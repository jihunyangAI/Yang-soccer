import { BALL_RADIUS as R } from './constants';
import { ROLL_DECEL, type Ball, type Team } from './ball';
import { clamp, rotateToward, smooth, wrapAngle, type V2 } from './math';
import type { Rng } from './rng';

export interface Stats {
  speed: number;
  dribble: number;
  pass: number;
  shoot: number;
  defense: number;
  stamina: number;
}

export type KickKind = 'pass' | 'through' | 'shoot' | 'lob';
export type ChargeKind = 'shoot' | 'lob';

export interface Player {
  id: number;
  team: Team;
  role: 'field' | 'gk';
  /** Formation slot in team space: x -1 (own goal) … +1 (opponent goal), z -1 … +1. */
  slot: V2;
  number: number;
  pos: V2;
  vel: V2;
  /** Facing angle in the x/z plane: direction = (cos, sin). */
  facing: number;
  stats: Stats;
  possessCooldown: number;
  kickCooldown: number;
  tackleCooldown: number;
  /** Seconds left off-balance after a missed tackle. */
  stumble: number;
  charge: { kind: ChargeKind | null; t: number };
  pending: { kind: KickKind; power: number; t: number } | null;
  /** AI: seconds until the next decision, and the current dribble heading. */
  think: number;
  aiDir: V2;
  /** AI off the ball: the opponent being marked (-1 = none), and the spot being run to with seconds until it is reconsidered. */
  aiMark: number;
  /** AI: the set piece this player is taking (0 none, 1 throw-in, 2 corner); it is played to a teammate at once, not dribbled. */
  setPiece: 0 | 1 | 2;
  aiSpot: V2;
  aiSpotT: number;
  /** Visual-only animation state. */
  runPhase: number;
  kickAnim: number;
  tackleAnim: number;
  sprinting: boolean;
  // ---- squad identity (changes on substitution) ----
  name: string;
  posLabel: string;
  look: Look;
  /** Bumped when a substitute takes this spot, so views rebuild. */
  version: number;
  /** 1 = fresh, 0 = exhausted. */
  energy: number;
  yellow: number;
  sentOff: boolean;
  /** Goal celebration role: 0 none, 1 scorer, 2 teammate, 3 conceding side. */
  celebrate: 0 | 1 | 2 | 3;
  /** Scorer's celebration style: 0 arms up, 1 airplane, 2 knee slide. */
  celebPose: 0 | 1 | 2;
  // ---- ball work ----
  /** Seconds until the next dribble touch is allowed. */
  touchCooldown: number;
  /** Visual: a dribble touch or first touch in progress (seconds left), and with which foot (-1 left, 1 right). */
  touchAnim: number;
  touchFoot: -1 | 1;
  /** Seconds until the step that is meant to make the next dribble touch (0 = none planned). */
  touchEta: number;
  /** Visual: what the last kick was and which foot struck it. */
  kickKind: KickKind;
  kickFoot: -1 | 1;
  /** Kick wind-up: the strike happens when `windT` reaches zero. */
  windT: number;
  windMax: number;
  windKind: KickKind;
  windFire: (() => void) | null;
  /** Direction the kick being wound up will go (radians), or null if it is not known yet. */
  windAim: number | null;
}

/** Seconds the leg swings through after contact (visual). */
export const FOLLOW_THROUGH = 0.3;

export interface Look { skin: number; hair: number; style: 0 | 1 | 2 | 3; eye: number }

/** Per-tick input. `down`/`up` carry button edges since the last tick. */
export interface Actions {
  mx: number;
  mz: number;
  sprint: boolean;
  held: ReadonlySet<string>;
  down: ReadonlySet<string>;
  up: ReadonlySet<string>;
}

export interface KickRequest { kind: KickKind; power: number; dir: V2 }

export const MAX_CHARGE = 0.8; // seconds for full power
export const CONTROL_RADIUS = 0.75;

export function createPlayer(id: number, team: Team, role: 'field' | 'gk', slot: V2, number: number, stats: Stats): Player {
  return {
    id, team, role, slot, number, stats,
    pos: { x: 0, z: 0 },
    vel: { x: 0, z: 0 },
    facing: 0,
    possessCooldown: 0,
    kickCooldown: 0,
    tackleCooldown: 0,
    stumble: 0,
    charge: { kind: null, t: 0 },
    pending: null,
    think: 0,
    aiDir: { x: 0, z: 0 },
    aiMark: -1,
    setPiece: 0,
    aiSpot: { x: 0, z: 0 },
    aiSpotT: 0,
    runPhase: 0,
    kickAnim: 0,
    tackleAnim: 0,
    sprinting: false,
    name: '',
    posLabel: '',
    look: { skin: 0xd9a27c, hair: 0x2a1d14, style: 0, eye: 0x4a2f1c },
    version: 0,
    energy: 1,
    yellow: 0,
    sentOff: false,
    celebrate: 0,
    celebPose: 0,
    touchCooldown: 0,
    touchAnim: 0,
    touchFoot: 1,
    touchEta: 0,
    kickKind: 'pass',
    kickFoot: 1,
    windT: 0,
    windMax: 0,
    windKind: 'pass',
    windFire: null,
    windAim: null,
  };
}

/** Which foot is nearer the ball: -1 left, 1 right (left is -z when facing +x). */
export function footFor(p: Player, b: Ball): -1 | 1 {
  const fx = Math.cos(p.facing), fz = Math.sin(p.facing);
  // The player's right is (−fz, fx): +z when facing +x.
  const side = (b.pos.x - p.pos.x) * -fz + (b.pos.z - p.pos.z) * fx;
  return side < -0.05 ? -1 : 1;
}

/** Speed and accuracy fall off once energy drops below 60%. */
export const fatigueSpeed = (p: Player): number => 0.82 + 0.18 * Math.min(1, p.energy / 0.6);
export const fatigueSpread = (p: Player): number => 1 + (1 - p.energy) * 0.5;

export function tickTimers(p: Player, dt: number): void {
  p.possessCooldown = Math.max(0, p.possessCooldown - dt);
  p.kickCooldown = Math.max(0, p.kickCooldown - dt);
  p.tackleCooldown = Math.max(0, p.tackleCooldown - dt);
  p.stumble = Math.max(0, p.stumble - dt);
  p.kickAnim = Math.max(0, p.kickAnim - dt);
  p.tackleAnim = Math.max(0, p.tackleAnim - dt);
  p.touchAnim = Math.max(0, p.touchAnim - dt);
  p.touchCooldown = Math.max(0, p.touchCooldown - dt);
}

/** Move with input direction (|i| ≤ 1). `hasBall` slows the player slightly. */
export function movePlayer(p: Player, ix: number, iz: number, sprint: boolean, hasBall: boolean, dt: number): void {
  const mag = Math.min(1, Math.hypot(ix, iz));
  const s = p.stats;
  const jog = 4.4 + (s.speed / 99) * 1.6;
  const run = 6.4 + (s.speed / 99) * 2.8;
  let max = sprint && mag > 0.3 ? run : jog;
  if (hasBall) max *= 0.92 - (1 - s.dribble / 99) * 0.15;
  if (p.stumble > 0) max *= 0.25;
  if (p.windT > 0) max *= 0.55; // planting the standing foot for a kick
  max *= fatigueSpeed(p);
  p.sprinting = sprint && mag > 0.3;

  const k = smooth(mag > 0.05 ? 9 : 7, dt);
  p.vel.x += (ix * max - p.vel.x) * k;
  p.vel.z += (iz * max - p.vel.z) * k;
  p.pos.x = clamp(p.pos.x + p.vel.x * dt, -57, 57);
  p.pos.z = clamp(p.pos.z + p.vel.z * dt, -38, 38);

  const sp = Math.hypot(p.vel.x, p.vel.z);
  const turn = (hasBall ? 9 : 12) * dt;
  // Winding up and following through a kick: the body turns toward where the ball is going,
  // not where the stick points.
  if (p.windFire && p.windAim !== null) {
    // The ball is struck across the body where it lies; the body only turns for the part of the
    // angle a leg cannot kick across.
    const rem = wrapAngle(p.windAim - p.facing), across = kickAcross(p.windKind);
    if (Math.abs(rem) > across) p.facing = rotateToward(p.facing, p.windAim - Math.sign(rem) * across, KICK_TURN * dt);
  } else if (p.kickAnim > 0 && p.windAim !== null) p.facing = rotateToward(p.facing, p.windAim, 8 * dt);
  else if (mag > 0.1) p.facing = rotateToward(p.facing, Math.atan2(iz, ix), turn);
  else if (sp > 0.6) p.facing = rotateToward(p.facing, Math.atan2(p.vel.z, p.vel.x), turn);
  // Stride grows with speed (about 2.6 m per cycle jogging, 4.4 m sprinting), so cadence stays human.
  const stride = 1.6 + sp * 0.35;
  p.runPhase += (2 * sp / stride) * dt;
}

/** Steer toward a point; returns the input vector that does it. */
export function seek(p: Player, tx: number, tz: number, slowRadius = 2): V2 {
  const dx = tx - p.pos.x, dz = tz - p.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.25) return { x: 0, z: 0 };
  const m = Math.min(1, d / slowRadius);
  return { x: (dx / d) * m, z: (dz / d) * m };
}

/** Point just in front of the player where the ball sits when controlled. */
export function footPoint(p: Player): V2 {
  return { x: p.pos.x + Math.cos(p.facing) * 0.4, z: p.pos.z + Math.sin(p.facing) * 0.4 };
}

export function ballDistance(p: Player, b: Ball): number {
  const f = footPoint(p);
  return Math.hypot(b.pos.x - f.x, b.pos.z - f.z);
}

/** Can this player take a loose ball arriving at the feet? */
export function canControl(p: Player, b: Ball): boolean {
  if (b.held || p.possessCooldown > 0 || p.stumble > 0 || b.pos.y > 0.8) return false;
  if (ballDistance(p, b) > CONTROL_RADIUS) return false;
  const rvx = b.vel.x - p.vel.x, rvz = b.vel.z - p.vel.z;
  const rel = Math.hypot(rvx, rvz);
  if (rel >= 10 + (p.stats.dribble / 99) * 9) return false;
  // A pass still on its way in is taken when it gets to a foot, not from a stride away.
  const fx = Math.cos(p.facing), fz = Math.sin(p.facing);
  const dx = b.pos.x - p.pos.x, dz = b.pos.z - p.pos.z;
  const ahead = dx * fx + dz * fz, side = -dx * fz + dz * fx;
  // A ball rolling slowly nearby is simply collected, and one that has come right up to the body is stopped by it.
  if (rel < 4 || Math.hypot(dx, dz) < 0.46) return true;
  // While it is still coming closer it is left until a foot can meet it comfortably; one that is
  // as close as it will get is taken with a stretch.
  const closing = (dx - fx * 0.45) * rvx + (dz - fz * 0.45) * rvz < 0;
  const m = closing ? -0.06 : 0.16;
  return ahead > -0.05 && ahead < FOOT_REACH.far + m && Math.abs(side) < FOOT_REACH.side + m;
}

/**
 * Stride position of a leg: 0 as the foot lands, rising to 1 just before it lands again.
 * side −1 = left, 1 = right. The renderer draws the legs from the same number.
 */
export const legPhase = (p: Player, side: -1 | 1): number => {
  const u = p.runPhase / 2 + (side > 0 ? 0.5 : 0);
  return u - Math.floor(u);
};
/** Late swing: the part of the stride where that foot is coming through to the front. */
export const TOUCH_WINDOW = { from: 0.76, to: 0.95 };
/** The foot that is swinging forward right now (−1 left, 1 right), or 0 if neither is. */
export function swingingFoot(p: Player): -1 | 0 | 1 {
  for (const s of [-1, 1] as const) {
    const u = legPhase(p, s);
    if (u > TOUCH_WINDOW.from && u < TOUCH_WINDOW.to) return s;
  }
  return 0;
}

/** How hard the ball falls back toward a dribbler between touches (m/s², relative). */
const DRIBBLE_SETTLE = 9;
/** Where the ball rests when its owner stands still: ahead of the player, toward the foot that holds it. */
export const STAND_BALL = { ahead: 0.42, side: 0.09 };
/** Distance ahead of the player at which a swinging foot meets the ball (the ball is drawn large). */
export const DRIBBLE_REACH = 0.62;
/** How fast the body turns toward a kick's direction (rad/s). */
export const KICK_TURN = 12;
/** The widest angle a kick can go across the body: wide for a side-foot pass, less for a driven ball. */
export const kickAcross = (kind: KickKind): number => (kind === 'pass' || kind === 'through' ? 1.5 : 0.9);
/** Radius of the patch of grass in front of the kicking foot where the ball can be struck from. */
const KICK_AREA = 0.13;
/** How fast (m/s, relative to the player) the ball can be brought to the kicking foot during a wind-up. */
export const KICK_GATHER = 8;
/**
 * Where a foot can actually play the ball, in metres ahead of and beside the player. The leg is
 * 0.84 m long, so the boot cannot meet a ball much further ahead than DRIBBLE_REACH.
 */
export const FOOT_REACH = { near: 0.22, far: 0.72, side: 0.36 };

/**
 * Dribbling by touches. The ball runs free a little ahead of the player; when it comes back
 * within reach (or drifts off line after a turn) the player knocks it on again, alternating
 * feet. Touches are short when jogging and longer when sprinting. Returns true on a touch.
 */
/**
 * Where the ball should be, ahead of and beside the player, for the kicking foot to strike it
 * toward the wind-up's aim. The foot has to get behind the ball, so the ball must lie in a small
 * patch in front of that foot (round to the side for a kick across the body). A ball already
 * there stays where it is; otherwise this is the nearest spot in the patch, `gap` metres away.
 */
export function kickSpot(p: Player, b: Ball): { ahead: number; side: number; gap: number } {
  const across = kickAcross(p.windKind);
  const turn = p.windAim === null ? 0 : clamp(wrapAngle(p.windAim - p.facing), -across, across);
  const cx = 0.15 + 0.28 * Math.cos(turn), cz = p.kickFoot * 0.12 + 0.28 * Math.sin(turn);
  const fx = Math.cos(p.facing), fz = Math.sin(p.facing);
  const dx = b.pos.x - p.pos.x, dz = b.pos.z - p.pos.z;
  const ox = dx * fx + dz * fz - cx, oz = -dx * fz + dz * fx - cz;
  const d = Math.hypot(ox, oz);
  // Aim well inside the patch, so the ball still ends up in it when the player is jostled or changes pace.
  const k = d > KICK_AREA * 0.4 ? (KICK_AREA * 0.4) / d : 1;
  return { ahead: cx + ox * k, side: cz + oz * k, gap: Math.max(0, d - KICK_AREA) };
}

/** The owner's kick can be struck: the ball is where the swinging foot will meet it. */
export function kickReady(p: Player, b: Ball): boolean {
  if (b.ownerId !== p.id) return canKick(p, b);
  if (b.held || p.kickCooldown > 0 || p.stumble > 0) return false;
  // Still turning to face a kick that goes behind the body.
  if (p.windAim !== null && Math.abs(wrapAngle(p.windAim - p.facing)) > kickAcross(p.windKind) + 0.05) return false;
  return kickSpot(p, b).gap < 0.06;
}

export function dribble(p: Player, b: Ball, dt: number): boolean {
  if (b.pos.y > R + 0.06) return false; // let a bouncing ball come down first
  if (p.windFire) {
    // Winding up: no more touches. A ball that is not where the kicking foot can strike it is
    // brought there, arriving as the swing does.
    const fx = Math.cos(p.facing), fz = Math.sin(p.facing);
    const k = kickSpot(p, b);
    const tx = p.pos.x + fx * k.ahead - fz * k.side, tz = p.pos.z + fz * k.ahead + fx * k.side;
    const T = Math.max(0.04, p.windT);
    let vx = (tx - b.pos.x) / T, vz = (tz - b.pos.z) / T;
    const v = Math.hypot(vx, vz);
    if (v > KICK_GATHER) { vx *= KICK_GATHER / v; vz *= KICK_GATHER / v; }
    const kk = 1 - Math.exp(-dt * 30);
    b.vel.x += (p.vel.x + vx - b.vel.x) * kk;
    b.vel.z += (p.vel.z + vz - b.vel.z) * kk;
    b.vel.y = 0;
    b.spin = 0;
    return false;
  }
  const fx = Math.cos(p.facing), fz = Math.sin(p.facing);
  const rx = -fz, rz = fx; // player's right
  const dx = b.pos.x - p.pos.x, dz = b.pos.z - p.pos.z;
  const ahead = dx * fx + dz * fz;
  const side = dx * rx + dz * rz;
  const sp = Math.hypot(p.vel.x, p.vel.z);
  const relF = (b.vel.x - p.vel.x) * fx + (b.vel.z - p.vel.z) * fz;
  const relS = (b.vel.x - p.vel.x) * rx + (b.vel.z - p.vel.z) * rz;
  b.vel.y = 0;
  b.spin = 0;

  if (sp < 1.2) {
    // Standing or shuffling: the ball stays under the sole of one foot, just in front of it.
    const off = p.touchFoot * STAND_BALL.side;
    const tx = p.pos.x + fx * STAND_BALL.ahead + rx * off, tz = p.pos.z + fz * STAND_BALL.ahead + rz * off;
    const k = 1 - Math.exp(-dt * 10);
    b.vel.x += (p.vel.x + (tx - b.pos.x) * 4 - b.vel.x) * k;
    b.vel.z += (p.vel.z + (tz - b.pos.z) * 4 - b.vel.z) * k;
    return false;
  }

  const lead = Math.max(0.85, 0.45 + sp * 0.12 + (p.sprinting ? 0.55 : 0));
  const cycle = (1.6 + sp * 0.35) / sp; // seconds per full stride (see movePlayer)
  const g = DRIBBLE_SETTLE + ROLL_DECEL;
  // Seconds until each coming step swings through, soonest first.
  const steps: number[] = [];
  for (const sd of [-1, 1] as const) {
    let du = TOUCH_WINDOW.from - legPhase(p, sd);
    if (du < 0.02) du += 1;
    steps.push(du * cycle, (du + 1) * cycle);
  }
  steps.sort((x, y) => x - y);

  // A touch is made by a foot, so it only happens where a foot can get to: a leg is swinging
  // forward and the ball is inside its reach. A ball that is anywhere else is steered back into
  // reach first (see below) instead of being knocked on from a distance.
  const foot = swingingFoot(p);
  const inReach = ahead > FOOT_REACH.near && ahead < FOOT_REACH.far && Math.abs(side) < FOOT_REACH.side;
  // A ball out to one side is played by the foot on that side, not by a leg crossing over.
  const due = foot !== 0 && inReach && relF <= 0.5 && foot * side > -0.14;
  // The ball is right at the player's feet and not moving on: the nearer foot pokes it ahead
  // without waiting for the stride.
  const stuck = foot === 0 && inReach && ahead < FOOT_REACH.near + 0.12 && relF < 0.3 && steps[0] > 0.12;
  if (p.touchCooldown === 0 && (due || stuck)) {
    // Knock it on, timed so the ball drops back to the foot's reach just as a later step swings
    // through: of the coming steps, pick the one whose push carries the ball about `lead` ahead.
    const a0 = Math.max(0, ahead);
    let push = Math.sqrt(2 * g * Math.max(0.35, lead - a0)), best = 9;
    p.touchEta = 0;
    for (const T of steps) {
      if (T < 0.2) continue;
      const v = (DRIBBLE_REACH - a0 + 0.5 * g * T * T) / T;
      const err = Math.abs(a0 + (v * v) / (2 * g) - lead);
      if (err < best) { best = err; push = v; p.touchEta = T; }
    }
    // The push also takes the ball back onto the player's line by the time it is met again.
    const across = clamp(side / Math.max(0.25, p.touchEta), -4, 4);
    b.vel.x = p.vel.x + fx * push - rx * across;
    b.vel.z = p.vel.z + fz * push - rz * across;
    const control = p.stats.dribble / 99;
    p.touchCooldown = 0.16 + (1 - control) * 0.08;
    p.touchAnim = 0.2;
    p.touchFoot = foot !== 0 ? foot : side < 0 ? -1 : 1;
    return true;
  }

  // Between touches the ball is brought to the foot's reach exactly when a step arrives, even
  // if the player speeds up, slows down or turns. If the step that was planned has gone by
  // without a touch (the ball was out of reach after a turn), the next step that can be made is taken.
  p.touchEta = Math.max(0, p.touchEta - dt);
  const need = (T: number) => (2 * (ahead + relF * T - DRIBBLE_REACH)) / (T * T) - ROLL_DECEL;
  if (p.touchEta <= 0.05) {
    p.touchEta = 0;
    for (const T of steps) {
      if (T < 0.1) continue;
      const a = need(T);
      // The ball can be slowed to arrive with that step, and can get across to the line in time.
      if (a <= 26 && Math.abs(side) / T < 5) { p.touchEta = T; break; }
    }
  }
  const T = p.touchEta;
  let settle = DRIBBLE_SETTLE;
  if (T > 0.05) settle = clamp(need(T), 0, 30);
  if (relF > -6) {
    b.vel.x -= fx * settle * dt;
    b.vel.z -= fz * settle * dt;
  }
  // The ball has ended up beside or behind the player (a sharp turn, a stop): it follows the
  // player round until a foot can reach it again.
  if (ahead < 0.45 && relF < 2) {
    const pull = clamp((0.52 - ahead) * 30 - relF * 8, 0, 22) * dt;
    b.vel.x += fx * pull;
    b.vel.z += fz * pull;
  }
  // Sideways the ball drifts onto the player's line in time for that step (as if played with a
  // little spin). A ball coming round from behind stays just outside the feet until it is in
  // front of them, so it goes round the boots instead of through them.
  const outside = ahead < FOOT_REACH.near ? (Math.abs(side) > 0.03 ? Math.sign(side) : p.touchFoot) * FOOT_REACH.side * 0.95 : 0;
  const wantS = outside !== 0 ? clamp((outside - side) * 9, -6, 6)
    : T > 0.05 ? clamp(-side / Math.max(T, 0.1), -5, 5) : clamp(-side * 4, -5, 5);
  const s = (relS - wantS) * (1 - Math.exp(-dt * 12));
  b.vel.x -= rx * s;
  b.vel.z -= rz * s;
  return false;
}

/** Receiving a firm pass: cushion it and drop it a step ahead. */
export function firstTouch(p: Player, b: Ball): void {
  const rel = Math.hypot(b.vel.x - p.vel.x, b.vel.z - p.vel.z);
  p.touchFoot = footFor(p, b);
  if (rel < 4) return;
  const fx = Math.cos(p.facing), fz = Math.sin(p.facing);
  const settle = 1 + (1 - p.stats.dribble / 99) * 1.5; // poorer control: it bobbles further
  b.vel.x = p.vel.x + fx * settle;
  b.vel.z = p.vel.z + fz * settle;
  b.vel.y = 0;
  p.touchAnim = 0.26;
  p.touchCooldown = 0.25;
}

export function canKick(p: Player, b: Ball): boolean {
  if (b.held || p.kickCooldown > 0 || p.stumble > 0) return false;
  if (b.ownerId === p.id) return ballDistance(p, b) < 1.2; // a ball knocked ahead must come back first
  if (b.ownerId !== -1) return false;
  return b.pos.y < 1.4 && ballDistance(p, b) < 1.1;
}

/** Apply a kick velocity with an accuracy error that grows as `spread` grows. */
export function strike(p: Player, b: Ball, vx: number, vy: number, vz: number, spread: number, spin: number, rng: Rng): void {
  const h = Math.hypot(vx, vz);
  const a = Math.atan2(vz, vx) + (rng() - 0.5) * 2 * spread * fatigueSpread(p);
  b.kickerId = p.id;
  b.vel.x = Math.cos(a) * h;
  b.vel.z = Math.sin(a) * h;
  b.vel.y = vy;
  b.pos.y = Math.max(b.pos.y, R + 0.01);
  b.spin = spin;
  b.ownerId = -1;
  b.intendedId = -1;
  b.kickId++;
  b.age = 0;
  b.lastTouch = p.team;
  p.possessCooldown = 0.3;
  p.kickCooldown = 0.2;
  p.kickAnim = FOLLOW_THROUGH;
  // The body keeps turning toward the kick through the follow-through (see movePlayer).
  if (h > 0.1) p.windAim = a;
}

/** Shot velocity for a given power (0–1) toward `dir`. */
export function shoot(p: Player, b: Ball, power: number, dir: V2, rng: Rng): void {
  const s = p.stats;
  // 22 m/s (~80 km/h) on a tap, up to ~42 m/s (~150 km/h) at full charge.
  const speed = 22 + power * (15 + (s.shoot / 99) * 5);
  const vy = 0.6 + power * power * 5.5;
  const spread = 0.02 + (1 - s.shoot / 99) * 0.08 + Math.max(0, power - 0.85) * 0.5;
  strike(p, b, dir.x * speed, vy, dir.z * speed, spread, (rng() - 0.5) * 0.15, rng);
}

/**
 * Human attacking input: shoot and lob charge while held and fire on release;
 * a kick pressed slightly before reaching the ball is buffered.
 * Returns a kick request when the ball is playable this tick.
 */
export function readKickInput(p: Player, b: Ball, a: Actions, dt: number): KickRequest | null {
  for (const kind of ['shoot', 'lob'] as const) {
    if (a.down.has(kind) && p.charge.kind === null) p.charge = { kind, t: 0 };
  }
  if (p.charge.kind) {
    const kind = p.charge.kind;
    if (a.held.has(kind)) p.charge.t += dt;
    const released = a.up.has(kind) || !a.held.has(kind) || p.charge.t >= MAX_CHARGE * 1.15;
    if (released) {
      const power = clamp(p.charge.t / MAX_CHARGE, 0.15, 1);
      p.pending = { kind, power, t: 0.6 };
      p.charge = { kind: null, t: 0 };
    }
  }
  if (a.down.has('pass')) p.pending = { kind: 'pass', power: 0, t: 0.6 };
  if (a.down.has('through')) p.pending = { kind: 'through', power: 0, t: 0.6 };

  if (!p.pending) return null;
  p.pending.t -= dt;
  if (canKick(p, b)) {
    const mag = Math.hypot(a.mx, a.mz);
    const dir = mag > 0.2
      ? { x: a.mx / mag, z: a.mz / mag }
      : { x: Math.cos(p.facing), z: Math.sin(p.facing) };
    const req = { kind: p.pending.kind, power: p.pending.power, dir };
    p.pending = null;
    return req;
  }
  if (p.pending.t <= 0) p.pending = null;
  return null;
}
