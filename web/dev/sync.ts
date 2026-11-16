// Dev-only measurement of how well feet and ball meet: /dev/sync.html
// Runs scripted dribbles and whole AI matches with the real animator, and at every dribble
// touch, first touch and kick measures the gap between the boot that plays the ball and the
// surface of the ball as drawn. Results go to window.__sync and onto the page.
//   0 m      the boot touches the ball
//   > 0      the boot is short of the ball (the ball moves "by itself")
//   < 0      the boot is inside the ball
import * as THREE from 'three';
import { PlayerView } from '../src/render/players';
import { B } from '../src/render/skeleton';
import { createBall, stepBall, type Ball } from '../src/sim/ball';
import { Match } from '../src/sim/match';
import { createPlayer, dribble, FOLLOW_THROUGH, kickSpot, movePlayer, swingingFoot, tickTimers, type Player } from '../src/sim/player';
import { TEAMS } from '../src/sim/team';

const DT = 1 / 60;
/** The ball as drawn (see scene.ts): bigger than the simulated one and lifted to sit on the grass. */
const BALL_R = 0.187, BALL_LIFT = 0.077;
/** The boot as a capsule in the ankle bone's frame (see players.ts). */
const BOOT_A = new THREE.Vector3(-0.04, -0.03, 0), BOOT_B = new THREE.Vector3(0.13, -0.03, 0), BOOT_R = 0.05;
const kit = { shirt: 0x2346c8, shorts: 0xf2f2f2, socks: 0x2346c8, trim: 0xffffff, badge: [0xffffff, 0xf6c21c] as [number, number] };

const A = new THREE.Vector3(), Bv = new THREE.Vector3(), C = new THREE.Vector3(), AB = new THREE.Vector3();
type Bones = { b: THREE.Bone[] };

/** Gap between a boot and the drawn ball surface (negative = overlapping). */
function bootGap(v: PlayerView, side: -1 | 1, ball: Ball): number {
  const bone = (v as unknown as Bones).b[side < 0 ? B.AnkleL : B.AnkleR];
  A.copy(BOOT_A).applyMatrix4(bone.matrixWorld);
  Bv.copy(BOOT_B).applyMatrix4(bone.matrixWorld);
  C.set(ball.pos.x, ball.pos.y + BALL_LIFT, ball.pos.z);
  AB.subVectors(Bv, A);
  const t = THREE.MathUtils.clamp(C.clone().sub(A).dot(AB) / AB.lengthSq(), 0, 1);
  return A.addScaledVector(AB, t).distanceTo(C) - BOOT_R - BALL_R;
}

interface Sample { kind: 'dribble' | 'first' | 'kick'; at: number; best: number; lag: number; note: string }
interface Pending { kind: Sample['kind']; side: -1 | 1; view: PlayerView; left: number; at: number; best: number; lag: number; note: string; pre: number[] }

class Recorder {
  samples: Sample[] = [];
  /** Deepest overlap of any boot with the ball while nobody is playing it. */
  overlap = 0;
  overlapTicks = 0;
  ticks = 0;
  private pending: Pending[] = [];
  private history = new Map<PlayerView, { l: number[]; r: number[] }>();

  /** Call every tick after the views were posed. */
  track(views: PlayerView[], ball: Ball, near: (v: PlayerView, i: number) => boolean): void {
    this.ticks++;
    views.forEach((v, i) => {
      if (!near(v, i)) { this.history.delete(v); return; }
      v.root.updateMatrixWorld(true);
      const h = this.history.get(v) ?? { l: [], r: [] };
      h.l.push(bootGap(v, -1, ball)); h.r.push(bootGap(v, 1, ball));
      if (h.l.length > 4) { h.l.shift(); h.r.shift(); }
      this.history.set(v, h);
      const deep = Math.min(h.l[h.l.length - 1], h.r[h.r.length - 1]);
      if (deep < -0.06) { this.overlapTicks++; this.overlap = Math.min(this.overlap, deep); }
    });
    for (const p of this.pending) {
      const h = this.history.get(p.view);
      if (h) {
        const g = (p.side < 0 ? h.l : h.r)[h.l.length - 1];
        const frame = PENDING_FRAMES - p.left + 1; // frames after the touch
        if (Math.abs(g) < Math.abs(p.best)) { p.best = g; p.lag = frame; }
      }
      p.left--;
    }
    for (const p of this.pending.filter((x) => x.left <= 0)) this.samples.push({ kind: p.kind, at: p.at, best: p.best, lag: p.lag, note: p.note });
    this.pending = this.pending.filter((x) => x.left > 0);
  }

  /** A foot played the ball this tick: judge it by the closest the boot gets within ±3 frames. */
  event(kind: Sample['kind'], view: PlayerView, side: -1 | 1, note = ''): void {
    const h = this.history.get(view);
    const pre = h ? (side < 0 ? h.l : h.r).slice() : [];
    const at = pre.length ? pre[pre.length - 1] : 9;
    let best = 9, lag = 0;
    pre.forEach((g, i) => { if (Math.abs(g) < Math.abs(best)) { best = g; lag = i - (pre.length - 1); } });
    this.pending.push({ kind, side, view, left: PENDING_FRAMES, at, best, lag, note, pre });
  }
}
const PENDING_FRAMES = 3;

const pct = (xs: number[], q: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] : NaN);
function summary(samples: Sample[], kind: Sample['kind']) {
  const s = samples.filter((x) => x.kind === kind);
  const best = s.map((x) => x.best), at = s.map((x) => x.at);
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return {
    n: s.length,
    // closest approach within ±3 frames of the touch
    medianGap: r(pct(best, 0.5)), p90Gap: r(pct(best, 0.9)), worstGap: r(Math.max(...best, -9)), deepest: r(Math.min(...best, 9)),
    // share of touches where the boot visibly reaches the ball (within 4 cm) / clearly misses (over 10 cm)
    clean: r(s.filter((x) => Math.abs(x.best) <= 0.04).length / Math.max(1, s.length)),
    missed: r(s.filter((x) => x.best > 0.1).length / Math.max(1, s.length)),
    through: r(s.filter((x) => x.best < -0.08).length / Math.max(1, s.length)),
    // the gap on the very frame the ball changes speed
    medianAtFrame: r(pct(at, 0.5)), p90AtFrame: r(pct(at, 0.9)),
  };
}

const debug = new URLSearchParams(location.search).get('debug');
const debugLog: string[] = [];
const lateLog: string[][] = [];
// ---------------------------------------------------------------- scripted dribbles
type Input = (t: number) => { ix: number; iz: number; sprint: boolean };
const dir = (a: number, sprint = false, m = 1) => ({ ix: Math.cos(a) * m, iz: Math.sin(a) * m, sprint });
const SCRIPTS: Record<string, Input> = {
  jog: () => dir(0),
  'jog-diagonal': () => dir(1),
  sprint: () => dir(0, true),
  'jog-sprint': (t) => dir(0, Math.floor(t / 1.5) % 2 === 1),
  curve: (t) => dir(t * 0.6),
  'curve-sprint': (t) => dir(t * 0.5, true),
  zigzag: (t) => dir((Math.floor(t / 1.2) % 2 ? 1 : -1) * 0.6),
  'zigzag-sprint': (t) => dir((Math.floor(t / 1.2) % 2 ? 1 : -1) * 0.6, true),
  'cut-90': (t) => dir(Math.floor(t / 2) * (Math.PI / 2)),
  'turn-180': (t) => dir(Math.floor(t / 2.5) * Math.PI),
  'stop-go': (t) => (t % 2 > 1.4 ? { ix: 0, iz: 0, sprint: false } : dir(0)),
  slow: () => dir(0, false, 0.45),
};

function runScript(name: string, skill: number, seconds = 14) {
  const p = createPlayer(1, 'home', 'field', { x: 0, z: 0 }, 9, { speed: 80, dribble: skill, pass: 80, shoot: 80, defense: 80, stamina: 80 });
  p.look = { skin: 0xe0ac86, hair: 0x2a1d14, style: 0, eye: 0x4a2f1c };
  const b = createBall();
  b.pos.x = 0.45; b.ownerId = p.id;
  const v = new PlayerView(kit, p);
  const rec = new Recorder();
  let lost = 0, maxAhead = 0;
  const log: string[] = [];
  let lastLog = -9;
  for (let t = 0; t < seconds; t += DT) {
    tickTimers(p, DT);
    const i = SCRIPTS[name](t);
    movePlayer(p, i.ix, i.iz, i.sprint, true, DT);
    // Keep the run on the pitch model's open ground.
    if (Math.abs(p.pos.x) > 50 || Math.abs(p.pos.z) > 30) { b.pos.x -= p.pos.x; b.pos.z -= p.pos.z; p.pos.x = 0; p.pos.z = 0; }
    const pre = { fx: Math.cos(p.facing), fz: Math.sin(p.facing), dx: b.pos.x - p.pos.x, dz: b.pos.z - p.pos.z, foot: swingingFoot(p), relx: b.vel.x - p.vel.x, relz: b.vel.z - p.vel.z, sp: Math.hypot(p.vel.x, p.vel.z) };
    const touched = dribble(p, b, DT);
    stepBall(b, DT);
    v.update(p, { ball: b }, DT);
    if (touched && t > 1) rec.event('dribble', v, p.touchFoot, name);
    if (touched && t > 1 && debug === name && log.length < 40) {
      const ahead = pre.dx * pre.fx + pre.dz * pre.fz, side = -pre.dx * pre.fz + pre.dz * pre.fx;
      v.root.updateMatrixWorld(true);
      const an = (v as unknown as Bones).b[p.touchFoot < 0 ? B.AnkleL : B.AnkleR].getWorldPosition(new THREE.Vector3());
      const ax = (an.x - p.pos.x) * pre.fx + (an.z - p.pos.z) * pre.fz, az = -(an.x - p.pos.x) * pre.fz + (an.z - p.pos.z) * pre.fx;
      log.push(`t=${t.toFixed(2)} sp=${pre.sp.toFixed(1)} ahead=${ahead.toFixed(2)} side=${side.toFixed(2)} relF=${(pre.relx * pre.fx + pre.relz * pre.fz).toFixed(1)} swing=${pre.foot} foot=${p.touchFoot} ankle=(${ax.toFixed(2)},${an.y.toFixed(2)},${az.toFixed(2)})`);
    }
    const before = rec.overlapTicks;
    rec.track([v], b, () => true);
    if (rec.overlapTicks > before && debug === name && t - lastLog > 0.15 && log.length < 40) {
      lastLog = t;
      const fx = Math.cos(p.facing), fz = Math.sin(p.facing), dx = b.pos.x - p.pos.x, dz = b.pos.z - p.pos.z;
      log.push(`OVERLAP t=${t.toFixed(2)} sp=${Math.hypot(p.vel.x, p.vel.z).toFixed(1)} ahead=${(dx * fx + dz * fz).toFixed(2)} side=${(-dx * fz + dz * fx).toFixed(2)} L=${bootGap(v, -1, b).toFixed(2)} R=${bootGap(v, 1, b).toFixed(2)} phaseL=${((p.runPhase / 2) % 1).toFixed(2)} touchAnim=${p.touchAnim.toFixed(2)} eta=${p.touchEta.toFixed(2)}`);
    }
    const d = Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z);
    maxAhead = Math.max(maxAhead, d);
    if (d > 3) lost++;
  }
  v.dispose();
  if (log.length) debugLog.push(...log);
  return { script: name, skill, ...summary(rec.samples, 'dribble'), overlapTicks: rec.overlapTicks, deepestOverlap: Math.round(rec.overlap * 1000) / 1000, maxBallDistance: Math.round(maxAhead * 100) / 100, lostTicks: lost };
}

// ---------------------------------------------------------------- whole matches
function runMatch(seed: number, home: number, away: number, seconds: number) {
  const m = new Match({ seed, humans: [], seconds, home: TEAMS[home], away: TEAMS[away] });
  const views = m.players.map((p) => new PlayerView(kit, p));
  const rec = new Recorder();
  const prevTouch = m.players.map((p) => p.touchAnim);
  let kickId = m.ball.kickId;
  const trace: string[][] = [];
  const prev = m.players.map((p) => ({ f: p.facing, aim: p.windAim, max: p.windMax, t: p.windT, x: p.pos.x, z: p.pos.z, sp: 0 }));
  const pb = { x: m.ball.pos.x, y: m.ball.pos.y, z: m.ball.pos.z, vx: 0, vz: 0 };
  const where = (i: number) => {
    const q = prev[i], fx = Math.cos(q.f), fz = Math.sin(q.f), dx = pb.x - q.x, dz = pb.z - q.z;
    return `ahead=${(dx * fx + dz * fz).toFixed(2)} side=${(-dx * fz + dz * fx).toFixed(2)} y=${pb.y.toFixed(2)} sp=${q.sp.toFixed(1)} ballRel=${Math.hypot(pb.vx, pb.vz).toFixed(1)}`;
  };
  const refresh = (p: Player, i: number) => {
    if (views[i].version !== p.version) { views[i].dispose(); views[i] = new PlayerView(kit, p); }
  };
  for (let k = 0; k < 60 * seconds * 3 && m.phase !== 'fulltime'; k++) {
    m.step({}, DT);
    m.events.length = 0; m.notices.length = 0;
    const keepers = new Map(Object.values(m.keepers).map((kp) => [kp.p.id, kp]));
    m.players.forEach((p, i) => {
      refresh(p, i);
      if (p.sentOff) return;
      const kp = keepers.get(p.id);
      views[i].update(p, kp ? { dive: kp.state === 'dive' || kp.state === 'down' ? (kp.diveVel.z || 1) : 0, hold: kp.state === 'hold', ball: m.ball } : { ball: m.ball }, DT);
    });
    const b = m.ball;
    const play = m.phase === 'play';
    m.players.forEach((p, i) => {
      if (!p.windFire) { if (!(p.kickAnim > FOLLOW_THROUGH - 0.03)) trace[i] = []; return; }
      const fx = Math.cos(p.facing), fz = Math.sin(p.facing), dx = b.pos.x - p.pos.x, dz = b.pos.z - p.pos.z, kp = kickSpot(p, b);
      (trace[i] ??= []).push(`T=${p.windT.toFixed(2)} own=${b.ownerId === p.id ? 1 : 0} ball=(${(dx * fx + dz * fz).toFixed(2)},${(-dx * fz + dz * fx).toFixed(2)},y${b.pos.y.toFixed(2)}) want=(${kp.ahead.toFixed(2)},${kp.side.toFixed(2)}) gap=${kp.gap.toFixed(2)} foot=${p.kickFoot} ${p.windKind} turn=${p.windAim === null ? 'x' : Math.atan2(Math.sin(p.windAim - p.facing), Math.cos(p.windAim - p.facing)).toFixed(2)} cd=${p.kickCooldown.toFixed(2)} st=${p.stumble.toFixed(2)} sp=${Math.hypot(p.vel.x, p.vel.z).toFixed(1)}`);
    });
    m.players.forEach((p, i) => {
      if (play && p.role === 'field' && p.touchAnim > prevTouch[i] + 0.01 && b.pos.y < 0.3) {
        rec.event(p.touchAnim > 0.23 ? 'first' : 'dribble', views[i], p.touchFoot, `${p.touchAnim > 0.23 ? 'first' : 'dribble'} foot=${p.touchFoot} ${where(i)}`);
      }
      prevTouch[i] = p.touchAnim;
    });
    if (b.kickId !== kickId) {
      kickId = b.kickId;
      const kicker = b.kickerId >= 0 ? m.players[b.kickerId] : null;
      // Dribble touches do not count as kicks; keepers' throws and punts are left out.
      if (play && kicker && prev[b.kickerId].t < -0.05 && lateLog.length < 4 && trace[b.kickerId]?.length) lateLog.push(trace[b.kickerId].slice(0, 30));
      if (play && kicker && kicker.role === 'field' && kicker.kickAnim > FOLLOW_THROUGH - 0.05) rec.event('kick', views[b.kickerId], kicker.kickFoot, `${kicker.kickKind} foot=${kicker.kickFoot} turn=${prev[b.kickerId].aim === null ? 'none' : (Math.atan2(Math.sin(prev[b.kickerId].aim! - prev[b.kickerId].f), Math.cos(prev[b.kickerId].aim! - prev[b.kickerId].f))).toFixed(2)} snap=${Math.atan2(Math.sin(kicker.facing - prev[b.kickerId].f), Math.cos(kicker.facing - prev[b.kickerId].f)).toFixed(2)} wind=${prev[b.kickerId].max.toFixed(2)}/${prev[b.kickerId].t.toFixed(2)} ${where(b.kickerId)}`);
    }
    m.players.forEach((p, i) => { const q = prev[i]; q.f = p.facing; q.aim = p.windAim; q.max = p.windMax; q.t = p.windT; q.x = p.pos.x; q.z = p.pos.z; q.sp = Math.hypot(p.vel.x, p.vel.z); });
    pb.x = b.pos.x; pb.y = b.pos.y; pb.z = b.pos.z; pb.vx = b.vel.x; pb.vz = b.vel.z;
    rec.track(views, b, (_, i) => !m.players[i].sentOff && !b.held && Math.hypot(m.players[i].pos.x - b.pos.x, m.players[i].pos.z - b.pos.z) < 2.5 && b.pos.y < 0.5);
  }
  for (const v of views) v.dispose();
  return rec;
}

const out: Record<string, unknown> = {};
const q = new URLSearchParams(location.search);
const scripts = [];
for (const name of Object.keys(SCRIPTS)) for (const skill of [60, 90]) scripts.push(runScript(name, skill));
out.scripts = scripts;
out.debug = debugLog;
const matches = Number(q.get('matches') ?? 4);
const all: Sample[] = [];
let overlapTicks = 0, deepest = 0, ticks = 0;
for (let i = 0; i < matches; i++) {
  const rec = runMatch(700 + i, (i * 5) % TEAMS.length, (i * 7 + 3) % TEAMS.length, 240);
  all.push(...rec.samples);
  overlapTicks += rec.overlapTicks; deepest = Math.min(deepest, rec.overlap); ticks += rec.ticks;
}
out.late = lateLog;
out.match = {
  matches, dribble: summary(all, 'dribble'), first: summary(all, 'first'), kick: summary(all, 'kick'),
  kickByKind: Object.fromEntries(['pass', 'through', 'lob', 'shoot'].map((k) => [k, summary(all.filter((s) => s.note.startsWith(k + ' ')), 'kick')])),
  worst: Object.fromEntries((['dribble', 'first', 'kick'] as const).map((k) => [k, all.filter((s) => s.kind === k && s.best > 0.1).sort((a, b) => b.best - a.best).filter((_, i, arr) => i % Math.max(1, Math.floor(arr.length / 14)) === 0).slice(0, 14).map((s) => `${s.best.toFixed(2)} ${s.note}`)])),
  overlapTicks, overlapShare: Math.round((overlapTicks / Math.max(1, ticks)) * 10000) / 10000, deepestOverlap: Math.round(deepest * 1000) / 1000,
};
(window as unknown as { __sync: unknown }).__sync = out;
const pre = document.createElement('pre');
pre.style.cssText = 'color:#dfe;font:12px ui-monospace,Consolas,monospace;padding:12px;white-space:pre-wrap';
pre.textContent = JSON.stringify(out, null, 1);
document.body.appendChild(pre);
