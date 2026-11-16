import * as THREE from 'three';
import { FOLLOW_THROUGH, legPhase, TOUCH_WINDOW, type Player } from '../sim/player';
import { wrapAngle } from '../sim/math';
import { B, HIP_Y, LEG } from './skeleton';

/**
 * Procedural player animation.
 *
 * Layers, in order:
 *  1. Locomotion: each foot follows a stance/swing path along the direction of travel (so
 *     running, backpedalling and side-steps all come from one gait), and the legs are solved
 *     with two-bone IK so the stance foot stays on the ground while the hips bounce, sway and lean.
 *  2. Ball work: dribble touches, kick wind-up, strike and follow-through move the foot targets.
 *  3. Whole-body poses (slide tackle, dive, celebrations…) blended in with eased weights.
 *  4. A short smoothing filter on every joint, so no pose ever pops.
 *
 * Root space: x forward (the facing direction), y up, z to the player's right.
 */
export interface AnimExtra {
  dive?: number;
  hold?: boolean;
  /** The match ball; the head follows it and the feet reach for it. */
  ball?: { pos: { x: number; y: number; z: number }; vel: { x: number; z: number }; ownerId: number };
}

const S = THREE.MathUtils.smoothstep;
const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const frac = (x: number) => x - Math.floor(x);
const TAU = Math.PI * 2;
const COUNT = 16;
const L1 = LEG.thigh, L2 = LEG.shin;
/** The ball is drawn larger than it really is; feet aim for the surface of the ball you see. */
const BALL_R = 0.187;
/** Where the ankle goes for the inside of the foot to meet a ball at (bx, bz) in the body frame. */
const meet = (out: THREE.Vector3, bx: number, bz: number) =>
  out.set(clamp(bx - BALL_R - 0.08, -0.1, 0.56), 0.1, clamp(bz, -0.46, 0.46));

// Scratch objects.
const E = new THREE.Euler();
const Q = new THREE.Quaternion(), Q2 = new THREE.Quaternion();
const V = new THREE.Vector3(), POLE = new THREE.Vector3(), AXIS = new THREE.Vector3(), DIR = new THREE.Vector3();
const X = new THREE.Vector3(), Y = new THREE.Vector3(), JOINT = new THREE.Vector3();
const M = new THREE.Matrix4();
const ZAXIS = new THREE.Vector3(0, 0, 1);

interface Foot { pos: THREE.Vector3; pitch: number; toeOut: number }

export class Animator {
  private q = Array.from({ length: COUNT }, () => new THREE.Quaternion());
  private hip = new THREE.Vector3(0, HIP_Y, 0);
  private hipQ = new THREE.Quaternion();
  private hipQi = new THREE.Quaternion();
  private feet: Foot[] = [
    { pos: new THREE.Vector3(), pitch: 0, toeOut: 0 },
    { pos: new THREE.Vector3(), pitch: 0, toeOut: 0 },
  ];
  private first = true;
  private clock = Math.random() * 10;
  private vf = 0;
  private vs = 0;
  private pvf = 0;
  private af = 0;
  private prevFacing = 0;
  private roll = 0;
  private headYaw = 0;
  private headPitch = 0;
  private touchPrev = 0;
  private touchAt = new THREE.Vector3(0.35, 0.1, 0);
  private kickAt = new THREE.Vector3(0.42, 0, 0.08);
  private diveSign = 1;
  private tiltX = 0;
  private tiltY = 0;
  /** Eased weights of the whole-body poses. */
  private w: Record<string, number> = {};

  constructor(private bones: THREE.Bone[], private tilt: THREE.Group) {}

  private ease(name: string, on: boolean, dt: number, up = 16, down = 8): number {
    const cur = this.w[name] ?? 0;
    const next = cur + ((on ? 1 : 0) - cur) * (1 - Math.exp(-dt * (on ? up : down)));
    return (this.w[name] = next < 0.001 && !on ? 0 : next);
  }

  /** Set a joint target from Euler angles (x roll, y yaw, z pitch; applied z first). */
  private set(bone: number, x: number, y: number, z: number): void {
    this.q[bone].setFromEuler(E.set(x, y, z));
  }
  /** Blend a joint toward Euler angles by weight w. */
  private mix(bone: number, x: number, y: number, z: number, w: number): void {
    if (w <= 0) return;
    this.q[bone].slerp(Q.setFromEuler(E.set(x, y, z)), Math.min(1, w));
  }

  update(p: Player, extra: AnimExtra, dtIn: number): void {
    const dt = Math.min(Math.max(dtIn, 0), 0.05);
    this.clock += dt;
    const cf = Math.cos(p.facing), sf = Math.sin(p.facing);

    // ---- velocity in the body frame (forward, right), lightly smoothed ----
    const rvf = p.vel.x * cf + p.vel.z * sf, rvs = -p.vel.x * sf + p.vel.z * cf;
    const kv = this.first ? 1 : 1 - Math.exp(-dt * 14);
    this.vf += (rvf - this.vf) * kv;
    this.vs += (rvs - this.vs) * kv;
    if (dt > 0) this.af += (clamp((rvf - this.pvf) / dt, -25, 25) - this.af) * (1 - Math.exp(-dt * 5));
    this.pvf = rvf;
    const sp = Math.hypot(this.vf, this.vs);
    const run = S(sp, 0.25, 1.6);           // fades the stride in from a standstill
    const amp = clamp(sp / 8.5, 0, 1);      // 0 standing … 1 flat-out sprint
    const dx = sp > 0.05 ? this.vf / sp : 1, dz = sp > 0.05 ? this.vs / sp : 0;
    const fwd = Math.max(0, dx);            // how much of the motion is forward running

    // Lean into turns.
    let dF = p.facing - this.prevFacing;
    while (dF > Math.PI) dF -= TAU;
    while (dF < -Math.PI) dF += TAU;
    this.prevFacing = p.facing;
    const turnRate = dt > 0 && !this.first ? dF / dt : 0;
    this.roll += (clamp(turnRate * sp * 0.02, -0.3, 0.3) - this.roll) * Math.min(1, dt * 8);
    const accelLean = clamp(this.af * 0.016, -0.12, 0.22) * (1 - (this.w.kick ?? 0));

    // ---- ball in the body frame ----
    let bx = 0.45, bz = 0, by = 0.11, bDist = 99, hasBall = false, owner = false;
    let brx = 0, brz = 0; // ball velocity relative to the player, in the body frame
    if (extra.ball) {
      const b = extra.ball;
      const wx = b.pos.x - p.pos.x, wz = b.pos.z - p.pos.z;
      bx = wx * cf + wz * sf; bz = -wx * sf + wz * cf; by = b.pos.y;
      const vx = b.vel.x - p.vel.x, vz = b.vel.z - p.vel.z;
      brx = vx * cf + vz * sf; brz = -vx * sf + vz * cf;
      bDist = Math.hypot(bx, bz);
      hasBall = true;
      owner = b.ownerId === p.id;
    }

    // ---- states ----
    const gk = p.role === 'gk';
    const wTackle = this.ease('tackle', p.tackleAnim > 0, dt, 30, 7);
    const wStumble = this.ease('stumble', p.stumble > 0 && p.tackleAnim <= 0, dt, 18, 7);
    const wHold = this.ease('hold', !!extra.hold, dt, 14, 8);
    if (extra.dive) this.diveSign = Math.sign(extra.dive) || 1;
    const wDive = this.ease('dive', !!extra.dive, dt, 22, 5);
    const ready = this.ease('ready', gk && amp < 0.35 && !extra.hold && !extra.dive && !p.celebrate, dt, 8, 6);
    // Defenders shuffling sideways or backwards stay low, like a jockeying stance.
    const jockey = this.ease('jockey', !gk && sp > 0.8 && sp < 5.5 && dx < 0.5 && !p.celebrate, dt, 7, 5);
    const low = Math.max(ready, 0.6 * jockey);
    const charging = this.ease('charge', !!p.charge.kind, dt, 10, 10);
    const moving = sp > 2.5;
    const c = p.celebrate;
    const wAir = this.ease('air', c === 1 && p.celebPose === 1 && moving, dt, 6, 5);
    const wKneel = this.ease('kneel', c === 1 && p.celebPose === 2 && !moving, dt, 9, 5);
    const wJump = this.ease('jump', (c === 1 && p.celebPose !== 2 && !moving) || (c === 2 && !moving), dt, 8, 5);
    const wArmsUp = this.ease('armsUp', (c === 1 && !(p.celebPose === 1 && moving)) || (c === 2 && !moving), dt, 7, 5);
    const wOneArm = this.ease('oneArm', c === 2 && moving, dt, 6, 6);
    const wSlump = this.ease('slump', c === 3, dt, 3, 4);

    // ---- kick timeline ----
    const winding = !!p.windFire;
    const kt = p.kickAnim > 0 ? clamp(1 - p.kickAnim / FOLLOW_THROUGH, 0, 1) : -1; // 0 = contact … 1 = done
    const kicking = winding || kt >= 0;
    const kind = winding ? p.windKind : p.kickKind;
    const big = kind === 'shoot' ? 1 : kind === 'lob' ? 0.85 : kind === 'through' ? 0.7 : 0.55;
    const ks = p.kickFoot;
    const windQ = winding ? clamp(1 - p.windT / Math.max(0.01, p.windMax), 0, 1) : 0;
    const wKick = this.ease('kick', kicking && (kt < 0 || kt < 0.6), dt, 40, 9);
    // The wind-up draws the leg back, then swings it down so the foot meets the ball as it is struck.
    const backAmt = winding ? S(windQ, 0, 0.5) : 0;                      // leg drawn back
    // The swing runs a little ahead of the clock, so that after joint smoothing the boot is on the ball as it leaves.
    const windLead = winding ? clamp(1 - (p.windT - 0.045) / Math.max(0.01, p.windMax), 0, 1) : 0;
    // (If the ball is not quite there when the swing ends, the foot waits at the ball rather than drawing back again.)
    const hitAmt = winding ? S(windLead, 0.45, 1) : kt >= 0 ? 1 : 0; // foot arriving at the ball
    const throughAmt = kt >= 0 ? S(kt, 0, 0.32) : 0;                     // swung through
    if (winding && hasBall && bDist < 1.3) this.kickAt.set(clamp(bx, 0.1, 0.75), 0, clamp(bz, -0.5, 0.5));
    else if (kt >= 0 && dF !== 0) {
      // The body turned as the ball was struck: the spot where it was struck stays put on the grass.
      const cd = Math.cos(dF), sd = Math.sin(dF), kx = this.kickAt.x, kz = this.kickAt.z;
      this.kickAt.set(kx * cd + kz * sd, 0, -kx * sd + kz * cd);
    }
    // Direction of the kick relative to the body (0 = straight ahead, positive = to the right).
    const aim = kicking && p.windAim !== null ? clamp(wrapAngle(p.windAim - p.facing), -1.6, 1.6) : 0;
    const ca = Math.cos(aim), sa = Math.sin(aim);

    // ---- dribble touch / first touch: remember where the ball was met ----
    if (p.touchAnim > this.touchPrev + 0.01) {
      if (hasBall && bDist < 1.4) meet(this.touchAt, bx, bz);
      else this.touchAt.set(0.3, 0.1, p.touchFoot * 0.1);
    }
    this.touchPrev = p.touchAnim;
    const tt = p.touchAnim > 0 ? clamp(1 - p.touchAnim / 0.22, 0, 1) : 1;
    const wTouch = this.ease('touch', p.touchAnim > 0 && !kicking && tt < 0.55, dt, 45, 14);
    // Standing on the ball: one sole rests on top of it while the player waits.
    const wSole = this.ease('sole', owner && !kicking && !extra.hold && sp < 0.9 && bDist < 0.8 && by < 0.2 && bx > 0.1, dt, 7, 16);

    // ---- gait ----
    const stride = 1.6 + sp * 0.35;                           // metres per full cycle (matches the sim)
    const contact = Math.min(stride * 0.5, 0.5 + 0.3 * amp);  // ground covered while a foot is planted
    const D = contact / stride;                               // share of the cycle spent on the ground
    const xF = contact * 0.36, xB = -contact * 0.64;          // foot lands ahead of the hip, leaves behind it
    const liftScale = 0.4 + 0.6 * amp;
    const liftEnd = 0.2 * S(-xB, 0.12, 0.5) * liftScale;
    const uL = frac(p.runPhase / 2);
    // Feet land near the midline when running, wider when low or side-stepping (so the legs do not cross).
    const zBase = lerp(0.11, 0.055, run) + 0.1 * low + 0.12 * Math.abs(dz) * run;
    const jumpJ = Math.abs(Math.sin(this.clock * 6.5 + p.id));

    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -1 : 1;
      const u = frac(uL + (i === 0 ? 0 : 0.5));
      let along: number, y: number, pitch: number;
      if (u < D) {
        // Stance: the foot travels straight back under the body; the heel peels up at the end.
        const t = u / D;
        along = lerp(xF, xB, t);
        y = 0.2 * S(-along, 0.12, 0.5) * liftScale;
        pitch = -Math.asin(clamp(y / 0.17, 0, 0.95)) + 0.22 * (1 - amp) * fwd * (1 - S(t, 0, 0.2));
      } else {
        // Swing: heel kicks up behind, the knee drives through, the foot reaches for the ground.
        const wv = (u - D) / (1 - D);
        // The foot comes through early (knee drive), then waits out front for the ground.
        along = lerp(xB, xF, Math.pow(Math.sin(wv * Math.PI / 2), 1.3));
        const H = 0.07 + 0.34 * amp * (0.35 + 0.65 * fwd);
        y = lerp(liftEnd, 0, wv) + H * Math.sin(Math.PI * Math.pow(wv, 0.75));
        const pitchEnd = -Math.asin(clamp(liftEnd / 0.17, 0, 0.95));
        pitch = lerp(pitchEnd, 0.14 * (1 - amp) * fwd, S(wv, 0.3, 0.9)) - 0.45 * amp * Math.sin(Math.PI * wv) * (1 - wv);
      }
      const f = this.feet[i];
      f.pos.set(dx * along * run - 0.02 * s * (1 - run), LEG.ankle + y * run, s * zBase + dz * along * run * 0.7);
      f.pitch = pitch * run;
      f.toeOut = 0.1 + 0.12 * low;
      if (wJump > 0) f.pos.y += Math.max(0, jumpJ * 0.2 - 0.07) * wJump;
    }

    /** 0…1: how far the hips sink to let a foot reach a ball that is a stretch away. */
    let lunge = 0;
    if (wSole > 0) {
      // The ball is drawn larger and lifted so it sits on the grass: aim for the top of what is seen.
      const f = this.feet[p.touchFoot < 0 ? 0 : 1];
      V.set(clamp(bx - 0.07, 0.12, 0.5), by + (BALL_R - 0.11) + BALL_R + 0.072, clamp(bz, -0.3, 0.3));
      f.pos.lerp(V, wSole);
      f.pitch = lerp(f.pitch, -0.1, wSole);
      f.toeOut = lerp(f.toeOut, 0.12, wSole);
    }

    // Reaching for the ball before it is touched, so foot and ball meet instead of the foot chasing.
    if (hasBall && !kicking && p.touchAnim <= 0 && by < 0.45) {
      if (owner && run > 0.3 && bx > 0.1 && bx < 0.9 && Math.abs(bz) < 0.42 && brx <= 0.6) {
        // Dribbling: the sim touches the ball as a foot swings through (TOUCH_WINDOW), so the leg
        // that is coming forward bends its swing to arrive at the ball right then.
        for (let i = 0; i < 2; i++) {
          const u = legPhase(p, i === 0 ? -1 : 1);
          const wA = S(u, TOUCH_WINDOW.from - 0.2, TOUCH_WINDOW.from) * (1 - S(u, TOUCH_WINDOW.to, 1));
          if (wA <= 0) continue;
          const f = this.feet[i];
          f.pos.lerp(meet(V, bx, bz), wA);
          f.toeOut = lerp(f.toeOut, 0.5, wA);
          f.pitch = lerp(f.pitch, 0.05, wA);
        }
      } else if (!owner && bDist < 2.2) {
        // Receiving: when the ball is about to arrive, the nearer foot goes out to where it will be met.
        const closing = -(bx * brx + bz * brz) / Math.max(0.01, bDist);
        const eta = closing > 1.5 ? (bDist - 0.55) / closing : 9;
        if (eta < 0.32) {
          const px = bx + brx * Math.max(0, eta), pz = bz + brz * Math.max(0, eta);
          const wA = (1 - S(eta, 0.06, 0.32)) * S(px, -0.1, 0.15);
          const side = (Math.abs(pz) > 0.05 ? pz : bz) < 0 ? 0 : 1;
          const f = this.feet[side];
          meet(V, px, pz);
          lunge = Math.max(lunge, wA * S(Math.hypot(V.x, V.z - (side ? 1 : -1) * LEG.hipHalf), 0.26, 0.5));
          f.pos.lerp(V, wA);
          f.toeOut = lerp(f.toeOut, 0.6, wA);
          f.pitch = lerp(f.pitch, 0.05, wA);
        }
      }
    }

    // Dribble touch: the inside of the foot meets the ball, then pushes through.
    if (wTouch > 0) {
      const f = this.feet[p.touchFoot < 0 ? 0 : 1];
      V.copy(this.touchAt); V.x += 0.14 * tt;
      // A ball that is a stretch away: the hips drop so the leg can get there.
      lunge = Math.max(lunge, wTouch * S(Math.hypot(V.x, V.z - p.touchFoot * LEG.hipHalf), 0.26, 0.5));
      f.pos.lerp(V, wTouch);
      f.toeOut = lerp(f.toeOut, 0.55, wTouch);
      f.pitch = lerp(f.pitch, 0.05, wTouch);
    }

    // Kick: plant beside the ball, draw the leg back, strike through the ball, follow through.
    if (wKick > 0) {
      const kf = this.feet[ks < 0 ? 0 : 1], pf = this.feet[ks < 0 ? 1 : 0];
      const k = this.kickAt, side = kind === 'pass' || kind === 'through';
      // Standing foot beside the ball.
      V.set(clamp(k.x - 0.3, -0.05, 0.25), LEG.ankle, clamp(k.z - ks * 0.3, -0.34, 0.34));
      pf.pos.lerp(V, wKick);
      pf.pitch = lerp(pf.pitch, 0, wKick);
      // Kicking foot: back → ball → follow-through.
      const backX = -0.22 - 0.26 * big, backY = 0.28 + 0.27 * big;
      // The ankle stops short of the ball by the ball's (drawn) radius plus the part of the foot that strikes it.
      // The swing is laid out along the kick's direction (x toward the target, z across it), then turned to the body.
      const kx = k.x * ca + k.z * sa, kz = -k.x * sa + k.z * ca;
      const hitX = kx - BALL_R - (side ? 0.07 : 0.12), hitY = side ? 0.11 : kind === 'lob' ? 0.1 : 0.17;
      const folX = kind === 'shoot' ? 0.74 : kind === 'lob' ? 0.6 : 0.56 + 0.1 * (big - 0.55);
      const folY = kind === 'shoot' ? 0.6 : kind === 'lob' ? 0.56 : 0.26 + 0.3 * (big - 0.55);
      let tx = lerp(backX, hitX, hitAmt), ty = lerp(backY, hitY, hitAmt * hitAmt), tz = lerp(kz + ks * 0.06, kz, hitAmt);
      tx = lerp(tx, folX, throughAmt); ty = lerp(ty, folY, throughAmt);
      tz = lerp(tz, kind === 'shoot' ? kz - ks * 0.1 : kz, throughAmt);
      V.set(tx * ca - tz * sa, ty, tx * sa + tz * ca);
      const wk = kt < 0 ? wKick * backAmt : wKick;
      kf.pos.lerp(V, wk);
      kf.toeOut = lerp(kf.toeOut, clamp((side ? 1.15 : 0.15) + ks * aim, -0.6, 1.7), wk);
      kf.pitch = lerp(kf.pitch, side ? 0.05 : kind === 'lob' ? -0.25 : -0.8 + 0.5 * throughAmt, wk);
    }

    // ---- hips ----
    const stanceL = Math.cos(TAU * (uL - D / 2));                 // +1 mid-stance left, −1 mid-stance right
    const idle = 1 - run;
    const sway = Math.sin(this.clock * 0.6) * idle;
    let hipY = HIP_Y - 0.012 - 0.05 * amp * run - 0.09 * low
      - 0.032 * run * (0.5 + 0.5 * amp) * Math.cos(2 * TAU * (uL - D / 2))
      - 0.05 * big * wKick * (1 - throughAmt * 0.6) - 0.04 * wTouch - 0.05 * wStumble - 0.16 * lunge;
    if (wJump > 0) hipY += (jumpJ * 0.2 - 0.05) * wJump;
    hipY = lerp(hipY, 0.27, wTackle);
    hipY = lerp(hipY, 0.45, wKneel);
    const kickYaw = wKick * big * (-ks * 0.38 * backAmt * (1 - hitAmt) + ks * 0.34 * throughAmt);
    const hipYaw = -(0.07 + 0.1 * amp) * run * Math.cos(TAU * uL) * (dx >= 0 ? 1 : -1) + kickYaw;
    const hipRoll = this.roll * 0.6 + 0.045 * run * stanceL + 0.03 * sway;
    const hipPitch = -(0.03 + 0.09 * amp) * run * fwd - accelLean * 0.5 - 0.06 * low + 0.08 * wKick * throughAmt;
    // With a foot up on the ball the weight sits over the other leg and the sway stops.
    this.hip.set(-0.02 * wKick * backAmt * (1 - hitAmt) + 0.03 * wSole, hipY, -0.018 * run * stanceL + this.roll * 0.2 + 0.022 * sway * (1 - wSole) - p.touchFoot * 0.035 * wSole);
    this.hipQ.setFromEuler(E.set(hipRoll, hipYaw, hipPitch));
    this.hipQi.copy(this.hipQ).invert();
    this.q[B.Root].identity();
    this.q[B.Hips].copy(this.hipQ);

    // ---- legs ----
    this.solveLeg(-1, this.feet[0]);
    this.solveLeg(1, this.feet[1]);

    // ---- trunk: shoulders counter the hips, the chest breathes, the head stays level ----
    const breath = Math.sin(this.clock * 1.5) * 0.012 * (1 - 0.5 * run);
    const kickLean = wKick * (kind === 'lob' ? 0.2 : kind === 'shoot' ? -0.14 + 0.2 * throughAmt : -0.06);
    const spineYaw = -1.7 * hipYaw * (1 - 0.5 * wKick);
    const spinePitch = -(0.04 + 0.12 * amp) * run * fwd - accelLean * 0.5 - 0.16 * low + kickLean
      - 0.07 * wTouch - 0.06 * charging - 0.45 * wStumble;
    this.set(B.Spine, this.roll * 0.4 - hipRoll * 0.8, spineYaw, spinePitch);
    this.set(B.Chest, 0, 0, breath);

    // Head: cancel the trunk's twist and lean, then look at the ball.
    let yawT = 0, pitchT = 0;
    if (hasBall && bDist > 0.3 && !c) {
      const ang = Math.atan2(bz, bx);
      if (Math.abs(ang) < 2.5) yawT = clamp(-ang, -1.2, 1.2);
      // A player in control glances at the ball rather than staring at his feet.
      pitchT = clamp(Math.atan2(by - 1.62, bDist), -0.75, 0.45) * (owner && bDist < 1.2 ? 0.45 : 1);
    }
    const kh = this.first ? 1 : 1 - Math.exp(-dt * 9);
    this.headYaw += (yawT - this.headYaw) * kh;
    this.headPitch += (pitchT - this.headPitch) * kh;
    const level = -(hipPitch + spinePitch) * 0.55;
    this.set(B.Neck, 0, -(hipYaw + spineYaw) + 0.4 * this.headYaw, level + 0.35 * this.headPitch);
    this.set(B.Head, 0, 0.6 * this.headYaw, 0.65 * this.headPitch);

    // ---- arms: swing against the legs, elbows bend more at speed, hands cross toward the midline ----
    const th = TAU * (uL + 0.04);
    const A = (0.22 + 0.5 * amp) * run;
    const elbow = 0.22 + (0.95 + 0.35 * amp) * run * (1 - 0.5 * low) + 0.35 * low;
    const out = 0.1 + 0.05 * amp + 0.42 * low + 0.25 * wTouch + 0.2 * charging + 0.5 * wStumble;
    const cs = Math.cos(th);
    const fwdArm = 0.38 * low + 0.5 * wStumble;
    this.set(B.ArmL, out, -0.35 * run, -A * cs - 0.08 * run + fwdArm);
    this.set(B.ArmR, -out, 0.35 * run, A * cs - 0.08 * run + fwdArm);
    this.set(B.ElbowL, 0, 0, elbow - 0.28 * run * cs);
    this.set(B.ElbowR, 0, 0, elbow + 0.28 * run * cs);
    if (wKick > 0) {
      // The arm opposite the kicking leg reaches forward and out for balance, then sweeps back.
      const opp = ks < 0 ? B.ArmR : B.ArmL, same = ks < 0 ? B.ArmL : B.ArmR;
      const os = ks < 0 ? -1 : 1; // sign of "out" for the opposite arm
      const bk = kt < 0 ? backAmt : 1 - throughAmt;
      this.mix(opp, os * (0.7 + 0.3 * big), 0, 0.75 * big * bk - 0.35 * throughAmt, wKick);
      this.mix(same, -os * 0.5, 0, -0.55 * big * bk + 0.45 * throughAmt, wKick);
    }

    // ---- whole-body poses ----
    if (wTackle > 0) {
      // Slide tackle: sitting low and leaning back, leading leg stretched along the grass,
      // trailing leg folded under, one hand reaching back for the ground.
      this.mix(B.Hips, 0.12, 0, 0.55, wTackle);
      this.mix(B.ThighR, 0, 0, 1.05, wTackle); this.mix(B.KneeR, 0, 0, -0.08, wTackle); this.mix(B.AnkleR, 0, 0, 0.35, wTackle);
      this.mix(B.ThighL, 0.25, 0, 0.5, wTackle); this.mix(B.KneeL, 0, 0, -1.9, wTackle); this.mix(B.AnkleL, 0, 0, -0.5, wTackle);
      this.mix(B.Spine, 0, 0, -0.25, wTackle);
      this.mix(B.Neck, 0, 0, -0.2, wTackle);
      this.mix(B.ArmL, 0.5, 0, -0.9, wTackle); this.mix(B.ElbowL, 0, 0, 0.2, wTackle);
      this.mix(B.ArmR, -0.8, 0, 0.3, wTackle); this.mix(B.ElbowR, 0, 0, 0.6, wTackle);
    }
    if (wHold > 0) {
      this.mix(B.ArmL, 0, 0, 1.1, wHold); this.mix(B.ArmR, 0, 0, 1.1, wHold);
      this.mix(B.ElbowL, 0, 0, 0.9, wHold); this.mix(B.ElbowR, 0, 0, 0.9, wHold);
    }
    if (wDive > 0) {
      // Sideways dive: the whole body tips toward the ball, arms stretched overhead.
      this.mix(B.ArmL, 0.15, 0, 3.0, wDive); this.mix(B.ArmR, -0.15, 0, 3.0, wDive);
      this.mix(B.ElbowL, 0, 0, 0.05, wDive); this.mix(B.ElbowR, 0, 0, 0.05, wDive);
      this.mix(B.ThighL, 0, 0, 0, wDive); this.mix(B.ThighR, 0, 0, 0.25, wDive);
      this.mix(B.KneeL, 0, 0, -0.2, wDive); this.mix(B.KneeR, 0, 0, -0.5, wDive);
      this.mix(B.Hips, 0, 0, 0, wDive); this.mix(B.Spine, 0, 0, 0, wDive);
    }
    if (wAir > 0) {
      // Airplane: arms out wide, banking through the run.
      this.mix(B.ArmL, 1.45, 0, 0.15, wAir); this.mix(B.ArmR, -1.45, 0, 0.15, wAir);
      this.mix(B.ElbowL, 0, 0, 0.1, wAir); this.mix(B.ElbowR, 0, 0, 0.1, wAir);
    }
    if (wArmsUp > 0) {
      const spread = 0.3 + 0.25 * wKneel, pump = wJump * (0.6 - jumpJ * 0.6);
      this.mix(B.ArmL, spread, 0, 2.75, wArmsUp); this.mix(B.ArmR, -spread, 0, 2.75, wArmsUp);
      this.mix(B.ElbowL, 0, 0, 0.3 + pump, wArmsUp); this.mix(B.ElbowR, 0, 0, 0.3 + pump, wArmsUp);
    }
    if (wOneArm > 0) {
      this.mix(B.ArmR, -0.2, 0, 2.6, wOneArm); this.mix(B.ElbowR, 0, 0, 0.3, wOneArm);
    }
    if (wKneel > 0) {
      // Knee slide finish: kneeling, leaning back, arms to the sky.
      for (const [th2, kn, an] of [[B.ThighL, B.KneeL, B.AnkleL], [B.ThighR, B.KneeR, B.AnkleR]]) {
        this.mix(th2, 0, 0, 0.15, wKneel); this.mix(kn, 0, 0, -1.75, wKneel); this.mix(an, 0, 0, -0.6, wKneel);
      }
      this.mix(B.Hips, 0, 0, 0, wKneel);
      this.mix(B.Spine, 0, 0, 0.35, wKneel); this.mix(B.Neck, 0, 0, 0.25, wKneel);
    }
    if (wSlump > 0) {
      // Conceding side: head down, shoulders slumped, arms hanging.
      this.mix(B.Spine, 0, 0, -0.3, wSlump); this.mix(B.Neck, 0, 0, -0.45, wSlump); this.mix(B.Head, 0, 0, -0.1, wSlump);
      this.mix(B.ArmL, 0.06, 0, 0.05, wSlump); this.mix(B.ArmR, -0.06, 0, 0.05, wSlump);
      this.mix(B.ElbowL, 0, 0, 0.1, wSlump); this.mix(B.ElbowR, 0, 0, 0.1, wSlump);
    }

    // ---- apply through a short smoothing filter ----
    const snap = this.first || dtIn > 0.2;
    // A kicking leg moves fast: let it follow its target more tightly.
    const kLeg = snap ? 1 : 1 - Math.exp(-dt * lerp(42, 95, wKick)), kBody = snap ? 1 : 1 - Math.exp(-dt * 26);
    for (let i = 0; i < COUNT; i++) this.bones[i].quaternion.slerp(this.q[i], i >= B.ThighL ? kLeg : kBody);
    this.bones[B.Hips].position.lerp(this.hip, kLeg);
    const tiltX = this.diveSign * 1.3 * wDive + (this.roll * 2 + Math.sin(this.clock * 2.2) * 0.12) * wAir;
    this.tiltX += (tiltX - this.tiltX) * kBody;
    this.tiltY += (0.2 * wDive - this.tiltY) * kBody;
    this.tilt.rotation.set(this.tiltX, 0, 0);
    this.tilt.position.y = this.tiltY;
    this.first = false;
  }

  /** Two-bone IK: place the ankle of leg s (−1 left, 1 right) on the foot target, knee toward the toes. */
  private solveLeg(s: number, f: Foot): void {
    const thigh = s < 0 ? B.ThighL : B.ThighR, knee = s < 0 ? B.KneeL : B.KneeR, ankle = s < 0 ? B.AnkleL : B.AnkleR;
    JOINT.set(0, -LEG.hipDrop, s * LEG.hipHalf).applyQuaternion(this.hipQ).add(this.hip);
    V.copy(f.pos).sub(JOINT).applyQuaternion(this.hipQi);
    const d = clamp(V.length(), 0.2, L1 + L2 - 0.004);
    V.normalize();
    const alpha = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
    const flex = Math.PI - Math.acos(clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1));
    POLE.set(Math.cos(f.toeOut), 0, s * Math.sin(f.toeOut));
    AXIS.crossVectors(V, POLE);
    if (AXIS.lengthSq() < 1e-6) AXIS.set(0, 0, 1);
    AXIS.normalize();
    DIR.copy(V).applyAxisAngle(AXIS, alpha);
    // Thigh frame: −y along the thigh, z along the knee hinge.
    Y.copy(DIR).negate();
    X.crossVectors(Y, AXIS);
    this.q[thigh].setFromRotationMatrix(M.makeBasis(X, Y, AXIS));
    this.q[knee].setFromAxisAngle(ZAXIS, -flex);
    // Foot orientation is given in root space (toe-out yaw, then pitch).
    Q.copy(this.hipQ).multiply(this.q[thigh]).multiply(this.q[knee]).invert();
    Q2.setFromEuler(E.set(0, -s * f.toeOut, f.pitch, 'YZX'));
    this.q[ankle].copy(Q).multiply(Q2);
    E.order = 'XYZ';
  }
}
