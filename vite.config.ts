import { defineConfig } from 'vite';

// The site is served at jbernier.com/music-viz/ (a Worker on that domain forwards the path to
// this project's Cloudflare Pages deployment). So every asset URL carries the /music-viz/
// prefix, and the build goes into a folder of that name, which makes the same paths work on the
// Pages host too. pages/_redirects sends the Pages root there.
const BASE = '/music-viz/';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? BASE : '/',
  build: { outDir: 'dist' + BASE, emptyOutDir: true },
  optimizeDeps: {
    // Pre-bundle the lazily loaded separation library so the dev server doesn't discover it
    // mid-session and reload the page. onnxruntime-web must NOT be pre-bundled: it locates
    // its own WebAssembly/worker files relative to itself, which re-bundling breaks.
    include: ['demucs-web'],
    exclude: ['onnxruntime-web'],
  },
  worker: { format: 'es' },
}));
