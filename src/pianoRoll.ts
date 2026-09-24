import { frameToSeconds, isBlackKey, noteName } from './constants';
import type { Note } from './notes';

const LOWEST = 21; // A0
const HIGHEST = 108; // C8
/** Length of the keys (keyboard width in horizontal mode, height in vertical mode). */
const KEY_LEN = 72;

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
  keyActive: '#7ee08a',
  note: [126, 224, 138] as const,
  noteText: '#0f2a14',
  playhead: '#ff9c4a',
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
  /** Playback position (s), or null when not playing. */
  playhead: number | null = null;
  /** While recording: how much audio has been captured / analysed (s). */
  recordTime: number | null = null;
  analyzedTime = 0;
  /** Keep the newest audio in view while recording. */
  follow = true;

  onNoteClick: (note: Note) => void = () => {};
  onKeyPress: (pitch: number) => void = () => {};
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
    const center = this.pitchAt(this.ruler + (this.B - this.ruler) / 2);
    const headT = this.playhead ?? this.recordTime;
    this.vertical = vertical;
    // Vertical: fit the whole keyboard across the screen if the keys stay a usable size.
    this.keyH = vertical ? Math.max(10, Math.min(32, (this.B - this.ruler) / (HIGHEST - LOWEST + 1))) : 14;
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
    return this.ruler + idx * this.keyH - this.scrollP;
  }
  /** Lane edge shared with the next lower pitch. */
  private lowerEdge(p: number) {
    return this.vertical ? this.pitchB(p) : this.pitchB(p) + this.keyH;
  }
  private pitchAt(b: number) {
    const idx = Math.floor((b - this.ruler + this.scrollP) / this.keyH);
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
    this.scrollP = this.clampP((idx + 0.5) * this.keyH - (this.B - this.ruler) / 2);
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
    return Math.max(0, Math.min(p, total - (this.B - this.ruler)));
  }

  private noteAt(a: number, b: number): Note | null {
    if (a < KEY_LEN || b < this.ruler) return null;
    const pitch = this.pitchAt(b);
    const t = this.timeAt(a);
    for (const n of this.notes) {
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
      if (a < KEY_LEN && b > this.ruler) {
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

  /** Pitches sounding at time t. */
  private activeAt(t: number): Set<number> {
    const s = new Set<number>();
    for (const n of this.notes) if (frameToSeconds(n.start) <= t && frameToSeconds(n.end) > t) s.add(n.pitch);
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

    // --- pitch lanes
    ctx.save();
    ctx.beginPath();
    ctx.rect(...this.box(KEY_LEN, ruler, A - KEY_LEN, B - ruler));
    ctx.clip();
    for (let p = HIGHEST; p >= LOWEST; p--) {
      const b = this.pitchB(p);
      if (b > B || b + kh < ruler) continue;
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
    const [nr, ng, nb] = C.note;
    ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const n of this.notes) {
      const t0 = frameToSeconds(n.start);
      const t1 = frameToSeconds(n.end);
      if (t1 < tStart || t0 > tEnd) continue;
      const b = this.pitchB(n.pitch);
      if (b > B || b + kh < ruler) continue;
      const a0 = this.timeA(t0);
      const len = Math.max(3, (t1 - t0) * this.pxPerSec - 1);
      const alpha = Math.min(1, Math.max(0.35, n.amplitude * 1.3));
      ctx.fillStyle = n === this.hover ? '#c8ffd0' : `rgba(${nr},${ng},${nb},${alpha})`;
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

    // --- heads
    if (this.recordTime !== null) {
      ctx.fillStyle = C.recordHead;
      this.fill(this.timeA(this.recordTime) - 1, ruler, 2, B);
    }
    if (this.playhead !== null) {
      ctx.fillStyle = C.playhead;
      this.fill(this.timeA(this.playhead) - 1, ruler, 2, B);
    }
    ctx.restore();

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
    const active = headT !== null ? this.activeAt(headT) : new Set<number>();
    if (this.pressedKey !== null) active.add(this.pressedKey);

    ctx.save();
    ctx.beginPath();
    ctx.rect(...this.box(0, ruler, KEY_LEN, B - ruler));
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
      if (b1 < ruler || b0 > B) continue;
      if (active.has(p)) {
        ctx.fillStyle = C.keyActive;
        this.fill(0, b0, KEY_LEN, b1 - b0);
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
      if (b + kh < ruler || b > B) continue;
      ctx.fillStyle = active.has(p) ? '#4fb85c' : C.keyBlack;
      ctx.beginPath();
      ctx.roundRect(...this.box(-3, b, KEY_LEN * 0.6 + 3, kh), 2);
      ctx.fill();
    }
    // Border between keyboard and grid
    ctx.fillStyle = '#0c0f11';
    this.fill(KEY_LEN - 1, ruler, 1, B);
    ctx.restore();
    ctx.textAlign = 'left';
  }

  private drawTooltip(n: Note) {
    const { ctx } = this;
    const text = `${noteName(n.pitch)}  ·  ${formatTime(frameToSeconds(n.start), true)}  ·  ${Math.round(
      (frameToSeconds(n.end) - frameToSeconds(n.start)) * 1000,
    )} ms`;
    ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(text).width + 16;
    const th = 22;
    const [nx, ny, nw, nh] = this.box(this.timeA(frameToSeconds(n.start)), this.pitchB(n.pitch), 0, this.keyH);
    // Place above the note, or below it if there's no room.
    const [minX, minY] = this.pt(KEY_LEN, this.ruler);
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
