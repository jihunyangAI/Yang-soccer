import * as THREE from 'three';
import type { Look } from '../sim/player';
import { HEAD_AO, HEAD_COUNT, HEAD_EAR, HEAD_EYES, HEAD_INDEX, HEAD_MORPHS, HEAD_POS, HEAD_UV } from './headData';

// Head and neck from the MakeHuman base mesh (CC0), see web/scripts/mh-head/.
// Game space: metres, x forward, y up, z to the player's right.

const bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
const Q = 1e-4;

interface Base {
  pos: Float32Array; uv: Float32Array; index: Uint16Array; ao: Uint8Array;
  /** UV seams split vertices; weld[i] is the shared vertex used for normals and the hair shell. */
  weld: Uint16Array; wcount: number; windex: Uint16Array; first: Uint16Array; wear: Float32Array;
}
interface Morph { idx: Uint16Array; d: Int16Array; eyes: number[][] }
let base: Base | null = null;
const morphs: Record<string, Morph> = {};

function data(): Base {
  if (base) return base;
  const p = new Int16Array(bytes(HEAD_POS));
  const pos = new Float32Array(p.length);
  for (let i = 0; i < p.length; i++) pos[i] = p[i] * Q;
  const u = new Uint16Array(bytes(HEAD_UV));
  const uv = new Float32Array(u.length);
  for (let i = 0; i < u.length; i++) uv[i] = u[i] / 65535;
  const index = new Uint16Array(bytes(HEAD_INDEX)), ear = new Uint8Array(bytes(HEAD_EAR));
  // Vertices with identical positions share one welded id (computed once; morphs move them together).
  const ids = new Map<string, number>(), weld = new Uint16Array(HEAD_COUNT), first: number[] = [];
  for (let i = 0; i < HEAD_COUNT; i++) {
    const k = `${p[i * 3]},${p[i * 3 + 1]},${p[i * 3 + 2]}`;
    let j = ids.get(k);
    if (j === undefined) { j = first.length; ids.set(k, j); first.push(i); }
    weld[i] = j;
  }
  const wear = new Float32Array(first.length);
  for (let i = 0; i < HEAD_COUNT; i++) wear[weld[i]] = Math.max(wear[weld[i]], ear[i] / 255);
  base = { pos, uv, index, ao: new Uint8Array(bytes(HEAD_AO)), weld, wcount: first.length, windex: index.map((v) => weld[v]), first: Uint16Array.from(first), wear };
  for (const [k, m] of Object.entries(HEAD_MORPHS)) morphs[k] = { idx: new Uint16Array(bytes(m.idx)), d: new Int16Array(bytes(m.d)), eyes: m.eyes };
  return base;
}

/** Small deterministic PRNG so a player always gets the same face. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 4294967296);
}

/** Morph weights for one player: ancestry follows skin tone, the rest is varied per face. */
function faceWeights(look: Look, seed: number): Record<string, number> {
  const r = rng(seed * 2654435761 + look.skin);
  const R = (a: number, b: number) => a + (b - a) * r();
  const c = look.skin, lum = (0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255)) / 255;
  const dark = THREE.MathUtils.smoothstep(lum, 0.62, 0.42);
  const east = (1 - dark) * R(0, 1) ** 1.5;
  const w: Record<string, number> = { african: dark * R(0.6, 1.1), asian: east * 1.1, caucasian: (1 - dark) * (1 - east) * 1.1 };
  const pickOne = (names: string[], lo: number, hi: number) => { w[names[Math.floor(r() * names.length)]] = R(lo, hi); };
  pickOne(['square', 'oval', 'round', 'rect', 'tri'], 0.3, 0.9);
  pickOne(['noseWide', 'noseNarrow', 'noseHump', 'noseLong', 'flare'], 0.3, 1);
  if (r() < 0.5) w.noseTip = R(0.3, 1);
  pickOne(['chinWide', 'chinNarrow', 'chinOut', 'chinIn', 'chinLong'], 0.2, 0.8);
  if (r() < 0.25) w.chinCleft = R(0.5, 1);
  pickOne(['lipsFull', 'lipsThin', 'mouthWide'], 0.2, 0.9);
  w.lean = R(0.3, 1);
  if (r() < 0.5) w.browLow = R(0.2, 0.7);
  if (r() < 0.4) w.temple = R(0.3, 1);
  return w;
}

export interface HeadParts {
  skin: THREE.BufferGeometry;
  hair: THREE.BufferGeometry;
  /** Eyeball centres, left (−z) then right. */
  eyes: THREE.Vector3[];
}

/**
 * Hair styles. front/side/back: hairline height (on the head's unit sphere) at the forehead,
 * above the ears and at the nape; scalp: how strongly the scalp is tinted under the hairline.
 */
const HAIR = [
  { thick: 0.0055, front: 0.55, side: 0.14, back: -0.6, jag: 0.02, scalp: 0.75, curl: 0, hang: 0, streak: 0.14, ridge: 0.0012 },   // short
  { thick: 0.0008, front: 0.58, side: 0.2, back: -0.5, jag: 0.012, scalp: 0.85, curl: 0, hang: 0, streak: 0.04, ridge: 0 },   // buzz cut
  { thick: 0.0095, front: 0.5, side: 0.12, back: -0.6, jag: 0.035, scalp: 0.95, curl: 0.008, hang: 0, streak: 0.05, ridge: 0 }, // curly
  { thick: 0.008, front: 0.42, side: 0.08, back: -0.95, jag: 0.03, scalp: 0.75, curl: 0, hang: 0.006, streak: 0.16, ridge: 0.0022 }, // longer
] as const;

const NECK_LO = 1.575, NECK_HI = 1.64;
/** Head-bone share of a vertex at height y: the bottom of the neck follows the neck bone. */
const headShare = (y: number) => 0.3 + 0.7 * THREE.MathUtils.clamp((y - NECK_LO) / (NECK_HI - NECK_LO), 0, 1);

function skinned(g: THREE.BufferGeometry, color: (i: number) => [number, number, number], head: number, neck: number): THREE.BufferGeometry {
  const pos = g.getAttribute('position');
  const n = pos.count;
  const col = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const [r, gg, b] = color(i);
    col[i * 3] = r; col[i * 3 + 1] = gg; col[i * 3 + 2] = b;
    const h = headShare(pos.getY(i));
    si[i * 4] = head; si[i * 4 + 1] = neck;
    sw[i * 4] = h; sw[i * 4 + 1] = 1 - h;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  return g;
}

/**
 * Build the skin, hair and eye positions for one player.
 * uvTo maps the head's face-sheet UV (0..1) into the shared atlas.
 */
export function buildHead(look: Look, seed: number, bones: { head: number; neck: number }, uvTo: (u: number, v: number) => [number, number]): HeadParts {
  const b = data();
  const pos = b.pos.slice();
  const w = faceWeights(look, seed);
  const eyes = HEAD_EYES.map((e) => new THREE.Vector3(e[0], e[1], e[2]));
  for (const [k, wt] of Object.entries(w)) {
    const m = morphs[k];
    if (!m || !wt) continue;
    for (let j = 0; j < m.idx.length; j++) {
      const o = m.idx[j] * 3;
      pos[o] += m.d[j * 3] * Q * wt; pos[o + 1] += m.d[j * 3 + 1] * Q * wt; pos[o + 2] += m.d[j * 3 + 2] * Q * wt;
    }
    m.eyes.forEach((d, s) => eyes[s].add(new THREE.Vector3(d[0], d[1], d[2]).multiplyScalar(wt)));
  }

  // ---- skin ----
  const skin = new THREE.BufferGeometry();
  skin.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const uv = new Float32Array(HEAD_COUNT * 2);
  for (let i = 0; i < HEAD_COUNT; i++) {
    const [u, v] = uvTo(b.uv[i * 2], b.uv[i * 2 + 1]);
    uv[i * 2] = u; uv[i * 2 + 1] = v;
  }
  skin.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  skin.setIndex(new THREE.BufferAttribute(b.index, 1));
  // Normals must not split along UV seams, so compute them on the welded mesh.
  const wpos = new Float32Array(b.wcount * 3);
  for (let j = 0; j < b.wcount; j++) wpos.set(pos.subarray(b.first[j] * 3, b.first[j] * 3 + 3), j * 3);
  const welded = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(wpos, 3)).setIndex(new THREE.BufferAttribute(b.windex, 1));
  welded.computeVertexNormals();
  const wn = welded.getAttribute('normal'), wp = welded.getAttribute('position');
  const nrm = new Float32Array(HEAD_COUNT * 3);
  for (let i = 0; i < HEAD_COUNT; i++) {
    const j = b.weld[i];
    nrm[i * 3] = wn.getX(j); nrm[i * 3 + 1] = wn.getY(j); nrm[i * 3 + 2] = wn.getZ(j);
  }
  skin.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  // ---- hair field: how far above the hairline each welded vertex sits ----
  const style = look.style;
  const H = HAIR[style];
  const hr = rng(seed * 31 + 7);
  const ph = [hr(), hr(), hr(), hr()].map((x) => x * Math.PI * 2);
  const C = new THREE.Vector3(0.02, 1.7, 0), RAD = new THREE.Vector3(0.1, 0.116, 0.086);
  const S = THREE.MathUtils.smoothstep;
  const n = b.wcount;
  const above = new Float32Array(n), earOff = new Float32Array(n), dir = new Float32Array(n * 3);
  const d = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    d.set(wp.getX(i), wp.getY(i), wp.getZ(i)).sub(C).divide(RAD).normalize();
    dir[i * 3] = d.x; dir[i * 3 + 1] = d.y; dir[i * 3 + 2] = d.z;
    // Hairline: high on the forehead, down the temples into short sideburns, low at the nape,
    // with an irregular edge so it does not read as a cut-out cap.
    const sides = Math.abs(d.z);
    const burn = 0.32 * S(sides, 0.6, 0.9) * S(d.x, -0.35, -0.05) * (1 - S(d.x, 0.25, 0.45));
    const az = Math.atan2(d.z, d.x);
    const jag = H.jag * (0.5 * Math.sin(az * 9 + ph[0]) + 0.3 * Math.sin(az * 17 + ph[1]) + 0.2 * Math.sin(az * 41 + ph[2]));
    const line = H.side + (H.front - H.side) * Math.pow(Math.max(0, d.x), 1.3) * (1 - 0.6 * sides * sides)
      + (H.back - H.side) * Math.pow(Math.max(0, -d.x), 1.1) - burn + jag;
    above[i] = d.y - line;
    earOff[i] = 1 - S(b.wear[i], 0.5, 0.85); // ears stay clear of the hair
  }

  // ---- skin: AO, and the scalp tinted toward the hair colour so the hairline fades in softly ----
  const sc = new THREE.Color(look.skin);
  const hc = new THREE.Color(look.hair);
  skinned(skin, (i) => {
    const j = b.weld[i], a = b.ao[i] / 255;
    const k = H.scalp * S(above[j], -0.07, 0.01) * earOff[j];
    return [(sc.r * (1 - k) + hc.r * 0.85 * k) * a, (sc.g * (1 - k) + hc.g * 0.85 * k) * a, (sc.b * (1 - k) + hc.b * 0.85 * k) * a];
  }, bones.head, bones.neck);

  // ---- hair shell: grows out of the tinted scalp just above the hairline ----
  const hp = new Float32Array(n * 3), hcol = new Float32Array(n * 3);
  const keep: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const dx = dir[i * 3], dy = dir[i * 3 + 1], dz = dir[i * 3 + 2];
    const fade = S(above[i], 0, 0.09) * earOff[i];
    keep.push(earOff[i] > 0.1 && above[i] > -0.02);
    // Curls: overlapping bumps; longer hair hangs fuller over the back and sides.
    // Tight coils: sharpened bumps, so the surface reads as clumps rather than waves.
    const raw = Math.sin(dx * 21 + ph[0]) * Math.sin(dy * 19 + ph[1]) * Math.sin(dz * 23 + ph[2])
      + 0.6 * Math.sin(dx * 33 + ph[3]) * Math.sin(dy * 31) * Math.sin(dz * 37);
    const bump = Math.sign(raw) * Math.sqrt(Math.abs(raw) / 1.6);
    const curl = H.curl * (0.5 + 0.5 * bump) * fade; // outward only, so curls never open holes
    const hang = H.hang * S(-dy, -0.2, 0.5) * S(-dx, -0.6, 0.2) * fade;
    // Strand ridges: shallow grooves running from the forehead to the crown and back.
    const az0 = Math.atan2(dz, dx);
    const ridge = H.ridge * Math.sin(az0 * 16 + dy * 4 + ph[1]) * (0.6 + 0.4 * Math.sin(az0 * 7 - dy * 3 + ph[3])) * S(fade, 0.3, 1);
    // Fuller on the crown, close to the head over the ears.
    const off = -0.002 + (H.thick * (0.35 + 0.65 * Math.max(0, dy)) + 0.002) * fade + curl + hang + ridge;
    hp[i * 3] = wp.getX(i) + wn.getX(i) * off;
    hp[i * 3 + 1] = wp.getY(i) + wn.getY(i) * off;
    hp[i * 3 + 2] = wp.getZ(i) + wn.getZ(i) * off;
    // Colour: strand streaks running back from the forehead, a sheen on the crown,
    // darker roots at the edge and in the curls' hollows.
    const az = az0;
    let k = 1 + H.streak * (0.6 * Math.sin(az * 23 + dy * 5 + ph[1]) + 0.4 * Math.sin(az * 53 - dy * 9 + ph[2]));
    k *= 0.82 + 0.18 * S(fade, 0.2, 0.9);
    if (H.curl) k *= 0.7 + 0.5 * (0.5 + 0.5 * bump);
    const sheen = 0.03 * S(dy, 0.55, 0.95);
    hcol[i * 3] = hc.r * k + sheen; hcol[i * 3 + 1] = hc.g * k + sheen * 0.95; hcol[i * 3 + 2] = hc.b * k + sheen * 0.85;
  }
  const wi = b.windex;
  const hidx: number[] = [];
  for (let t = 0; t < wi.length; t += 3) if (keep[wi[t]] || keep[wi[t + 1]] || keep[wi[t + 2]]) hidx.push(wi[t], wi[t + 1], wi[t + 2]);
  const hair = new THREE.BufferGeometry();
  hair.setAttribute('position', new THREE.BufferAttribute(hp, 3));
  hair.setIndex(hidx);
  hair.computeVertexNormals();
  const white = uvTo(-1, -1);
  hair.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2).map((_, k) => white[k & 1]), 2));
  skinned(hair, (i) => [hcol[i * 3], hcol[i * 3 + 1], hcol[i * 3 + 2]], bones.head, bones.neck);
  welded.dispose();
  return { skin, hair, eyes };
}


/** Eyeball looking forward (+x): white, coloured iris and a dark pupil, by angle from the front. */
export function eyeball(center: THREE.Vector3, r: number, iris: number, seg: number): { geo: THREE.BufferGeometry; colors: Float32Array } {
  const g = new THREE.SphereGeometry(r, seg, Math.max(6, Math.round(seg * 0.8))).rotateZ(-Math.PI / 2).translate(center.x, center.y, center.z);
  const p = g.getAttribute('position');
  const colors = new Float32Array(p.count * 3);
  const ic = new THREE.Color(iris), white = new THREE.Color(0xf3f1ec), pupil = new THREE.Color(0x0d0d0d), c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const a = Math.acos(THREE.MathUtils.clamp((p.getX(i) - center.x) / r, -1, 1));
    if (a < 0.24) c.copy(pupil);
    else if (a < 0.62) c.copy(ic);
    else c.copy(white);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  return { geo: g, colors };
}
