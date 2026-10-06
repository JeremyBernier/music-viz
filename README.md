# Piano Roll Transcriber

Listens to piano through your microphone and draws the notes (chords included) in an
FL Studio–style piano roll as you play.

```sh
npm install
npm run dev      # http://localhost:5173
```

## Features

- **Record** (or press `R`): notes appear about half a second after you play them.
  When you stop, the whole take is decoded one more time so the final result is consistent.
  While recording, the keyboard presses down the notes that are currently sounding.
- **Vertical** (or press `V`): rotates the roll so the keyboard sits along the top and time
  flows downward. Click again to go back to horizontal. The choice is remembered.
- **Instrument colours**: notes are coloured by instrument (piano / other, bass, vocals), and drum
  hits go in a kick / snare / hi-hat lane above the keys. Click an instrument in the legend
  (bottom bar) to hide and mute it. While recording the colours are a rough guess: low notes are
  called bass, and drums come from a simple hit detector. After you stop, the audio is split into
  instruments with [Demucs](https://github.com/facebookresearch/demucs) and each part is
  transcribed separately. That model is ~172 MB, downloaded once from Hugging Face and cached by
  the browser. It runs on the GPU via WebGPU, taking about a third of the recording's length.
  Turn it off in **Detection → Identify instruments**.
- **Play** (or press `Space`): plays back the detected notes and drums, the original recording, or both.
- **Detection** panel: note sensitivity, sustain sensitivity, minimum note length. Changes
  re-apply instantly to the current take.
- **Open file** (or drag and drop): transcribes an existing audio file.
- **MIDI**: exports a `.mid` file with one track per instrument (drums on the General MIDI drum channel).
- **Input** picker: choose a microphone. To transcribe audio playing *on* the computer,
  pick a loopback device such as [BlackHole](https://github.com/ExistentialAudio/BlackHole).

Piano roll controls: scroll to move around, `⌘/Ctrl`+scroll to zoom time, `Alt`+scroll to
zoom keys, drag to pan, click a note or key to hear it, click the ruler to move the playhead.

## How it works

| File | Role |
| --- | --- |
| `src/audio.ts` | Microphone capture (AudioWorklet), with echo cancellation, noise suppression and auto-gain turned off. Low-pass filters and resamples to 22.05 kHz. |
| `src/transcriber.ts` | Runs Spotify's [Basic Pitch](https://github.com/spotify/basic-pitch) model (TensorFlow.js, WebGL) on 2 s windows. While recording, each run uses the newest full window and keeps only rows it hasn't computed yet. This is what brings latency down to ~0.5 s. |
| `src/notes.ts` | Turns the model's per-frame note/onset probabilities into notes (a typed-array port of Basic Pitch's decoder). Notes that have clearly ended are committed, and only the recent tail is re-decoded on each update. |
| `src/drums.ts` | Drum hit detector (kick / snare / hi-hat) based on per-band spectral flux. Kicks are confirmed by how fast their low end dies away, which separates them from bass notes. |
| `src/separation.ts`, `src/separation.worker.ts` | Demucs source separation (drums / bass / other / vocals) via [demucs-web](https://github.com/timcsy/demucs-web) + onnxruntime-web, in a Web Worker. |
| `src/parts.ts` | Live instrument guesses, and merging per-stem results (removing notes that leaked into two stems). |
| `src/pianoRoll.ts` | Canvas piano roll, keyboard and drum lane. |
| `src/player.ts`, `src/midi.ts` | Playback synth and MIDI export. |

`onnxruntime-web` is pinned to 1.22.0: the WebGPU build of 1.30.0 fails to run this model.

The model weights in `public/model/` come from `@spotify/basic-pitch` (Apache-2.0, see
`public/model/LICENSE-basic-pitch`).

## Deploying

Live at [jbernier.com/music-viz](https://jbernier.com/music-viz/). `npm run deploy` builds into
`dist/music-viz/` and uploads it to the `music-viz` Cloudflare Pages project.
