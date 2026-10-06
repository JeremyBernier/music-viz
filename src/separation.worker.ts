/// <reference lib="webworker" />
// Runs Demucs (drums / bass / other / vocals source separation) off the main thread.
import * as ort from 'onnxruntime-web/webgpu';
// Imported by path: this onnxruntime-web version doesn't list the .wasm in its package exports.
import wasmUrl from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';
import { CONSTANTS, DemucsProcessor } from 'demucs-web';

export type Stem = 'drums' | 'bass' | 'other' | 'vocals';
export type WorkerRequest = { left: Float32Array; right: Float32Array };
export type WorkerMessage =
  | { type: 'download'; loaded: number; total: number }
  | { type: 'loading' }
  | { type: 'progress'; progress: number; backend: string }
  | { type: 'done'; stems: Record<Stem, Float32Array> }
  | { type: 'error'; message: string };

ort.env.wasm.wasmPaths = { wasm: new URL(wasmUrl, self.location.href).href };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

const post = (m: WorkerMessage, transfer: Transferable[] = []) => self.postMessage(m, transfer);
// Errors thrown from inside ONNX Runtime's own callbacks escape our try/catch; report them
// instead of leaving the page waiting forever.
self.addEventListener('unhandledrejection', (e) => {
  console.error('[separation]', e.reason);
  post({ type: 'error', message: String(e.reason?.message ?? e.reason) });
});
self.addEventListener('error', (e) => {
  console.error('[separation]', e.error ?? e.message);
  post({ type: 'error', message: e.message });
});
const MODEL_URL = CONSTANTS.DEFAULT_MODEL_URL;

/** Fetch the ~172 MB model once and keep it in Cache Storage for later sessions. */
async function fetchModel(): Promise<ArrayBuffer> {
  const cache = await caches.open('demucs-model-v1').catch(() => null);
  const cached = await cache?.match(MODEL_URL);
  if (cached) return cached.arrayBuffer();

  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`model download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('Content-Length')) || 172_000_000;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let lastPost = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (loaded - lastPost > 1_000_000) {
      lastPost = loaded;
      post({ type: 'download', loaded, total });
    }
  }
  const bytes = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.length;
  }
  await cache?.put(MODEL_URL, new Response(bytes.slice(0), { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {});
  return bytes.buffer;
}

let backend = 'wasm';
let processorPromise: Promise<DemucsProcessor> | null = null;

function getProcessor() {
  processorPromise ??= (async () => {
    const model = await fetchModel();
    post({ type: 'loading' });
    const hasGpu = 'gpu' in navigator && !!(await (navigator as any).gpu.requestAdapter().catch(() => null));
    backend = hasGpu ? 'webgpu' : 'wasm';
    const p = new DemucsProcessor({
      ort,
      sessionOptions: { executionProviders: hasGpu ? ['webgpu', 'wasm'] : ['wasm'] },
      onProgress: ({ progress }) => post({ type: 'progress', progress, backend }),
    });
    await p.loadModel(model);
    return p;
  })();
  processorPromise.catch(() => (processorPromise = null));
  return processorPromise;
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  try {
    const processor = await getProcessor();
    post({ type: 'progress', progress: 0, backend });
    const out = await processor.separate(e.data.left, e.data.right);
    const stems = {} as Record<Stem, Float32Array>;
    for (const k of ['drums', 'bass', 'other', 'vocals'] as Stem[]) {
      const { left, right } = out[k];
      const mono = new Float32Array(left.length);
      for (let i = 0; i < mono.length; i++) mono[i] = 0.5 * (left[i] + right[i]);
      stems[k] = mono;
    }
    post({ type: 'done', stems }, Object.values(stems).map((s) => s.buffer));
  } catch (err) {
    console.error('[separation]', err);
    post({ type: 'error', message: (err as Error)?.message ?? String(err) });
  }
};
