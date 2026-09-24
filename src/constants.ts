// Constants of the Basic Pitch model (https://github.com/spotify/basic-pitch).
export const SAMPLE_RATE = 22050;
export const FFT_HOP = 256;
/** Samples per model input window (~2 s). */
export const WINDOW_SAMPLES = SAMPLE_RATE * 2 - FFT_HOP; // 43844
/** Output frames per model window. */
export const WINDOW_FRAMES = 172;
/** Frames trimmed from each edge of a window's output, where predictions are unreliable. */
export const EDGE_FRAMES = 15;
/** Usable frames per window after trimming both edges. */
export const KEPT_FRAMES = WINDOW_FRAMES - 2 * EDGE_FRAMES; // 142
/** Number of pitch bins (piano keys A0..C8). */
export const N_PITCHES = 88;
export const MIDI_OFFSET = 21;
export const FRAMES_PER_SECOND = SAMPLE_RATE / FFT_HOP; // ~86.13

export const frameToSeconds = (frame: number) => (frame * FFT_HOP) / SAMPLE_RATE;
export const secondsToFrame = (seconds: number) => (seconds * SAMPLE_RATE) / FFT_HOP;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (midi: number) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
export const isBlackKey = (midi: number) => [1, 3, 6, 8, 10].includes(midi % 12);
