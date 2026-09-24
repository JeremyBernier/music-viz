import { frameToSeconds } from './constants';
import type { Note } from './notes';

const PPQ = 480;
const BPM = 120;
const secondsToTicks = (s: number) => Math.round((s * BPM * PPQ) / 60);

function varLen(n: number): number[] {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}

/** Encode notes as a single-track Standard MIDI File (format 0, 120 BPM). */
export function notesToMidi(notes: Note[]): Uint8Array {
  const events: { tick: number; on: boolean; pitch: number; vel: number }[] = [];
  for (const n of notes) {
    const vel = Math.max(20, Math.min(127, Math.round(30 + n.amplitude * 100)));
    events.push({ tick: secondsToTicks(frameToSeconds(n.start)), on: true, pitch: n.pitch, vel });
    events.push({ tick: secondsToTicks(frameToSeconds(n.end)), on: false, pitch: n.pitch, vel: 0 });
  }
  // Note-offs before note-ons at the same tick so repeated notes retrigger cleanly.
  events.sort((a, b) => a.tick - b.tick || Number(a.on) - Number(b.on));

  const track: number[] = [];
  const tempo = Math.round(60_000_000 / BPM);
  track.push(0, 0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff);
  track.push(0, 0xc0, 0); // Acoustic Grand Piano
  let last = 0;
  for (const e of events) {
    track.push(...varLen(e.tick - last), e.on ? 0x90 : 0x80, e.pitch, e.vel);
    last = e.tick;
  }
  track.push(0, 0xff, 0x2f, 0x00);

  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff];
  const len = track.length;
  const trackHeader = [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff];
  return new Uint8Array([...header, ...trackHeader, ...track]);
}
