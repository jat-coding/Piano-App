// Generates branded PWA icons (no image deps) by drawing pixels and encoding PNG.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

// --- tiny PNG encoder (8-bit RGBA) ---
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // rest 0
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- draw the icon ---
function hex(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function draw(size, pad) {
  const buf = Buffer.alloc(size * size * 4);
  const px = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
  };
  const rect = (x0, y0, w, h, color) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px(x, y, color);
  };

  const bg = hex('#14110d'); // warm ebony
  const orange = hex('#d39a52'); // honey amber (right)
  const blue = hex('#5f8a96'); // dusty teal-blue (left)
  const white = hex('#efe5cf'); // ivory keys
  const black = hex('#1a1510'); // ebony keys

  rect(0, 0, size, size, bg);

  const inner = size - pad * 2;
  const noteW = Math.round(inner * 0.13);
  const kbY = pad + Math.round(inner * 0.72);

  // Falling notes (orange right, blue left).
  rect(pad + Math.round(inner * 0.18), pad + Math.round(inner * 0.1), noteW, Math.round(inner * 0.4), blue);
  rect(pad + Math.round(inner * 0.42), pad + Math.round(inner * 0.22), noteW, Math.round(inner * 0.36), orange);
  rect(pad + Math.round(inner * 0.66), pad + Math.round(inner * 0.06), noteW, Math.round(inner * 0.5), orange);

  // Keyboard strip.
  rect(pad, kbY, inner, Math.round(inner * 0.2), white);
  const keyW = Math.round(inner / 7);
  for (let k = 1; k < 7; k++) {
    if (k === 3 || k === 7) continue; // skip B/E-ish gaps loosely
    rect(pad + k * keyW - Math.round(keyW * 0.3), kbY, Math.round(keyW * 0.6), Math.round(inner * 0.12), black);
  }
  return buf;
}

mkdirSync('public', { recursive: true });
for (const { size, pad, name } of [
  { size: 192, pad: 16, name: 'icon-192.png' },
  { size: 512, pad: 40, name: 'icon-512.png' },
  { size: 512, pad: 96, name: 'icon-maskable-512.png' },
]) {
  writeFileSync(`public/${name}`, encodePng(size, size, draw(size, pad)));
  console.log('wrote public/' + name);
}
