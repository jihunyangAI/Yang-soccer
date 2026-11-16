// Dev-only film strip of an animation: /dev/anim.html?s=jog
//   s     jog | sprint | walk | back | side | idle | dribble | shoot | pass | start | stop | turn | keeper
//   n     frames (default 8)      step  seconds between frames (default 0.05)
//   t0    time of the first frame gap   metres between frames (default 0.9; 0 = true positions)
//   view  side | front | q (three-quarter)
import * as THREE from 'three';
import { PlayerView } from '../src/render/players';
import { createBall, stepBall } from '../src/sim/ball';
import { createPlayer, dribble, movePlayer, tickTimers, FOLLOW_THROUGH } from '../src/sim/player';

const q = new URLSearchParams(location.search);
const script = q.get('s') ?? 'jog';
const n = Number(q.get('n') ?? 8), step = Number(q.get('step') ?? 0.05), t0 = Number(q.get('t0') ?? 1.2);
const gap = Number(q.get('gap') ?? 0.9), view = q.get('view') ?? 'side';

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb7d9);
scene.add(new THREE.HemisphereLight(0xeaf3ff, 0x3b5a2e, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-30, 60, 40);
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshLambertMaterial({ color: 0x3f8f45 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const kit = { shirt: 0x2346c8, shorts: 0xf2f2f2, socks: 0x2346c8, trim: 0xffffff, badge: [0xffffff, 0xf6c21c] as [number, number] };
const DT = 1 / 60;
const frames: THREE.Object3D[] = [];
let cx = 0, cz = 0;

for (let i = 0; i < n; i++) {
  // Each frame replays the script from the start, so the animator's smoothing state is honest.
  const p = createPlayer(1, 'home', script === 'keeper' || script === 'dive' ? 'gk' : 'field', { x: 0, z: 0 }, 9, { speed: 80, dribble: 80, pass: 80, shoot: 80, defense: 80, stamina: 80 });
  p.look = { skin: 0xe0ac86, hair: 0x2a1d14, style: 0, eye: 0x4a2f1c };
  const b = createBall();
  b.pos.x = 0.45;
  const v = new PlayerView(kit, p);
  v.setDetail(true);
  const T = t0 + i * step;
  for (let t = 0; t < T; t += DT) {
    tickTimers(p, DT);
    let ix = 0, iz = 0, sprint = false, own = false;
    switch (script) {
      case 'jog': ix = 1; break;
      case 'sprint': ix = 1; sprint = true; break;
      case 'walk': ix = 0.3; break;
      case 'idle': break;
      case 'stand': own = true; ix = t > 1.6 ? 1 : 0; break;
      case 'keeper': iz = t > 1 ? 0.4 : 0; break;
      case 'back': ix = -0.6; break;
      case 'side': iz = 0.6; break;
      case 'start': ix = t > 1 ? 1 : 0; sprint = true; break;
      case 'stop': ix = t < 1.3 ? 1 : 0; sprint = true; break;
      case 'turn': { const a = Math.max(0, t - 1) * 2.2; ix = Math.cos(a); iz = Math.sin(a); break; }
      case 'dribble': ix = 1; own = true; break;
      case 'dribblesprint': ix = 1; sprint = true; own = true; break;
      case 'tackle': ix = 1; if (t >= 1.25 && t < 1.25 + DT) p.tackleAnim = 0.35; break;
      case 'dive': break;
      case 'kneel': ix = t < 1.25 ? 1 : 0; if (t >= 1.25) { p.celebrate = 1; p.celebPose = 2; } break;
      case 'jump': if (t >= 1.25) { p.celebrate = 1; p.celebPose = 0; } break;
      case 'shoot': case 'pass': case 'lob': ix = t < 1.25 ? 0.8 : 0.2; own = b.ownerId !== -2; break;
    }
    movePlayer(p, ix, iz, sprint, own, DT);
    if (script === 'back' || script === 'side' || script === 'keeper') p.facing = 0; // keep facing +x while moving another way
    if (own && b.ownerId !== -2) { b.ownerId = p.id; dribble(p, b, DT); }
    if (script === 'shoot' || script === 'pass' || script === 'lob') {
      const kind = script as 'shoot' | 'pass' | 'lob';
      const wind = kind === 'shoot' ? 0.16 : 0.1;
      if (t >= 1.25 && t < 1.25 + DT) { p.windT = wind; p.windMax = wind; p.windKind = kind; p.windFire = () => {}; p.kickFoot = 1; }
      if (p.windFire) {
        p.windT -= DT;
        if (p.windT <= 0) {
          p.windFire = null; p.windT = 0; p.kickKind = kind; p.kickAnim = FOLLOW_THROUGH;
          const sp = kind === 'shoot' ? 28 : 14;
          b.vel.x = sp; b.vel.y = kind === 'lob' ? 7 : kind === 'shoot' ? 3 : 0; b.ownerId = -2;
        }
      }
    }
    stepBall(b, DT);
    v.update(p, { ball: b, dive: script === 'dive' && t > 1.25 ? 1 : 0 }, DT);
  }
  // Lay the frames out left to right (or leave them where they really are when gap = 0).
  const holder = new THREE.Group();
  if (gap) holder.position.set(view === 'front' ? -p.pos.x : i * gap - p.pos.x, 0, view === 'front' ? -i * gap - p.pos.z : -p.pos.z);
  holder.add(v.root);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.187, 16, 12), new THREE.MeshLambertMaterial({ color: 0xffffff }));
  ball.position.set(b.pos.x, b.pos.y + 0.077, b.pos.z);
  if (Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z) < 3) holder.add(ball);
  scene.add(holder);
  frames.push(holder);
  cx += (p.pos.x + holder.position.x) / n; cz += (p.pos.z + holder.position.z) / n;
}

const span = gap ? n * gap : 6;
const aspect = innerWidth / innerHeight;
const halfW = Math.max(span / 2 + 0.6, 1.3 * aspect);
const camera = new THREE.OrthographicCamera(-halfW, halfW, halfW / aspect, -halfW / aspect, 0.1, 200);
const target = new THREE.Vector3(cx, 0.95, cz);
const dir = view === 'front' ? new THREE.Vector3(1, 0.05, 0.001) : view === 'q' ? new THREE.Vector3(0.6, 0.25, 1) : new THREE.Vector3(0, 0.04, 1);
camera.position.copy(target).addScaledVector(dir.normalize(), 30);
camera.lookAt(target);
renderer.render(scene, camera);
