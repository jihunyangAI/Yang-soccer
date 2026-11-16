import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Look, Player } from '../sim/player';
import { Animator, type AnimExtra } from './animator';
import { B, BONES } from './skeleton';
import { buildHead, eyeball, type HeadParts } from './head';
import { HEAD_FACE_PNG } from './headData';

export interface Kit {
  shirt: number; sleeve?: number; shorts: number; socks: number;
  /** Collar, cuffs and trim; defaults to sleeve or shorts colour. */
  trim?: number;
  /** Chest badge: fill and ring colours. */
  badge?: [number, number];
}

const GLOVE = 0xd7f75b;

// ---------- texture atlas (1024 × 2048) ----------
// Top 1024 px: shirt numbers in a 10×10 grid (cell 0 is solid white for untextured parts).
// Bottom 1024 px: the face sheet baked for the MakeHuman head (see web/scripts/mh-head/).
// Everything is multiplied by vertex colour, so features painted in greys and warm tints
// darken the player's own skin tone instead of replacing it.
const ATLAS_W = 1024, ATLAS_H = 2048, FACE_TOP = 1024;
let atlas: THREE.CanvasTexture | null = null;
const WHITE_UV: [number, number] = [0.05, 0.975];

function numberAtlas(): THREE.CanvasTexture {
  if (atlas) return atlas;
  const C = 1024 / 10;
  const c = document.createElement('canvas');
  c.width = ATLAS_W; c.height = ATLAS_H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, ATLAS_W, ATLAS_H);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, C, C); // white texel for every non-number vertex
  g.font = `900 ${C * 0.78}px "Arial Black", Impact, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let n = 1; n < 100; n++) {
    const cx = (n % 10) * C + C / 2, cy = Math.floor(n / 10) * C + C / 2 + C * 0.04;
    g.fillText(String(n), cx, cy, C * 0.92);
  }
  g.fillStyle = '#fff';
  g.fillRect(0, FACE_TOP, ATLAS_W, ATLAS_H - FACE_TOP);
  atlas = new THREE.CanvasTexture(c);
  const tex = atlas;
  const img = new Image();
  img.onload = () => { g.drawImage(img, 0, FACE_TOP); tex.needsUpdate = true; };
  img.src = HEAD_FACE_PNG;
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 4;
  return atlas;
}
const cellUV = (n: number) => {
  const C = 1024 / 10, cx = n % 10, cy = Math.floor(n / 10);
  return { u0: cx / 10, u1: (cx + 1) / 10, v0: 1 - ((cy + 1) * C) / ATLAS_H, v1: 1 - (cy * C) / ATLAS_H };
};
/** The face sheet occupies the bottom half of the atlas; (−1, −1) means the white cell. */
const FACE_V1 = 1 - FACE_TOP / ATLAS_H;
const faceUV = (u: number, v: number): [number, number] => (u < 0 ? WHITE_UV : [u, v * FACE_V1]);

let material: THREE.MeshLambertMaterial | null = null;
const playerMaterial = () =>
  (material ??= new THREE.MeshLambertMaterial({ vertexColors: true, map: numberAtlas(), alphaTest: 0.5 }));

/** Dark numbers on light shirts, white numbers on dark shirts. */
const inkFor = (c: number) => {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? 0x16181d : 0xffffff;
};

interface Part { geo: THREE.BufferGeometry; color: number; bone: number; number?: number }

/** Rigid part (head, hands, boots…): every vertex follows one bone. */
function prep(part: Part): THREE.BufferGeometry {
  // Some shapes (icosahedron) come without an index; merging needs every part indexed.
  const g = part.geo.index ? part.geo : mergeVertices(part.geo);
  const n = g.getAttribute('position').count;
  const c = new THREE.Color(part.color);
  const col = new Float32Array(n * 3);
  const idx = new Uint16Array(n * 4);
  const w = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    idx[i * 4] = part.bone;
    w[i * 4] = 1;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(idx, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4));
  // UVs: number quads map to their atlas cell, everything else to the white cell.
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  if (part.number !== undefined) {
    const { u0, u1, v0, v1 } = cellUV(part.number);
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  } else {
    for (let i = 0; i < uv.count; i++) uv.setXY(i, WHITE_UV[0], WHITE_UV[1]);
  }
  return g;
}

/** Ellipsoid of radii (rx, ry, rz) centred at (x, y, z). */
const blob = (x: number, y: number, z: number, rx: number, ry: number, rz: number, ws = 12, hs = 8) =>
  new THREE.SphereGeometry(1, ws, hs).scale(rx, ry, rz).translate(x, y, z);

/** Skin weights for a ring: blend from bone a to bone b by t (0 = all a). */
type W = [number, number, number];
const only = (b: number): W => [b, b, 0];
interface Ring { y: number; x?: number; z?: number; rx: number; rz: number; color: number; w: W }

/**
 * One continuous skinned surface through horizontal elliptical rings (top to bottom).
 * Rings near a joint blend two bones, so the surface bends smoothly instead of hinging.
 * Two rings at the same height with different radii/colours make a crisp hem or cuff.
 */
function tube(rings: Ring[], seg: number, capTop: boolean, capBottom: boolean): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [], uv: number[] = [], idx: number[] = [];
  const si: number[] = [], sw: number[] = [];
  const c = new THREE.Color();
  const vert = (x: number, y: number, z: number, r: Ring) => {
    pos.push(x, y, z);
    c.setHex(r.color);
    col.push(c.r, c.g, c.b);
    uv.push(WHITE_UV[0], WHITE_UV[1]);
    si.push(r.w[0], r.w[1], 0, 0);
    sw.push(1 - r.w[2], r.w[2], 0, 0);
  };
  for (const r of rings) {
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      vert((r.x ?? 0) + Math.cos(a) * r.rx, r.y, (r.z ?? 0) + Math.sin(a) * r.rz, r);
    }
  }
  for (let k = 0; k < rings.length - 1; k++) {
    for (let i = 0; i < seg; i++) {
      const a = k * seg + i, b = k * seg + ((i + 1) % seg);
      const cc = (k + 1) * seg + i, d = (k + 1) * seg + ((i + 1) % seg);
      idx.push(a, b, cc, b, d, cc);
    }
  }
  if (capTop) {
    const r = rings[0], t = pos.length / 3;
    vert(r.x ?? 0, r.y + Math.min(r.rx, r.rz) * 0.3, r.z ?? 0, r);
    for (let i = 0; i < seg; i++) idx.push(t, (i + 1) % seg, i);
  }
  if (capBottom) {
    const r = rings[rings.length - 1], base = (rings.length - 1) * seg, t = pos.length / 3;
    vert(r.x ?? 0, r.y - Math.min(r.rx, r.rz) * 0.4, r.z ?? 0, r);
    for (let i = 0; i < seg; i++) idx.push(t, base + i, base + ((i + 1) % seg));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(si), 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const shade = (c: number, k: number) => {
  const r = Math.min(255, ((c >> 16) & 255) * k), g = Math.min(255, ((c >> 8) & 255) * k), b = Math.min(255, (c & 255) * k);
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
};
const BOOTS = [0x18181b, 0xf2f2f2, 0x2f6fed, 0xe8553b, 0xf6c21c, 0x26c281];

/** detail = close-up level: rounder eyeballs. */
function buildGeometry(kit: Kit, look: Look, number: number, gk: boolean, detail: boolean, head: HeadParts): THREE.BufferGeometry {
  const skin = look.skin;
  const hands = gk ? GLOVE : skin;
  const sleeve = kit.sleeve ?? kit.shirt;
  const trim = kit.trim ?? (kit.sleeve && kit.sleeve !== kit.shirt ? kit.sleeve : kit.shorts);
  const band = kit.socks !== kit.shirt ? kit.shirt : kit.shorts;
  const boot = BOOTS[(number * 7 + 3) % BOOTS.length];
  const bootTrim = boot === 0xf2f2f2 ? 0x18181b : 0xf2f2f2;

  const tubes: THREE.BufferGeometry[] = [];
  const parts: Part[] = [];

  // ---- shorts (pelvis) and shirt worn over it ----
  tubes.push(tube([
    { y: 1.03, rx: 0.124, rz: 0.166, color: kit.shorts, w: only(B.Hips) },
    { y: 0.98, rx: 0.13, rz: 0.176, color: kit.shorts, w: only(B.Hips) },
    { y: 0.9, rx: 0.126, rz: 0.18, color: kit.shorts, w: only(B.Hips) },
    { y: 0.84, rx: 0.1, rz: 0.15, color: kit.shorts, w: only(B.Hips) },
  ], 16, false, true));
  tubes.push(tube([
    { y: 1.555, x: 0.02, rx: 0.074, rz: 0.068, color: trim, w: only(B.Neck) },
    { y: 1.53, x: 0.014, rx: 0.084, rz: 0.086, color: trim, w: [B.Chest, B.Neck, 0.5] },
    { y: 1.53, x: 0.014, rx: 0.084, rz: 0.086, color: kit.shirt, w: [B.Chest, B.Neck, 0.5] },
    { y: 1.5, rx: 0.1, rz: 0.15, color: kit.shirt, w: only(B.Chest) },
    { y: 1.46, rx: 0.124, rz: 0.205, color: kit.shirt, w: only(B.Chest) },
    { y: 1.4, rx: 0.14, rz: 0.215, color: kit.shirt, w: only(B.Chest) },
    { y: 1.3, rx: 0.145, rz: 0.2, color: kit.shirt, w: [B.Spine, B.Chest, 0.5] },
    { y: 1.18, rx: 0.13, rz: 0.182, color: kit.shirt, w: only(B.Spine) },
    { y: 1.06, rx: 0.122, rz: 0.17, color: kit.shirt, w: only(B.Spine) },
    { y: 0.97, rx: 0.135, rz: 0.185, color: kit.shirt, w: [B.Hips, B.Spine, 0.3] },
  ], 18, false, false));
  // ---- head: MakeHuman head and neck down under the collar (shared by both detail levels), eyeballs, hair ----
  tubes.push(head.skin.clone(), head.hair.clone());
  for (const e of head.eyes) {
    const eye = eyeball(e, 0.0142, look.eye, detail ? 20 : 8);
    const g = prep({ geo: eye.geo, color: 0xffffff, bone: B.Head });
    g.setAttribute('color', new THREE.BufferAttribute(eye.colors, 3));
    tubes.push(g);
  }

  for (const s of [-1, 1]) {
    const arm = s < 0 ? B.ArmL : B.ArmR, elbow = s < 0 ? B.ElbowL : B.ElbowR;
    const thigh = s < 0 ? B.ThighL : B.ThighR, knee = s < 0 ? B.KneeL : B.KneeR, ankle = s < 0 ? B.AnkleL : B.AnkleR;
    const az = s * 0.242, lz = s * 0.1;

    // ---- arm: deltoid, sleeve with cuff, biceps, forearm, wrist ----
    tubes.push(tube([
      { y: 1.475, z: s * 0.215, rx: 0.058, rz: 0.055, color: sleeve, w: [B.Chest, arm, 0.6] },
      { y: 1.42, z: s * 0.236, rx: 0.065, rz: 0.063, color: sleeve, w: only(arm) },
      { y: 1.34, z: az, rx: 0.061, rz: 0.058, color: sleeve, w: only(arm) },
      { y: 1.3, z: az, rx: 0.059, rz: 0.056, color: trim, w: only(arm) },
      { y: 1.3, z: az, rx: 0.045, rz: 0.043, color: skin, w: only(arm) },
      { y: 1.22, z: az, rx: 0.047, rz: 0.044, color: skin, w: only(arm) },
      { y: 1.15, z: s * 0.244, rx: 0.038, rz: 0.036, color: skin, w: [arm, elbow, 0.5] },
      { y: 1.08, z: s * 0.245, rx: 0.042, rz: 0.039, color: skin, w: only(elbow) },
      { y: 0.97, z: s * 0.245, rx: 0.033, rz: 0.03, color: skin, w: only(elbow) },
      { y: 0.905, z: s * 0.245, rx: 0.027, rz: 0.024, color: skin, w: only(elbow) },
    ], 12, false, true));
    // Hand with thumb (keepers wear big gloves).
    const gs = gk ? 1.3 : 1;
    parts.push(
      { geo: blob(0.004, 0.852, s * 0.246, 0.034 * gs, 0.056 * gs, 0.02 * gs), color: hands, bone: elbow },
      { geo: blob(0.028, 0.872, s * 0.236, 0.012 * gs, 0.026 * gs, 0.012 * gs, 8, 6), color: hands, bone: elbow },
    );

    // ---- leg: shorts leg, quads, knee, sock with band, calf, ankle ----
    tubes.push(tube([
      { y: 0.97, z: lz, rx: 0.1, rz: 0.098, color: kit.shorts, w: [B.Hips, thigh, 0.5] },
      { y: 0.9, z: lz, rx: 0.101, rz: 0.1, color: kit.shorts, w: only(thigh) },
      { y: 0.79, z: lz, rx: 0.099, rz: 0.098, color: kit.shorts, w: only(thigh) },
      { y: 0.79, z: lz, rx: 0.073, rz: 0.071, color: skin, w: only(thigh) },
      { y: 0.7, x: 0.004, z: lz, rx: 0.072, rz: 0.068, color: skin, w: only(thigh) },
      { y: 0.6, x: 0.006, z: lz, rx: 0.062, rz: 0.058, color: skin, w: only(thigh) },
      { y: 0.53, z: lz, rx: 0.052, rz: 0.05, color: skin, w: [thigh, knee, 0.4] },
      { y: 0.49, z: lz, rx: 0.05, rz: 0.048, color: skin, w: [thigh, knee, 0.65] },
      { y: 0.47, z: lz, rx: 0.052, rz: 0.05, color: band, w: only(knee) },
      { y: 0.43, z: lz, rx: 0.056, rz: 0.052, color: band, w: only(knee) },
      { y: 0.43, z: lz, rx: 0.056, rz: 0.052, color: kit.socks, w: only(knee) },
      { y: 0.36, x: -0.01, z: lz, rx: 0.061, rz: 0.054, color: kit.socks, w: only(knee) },
      { y: 0.26, x: -0.004, z: lz, rx: 0.05, rz: 0.046, color: kit.socks, w: only(knee) },
      { y: 0.15, z: lz, rx: 0.037, rz: 0.035, color: kit.socks, w: only(knee) },
      { y: 0.1, z: lz, rx: 0.036, rz: 0.035, color: kit.socks, w: [knee, ankle, 0.5] },
    ], 12, false, true));
    // Boot: rounded upper, heel, sole and a side stripe.
    parts.push(
      { geo: blob(0.045, 0.05, lz, 0.132, 0.05, 0.052), color: boot, bone: ankle },
      { geo: blob(-0.035, 0.062, lz, 0.05, 0.055, 0.047), color: boot, bone: ankle },
      { geo: new THREE.BoxGeometry(0.235, 0.014, 0.078).translate(0.035, 0.008, lz), color: shade(boot, boot === 0x18181b ? 1.6 : 0.6), bone: ankle },
      { geo: new THREE.BoxGeometry(0.12, 0.012, 0.004).translate(0.045, 0.052, lz + s * 0.052), color: bootTrim, bone: ankle },
    );
  }

  // ---- kit details: big number on the back, small number and club badge on the front ----
  if (number > 0 && number < 100) {
    parts.push({ geo: new THREE.PlaneGeometry(0.2, 0.2).rotateY(-Math.PI / 2).translate(-0.146, 1.26, 0), color: inkFor(kit.shirt), bone: B.Spine, number });
    parts.push({ geo: new THREE.PlaneGeometry(0.075, 0.075).rotateY(Math.PI / 2).translate(0.148, 1.36, 0.085), color: inkFor(kit.shirt), bone: B.Chest, number });
  }
  if (kit.badge) {
    parts.push(
      { geo: new THREE.CircleGeometry(0.022, 16).rotateY(Math.PI / 2).translate(0.149, 1.37, -0.085), color: kit.badge[0], bone: B.Chest },
      { geo: new THREE.RingGeometry(0.022, 0.028, 16).rotateY(Math.PI / 2).translate(0.149, 1.37, -0.085), color: kit.badge[1], bone: B.Chest },
    );
  }

  const merged = mergeGeometries([...tubes, ...parts.map(prep)])!;
  for (const g of tubes) g.dispose();
  for (const p of parts) p.geo.dispose();
  return merged;
}

/** One skinned mesh (a single draw call) per player, posed procedurally every frame. */
export class PlayerView {
  readonly root = new THREE.Group();
  private tilt = new THREE.Group();
  private mesh: THREE.SkinnedMesh;
  private lo: THREE.BufferGeometry;
  private hi: THREE.BufferGeometry;

  /** Swap to the detailed model when the camera is close. */
  setDetail(close: boolean): void {
    const g = close ? this.hi : this.lo;
    if (this.mesh.geometry !== g) this.mesh.geometry = g;
  }
  private b: THREE.Bone[];
  private anim: Animator;
  readonly version: number;

  constructor(kit: Kit, p: Player) {
    this.version = p.version;
    // Two levels of detail sharing one skeleton: the close-up face is only used near the camera.
    const l = p.look;
    const head = buildHead(l, l.skin ^ (l.hair * 31) ^ (l.eye * 7) ^ (l.style * 131) ^ (p.number * 7919), { head: B.Head, neck: B.Neck }, faceUV);
    this.lo = buildGeometry(kit, l, p.number, p.role === 'gk', false, head);
    this.hi = buildGeometry(kit, l, p.number, p.role === 'gk', true, head);
    head.skin.dispose();
    head.hair.dispose();
    this.mesh = new THREE.SkinnedMesh(this.lo, playerMaterial());
    this.mesh.frustumCulled = false;
    this.b = BONES.map(() => new THREE.Bone());
    BONES.forEach((def, i) => {
      const bone = this.b[i];
      const pa = def.parent >= 0 ? BONES[def.parent].at : [0, 0, 0];
      bone.position.set(def.at[0] - pa[0], def.at[1] - pa[1], def.at[2] - pa[2]);
      if (def.parent >= 0) this.b[def.parent].add(bone);
    });
    this.mesh.add(this.b[0]);
    this.mesh.updateMatrixWorld(true);
    this.mesh.bind(new THREE.Skeleton(this.b));
    this.anim = new Animator(this.b, this.tilt);
    this.tilt.add(this.mesh);
    this.root.add(this.tilt);
  }

  dispose(): void {
    this.lo.dispose();
    this.hi.dispose();
    this.mesh.skeleton.dispose();
  }

  /** Pose the player for this frame (see Animator). */
  update(p: Player, extra: AnimExtra = {}, dt = 1 / 60): void {
    this.root.position.set(p.pos.x, 0, p.pos.z);
    this.root.rotation.y = -p.facing;
    this.anim.update(p, extra, dt);
  }
}

/** Ring and facing arrow under a human-controlled player. */
export class ControlMarker {
  readonly root = new THREE.Group();
  private arrow: THREE.Mesh;

  constructor(color: number) {
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.7, 32), m);
    ring.rotation.x = -Math.PI / 2;
    const tri = new THREE.Shape();
    tri.moveTo(0.95, 0); tri.lineTo(0.75, 0.13); tri.lineTo(0.75, -0.13); tri.closePath();
    const tg = new THREE.ShapeGeometry(tri);
    tg.rotateX(-Math.PI / 2);
    this.arrow = new THREE.Mesh(tg, m);
    this.root.add(ring, this.arrow);
    this.root.position.y = 0.02;
    this.root.visible = false;
  }

  follow(p: Player | null): void {
    this.root.visible = !!p;
    if (!p) return;
    this.root.position.x = p.pos.x;
    this.root.position.z = p.pos.z;
    this.arrow.rotation.y = -p.facing;
  }
}

/** All player blob shadows in one draw call. */
export class ShadowLayer {
  readonly mesh: THREE.InstancedMesh;
  private m = new THREE.Matrix4();

  constructor(count: number) {
    const g = new THREE.CircleGeometry(0.42, 16);
    g.rotateX(-Math.PI / 2);
    this.mesh = new THREE.InstancedMesh(
      g,
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }),
      count,
    );
    this.mesh.frustumCulled = false;
  }

  update(players: Player[]): void {
    const on = players.filter((p) => !p.sentOff);
    this.mesh.count = on.length;
    on.forEach((p, i) => {
      this.m.makeTranslation(p.pos.x, 0.012, p.pos.z);
      this.mesh.setMatrixAt(i, this.m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
