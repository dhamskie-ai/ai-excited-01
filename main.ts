// SPDX-License-Identifier: MIT
// STARWHALE — a galaxy-sized luminous whale arcing through a nebula,
// blowing a spiral of golden stars, with a tiny astronaut on its back.
// Fully procedural, deterministic (fixed-seed PRNG), standard library only.
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const W = 1024;
const H = 1024;
const SEED = 20261116;

// ---------- PRNG (mulberry32, fixed seed) ----------
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
const rand = mulberry32(SEED);

// ---------- small helpers ----------
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
type RGB = [number, number, number];
function hex(h: string): RGB {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function mix3(c1: RGB, c2: RGB, t: number): RGB {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

// ---------- float RGB buffer ----------
const buf = new Float32Array(W * H * 3);

function blendPx(x: number, y: number, r: number, g: number, b: number, a: number): void {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || xi >= W || yi < 0 || yi >= H) return;
  const i = (yi * W + xi) * 3;
  const ia = 1 - a;
  buf[i] = r * a + buf[i] * ia;
  buf[i + 1] = g * a + buf[i + 1] * ia;
  buf[i + 2] = b * a + buf[i + 2] * ia;
}
function addPx(x: number, y: number, r: number, g: number, b: number, a: number): void {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || xi >= W || yi < 0 || yi >= H) return;
  const i = (yi * W + xi) * 3;
  buf[i] += r * a;
  buf[i + 1] += g * a;
  buf[i + 2] += b * a;
}

// Disk fill (source-over blend)
function disk(cx: number, cy: number, rad: number, c: RGB, a: number): void {
  const r = Math.max(0.5, rad);
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(H - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= r) {
        // soft 1px edge
        const edge = clamp(r - d + 0.5, 0, 1);
        blendPx(x, y, c[0], c[1], c[2], a * edge);
      }
    }
  }
}

// Soft radial glow blob (additive)
function glow(cx: number, cy: number, rad: number, c: RGB, a: number): void {
  const x0 = Math.max(0, Math.floor(cx - rad));
  const x1 = Math.min(W - 1, Math.ceil(cx + rad));
  const y0 = Math.max(0, Math.floor(cy - rad));
  const y1 = Math.min(H - 1, Math.ceil(cy + rad));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy) / rad;
      if (d < 1) {
        const f = smoothstep(1, 0, d);
        addPx(x, y, c[0], c[1], c[2], a * f);
      }
    }
  }
}

// Thick line as a chain of disks along sampled points
function thickLine(pts: Array<[number, number]>, thick: number, c: RGB, a: number): void {
  const r = thick / 2;
  for (let i = 0; i < pts.length; i++) {
    disk(pts[i][0], pts[i][1], r, c, a);
  }
}

// Quadratic bezier sampler
function quad(p0: [number, number], p1: [number, number], p2: [number, number], n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([
      u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
      u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    ]);
  }
  return out;
}

// ---------- geometry ----------
type Pt = [number, number];

// Closed Catmull-Rom spline through control points, samples per segment
function catmullRomClosed(pts: Array<Pt>, samplesPerSeg: number): Array<Pt> {
  const n = pts.length;
  const out: Array<Pt> = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    for (let s = 0; s < samplesPerSeg; s++) {
      const t = s / samplesPerSeg;
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

// Open Catmull-Rom spline through control points
function catmullRomOpen(pts: Array<Pt>, samplesPerSeg: number): Array<Pt> {
  const n = pts.length;
  const ext: Array<Pt> = [pts[0], ...pts, pts[n - 1]];
  const out: Array<Pt> = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = ext[i];
    const p1 = ext[i + 1];
    const p2 = ext[i + 2];
    const p3 = ext[i + 3];
    for (let s = 0; s < samplesPerSeg; s++) {
      const t = s / samplesPerSeg;
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
  out.push([pts[n - 1][0], pts[n - 1][1]]);
  return out;
}

// Ray-casting point-in-polygon
function pointInPolygon(x: number, y: number, poly: Array<Pt>): boolean {
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

// Scanline polygon fill; colorFn(y) returns [r,g,b,a] for that scanline
function fillPolygon(poly: Array<Pt>, colorFn: (y: number) => [number, number, number, number]): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(H - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    const xs: Array<number> = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0];
      const yi = poly[i][1];
      const xj = poly[j][0];
      const yj = poly[j][1];
      if ((yi <= yc && yj > yc) || (yj <= yc && yi > yc)) {
        xs.push(xi + ((yc - yi) * (xj - xi)) / (yj - yi));
      }
    }
    xs.sort((a, b) => a - b);
    const [r, g, b, a] = colorFn(y);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xStart = Math.max(0, Math.ceil(xs[k] - 0.5));
      const xEnd = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xStart; x <= xEnd; x++) {
        blendPx(x, y, r, g, b, a);
      }
    }
  }
}

// ================= SCENE =================

// 1. Sky: vertical gradient
{
  const stops: Array<[number, RGB]> = [
    [0, hex("#050514")],
    [0.33, hex("#0d0b2e")],
    [0.66, hex("#1a0f3c")],
    [1, hex("#04263b")],
  ];
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    let c: RGB = stops[0][1];
    for (let s = 0; s < stops.length - 1; s++) {
      if (t >= stops[s][0] && t <= stops[s + 1][0]) {
        const lt = (t - stops[s][0]) / (stops[s + 1][0] - stops[s][0]);
        c = mix3(stops[s][1], stops[s + 1][1], lt);
        break;
      }
    }
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      buf[i] = c[0];
      buf[i + 1] = c[1];
      buf[i + 2] = c[2];
    }
  }
}

// 2. Nebula clouds (soft additive radial blobs)
glow(750, 220, 260, hex("#ff2d78"), 0.16);
glow(250, 750, 300, hex("#00e5c7"), 0.12);
glow(850, 800, 220, hex("#ffb347"), 0.1);

// Whale body outline (defined early: stars must avoid it)
const whaleCtrl: Array<Pt> = [
  [150, 470],
  [230, 400],
  [360, 350],
  [520, 330],
  [680, 345],
  [800, 380],
  [880, 420],
  [960, 300],
  [905, 440],
  [955, 540],
  [880, 470],
  [760, 520],
  [600, 545],
  [430, 540],
  [290, 510],
  [190, 490],
];
const whalePoly = catmullRomClosed(whaleCtrl, 16);

// 3. Stars (~500 seeded), never inside the whale body
{
  const starCols: Array<RGB> = [hex("#ffffff"), hex("#cfe4ff"), hex("#ffe9a8")];
  const bright: Array<[number, number, number]> = [];
  let placed = 0;
  let guard = 0;
  while (placed < 500 && guard < 4000) {
    guard++;
    const x = rand() * W;
    const y = rand() * H;
    if (pointInPolygon(x, y, whalePoly)) continue;
    const r = 0.5 + rand() * 1.5;
    const a = 0.4 + rand() * 0.6;
    const c = starCols[Math.floor(rand() * starCols.length)];
    disk(x, y, r, c, a);
    if (r > 1.4 && a > 0.8) bright.push([x, y, r]);
    placed++;
  }
  // 4-point sparkle on the brightest ~20
  bright.sort((p, q) => q[2] - p[2]);
  const spark = bright.slice(0, 20);
  for (const [x, y] of spark) {
    const L = 7;
    for (let d = -L; d <= L; d++) {
      blendPx(x + d, y, 1, 1, 1, 0.75 * (1 - Math.abs(d) / (L + 1)));
      blendPx(x, y + d, 1, 1, 1, 0.75 * (1 - Math.abs(d) / (L + 1)));
    }
  }
}

// 4. Ringed planet at (830, 150), r 55
{
  const cx = 830;
  const cy = 150;
  const R = 55;
  const tilt = (-20 * Math.PI) / 180;
  const rx = 96;
  const ry = 26;
  const ringCol = hex("#ffe9a8");
  const ellipsePt = (theta: number): Pt => {
    const ex = rx * Math.cos(theta);
    const ey = ry * Math.sin(theta);
    return [
      cx + ex * Math.cos(tilt) - ey * Math.sin(tilt),
      cy + ex * Math.sin(tilt) + ey * Math.cos(tilt),
    ];
  };
  // back arc (theta pi..2pi) behind the disc
  {
    const pts: Array<Pt> = [];
    for (let i = 0; i <= 60; i++) {
      pts.push(ellipsePt(Math.PI + (i / 60) * Math.PI));
    }
    thickLine(pts, 3, ringCol, 0.8);
  }
  // disc with horizontal bands
  const bands: Array<RGB> = [hex("#ffb37a"), hex("#7a5cff"), hex("#ffe9c9")];
  for (let y = Math.floor(cy - R); y <= Math.ceil(cy + R); y++) {
    const dy = y + 0.5 - cy;
    const half = Math.sqrt(Math.max(0, R * R - dy * dy));
    const band = Math.floor((y - (cy - R)) / 13) % 3;
    const shade = 1 - 0.25 * smoothstep(0, R, Math.abs(dy));
    const c = bands[band];
    for (let x = Math.ceil(cx - half); x <= Math.floor(cx + half); x++) {
      blendPx(x, y, c[0] * shade, c[1] * shade, c[2] * shade, 1);
    }
  }
  // front arc (theta 0..pi) over the disc
  {
    const pts: Array<Pt> = [];
    for (let i = 0; i <= 60; i++) {
      pts.push(ellipsePt((i / 60) * Math.PI));
    }
    thickLine(pts, 3, ringCol, 0.8);
  }
}

// Second tiny distant planet at (120, 820), r 22
{
  const cx = 120;
  const cy = 820;
  const R = 22;
  const rose = hex("#c96a8a");
  const dark = hex("#6e2b47");
  for (let y = Math.floor(cy - R); y <= Math.ceil(cy + R); y++) {
    for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= R * R) {
        // crescent shadow: offset dark disk upper-right
        const sx = x + 0.5 - (cx + 9);
        const sy = y + 0.5 - (cy - 7);
        if (sx * sx + sy * sy <= R * R) {
          blendPx(x, y, dark[0], dark[1], dark[2], 0.55);
        } else {
          blendPx(x, y, rose[0], rose[1], rose[2], 1);
        }
      }
    }
  }
}

// 5. Whale
// Rim light: same shape shifted up 6px, glowing cyan, drawn first
{
  const shifted = whalePoly.map(([x, y]): Pt => [x, y - 6]);
  fillPolygon(shifted, () => [0.75, 0.95, 1, 0.5]);
}
// Body fill: vertical gradient #6a5cff -> #2a1a8f
{
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of whalePoly) {
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const top = hex("#6a5cff");
  const bot = hex("#2a1a8f");
  fillPolygon(whalePoly, (y) => {
    const c = mix3(top, bot, clamp((y - minY) / (maxY - minY), 0, 1));
    return [c[0], c[1], c[2], 1];
  });
}
// Belly band: lower chain inset ~25px upward
{
  // find sampled index nearest tail-stock-bottom (880, 470)
  let idx = 0;
  let best = Infinity;
  for (let i = 0; i < whalePoly.length; i++) {
    const d = Math.hypot(whalePoly[i][0] - 880, whalePoly[i][1] - 470);
    if (d < best) {
      best = d;
      idx = i;
    }
  }
  const lower: Array<Pt> = [];
  for (let k = 0; k < whalePoly.length; k++) {
    const i = (idx + k) % whalePoly.length;
    lower.push(whalePoly[i]);
    if (Math.hypot(whalePoly[i][0] - 150, whalePoly[i][1] - 470) < 4) break;
  }
  const band: Array<Pt> = [...lower];
  for (let k = lower.length - 1; k >= 0; k--) {
    band.push([lower[k][0], lower[k][1] - 26]);
  }
  const belly = hex("#b9a7ff");
  fillPolygon(band, () => [belly[0], belly[1], belly[2], 0.35]);
}
// Mouth: gently upturned curve (170,478) -> (300,500)
{
  const pts = quad([170, 478], [235, 503], [300, 500], 100);
  thickLine(pts, 4, hex("#14104a"), 0.9);
}
// Pectoral fin: curved triangle (430,535) -> (560,640) -> (520,520)
{
  const e1 = quad([430, 535], [520, 612], [560, 640], 24);
  const e2 = quad([560, 640], [545, 575], [520, 520], 24);
  const finPoly: Array<Pt> = [...e1, ...e2];
  const fin = hex("#2c1f9e");
  fillPolygon(finPoly, () => [fin[0], fin[1], fin[2], 1]);
  // thin rim-light line on the upper edge (520,520) -> (430,535)
  const rim = quad([520, 520], [475, 522], [430, 535], 20);
  thickLine(rim, 2, hex("#bff3ff"), 0.7);
}
// Star speckles on the body (~120 seeded, inside polygon only)
{
  let placed = 0;
  let guard = 0;
  while (placed < 120 && guard < 3000) {
    guard++;
    const x = 140 + rand() * 830;
    const y = 300 + rand() * 250;
    if (!pointInPolygon(x, y, whalePoly)) continue;
    const c = rand() < 0.6 ? hex("#ffffff") : hex("#ffe9a8");
    disk(x, y, 0.5 + rand() * 1.0, c, 0.5 + rand() * 0.5);
    placed++;
  }
}
// Eye at (225, 440)
disk(225, 440, 7, hex("#ffffff"), 1);
disk(226, 441, 3.5, hex("#14104a"), 1);
disk(222.5, 437.5, 1.5, hex("#ffffff"), 1);
// Soft glow dots along the top edge
{
  const topChain: Array<Pt> = [
    [150, 470],
    [230, 400],
    [360, 350],
    [520, 330],
    [680, 345],
    [800, 380],
    [880, 420],
  ];
  const edge = catmullRomOpen(topChain, 8);
  for (let i = 4; i < edge.length - 4; i += 14) {
    glow(edge[i][0], edge[i][1] - 2, 10, hex("#bff3ff"), 0.35);
  }
}

// 6. Star trail: spiral from the mouth up-left, arcing across the top to (700, 120)
{
  const spiralCtrl: Array<Pt> = [
    [170, 480],
    [80, 360],
    [70, 260],
    [180, 170],
    [360, 120],
    [540, 105],
    [700, 120],
  ];
  const path = catmullRomOpen(spiralCtrl, 24);
  // faint golden ribbon under the stars
  for (let i = 0; i < path.length; i += 3) {
    glow(path[i][0], path[i][1], 15, hex("#ffb347"), 0.08);
  }
  // ~40 stars, shrinking 7 -> 2 px, gold/white
  const N = 40;
  for (let k = 0; k < N; k++) {
    const t = k / (N - 1);
    const idx = Math.min(path.length - 1, Math.floor(t * (path.length - 1)));
    const [x, y] = path[idx];
    const r = lerp(7, 2, t);
    const c = k % 3 === 0 ? hex("#ffffff") : hex("#ffd76a");
    glow(x, y, r * 2.2, hex("#ffb347"), 0.5);
    disk(x, y, r, c, 1);
    if (k % 5 === 0) {
      // tiny sparkle cross on every 5th star
      for (let d = -5; d <= 5; d++) {
        blendPx(x + d, y, 1, 1, 1, 0.6 * (1 - Math.abs(d) / 6));
        blendPx(x, y + d, 1, 1, 1, 0.6 * (1 - Math.abs(d) / 6));
      }
    }
  }
}

// 7. Astronaut on the whale's back at ~(520, 322)
{
  const white = hex("#ffffff");
  const dark = hex("#1a1440");
  const gold = hex("#ffd76a");
  // tether: thin gold curve from the astronaut down-left along the back
  const tether = quad([518, 330], [492, 348], [466, 339], 24);
  thickLine(tether, 1.5, gold, 0.9);
  // legs
  thickLine([[517, 330], [515, 336]], 3, white, 1);
  thickLine([[523, 330], [525, 336]], 3, white, 1);
  // body capsule (rounded rect approx: rect + top/bottom disks)
  for (let y = 316; y <= 330; y++) {
    for (let x = 515; x <= 525; x++) {
      blendPx(x, y, white[0], white[1], white[2], 1);
    }
  }
  disk(520, 316, 5, white, 1);
  disk(520, 330, 5, white, 1);
  // raised arm (right side, waving)
  thickLine([[524, 320], [533, 307]], 2.5, white, 1);
  disk(534, 306, 2, white, 1);
  // left arm resting
  thickLine([[516, 320], [511, 328]], 2.5, white, 1);
  // helmet
  disk(520, 307, 9, white, 1);
  // dark visor arc (front-right of helmet)
  disk(523, 307, 5, dark, 1);
  disk(521, 305, 1.5, white, 1);
  // backpack hint
  disk(512, 320, 3, hex("#cfe4ff"), 1);
}

// 8. Vignette: darken corners slightly
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const d = Math.hypot(x + 0.5 - W / 2, y + 0.5 - H / 2) / ((W / 2) * Math.SQRT2);
    const f = 1 - 0.25 * smoothstep(0.55, 1.0, d);
    const i = (y * W + x) * 3;
    buf[i] *= f;
    buf[i + 1] *= f;
    buf[i + 2] *= f;
  }
}

// ================= PNG ENCODER =================

// CRC32, table-driven, polynomial 0xEDB88320
const CRC_TABLE: Array<number> = (() => {
  const table: Array<number> = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(): Buffer {
  // quantise float buffer to bytes, filter 0 per scanline
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    const rowStart = y * (1 + W * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const o = rowStart + 1 + x * 3;
      raw[o] = clamp(Math.round(buf[i] * 255), 0, 255);
      raw[o + 1] = clamp(Math.round(buf[i + 1] * 255), 0, 255);
      raw[o + 2] = clamp(Math.round(buf[i + 2] * 255), 0, 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 (RGB)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // no interlace
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ================= RUN =================
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "out";
mkdirSync(outDir, { recursive: true });
const png = encodePNG();
const outPath = join(outDir, "entry.png");
writeFileSync(outPath, png);
const sha = createHash("sha256").update(png).digest("hex");
console.log(`output: ${outPath}`);
console.log(`bytes: ${png.length}`);
console.log(`sha256: ${sha}`);
