import { FFT_HOP, SAMPLE_RATE } from './constants';
import type { DrumHit, DrumKind } from './instruments';

const N = 1024; // FFT size (~46 ms)
const BINS = N / 2;
const HZ_PER_BIN = SAMPLE_RATE / N;
const bin = (hz: number) => Math.round(hz / HZ_PER_BIN);

// Frequency bands (inclusive-exclusive bin ranges).
// Kick fundamentals sit at 40-100 Hz. Stopping at 120 Hz keeps notes around F3/G3 (175 Hz+)
// from leaking in through the window's main lobe.
const LOW = [bin(30), bin(120)] as const;
const BODY = [bin(120), bin(1000)] as const; // snare body, tonal instruments
const NOISE = [bin(1000), bin(8000)] as const; // snare / hat noise
const HIGH = [bin(5000), BINS] as const; // hi-hat

/** In-place radix-2 FFT. */
function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

const HANN = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));

interface Features {
  low: number;
  body: number;
  noise: number;
  high: number;
  /** Fraction of noise-band bins that got louder: high for drums, low for pitched notes. */
  noiseCoverage: number;
  highCoverage: number;
  /** Energy in the kick band in dB (a level, not a change). */
  lowDb: number;
}

/** Rows to wait before confirming a kick (~140 ms): long enough to see it die away. */
const KICK_CONFIRM = 12;
/** A kick's low end must drop at least this much in that time; bass notes sustain. */
const KICK_DECAY_DB = 6;

/**
 * Streaming percussion detector for 22.05 kHz mono audio, on the same row grid as the note
 * model. Uses band-wise spectral flux: drums make many bins jump at once (broadband), while
 * pitched notes only raise their harmonics.
 *
 * `strict` is for the full mix, where piano and bass onsets must not be mistaken for drums.
 * Without it (on Demucs' drum stem) detection is more permissive.
 */
export class DrumDetector {
  readonly hits: DrumHit[] = [];
  private audio = new Float32Array(SAMPLE_RATE * 30);
  private len = 0;
  private row = 0; // next row to analyse
  private prevLog = new Float32Array(BINS);
  private feats: Features[] = [];
  private ema = { low: 0.02, body: 0.02, noise: 0.02, high: 0.02 };
  private last: Record<DrumKind, number> = { kick: -99, snare: -99, hihat: -99 };
  private re = new Float32Array(N);
  private im = new Float32Array(N);

  constructor(private strict: boolean) {}

  push(samples: Float32Array) {
    if (this.len + samples.length > this.audio.length) {
      const bigger = new Float32Array(Math.max(this.len + samples.length, this.audio.length * 2));
      bigger.set(this.audio.subarray(0, this.len));
      this.audio = bigger;
    }
    this.audio.set(samples, this.len);
    this.len += samples.length;
    // Row r's window is centred on sample r * hop.
    while (this.row * FFT_HOP + N / 2 <= this.len) this.analyse(this.row++);
  }

  /** Analyse the remaining audio (zero-padded). */
  finish() {
    this.push(new Float32Array(N + (KICK_CONFIRM + 2) * FFT_HOP));
    this.hits.sort((a, b) => a.row - b.row);
  }

  private analyse(r: number) {
    const { re, im, audio } = this;
    const start = r * FFT_HOP - N / 2;
    for (let i = 0; i < N; i++) {
      const k = start + i;
      re[i] = k >= 0 && k < this.len ? audio[k] * HANN[i] : 0;
      im[i] = 0;
    }
    fft(re, im);

    const f: Features = { low: 0, body: 0, noise: 0, high: 0, noiseCoverage: 0, highCoverage: 0, lowDb: 0 };
    const band = (range: readonly [number, number], d: Float32Array) => {
      let s = 0;
      let covered = 0;
      for (let k = range[0]; k < range[1]; k++) {
        s += d[k];
        if (d[k] > 0.4) covered++;
      }
      return [s / (range[1] - range[0]), covered / (range[1] - range[0])];
    };
    const diff = new Float32Array(BINS);
    let lowPower = 1e-10;
    for (let k = 0; k < BINS; k++) {
      const mag = Math.hypot(re[k], im[k]);
      if (k >= LOW[0] && k < LOW[1]) lowPower += mag * mag;
      const l = Math.log1p(20 * mag);
      diff[k] = Math.max(0, l - this.prevLog[k]);
      this.prevLog[k] = l;
    }
    f.lowDb = 10 * Math.log10(lowPower);
    f.low = band(LOW, diff)[0];
    f.body = band(BODY, diff)[0];
    [f.noise, f.noiseCoverage] = band(NOISE, diff);
    [f.high, f.highCoverage] = band(HIGH, diff);
    this.feats.push(f);

    // Decide on the previous row now that we know its successor (peak picking).
    if (r >= 2) this.decide(r - 1);
    this.confirmKicks(r);

    const a = 0.03;
    for (const k of ['low', 'body', 'noise', 'high'] as const) this.ema[k] += a * (f[k] - this.ema[k]);
  }

  private pendingKicks: { row: number; velocity: number }[] = [];
  private lastKickCandidate = -99;

  /** Keep kick candidates whose low end died away quickly; drop sustained (pitched) ones. */
  private confirmKicks(r: number) {
    while (this.pendingKicks.length && this.pendingKicks[0].row + KICK_CONFIRM <= r) {
      const k = this.pendingKicks.shift()!;
      // Kicks sweep down in pitch, so their low end peaks a few rows after the attack.
      let peakDb = -Infinity;
      for (let i = k.row; i <= k.row + 4; i++) peakDb = Math.max(peakDb, this.feats[i].lowDb);
      if (peakDb - this.feats[k.row + KICK_CONFIRM].lowDb < KICK_DECAY_DB) continue;
      if (k.row - this.last.kick < 6) continue;
      this.last.kick = k.row;
      this.hits.push({ row: k.row, kind: 'kick', velocity: Math.min(1, k.velocity) });
    }
  }

  private decide(r: number) {
    const [p, f, n] = [this.feats[r - 1], this.feats[r], this.feats[r + 1]];
    const peak = (k: keyof Features) => f[k] >= p[k] && f[k] > n[k];
    const above = (k: 'low' | 'body' | 'noise' | 'high', min: number) => f[k] > min + 2.5 * this.ema[k];
    const strict = this.strict;
    const hit = (kind: DrumKind, strength: number) => {
      if (r - this.last[kind] < 6) return;
      this.last[kind] = r;
      this.hits.push({ row: r, kind, velocity: Math.min(1, strength) });
    };

    // Kick: a big jump in the low band that dominates both the body (snares have a strong
    // body) and the noise band. Bass and low piano notes pass this too; confirmKicks()
    // weeds them out because they don't die away quickly.
    // (A pitched note's attack can hit the low band a row before its body shows up, hence
    // comparing against the body over two rows.)
    const kick =
      peak('low') && above('low', 0.4) && f.low > 2.5 * f.noise && f.low > 1.5 * Math.max(f.body, n.body);
    if (kick) {
      this.pendingKicks.push({ row: r, velocity: f.low / 3 });
      this.lastKickCandidate = r;
    }
    // A kick's noise often peaks a row later; don't read that as a snare.
    const nearKick = r - this.lastKickCandidate <= 2;

    // Snare / hi-hat: a broadband noise jump. A snare also has a strong body (150 Hz-1 kHz);
    // a hi-hat is almost all noise. When a kick lands at the same moment its body masks the
    // snare test, so noise on top of a kick is taken to be a hi-hat.
    const coverage = strict ? 0.45 : 0.3;
    if (f.noiseCoverage > coverage && peak('noise') && above('noise', 0.1)) {
      if (!nearKick && (f.low + f.body) / 2 > 0.8 * f.noise) hit('snare', f.noise / 1.5);
      else if (f.highCoverage > coverage) hit('hihat', f.high / 1.2);
    }
  }
}
