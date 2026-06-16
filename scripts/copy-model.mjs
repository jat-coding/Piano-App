// Copies the Basic Pitch model into public/ so Vite serves it at /basic-pitch-model.
import { cpSync, mkdirSync } from 'node:fs';

const src = 'node_modules/@spotify/basic-pitch/model';
const dest = 'public/basic-pitch-model';
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`Copied model → ${dest}`);
