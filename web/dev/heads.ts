// Dev-only close-up of player heads: /dev/heads.html  (?view=side|back|body, &n=count)
import * as THREE from 'three';
import { PlayerView } from '../src/render/players';
import type { Look, Player } from '../src/sim/player';

const q = new URLSearchParams(location.search);
const view = q.get('view') ?? 'front';
const count = Number(q.get('n') ?? 6);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb7d9);
scene.add(new THREE.HemisphereLight(0xeaf3ff, 0x3b5a2e, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(30, 60, 20);
scene.add(sun);

const SKINS = [0xf1c7a5, 0xe0ac86, 0xc98d64, 0x9a6440, 0x6b4428, 0xe0ac86, 0xf1c7a5, 0xc98d64];
const HAIRS = [0x2a1d14, 0x111111, 0x4a2f1c, 0x1d1510, 0x111111, 0x8a5a2b, 0xc9a35a, 0x2a1d14];
const EYES = [0x4a2f1c, 0x3d6fa8, 0x2e1c10, 0x4a2f1c, 0x2e1c10, 0x4f7a43, 0x3d6fa8, 0x6b4a2a];
const kit = { shirt: 0x2346c8, shorts: 0xf2f2f2, socks: 0x2346c8, trim: 0xffffff, badge: [0xffffff, 0xf6c21c] as [number, number] };
const gap = 0.32;
for (let i = 0; i < count; i++) {
  const look: Look = { skin: SKINS[i % 8], hair: HAIRS[i % 8], style: ([0, 1, 2, 3, 0, 2, 3, 1] as const)[i % 8], eye: EYES[i % 8] };
  const p = { look, number: i + 2, role: 'mf', version: 0 } as unknown as Player;
  const v = new PlayerView(kit, p);
  v.setDetail(true);
  v.root.position.z = (i - (count - 1) / 2) * (view === 'body' ? 0.9 : gap);
  scene.add(v.root);
}
const camera = new THREE.PerspectiveCamera(view === 'body' ? 30 : 22, innerWidth / innerHeight, 0.05, 100);
const target = new THREE.Vector3(0, view === 'body' ? 0.95 : 1.69, 0);
const dist = view === 'body' ? 4 + count * 0.6 : 0.6 + count * 0.24;
const dir = view === 'side' ? new THREE.Vector3(0.5, 0.1, 1) : view === 'back' ? new THREE.Vector3(-1, 0.25, 0.2) : new THREE.Vector3(1, 0.06, 0.05);
camera.position.copy(target).addScaledVector(dir.normalize(), dist);
camera.lookAt(target);
const tick = () => { renderer.render(scene, camera); requestAnimationFrame(tick); };
tick();
