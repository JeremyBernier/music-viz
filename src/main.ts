import type { GraphModel } from '@tensorflow/tfjs';
import { decodeFile, listInputs, startRecording, type Recorder } from './audio';
import { frameToSeconds, SAMPLE_RATE } from './constants';
import { notesToMidi } from './midi';
import { DEFAULT_PARAMS, NoteTracker, type Note, type NoteParams } from './notes';
import { formatTime, PianoRoll } from './pianoRoll';
import { Player, type PlayMode } from './player';
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

const roll = new PianoRoll($<HTMLCanvasElement>('roll'));
const player = new Player();

let model: GraphModel | null = null;
let transcriber: StreamingTranscriber | null = null;
let recorder: Recorder | null = null;
let recordingAudio: AudioBuffer | null = null;
let busy = false; // finishing a recording or transcribing a file
const tracker = new NoteTracker(loadParams());

const setStatus = (s: string) => (statusEl.textContent = s);

function refreshNotes() {
  roll.notes = tracker.notes;
  roll.invalidate();
  const n = roll.notes.length;
  countEl.textContent = n ? `${n} note${n === 1 ? '' : 's'}` : '';
  emptyEl.hidden = n > 0 || recorder !== null || busy;
  updateButtons();
}

function updateButtons() {
  const has = roll.notes.length > 0 || recordingAudio !== null;
  recordBtn.disabled = !model || busy;
  playBtn.disabled = recorder !== null || busy || !has;
  exportBtn.disabled = recorder !== null || busy || roll.notes.length === 0;
  fileInput.disabled = recorder !== null || busy || !model;
}

/** Pitches still sounding at the newest analysed row (a note's end is its last loud row). */
function soundingAt(notes: Note[], rows: number): Set<number> {
  const s = new Set<number>();
  for (const n of notes) if (n.end >= rows - 2) s.add(n.pitch);
  return s;
}

function newSession() {
  player.stop();
  transcriber = new StreamingTranscriber(model!, () => {
    const rows = transcriber!.store.rows;
    tracker.update(transcriber!.store);
    roll.analyzedTime = frameToSeconds(rows);
    if (recorder) roll.livePitches = soundingAt(tracker.notes, rows);
    refreshNotes();
  });
  tracker.reset();
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
      (samples) => transcriber!.push(samples),
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
  setStatus('Recording… play something!');
  refreshNotes();
}

async function stopRecording() {
  if (!recorder || !transcriber) return;
  const rec = recorder;
  recorder = null;
  busy = true;
  recordBtn.classList.remove('recording');
  recordBtn.querySelector('.label')!.textContent = 'Record';
  levelEl.style.width = '0';
  setStatus('Finishing up…');
  updateButtons();

  recordingAudio = await rec.stop();
  await transcriber.finish();
  // Final pass over the whole take so everything is decoded consistently.
  tracker.recompute(transcriber.store);
  roll.recordTime = null;
  roll.livePitches = null;
  roll.playhead = 0;
  busy = false;
  refreshNotes();
  setStatus(`Recorded ${formatTime(recordingAudio.duration, true)}. Press Space to play it back.`);
}

// ---------------------------------------------------------------- files

async function openFile(file: File) {
  if (!model || recorder || busy) return;
  newSession();
  busy = true;
  refreshNotes();
  setStatus(`Decoding ${file.name}…`);
  try {
    const { original, mono22k } = await decodeFile(file);
    recordingAudio = original;
    const t = transcriber!;
    const total = Math.ceil(mono22k.length / 256);
    const onProgress = () => setStatus(`Transcribing ${file.name}… ${Math.min(99, Math.round((100 * t.store.rows) / total))}%`);
    const timer = setInterval(onProgress, 200);
    t.push(mono22k);
    await t.finish();
    clearInterval(timer);
    tracker.recompute(t.store);
    roll.frameNotes(tracker.notes);
    setStatus(`Transcribed ${file.name} (${formatTime(original.duration, true)}).`);
  } catch (err) {
    setStatus(`Could not read ${file.name}: ${(err as Error).message}`);
  } finally {
    busy = false;
    roll.playhead = 0;
    refreshNotes();
  }
}

// ---------------------------------------------------------------- playback

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
  player.play(roll.notes, from, playModeSel.value as PlayMode, recordingAudio);
  playBtn.classList.add('active');
  roll.follow = true;
}

player.onEnded = () => {
  playBtn.classList.remove('active');
  roll.playhead = 0;
  roll.invalidate();
};

roll.onNoteClick = (n) => player.preview(n.pitch, Math.min(1.5, frameToSeconds(n.end - n.start)), n.amplitude);
roll.onKeyPress = (p) => player.preview(p);
roll.onSeek = (t) => {
  if (recorder) return;
  const wasPlaying = player.playing;
  if (wasPlaying) player.stop();
  roll.playhead = t;
  roll.invalidate();
  if (wasPlaying) {
    player.play(roll.notes, t, playModeSel.value as PlayMode, recordingAudio);
  }
};

// ---------------------------------------------------------------- animation

function frame() {
  player.tick();
  if (recorder && transcriber) {
    const t = transcriber.receivedSamples / SAMPLE_RATE;
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
  tracker.params = p;
  showParams(p);
  try {
    localStorage.setItem('noteParams', JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
  // Re-decode the existing take with the new settings (the raw model output is kept).
  if (transcriber && !recorder && !busy) {
    clearTimeout(recomputeTimer);
    recomputeTimer = window.setTimeout(() => {
      tracker.recompute(transcriber!.store);
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

showParams(tracker.params);
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
  const blob = new Blob([notesToMidi(roll.notes) as BlobPart], { type: 'audio/midi' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `transcription-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.mid`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || e.metaKey || e.ctrlKey) return;
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
