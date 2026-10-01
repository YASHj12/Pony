/* Synthetic images for tests: no fixtures to download, everything generated.
 * Each one imitates a signature the classifier is supposed to recognise.
 */
import zlib from 'node:zlib';
import { crc32 } from '../public/js/zip.js';

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

export function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [clamp((r + m) * 255), clamp((g + m) * 255), clamp((b + m) * 255)];
}

function make(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * w + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

export const W = 240, H = 240;

/** A vertical rainbow colourbar down the left edge on a light canvas. */
export const legendImage = make(W, H, (x, y) => {
  if (x < 18) return hsvToRgb(240 - (y / H) * 240, 0.95, 0.95);
  return [242, 243, 245];
});

/** A full-view contour plot: object in the middle, generous background, rainbow. */
export const contourFull = make(W, H, (x, y) => {
  const inside = Math.abs(x - W * 0.55) < W * 0.22 && Math.abs(y - H * 0.5) < H * 0.22;
  if (x < 16) return hsvToRgb(240 - (y / H) * 240, 0.95, 0.95);      // legend
  if (!inside) return [246, 247, 249];                                // canvas
  const r = Math.hypot(x - W * 0.55, y - H * 0.5) / (W * 0.22);
  return hsvToRgb(250 - r * 250, 0.9, 0.95);
});

/** The same result, zoomed in: colour fills the whole frame, no background. */
export const contourZoomed = make(W, H, (x, y) => {
  const r = Math.hypot(x - W * 0.5, y - H * 0.5) / (W * 0.8);
  return hsvToRgb(250 - r * 250, 0.9, 0.95);
});

/** Mesh: dense thin dark lines over a light object, no colour. */
export const meshImage = make(W, H, (x, y) => {
  const inside = Math.abs(x - W * 0.5) < W * 0.3 && Math.abs(y - H * 0.5) < H * 0.3;
  if (!inside) return [255, 255, 255];
  if ((x + y) % 7 === 0 || (x - y + H) % 7 === 0) return [35, 35, 40];
  return [176, 178, 184];
});

/** Smooth achromatic shaded solid — a CAD/geometry screenshot. */
export const geometryImage = make(W, H, (x, y) => {
  const d = Math.hypot(x - W * 0.5, y - H * 0.5) / (W * 0.5);
  const v = d < 0.55 ? 200 - d * 120 : 250;
  return [v, v, v + 4];
});

/** A graph: mostly white with a thin coloured line and axes. */
export const graphImage = make(W, H, (x, y) => {
  const line = Math.abs(y - (H * 0.7 - Math.sin(x / 28) * H * 0.18)) < 1.2;
  if (line) return [200, 40, 40];
  if (Math.abs(x - 30) < 1 || Math.abs(y - (H - 30)) < 1) return [60, 60, 60];
  return [255, 255, 255];
});

/* ───────────────────────── PNG encoder (for PPTX tests) ───────────────────────── */

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

export function pngBytes(width, height, rgb = [180, 60, 60]) {
  const raw = Buffer.alloc(height * (width * 3 + 1));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;                                   // filter: none
    for (let x = 0; x < width; x++) {
      const shade = Math.round((x / width) * 60);
      raw[p++] = clamp(rgb[0] + shade);
      raw[p++] = clamp(rgb[1] + shade);
      raw[p++] = clamp(rgb[2] + shade);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}
