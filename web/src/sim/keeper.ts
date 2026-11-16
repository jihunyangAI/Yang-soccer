import type { Ball } from './ball';
import { BALL_RADIUS as R, GOAL, GRAVITY, PITCH } from './constants';
import { clamp, rotateToward, type V2 } from './math';
import { movePlayer, seek, type Player } from './player';
import type { Rng } from './rng';

export type KeeperState = 'guard' | 'dive' | 'hold' | 'down';
/** 'release' = the keeper wants to distribute the ball it is holding now. */
export type KeeperEvent = 'save' | 'catch' | 'release' | null;

export interface Keeper {
  p: Player;
  /** Which goal it defends: +1 = goal at x = +52.5. */
  side: 1 | -1;
  state: KeeperState;
  timer: number;
  diveVel: V2;
  /** One save roll per kick, so a shot is not re-rolled every tick. */
  rolledKick: number;
  rollOk: boolean;
  reflex: number; // 1–99
  /** Facing a penalty: he has to guess, so far fewer shots are saved than in open play. */
  penalty?: boolean;
}

export function createKeeper(p: Player, side: 1 | -1, reflex: number): Keeper {
  const k: Keeper = { p, side, state: 'guard', timer: 0, diveVel: { x: 0, z: 0 }, rolledKick: -1, rollOk: false, reflex };
  resetKeeper(k);
  return k;
}

export function resetKeeper(k: Keeper): void {
  k.p.pos.x = k.side * (PITCH.halfLength - 1);
  k.p.pos.z = 0;
  k.p.vel.x = 0; k.p.vel.z = 0;
  k.p.facing = k.side > 0 ? Math.PI : 0;
  k.state = 'guard';
  k.timer = 0;
  k.penalty = false;
}

/** Give the ball to the keeper (catch or goal kick). */
export function keeperTakeBall(k: Keeper, b: Ball, holdTime: number): void {
  k.state = 'hold';
  k.timer = holdTime;
  b.held = true;
  b.ownerId = k.p.id;
  b.intendedId = -1;
  b.vel.x = 0; b.vel.y = 0; b.vel.z = 0;
  b.spin = 0;
  b.lastTouch = k.p.team;
  b.kickId++;
}

/**
 * Positioning, diving and saving. `ownerTeam` is the team of the player
 * dribbling the ball (null when loose).
 */
export function updateKeeper(
  k: Keeper, b: Ball, ownerIsOpponent: boolean, dt: number, rng: Rng, active: boolean,
): KeeperEvent {
  const P = k.p;
  const side = k.side;
  const hl = PITCH.halfLength;
  const gx = side * hl;
  const outward = side > 0 ? Math.PI : 0;

  switch (k.state) {
    case 'hold': {
      P.vel.x = 0; P.vel.z = 0;
      P.facing = rotateToward(P.facing, outward, 6 * dt);
      b.pos.x = P.pos.x + Math.cos(P.facing) * 0.35;
      b.pos.z = P.pos.z + Math.sin(P.facing) * 0.35;
      b.pos.y = 1.1;
      k.timer -= dt;
      return k.timer <= 0 && active ? 'release' : null;
    }
    case 'dive':
      P.pos.x += k.diveVel.x * dt;
      P.pos.z += k.diveVel.z * dt;
      k.timer -= dt;
      if (k.timer <= 0) { k.state = 'down'; k.timer = 0.6; k.diveVel = { x: 0, z: 0 }; }
      break;
    case 'down':
      P.vel.x = 0; P.vel.z = 0;
      k.timer -= dt;
      if (k.timer <= 0) k.state = 'guard';
      break;
    case 'guard': {
      const dx = b.pos.x - gx, dz = b.pos.z;
      const d = Math.hypot(dx, dz);
      let tx: number, tz: number, sprint = false;
      const slow = Math.hypot(b.vel.x, b.vel.z) < 10;
      const threat = ownerIsOpponent || (b.ownerId === -1 && b.grounded && slow);
      if (d < 9 && threat && b.inGoal === 0 && !b.held) {
        // Close down a loose ball or a dribbler near the goal.
        tx = b.pos.x; tz = b.pos.z; sprint = true;
      } else {
        const dist = clamp(d * 0.1, 0.8, 4.5);
        tx = gx + (d > 0.01 ? dx / d : -side) * dist;
        tz = d > 0.01 ? (dz / d) * dist : 0;
      }
      tx = side * Math.min(side * tx, hl - 0.4);
      tz = clamp(tz, -GOAL.halfWidth - 3, GOAL.halfWidth + 3);
      const i = seek(P, tx, tz, 1.5);
      movePlayer(P, i.x, i.z, sprint, false, dt);
      P.facing = rotateToward(P.facing, Math.atan2(b.pos.z - P.pos.z, b.pos.x - P.pos.x), 10 * dt);
      break;
    }
  }
  if (!active || b.held || b.inGoal !== 0) return null;

  // React to a shot heading for goal by diving toward where it will cross.
  if (k.state === 'guard' && b.ownerId === -1 && b.age > 0.15 && side * b.vel.x > 6) {
    const t = (hl - side * b.pos.x) / (side * b.vel.x);
    if (t > 0 && t < 0.85) {
      const pz = b.pos.z + b.vel.z * t;
      const py = Math.max(R, b.pos.y + b.vel.y * t - 0.5 * GRAVITY * t * t);
      const lateral = pz - P.pos.z;
      if (Math.abs(pz) < GOAL.halfWidth + 0.6 && py < GOAL.height + 0.4 && Math.abs(lateral) > 0.8) {
        const need = Math.abs(lateral) / Math.max(t, 0.15);
        k.diveVel = { x: 0, z: Math.sign(lateral) * Math.min(7.5, need) };
        k.state = 'dive';
        k.timer = Math.min(0.8, t + 0.25);
      }
    }
  }

  if (k.state !== 'guard' && k.state !== 'dive') return null;
  if (P.possessCooldown > 0) return null;
  if (b.ownerId !== -1 && !ownerIsOpponent) return null;
  const diving = k.state === 'dive';
  const reach = diving ? 1.7 : 0.95;
  const d = Math.hypot(b.pos.x - P.pos.x, b.pos.z - P.pos.z);
  if (d > reach || b.pos.y > (diving ? 2.3 : 2.5)) return null;

  // Smothering a dribbler is not automatic.
  if (ownerIsOpponent) {
    if (rng() < 4 * dt) { keeperTakeBall(k, b, 1.2); return 'catch'; }
    return null;
  }

  const speed = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
  if (speed < 9) {
    keeperTakeBall(k, b, 1.2);
    return 'catch';
  }
  if (k.rolledKick !== b.kickId) {
    k.rolledKick = b.kickId;
    const base = clamp(1.35 - (speed - 12.5) / 33, 0.3, 0.96) * (0.8 + (k.reflex / 99) * 0.25);
    k.rollOk = rng() < base * (diving ? 0.85 : 1) * (k.penalty ? 0.42 : 1);
  }
  if (!k.rollOk) return null;
  if (speed < 17 && !diving) {
    keeperTakeBall(k, b, 1.2);
  } else {
    // Parry away from goal.
    b.vel.x = -side * (3 + rng() * 4);
    b.vel.y = 2 + rng() * 3;
    b.vel.z = (rng() - 0.5) * 10;
    b.spin = 0;
    b.ownerId = -1;
    b.kickId++;
    b.age = 0;
    b.lastTouch = P.team;
    P.possessCooldown = 0.6;
  }
  return 'save';
}

/** Release the ball from the hands with a given velocity. */
export function keeperThrow(k: Keeper, b: Ball, vx: number, vy: number, vz: number): void {
  const P = k.p;
  b.held = false;
  b.ownerId = -1;
  b.pos.y = Math.max(b.pos.y, 0.5);
  b.vel.x = vx; b.vel.y = vy; b.vel.z = vz;
  b.kickId++;
  b.age = 0;
  b.lastTouch = P.team;
  P.facing = Math.atan2(vz, vx);
  P.kickAnim = 0.25;
  P.possessCooldown = 1.0;
  k.state = 'guard';
}
