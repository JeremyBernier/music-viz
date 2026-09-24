import { frameToSeconds, isBlackKey, noteName } from './constants';
import type { Note } from './notes';

const LOWEST = 21; // A0
const HIGHEST = 108; // C8
const KEYBOARD_W = 72;
const RULER_H = 26;

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

export class PianoRoll {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private keyH = 14;
  private pxPerSec = 110;
  private scrollX = 0; // seconds at the left edge of the grid
  private scrollY = 0; // px offset from the top (C8)
  private dirty = true;
  private hover: Note | null = null;
  private drag: { x: number; y: number; sx: number; sy: number; moved: boolean } | null = null;
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

  get gridWidth() {
    return this.w - KEYBOARD_W;
  }

  get pixelsPerSecond() {
    return this.pxPerSec;
  }

  scrollToPitch(pitch: number) {
    const gridH = this.h - RULER_H;
    this.scrollY = this.clampY((HIGHEST - pitch) * this.keyH - gridH / 2);
    this.invalidate();
  }

  /** Scroll horizontally so `seconds` is visible, at `fraction` of the grid width. */
  reveal(seconds: number, fraction = 0.85) {
    const visible = this.gridWidth / this.pxPerSec;
    if (seconds < this.scrollX || seconds > this.scrollX + visible * 0.95) {
      this.scrollX = Math.max(0, seconds - visible * fraction);
      this.invalidate();
    }
  }

  resetView() {
    this.scrollX = 0;
    this.invalidate();
  }

  /** Scroll vertically so the given notes are centred. */
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
    this.scrollY = this.clampY(this.scrollY);
    this.invalidate();
  }

  private clampY(y: number) {
    const total = (HIGHEST - LOWEST + 1) * this.keyH;
    return Math.max(0, Math.min(y, total - (this.h - RULER_H)));
  }

  private pitchY(pitch: number) {
    return RULER_H + (HIGHEST - pitch) * this.keyH - this.scrollY;
  }

  private timeX(t: number) {
    return KEYBOARD_W + (t - this.scrollX) * this.pxPerSec;
  }

  private pitchAt(y: number) {
    return HIGHEST - Math.floor((y - RULER_H + this.scrollY) / this.keyH);
  }

  private timeAt(x: number) {
    return this.scrollX + (x - KEYBOARD_W) / this.pxPerSec;
  }

  private noteAt(x: number, y: number): Note | null {
    if (x < KEYBOARD_W || y < RULER_H) return null;
    const pitch = this.pitchAt(y);
    const t = this.timeAt(x);
    for (const n of this.notes) {
      if (n.pitch === pitch && frameToSeconds(n.start) <= t && frameToSeconds(n.end) >= t) return n;
    }
    return null;
  }

  private bindEvents() {
    const c = this.canvas;
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          // Zoom time around the cursor (pinch-to-zoom on trackpads also sends ctrlKey).
          const rect = c.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const t = this.timeAt(x);
          this.pxPerSec = Math.max(15, Math.min(1500, this.pxPerSec * Math.exp(-e.deltaY * 0.01)));
          this.scrollX = Math.max(0, t - (x - KEYBOARD_W) / this.pxPerSec);
        } else if (e.altKey) {
          this.keyH = Math.max(6, Math.min(32, this.keyH * Math.exp(-e.deltaY * 0.005)));
          this.scrollY = this.clampY(this.scrollY);
        } else {
          const dx = e.shiftKey ? e.deltaY : e.deltaX;
          const dy = e.shiftKey ? 0 : e.deltaY;
          if (dx) {
            this.scrollX = Math.max(0, this.scrollX + dx / this.pxPerSec);
            this.follow = false;
          }
          this.scrollY = this.clampY(this.scrollY + dy);
        }
        this.invalidate();
      },
      { passive: false },
    );

    c.addEventListener('pointerdown', (e) => {
      const { x, y } = this.local(e);
      if (y < RULER_H && x > KEYBOARD_W) {
        this.onSeek(Math.max(0, this.timeAt(x)));
        return;
      }
      if (x < KEYBOARD_W && y > RULER_H) {
        this.pressedKey = this.pitchAt(y);
        this.onKeyPress(this.pressedKey);
        this.invalidate();
        return;
      }
      c.setPointerCapture(e.pointerId);
      this.drag = { x, y, sx: this.scrollX, sy: this.scrollY, moved: false };
    });
    c.addEventListener('pointermove', (e) => {
      const { x, y } = this.local(e);
      if (this.drag) {
        const dx = x - this.drag.x;
        const dy = y - this.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
        if (this.drag.moved) {
          this.scrollX = Math.max(0, this.drag.sx - dx / this.pxPerSec);
          this.scrollY = this.clampY(this.drag.sy - dy);
          if (dx) this.follow = false;
          c.style.cursor = 'grabbing';
          this.invalidate();
        }
        return;
      }
      const hover = this.noteAt(x, y);
      if (hover !== this.hover) {
        this.hover = hover;
        this.invalidate();
      }
      c.style.cursor = hover || (x < KEYBOARD_W && y > RULER_H) ? 'pointer' : y < RULER_H ? 'col-resize' : 'grab';
    });
    const end = (e: PointerEvent) => {
      if (this.pressedKey !== null) {
        this.pressedKey = null;
        this.invalidate();
      }
      if (!this.drag) return;
      const { x, y } = this.local(e);
      if (!this.drag.moved) {
        const note = this.noteAt(x, y);
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

  private local(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /** Pitches sounding at time t. */
  private activeAt(t: number): Set<number> {
    const s = new Set<number>();
    for (const n of this.notes) if (frameToSeconds(n.start) <= t && frameToSeconds(n.end) > t) s.add(n.pitch);
    return s;
  }

  private draw() {
    this.dirty = false;
    const { ctx, w, h } = this;
    const kh = this.keyH;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    const tLeft = this.scrollX;
    const tRight = this.timeAt(w);

    // --- grid rows
    ctx.save();
    ctx.beginPath();
    ctx.rect(KEYBOARD_W, RULER_H, w - KEYBOARD_W, h - RULER_H);
    ctx.clip();
    for (let p = HIGHEST; p >= LOWEST; p--) {
      const y = this.pitchY(p);
      if (y > h || y + kh < RULER_H) continue;
      ctx.fillStyle = isBlackKey(p) ? C.rowBlack : C.rowWhite;
      ctx.fillRect(KEYBOARD_W, y, w, kh);
      ctx.fillStyle = p % 12 === 0 ? C.octaveLine : C.rowLine;
      ctx.fillRect(KEYBOARD_W, y + kh - (p % 12 === 0 ? 1.5 : 1), w, p % 12 === 0 ? 1.5 : 1);
    }

    // Region already analysed while recording.
    if (this.recordTime !== null) {
      const x0 = this.timeX(0);
      ctx.fillStyle = C.analyzed;
      ctx.fillRect(x0, RULER_H, this.timeX(this.analyzedTime) - x0, h);
    }

    // --- vertical time grid
    const step = this.gridStep();
    for (let t = Math.floor(tLeft / step) * step; t <= tRight; t += step) {
      const x = Math.round(this.timeX(t)) + 0.5;
      const strong = Math.abs(t / (step * 4) - Math.round(t / (step * 4))) < 1e-6;
      ctx.fillStyle = strong ? C.gridStrong : C.gridWeak;
      ctx.fillRect(x, RULER_H, 1, h);
    }

    // --- notes
    const [nr, ng, nb] = C.note;
    ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const n of this.notes) {
      const t0 = frameToSeconds(n.start);
      const t1 = frameToSeconds(n.end);
      if (t1 < tLeft || t0 > tRight) continue;
      const y = this.pitchY(n.pitch);
      if (y > h || y + kh < RULER_H) continue;
      const x0 = this.timeX(t0);
      const nw = Math.max(3, (t1 - t0) * this.pxPerSec - 1);
      const a = Math.min(1, Math.max(0.35, n.amplitude * 1.3));
      const hovered = n === this.hover;
      ctx.fillStyle = hovered ? '#c8ffd0' : `rgba(${nr},${ng},${nb},${a})`;
      roundRect(ctx, x0 + 0.5, y + 1, nw, kh - 2, 3);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
      if (nw > 26 && kh >= 11) {
        ctx.fillStyle = C.noteText;
        ctx.fillText(noteName(n.pitch), x0 + 4, y + kh / 2 + 0.5);
      }
    }

    // --- heads
    if (this.recordTime !== null) {
      const x = this.timeX(this.recordTime);
      ctx.fillStyle = C.recordHead;
      ctx.fillRect(x - 1, RULER_H, 2, h);
    }
    if (this.playhead !== null) {
      const x = this.timeX(this.playhead);
      ctx.fillStyle = C.playhead;
      ctx.fillRect(x - 1, RULER_H, 2, h);
    }
    ctx.restore();

    // --- ruler
    ctx.fillStyle = C.ruler;
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.fillStyle = C.rulerText;
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    const labelStep = step * 4;
    for (let t = Math.floor(tLeft / step) * step; t <= tRight; t += step) {
      const x = Math.round(this.timeX(t)) + 0.5;
      if (x < KEYBOARD_W) continue;
      const strong = Math.abs(t / labelStep - Math.round(t / labelStep)) < 1e-6;
      ctx.fillRect(x, strong ? RULER_H - 9 : RULER_H - 4, 1, strong ? 9 : 4);
      if (strong) ctx.fillText(formatTime(t), x + 4, RULER_H / 2 - 2);
    }
    const headT = this.playhead ?? this.recordTime;
    if (headT !== null) {
      const x = this.timeX(headT);
      if (x >= KEYBOARD_W) {
        ctx.fillStyle = this.playhead !== null ? C.playhead : C.recordHead;
        ctx.beginPath();
        ctx.moveTo(x - 6, RULER_H - 10);
        ctx.lineTo(x + 6, RULER_H - 10);
        ctx.lineTo(x, RULER_H);
        ctx.fill();
      }
    }

    this.drawKeyboard(headT);

    // Top-left corner
    ctx.fillStyle = C.ruler;
    ctx.fillRect(0, 0, KEYBOARD_W, RULER_H);

    // Hover tooltip
    if (this.hover) {
      const n = this.hover;
      const text = `${noteName(n.pitch)}  ·  ${formatTime(frameToSeconds(n.start), true)}  ·  ${Math.round(
        (frameToSeconds(n.end) - frameToSeconds(n.start)) * 1000,
      )} ms`;
      ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
      const tw = ctx.measureText(text).width + 16;
      let x = this.timeX(frameToSeconds(n.start));
      x = Math.max(KEYBOARD_W + 4, Math.min(x, w - tw - 4));
      let y = this.pitchY(n.pitch) - 26;
      if (y < RULER_H + 2) y = this.pitchY(n.pitch) + kh + 4;
      ctx.fillStyle = 'rgba(10,12,14,0.92)';
      roundRect(ctx, x, y, tw, 22, 5);
      ctx.fill();
      ctx.fillStyle = '#e6ecef';
      ctx.fillText(text, x + 8, y + 11);
    }
  }

  private drawKeyboard(headT: number | null) {
    const { ctx, h } = this;
    const kh = this.keyH;
    const active = headT !== null ? this.activeAt(headT) : new Set<number>();
    if (this.pressedKey !== null) active.add(this.pressedKey);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_H, KEYBOARD_W, h - RULER_H);
    ctx.clip();
    ctx.fillStyle = C.keyWhite;
    ctx.fillRect(0, RULER_H, KEYBOARD_W, h);

    // White keys extend halfway into neighbouring black-key rows, like a real keyboard.
    ctx.font = '600 9px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (let p = HIGHEST; p >= LOWEST; p--) {
      if (isBlackKey(p)) continue;
      const top = this.pitchY(p) - (p < HIGHEST && isBlackKey(p + 1) ? kh / 2 : 0);
      const bottom = this.pitchY(p) + kh + (p > LOWEST && isBlackKey(p - 1) ? kh / 2 : 0);
      if (bottom < RULER_H || top > h) continue;
      if (active.has(p)) {
        ctx.fillStyle = C.keyActive;
        ctx.fillRect(0, top, KEYBOARD_W, bottom - top);
      }
      ctx.fillStyle = C.keyLine;
      ctx.fillRect(0, Math.round(bottom) - 0.5, KEYBOARD_W, 1);
      if (p % 12 === 0 && kh >= 9) {
        ctx.fillStyle = '#56616a';
        ctx.fillText(noteName(p), KEYBOARD_W - 24, this.pitchY(p) + kh / 2);
      }
    }
    for (let p = HIGHEST; p >= LOWEST; p--) {
      if (!isBlackKey(p)) continue;
      const y = this.pitchY(p);
      if (y + kh < RULER_H || y > h) continue;
      ctx.fillStyle = active.has(p) ? '#4fb85c' : C.keyBlack;
      roundRect(ctx, -3, y, KEYBOARD_W * 0.6 + 3, kh, 2);
      ctx.fill();
    }
    ctx.fillStyle = '#0c0f11';
    ctx.fillRect(KEYBOARD_W - 1, RULER_H, 1, h);
    ctx.restore();
  }

  /** Grid spacing in seconds that keeps lines ~25-60 px apart. */
  private gridStep() {
    const steps = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30];
    for (const s of steps) if (s * this.pxPerSec >= 25) return s;
    return 60;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

export function formatTime(t: number, precise = false) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const ss = precise ? s.toFixed(2).padStart(5, '0') : Math.round(s * 100) % 100 === 0 ? String(Math.round(s)).padStart(2, '0') : s.toFixed(2).padStart(5, '0');
  return `${m}:${ss}`;
}
