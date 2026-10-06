import { frameToSeconds, isBlackKey, noteName } from './constants';
import { DRUM_KINDS, PARTS, partRgb, type DrumHit, type DrumKind, type Instrument, type Part } from './instruments';
import type { Note } from './notes';

const LOWEST = 21; // A0
const HIGHEST = 108; // C8
/** Length of the keys (keyboard width in horizontal mode, height in vertical mode). */
const KEY_LEN = 72;
/** Size of one drum row (kick / snare / hi-hat) across the pitch axis. */
const DRUM_ROW = 17;
/** A drum hit is drawn this long (s). */
const DRUM_HIT_LEN = 0.07;

const rgb = ([r, g, b]: readonly number[], a = 1) => `rgba(${r},${g},${b},${a})`;
const darker = ([r, g, b]: readonly number[]) => [r * 0.7, g * 0.7, b * 0.7];

const C = {
  bg: '#1d2327',
  rowWhite: '#283036',
  rowBlack: '#222a2f',
  rowLine: '#1a1f23',
  octaveLine: '#11161a',
  gridStrong: 'rgba(255,255,255,0.13)',
  gridWeak: 'rgba(255,255,255,0.045)',
  ruler: '#161b1f',
  rulerText: '#8f9ba5',
  keyWhite: '#e9edf0',
  keyBlack: '#1b1f22',
  keyLine: '#9aa4ab',
  noteText: '#10181c',
  drumLane: '#1a2024',
  drumLaneLine: '#12171a',
  playhead: '#f2f5f7',
  recordHead: '#ff5c5c',
  analyzed: 'rgba(255,92,92,0.06)',
};

/**
 * FL Studio–style piano roll.
 *
 * Drawing is done in axis coordinates: `a` runs along the time axis (the keyboard occupies
 * a < KEY_LEN) and `b` runs along the pitch axis (the ruler occupies b < ruler size).
 * Horizontal mode maps (a, b) to screen (x, y); vertical mode maps it to (y, x), which puts
 * the keyboard on top with time flowing downwards (a 90° clockwise rotation).
 *
 * When drums are shown, three fixed drum rows sit between the ruler and the pitch lanes
 * (b in [ruler, top)); the pitch lanes scroll underneath.
 */
export class PianoRoll {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private vertical = false;
  private keyH = 14; // size of one semitone along the pitch axis
  private pxPerSec = 110;
  private scrollT = 0; // seconds at the start of the time axis
  private scrollP = 0; // px offset along the pitch axis
  private dirty = true;
  private hover: Note | null = null;
  private drag: { a: number; b: number; st: number; sp: number; moved: boolean } | null = null;
  private pressedKey: number | null = null;

  notes: Note[] = [];
  drums: DrumHit[] = [];
  /** Show the drum rows (kick / snare / hi-hat). */
  showDrums = false;
  /** Parts hidden from the roll (toggled in the legend). */
  hidden = new Set<Part>();
  /** Playback position (s), or null when not playing. */
  playhead: number | null = null;
  /** While recording: how much audio has been captured / analysed (s). */
  recordTime: number | null = null;
  analyzedTime = 0;
  /** While recording: pitches sounding at the newest analysed moment (pressed on the keyboard). */
  livePitches: Map<number, Instrument> | null = null;
  /** While recording: drum kinds hit at the newest analysed moment. */
  liveDrums: Set<DrumKind> | null = null;
  /** Keep the newest audio in view while recording. */
  follow = true;

  onNoteClick: (note: Note) => void = () => {};
  onKeyPress: (pitch: number) => void = () => {};
  onDrumPress: (kind: DrumKind) => void = () => {};
  onSeek: (seconds: number) => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.scrollToPitch(60);
    this.bindEvents();
    const loop = () => {
      if (this.dirty) this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  invalidate() {
    this.dirty = true;
  }

  get isVertical() {
    return this.vertical;
  }

  /** Switch between horizontal (keys on the left) and vertical (keys on top) layouts. */
  setVertical(vertical: boolean) {
    if (vertical === this.vertical) return;
    const center = this.pitchAt(this.top + (this.B - this.top) / 2);
    const headT = this.playhead ?? this.recordTime;
    this.vertical = vertical;
    // Vertical: fit the whole keyboard across the screen if the keys stay a usable size.
    this.keyH = vertical ? Math.max(10, Math.min(32, (this.B - this.top) / (HIGHEST - LOWEST + 1))) : 14;
    this.scrollToPitch(center);
    if (headT !== null) this.reveal(headT, 0.5);
    this.invalidate();
  }

  // ---------------------------------------------------------------- geometry

  /** Screen extent along the time axis. */
  private get A() {
    return this.vertical ? this.h : this.w;
  }
  /** Screen extent along the pitch axis. */
  private get B() {
    return this.vertical ? this.w : this.h;
  }
  /** Ruler size across the pitch axis (vertical mode needs room for horizontal labels). */
  private get ruler() {
    return this.vertical ? 44 : 26;
  }

  /** Where the pitch lanes start along the pitch axis (after the ruler and drum rows). */
  private get top() {
    return this.ruler + (this.showDrums ? DRUM_KINDS.length * DRUM_ROW : 0);
  }

  private drumB(i: number) {
    return this.ruler + i * DRUM_ROW;
  }

  private get timeLen() {
    return this.A - KEY_LEN;
  }

  /** Axis-space rectangle → screen [x, y, w, h]. */
  private box(a: number, b: number, da: number, db: number): [number, number, number, number] {
    return this.vertical ? [b, a, db, da] : [a, b, da, db];
  }
  private fill(a: number, b: number, da: number, db: number) {
    this.ctx.fillRect(...this.box(a, b, da, db));
  }
  private pt(a: number, b: number): [number, number] {
    return this.vertical ? [b, a] : [a, b];
  }
  private toAxis(x: number, y: number) {
    return this.vertical ? { a: y, b: x } : { a: x, b: y };
  }

  /** Start of pitch p's lane along the pitch axis. Low notes are at the bottom / on the left. */
  private pitchB(p: number) {
    const idx = this.vertical ? p - LOWEST : HIGHEST - p;
    return this.top + idx * this.keyH - this.scrollP;
  }
  /** Lane edge shared with the next lower pitch. */
  private lowerEdge(p: number) {
    return this.vertical ? this.pitchB(p) : this.pitchB(p) + this.keyH;
  }
  private pitchAt(b: number) {
    const idx = Math.floor((b - this.top + this.scrollP) / this.keyH);
    return this.vertical ? LOWEST + idx : HIGHEST - idx;
  }
  private timeA(t: number) {
    return KEY_LEN + (t - this.scrollT) * this.pxPerSec;
  }
  private timeAt(a: number) {
    return this.scrollT + (a - KEY_LEN) / this.pxPerSec;
  }

  scrollToPitch(pitch: number) {
    const idx = this.vertical ? pitch - LOWEST : HIGHEST - pitch;
    this.scrollP = this.clampP((idx + 0.5) * this.keyH - (this.B - this.top) / 2);
    this.invalidate();
  }

  /** Scroll along the time axis so `seconds` is visible, at `fraction` of the visible span. */
  reveal(seconds: number, fraction = 0.85) {
    const visible = this.timeLen / this.pxPerSec;
    if (seconds < this.scrollT || seconds > this.scrollT + visible * 0.95) {
      this.scrollT = Math.max(0, seconds - visible * fraction);
      this.invalidate();
    }
  }

  resetView() {
    this.scrollT = 0;
    this.invalidate();
  }

  /** Scroll along the pitch axis so the given notes are centred. */
  frameNotes(notes: Note[]) {
    if (!notes.length) return;
    let lo = HIGHEST;
    let hi = LOWEST;
    for (const n of notes) {
      lo = Math.min(lo, n.pitch);
      hi = Math.max(hi, n.pitch);
    }
    this.scrollToPitch((lo + hi) / 2);
  }

  private resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.scrollP = this.clampP(this.scrollP);
    this.invalidate();
  }

  private clampP(p: number) {
    const total = (HIGHEST - LOWEST + 1) * this.keyH;
    return Math.max(0, Math.min(p, total - (this.B - this.top)));
  }

  /** Notes and drum hits currently shown (not hidden in the legend). */
  private get visibleNotes() {
    return this.hidden.size ? this.notes.filter((n) => !this.hidden.has(n.instrument)) : this.notes;
  }
  private get visibleDrums() {
    return this.showDrums && !this.hidden.has('drums') ? this.drums : [];
  }

  private noteAt(a: number, b: number): Note | null {
    if (a < KEY_LEN || b < this.top) return null;
    const pitch = this.pitchAt(b);
    const t = this.timeAt(a);
    for (const n of this.visibleNotes) {
      if (n.pitch === pitch && frameToSeconds(n.start) <= t && frameToSeconds(n.end) >= t) return n;
    }
    return null;
  }

  // ---------------------------------------------------------------- input

  private bindEvents() {
    const c = this.canvas;
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const { a } = this.local(e);
        if (e.ctrlKey || e.metaKey) {
          // Zoom time around the cursor (pinch-to-zoom on trackpads also sends ctrlKey).
          const t = this.timeAt(a);
          this.pxPerSec = Math.max(15, Math.min(1500, this.pxPerSec * Math.exp(-e.deltaY * 0.01)));
          this.scrollT = Math.max(0, t - (a - KEY_LEN) / this.pxPerSec);
        } else if (e.altKey) {
          this.keyH = Math.max(6, Math.min(32, this.keyH * Math.exp(-e.deltaY * 0.005)));
          this.scrollP = this.clampP(this.scrollP);
        } else {
          // The wheel's main direction follows the screen: in vertical mode it moves through time.
          const main = e.shiftKey ? 0 : e.deltaY;
          const cross = e.shiftKey ? e.deltaY : e.deltaX;
          const dt = this.vertical ? main : cross;
          const dp = this.vertical ? cross : main;
          if (dt) {
            this.scrollT = Math.max(0, this.scrollT + dt / this.pxPerSec);
            this.follow = false;
          }
          this.scrollP = this.clampP(this.scrollP + dp);
        }
        this.invalidate();
      },
      { passive: false },
    );

    c.addEventListener('pointerdown', (e) => {
      const { a, b } = this.local(e);
      if (b < this.ruler && a > KEY_LEN) {
        this.onSeek(Math.max(0, this.timeAt(a)));
        return;
      }
      if (a < KEY_LEN && b > this.ruler && b < this.top) {
        this.onDrumPress(DRUM_KINDS[Math.floor((b - this.ruler) / DRUM_ROW)].kind);
        return;
      }
      if (a < KEY_LEN && b > this.top) {
        this.pressedKey = this.pitchAt(b);
        this.onKeyPress(this.pressedKey);
        this.invalidate();
        return;
      }
      c.setPointerCapture(e.pointerId);
      this.drag = { a, b, st: this.scrollT, sp: this.scrollP, moved: false };
    });
    c.addEventListener('pointermove', (e) => {
      const { a, b } = this.local(e);
      if (this.drag) {
        const da = a - this.drag.a;
        const db = b - this.drag.b;
        if (Math.abs(da) + Math.abs(db) > 3) this.drag.moved = true;
        if (this.drag.moved) {
          this.scrollT = Math.max(0, this.drag.st - da / this.pxPerSec);
          this.scrollP = this.clampP(this.drag.sp - db);
          if (da) this.follow = false;
          c.style.cursor = 'grabbing';
          this.invalidate();
        }
        return;
      }
      const hover = this.noteAt(a, b);
      if (hover !== this.hover) {
        this.hover = hover;
        this.invalidate();
      }
      const onRuler = b < this.ruler;
      c.style.cursor =
        hover || (a < KEY_LEN && !onRuler) ? 'pointer' : onRuler ? (this.vertical ? 'row-resize' : 'col-resize') : 'grab';
    });
    const end = (e: PointerEvent) => {
      if (this.pressedKey !== null) {
        this.pressedKey = null;
        this.invalidate();
      }
      if (!this.drag) return;
      const { a, b } = this.local(e);
      if (!this.drag.moved) {
        const note = this.noteAt(a, b);
        if (note) this.onNoteClick(note);
      }
      this.drag = null;
      c.style.cursor = 'grab';
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      if (this.hover) {
        this.hover = null;
        this.invalidate();
      }
    });
  }

  /** Pointer position in axis coordinates. */
  private local(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return this.toAxis(e.clientX - rect.left, e.clientY - rect.top);
  }

  /** Pitches sounding at time t, with the instrument playing each. */
  private activeAt(t: number): Map<number, Instrument> {
    const m = new Map<number, Instrument>();
    for (const n of this.visibleNotes) {
      if (frameToSeconds(n.start) <= t && frameToSeconds(n.end) > t) m.set(n.pitch, n.instrument);
    }
    return m;
  }

  /** Drum kinds hit just before time t. */
  private drumsAt(t: number): Set<DrumKind> {
    const s = new Set<DrumKind>();
    for (const h of this.visibleDrums) {
      const ht = frameToSeconds(h.row);
      if (ht <= t && t - ht < 0.12) s.add(h.kind);
    }
    return s;
  }

  // ---------------------------------------------------------------- drawing

  private draw() {
    this.dirty = false;
    const { ctx, A, B, ruler } = this;
    const kh = this.keyH;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, this.w, this.h);

    const tStart = this.scrollT;
    const tEnd = this.timeAt(A);

    const top = this.top;

    // --- pitch lanes
    ctx.save();
    ctx.beginPath();
    ctx.rect(...this.box(KEY_LEN, top, A - KEY_LEN, B - top));
    ctx.clip();
    for (let p = HIGHEST; p >= LOWEST; p--) {
      const b = this.pitchB(p);
      if (b > B || b + kh < top) continue;
      ctx.fillStyle = isBlackKey(p) ? C.rowBlack : C.rowWhite;
      this.fill(KEY_LEN, b, A, kh);
      const octave = p % 12 === 0;
      const t = octave ? 1.5 : 1;
      ctx.fillStyle = octave ? C.octaveLine : C.rowLine;
      this.fill(KEY_LEN, this.vertical ? this.lowerEdge(p) : this.lowerEdge(p) - t, A, t);
    }

    // Region already analysed while recording.
    if (this.recordTime !== null) {
      const a0 = this.timeA(0);
      ctx.fillStyle = C.analyzed;
      this.fill(a0, ruler, this.timeA(this.analyzedTime) - a0, B);
    }

    // --- time grid
    const step = this.gridStep();
    for (let t = Math.floor(tStart / step) * step; t <= tEnd; t += step) {
      const a = Math.round(this.timeA(t)) + 0.5;
      const strong = Math.abs(t / (step * 4) - Math.round(t / (step * 4))) < 1e-6;
      ctx.fillStyle = strong ? C.gridStrong : C.gridWeak;
      this.fill(a, ruler, 1, B);
    }

    // --- notes
    ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const n of this.visibleNotes) {
      const t0 = frameToSeconds(n.start);
      const t1 = frameToSeconds(n.end);
      if (t1 < tStart || t0 > tEnd) continue;
      const b = this.pitchB(n.pitch);
      if (b > B || b + kh < top) continue;
      const a0 = this.timeA(t0);
      const len = Math.max(3, (t1 - t0) * this.pxPerSec - 1);
      const alpha = Math.min(1, Math.max(0.35, n.amplitude * 1.3));
      ctx.fillStyle = n === this.hover ? '#ffffff' : rgb(partRgb(n.instrument), alpha);
      ctx.beginPath();
      const [x, y, w, h] = this.box(a0 + 0.5, b + 1, len, kh - 2);
      ctx.roundRect(x, y, w, h, Math.min(3, w / 2, h / 2));
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = C.noteText;
      if (!this.vertical && len > 26 && kh >= 11) {
        ctx.textAlign = 'left';
        ctx.fillText(noteName(n.pitch), x + 4, y + h / 2 + 0.5);
      } else if (this.vertical && len > 16 && kh >= 20) {
        ctx.textAlign = 'center';
        ctx.fillText(noteName(n.pitch), x + w / 2, y + 8);
      }
    }
    ctx.textAlign = 'left';

    ctx.restore();

    if (this.showDrums) this.drawDrumRows(tStart, tEnd, step);

    // --- heads
    if (this.recordTime !== null) {
      ctx.fillStyle = C.recordHead;
      this.fill(this.timeA(this.recordTime) - 1, ruler, 2, B);
    }
    if (this.playhead !== null) {
      ctx.fillStyle = C.playhead;
      this.fill(this.timeA(this.playhead) - 1, ruler, 2, B);
    }


    // --- ruler
    ctx.fillStyle = C.ruler;
    this.fill(0, 0, A, ruler);
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    const labelStep = step * 4;
    for (let t = Math.floor(tStart / step) * step; t <= tEnd; t += step) {
      const a = Math.round(this.timeA(t)) + 0.5;
      if (a < KEY_LEN) continue;
      const strong = Math.abs(t / labelStep - Math.round(t / labelStep)) < 1e-6;
      ctx.fillStyle = C.rulerText;
      this.fill(a, strong ? ruler - 9 : ruler - 4, 1, strong ? 9 : 4);
      if (!strong) continue;
      if (this.vertical) ctx.fillText(formatTime(t), 4, a + 8);
      else ctx.fillText(formatTime(t), a + 4, ruler / 2 - 2);
    }
    const headT = this.playhead ?? this.recordTime;
    if (headT !== null) {
      const a = this.timeA(headT);
      if (a >= KEY_LEN) {
        ctx.fillStyle = this.playhead !== null ? C.playhead : C.recordHead;
        ctx.beginPath();
        ctx.moveTo(...this.pt(a - 6, ruler - 10));
        ctx.lineTo(...this.pt(a + 6, ruler - 10));
        ctx.lineTo(...this.pt(a, ruler));
        ctx.fill();
      }
    }

    this.drawKeyboard(headT);

    // Corner where the ruler and keyboard meet
    ctx.fillStyle = C.ruler;
    this.fill(0, 0, KEY_LEN, ruler);

    if (this.hover) this.drawTooltip(this.hover);
  }

  private drawKeyboard(headT: number | null) {
    const { ctx, B, ruler } = this;
    const kh = this.keyH;
    const active = this.livePitches
      ? new Map(this.livePitches)
      : headT !== null
        ? this.activeAt(headT)
        : new Map<number, Instrument>();
    if (this.hidden.size) for (const [p, inst] of active) if (this.hidden.has(inst)) active.delete(p);
    if (this.pressedKey !== null) active.set(this.pressedKey, 'piano');
    const top = this.top;

    ctx.save();
    ctx.beginPath();
    ctx.rect(...this.box(0, top, KEY_LEN, B - top));
    ctx.clip();
    ctx.fillStyle = C.keyWhite;
    this.fill(0, ruler, KEY_LEN, B);

    // White keys extend halfway into neighbouring black-key lanes, like a real keyboard.
    // Neighbours along the pitch axis: `before` has the smaller b coordinate.
    ctx.font = '600 9px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (let p = HIGHEST; p >= LOWEST; p--) {
      if (isBlackKey(p)) continue;
      const before = this.vertical ? p - 1 : p + 1;
      const after = this.vertical ? p + 1 : p - 1;
      const b0 = this.pitchB(p) - (before >= LOWEST && before <= HIGHEST && isBlackKey(before) ? kh / 2 : 0);
      const b1 = this.pitchB(p) + kh + (after >= LOWEST && after <= HIGHEST && isBlackKey(after) ? kh / 2 : 0);
      if (b1 < top || b0 > B) continue;
      const inst = active.get(p);
      if (inst) {
        ctx.fillStyle = rgb(partRgb(inst));
        this.fill(0, b0, KEY_LEN, b1 - b0);
        // Shadow at the hinge end so the key reads as pushed down.
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        this.fill(0, b0, 5, b1 - b0);
      }
      ctx.fillStyle = C.keyLine;
      this.fill(0, Math.round(b1) - 0.5, KEY_LEN, 1);
      if (p % 12 === 0 && kh >= 9) {
        ctx.fillStyle = '#56616a';
        ctx.fillText(noteName(p), ...this.pt(KEY_LEN - (this.vertical ? 10 : 16), this.pitchB(p) + kh / 2));
      }
    }
    for (let p = HIGHEST; p >= LOWEST; p--) {
      if (!isBlackKey(p)) continue;
      const b = this.pitchB(p);
      if (b + kh < top || b > B) continue;
      const inst = active.get(p);
      const down = inst !== undefined;
      ctx.fillStyle = inst ? rgb(darker(partRgb(inst))) : C.keyBlack;
      ctx.beginPath();
      // Pressed black keys sink in, so they look slightly shorter.
      ctx.roundRect(...this.box(-3, b, KEY_LEN * 0.6 + (down ? 0 : 3), kh), 2);
      ctx.fill();
    }
    // Border between keyboard and grid
    ctx.fillStyle = '#0c0f11';
    this.fill(KEY_LEN - 1, top, 1, B);
    ctx.restore();
    ctx.textAlign = 'left';

    if (this.showDrums) this.drawDrumLabels(headT);
  }

  /** Drum rows in the grid: fixed lanes for kick / snare / hi-hat with a mark per hit. */
  private drawDrumRows(tStart: number, tEnd: number, step: number) {
    const { ctx, A } = this;
    ctx.save();
    ctx.beginPath();
    ctx.rect(...this.box(KEY_LEN, this.ruler, A - KEY_LEN, this.top - this.ruler));
    ctx.clip();
    ctx.fillStyle = C.drumLane;
    this.fill(KEY_LEN, this.ruler, A, this.top - this.ruler);
    for (let t = Math.floor(tStart / step) * step; t <= tEnd; t += step) {
      ctx.fillStyle = C.gridWeak;
      this.fill(Math.round(this.timeA(t)) + 0.5, this.ruler, 1, this.top - this.ruler);
    }
    ctx.fillStyle = C.drumLaneLine;
    DRUM_KINDS.forEach((_, i) => this.fill(KEY_LEN, this.drumB(i + 1) - 1, A, 1));
    this.fill(KEY_LEN, this.top - 2, A, 2);

    const col = partRgb('drums');
    const len = Math.max(4, DRUM_HIT_LEN * this.pxPerSec);
    for (const h of this.visibleDrums) {
      const t = frameToSeconds(h.row);
      if (t < tStart - DRUM_HIT_LEN || t > tEnd) continue;
      const i = DRUM_KINDS.findIndex((d) => d.kind === h.kind);
      ctx.fillStyle = rgb(col, 0.45 + 0.55 * h.velocity);
      ctx.beginPath();
      ctx.roundRect(...this.box(this.timeA(t), this.drumB(i) + 3, len, DRUM_ROW - 7), 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Drum row labels where the keyboard is; they light up as each drum is hit. */
  private drawDrumLabels(headT: number | null) {
    const { ctx } = this;
    const hit = this.liveDrums ?? (headT !== null ? this.drumsAt(headT) : new Set<DrumKind>());
    ctx.save();
    ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    DRUM_KINDS.forEach((d, i) => {
      const on = hit.has(d.kind) && !this.hidden.has('drums');
      ctx.fillStyle = on ? rgb(partRgb('drums')) : '#2a3238';
      this.fill(0, this.drumB(i), KEY_LEN - 1, DRUM_ROW - 1);
      ctx.fillStyle = on ? C.noteText : '#aab4bb';
      // Vertical mode has only a narrow column per drum, so use the initial.
      const label = this.vertical ? d.short : d.label;
      ctx.fillText(label, ...this.pt(KEY_LEN / 2, this.drumB(i) + DRUM_ROW / 2));
    });
    ctx.restore();
  }

  private drawTooltip(n: Note) {
    const { ctx } = this;
    const part = PARTS.find((p) => p.id === n.instrument)!.label;
    const text = `${noteName(n.pitch)}  ·  ${part}  ·  ${formatTime(frameToSeconds(n.start), true)}  ·  ${Math.round(
      (frameToSeconds(n.end) - frameToSeconds(n.start)) * 1000,
    )} ms`;
    ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(text).width + 16;
    const th = 22;
    const [nx, ny, nw, nh] = this.box(this.timeA(frameToSeconds(n.start)), this.pitchB(n.pitch), 0, this.keyH);
    // Place above the note, or below it if there's no room.
    const [minX, minY] = this.pt(KEY_LEN, this.top);
    let x = Math.max(minX + 4, Math.min(nx + (this.vertical ? nw + 6 : 0), this.w - tw - 4));
    let y = this.vertical ? ny : ny - th - 4;
    if (y < minY + 2) y = ny + nh + 4;
    y = Math.min(y, this.h - th - 4);
    ctx.fillStyle = 'rgba(10,12,14,0.92)';
    ctx.beginPath();
    ctx.roundRect(x, y, tw, th, 5);
    ctx.fill();
    ctx.fillStyle = '#e6ecef';
    ctx.fillText(text, x + 8, y + th / 2);
  }

  /** Grid spacing in seconds that keeps lines ~25-60 px apart. */
  private gridStep() {
    const steps = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30];
    for (const s of steps) if (s * this.pxPerSec >= 25) return s;
    return 60;
  }
}

export function formatTime(t: number, precise = false) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const ss = precise ? s.toFixed(2).padStart(5, '0') : Math.round(s * 100) % 100 === 0 ? String(Math.round(s)).padStart(2, '0') : s.toFixed(2).padStart(5, '0');
  return `${m}:${ss}`;
}
