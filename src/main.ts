import type { GraphModel } from '@tensorflow/tfjs';
import { decodeFile, listInputs, startRecording, type Recorder } from './audio';
import { frameToSeconds, SAMPLE_RATE } from './constants';
import { DrumDetector } from './drums';
import { PARTS, partRgb, type DrumHit, type DrumKind, type Instrument, type Part } from './instruments';
import { notesToMidi } from './midi';
import { DEFAULT_PARAMS, NoteTracker, type Note, type NoteParams } from './notes';
import { classifyLive, mergeStemNotes } from './parts';
import { formatTime, PianoRoll } from './pianoRoll';
import { Player, type PlayMode } from './player';
import { cancelSeparation, separateStems, type SeparationStatus, type Stem } from './separation';
import { loadModel, StreamingTranscriber } from './transcriber';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const recordBtn = $<HTMLButtonElement>('record');
const playBtn = $<HTMLButtonElement>('play');
const exportBtn = $<HTMLButtonElement>('export');
const clock = $('clock');
const statusEl = $('status');
const countEl = $('count');
const levelEl = $('level');
const deviceSel = $<HTMLSelectElement>('device');
const playModeSel = $<HTMLSelectElement>('playMode');
const fileInput = $<HTMLInputElement>('file');
const emptyEl = $('empty');
const settingsEl = $('settings');
const legendEl = $('legend');

const roll = new PianoRoll($<HTMLCanvasElement>('roll'));
const player = new Player();

/** One audio signal run through the note model. */
interface Source {
  transcriber: StreamingTranscriber;
  tracker: NoteTracker;
}

let model: GraphModel | null = null;
let recorder: Recorder | null = null;
let recordingAudio: AudioBuffer | null = null;
let busy = false; // finishing a recording or transcribing a file
let params = loadParams();
let instrumentsOn = loadFlag('instruments', true);

/** The full mix: analysed live while recording, with rough instrument guesses. */
let mix: Source | null = null;
let mixDrums: DrumDetector | null = null;
/** After separation: each stem transcribed on its own, for accurate instrument labels. */
let stems: { sources: Source[]; drums: DrumHit[] } | null = null;
let separating = false; // for the current session
/** Bumped for every new recording / file so late results from an old one are dropped. */
let session = 0;

const setStatus = (s: string) => (statusEl.textContent = s);

function currentNotes(): Note[] {
  if (!mix) return [];
  if (!instrumentsOn) return mix.tracker.notes;
  if (stems) return mergeStemNotes(stems.sources.map((s) => s.tracker.notes));
  return classifyLive(mix.tracker.notes, mixDrums?.hits ?? []);
}

function currentDrums(): DrumHit[] {
  if (!instrumentsOn) return [];
  return stems ? stems.drums : (mixDrums?.hits ?? []);
}

function refreshNotes() {
  roll.notes = currentNotes();
  roll.drums = currentDrums();
  roll.showDrums = instrumentsOn;
  roll.invalidate();
  const n = roll.notes.length;
  const d = roll.drums.length;
  countEl.textContent = [n ? `${n} note${n === 1 ? '' : 's'}` : '', d ? `${d} drum hit${d === 1 ? '' : 's'}` : '']
    .filter(Boolean)
    .join(' · ');
  emptyEl.hidden = n + d > 0 || recorder !== null || busy;
  renderLegend();
  updateButtons();
}

function updateButtons() {
  const has = roll.notes.length > 0 || roll.drums.length > 0 || recordingAudio !== null;
  recordBtn.disabled = !model || busy;
  playBtn.disabled = recorder !== null || busy || !has;
  exportBtn.disabled = recorder !== null || busy || roll.notes.length + roll.drums.length === 0;
  fileInput.disabled = recorder !== null || busy || !model;
}

/** Pitches still sounding at the newest analysed row (a note's end is its last loud row). */
function soundingAt(notes: Note[], rows: number): Map<number, Instrument> {
  const m = new Map<number, Instrument>();
  for (const n of notes) if (n.end >= rows - 2) m.set(n.pitch, n.instrument);
  return m;
}

function newSession() {
  player.stop();
  session++;
  cancelSeparation();
  separating = false;
  stems = null;
  const transcriber = new StreamingTranscriber(model!, () => {
    const rows = transcriber.store.rows;
    mix!.tracker.update(transcriber.store);
    roll.analyzedTime = frameToSeconds(rows);
    refreshNotes();
    if (recorder) {
      roll.livePitches = soundingAt(roll.notes, rows);
      roll.liveDrums = new Set(roll.drums.filter((h) => h.row >= rows - 10).map((h) => h.kind));
    }
  });
  mix = { transcriber, tracker: new NoteTracker(params) };
  mixDrums = instrumentsOn ? new DrumDetector(true) : null;
  recordingAudio = null;
  roll.playhead = null;
  roll.resetView();
  roll.follow = true;
  refreshNotes();
}

// ---------------------------------------------------------------- recording

async function toggleRecord() {
  if (recorder) return stopRecording();
  if (!model || busy) return;
  newSession();
  try {
    recorder = await startRecording(
      deviceSel.value || undefined,
      (samples) => {
        mix!.transcriber.push(samples);
        mixDrums?.push(samples);
      },
      (rms) => (levelEl.style.width = `${Math.min(100, Math.sqrt(rms) * 220)}%`),
    );
  } catch (err) {
    setStatus(`Could not access the microphone: ${(err as Error).message}`);
    return;
  }
  void populateDevices(); // labels become available once permission is granted
  roll.recordTime = 0;
  roll.analyzedTime = 0;
  recordBtn.classList.add('recording');
  recordBtn.querySelector('.label')!.textContent = 'Stop';
  setStatus(
    instrumentsOn
      ? 'Recording… Instrument colours are a rough guess until you stop.'
      : 'Recording… play something!',
  );
  refreshNotes();
}

async function stopRecording() {
  if (!recorder || !mix) return;
  const rec = recorder;
  recorder = null;
  busy = true;
  recordBtn.classList.remove('recording');
  recordBtn.querySelector('.label')!.textContent = 'Record';
  levelEl.style.width = '0';
  setStatus('Finishing up…');
  updateButtons();

  recordingAudio = await rec.stop();
  await mix.transcriber.finish();
  mixDrums?.finish();
  // Final pass over the whole take so everything is decoded consistently.
  mix.tracker.recompute(mix.transcriber.store);
  roll.recordTime = null;
  roll.livePitches = null;
  roll.liveDrums = null;
  roll.playhead = 0;
  busy = false;
  refreshNotes();
  setStatus(`Recorded ${formatTime(recordingAudio.duration, true)}. Press Space to play it back.`);
  if (instrumentsOn) void separate();
}

// ---------------------------------------------------------------- instrument separation

function describe(s: SeparationStatus): string {
  switch (s.phase) {
    case 'download':
      return `Downloading the instrument model (first time only)… ${Math.round(s.loaded / 1e6)} of ${Math.round(s.total / 1e6)} MB`;
    case 'loading':
      return 'Loading the instrument model…';
    case 'separating':
      return `Separating instruments… ${Math.round(s.progress * 100)}%${s.backend === 'wasm' ? ' (no GPU available, so this is slow)' : ''}`;
    case 'transcribing':
      return 'Transcribing each instrument…';
  }
}

const rms = (x: Float32Array) => {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
};

/** Which stem feeds which instrument. Demucs' "other" stem is where piano ends up. */
const STEM_OF: Record<Instrument, Stem> = { piano: 'other', bass: 'bass', vocals: 'vocals' };

/**
 * Split the take into stems with Demucs, then transcribe each stem separately. Runs in the
 * background; the rough live result stays on screen until this finishes.
 */
async function separate() {
  const audio = recordingAudio;
  if (!audio || !model || separating) return;
  const id = session;
  separating = true;
  try {
    const audioStems = await separateStems(audio, (s) => {
      if (id === session) setStatus(describe(s));
    });
    if (id !== session) return;
    // Separation always leaks a little into every stem; skip stems that are essentially silent.
    const levels = Object.fromEntries(Object.entries(audioStems).map(([k, v]) => [k, rms(v)])) as Record<Stem, number>;
    const total = Object.values(levels).reduce((a, b) => a + b, 0);
    const audible = (stem: Stem) => levels[stem] > 0.04 * total;

    const sources: Source[] = [];
    for (const inst of ['piano', 'bass', 'vocals'] as Instrument[]) {
      if (!audible(STEM_OF[inst])) continue;
      const transcriber = new StreamingTranscriber(model, () => {});
      transcriber.push(audioStems[STEM_OF[inst]]);
      await transcriber.finish();
      const tracker = new NoteTracker(params, inst);
      tracker.recompute(transcriber.store);
      sources.push({ transcriber, tracker });
    }
    let drums: DrumHit[] = [];
    if (audible('drums')) {
      const det = new DrumDetector(false);
      det.push(audioStems.drums);
      det.finish();
      drums = det.hits;
    }
    if (id !== session) return;
    stems = { sources, drums };
    refreshNotes();
    setStatus('Instruments separated. Click a colour in the legend to show or hide it.');
  } catch (err) {
    if (id === session) {
      setStatus(`Couldn't separate instruments (${(err as Error).message}). Showing the rough guess instead.`);
    }
  } finally {
    if (id === session) separating = false;
  }
}

// ---------------------------------------------------------------- legend

function renderLegend() {
  legendEl.hidden = !instrumentsOn;
  if (!instrumentsOn) return;
  const present = new Set<Part>(roll.notes.map((n) => n.instrument));
  if (roll.drums.length) present.add('drums');
  legendEl.replaceChildren(
    ...PARTS.map((p) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.classList.toggle('off', roll.hidden.has(p.id));
      b.classList.toggle('absent', !present.has(p.id));
      b.title = roll.hidden.has(p.id) ? `Show ${p.label}` : `Hide ${p.label}`;
      b.setAttribute('aria-pressed', String(!roll.hidden.has(p.id)));
      b.style.setProperty('--c', `rgb(${partRgb(p.id).join(',')})`);
      b.textContent = p.label;
      b.addEventListener('click', () => {
        if (roll.hidden.has(p.id)) roll.hidden.delete(p.id);
        else roll.hidden.add(p.id);
        refreshNotes();
      });
      return b;
    }),
  );
}

// ---------------------------------------------------------------- files

async function openFile(file: File) {
  if (!model || recorder || busy) return;
  newSession();
  busy = true;
  refreshNotes();
  setStatus(`Decoding ${file.name}…`);
  let ok = false;
  try {
    const { original, mono22k } = await decodeFile(file);
    recordingAudio = original;
    const t = mix!.transcriber;
    const total = Math.ceil(mono22k.length / 256);
    const onProgress = () => setStatus(`Transcribing ${file.name}… ${Math.min(99, Math.round((100 * t.store.rows) / total))}%`);
    const timer = setInterval(onProgress, 200);
    t.push(mono22k);
    mixDrums?.push(mono22k);
    mixDrums?.finish();
    await t.finish();
    clearInterval(timer);
    mix!.tracker.recompute(t.store);
    roll.frameNotes(mix!.tracker.notes);
    setStatus(`Transcribed ${file.name} (${formatTime(original.duration, true)}).`);
    ok = true;
  } catch (err) {
    setStatus(`Could not read ${file.name}: ${(err as Error).message}`);
  } finally {
    busy = false;
    roll.playhead = 0;
    refreshNotes();
  }
  if (ok && instrumentsOn) void separate();
}

// ---------------------------------------------------------------- playback

const audibleNotes = () => roll.notes.filter((n) => !roll.hidden.has(n.instrument));
const audibleDrums = () => (roll.hidden.has('drums') ? [] : roll.drums);

function togglePlay() {
  if (recorder || busy) return;
  if (player.playing) {
    player.stop();
    roll.playhead = player.position;
    playBtn.classList.remove('active');
    return;
  }
  let from = roll.playhead ?? 0;
  const end = roll.notes.reduce((m, n) => Math.max(m, frameToSeconds(n.end)), recordingAudio?.duration ?? 0);
  if (from >= end - 0.05) from = 0;
  player.play(audibleNotes(), audibleDrums(), from, playModeSel.value as PlayMode, recordingAudio);
  playBtn.classList.add('active');
  roll.follow = true;
}

player.onEnded = () => {
  playBtn.classList.remove('active');
  roll.playhead = 0;
  roll.invalidate();
};

roll.onNoteClick = (n) =>
  player.preview(n.pitch, Math.min(1.5, frameToSeconds(n.end - n.start)), n.amplitude, n.instrument);
roll.onKeyPress = (p) => player.preview(p);
roll.onDrumPress = (k: DrumKind) => player.previewDrum(k);
roll.onSeek = (t) => {
  if (recorder) return;
  const wasPlaying = player.playing;
  if (wasPlaying) player.stop();
  roll.playhead = t;
  roll.invalidate();
  if (wasPlaying) {
    player.play(audibleNotes(), audibleDrums(), t, playModeSel.value as PlayMode, recordingAudio);
  }
};

// ---------------------------------------------------------------- animation

function frame() {
  player.tick();
  if (recorder && mix) {
    const t = mix.transcriber.receivedSamples / SAMPLE_RATE;
    roll.recordTime = t;
    clock.textContent = formatTime(t, true);
    if (roll.follow) roll.reveal(t);
    roll.invalidate();
  } else if (player.playing) {
    roll.playhead = player.position;
    clock.textContent = formatTime(player.position, true);
    if (roll.follow) roll.reveal(player.position, 0.3);
    roll.invalidate();
  } else if (roll.playhead !== null) {
    clock.textContent = formatTime(roll.playhead, true);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- settings

const onsetIn = $<HTMLInputElement>('onset');
const frameIn = $<HTMLInputElement>('frame');
const minLenIn = $<HTMLInputElement>('minLen');
const melodiaIn = $<HTMLInputElement>('melodia');
const instrumentsIn = $<HTMLInputElement>('instruments');

function loadFlag(key: string, fallback: boolean) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function loadParams(): NoteParams {
  try {
    return { ...DEFAULT_PARAMS, ...JSON.parse(localStorage.getItem('noteParams') ?? '{}') };
  } catch {
    return { ...DEFAULT_PARAMS };
  }
}

// Sliders show "sensitivity" (higher = more notes), i.e. the inverse of the threshold.
function showParams(p: NoteParams) {
  onsetIn.value = String(1 - p.onsetThreshold);
  frameIn.value = String(0.8 - p.frameThreshold);
  minLenIn.value = String(p.minNoteMs);
  melodiaIn.checked = p.melodiaTrick;
  $('onsetOut').textContent = `${Math.round((1 - p.onsetThreshold) * 100)}%`;
  $('frameOut').textContent = `${Math.round((0.8 - p.frameThreshold) * 100)}%`;
  $('minLenOut').textContent = `${p.minNoteMs} ms`;
}

let recomputeTimer = 0;
function applyParams(p: NoteParams) {
  params = p;
  const sources = [mix, ...(stems?.sources ?? [])].filter((x): x is Source => x !== null);
  for (const src of sources) src.tracker.params = p;
  showParams(p);
  try {
    localStorage.setItem('noteParams', JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
  // Re-decode the existing take with the new settings (the raw model output is kept).
  if (mix && !recorder && !busy) {
    clearTimeout(recomputeTimer);
    recomputeTimer = window.setTimeout(() => {
      for (const src of sources) src.tracker.recompute(src.transcriber.store);
      refreshNotes();
    }, 60);
  }
}

function readParams(): NoteParams {
  return {
    onsetThreshold: +(1 - +onsetIn.value).toFixed(2),
    frameThreshold: +(0.8 - +frameIn.value).toFixed(2),
    minNoteMs: +minLenIn.value,
    melodiaTrick: melodiaIn.checked,
  };
}

showParams(params);
instrumentsIn.checked = instrumentsOn;
instrumentsIn.addEventListener('change', () => {
  instrumentsOn = instrumentsIn.checked;
  try {
    localStorage.setItem('instruments', instrumentsOn ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
  refreshNotes();
  // Turned on after a take was made without it: separate that take now.
  if (instrumentsOn && !stems && !recorder && !busy) void separate();
});
for (const el of [onsetIn, frameIn, minLenIn, melodiaIn]) el.addEventListener('input', () => applyParams(readParams()));
$('resetSettings').addEventListener('click', () => applyParams({ ...DEFAULT_PARAMS }));
$('settingsBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  settingsEl.hidden = !settingsEl.hidden;
  $('settingsBtn').classList.toggle('active', !settingsEl.hidden);
});
document.addEventListener('pointerdown', (e) => {
  if (!settingsEl.hidden && !settingsEl.contains(e.target as Node) && !$('settingsBtn').contains(e.target as Node)) {
    settingsEl.hidden = true;
    $('settingsBtn').classList.remove('active');
  }
});

// ---------------------------------------------------------------- orientation

const orientationBtn = $<HTMLButtonElement>('orientation');

function setVertical(vertical: boolean) {
  roll.setVertical(vertical);
  orientationBtn.classList.toggle('active', vertical);
  orientationBtn.setAttribute('aria-pressed', String(vertical));
  document.querySelector('.stage')!.classList.toggle('vertical', vertical);
  try {
    localStorage.setItem('vertical', vertical ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

orientationBtn.addEventListener('click', () => setVertical(!roll.isVertical));
try {
  if (localStorage.getItem('vertical') === '1') setVertical(true);
} catch {
  /* storage unavailable */
}

// ---------------------------------------------------------------- devices

async function populateDevices() {
  try {
    const inputs = await listInputs();
    const current = deviceSel.value;
    deviceSel.replaceChildren(new Option('Default microphone', ''));
    inputs.forEach((d, i) => {
      if (d.deviceId === 'default' || !d.deviceId) return;
      deviceSel.add(new Option(d.label || `Input ${i + 1}`, d.deviceId));
    });
    deviceSel.value = [...deviceSel.options].some((o) => o.value === current) ? current : '';
  } catch {
    /* enumerateDevices unsupported */
  }
}
navigator.mediaDevices?.addEventListener?.('devicechange', populateDevices);
void populateDevices();

// ---------------------------------------------------------------- wiring

recordBtn.addEventListener('click', () => void toggleRecord());
playBtn.addEventListener('click', togglePlay);
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  fileInput.value = '';
  if (f) void openFile(f);
});
exportBtn.addEventListener('click', () => {
  const blob = new Blob([notesToMidi(roll.notes, roll.drums) as BlobPart], { type: 'audio/midi' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `transcription-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.mid`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ---------------------------------------------------------------- about
const aboutEl = $<HTMLDialogElement>('about');
$('aboutBtn').addEventListener('click', () => aboutEl.showModal());
$('aboutClose').addEventListener('click', () => aboutEl.close());
// A click on the backdrop lands on the dialog element, outside its box.
aboutEl.addEventListener('click', (e) => {
  const r = aboutEl.getBoundingClientRect();
  const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  if (e.target === aboutEl && !inside) aboutEl.close();
});

window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || e.metaKey || e.ctrlKey || aboutEl.open) return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.key === 'r' || e.key === 'R') {
    void toggleRecord();
  } else if (e.key === 'v' || e.key === 'V') {
    setVertical(!roll.isVertical);
  }
});

// Drag & drop an audio file onto the page.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files[0];
  if (f) void openFile(f);
});

if (!navigator.mediaDevices?.getUserMedia) {
  setStatus('Microphone access needs a secure context (https or localhost).');
}

loadModel()
  .then((m) => {
    model = m;
    setStatus('Ready. Press Record (R) or open an audio file.');
    updateButtons();
  })
  .catch((err) => setStatus(`Failed to load the note-detection model: ${err.message}`));
