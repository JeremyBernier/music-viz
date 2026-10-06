import { frameToSeconds } from './constants';
import { DRUM_KINDS, type DrumHit, type Instrument } from './instruments';
import type { Note } from './notes';

const PPQ = 480;
const BPM = 120;
const secondsToTicks = (s: number) => Math.round((s * BPM * PPQ) / 60);
const velocity = (x: number) => Math.max(20, Math.min(127, Math.round(30 + x * 100)));

function varLen(n: number): number[] {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}

const u32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const text = (s: string) => [...new TextEncoder().encode(s)];

type Ev = { tick: number; on: boolean; pitch: number; vel: number };

function track(name: string, channel: number, program: number | null, events: Ev[], tempo = false): number[] {
  // Note-offs before note-ons at the same tick so repeated notes retrigger cleanly.
  events.sort((a, b) => a.tick - b.tick || Number(a.on) - Number(b.on));
  const t: number[] = [];
  const nameBytes = text(name);
  t.push(0, 0xff, 0x03, ...varLen(nameBytes.length), ...nameBytes);
  if (tempo) {
    const us = Math.round(60_000_000 / BPM);
    t.push(0, 0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff);
  }
  if (program !== null) t.push(0, 0xc0 | channel, program);
  let last = 0;
  for (const e of events) {
    t.push(...varLen(e.tick - last), (e.on ? 0x90 : 0x80) | channel, e.pitch, e.vel);
    last = e.tick;
  }
  t.push(0, 0xff, 0x2f, 0x00);
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(t.length), ...t];
}

const TRACKS: { instrument: Instrument; name: string; channel: number; program: number }[] = [
  { instrument: 'piano', name: 'Piano / other', channel: 0, program: 0 }, // Acoustic Grand Piano
  { instrument: 'bass', name: 'Bass', channel: 1, program: 33 }, // Electric Bass (finger)
  { instrument: 'vocals', name: 'Vocals', channel: 2, program: 53 }, // Voice Oohs
];

/** Encode notes and drum hits as a Standard MIDI File (format 1, one track per instrument, 120 BPM). */
export function notesToMidi(notes: Note[], drums: DrumHit[]): Uint8Array {
  const tracks: number[][] = [];
  for (const def of TRACKS) {
    const ns = notes.filter((n) => n.instrument === def.instrument);
    if (!ns.length) continue;
    const events: Ev[] = [];
    for (const n of ns) {
      events.push({ tick: secondsToTicks(frameToSeconds(n.start)), on: true, pitch: n.pitch, vel: velocity(n.amplitude) });
      events.push({ tick: secondsToTicks(frameToSeconds(n.end)), on: false, pitch: n.pitch, vel: 0 });
    }
    tracks.push(track(def.name, def.channel, def.program, events, tracks.length === 0));
  }
  if (drums.length) {
    const events: Ev[] = [];
    for (const h of drums) {
      const pitch = DRUM_KINDS.find((d) => d.kind === h.kind)!.gmNote;
      const tick = secondsToTicks(frameToSeconds(h.row));
      events.push({ tick, on: true, pitch, vel: velocity(h.velocity) });
      events.push({ tick: tick + PPQ / 8, on: false, pitch, vel: 0 });
    }
    // General MIDI channel 10 (index 9) is percussion.
    tracks.push(track('Drums', 9, null, events, tracks.length === 0));
  }
  if (!tracks.length) tracks.push(track('Empty', 0, null, [], true));

  const header = [0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 1, 0, tracks.length, (PPQ >> 8) & 0xff, PPQ & 0xff];
  return new Uint8Array([...header, ...tracks.flat()]);
}
