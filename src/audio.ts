import { SAMPLE_RATE } from './constants';

const WORKLET_SOURCE = `
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.len = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      this.buf.set(ch, this.len);
      this.len += ch.length;
      if (this.len >= 1024) {
        this.port.postMessage(this.buf.slice(0, this.len));
        this.len = 0;
      }
    }
    return true;
  }
}
registerProcessor('capture', Capture);
`;

/** Streaming linear-interpolation resampler (input is low-pass filtered beforehand). */
class Resampler {
  private pos = 0;
  private last = 0;
  constructor(private ratio: number) {}

  process(input: Float32Array): Float32Array {
    if (this.ratio === 1) return input;
    // Index 0 is the last sample of the previous chunk, so interpolation spans chunk boundaries.
    const buf = new Float32Array(input.length + 1);
    buf[0] = this.last;
    buf.set(input, 1);
    // `pos` indexes into `buf`, so it stays in [0, input.length) and buf[i + 1] always exists.
    const out = new Float32Array(Math.ceil((input.length - this.pos) / this.ratio) + 1);
    let n = 0;
    while (this.pos < input.length) {
      const i = Math.floor(this.pos);
      const f = this.pos - i;
      out[n++] = buf[i] * (1 - f) + buf[i + 1] * f;
      this.pos += this.ratio;
    }
    this.pos -= input.length;
    this.last = input[input.length - 1];
    return out.subarray(0, n);
  }
}

export interface Recorder {
  /** Stop recording and return the captured audio at the device's native rate. */
  stop(): Promise<AudioBuffer>;
}

export async function listInputs(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
}

/**
 * Record from an input device. `onAudio` receives 22.05 kHz mono chunks for the model;
 * `onLevel` receives the RMS level of each chunk. `stop()` returns the full recording at the
 * device's native rate for playback.
 */
export async function startRecording(
  deviceId: string | undefined,
  onAudio: (samples: Float32Array) => void,
  onLevel: (rms: number) => void,
): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      // These are designed for speech and wreck music (they'd cut sustained piano notes).
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });
  const context = new AudioContext();
  const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
  await context.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, 'capture', { numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });

  // Anti-aliasing: 4th-order Butterworth low-pass below the model's Nyquist (11.025 kHz).
  let last: AudioNode = source;
  if (context.sampleRate !== SAMPLE_RATE) {
    for (const q of [0.5412, 1.3066]) {
      const lp = context.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = SAMPLE_RATE * 0.45;
      lp.Q.value = q;
      last.connect(lp);
      last = lp;
    }
  }
  last.connect(node);
  // Keep the graph pulled without making any sound.
  const mute = context.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(context.destination);

  // Capture the unfiltered signal separately for faithful playback.
  const rawChunks: Float32Array[] = [];
  const rawNode = new AudioWorkletNode(context, 'capture', { numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
  source.connect(rawNode);
  rawNode.connect(mute);
  rawNode.port.onmessage = (e) => rawChunks.push(e.data as Float32Array);

  const resampler = new Resampler(context.sampleRate / SAMPLE_RATE);
  node.port.onmessage = (e) => {
    const chunk = e.data as Float32Array;
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    onLevel(Math.sqrt(sum / chunk.length));
    onAudio(resampler.process(chunk));
  };

  return {
    async stop() {
      stream.getTracks().forEach((t) => t.stop());
      source.disconnect();
      node.port.onmessage = null;
      rawNode.port.onmessage = null;
      const total = rawChunks.reduce((n, c) => n + c.length, 0);
      const buffer = context.createBuffer(1, Math.max(1, total), context.sampleRate);
      const data = buffer.getChannelData(0);
      let off = 0;
      for (const c of rawChunks) {
        data.set(c, off);
        off += c.length;
      }
      await context.close();
      return buffer;
    },
  };
}

/** Decode an audio file and resample it to 22.05 kHz mono for the model. */
export async function decodeFile(file: File): Promise<{ original: AudioBuffer; mono22k: Float32Array }> {
  const bytes = await file.arrayBuffer();
  const ctx = new AudioContext();
  const original = await ctx.decodeAudioData(bytes);
  await ctx.close();
  const offline = new OfflineAudioContext(1, Math.ceil(original.duration * SAMPLE_RATE), SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = original; // multi-channel is down-mixed to the mono destination
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return { original, mono22k: rendered.getChannelData(0) };
}
