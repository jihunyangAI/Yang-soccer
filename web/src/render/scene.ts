import * as THREE from 'three';
import { BALL_RADIUS, GOAL, PITCH } from '../sim/constants';
import type { Keeper } from '../sim/keeper';
import { GOAL_TIME, type Match } from '../sim/match';
import type { Player } from '../sim/player';
import { ControlMarker, PlayerView, ShadowLayer } from './players';
import { makeBallTexture, makePitchTexture, PITCH_PLANE } from './textures';
import { Stadium } from './crowd';

const BALL_VISUAL_SCALE = 1.7; // a real-size ball is hard to read from the broadcast camera
const P1_COLOR = 0xffe14d;
const P2_COLOR = 0x4de1ff;

const isMobile = () => window.matchMedia('(pointer: coarse)').matches || Math.min(window.innerWidth, window.innerHeight) < 500;

/**
 * Lowers the render resolution when frames run slow, raises it back when there is headroom.
 * Pixel ratio is the biggest lever on phone GPUs.
 */
class AdaptiveResolution {
  ratio: number;
  readonly max: number;
  private readonly min = 0.75;
  private frames = 0;
  private time = 0;
  private goodStreak = 0;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.max = Math.min(window.devicePixelRatio || 1, isMobile() ? 1.5 : 2);
    this.ratio = this.max;
    renderer.setPixelRatio(this.ratio);
  }

  /** Feed the real frame time; checks every 2 seconds. */
  tick(dt: number): void {
    if (dt <= 0 || dt > 0.5) return;
    this.frames++;
    this.time += dt;
    if (this.time < 2) return;
    const fps = this.frames / this.time;
    this.frames = 0;
    this.time = 0;
    if (fps < 45 && this.ratio > this.min) {
      this.set(this.ratio - 0.25);
      this.goodStreak = 0;
    } else if (fps > 57 && this.ratio < this.max) {
      if (++this.goodStreak >= 3) { this.set(this.ratio + 0.25); this.goodStreak = 0; }
    } else {
      this.goodStreak = 0;
    }
  }

  private set(r: number): void {
    this.ratio = Math.max(this.min, Math.min(this.max, r));
    this.renderer.setPixelRatio(this.ratio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}

export class GameView {
  readonly renderer: THREE.WebGLRenderer;
  readonly quality: AdaptiveResolution;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(36, 1, 0.5, 600);
  private ball: THREE.Mesh;
  private ballShadow: THREE.Mesh;
  private views: PlayerView[] = [];
  private shadows: ShadowLayer;
  private markers: [ControlMarker, ControlMarker];
  private bound: Match | null = null;
  private camX = 0;
  private camZ = 0;
  private trail: THREE.Mesh;
  private trailPts: THREE.Vector3[] = [];
  zoom = 1;
  /** Goal-celebration camera (a cut to a second angle). */
  private altCam = false;
  private altPos = new THREE.Vector3();
  private altLook = new THREE.Vector3();
  private stadium!: Stadium;
  private crowdJoy = new THREE.Vector3();

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: !isMobile() || window.devicePixelRatio < 2, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.quality = new AdaptiveResolution(this.renderer);
    container.appendChild(this.renderer.domElement);

    const sky = 0x9cc3e6;
    this.scene.background = new THREE.Color(sky);
    this.scene.fog = new THREE.Fog(sky, 140, 320);
    this.scene.add(new THREE.HemisphereLight(0xeaf3ff, 0x3b5a2e, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-30, 60, 40);
    this.scene.add(sun);

    this.buildStadium();

    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_RADIUS * BALL_VISUAL_SCALE, 20, 14),
      new THREE.MeshLambertMaterial({ map: makeBallTexture() }),
    );
    this.scene.add(this.ball);
    this.ballShadow = new THREE.Mesh(
      new THREE.CircleGeometry(BALL_RADIUS * BALL_VISUAL_SCALE * 1.1, 16),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.ballShadow.position.y = 0.015;
    this.scene.add(this.ballShadow);

    // Speed trail behind fast balls: a ribbon that tapers toward the tail.
    this.trail = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.trail.frustumCulled = false;
    this.scene.add(this.trail);

    this.shadows = new ShadowLayer(22);
    this.scene.add(this.shadows.mesh);
    this.markers = [new ControlMarker(P1_COLOR), new ControlMarker(P2_COLOR)];
    for (const mk of this.markers) this.scene.add(mk.root);

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private buildStadium(): void {
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    const pitch = new THREE.Mesh(
      new THREE.PlaneGeometry(PITCH_PLANE.halfLength * 2, PITCH_PLANE.halfWidth * 2),
      new THREE.MeshLambertMaterial({ map: makePitchTexture(maxAniso) }),
    );
    pitch.rotation.x = -Math.PI / 2;
    this.scene.add(pitch);

    const apron = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshLambertMaterial({ color: 0x25602f }),
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -0.02;
    this.scene.add(apron);

    // Advertising boards, one shared material per color.
    const boardMats = [0x1b3d8f, 0xe8e8e8, 0xc23b2e, 0x1d2330].map((c) => new THREE.MeshLambertMaterial({ color: c }));
    const boardGeo = new THREE.BoxGeometry(1, 0.9, 0.15);
    const addBoard = (x: number, z: number, len: number, rotY: number, i: number) => {
      const m = new THREE.Mesh(boardGeo, boardMats[i % boardMats.length]);
      m.scale.x = len;
      m.position.set(x, 0.45, z);
      m.rotation.y = rotY;
      this.scene.add(m);
    };
    const bz = PITCH.halfWidth + 4;
    const bx = PITCH.halfLength + 4.5;
    for (let i = 0; i < 12; i++) {
      const x = -PITCH.halfLength + 4.375 + i * 8.75;
      addBoard(x, -bz, 8.6, 0, i);
    }
    for (const s of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        const z = -PITCH.halfWidth + 6 + i * 17;
        if (Math.abs(z) < GOAL.halfWidth + 2) continue;
        addBoard(s * bx, z, 16, Math.PI / 2, i + 1);
      }
    }

    // Stands, roofs, floodlights and the crowd.
    this.stadium = new Stadium(this.scene);

    for (const s of [-1, 1]) this.scene.add(this.buildGoal(s));
  }

  private buildGoal(side: number): THREE.Group {
    const g = new THREE.Group();
    const hl = PITCH.halfLength;
    const white = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const r = GOAL.postRadius;
    const post = new THREE.CylinderGeometry(r, r, GOAL.height, 10);
    for (const z of [-GOAL.halfWidth, GOAL.halfWidth]) {
      const m = new THREE.Mesh(post, white);
      m.position.set(side * hl, GOAL.height / 2, z);
      g.add(m);
    }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(r, r, GOAL.halfWidth * 2, 10), white);
    bar.rotation.x = Math.PI / 2;
    bar.position.set(side * hl, GOAL.height, 0);
    g.add(bar);

    // Net as a line grid on back, sides and roof.
    const pts: number[] = [];
    const x0 = side * hl, x1 = side * (hl + GOAL.depth);
    const hw = GOAL.halfWidth, h = GOAL.height;
    const step = 0.25;
    const seg = (a: number[], b: number[]) => pts.push(...a, ...b);
    for (let z = -hw; z <= hw + 1e-6; z += step) { seg([x1, 0, z], [x1, h, z]); seg([x0, h, z], [x1, h, z]); }
    for (let y = 0; y <= h + 1e-6; y += step) {
      seg([x1, y, -hw], [x1, y, hw]);
      seg([x0, y, -hw], [x1, y, -hw]);
      seg([x0, y, hw], [x1, y, hw]);
    }
    for (let t = 0; t <= GOAL.depth + 1e-6; t += step) {
      const x = side * (hl + t);
      seg([x, 0, -hw], [x, h, -hw]);
      seg([x, 0, hw], [x, h, hw]);
      seg([x, h, -hw], [x, h, hw]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 })));
    return g;
  }

  /** How excited each group of fans is right now. */
  private updateCrowd(m: Match, dt: number): void {
    const j = this.crowdJoy.set(0.08, 0.1, 0.1);
    const b = m.ball.pos;
    if (m.phase === 'goal' && m.lastGoal) {
      const homeScored = m.lastGoal.team === 'home';
      j.set(0.55, homeScored ? 1 : 0, homeScored ? 0 : 1);
    } else if (m.phase === 'play') {
      // Fans of the attacking side rise as the ball nears the goal they attack.
      const near = Math.max(0, Math.min(1, (Math.abs(b.x) - 30) / 18));
      const attacker = m.dir('home') === Math.sign(b.x) ? 'home' : 'away';
      if (attacker === 'home') j.y += near * 0.55; else j.z += near * 0.55;
      j.x += near * 0.25;
    } else if (m.phase === 'fulltime') {
      const w = m.score.home - m.score.away;
      j.set(0.4, w > 0 ? 0.9 : 0.05, w < 0 ? 0.9 : 0.05);
    }
    this.stadium.update(dt, j, m.phase === 'play');
  }

  get crowdWaving(): boolean { return this.stadium.waving; }

  resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 1 ? 58 : w / h < 1.4 ? 44 : 36;
    this.camera.updateProjectionMatrix();
  }

  /** Snap the camera to the ball (used on kickoff). */
  snapCamera(m: Match): void {
    this.camX = m.ball.pos.x;
    this.camZ = m.ball.pos.z * 0.6;
  }

  private updateTrail(speed: number, held: boolean): void {
    const MAX = 14;
    if (speed > 17 && !held) {
      this.trailPts.unshift(this.ball.position.clone());
      if (this.trailPts.length > MAX) this.trailPts.pop();
    } else if (this.trailPts.length) {
      this.trailPts.pop();
    }
    const pts = this.trailPts;
    if (pts.length < 2) { this.trail.visible = false; return; }
    this.trail.visible = true;
    // Ribbon facing the camera: offset each point sideways from the view direction.
    const verts: number[] = [];
    const idx: number[] = [];
    const camPos = this.camera.position;
    const w0 = BALL_RADIUS * BALL_VISUAL_SCALE * 0.9;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], c = pts[Math.min(pts.length - 1, i + 1)];
      const dir = new THREE.Vector3().subVectors(c, a).normalize();
      const view = new THREE.Vector3().subVectors(camPos, pts[i]).normalize();
      const side = new THREE.Vector3().crossVectors(dir, view).normalize().multiplyScalar(w0 * (1 - i / pts.length));
      verts.push(pts[i].x + side.x, pts[i].y + side.y, pts[i].z + side.z, pts[i].x - side.x, pts[i].y - side.y, pts[i].z - side.z);
      if (i > 0) { const j = i * 2; idx.push(j - 2, j - 1, j, j - 1, j + 1, j); }
    }
    const geo = this.trail.geometry;
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
  }

  render(m: Match, frameDt: number): void {
    this.quality.tick(frameDt);
    const b = m.ball;
    // Ball: lift by the visual scale so the bigger mesh still sits on the grass.
    const lift = BALL_RADIUS * (BALL_VISUAL_SCALE - 1);
    this.ball.position.set(b.pos.x, b.pos.y + lift, b.pos.z);
    const hs = Math.hypot(b.vel.x, b.vel.z);
    if (hs > 0.01 && !b.held) {
      const axis = new THREE.Vector3(b.vel.z, 0, -b.vel.x).normalize();
      this.ball.rotateOnWorldAxis(axis, (hs * frameDt) / (BALL_RADIUS * BALL_VISUAL_SCALE));
    }
    this.updateTrail(Math.hypot(b.vel.x, b.vel.y, b.vel.z), b.held || b.ownerId >= 0);
    this.ballShadow.position.set(b.pos.x, 0.015, b.pos.z);
    const sh = 1 + b.pos.y * 0.25;
    this.ballShadow.scale.set(sh, sh, sh);
    (this.ballShadow.material as THREE.MeshBasicMaterial).opacity = 0.35 / sh;

    const makeView = (p: Player) => {
      const k = m.kits[p.team];
      const crest = m.teams[p.team].crest;
      // Badge fill uses the trim colour so it stands out from the shirt.
      const badge: [number, number] = [crest.colors[2], crest.colors[0] === k.shirt ? crest.colors[1] === k.shirt ? 0x111111 : crest.colors[1] : crest.colors[0]];
      const kit = p.role === 'gk' ? { shirt: k.gk, shorts: 0x1d2330, socks: k.gk, trim: 0x1d2330, badge } : { ...k, badge };
      const v = new PlayerView(kit, p);
      this.scene.add(v.root);
      return v;
    };
    if (this.bound !== m) {
      // New match: rebuild the players in this match's kits.
      for (const v of this.views) { this.scene.remove(v.root); v.dispose(); }
      this.views = m.players.map(makeView);
      this.bound = m;
      // Fans wear their club colours.
      this.stadium.populate({ home: m.teams.home.kit.shirt, away: m.teams.away.kit.shirt }, m.config.seed);
    }
    const keeperOf = new Map<number, Keeper>([[m.keepers.home.p.id, m.keepers.home], [m.keepers.away.p.id, m.keepers.away]]);
    m.players.forEach((p, i) => {
      if (this.views[i].version !== p.version) {
        // A substitute came on: new face, new number.
        this.scene.remove(this.views[i].root);
        this.views[i].dispose();
        this.views[i] = makeView(p);
      }
      this.views[i].root.visible = !p.sentOff;
      // Detailed faces only when the camera is close enough to see them.
      const cp = this.camera.position;
      this.views[i].setDetail(Math.hypot(cp.x - p.pos.x, cp.y - 1.6, cp.z - p.pos.z) < 11);
      if (p.sentOff) return;
      const k = keeperOf.get(p.id);
      this.views[i].update(p, k ? {
        dive: k.state === 'dive' || k.state === 'down' ? (k.diveVel.z || 1) : 0,
        hold: k.state === 'hold',
        ball: m.ball,
      } : { ball: m.ball }, frameDt);
    });
    this.shadows.update(m.players);
    const showRing = m.phase !== 'goal';
    this.markers[0].follow(showRing && m.isHuman('home') ? m.players[m.ctrl.home] : null);
    this.markers[1].follow(showRing && m.isHuman('away') ? m.players[m.ctrl.away] : null);

    const aspect = this.camera.aspect;
    // Phones in landscape are short: move the camera closer so players stay readable.
    const short = window.innerHeight < 500 ? 0.78 : 1;
    const dist = (aspect < 1 ? 1.25 : short) * this.zoom;

    // Goal celebration: like a TV director, cut (no zoom) to a second, diagonal angle from
    // the near touchline that frames the scorer, then cut back for the kickoff.
    const celebrating = m.phase === 'goal' && m.lastGoal !== null && m.phaseTimer < GOAL_TIME - 0.8;
    if (celebrating) {
      const s = m.players[m.lastGoal!.scorerId].pos;
      const side = Math.sign(s.x) || 1;
      const look = new THREE.Vector3(s.x, 0.8, s.z);
      // Diagonal from the open near touchline toward the scorer, with the goal end behind them;
      // stays inside the bowl (the end stands have roofs) at about broadcast distance.
      const pos = look.clone().add(new THREE.Vector3(-side * 14, 20, 26).multiplyScalar(dist));
      if (!this.altCam) {
        // Hard cut on the first frame.
        this.altPos.copy(pos);
        this.altLook.copy(look);
        this.altCam = true;
      } else {
        const k = 1 - Math.exp(-2 * frameDt);
        this.altPos.lerp(pos, k);
        this.altLook.lerp(look, k);
      }
      this.camera.position.copy(this.altPos);
      this.camera.lookAt(this.altLook);
    } else {
      if (this.altCam) {
        // Cut back to the broadcast camera, already framing the ball.
        this.altCam = false;
        this.snapCamera(m);
      }
      // Broadcast camera on the near sideline, following the ball.
      const tx = Math.max(-PITCH.halfLength + 14, Math.min(PITCH.halfLength - 14, b.pos.x));
      const tz = b.pos.z * 0.6;
      const k1 = 1 - Math.exp(-2.5 * frameDt);
      this.camX += (tx - this.camX) * k1;
      this.camZ += (tz - this.camZ) * k1;
      this.camera.position.set(this.camX, 26 * dist, this.camZ + 44 * dist);
      this.camera.lookAt(this.camX, 0, this.camZ);
    }

    this.updateCrowd(m, frameDt);
    this.renderer.render(this.scene, this.camera);
  }
}
