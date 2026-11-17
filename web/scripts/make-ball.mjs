// Draws the football used on the title screen: a lit, shaded sphere with the classic
// black-pentagon pattern and a soft shadow, written to src/assets/ball.png.
//   node scripts/make-ball.mjs
// No image is downloaded: every pixel is computed here, so the picture is ours to use.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 360, H = 384, R = 166, CX = 180, CY = 172, SS = 3;

// ---- the ball's pattern: a truncated icosahedron (12 pentagons, 20 hexagons) ----
const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const mix = (a, b, t) => norm([a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t, a[2] * (1 - t) + b[2] * t]);
const PHI = (1 + Math.sqrt(5)) / 2;
const VERTS = [];
for (const s1 of [-1, 1]) for (const s2 of [-1, 1]) {
  VERTS.push(norm([0, s1, s2 * PHI]), norm([s1, s2 * PHI, 0]), norm([s2 * PHI, 0, s1]));
}
// Each pentagon: its centre and its five corners, in order round the centre.
const PENTAGONS = VERTS.map((v) => {
  const near = VERTS.filter((u) => u !== v && dot(u, v) > 0.4);
  const ref = norm(cross(v, [0.3, 0.5, 0.8])), up = cross(v, ref);
  const corners = near.map((u) => mix(v, u, 1 / 3))
    .sort((a, b) => Math.atan2(dot(a, up), dot(a, ref)) - Math.atan2(dot(b, up), dot(b, ref)));
  return { v, corners };
});
// Seams between two hexagons run along the middle third of each edge of the icosahedron.
const HEX_SEAMS = [];
for (let i = 0; i < VERTS.length; i++) for (let j = i + 1; j < VERTS.length; j++) {
  if (dot(VERTS[i], VERTS[j]) > 0.4) HEX_SEAMS.push([mix(VERTS[i], VERTS[j], 1 / 3), mix(VERTS[i], VERTS[j], 2 / 3)]);
}
/** Angle (radians) from a point on the sphere to the arc from a to b. */
function arcDistance(p, a, b) {
  const n = norm(cross(a, b));
  const d = dot(n, p);
  const q = norm([p[0] - n[0] * d, p[1] - n[1] * d, p[2] - n[2] * d]); // nearest point on the great circle
  if (dot(cross(a, q), n) >= 0 && dot(cross(q, b), n) >= 0) return Math.abs(Math.asin(d));
  return Math.min(Math.acos(Math.min(1, dot(p, a))), Math.acos(Math.min(1, dot(p, b))));
}
/** What is at this point of the ball: 1 inside a pentagon, 0 on a hexagon, and how near the closest seam is. */
function pattern(p) {
  let best = PENTAGONS[0], bd = -2;
  for (const g of PENTAGONS) { const d = dot(g.v, p); if (d > bd) { bd = d; best = g; } }
  let inside = true, seam = 9;
  for (let i = 0; i < 5; i++) {
    const a = best.corners[i], b = best.corners[(i + 1) % 5];
    if (dot(cross(a, b), p) < 0) inside = false;
    seam = Math.min(seam, arcDistance(p, a, b));
  }
  if (!inside) for (const [a, b] of HEX_SEAMS) { if (dot(a, p) > 0.9) seam = Math.min(seam, arcDistance(p, a, b)); }
  return { inside, seam };
}

// ---- lighting ----
const rot = (p) => {
  // Turn the ball so that a pentagon sits a little off-centre, as in a product photo.
  const ax = 0.42, ay = -0.5;
  let [x, y, z] = p;
  [y, z] = [y * Math.cos(ax) - z * Math.sin(ax), y * Math.sin(ax) + z * Math.cos(ax)];
  [x, z] = [x * Math.cos(ay) + z * Math.sin(ay), -x * Math.sin(ay) + z * Math.cos(ay)];
  return [x, y, z];
};
const LIGHT = norm([-0.5, 0.72, 0.62]), HALF = norm([LIGHT[0], LIGHT[1], LIGHT[2] + 1]);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function sample(px, py) {
  const x = (px - CX) / R, y = -(py - CY) / R;
  const r2 = x * x + y * y;
  if (r2 <= 1) {
    const n = [x, y, Math.sqrt(1 - r2)];
    const { inside, seam } = pattern(rot(n));
    // Panels are slightly pillowed: the surface dips toward each seam.
    const groove = 1 - smooth(0, 0.035, seam);
    const base = inside ? [0.022, 0.024, 0.03] : [0.955, 0.955, 0.94];
    const diff = Math.max(0, dot(n, LIGHT));
    const wrap = 0.36 + 0.74 * Math.pow(diff, 0.9);
    const rim = Math.pow(1 - n[2], 2.2);
    const spec = Math.pow(Math.max(0, dot(n, HALF)), 46) * (inside ? 0.3 : 0.32) * (1 - groove);
    const bounce = Math.max(0, -n[1]) * 0.07; // green light coming up off the pitch
    let c = base.map((v) => v * wrap * (1 - 0.42 * groove) * (1 - 0.5 * rim));
    c = [c[0] + spec + bounce * 0.4, c[1] + spec + bounce, c[2] + spec + bounce * 0.35];
    return [c[0], c[1], c[2], 1];
  }
  // The shadow on the ground under the ball.
  const sx = (px - CX - 10) / (R * 0.86), sy = (py - (CY + R * 1.0)) / (R * 0.2);
  const a = 0.5 * Math.exp(-(sx * sx + sy * sy) * 1.7);
  return [0, 0, 0, a];
}

// ---- render with supersampling, then encode as PNG ----
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let j = 0; j < H; j++) {
  raw[j * (W * 4 + 1)] = 0;
  for (let i = 0; i < W; i++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sj = 0; sj < SS; sj++) for (let si = 0; si < SS; si++) {
      const s = sample(i + (si + 0.5) / SS, j + (sj + 0.5) / SS);
      r += s[0] * s[3]; g += s[1] * s[3]; b += s[2] * s[3]; a += s[3];
    }
    const o = j * (W * 4 + 1) + 1 + i * 4;
    const to8 = (v) => Math.max(0, Math.min(255, Math.round(Math.pow(Math.max(0, v), 1 / 2.2) * 255))); // linear light → sRGB
    raw[o] = a ? to8(r / a) : 0; raw[o + 1] = a ? to8(g / a) : 0; raw[o + 2] = a ? to8(b / a) : 0;
    raw[o + 3] = Math.round((a / (SS * SS)) * 255);
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};
const head = Buffer.alloc(13);
head.writeUInt32BE(W, 0); head.writeUInt32BE(H, 4); head[8] = 8; head[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
const dir = new URL('../src/assets/', import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL('ball.png', dir), png);
console.log(`wrote src/assets/ball.png  ${W}x${H}  ${(png.length / 1024).toFixed(0)} KB`);
