import { frameToSeconds } from './constants';
import type { Note } from './notes';

export type PlayMode = 'notes' | 'audio' | 'both';

const midiToHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

/** Plays transcribed notes with a simple piano-like synth, and/or the original recording. */
export class Player {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private wave: PeriodicWave | null = null;
  private nodes: AudioScheduledSourceNode[] = [];
  private startedAt = 0;
  private offset = 0;
  private endTime = 0;
  playing = false;
  onEnded: () => void = () => {};

  private ensure() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      const comp = this.ctx.createDynamicsCompressor();
      comp.connect(this.ctx.destination);
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(comp);
      // Decaying harmonics: a soft, vaguely piano/e-piano tone.
      const real = new Float32Array([0, 1, 0.45, 0.22, 0.12, 0.06, 0.03]);
      this.wave = this.ctx.createPeriodicWave(real, new Float32Array(real.length));
    }
    return this.ctx;
  }

  /** Current position in seconds. */
  get position() {
    if (!this.playing || !this.ctx) return this.offset;
    return this.offset + (this.ctx.currentTime - this.startedAt);
  }

  private voice(pitch: number, when: number, duration: number, velocity: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(this.wave!);
    osc.frequency.value = midiToHz(pitch);
    const g = ctx.createGain();
    const peak = 0.12 + 0.3 * velocity;
    const release = 0.12;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.005);
    // Piano-ish decay: fast initial drop, then a slow tail while held.
    g.gain.setTargetAtTime(peak * 0.35, when + 0.005, 0.25);
    g.gain.setTargetAtTime(0, when + duration, release / 3);
    osc.connect(g).connect(this.master!);
    osc.start(when);
    osc.stop(when + duration + release * 2);
    this.nodes.push(osc);
  }

  /** Audition a single note immediately. */
  preview(pitch: number, duration = 0.5, velocity = 0.7) {
    const ctx = this.ensure();
    void ctx.resume();
    this.voice(pitch, ctx.currentTime + 0.01, duration, velocity);
  }

  play(notes: Note[], from: number, mode: PlayMode, audio: AudioBuffer | null) {
    this.stop();
    const ctx = this.ensure();
    void ctx.resume();
    const t0 = ctx.currentTime + 0.05;
    this.startedAt = t0;
    this.offset = from;
    this.playing = true;
    this.endTime = from;

    if (mode !== 'audio') {
      for (const n of notes) {
        const s = frameToSeconds(n.start);
        const e = frameToSeconds(n.end);
        if (e <= from) continue;
        const start = Math.max(s, from);
        this.voice(n.pitch, t0 + start - from, e - start, Math.min(1, n.amplitude * 1.2));
        this.endTime = Math.max(this.endTime, e + 0.3);
      }
    }
    if (mode !== 'notes' && audio && from < audio.duration) {
      const src = ctx.createBufferSource();
      src.buffer = audio;
      src.connect(ctx.destination);
      src.start(t0, from);
      this.nodes.push(src);
      this.endTime = Math.max(this.endTime, audio.duration);
    }
  }

  /** Call from an animation loop; fires onEnded when playback runs past the last note. */
  tick() {
    if (this.playing && this.position >= this.endTime) {
      this.stop();
      this.onEnded();
    }
  }

  stop() {
    if (this.playing) this.offset = this.position;
    this.playing = false;
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        /* already stopped */
      }
      n.disconnect();
    }
    this.nodes = [];
  }
}
