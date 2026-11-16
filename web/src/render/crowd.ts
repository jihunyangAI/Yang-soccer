import * as THREE from 'three';
import { PITCH } from '../sim/constants';
import { createRng } from '../sim/rng';

/**
 * Stadium bowl: stepped stands, roofs, floodlight towers, and about ten thousand spectators.
 * Spectators are camera-facing sprites in one instanced draw call; all of their motion
 * (swaying, standing, jumping, waving, the Mexican wave) runs in the vertex shader.
 */

const ROW_RUN = 0.8;   // depth of one row of seats
const ROW_RISE = 0.42; // height gained per row
const SEAT = 0.62;     // seat width

/** Sprite masks: red = shirt, green = skin, blue = dark (hair, trousers). Two frames: arms down / arms up. */
function spectatorSprite(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d')!;
  const frame = (ox: number, armsUp: boolean) => {
    // Trousers / seat shadow.
    g.fillStyle = '#0000ff';
    g.fillRect(ox + 18, 96, 28, 32);
    // Torso.
    g.fillStyle = '#ff0000';
    g.beginPath();
    g.moveTo(ox + 14, 100);
    g.lineTo(ox + 16, 60);
    g.quadraticCurveTo(ox + 32, 50, ox + 48, 60);
    g.lineTo(ox + 50, 100);
    g.closePath();
    g.fill();
    // Arms.
    if (armsUp) {
      g.fillRect(ox + 8, 26, 9, 40);
      g.fillRect(ox + 47, 26, 9, 40);
      g.fillStyle = '#00ff00';
      g.beginPath(); g.arc(ox + 12.5, 22, 6, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(ox + 51.5, 22, 6, 0, Math.PI * 2); g.fill();
    } else {
      g.fillRect(ox + 9, 62, 9, 34);
      g.fillRect(ox + 46, 62, 9, 34);
      g.fillStyle = '#00ff00';
      g.beginPath(); g.arc(ox + 13.5, 99, 5, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(ox + 50.5, 99, 5, 0, Math.PI * 2); g.fill();
    }
    // Neck and head, hair on top.
    g.fillStyle = '#00ff00';
    g.fillRect(ox + 27, 48, 10, 8);
    g.beginPath(); g.ellipse(ox + 32, 38, 12, 14, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#0000ff';
    g.beginPath(); g.ellipse(ox + 32, 31, 12.5, 8.5, 0, Math.PI, 0); g.fill();
  };
  g.clearRect(0, 0, 128, 128);
  frame(0, false);
  frame(64, true);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace; // masks, not colours
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

const VERT = /* glsl */ `
  attribute vec3 aSkin;
  attribute float aSeed;
  attribute float aFan;   // 0 neutral, 1 home, 2 away
  attribute float aPath;  // distance around the bowl, for the wave
  uniform float uTime;
  uniform vec3 uJoy;      // excitement for neutral, home and away fans
  uniform float uWave;
  uniform float uWaveOn;
  varying vec2 vUv;
  varying vec3 vShirt;
  varying vec3 vSkin;
  varying float vShade;
  #include <fog_pars_vertex>
  void main() {
    float joy = aFan < 0.5 ? uJoy.x : (aFan < 1.5 ? uJoy.y : uJoy.z);
    float wave = smoothstep(7.0, 0.0, abs(aPath - uWave)) * uWaveOn;
    // Each fan has their own threshold, so a stand rises raggedly, not in lockstep.
    float eager = fract(aSeed * 13.17);
    float up = max(smoothstep(eager * 0.6, eager * 0.6 + 0.25, joy), wave);
    float sway = sin(uTime * (1.1 + eager) + aSeed * 40.0) * 0.02;
    float jump = abs(sin(uTime * (5.5 + eager * 2.0) + aSeed * 30.0)) * 0.22 * smoothstep(0.6, 1.0, joy);
    float rise = up * 0.3 + jump + sway;

    vec4 center = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec3 toCam = cameraPosition - center.xyz;
    toCam.y = 0.0;
    toCam = normalize(toCam);
    vec3 right = vec3(toCam.z, 0.0, -toCam.x);
    float s = 0.9 + 0.2 * fract(aSeed * 3.71);
    vec3 world = center.xyz + right * position.x * s + vec3(0.0, position.y * s + rise, 0.0);

    // Arms-up frame for standing, celebrating fans; waving arms flick between frames.
    float armsUp = step(0.55, up) * step(0.35, fract(aSeed * 5.3 + uTime * (up > 0.9 ? 1.6 : 0.0)));
    vUv = vec2(uv.x * 0.5 + armsUp * 0.5, uv.y);
    vShirt = instanceColor;
    vSkin = aSkin;
    vShade = 0.78 + 0.22 * fract(aSeed * 9.1);
    vec4 mvPosition = viewMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D map;
  varying vec2 vUv;
  varying vec3 vShirt;
  varying vec3 vSkin;
  varying float vShade;
  #include <fog_pars_fragment>
  void main() {
    vec4 t = texture2D(map, vUv);
    if (t.a < 0.4) discard;
    vec3 col = vShirt * t.r + vSkin * t.g + vec3(0.06, 0.055, 0.06) * t.b;
    gl_FragColor = vec4(col * vShade, 1.0);
    #include <fog_fragment>
    #include <colorspace_fragment>
  }
`;

interface StandDef {
  /** Where the front row starts and which way the rows climb. */
  origin: THREE.Vector3;
  along: THREE.Vector3;
  back: THREE.Vector3;
  length: number;
  rows: number;
  pathStart: number;
}

export interface CrowdColors { home: number; away: number }

export class Stadium {
  readonly group = new THREE.Group();
  private crowd: THREE.InstancedMesh | null = null;
  private material: THREE.ShaderMaterial;
  private stands: StandDef[];
  private pathLength = 0;
  private waveX = -999;
  private waveTimer = 40;
  private time = 0;
  private joy = new THREE.Vector3(0.1, 0.1, 0.1);

  constructor(scene: THREE.Scene) {
    const hl = PITCH.halfLength, hw = PITCH.halfWidth;
    const far = { origin: new THREE.Vector3(-72, 1.1, -(hw + 8)), along: new THREE.Vector3(1, 0, 0), back: new THREE.Vector3(0, 0, -1), length: 144, rows: 26, pathStart: 0 };
    const right = { origin: new THREE.Vector3(hl + 9, 1.1, -(hw + 4)), along: new THREE.Vector3(0, 0, 1), back: new THREE.Vector3(1, 0, 0), length: 2 * hw + 8, rows: 22, pathStart: 144 };
    const left = { origin: new THREE.Vector3(-(hl + 9), 1.1, hw + 4), along: new THREE.Vector3(0, 0, -1), back: new THREE.Vector3(-1, 0, 0), length: 2 * hw + 8, rows: 22, pathStart: -(2 * hw + 8) };
    this.stands = [left, far, right];
    this.pathLength = 144 + 2 * (2 * hw + 8);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { map: { value: null }, uTime: { value: 0 }, uJoy: { value: new THREE.Vector3() }, uWave: { value: -999 }, uWaveOn: { value: 0 } },
      ]),
      fog: true,
    });
    this.material.uniforms.map.value = spectatorSprite();

    for (const s of this.stands) this.group.add(this.buildStand(s));
    this.buildFloodlights();
    scene.add(this.group);
  }

  /** Concrete terracing with seat rows, a back wall and a roof on columns. */
  private buildStand(s: StandDef): THREE.Group {
    const g = new THREE.Group();
    const steps = new THREE.Shape();
    steps.moveTo(0, 0);
    for (let r = 0; r < s.rows; r++) {
      steps.lineTo(r * ROW_RUN, (r + 1) * ROW_RISE);
      steps.lineTo((r + 1) * ROW_RUN, (r + 1) * ROW_RISE);
    }
    steps.lineTo(s.rows * ROW_RUN, 0);
    steps.closePath();
    const geo = new THREE.ExtrudeGeometry(steps, { depth: s.length, bevelEnabled: false });
    // Shape x → back, shape y → up, extrude z → along the stand.
    const basis = new THREE.Matrix4().makeBasis(s.back, new THREE.Vector3(0, 1, 0), s.along);
    geo.applyMatrix4(basis);
    geo.translate(s.origin.x, s.origin.y - 1.1, s.origin.z);
    g.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x5b6270 })));

    // Seat rows: a coloured strip on every tread.
    const seatGeo = new THREE.BoxGeometry(0.35, 0.28, s.length);
    const seatMat = new THREE.MeshLambertMaterial({ color: 0x23397a });
    const seats = new THREE.InstancedMesh(seatGeo, seatMat, s.rows);
    const m = new THREE.Matrix4();
    for (let r = 0; r < s.rows; r++) {
      const p = s.origin.clone()
        .addScaledVector(s.back, r * ROW_RUN + 0.55)
        .addScaledVector(s.along, s.length / 2);
      p.y = s.origin.y - 1.1 + (r + 1) * ROW_RISE + 0.14;
      m.makeBasis(s.back, new THREE.Vector3(0, 1, 0), s.along).setPosition(p);
      seats.setMatrixAt(r, m);
    }
    g.add(seats);

    // Back wall and roof.
    const depth = s.rows * ROW_RUN, top = s.origin.y - 1.1 + s.rows * ROW_RISE;
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x3a4152 });
    const mid = s.origin.clone().addScaledVector(s.along, s.length / 2);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.6, 6, s.length), wallMat);
    wall.position.copy(mid).addScaledVector(s.back, depth + 0.3);
    wall.position.y = top + 2;
    wall.lookAt(wall.position.clone().add(s.back));
    wall.rotateY(Math.PI / 2);
    g.add(wall);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(depth + 6, 0.5, s.length + 2), new THREE.MeshLambertMaterial({ color: 0xd8dde4, emissive: 0x3a414c }));
    roof.position.copy(mid).addScaledVector(s.back, depth / 2 - 1);
    roof.position.y = top + 6.5;
    roof.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(s.back, new THREE.Vector3(0, 1, 0), s.along));
    roof.rotateZ(-0.08);
    g.add(roof);
    // Columns along the back.
    const colGeo = new THREE.CylinderGeometry(0.25, 0.25, 8, 8);
    for (let t = 6; t < s.length; t += 18) {
      const c = new THREE.Mesh(colGeo, wallMat);
      c.position.copy(s.origin).addScaledVector(s.along, t).addScaledVector(s.back, depth + 0.2);
      c.position.y = top + 2.5;
      g.add(c);
    }
    return g;
  }

  private buildFloodlights(): void {
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x8a919c });
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xfffbe8 });
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const x = sx * (PITCH.halfLength + 22), z = sz * (PITCH.halfWidth + 26);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.7, 40, 8), poleMat);
        pole.position.set(x, 20, z);
        const head = new THREE.Mesh(new THREE.BoxGeometry(7, 4, 0.6), lampMat);
        head.position.set(x, 41, z);
        head.lookAt(0, 0, 0);
        this.group.add(pole, head);
      }
    }
  }

  /** Fill the stands with fans in the two clubs' colours (away fans behind one goal). */
  populate(colors: CrowdColors, seed: number): void {
    if (this.crowd) { this.group.remove(this.crowd); this.crowd.geometry.dispose(); this.crowd.dispose(); }
    const rng = createRng(seed);
    type Fan = { pos: THREE.Vector3; fan: number; path: number };
    const fans: Fan[] = [];
    for (const s of this.stands) {
      for (let r = 0; r < s.rows; r++) {
        for (let a = 0.4; a < s.length - 0.3; a += SEAT) {
          if (rng() < 0.06) continue; // a few empty seats
          // Gangway every 18 m.
          if (a % 18 < SEAT * 1.2) continue;
          const pos = s.origin.clone()
            .addScaledVector(s.along, a + (rng() - 0.5) * 0.12)
            .addScaledVector(s.back, r * ROW_RUN + 0.3);
          pos.y = s.origin.y - 1.1 + (r + 1) * ROW_RISE + 0.05;
          const path = s.pathStart + (s === this.stands[0] ? s.length - a : a);
          // Away section: one corner of the right-hand end.
          const awaySection = s === this.stands[2] && a > s.length * 0.55;
          const pick = rng();
          const fan = awaySection ? (pick < 0.85 ? 2 : 0) : pick < 0.7 ? 1 : pick < 0.78 ? 2 : 0;
          fans.push({ pos, fan, path });
        }
      }
    }
    const geo = new THREE.PlaneGeometry(0.62, 0.95).translate(0, 0.475, 0);
    const n = fans.length;
    const skin = new Float32Array(n * 3), seedA = new Float32Array(n), fanA = new Float32Array(n), pathA = new Float32Array(n);
    const skins = [0xf1c7a5, 0xe0ac86, 0xc98d64, 0x9a6440, 0x6b4428].map((h) => new THREE.Color(h));
    const neutrals = [0xe8e8e8, 0x2b2f3a, 0x6b7280, 0x1e3a8a, 0x7f1d1d, 0xd6c7a1].map((h) => new THREE.Color(h));
    const home = new THREE.Color(colors.home), away = new THREE.Color(colors.away);
    const mesh = new THREE.InstancedMesh(geo, this.material, n);
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    fans.forEach((f, i) => {
      m.makeTranslation(f.pos.x, f.pos.y, f.pos.z);
      mesh.setMatrixAt(i, m);
      if (f.fan === 1) c.copy(home).multiplyScalar(0.85 + rng() * 0.3);
      else if (f.fan === 2) c.copy(away).multiplyScalar(0.85 + rng() * 0.3);
      else c.copy(neutrals[(rng() * neutrals.length) | 0]);
      mesh.setColorAt(i, c);
      const sk = skins[(rng() * skins.length) | 0];
      skin[i * 3] = sk.r; skin[i * 3 + 1] = sk.g; skin[i * 3 + 2] = sk.b;
      seedA[i] = rng();
      fanA[i] = f.fan;
      pathA[i] = f.path;
    });
    geo.setAttribute('aSkin', new THREE.InstancedBufferAttribute(skin, 3));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seedA, 1));
    geo.setAttribute('aFan', new THREE.InstancedBufferAttribute(fanA, 1));
    geo.setAttribute('aPath', new THREE.InstancedBufferAttribute(pathA, 1));
    mesh.frustumCulled = false;
    this.crowd = mesh;
    this.group.add(mesh);
  }

  get count(): number { return this.crowd?.count ?? 0; }

  /**
   * Drive the crowd. `joy` = target excitement for neutral, home and away fans (0 seated … 1 going wild).
   * `allowWave` lets a Mexican wave start now and then during quiet play.
   */
  update(dt: number, joy: THREE.Vector3, allowWave: boolean): void {
    this.time += dt;
    const k = 1 - Math.exp(-dt * 3);
    this.joy.lerp(joy, k);
    const u = this.material.uniforms;
    u.uTime.value = this.time;
    u.uJoy.value.copy(this.joy);

    // Mexican wave: starts at random, travels round the bowl at ~22 m/s.
    if (this.waveX > -900) {
      this.waveX += dt * 22;
      if (this.waveX > this.pathLength) this.waveX = -999;
    } else if (allowWave) {
      this.waveTimer -= dt;
      if (this.waveTimer <= 0) { this.waveX = this.stands[0].pathStart; this.waveTimer = 60 + Math.random() * 60; }
    }
    u.uWave.value = this.waveX;
    u.uWaveOn.value = this.waveX > -900 ? 1 : 0;
  }

  /** True while a wave is going round (the sound layer cheers along). */
  get waving(): boolean { return this.waveX > -900; }
}

