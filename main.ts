// SPDX-License-Identifier: MIT
// STARWHALE — a galaxy-sized luminous whale arcing across deep space,
// blowing a spiral of golden stars, a tiny astronaut waving on its back.
// Drawn fully procedurally, deterministically, standard library only.
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";

const W = 1024;
const H = 1024;
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR || "out";
const OUT_PATH = OUT_DIR + "/entry.png";

// ---- deterministic PRNG (mulberry32, fixed seed) ----
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261116);

// ---- float RGB buffer ----
const buf = new Float32Array(W * H * 3);

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Source-over blend of one pixel.
function paint(x: number, y: number, r: number, g: number, b: number, a: number): void {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
  const i = (yi * W + xi) * 3;
  const inv = 1 - a;
  buf[i] = buf[i] * inv + r * a;
  buf[i + 1] = buf[i + 1] * inv + g * a;
  buf[i + 2] = buf[i + 2] * inv + b * a;
}

// Additive glow (clamped later at quantisation).
function glow(x: number, y: number, r: number, g: number, b: number, a: number): void {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
  const i = (yi * W + xi) * 3;
  buf[i] += r * a;
  buf[i + 1] += g * a;
  buf[i + 2] += b * a;
}

// ---- sky: vertical multi-stop gradient ----
function drawSky(): void {
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, hexRgb("#050514")],
    [0.35, hexRgb("#0d0b2e")],
    [0.65, hexRgb("#1a0f3c")],
    [1.0, hexRgb("#04263b")],
  ];
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    let s = 0;
    while (s < stops.length - 2 && t > stops[s + 1][0]) s++;
    const [t0, c0] = stops[s];
    const [t1, c1] = stops[s + 1];
    const f = clamp((t - t0) / (t1 - t0), 0, 1);
    const r = lerp(c0[0], c1[0], f);
    const g = lerp(c0[1], c1[1], f);
    const b = lerp(c0[2], c1[2], f);
    let i = y * W * 3;
    for (let x = 0; x < W; x++) {
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      i += 3;
    }
  }
}

// ---- PNG encoder (signature, IHDR, IDAT, IEND, table CRC32) ----
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcData = new Uint8Array(4 + data.length);
  crcData.set(out.subarray(4, 8), 0);
  crcData.set(data, 4);
  view.setUint32(8 + data.length, crc32(crcData));
  return out;
}

function encodePng(): Uint8Array {
  const raw = new Uint8Array(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0; // filter byte: none
    let o = y * (1 + W * 3) + 1;
    let i = y * W * 3;
    for (let x = 0; x < W; x++) {
      raw[o++] = clamp(Math.round(buf[i]), 0, 255);
      raw[o++] = clamp(Math.round(buf[i + 1]), 0, 255);
      raw[o++] = clamp(Math.round(buf[i + 2]), 0, 255);
      i += 3;
    }
  }
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, W);
  iv.setUint32(4, H);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const idat = deflateSync(raw, { level: 9 });
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  let total = 0;
  for (const p of parts) total += p.length;
  const png = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    png.set(p, off);
    off += p.length;
  }
  return png;
}

// ---- geometry helpers ----
type Pt = [number, number];

// Closed Catmull-Rom spline through control points, ~16 samples per segment.
function closedSpline(pts: Pt[], perSeg: number): Pt[] {
  const out: Pt[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    for (let s = 0; s < perSeg; s++) {
      const t = s / perSeg;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1[0] +
          (-p0[0] + p2[0]) * t +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y =
        0.5 *
        (2 * p1[1] +
          (-p0[1] + p2[1]) * t +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      out.push([x, y]);
    }
  }
  return out;
}

// Open Catmull-Rom through points (endpoints duplicated), for curves.
function openSpline(pts: Pt[], perSeg: number): Pt[] {
  const ext: Pt[] = [pts[0], ...pts, pts[pts.length - 1]];
  const out: Pt[] = [];
  for (let i = 0; i < ext.length - 3; i++) {
    const p0 = ext[i];
    const p1 = ext[i + 1];
    const p2 = ext[i + 2];
    const p3 = ext[i + 3];
    for (let s = 0; s < perSeg; s++) {
      const t = s / perSeg;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1[0] +
          (-p0[0] + p2[0]) * t +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y =
        0.5 *
        (2 * p1[1] +
          (-p0[1] + p2[1]) * t +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      out.push([x, y]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// Ray-casting point-in-polygon test.
function insidePoly(x: number, y: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Scanline fill of a polygon. colourFn(x, y) returns [r, g, b, a].
function fillPoly(poly: Pt[], colourFn: (x: number, y: number) => [number, number, number, number]): void {
  let minY = H;
  let maxY = 0;
  for (const p of poly) {
    minY = Math.min(minY, Math.floor(p[1]));
    maxY = Math.max(maxY, Math.ceil(p[1]));
  }
  minY = clamp(minY, 0, H - 1);
  maxY = clamp(maxY, 0, H - 1);
  const xs: number[] = [];
  for (let y = minY; y <= maxY; y++) {
    xs.length = 0;
    const yc = y + 0.5;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > yc !== yj > yc) {
        xs.push(((xj - xi) * (yc - yi)) / (yj - yi) + xi);
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = clamp(Math.ceil(xs[k]), 0, W - 1);
      const x1 = clamp(Math.floor(xs[k + 1]), 0, W - 1);
      for (let x = x0; x <= x1; x++) {
        const [r, g, b, a] = colourFn(x, y);
        paint(x, y, r, g, b, a);
      }
    }
  }
}

// Filled disk (source-over).
function fillDisk(cx: number, cy: number, r: number, colour: [number, number, number], a: number): void {
  const [cr, cg, cb] = colour;
  const r2 = r * r;
  const x0 = clamp(Math.floor(cx - r), 0, W - 1);
  const x1 = clamp(Math.ceil(cx + r), 0, W - 1);
  const y0 = clamp(Math.floor(cy - r), 0, H - 1);
  const y1 = clamp(Math.ceil(cy + r), 0, H - 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) paint(x, y, cr, cg, cb, a);
    }
  }
}

// Soft radial glow disk (additive, smooth falloff to the edge).
function glowDisk(cx: number, cy: number, r: number, colour: [number, number, number], a: number): void {
  const [cr, cg, cb] = colour;
  const r2 = r * r;
  const x0 = clamp(Math.floor(cx - r), 0, W - 1);
  const x1 = clamp(Math.ceil(cx + r), 0, W - 1);
  const y0 = clamp(Math.floor(cy - r), 0, H - 1);
  const y1 = clamp(Math.ceil(cy + r), 0, H - 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r2) {
        const fall = 1 - smoothstep(0.2, 1.0, Math.sqrt(d2) / r);
        glow(x, y, cr, cg, cb, a * fall);
      }
    }
  }
}

// Thick line as a chain of disks along sampled points.
function thickLine(pts: Pt[], width: number, colour: [number, number, number], a: number): void {
  const step = Math.max(1, Math.floor(width / 3));
  for (let i = 0; i < pts.length; i += step) {
    fillDisk(pts[i][0], pts[i][1], width / 2, colour, a);
  }
  const last = pts[pts.length - 1];
  fillDisk(last[0], last[1], width / 2, colour, a);
}

// Small 4-point sparkle (plus-shaped cross) at a point.
function sparkle(cx: number, cy: number, len: number, colour: [number, number, number], a: number): void {
  const [r, g, b] = colour;
  for (let d = -len; d <= len; d++) {
    const f = 1 - Math.abs(d) / (len + 1);
    paint(cx + d, cy, r, g, b, a * f);
    paint(cx, cy + d, r, g, b, a * f);
  }
}

// Soft radial nebula blob, added (low alpha).
function nebula(cx: number, cy: number, radius: number, colour: [number, number, number], a: number): void {
  glowDisk(cx, cy, radius, colour, a);
}

// ---- whale body (hero) ----
const BODY_PTS: Pt[] = [
  [150, 470], [230, 400], [360, 350], [520, 330], [680, 345], [800, 380],
  [880, 420], [960, 300], [905, 440], [955, 540], [880, 470], [760, 520],
  [600, 545], [430, 540], [290, 510], [190, 490],
];
const BODY_POLY: Pt[] = closedSpline(BODY_PTS, 16);

function drawStars(): void {
  const palette: Array<[number, number, number]> = [
    [255, 255, 255],
    [200, 220, 255],
    [255, 220, 150],
  ];
  type Star = { x: number; y: number; r: number; c: [number, number, number]; a: number; bright: number };
  const stars: Star[] = [];
  for (let i = 0; i < 520; i++) {
    const x = rand() * W;
    const y = rand() * H;
    if (insidePoly(x, y, BODY_POLY)) continue;
    const bright = rand();
    const r = 0.5 + rand() * 1.5;
    const a = 0.4 + rand() * 0.6;
    const c = palette[Math.floor(rand() * palette.length)];
    stars.push({ x, y, r, c, a, bright });
  }
  for (const s of stars) {
    fillDisk(s.x, s.y, s.r, s.c, s.a);
    if (s.r >= 1.6) glowDisk(s.x, s.y, s.r * 2.2, s.c, 0.25);
  }
  // Brightest ~20 get a small 4-point sparkle.
  const sorted = [...stars].sort((a, b) => b.bright - a.bright).slice(0, 20);
  for (const s of sorted) {
    sparkle(s.x, s.y, 4 + Math.floor(rand() * 3), s.c, 0.9);
  }
}

function drawPlanets(): void {
  // Ringed planet, centre (830, 150), radius 55.
  const cx = 830;
  const cy = 150;
  const r = 55;
  const tilt = (-20 * Math.PI) / 180;
  const cosT = Math.cos(tilt);
  const sinT = Math.sin(tilt);
  const ringCol = hexRgb("#ffe9a8");
  // Back half of the tilted ring (far side), drawn before the disc.
  const backPts: Pt[] = [];
  const frontPts: Pt[] = [];
  for (let i = 0; i <= 120; i++) {
    const th = (i / 120) * Math.PI * 2;
    const lx = 95 * Math.cos(th);
    const ly = 22 * Math.sin(th);
    const px = cx + lx * cosT - ly * sinT;
    const py = cy + lx * sinT + ly * cosT;
    if (Math.sin(th) < 0) backPts.push([px, py]);
    else frontPts.push([px, py]);
  }
  thickLine(backPts, 3, ringCol, 0.8);
  // Disc: horizontal bands of peach / violet / pale.
  const bands: Array<[number, number, number]> = [hexRgb("#ffb37a"), hexRgb("#7a5cff"), hexRgb("#ffe9c9")];
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    const dy = y + 0.5 - cy;
    const half = Math.sqrt(Math.max(0, r * r - dy * dy));
    const band = bands[Math.abs(Math.floor((y - (cy - r)) / 9)) % 3];
    for (let x = Math.ceil(cx - half); x <= Math.floor(cx + half); x++) {
      paint(x, y, band[0], band[1], band[2], 1);
    }
  }
  // Front half of the ring, over the disc.
  thickLine(frontPts, 3, ringCol, 0.8);
  // Tiny distant planet (120, 820), radius 22, dusty rose + crescent shadow.
  const px2 = 120;
  const py2 = 820;
  const pr = 22;
  const rose = hexRgb("#c96a8a");
  fillDisk(px2, py2, pr, rose, 1);
  const shadow = hexRgb("#6a2a4a");
  for (let y = Math.floor(py2 - pr); y <= Math.ceil(py2 + pr); y++) {
    for (let x = Math.floor(px2 - pr); x <= Math.ceil(px2 + pr); x++) {
      const dx = x + 0.5 - px2;
      const dy = y + 0.5 - py2;
      if (dx * dx + dy * dy > pr * pr) continue;
      const sdx = x + 0.5 - (px2 + 9);
      const sdy = y + 0.5 - (py2 - 5);
      if (sdx * sdx + sdy * sdy <= 19 * 19) {
        paint(x, y, shadow[0], shadow[1], shadow[2], 0.5);
      }
    }
  }
}

function drawWhale(): void {
  // Rim light: same shape shifted up 6 px, glowing cyan, drawn first.
  const rimPoly: Pt[] = BODY_POLY.map(([x, y]): Pt => [x, y - 6]);
  const rimCol = hexRgb("#bff3ff");
  fillPoly(rimPoly, () => [rimCol[0], rimCol[1], rimCol[2], 0.5]);
  // Body fill: vertical gradient #6a5cff (top) -> #2a1a8f (bottom).
  const topCol = hexRgb("#6a5cff");
  const botCol = hexRgb("#2a1a8f");
  let minY = H;
  let maxY = 0;
  for (const p of BODY_POLY) {
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  fillPoly(BODY_POLY, (x, y) => {
    const t = clamp((y - minY) / (maxY - minY), 0, 1);
    return [lerp(topCol[0], botCol[0], t), lerp(topCol[1], botCol[1], t), lerp(topCol[2], botCol[2], t), 1];
  });
  // Belly band: smaller smooth shape hugging the bottom edge.
  const bellyPts: Pt[] = [
    [190, 490], [290, 510], [430, 540], [600, 545], [760, 520], [880, 470],
    [880, 445], [760, 495], [600, 520], [430, 515], [290, 485], [190, 465],
  ];
  const bellyPoly = closedSpline(bellyPts, 12);
  const bellyCol = hexRgb("#b9a7ff");
  fillPoly(bellyPoly, () => [bellyCol[0], bellyCol[1], bellyCol[2], 0.35]);
  // Mouth: gently upturned curve from (170, 478) to (300, 500).
  const mouth = openSpline([[170, 478], [220, 492], [300, 500]], 10);
  thickLine(mouth, 4, hexRgb("#14104a"), 1);
  // Eye at (225, 440): white disk, dark pupil, highlight dot up-left.
  fillDisk(225, 440, 7, [255, 255, 255], 1);
  fillDisk(225, 440, 3.5, hexRgb("#14104a"), 1);
  fillDisk(222, 437, 1.5, [255, 255, 255], 1);
  // Pectoral fin: curved triangle from the belly sweeping down-right.
  const finPts: Pt[] = [[430, 535], [560, 640], [520, 520]];
  const finPoly = closedSpline(finPts, 14);
  const finCol = hexRgb("#2c1f9e");
  fillPoly(finPoly, () => [finCol[0], finCol[1], finCol[2], 1]);
  // Thin rim-light line on the fin's upper edge.
  const finEdge = openSpline([[430, 535], [480, 520], [520, 520]], 8);
  thickLine(finEdge, 2, hexRgb("#bff3ff"), 0.6);
  // Star speckles on the body: ~120 seeded dots kept inside the body.
  let placed = 0;
  let tries = 0;
  while (placed < 120 && tries < 900) {
    tries++;
    const x = 150 + rand() * 810;
    const y = 300 + rand() * 245;
    if (!insidePoly(x, y, BODY_POLY)) continue;
    const gold = rand() > 0.5;
    const c: [number, number, number] = gold ? [255, 220, 150] : [255, 255, 255];
    fillDisk(x, y, 0.5 + rand() * 1.0, c, 0.5 + rand() * 0.5);
    placed++;
  }
  // Row of soft glow dots along the top edge.
  const topEdge = openSpline([[230, 400], [360, 350], [520, 330], [680, 345], [800, 380]], 12);
  for (let i = 0; i < topEdge.length; i += 6) {
    glowDisk(topEdge[i][0], topEdge[i][1], 7, hexRgb("#bff3ff"), 0.22);
  }
}

// ---- star trail: spiral of golden stars from the mouth ----
function drawTrail(): void {
  const path = openSpline(
    [[170, 480], [120, 420], [90, 340], [140, 250], [250, 180], [400, 140], [550, 125], [700, 120]],
    10
  );
  // Faint golden ribbon under the stars: overlapping soft circles.
  for (let i = 0; i < path.length; i += 2) {
    glowDisk(path[i][0], path[i][1], 16, hexRgb("#ffb347"), 0.08);
  }
  // ~40 stars along the path, sizes shrinking 7 -> 2 px, gold / white.
  const count = 40;
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const idx = Math.min(path.length - 1, Math.floor(t * (path.length - 1)));
    const [x, y] = path[idx];
    const size = lerp(7, 2, t);
    const gold = rand() > 0.35;
    const c: [number, number, number] = gold ? [255, 200, 90] : [255, 255, 255];
    fillDisk(x, y, size, c, 1);
    glowDisk(x, y, size * 2.4, c, 0.35);
    if (size >= 5) sparkle(x, y, Math.round(size), c, 0.8);
  }
}

// ---- tiny astronaut standing on the whale's back ----
function drawAstronaut(): void {
  const white: [number, number, number] = [255, 255, 255];
  // Helmet: white circle radius 11, dark visor arc on the front (right) side.
  fillDisk(520, 306, 11, white, 1);
  const visor = hexRgb("#14104a");
  for (let y = 295; y <= 317; y++) {
    for (let x = 509; x <= 531; x++) {
      const dx = x + 0.5 - 520;
      const dy = y + 0.5 - 306;
      if (dx * dx + dy * dy > 121) continue;
      const vx = x + 0.5 - 525;
      const vy = y + 0.5 - 306;
      if (vx * vx + vy * vy <= 42) paint(x, y, visor[0], visor[1], visor[2], 1);
    }
  }
  // Body capsule ~12 wide x 16 tall.
  thickLine([[520, 315], [520, 331]], 12, white, 1);
  // Legs: two short lines.
  thickLine([[517, 331], [513, 342]], 3, white, 1);
  thickLine([[523, 331], [527, 342]], 3, white, 1);
  // One arm raised, waving.
  thickLine([[525, 318], [536, 304]], 3, white, 1);
  fillDisk(536, 304, 2.5, white, 1);
  // Thin gold tether curving from the astronaut down to the whale's back.
  const tether = openSpline([[515, 331], [506, 335], [496, 337]], 6);
  thickLine(tether, 2, hexRgb("#ffd76a"), 0.9);
}

// ---- vignette: darken the four corners slightly ----
function vignette(): void {
  const cx = W / 2;
  const cy = H / 2;
  const maxD = Math.sqrt(cx * cx + cy * cy);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy) / maxD;
      const f = smoothstep(0.55, 1.0, d) * 0.25;
      if (f <= 0) continue;
      const i = (y * W + x) * 3;
      const keep = 1 - f;
      buf[i] *= keep;
      buf[i + 1] *= keep;
      buf[i + 2] *= keep;
    }
  }
}

// ---- main ----
function main(): void {
  drawSky();
  nebula(750, 220, 260, hexRgb("#ff2d78"), 0.16);
  nebula(250, 750, 300, hexRgb("#00e5c7"), 0.12);
  nebula(850, 800, 220, hexRgb("#ffb347"), 0.1);
  drawStars();
  drawPlanets();
  drawWhale();
  drawTrail();
  drawAstronaut();
  vignette();
  const png = encodePng();
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, png);
  const hash = createHash("sha256").update(png).digest("hex");
  console.log("wrote " + OUT_PATH);
  console.log("bytes " + png.length);
  console.log("sha256 " + hash);
}

main();



