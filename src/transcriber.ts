import * as tf from '@tensorflow/tfjs';
import {
  EDGE_FRAMES,
  FFT_HOP,
  KEPT_FRAMES,
  N_PITCHES,
  WINDOW_FRAMES,
  WINDOW_SAMPLES,
} from './constants';

/** Growable per-frame model output: `frames` (note is sounding) and `onsets` (note starts), 88 values per row. */
export class FrameStore {
  frames = new Float32Array(N_PITCHES * 1024);
  onsets = new Float32Array(N_PITCHES * 1024);
  rows = 0;

  append(frames: Float32Array, onsets: Float32Array, nRows: number) {
    const needed = (this.rows + nRows) * N_PITCHES;
    if (needed > this.frames.length) {
      const cap = Math.max(needed, this.frames.length * 2);
      const grow = (a: Float32Array) => {
        const b = new Float32Array(cap);
        b.set(a.subarray(0, this.rows * N_PITCHES));
        return b;
      };
      this.frames = grow(this.frames);
      this.onsets = grow(this.onsets);
    }
    this.frames.set(frames.subarray(0, nRows * N_PITCHES), this.rows * N_PITCHES);
    this.onsets.set(onsets.subarray(0, nRows * N_PITCHES), this.rows * N_PITCHES);
    this.rows += nRows;
  }

  truncate(rows: number) {
    this.rows = Math.min(this.rows, rows);
  }
}

let modelPromise: Promise<tf.GraphModel> | null = null;

export function loadModel(): Promise<tf.GraphModel> {
  modelPromise ??= (async () => {
    try {
      await tf.setBackend('webgl');
    } catch {
      await tf.setBackend('cpu');
    }
    await tf.ready();
    const model = await tf.loadGraphModel(`${import.meta.env.BASE_URL}model/model.json`);
    // Warm up so the first real window isn't slow (shader compilation).
    const out = model.execute(tf.zeros([1, WINDOW_SAMPLES, 1]), ['Identity_1']) as tf.Tensor;
    await out.data();
    out.dispose();
    return model;
  })();
  return modelPromise;
}

/**
 * Streams 22.05 kHz mono audio through Basic Pitch.
 *
 * Output row `r` corresponds to time r * 256 / 22050 s. The audio is prefixed with
 * EDGE_FRAMES hops of silence so that row 0 sits at time 0 and can be taken from the
 * trusted (non-edge) part of a window.
 *
 * While recording, each inference uses the most recent full window of audio and keeps
 * only rows not yet computed, so new notes show up ~0.5 s after being played instead of
 * waiting for a whole new 2 s window.
 */
export class StreamingTranscriber {
  readonly store = new FrameStore();
  private audio = new Float32Array(22050 * 60);
  private audioLen = EDGE_FRAMES * FFT_HOP; // starts with the silent prefix
  private busy = false;
  private finalRows: number | null = null;

  /** Minimum new rows (~0.2 s) before running another inference while streaming. */
  private static readonly MIN_NEW_ROWS = 18;

  constructor(
    private model: tf.GraphModel,
    private onRows: () => void,
  ) {}

  /** Number of audio samples received so far (excluding the silent prefix). */
  get receivedSamples() {
    return this.audioLen - EDGE_FRAMES * FFT_HOP;
  }

  push(samples: Float32Array) {
    if (this.finalRows !== null) return;
    this.ensureCapacity(this.audioLen + samples.length);
    this.audio.set(samples, this.audioLen);
    // A single NaN would turn the model's whole 2 s window into NaN, so scrub them.
    for (let i = this.audioLen; i < this.audioLen + samples.length; i++) {
      if (!Number.isFinite(this.audio[i])) this.audio[i] = 0;
    }
    this.audioLen += samples.length;
    void this.pump();
  }

  /** Flush the remaining audio (zero-padded) through the model. Resolves when all rows are computed. */
  async finish(): Promise<void> {
    if (this.finalRows === null) {
      this.finalRows = Math.ceil(this.receivedSamples / FFT_HOP);
      // Pad with a full window of silence so every remaining row can be computed.
      const pad = WINDOW_SAMPLES + KEPT_FRAMES * FFT_HOP;
      this.ensureCapacity(this.audioLen + pad);
      this.audio.fill(0, this.audioLen, this.audioLen + pad);
      this.audioLen += pad;
    }
    await this.pump();
    this.store.truncate(this.finalRows);
  }

  private ensureCapacity(n: number) {
    if (n <= this.audio.length) return;
    const bigger = new Float32Array(Math.max(n, this.audio.length * 2));
    bigger.set(this.audio.subarray(0, this.audioLen));
    this.audio = bigger;
  }

  /** Window start (in hops) for the next inference, or null if not enough new audio yet. */
  private nextWindow(): number | null {
    const r0 = this.store.rows;
    const final = this.finalRows !== null;
    if (final && r0 >= this.finalRows!) return null;
    const latest = Math.floor((this.audioLen - WINDOW_SAMPLES) / FFT_HOP);
    // A window starting at hop w yields trusted rows [w, w + KEPT_FRAMES).
    const w = Math.min(r0, latest);
    if (w < 0) return null;
    const newRows = w + KEPT_FRAMES - r0;
    if (newRows <= 0) return null;
    if (!final && newRows < StreamingTranscriber.MIN_NEW_ROWS) return null;
    return w;
  }

  private async pump() {
    if (this.busy) return this.pumpPromise;
    this.busy = true;
    this.pumpPromise = (async () => {
      try {
        let w: number | null;
        while ((w = this.nextWindow()) !== null) {
          await this.runWindow(w);
          this.onRows();
          await new Promise((r) => setTimeout(r, 0)); // let the UI breathe
        }
      } finally {
        this.busy = false;
      }
    })();
    return this.pumpPromise;
  }
  private pumpPromise: Promise<void> = Promise.resolve();

  private async runWindow(w: number) {
    const start = w * FFT_HOP;
    const input = tf.tensor3d(this.audio.slice(start, start + WINDOW_SAMPLES), [1, WINDOW_SAMPLES, 1]);
    const [framesT, onsetsT] = this.model.execute(input, ['Identity_1', 'Identity_2']) as tf.Tensor[];
    const [frames, onsets] = (await Promise.all([framesT.data(), onsetsT.data()])) as Float32Array[];
    tf.dispose([input, framesT, onsetsT]);

    // Model row m of this window corresponds to global row w + m - EDGE_FRAMES.
    const r0 = this.store.rows;
    const mFrom = r0 - w + EDGE_FRAMES;
    const mTo = WINDOW_FRAMES - EDGE_FRAMES;
    const n = mTo - mFrom;
    this.store.append(
      frames.subarray(mFrom * N_PITCHES, mTo * N_PITCHES),
      onsets.subarray(mFrom * N_PITCHES, mTo * N_PITCHES),
      n,
    );
  }
}
