// Copies runtime assets into public/ so Vite serves them:
//  - the Basic Pitch model  → /basic-pitch-model
//  - the tfjs WASM backends  → /tfjs-wasm  (SIMD backend = fast transcription)
// These are also committed to public/, so a failure here (e.g. odd CI layout)
// must NOT break the build — the committed copies are the fallback.
import { cpSync, mkdirSync, existsSync, readdirSync, copyFileSync } from 'node:fs';

function copyDir(src, dest, label) {
  try {
    if (!existsSync(src)) {
      console.warn(`[copy-assets] ${label} source missing (${src}); using committed copy.`);
      return;
    }
    mkdirSync(dest, { recursive: true });
    cpSync(src, dest, { recursive: true });
    console.log(`[copy-assets] ${label} → ${dest}`);
  } catch (err) {
    console.warn(`[copy-assets] ${label} skipped (${err?.message ?? err}); using committed copy.`);
  }
}

copyDir('node_modules/@spotify/basic-pitch/model', 'public/basic-pitch-model', 'model');

// Only the .wasm binaries are needed at runtime (setWasmPaths points here).
try {
  const wasmSrc = 'node_modules/@tensorflow/tfjs-backend-wasm/dist';
  const wasmDest = 'public/tfjs-wasm';
  if (existsSync(wasmSrc)) {
    mkdirSync(wasmDest, { recursive: true });
    for (const f of readdirSync(wasmSrc)) {
      if (f.endsWith('.wasm')) copyFileSync(`${wasmSrc}/${f}`, `${wasmDest}/${f}`);
    }
    console.log(`[copy-assets] tfjs wasm → ${wasmDest}`);
  } else {
    console.warn('[copy-assets] tfjs wasm source missing; using committed copy.');
  }
} catch (err) {
  console.warn(`[copy-assets] tfjs wasm skipped (${err?.message ?? err}); using committed copy.`);
}
