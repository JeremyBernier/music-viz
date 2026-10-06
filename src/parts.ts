import { secondsToFrame } from './constants';
import type { DrumHit } from './instruments';
import type { Note } from './notes';

/** Below this pitch (C3) a note is guessed to be bass while recording. */
const LIVE_BASS_BELOW = 48;

/**
 * Rough instrument guess used while recording, before source separation is possible:
 * low notes are called bass, and short low "notes" right on a kick are dropped (the note
 * model tends to hear a kick as a brief low pitch).
 */
export function classifyLive(notes: Note[], hits: DrumHit[]): Note[] {
  const kicks = hits.filter((h) => h.kind === 'kick').map((h) => h.row);
  const short = secondsToFrame(0.15);
  const onKick = (row: number) => kicks.some((k) => Math.abs(k - row) <= 3);
  const out: Note[] = [];
  for (const n of notes) {
    if (n.pitch < 45 && n.end - n.start < short && onKick(n.start)) continue;
    out.push(n.pitch < LIVE_BASS_BELOW ? { ...n, instrument: 'bass' } : n);
  }
  return out;
}

/**
 * Combine notes transcribed from separate stems. Separation isn't perfect, so the same note
 * can bleed into two stems: when notes of the same pitch overlap by more than half, keep
 * the more confident one.
 */
export function mergeStemNotes(lists: Note[][]): Note[] {
  const byPitch = new Map<number, Note[]>();
  for (const list of lists) {
    for (const n of list) {
      const arr = byPitch.get(n.pitch);
      if (arr) arr.push(n);
      else byPitch.set(n.pitch, [n]);
    }
  }
  const out: Note[] = [];
  for (const arr of byPitch.values()) {
    arr.sort((a, b) => b.amplitude - a.amplitude);
    const kept: Note[] = [];
    for (const n of arr) {
      const dup = kept.some((k) => {
        if (k.instrument === n.instrument) return false;
        const overlap = Math.min(k.end, n.end) - Math.max(k.start, n.start);
        return overlap > 0.5 * Math.min(k.end - k.start, n.end - n.start);
      });
      if (!dup) kept.push(n);
    }
    out.push(...kept);
  }
  return out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}
