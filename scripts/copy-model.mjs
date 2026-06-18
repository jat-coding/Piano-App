// Copies the Basic Pitch model into public/ so Vite serves it at /basic-pitch-model.
// The model is also committed to public/, so this is a convenience refresh — a
// failure here (e.g. unexpected package layout in CI) must NOT break the build.
import { cpSync, mkdirSync, existsSync } from 'node:fs';

const src = 'node_modules/@spotify/basic-pitch/model';
const dest = 'public/basic-pitch-model';

try {
  if (!existsSync(src)) {
    console.warn(`[copy-model] source missing (${src}); using committed copy in ${dest}.`);
  } else {
    mkdirSync(dest, { recursive: true });
    cpSync(src, dest, { recursive: true });
    console.log(`Copied model → ${dest}`);
  }
} catch (err) {
  console.warn(`[copy-model] skipped (${err?.message ?? err}); using committed copy.`);
}
