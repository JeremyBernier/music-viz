declare module 'demucs-web' {
  type Stereo = { left: Float32Array; right: Float32Array };
  export const CONSTANTS: { SAMPLE_RATE: number; DEFAULT_MODEL_URL: string; TRACKS: string[] };
  export class DemucsProcessor {
    constructor(options: {
      ort: unknown;
      onProgress?: (p: { progress: number; currentSegment: number; totalSegments: number }) => void;
      sessionOptions?: Record<string, unknown>;
    });
    loadModel(model: ArrayBuffer | string): Promise<unknown>;
    separate(left: Float32Array, right: Float32Array): Promise<Record<'drums' | 'bass' | 'other' | 'vocals', Stereo>>;
  }
}
