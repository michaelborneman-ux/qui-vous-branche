// Rasterises the app icon to PNG without any image dependency.
// Usage: node tools/make-icons.js
// Draws the same mark as icons/icon.svg: a hexagon ring with an off-centre dot,
// which is the app's whole idea - a point somewhere inside a coverage cell.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'icons');

const BG = [0x0b, 0x25, 0x45];
const RING = [0xed, 0xf1, 0xf5];
const DOT = [0x35, 0xbd, 0xcb];

// Geometry in a 512-unit design space, matching icon.svg.
const HEX = [[160, 96], [352, 96], [448, 256], [352, 416], [160, 416], [64, 256]];
const STROKE = 13;            // half of the svg stroke-width
const DOT_C = [288, 296];
const DOT_R = 30;
const CORNER = 96;

function distToSegment(px, py, [x1, y1], [x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let tt = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  tt = Math.max(0, Math.min(1, tt));
  return Math.hypot(px - (x1 + tt * dx), py - (y1 + tt * dy));
}

function distToHexOutline(px, py) {
  let best = Infinity;
  for (let i = 0; i < HEX.length; i++) {
    best = Math.min(best, distToSegment(px, py, HEX[i], HEX[(i + 1) % HEX.length]));
  }
  return best;
}

function insideRounded(px, py, r) {
  if (r <= 0) return true;
  const cx = Math.min(Math.max(px, r), 512 - r);
  const cy = Math.min(Math.max(py, r), 512 - r);
  return Math.hypot(px - cx, py - cy) <= r;
}

// inset: shrink the mark for the maskable safe zone. corner: 0 for maskable (full bleed).
function render(size, { inset = 0, corner = CORNER } = {}) {
  const SS = 2;                                   // 2x2 supersampling
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0;                                    // PNG filter: none
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = ((x + (sx + 0.5) / SS) / size) * 512;
          const py = ((y + (sy + 0.5) / SS) / size) * 512;
          let col = null, alpha = 0;

          if (insideRounded(px, py, corner * (size / 512) * (512 / size))) {
            col = BG; alpha = 255;
            // map the mark into the inset box
            const mx = (px - 256) / (1 - inset) + 256;
            const my = (py - 256) / (1 - inset) + 256;
            if (Math.hypot(mx - DOT_C[0], my - DOT_C[1]) <= DOT_R) col = DOT;
            else if (distToHexOutline(mx, my) <= STROKE) col = RING;
          }
          if (col) { r += col[0]; g += col[1]; b += col[2]; a += alpha; }
        }
      }
      const n = SS * SS;
      const o = 1 + x * 4;
      row[o] = Math.round(r / n);
      row[o + 1] = Math.round(g / n);
      row[o + 2] = Math.round(b / n);
      row[o + 3] = Math.round(a / n);
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function png(size, opts) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(render(size, opts), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
const files = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-180.png', 180, {}],
  ['icon-maskable.png', 512, { inset: 0.2, corner: 0 }],
];
for (const [name, size, opts] of files) {
  const buf = png(size, opts);
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log(name, size + 'px', (buf.length / 1024).toFixed(1) + ' KB');
}
