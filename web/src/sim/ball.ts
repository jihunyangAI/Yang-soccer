import { BALL_RADIUS as R, GOAL, GRAVITY, PITCH } from './constants';
import type { V3 } from './math';

export type Team = 'home' | 'away';

export interface Ball {
  pos: V3;
  vel: V3;
  /** Side spin; curves the ball in flight. */
  spin: number;
  /** Player id dribbling or holding the ball, -1 when loose. */
  ownerId: number;
  /** True while a goalkeeper holds the ball in hands. */
  held: boolean;
  /** Player id a pass was aimed at, -1 if none. */
  intendedId: number;
  /** Increments on every kick; lets a keeper roll one save chance per shot. */
  kickId: number;
  /** Seconds since the last kick. */
  age: number;
  lastTouch: Team | null;
  /** +1 / -1 once the ball has entered that goal through the mouth, else 0. */
  inGoal: number;
  grounded: boolean;
  /** Players caught offside at the moment of the last kick, and their team. */
  offsideIds: number[];
  offsideTeam: Team | null;
  /** Player id that last kicked the ball, -1 if none. */
  kickerId: number;
}

export type BallHit = 'post' | 'bar' | 'net' | null;

const AIR_DRAG = 0.010; // quadratic drag coefficient for a size-5 ball (drag drops at high speed)
export const ROLL_DECEL = 1.6; // m/s² on grass
const BOUNCE = 0.55;

export function createBall(): Ball {
  return {
    pos: { x: 0, y: R, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    spin: 0,
    ownerId: -1,
    held: false,
    intendedId: -1,
    kickId: 0,
    age: 0,
    lastTouch: null,
    inGoal: 0,
    grounded: true,
    offsideIds: [],
    offsideTeam: null,
    kickerId: -1,
  };
}

export function placeBall(b: Ball, x: number, z: number): void {
  b.pos.x = x; b.pos.y = R; b.pos.z = z;
  b.vel.x = 0; b.vel.y = 0; b.vel.z = 0;
  b.spin = 0;
  b.ownerId = -1;
  b.held = false;
  b.intendedId = -1;
  b.inGoal = 0;
  b.kickId++;
  b.age = 0;
  b.offsideIds = [];
  b.offsideTeam = null;
}

export function stepBall(b: Ball, dt: number): BallHit {
  b.age += dt;
  if (b.held) return null;
  const p = b.pos;
  const v = b.vel;
  const prevX = p.x;

  v.y -= GRAVITY * dt;

  const speed = Math.hypot(v.x, v.y, v.z);
  const drag = AIR_DRAG * speed * dt;
  v.x -= v.x * drag; v.y -= v.y * drag; v.z -= v.z * drag;

  if (b.spin !== 0) {
    const ax = -v.z * b.spin, az = v.x * b.spin;
    v.x += ax * dt;
    v.z += az * dt;
    b.spin *= Math.exp(-0.6 * dt);
    if (Math.abs(b.spin) < 0.005) b.spin = 0;
  }

  p.x += v.x * dt; p.y += v.y * dt; p.z += v.z * dt;

  b.grounded = false;
  if (p.y <= R) {
    p.y = R;
    if (v.y < -1.0) {
      v.y = -v.y * BOUNCE;
      v.x *= 0.88; v.z *= 0.88;
      b.spin *= 0.6;
    } else {
      v.y = 0;
      b.grounded = true;
      const h = Math.hypot(v.x, v.z);
      if (h > 0) {
        const nh = Math.max(0, h - ROLL_DECEL * dt);
        v.x *= nh / h; v.z *= nh / h;
      }
      b.spin *= Math.exp(-3 * dt);
    }
  }

  let hit: BallHit = null;
  for (const side of [-1, 1]) {
    const h = collideGoal(b, side, prevX);
    if (h) hit = h;
  }
  return hit;
}

function collideGoal(b: Ball, side: number, prevX: number): BallHit {
  const p = b.pos;
  const v = b.vel;
  const hl = PITCH.halfLength;
  const gx = side * hl;
  const minD = R + GOAL.postRadius;
  let hit: BallHit = null;

  // Entering through the goal mouth.
  if (b.inGoal === 0 && side * prevX <= hl && side * p.x > hl &&
      Math.abs(p.z) < GOAL.halfWidth && p.y < GOAL.height) {
    b.inGoal = side;
  }

  // Posts (vertical cylinders).
  if (p.y < GOAL.height + R) {
    for (const zp of [-GOAL.halfWidth, GOAL.halfWidth]) {
      const dx = p.x - gx, dz = p.z - zp;
      const d = Math.hypot(dx, dz);
      if (d < minD && d > 1e-6) {
        const nx = dx / d, nz = dz / d;
        const vn = v.x * nx + v.z * nz;
        if (vn < 0) { v.x -= 1.7 * vn * nx; v.z -= 1.7 * vn * nz; }
        p.x = gx + nx * minD; p.z = zp + nz * minD;
        hit = 'post';
      }
    }
  }

  // Crossbar (horizontal cylinder along z).
  if (Math.abs(p.z) < GOAL.halfWidth) {
    const dx = p.x - gx, dy = p.y - GOAL.height;
    const d = Math.hypot(dx, dy);
    if (d < minD && d > 1e-6) {
      const nx = dx / d, ny = dy / d;
      const vn = v.x * nx + v.y * ny;
      if (vn < 0) { v.x -= 1.7 * vn * nx; v.y -= 1.7 * vn * ny; }
      p.x = gx + nx * minD; p.y = GOAL.height + ny * minD;
      hit = 'bar';
    }
  }

  // Net: once inside, the ball is caught by the back, side and roof netting.
  if (b.inGoal === side) {
    const back = hl + GOAL.depth - R;
    if (side * p.x > back) {
      p.x = side * back; v.x = -v.x * 0.1; v.y *= 0.5; v.z *= 0.5; hit = 'net';
    }
    const sw = GOAL.halfWidth - R;
    if (Math.abs(p.z) > sw) { p.z = Math.sign(p.z) * sw; v.z = -v.z * 0.1; v.x *= 0.6; }
    const roof = GOAL.height - R;
    if (p.y > roof) { p.y = roof; v.y = -Math.abs(v.y) * 0.1; }
  }
  return hit;
}
