import type { Ball } from './ball';
import { GOAL, PITCH } from './constants';
import { clamp, type V2 } from './math';
import { ballDistance, footPoint, seek, type Player } from './player';
import type { Match } from './match';

/**
 * carrier: on the ball. receive: the pass is coming to him. support: comes to offer a pass.
 * run: a forward stretching the defence. press: goes for the ball. cover: stands between the
 * ball and the goal. mark: stays goal-side of one opponent. shape: holds his position.
 */
export type Role = 'carrier' | 'press' | 'cover' | 'receive' | 'support' | 'run' | 'mark' | 'shape';

export type AiDecision =
  | { type: 'move'; mx: number; mz: number; sprint: boolean }
  | { type: 'shoot'; dir: V2; power: number }
  | { type: 'pass'; target: Player; kind: 'pass' | 'through' | 'lob' }
  | { type: 'tackle'; mx: number; mz: number };

const HL = PITCH.halfLength;

/** Where a player stands in the team shape, given ball position and possession. */
export function formationTarget(m: Match, p: Player): V2 {
  const dir = m.dir(p.team);
  const b = m.ball.pos;
  const ballT = b.x * dir;
  const owner = m.owner();
  const attacking = owner ? owner.team === p.team : false;
  // Out of possession the whole team drops and squeezes, forwards included.
  let x = attacking ? p.slot.x * 31 + ballT * 0.58 + 9 : p.slot.x * 22 + ballT * 0.55 - 6;
  if (!attacking && p.slot.x < -0.4) x = Math.min(x, ballT - 6); // last defender stays goal-side
  // Forwards hold the offside line instead of standing beyond it.
  if (m.offside) x = Math.min(x, m.offsideLine(p.team) - 0.8);
  x = clamp(x, -46, 44);
  const width = attacking ? 26 : 18;
  // Slot z is in team space (left of the attack direction is negative).
  const z = clamp(p.slot.z * width * dir + b.z * 0.35, -31, 31);
  return { x: x * dir, z };
}

/** Closest point on the (straight-line) future path of the ball to `p`. */
export function interceptPoint(b: Ball, p: Player): V2 {
  const vx = b.vel.x, vz = b.vel.z;
  const v2 = vx * vx + vz * vz;
  if (v2 < 4) return { x: b.pos.x, z: b.pos.z };
  const t = clamp(((p.pos.x - b.pos.x) * vx + (p.pos.z - b.pos.z) * vz) / v2, 0, 2.5);
  return { x: b.pos.x + vx * t, z: b.pos.z + vz * t };
}

function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax, vz = bz - az;
  const l2 = vx * vx + vz * vz;
  const t = l2 > 0 ? clamp(((px - ax) * vx + (pz - az) * vz) / l2, 0, 1) : 0;
  return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
}

/** Score passing to `q`; higher is better. */
export function passScore(m: Match, p: Player, q: Player): number {
  const dir = m.dir(p.team);
  const d = Math.hypot(q.pos.x - p.pos.x, q.pos.z - p.pos.z);
  if (d < 5 || d > 40) return -Infinity;
  if (m.offside && q.pos.x * dir > m.offsideLine(p.team)) return -Infinity;
  const opps = m.opponentsOf(p.team);
  let open = 10, lane = 99;
  for (const o of opps) {
    open = Math.min(open, Math.hypot(o.pos.x - q.pos.x, o.pos.z - q.pos.z));
    lane = Math.min(lane, distToSegment(o.pos.x, o.pos.z, p.pos.x, p.pos.z, q.pos.x, q.pos.z));
  }
  const progress = (q.pos.x - p.pos.x) * dir;
  let s = progress * 0.15 + open * 0.35 - d * 0.03;
  // From out wide near the goal line, the ball goes into the box.
  const depth = HL - p.pos.x * dir, qDepth = HL - q.pos.x * dir;
  if (depth < 20 && Math.abs(p.pos.z) > 15 && qDepth < 18 && Math.abs(q.pos.z) < 12) s += 2.5;
  // A teammate standing on a line is a poor target: the ball tends to run out.
  if (Math.abs(q.pos.z) > PITCH.halfWidth - 2.5 || Math.abs(q.pos.x) > HL - 3) s -= 3;
  // Longer passes give defenders more time to step into the lane.
  const need = 1.2 + d * 0.05;
  if (lane < need) s -= 4;
  else if (lane < need + 1.5) s -= 1.5;
  return s;
}

function nearestOpponentDist(m: Match, p: Player): number {
  let best = 99;
  for (const o of m.opponentsOf(p.team)) best = Math.min(best, Math.hypot(o.pos.x - p.pos.x, o.pos.z - p.pos.z));
  return best;
}

/** Decision for the AI player on the ball. */
export function aiCarrier(m: Match, p: Player, dt: number): AiDecision {
  const dir = m.dir(p.team);
  const gx = dir * HL;
  const dGoal = Math.hypot(gx - p.pos.x, p.pos.z);
  const nearOpp = nearestOpponentDist(m, p);

  p.think -= dt;
  if (p.think > 0) return { type: 'move', mx: p.aiDir.x, mz: p.aiDir.z, sprint: nearOpp > 4 };
  p.think = (0.22 + m.rng() * 0.18) / m.skill[p.team];

  // Shoot when in range with a reasonable angle.
  if (dGoal < 26 && Math.abs(p.pos.z) < 18) {
    const chance = dGoal < 16 ? 1 : nearOpp < 3 ? 0.6 : 0.3;
    if (m.rng() < chance) {
      const gk = m.keeperFacing(p.team).p;
      const postSide = gk.pos.z > 0.3 ? -1 : gk.pos.z < -0.3 ? 1 : (m.rng() < 0.5 ? -1 : 1);
      // Aim error grows with distance and pressure, so long shots often miss.
      const err = (0.6 + dGoal * 0.07 + (nearOpp < 2 ? 0.8 : 0)) * (1.15 - p.stats.shoot / 99) / m.skill[p.team];
      const aimZ = postSide * (GOAL.halfWidth - 0.6 - m.rng() * 0.8) + (m.rng() - 0.5) * 2 * err * 3.0;
      const dx = gx - p.pos.x, dz = aimZ - p.pos.z;
      const L = Math.hypot(dx, dz);
      const power = clamp(0.45 + dGoal / 45, 0.5, 0.85);
      return { type: 'shoot', dir: { x: dx / L, z: dz / L }, power };
    }
  }

  // Compare the best pass with carrying the ball on.
  let best: Player | null = null, bestScore = -Infinity;
  for (const q of m.teammatesOf(p)) {
    const s = passScore(m, p, q);
    if (s > bestScore) { bestScore = s; best = q; }
  }
  const pressured = nearOpp < 3.2;
  const dribbleScore = (pressured ? -1.5 : 0.6) + Math.min(nearOpp, 12) * 0.12;
  if (best && bestScore > dribbleScore + 0.6) {
    const d = Math.hypot(best.pos.x - p.pos.x, best.pos.z - p.pos.z);
    const ahead = (best.pos.x - p.pos.x) * dir;
    const kind = d > 26 ? 'lob' : ahead > 6 && best.slot.x > 0 ? 'through' : 'pass';
    return { type: 'pass', target: best, kind };
  }

  // Dribble toward goal, steering around opponents in front.
  let hx = gx - p.pos.x, hz = -p.pos.z * 0.4;
  const hl = Math.hypot(hx, hz);
  hx /= hl; hz /= hl;
  for (const o of m.opponentsOf(p.team)) {
    const ox = o.pos.x - p.pos.x, oz = o.pos.z - p.pos.z;
    const d = Math.hypot(ox, oz);
    if (d > 7 || d < 0.01) continue;
    if (ox * hx + oz * hz < 0) continue; // behind
    // Perpendicular to the heading, pointing away from the opponent.
    let px = -hz, pz = hx;
    if (px * ox + pz * oz > 0) { px = -px; pz = -pz; }
    const w = ((7 - d) / 7) * 1.4;
    hx += px * w; hz += pz * w;
  }
  // Stay inside the pitch.
  if (Math.abs(p.pos.z) > PITCH.halfWidth - 4) hz -= Math.sign(p.pos.z) * 1.2;
  const L = Math.hypot(hx, hz) || 1;
  p.aiDir = { x: hx / L, z: hz / L };
  return { type: 'move', mx: p.aiDir.x, mz: p.aiDir.z, sprint: nearOpp > 4 };
}

/** Decision for an AI player without the ball. */
export function aiOffBall(m: Match, p: Player, role: Role, dt: number): AiDecision {
  const b = m.ball;
  switch (role) {
    case 'press': {
      const owner = m.owner();
      if (owner && owner.team !== p.team && !b.held) {
        const d = ballDistance(p, b);
        // A booked player avoids tackling from behind.
        let diff = Math.abs(p.facing - owner.facing) % (Math.PI * 2);
        if (diff > Math.PI) diff = Math.PI * 2 - diff;
        const careful = p.yellow > 0 && diff < 0.9;
        if (!careful && d < 1.3 && p.tackleCooldown === 0 && m.rng() < 2.2 * m.skill[p.team] * dt) {
          const i = seek(p, b.pos.x, b.pos.z, 0.5);
          return { type: 'tackle', mx: i.x, mz: i.z };
        }
        // Approach the ball, aiming slightly ahead of the dribbler.
        const f = footPoint(owner);
        const t = seek(p, f.x + owner.vel.x * 0.3, f.z + owner.vel.z * 0.3, 0.8);
        return { type: 'move', mx: t.x, mz: t.z, sprint: d > 2.5 };
      }
      const ip = interceptPoint(b, p);
      const t = seek(p, ip.x, ip.z, 0.6);
      return { type: 'move', mx: t.x, mz: t.z, sprint: true };
    }
    case 'cover': {
      const own = -m.dir(p.team) * HL;
      const dx = own - b.pos.x, dz = -b.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      const k = Math.min(7, d * 0.5);
      const t = seek(p, b.pos.x + (dx / d) * k, b.pos.z + (dz / d) * k);
      const far = Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z) > 12;
      return { type: 'move', mx: t.x, mz: t.z, sprint: far };
    }
    case 'receive': {
      const ip = interceptPoint(b, p);
      const t = seek(p, ip.x, ip.z, 0.6);
      return { type: 'move', mx: t.x, mz: t.z, sprint: true };
    }
    case 'support': {
      // Come and offer a pass: pick a spot about ten metres from the ball that is open, has a
      // clear line to it and is not where a teammate already stands. Reconsidered twice a second.
      const owner = m.owner() ?? (b.intendedId >= 0 ? m.players[b.intendedId] : null);
      if (!owner || owner.team !== p.team) return aiOffBall(m, p, 'shape', dt);
      p.aiSpotT -= dt;
      const stale = Math.hypot(p.aiSpot.x - owner.pos.x, p.aiSpot.z - owner.pos.z);
      if (p.aiSpotT <= 0 || stale < 5 || stale > 17) {
        p.aiSpotT = 0.5;
        const dir = m.dir(p.team);
        const line = m.offside ? m.offsideLine(p.team) - 0.8 : HL - 3;
        const opps = m.opponentsOf(p.team), mates = m.teammatesOf(p).filter((q) => q !== owner);
        let bestS = -Infinity;
        for (const deg of [35, -35, 80, -80, 125, -125, 180, 0]) {
          const a = (deg * Math.PI) / 180;
          const R = deg === 0 ? 13 : 10;
          const x = owner.pos.x + Math.cos(a) * R * dir, z = owner.pos.z + Math.sin(a) * R;
          if (Math.abs(z) > PITCH.halfWidth - 2 || Math.abs(x) > HL - 2 || x * dir > line) continue;
          let open = 9, lane = 9, crowd = 0;
          for (const o of opps) {
            open = Math.min(open, Math.hypot(o.pos.x - x, o.pos.z - z));
            lane = Math.min(lane, distToSegment(o.pos.x, o.pos.z, owner.pos.x, owner.pos.z, x, z));
          }
          for (const q of mates) if (Math.hypot(q.pos.x - x, q.pos.z - z) < 6) crowd++;
          const s = open * 0.9 + Math.cos(a) * 2.2 + (lane < 1.5 ? -4 : 0) - crowd * 2.5
            - Math.hypot(p.pos.x - x, p.pos.z - z) * 0.12;
          if (s > bestS) { bestS = s; p.aiSpot = { x, z }; }
        }
        if (bestS === -Infinity) p.aiSpot = formationTarget(m, p);
      }
      const t = seek(p, p.aiSpot.x, p.aiSpot.z, 2);
      return { type: 'move', mx: t.x, mz: t.z, sprint: Math.hypot(p.aiSpot.x - p.pos.x, p.aiSpot.z - p.pos.z) > 8 };
    }
    case 'run': {
      // A forward stretching the defence: stay on the shoulder of the last defender, well ahead
      // of the ball, in the gap between the defenders nearest his channel.
      const owner = m.owner() ?? (b.intendedId >= 0 ? m.players[b.intendedId] : null);
      if (!owner || owner.team !== p.team) return aiOffBall(m, p, 'shape', dt);
      const dir = m.dir(p.team);
      const ft = formationTarget(m, p);
      const line = m.offside ? m.offsideLine(p.team) - 0.7 : HL - 9;
      const x = clamp(Math.max(ft.x * dir, owner.pos.x * dir + 13), -HL + 4, Math.min(line, HL - 7));
      let z = ft.z;
      // Step off the nearest defender on that line, toward the bigger gap.
      let near: Player | null = null, nd = 5;
      for (const o of m.opponentsOf(p.team)) {
        if (Math.abs(o.pos.x * dir - x) > 6) continue;
        const d = Math.abs(o.pos.z - z);
        if (d < nd) { nd = d; near = o; }
      }
      if (near) z = clamp(z + (z >= near.pos.z ? 1 : -1) * (5 - nd), -PITCH.halfWidth + 3, PITCH.halfWidth - 3);
      const t = seek(p, x * dir, z, 2);
      return { type: 'move', mx: t.x, mz: t.z, sprint: Math.hypot(x * dir - p.pos.x, z - p.pos.z) > 7 };
    }
    case 'mark': {
      // Stay goal-side of one opponent, a step toward the ball, tighter the nearer he is to goal.
      const o = m.players[p.aiMark];
      if (!o || o.sentOff || o.team === p.team) return aiOffBall(m, p, 'shape', dt);
      const gx = -m.dir(p.team) * HL;
      const gdx = gx - o.pos.x, gdz = -o.pos.z, gd = Math.hypot(gdx, gdz) || 1;
      const bdx = b.pos.x - o.pos.x, bdz = b.pos.z - o.pos.z, bd = Math.hypot(bdx, bdz) || 1;
      const gap = clamp(gd * 0.06, 1.0, 2.6);
      // The pass is coming to him: get to it first if that is possible, otherwise get tight.
      if (b.ownerId === -1 && b.intendedId === o.id) {
        const ip = interceptPoint(b, p);
        const mine = Math.hypot(ip.x - p.pos.x, ip.z - p.pos.z), his = Math.hypot(ip.x - o.pos.x, ip.z - o.pos.z);
        if (mine < his + 1) { const t = seek(p, ip.x, ip.z, 0.6); return { type: 'move', mx: t.x, mz: t.z, sprint: true }; }
      }
      const x = o.pos.x + (gdx / gd) * gap + (bdx / bd) * 0.7 + o.vel.x * 0.25;
      const z = o.pos.z + (gdz / gd) * gap + (bdz / bd) * 0.7 + o.vel.z * 0.25;
      const t = seek(p, x, z, 1.5);
      return { type: 'move', mx: t.x, mz: t.z, sprint: Math.hypot(x - p.pos.x, z - p.pos.z) > 6 };
    }
    case 'shape':
    default: {
      const ft = formationTarget(m, p);
      const owner = m.owner();
      if (owner && owner.team === p.team) {
        // Get open: drift away from the nearest marker so the carrier has an option.
        let best: Player | null = null, bd = 6;
        for (const o of m.opponentsOf(p.team)) {
          const d = Math.hypot(o.pos.x - ft.x, o.pos.z - ft.z);
          if (d < bd) { bd = d; best = o; }
        }
        if (best) {
          const dx = ft.x - best.pos.x, dz = ft.z - best.pos.z;
          const L = Math.hypot(dx, dz) || 1;
          const push = 6 - bd;
          ft.x += (dx / L) * push;
          ft.z = clamp(ft.z + (dz / L) * push, -31, 31);
          if (m.offside) {
            const dir = m.dir(p.team);
            ft.x = dir * Math.min(ft.x * dir, m.offsideLine(p.team) - 0.8);
          }
        }
      }
      const t = seek(p, ft.x, ft.z, 3);
      const far = Math.hypot(ft.x - p.pos.x, ft.z - p.pos.z) > 8;
      return { type: 'move', mx: t.x, mz: t.z, sprint: far };
    }
  }
}
