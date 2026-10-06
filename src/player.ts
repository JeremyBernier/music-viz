import { frameToSeconds } from './constants';
import type { DrumHit, DrumKind, Instrument } from './instruments';
import type { Note } from './notes';

export type PlayMode = 'notes' | 'audio' | 'both';

const midiToHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

/** Plays transcribed notes and drum hits with simple synths, and/or the original recording. */
export class Player {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private pianoWave: PeriodicWave | null = null;
  private noise: AudioBuffer | null = null;
  private nodes: AudioScheduledSourceNode[] = [];
  private startedAt = 0;
  private offset = 0;
  private endTime = 0;
  playing = false;
  onEnded: () => void = () => {};

  private ensure() {
    if (!this.ctx) {
      const ctx = (this.ctx = new AudioContext());
      const comp = ctx.createDynamicsCompressor();
      comp.connect(ctx.destination);
      this.master = ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(comp);
      // Decaying harmonics: a soft, vaguely piano/e-piano tone.
      const real = new Float32Array([0, 1, 0.45, 0.22, 0.12, 0.06, 0.03]);
      this.pianoWave = ctx.createPeriodicWave(real, new Float32Array(real.length));
      this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return this.ctx;
  }

  /** Current position in seconds. */
  get position() {
    if (!this.playing || !this.ctx) return this.offset;
    return this.offset + (this.ctx.currentTime - this.startedAt);
  }

  private voice(instrument: Instrument, pitch: number, when: number, duration: number, velocity: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.frequency.value = midiToHz(pitch);
    const g = ctx.createGain();
    let out: AudioNode = g;
    let peak = 0.12 + 0.3 * velocity;
    const release = 0.12;
    g.gain.setValueAtTime(0, when);

    if (instrument === 'bass') {
      // Plucked bass: filtered sawtooth that darkens as it decays.
      osc.type = 'sawtooth';
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(1200, when);
      lp.frequency.setTargetAtTime(350, when, 0.15);
      g.connect(lp);
      out = lp;
      peak *= 1.2;
      g.gain.linearRampToValueAtTime(peak, when + 0.008);
      g.gain.setTargetAtTime(peak * 0.5, when + 0.008, 0.4);
    } else if (instrument === 'vocals') {
      // Soft sustained tone with vibrato.
      osc.type = 'triangle';
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = 5.5;
      depth.gain.value = midiToHz(pitch) * 0.006;
      lfo.connect(depth).connect(osc.frequency);
      lfo.start(when);
      lfo.stop(when + duration + release * 2);
      this.nodes.push(lfo);
      g.gain.linearRampToValueAtTime(peak * 0.8, when + 0.06);
    } else {
      osc.setPeriodicWave(this.pianoWave!);
      g.gain.linearRampToValueAtTime(peak, when + 0.005);
      // Piano-ish decay: fast initial drop, then a slow tail while held.
      g.gain.setTargetAtTime(peak * 0.35, when + 0.005, 0.25);
    }
    g.gain.setTargetAtTime(0, when + duration, release / 3);
    osc.connect(g);
    out.connect(this.master!);
    osc.start(when);
    osc.stop(when + duration + release * 2);
    this.nodes.push(osc);
  }

  private drum(kind: DrumKind, when: number, velocity: number) {
    const ctx = this.ctx!;
    const v = 0.4 + 0.6 * velocity;
    const g = ctx.createGain();
    g.connect(this.master!);
    if (kind === 'kick') {
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(150, when);
      osc.frequency.exponentialRampToValueAtTime(45, when + 0.12);
      g.gain.setValueAtTime(1.2 * v, when);
      g.gain.exponentialRampToValueAtTime(0.001, when + 0.35);
      osc.connect(g);
      osc.start(when);
      osc.stop(when + 0.4);
      this.nodes.push(osc);
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    if (kind === 'snare') {
      f.type = 'bandpass';
      f.frequency.value = 2500;
      f.Q.value = 0.6;
      g.gain.setValueAtTime(0.9 * v, when);
      g.gain.exponentialRampToValueAtTime(0.001, when + 0.18);
      // Body
      const body = ctx.createOscillator();
      const bg = ctx.createGain();
      body.frequency.value = 190;
      bg.gain.setValueAtTime(0.5 * v, when);
      bg.gain.exponentialRampToValueAtTime(0.001, when + 0.1);
      body.connect(bg).connect(this.master!);
      body.start(when);
      body.stop(when + 0.12);
      this.nodes.push(body);
    } else {
      f.type = 'highpass';
      f.frequency.value = 7000;
      g.gain.setValueAtTime(0.35 * v, when);
      g.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
    }
    src.connect(f).connect(g);
    src.start(when);
    src.stop(when + 0.25);
    this.nodes.push(src);
  }

  /** Audition a single note immediately. */
  preview(pitch: number, duration = 0.5, velocity = 0.7, instrument: Instrument = 'piano') {
    const ctx = this.ensure();
    void ctx.resume();
    this.voice(instrument, pitch, ctx.currentTime + 0.01, duration, velocity);
  }

  previewDrum(kind: DrumKind) {
    const ctx = this.ensure();
    void ctx.resume();
    this.drum(kind, ctx.currentTime + 0.01, 0.8);
  }

  play(notes: Note[], drums: DrumHit[], from: number, mode: PlayMode, audio: AudioBuffer | null) {
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
        this.voice(n.instrument, n.pitch, t0 + start - from, e - start, Math.min(1, n.amplitude * 1.2));
        this.endTime = Math.max(this.endTime, e + 0.3);
      }
      for (const h of drums) {
        const t = frameToSeconds(h.row);
        if (t < from) continue;
        this.drum(h.kind, t0 + t - from, h.velocity);
        this.endTime = Math.max(this.endTime, t + 0.4);
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
