import { MIDI_OFFSET, N_PITCHES, secondsToFrame } from './constants';
import type { FrameStore } from './transcriber';

export interface Note {
  /** MIDI pitch (21 = A0 .. 108 = C8). */
  pitch: number;
  /** Start row in the frame store (1 row = 256 / 22050 s). */
  start: number;
  /** End row (exclusive). */
  end: number;
  /** Mean model confidence while sounding, 0..1. Used as a velocity proxy. */
  amplitude: number;
}

export interface NoteParams {
  /** Onset peak threshold: lower = more notes detected. */
  onsetThreshold: number;
  /** Sustain threshold: lower = notes held longer. */
  frameThreshold: number;
  /** Notes shorter than this are dropped. */
  minNoteMs: number;
  /** Also pick up sustained energy that has no detected onset. */
  melodiaTrick: boolean;
}

export const DEFAULT_PARAMS: NoteParams = {
  onsetThreshold: 0.5,
  frameThreshold: 0.3,
  minNoteMs: 60,
  melodiaTrick: true,
};

/** Frames below threshold tolerated before a note is considered ended. */
const ENERGY_TOLERANCE = 11;

/**
 * Decode notes from rows [from, to) of the model output.
 * Port of Basic Pitch's `output_to_notes_polyphonic`, using flat typed arrays so it is
 * fast enough to re-run many times per second while recording.
 *
 * `exclude` notes (already committed) have their energy removed so they aren't found again.
 */
export function extractNotes(
  store: FrameStore,
  from: number,
  to: number,
  params: NoteParams,
  exclude: Note[] = [],
): Note[] {
  const P = N_PITCHES;
  const n = to - from;
  if (n <= 1) return [];
  const frames = store.frames.subarray(from * P, to * P);
  const onsets = store.onsets.subarray(from * P, to * P);
  const minNoteLen = Math.max(1, Math.round(secondsToFrame(params.minNoteMs / 1000)));
  const thresh = params.frameThreshold;

  // Inferred onsets: max(onsets, rescaled positive frame differences over 1 and 2 rows).
  const all = store.frames;
  const diff = new Float32Array(n * P);
  let diffMax = 0;
  let onsetMax = 0;
  for (let r = 0; r < n; r++) {
    const g = from + r;
    for (let c = 0; c < P; c++) {
      const i = r * P + c;
      if (onsets[i] > onsetMax) onsetMax = onsets[i];
      if (g < 2) continue;
      const v = all[g * P + c];
      const d = Math.min(v - all[(g - 1) * P + c], v - all[(g - 2) * P + c]);
      if (d > 0) {
        diff[i] = d;
        if (d > diffMax) diffMax = d;
      }
    }
  }
  const scale = diffMax > 0 ? onsetMax / diffMax : 0;
  const inferred = new Float32Array(n * P);
  for (let i = 0; i < n * P; i++) inferred[i] = Math.max(onsets[i], diff[i] * scale);

  // Onset peaks (strict local maxima in time) above threshold.
  const starts: [number, number][] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < P; c++) {
      const v = inferred[r * P + c];
      if (v <= params.onsetThreshold) continue;
      if (r > 0 && !(v > inferred[(r - 1) * P + c])) continue;
      if (r < n - 1 && !(v > inferred[(r + 1) * P + c])) continue;
      starts.push([r, c]);
    }
  }

  const remaining = frames.slice();
  const zero = (r: number, c: number) => {
    remaining[r * P + c] = 0;
    if (c < P - 1) remaining[r * P + c + 1] = 0;
    if (c > 0) remaining[r * P + c - 1] = 0;
  };
  for (const note of exclude) {
    const c = note.pitch - MIDI_OFFSET;
    for (let g = Math.max(note.start, from); g < Math.min(note.end, to); g++) zero(g - from, c);
  }

  const meanAmp = (r0: number, r1: number, c: number) => {
    let s = 0;
    for (let r = r0; r < r1; r++) s += frames[r * P + c];
    return s / (r1 - r0);
  };

  const notes: Note[] = [];
  // Latest onsets first, as in the reference implementation.
  for (let s = starts.length - 1; s >= 0; s--) {
    const [r0, c] = starts[s];
    if (r0 >= n - 1) continue;
    let i = r0 + 1;
    let k = 0;
    while (i < n - 1 && k < ENERGY_TOLERANCE) {
      k = remaining[i * P + c] < thresh ? k + 1 : 0;
      i++;
    }
    i -= k;
    if (i - r0 <= minNoteLen) continue;
    for (let r = r0; r < i; r++) zero(r, c);
    notes.push({ pitch: c + MIDI_OFFSET, start: from + r0, end: from + i, amplitude: meanAmp(r0, i, c) });
  }

  if (params.melodiaTrick) {
    // Repeatedly take the strongest remaining cell and grow a note around it. Values only
    // ever get zeroed, so walking cells in descending order visits the same global maxima
    // as rescanning the whole matrix each time.
    const candidates: number[] = [];
    for (let i = 0; i < n * P; i++) if (remaining[i] > thresh) candidates.push(i);
    const initial = remaining.slice();
    candidates.sort((a, b) => initial[b] - initial[a]);
    for (const idx of candidates) {
      if (remaining[idx] !== initial[idx]) continue; // consumed by an earlier note
      const mid = Math.floor(idx / P);
      const c = idx % P;
      remaining[idx] = 0;

      let i = mid + 1;
      let k = 0;
      while (i < n - 1 && k < ENERGY_TOLERANCE) {
        k = remaining[i * P + c] < thresh ? k + 1 : 0;
        zero(i, c);
        i++;
      }
      const iEnd = i - 1 - k;

      i = mid - 1;
      k = 0;
      while (i > 0 && k < ENERGY_TOLERANCE) {
        k = remaining[i * P + c] < thresh ? k + 1 : 0;
        zero(i, c);
        i--;
      }
      const iStart = i + 1 + k;

      if (iEnd - iStart <= minNoteLen) continue;
      notes.push({ pitch: c + MIDI_OFFSET, start: from + iStart, end: from + iEnd, amplitude: meanAmp(iStart, iEnd, c) });
    }
  }

  return notes;
}

/**
 * Incrementally decodes notes while rows stream in. Notes that have clearly ended are
 * committed and never recomputed; only the recent tail of the recording is re-decoded on
 * each update, so the cost stays constant as the recording grows.
 */
export class NoteTracker {
  private committed: Note[] = [];
  private tentative: Note[] = [];
  private commitRow = 0;

  constructor(public params: NoteParams) {}

  get notes(): Note[] {
    return this.tentative.length ? this.committed.concat(this.tentative) : this.committed;
  }

  reset() {
    this.committed = [];
    this.tentative = [];
    this.commitRow = 0;
  }

  update(store: FrameStore, final = false) {
    const N = store.rows;
    const CONTEXT = 20;
    const from = Math.max(0, this.commitRow - CONTEXT);
    const exclude = this.committed.filter((n) => n.end > from);
    const found = extractNotes(store, from, N, this.params, exclude).filter((n) => n.start >= this.commitRow);

    if (final) {
      this.committed = this.committed.concat(found).sort((a, b) => a.start - b.start);
      this.tentative = [];
      this.commitRow = N;
      return;
    }

    // A note is settled once it ended well before the newest row.
    const settleRow = N - ENERGY_TOLERANCE - 8;
    let newCommit = settleRow;
    for (const n of found) if (n.end >= settleRow) newCommit = Math.min(newCommit, n.start);
    newCommit = Math.max(newCommit, this.commitRow);

    const tentative: Note[] = [];
    for (const n of found) {
      if (n.start < newCommit && n.end < settleRow) this.committed.push(n);
      else tentative.push(n);
    }
    this.tentative = tentative;
    this.commitRow = newCommit;
  }

  /** Re-decode everything from scratch (e.g. after changing parameters). */
  recompute(store: FrameStore) {
    this.reset();
    this.update(store, true);
  }
}
