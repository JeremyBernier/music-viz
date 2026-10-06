import { SAMPLE_RATE } from './constants';
import type { Stem, WorkerMessage } from './separation.worker';

export type { Stem };
const DEMUCS_RATE = 44100;

export type SeparationStatus =
  | { phase: 'download'; loaded: number; total: number }
  | { phase: 'loading' }
  | { phase: 'separating'; progress: number; backend: string }
  | { phase: 'transcribing' };

let worker: Worker | null = null;
let cancelActive: (() => void) | null = null;

/** Abort a separation in progress (the worker is restarted on next use). */
export function cancelSeparation() {
  if (!cancelActive) return;
  worker?.terminate();
  worker = null;
  cancelActive();
}

async function resample(channels: Float32Array[], fromRate: number, toRate: number, outChannels: number): Promise<AudioBuffer> {
  const length = Math.ceil((channels[0].length * toRate) / fromRate);
  const ctx = new OfflineAudioContext(outChannels, Math.max(1, length), toRate);
  const buf = ctx.createBuffer(channels.length, channels[0].length, fromRate);
  channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

/**
 * Split a recording into drums / bass / other / vocals with Demucs (in a worker), and
 * return each stem as 22.05 kHz mono, ready for the note model.
 */
export async function separateStems(
  audio: AudioBuffer,
  onStatus: (s: SeparationStatus) => void,
): Promise<Record<Stem, Float32Array>> {
  const input = [...Array(audio.numberOfChannels)].map((_, i) => audio.getChannelData(i));
  const stereo = await resample(input, audio.sampleRate, DEMUCS_RATE, 2);
  const left = stereo.getChannelData(0).slice();
  const right = stereo.getChannelData(1).slice();

  worker ??= new Worker(new URL('./separation.worker.ts', import.meta.url), { type: 'module' });
  const stems = await new Promise<Record<Stem, Float32Array>>((resolve, reject) => {
    cancelActive = () => reject(new Error('cancelled'));
    worker!.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const m = e.data;
      if (m.type === 'download') onStatus({ phase: 'download', loaded: m.loaded, total: m.total });
      else if (m.type === 'loading') onStatus({ phase: 'loading' });
      else if (m.type === 'progress') onStatus({ phase: 'separating', progress: m.progress, backend: m.backend });
      else if (m.type === 'done') resolve(m.stems);
      else reject(new Error(m.message));
    };
    worker!.onerror = (e) => reject(new Error(e.message || 'separation worker crashed'));
    worker!.postMessage({ left, right }, [left.buffer, right.buffer]);
  }).finally(() => (cancelActive = null));

  onStatus({ phase: 'transcribing' });
  const out = {} as Record<Stem, Float32Array>;
  for (const [k, v] of Object.entries(stems) as [Stem, Float32Array][]) {
    out[k] = (await resample([v], DEMUCS_RATE, SAMPLE_RATE, 1)).getChannelData(0);
  }
  return out;
}
