export type Instrument = 'piano' | 'bass' | 'vocals';
export type DrumKind = 'kick' | 'snare' | 'hihat';
/** Everything that can be shown / hidden in the legend. */
export type Part = Instrument | 'drums';

export interface DrumHit {
  /** Row in the frame grid (1 row = 256 / 22050 s). */
  row: number;
  kind: DrumKind;
  /** 0..1 */
  velocity: number;
}

export const PARTS: { id: Part; label: string; rgb: readonly [number, number, number] }[] = [
  // Demucs' "other" stem holds everything that isn't drums, bass or vocals, so this is
  // piano plus guitars, synths, etc.
  { id: 'piano', label: 'Piano / other', rgb: [126, 224, 138] },
  { id: 'bass', label: 'Bass', rgb: [98, 170, 255] },
  { id: 'drums', label: 'Drums', rgb: [255, 184, 77] },
  { id: 'vocals', label: 'Vocals', rgb: [236, 128, 214] },
];

export const partRgb = (p: Part) => PARTS.find((x) => x.id === p)!.rgb;

export const DRUM_KINDS: { kind: DrumKind; label: string; short: string; gmNote: number }[] = [
  { kind: 'kick', label: 'Kick', short: 'K', gmNote: 36 },
  { kind: 'snare', label: 'Snare', short: 'S', gmNote: 38 },
  { kind: 'hihat', label: 'Hi-hat', short: 'H', gmNote: 42 },
];
