import { createBall, placeBall, stepBall, type Ball, type Team } from './ball';
import { aiCarrier, aiOffBall, formationTarget, interceptPoint, passScore, type AiDecision, type Role } from './ai';
import { BALL_RADIUS as R, BOX, GOAL, GRAVITY, PITCH } from './constants';
import { createKeeper, keeperTakeBall, keeperThrow, resetKeeper, updateKeeper, type Keeper, keeperDive } from './keeper';
import { clamp, wrapAngle, type V2 } from './math';
import {
  ballDistance, canControl, createPlayer, dribble, firstTouch, footFor, footPoint, KICK_GATHER, KICK_TURN, kickAcross, kickReady, kickSpot, movePlayer, readKickInput, seek, shoot, strike, tickTimers,
  type Actions, type KickKind, type Player,
} from './player';
import { createRng, type Rng } from './rng';
import { buildRoster, pickLineup, slotCategory, type RosterPlayer } from './roster';
import { FORMATIONS, matchKits, otherTeam, TEAMS, type Kit, type TeamDef } from './team';

export type Phase = 'ready' | 'play' | 'goal' | 'out' | 'halftime' | 'fulltime';
export type MatchEvent =
  | 'goal_home' | 'goal_away' | 'save' | 'post' | 'shot' | 'tackle' | 'block'
  | 'throw' | 'corner' | 'goalkick' | 'kickoff' | 'halftime' | 'fulltime' | 'extratime'
  | 'foul' | 'penalty' | 'offside' | 'yellow' | 'red' | 'sub'
  | 'shootout' | 'pen_goal' | 'pen_saved' | 'pen_missed' | 'header';
export type Difficulty = 'easy' | 'normal' | 'hard';

type Restart =
  | { kind: 'kickoff'; team: Team }
  | { kind: 'goalkick'; team: Team }
  | { kind: 'penalty'; team: Team; taker?: number }
  | { kind: 'shootout' }
  | { kind: 'throw' | 'corner' | 'freekick'; team: Team; x: number; z: number };

export interface MatchConfig {
  home: TeamDef;
  away: TeamDef;
  homeFormation: string;
  awayFormation: string;
  /** Real seconds for a full 90-minute match. */
  seconds: number;
  offside: boolean;
  /** Teams controlled by a person. Empty = AI vs AI. */
  humans: Team[];
  /** Human teams that get control assistance (shot aim, auto power, wider passes). */
  assist: Team[];
  /** Strength of AI-only teams. */
  difficulty: Difficulty;
  /**
   * Knock-out match: if level at full time, extra time is played until the next goal, and if
   * nobody scores it goes to a penalty shoot-out, taken kick by kick.
   */
  decider?: boolean;
  /** Squads to use instead of the clubs' built-in ones (club development mode). */
  rosters?: Partial<Record<Team, RosterPlayer[]>>;
  /** Teams whose roster is already in order: its first eleven start, slot by slot (a hand-picked eleven). */
  lineupGiven?: Team[];
  /** Optional per-team AI level override (tests, demo). */
  levels?: Partial<Record<Team, Difficulty>>;
  /**
   * Easy control: control passes sooner to whoever is nearer the ball, and holding a defending
   * button (press or tackle) sends the player to the ball by himself; he only tackles within reach.
   */
  easyControl?: boolean;
  seed: number;
}

export const DEFAULT_CONFIG: MatchConfig = {
  home: TEAMS[0], away: TEAMS[3],
  homeFormation: TEAMS[0].formation, awayFormation: TEAMS[3].formation,
  seconds: 300, offside: true, humans: ['home'], assist: [], difficulty: 'normal', easyControl: true, seed: 20261115,
};

/** Inputs for each human-controlled team this tick. */
export type TeamActions = Partial<Record<Team, Actions>>;

export interface Squad {
  bench: RosterPlayer[];
  subsLeft: number;
  /** Substitutions waiting for the next stoppage. */
  queue: { outId: number; benchIdx: number }[];
}

/** Last card or substitution, for the HUD to describe. */
export interface Notice { team: Team; text: string }

const NO_INPUT: Actions = { mx: 0, mz: 0, sprint: false, held: new Set(), down: new Set(), up: new Set() };
/** A quick tap on shoot (no real charge) gets this power from readKickInput. */
const TAP_POWER = 0.16;
const MAX_SUBS = 3;
/** Seconds of goal celebration before the kickoff (any button skips). */
export const GOAL_TIME = 5.5;
/** Extra time as a share of the match: 30 of 90 minutes. */
export const EXTRA_TIME = 1 / 3;
const SKILL: Record<Difficulty, number> = { easy: 0.6, normal: 1, hard: 1.35 };
const STAT_SHIFT: Record<Difficulty, number> = { easy: -10, normal: 0, hard: 7 };

/**
 * An 11-a-side match. Each human team controls one outfield player at a time;
 * everyone else is AI. No rendering code lives here.
 */
export class Match {
  readonly ball: Ball = createBall();
  readonly players: Player[] = [];
  readonly keepers: Record<Team, Keeper>;
  readonly teams: Record<Team, TeamDef>;
  /** What each side wears today: the away side changes if the shirts would clash. */
  readonly kits: Record<Team, Kit>;
  readonly squads: Record<Team, Squad>;
  readonly config: MatchConfig;
  readonly humans: ReadonlySet<Team>;
  readonly assist: ReadonlySet<Team>;
  /** AI sharpness per team (decision speed, tackling, finishing). */
  readonly skill: Record<Team, number>;
  readonly score = { home: 0, away: 0 };
  readonly shots = { home: 0, away: 0 };
  readonly cards = { home: { yellow: 0, red: 0 }, away: { yellow: 0, red: 0 } };
  readonly matchSeconds: number;
  readonly offside: boolean;
  time = 0;
  half: 1 | 2 = 1;
  /** Knock-out matches only: sudden-death extra time is being played. */
  extraTime = false;
  /** Knock-out matches only: the shoot-out score (it counts up while the shoot-out is on). */
  shootout: { home: number; away: number } | null = null;
  /**
   * The shoot-out in progress: whose turn it is, each side's kicks so far (true = scored), and
   * the kick itself (`live` once struck, with seconds left to see how it ends).
   */
  pens: { turn: Team; kicks: Record<Team, boolean[]>; order: Record<Team, number[]>; taker: number; live: boolean; timer: number } | null = null;
  /** Second half: teams have swapped ends. */
  flipped = false;
  phase: Phase = 'ready';
  phaseTimer = 0;
  /** Player id each human team controls. */
  readonly ctrl: Record<Team, number> = { home: 0, away: 0 };
  /**
   * A human team's player was just switched to and the stick has not been moved yet: he runs
   * for the ball by himself instead of standing still. Any stick movement takes over.
   */
  readonly autoRun: Record<Team, boolean> = { home: false, away: false };
  private lastCtrl: Record<Team, number> = { home: -1, away: -1 };
  /** Seconds before control may switch by itself again (longer after the player switched by hand). */
  private switchLock: Record<Team, number> = { home: 0, away: 0 };
  /** Seconds the stick has been at rest. */
  private idle: Record<Team, number> = { home: 0, away: 0 };
  /** 'defend' when the opponent has the ball: pass = press, shoot = tackle. */
  readonly mode: Record<Team, 'attack' | 'defend'> = { home: 'attack', away: 'attack' };
  readonly rng: Rng;
  events: MatchEvent[] = [];
  notices: Notice[] = [];
  /** The most recent goal, for the HUD and the celebration camera. */
  lastGoal: { team: Team; scorerId: number; minute: number; own: boolean } | null = null;
  private celebSpot = { x: 0, z: 0 };
  private restart: Restart | null = null;
  private postCooldown = 0;
  private lastOwnerTeam: Team | null = null;
  private firstHalfKickoff: Team = 'home';
  /** Free-kick wall: players held in place until the kick is taken. */
  private wall: { id: number; x: number; z: number }[] = [];
  private wallKickId = -1;
  private tick = 0;
  private playSinceRestart = 0;
  private quickRestarts = 0;

  constructor(config: Partial<MatchConfig> = {}) {
    const c = { ...DEFAULT_CONFIG, ...config };
    this.config = c;
    this.rng = createRng(c.seed);
    this.matchSeconds = c.seconds;
    this.offside = c.offside;
    this.humans = new Set(c.humans);
    this.assist = new Set(c.assist);
    this.teams = { home: c.home, away: c.away };
    this.kits = matchKits(c.home.kit, c.away.kit);
    // Difficulty only changes teams the AI plays for a human opponent.
    const vsHuman = c.humans.length > 0;
    const level = (t: Team): Difficulty => c.levels?.[t] ?? (vsHuman && !this.humans.has(t) ? c.difficulty : 'normal');
    this.skill = { home: SKILL[level('home')], away: SKILL[level('away')] };

    const squads = {} as Record<Team, Squad>;
    const reflex = {} as Record<Team, number>;
    let id = 0;
    for (const team of ['home', 'away'] as const) {
      const formation = FORMATIONS[team === 'home' ? c.homeFormation : c.awayFormation] ?? FORMATIONS['4-4-2'];
      const roster = c.rosters?.[team] ?? buildRoster(this.teams[team]);
      const { starters, bench } = c.lineupGiven?.includes(team) && roster.length >= formation.length
        ? { starters: roster.slice(0, formation.length), bench: roster.slice(formation.length) }
        : pickLineup(roster, formation);
      const shift = STAT_SHIFT[level(team)];
      formation.forEach((s, i) => {
        const p = createPlayer(id++, team, s.role, s.slot, 0, { speed: 0, dribble: 0, pass: 0, shoot: 0, defense: 0, stamina: 0 });
        this.assign(p, starters[i], shift);
        p.posLabel = s.pos;
        this.players.push(p);
      });
      squads[team] = { bench, subsLeft: MAX_SUBS, queue: [] };
      reflex[team] = clamp(starters[0].reflex + shift * 1.5, 40, 95);
    }
    this.squads = squads;
    this.keepers = {
      home: createKeeper(this.gkOf('home'), -1, reflex.home),
      away: createKeeper(this.gkOf('away'), 1, reflex.away),
    };
    this.setupKickoff('home');
  }

  /** Put a squad member into a player slot. */
  private assign(p: Player, r: RosterPlayer, shift = 0): void {
    const s = r.stats;
    const adj = (v: number) => clamp(v + shift, 30, 99);
    p.name = r.name;
    p.number = r.number;
    p.look = { ...r.look };
    p.stats = { speed: adj(s.speed), dribble: adj(s.dribble), pass: adj(s.pass), shoot: adj(s.shoot), defense: adj(s.defense), stamina: adj(s.stamina) };
    p.energy = 1;
    p.yellow = 0;
    p.version++;
  }

  // ---------- queries used by AI, UI and tests ----------
  /** +1 if `team` attacks toward x = +52.5 right now. */
  dir(team: Team): 1 | -1 {
    const d = team === 'home' ? 1 : -1;
    return (this.flipped ? -d : d) as 1 | -1;
  }
  /** Player 1's controlled player (home). */
  get controlledId(): number { return this.ctrl.home; }
  get controlled(): Player { return this.players[this.ctrl.home]; }
  isHuman(team: Team): boolean { return this.humans.has(team); }
  owner(): Player | null { return this.ball.ownerId >= 0 ? this.players[this.ball.ownerId] : null; }
  gkOf(team: Team): Player { return this.players.find((p) => p.team === team && p.role === 'gk')!; }
  fieldOf(team: Team): Player[] { return this.players.filter((p) => p.team === team && p.role === 'field' && !p.sentOff); }
  teammatesOf(p: Player): Player[] { return this.fieldOf(p.team).filter((q) => q !== p); }
  opponentsOf(team: Team): Player[] { return this.players.filter((p) => p.team !== team && !p.sentOff); }
  /** The keeper a team shoots at. */
  keeperFacing(team: Team): Keeper { return this.keepers[otherTeam(team)]; }
  get clockMinute(): number { return Math.min(this.extraTime ? 120 : 90, Math.floor((this.time / this.matchSeconds) * 90)); }
  /** The side that won, counting a shoot-out; null while level (or drawn). */
  get winner(): Team | null {
    const s = this.shootout && this.score.home === this.score.away ? this.shootout : this.score;
    return s.home > s.away ? 'home' : s.away > s.home ? 'away' : null;
  }

  /**
   * Offside line for `team` in its own attacking frame (x · dir):
   * the second-last opponent or the ball, never inside its own half.
   */
  offsideLine(team: Team): number {
    const dir = this.dir(team);
    const xs = this.opponentsOf(team).map((p) => p.pos.x * dir).sort((a, b) => b - a);
    return Math.max(xs[1] ?? 0, this.ball.pos.x * dir, 0);
  }

  // ---------- substitutions ----------
  /** Queue a substitution; it happens at the next stoppage. Returns false if not allowed. */
  requestSub(team: Team, outId: number, benchIdx: number): boolean {
    const sq = this.squads[team];
    const out = this.players[outId];
    const inn = sq.bench[benchIdx];
    if (!out || !inn || out.team !== team || out.sentOff) return false;
    if (sq.subsLeft - sq.queue.length <= 0) return false;
    if ((out.role === 'gk') !== (inn.cat === 'GK')) return false;
    if (sq.queue.some((q) => q.outId === outId || q.benchIdx === benchIdx)) return false;
    sq.queue.push({ outId, benchIdx });
    return true;
  }

  private applySubs(): void {
    for (const team of ['home', 'away'] as const) {
      const sq = this.squads[team];
      // Remove from the bench in descending index order so indices stay valid.
      const queue = [...sq.queue].sort((a, b) => b.benchIdx - a.benchIdx);
      sq.queue = [];
      for (const { outId, benchIdx } of queue) {
        const out = this.players[outId];
        const inn = sq.bench[benchIdx];
        if (!inn || out.sentOff || sq.subsLeft <= 0) continue;
        const leaving: RosterPlayer = {
          name: out.name, number: out.number, cat: out.role === 'gk' ? 'GK' : slotCategory(out.posLabel),
          stats: { ...out.stats }, reflex: 0, look: out.look,
        };
        sq.bench.splice(benchIdx, 1);
        sq.bench.push(leaving); // shown as used; cannot come back on
        sq.subsLeft--;
        this.notices.push({ team, text: `교체 · OUT ${out.number} ${out.name} · IN ${inn.number} ${inn.name}` });
        this.assign(out, inn, STAT_SHIFT[this.skill[team] < 1 ? 'easy' : this.skill[team] > 1 ? 'hard' : 'normal']);
        this.events.push('sub');
      }
    }
  }

  /** AI managers bring on fresh legs after the hour mark. */
  private aiSubs(): void {
    if (this.clockMinute < 55) return;
    for (const team of ['home', 'away'] as const) {
      if (this.isHuman(team)) continue;
      const sq = this.squads[team];
      if (sq.subsLeft - sq.queue.length <= 0) continue;
      const tired = this.fieldOf(team)
        .filter((p) => p.energy < 0.55 && !sq.queue.some((q) => q.outId === p.id))
        .sort((a, b) => a.energy - b.energy)[0];
      if (!tired) continue;
      const cat = slotCategory(tired.posLabel);
      const queued = new Set(sq.queue.map((q) => q.benchIdx)); // by index: edited names may repeat
      let idx = sq.bench.findIndex((r, i) => r.cat === cat && !queued.has(i) && i < sq.bench.length - (MAX_SUBS - sq.subsLeft));
      if (idx < 0) idx = sq.bench.findIndex((r, i) => r.cat !== 'GK' && !queued.has(i) && i < sq.bench.length - (MAX_SUBS - sq.subsLeft));
      if (idx >= 0) this.requestSub(team, tired.id, idx);
    }
  }

  // ---------- set pieces ----------
  private setupKickoff(team: Team): void {
    placeBall(this.ball, 0, 0);
    this.ball.lastTouch = null;
    for (const p of this.players) {
      if (p.sentOff) continue;
      const dir = this.dir(p.team);
      p.vel.x = 0; p.vel.z = 0;
      p.facing = dir > 0 ? 0 : Math.PI;
      p.charge = { kind: null, t: 0 };
      p.pending = null;
      p.stumble = 0;
      p.celebrate = 0;
      if (p.role === 'gk') continue;
      let x = Math.min(p.slot.x * 32 - 3, -1.5);
      if (p.team !== team && Math.abs(p.slot.z) < 0.45) x = Math.min(x, -10);
      p.pos.x = x * dir;
      p.pos.z = p.slot.z * 26 * dir; // mirror sides when ends are switched
    }
    for (const k of Object.values(this.keepers)) resetKeeper(k);
    // The most advanced player of the kicking team stands on the ball.
    const st = this.fieldOf(team).reduce((a, b) => (b.slot.x > a.slot.x ? b : a));
    st.pos.x = -0.6 * this.dir(team);
    st.pos.z = 0;
    this.giveTo(st);
    this.events.push('kickoff');
    this.enter('ready', 1.2, null);
  }

  /** Hand the ball to `p` for a restart and point every human at the action. */
  private giveTo(p: Player): void {
    this.ball.ownerId = p.id;
    this.ball.lastTouch = p.team;
    this.lastOwnerTeam = p.team;
    p.think = 0.6;
    // He stands still until his first decision: carrying on in the direction he was last dribbling
    // took the ball straight out of play from a corner or a throw-in.
    p.aiDir = { x: 0, z: 0 };
    p.setPiece = 0;
    for (const team of this.humans) {
      this.ctrl[team] = team === p.team ? p.id : this.nearestField(team, this.ball.pos).id;
    }
  }

  /** Move opponents of `team` at least `r` meters from the ball. */
  private clearArea(team: Team, r: number): void {
    const b = this.ball.pos;
    for (const o of this.opponentsOf(team)) {
      if (o.role === 'gk') continue;
      const dx = o.pos.x - b.x, dz = o.pos.z - b.z;
      const d = Math.hypot(dx, dz);
      if (d < r) {
        const ox = -this.dir(o.team);
        const nx = d > 0.01 ? dx / d : ox, nz = d > 0.01 ? dz / d : 0;
        o.pos.x = clamp(b.x + nx * r, -PITCH.halfLength, PITCH.halfLength);
        o.pos.z = clamp(b.z + nz * r, -PITCH.halfWidth, PITCH.halfWidth);
      }
    }
  }

  /** Line up a defensive wall 9.15 m from a free kick within shooting range. */
  private buildWall(attacking: Team): void {
    this.wall = [];
    const b = this.ball.pos;
    const gx = this.dir(attacking) * PITCH.halfLength;
    const d = Math.hypot(gx - b.x, b.z);
    if (d > 32) return;
    const n = d < 22 ? 4 : 3;
    const ux = (gx - b.x) / d, uz = -b.z / d; // toward goal centre
    const px = -uz, pz = ux; // across the line of the shot
    // Shift the wall toward the near post.
    const near = Math.sign(b.z) || 1;
    const shift = (pz * near > 0 ? 1 : -1) * 0.6;
    const defenders = this.fieldOf(otherTeam(attacking))
      .sort((a, c) => Math.hypot(a.pos.x - b.x, a.pos.z - b.z) - Math.hypot(c.pos.x - b.x, c.pos.z - b.z))
      .slice(0, n);
    defenders.forEach((p, i) => {
      const off = (i - (n - 1) / 2) * 0.7 + shift;
      const x = b.x + ux * 9.15 + px * off, z = b.z + uz * 9.15 + pz * off;
      p.pos.x = x; p.pos.z = z;
      p.vel.x = 0; p.vel.z = 0;
      p.facing = Math.atan2(-uz, -ux);
      this.wall.push({ id: p.id, x, z });
    });
    this.wallKickId = this.ball.kickId;
  }

  private applyRestart(r: Restart): void {
    this.applySubs();
    const b = this.ball;
    // Safety net: if restarts keep sending the ball straight back out, hand it to the keeper.
    this.quickRestarts = this.playSinceRestart < 1 ? this.quickRestarts + 1 : 0;
    this.playSinceRestart = 0;
    if (this.quickRestarts >= 5 && (r.kind === 'throw' || r.kind === 'corner')) {
      this.quickRestarts = 0;
      r = { kind: 'goalkick', team: r.team };
    }
    if (r.kind === 'kickoff') { this.setupKickoff(r.team); return; }
    if (r.kind === 'goalkick') {
      const k = this.keepers[r.team];
      resetKeeper(k);
      k.p.pos.x = k.side * (PITCH.halfLength - 5);
      placeBall(b, k.p.pos.x, 0);
      keeperTakeBall(k, b, 1.0);
      this.lastOwnerTeam = r.team;
      for (const team of this.humans) if (team !== r.team) this.ctrl[team] = this.nearestField(team, b.pos).id;
      this.enter('play', 0, null);
      return;
    }
    if (r.kind === 'shootout') { this.nextPenalty(); return; }
    if (r.kind === 'penalty') {
      const dir = this.dir(r.team);
      const spotX = dir * (PITCH.halfLength - 11);
      placeBall(b, spotX, 0);
      const best = this.fieldOf(r.team).reduce((a, c) => (c.stats.shoot > a.stats.shoot ? c : a));
      const named = r.taker === undefined ? null : this.players[r.taker];
      const taker = named && !named.sentOff ? named : best;
      // Everyone else waits outside the box.
      const edge = PITCH.halfLength - BOX.depth - 1.5;
      for (const p of this.players) {
        if (p.role === 'gk' || p === taker || p.sentOff) continue;
        if (p.pos.x * dir > edge) p.pos.x = dir * (edge - this.rng() * 3);
      }
      const k = this.keepers[otherTeam(r.team)];
      resetKeeper(k);
      k.p.pos.x = k.side * (PITCH.halfLength - 0.3);
      // He stands over the ball with it in front of his right foot, so it is struck from the spot.
      taker.pos.x = spotX - dir * 0.43;
      taker.pos.z = -dir * 0.11;
      taker.vel.x = 0; taker.vel.z = 0;
      taker.touchFoot = 1;
      taker.facing = dir > 0 ? 0 : Math.PI;
      this.giveTo(taker);
      taker.think = 0.2;
      this.enter('ready', 1.4, null);
      return;
    }
    placeBall(b, r.x, r.z);
    const taker = this.nearestField(r.team, b.pos);
    const sz = Math.sign(r.z) || 1;
    if (r.kind === 'throw') {
      taker.pos.x = r.x;
      taker.pos.z = sz * (PITCH.halfWidth - 0.1);
      taker.facing = sz > 0 ? -Math.PI / 2 : Math.PI / 2;
      b.pos.z = sz * (PITCH.halfWidth - 0.6);
      this.clearArea(r.team, 5);
    } else if (r.kind === 'corner') {
      const sx = Math.sign(r.x);
      taker.pos.x = sx * (PITCH.halfLength - 0.3);
      taker.pos.z = sz * (PITCH.halfWidth - 0.3);
      taker.facing = Math.atan2(-taker.pos.z, sx * (PITCH.halfLength - 11) - taker.pos.x);
      b.pos.x = taker.pos.x + Math.cos(taker.facing) * 0.5;
      b.pos.z = taker.pos.z + Math.sin(taker.facing) * 0.5;
      this.clearArea(r.team, 9.15);
    } else {
      // Free kick: taker stands behind the ball facing the opponent goal.
      const gx = this.dir(r.team) * PITCH.halfLength;
      const a = Math.atan2(-r.z, gx - r.x);
      taker.facing = a;
      taker.pos.x = r.x - Math.cos(a) * 0.55;
      taker.pos.z = r.z - Math.sin(a) * 0.55;
      this.clearArea(r.team, 9.15);
    }
    taker.vel.x = 0; taker.vel.z = 0;
    this.giveTo(taker);
    taker.setPiece = r.kind === 'throw' ? 1 : r.kind === 'corner' ? 2 : 0;
    if (r.kind === 'freekick') this.buildWall(r.team);
    this.enter('ready', r.kind === 'freekick' ? 1.2 : 0.7, null);
  }

  private enter(phase: Phase, time: number, restart: Restart | null): void {
    if (phase !== 'play') for (const p of this.players) { p.windFire = null; p.windT = 0; }
    this.phase = phase;
    this.phaseTimer = time;
    this.restart = restart;
  }

  /**
   * How far a player is from winning the ball, in metres: the distance to where the ball is
   * going (ahead of a dribbler, or the nearest point of a loose ball's path), plus a handicap
   * for a player the attack has already gone past, who would have to catch up from behind.
   */
  private reach(p: Player): number {
    const b = this.ball;
    const owner = this.owner();
    let tx: number, tz: number;
    if (owner) { tx = owner.pos.x + owner.vel.x * 0.35; tz = owner.pos.z + owner.vel.z * 0.35; }
    else { const ip = interceptPoint(b, p); tx = ip.x; tz = ip.z; }
    let d = Math.hypot(p.pos.x - tx, p.pos.z - tz);
    if (owner && owner.team !== p.team) {
      // Positive when the player is on the wrong side of the ball: further from his own goal than it is.
      const past = (p.pos.x - tx) * this.dir(p.team);
      if (past > 1) d += Math.min(7, past * 0.7);
    }
    return d;
  }

  /** The outfield player of a team best placed to win the ball. */
  private bestPlaced(team: Team, exclude = -1): Player {
    let best = this.fieldOf(team)[0], bd = Infinity;
    for (const p of this.fieldOf(team)) {
      if (p.id === exclude) continue;
      const d = this.reach(p);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  private nearestField(team: Team, at: { x: number; z: number }, exclude = -1): Player {
    let best = this.fieldOf(team)[0], bd = Infinity;
    for (const p of this.fieldOf(team)) {
      if (p.id === exclude) continue;
      const d = Math.hypot(p.pos.x - at.x, p.pos.z - at.z);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  // ---------- kicks ----------
  /** Record who is offside at the moment `team` plays the ball. */
  private markOffside(team: Team, kickerId: number): void {
    const b = this.ball;
    b.offsideIds = [];
    b.offsideTeam = team;
    if (!this.offside) return;
    const dir = this.dir(team);
    const line = this.offsideLine(team);
    for (const p of this.fieldOf(team)) {
      if (p.id !== kickerId && p.pos.x * dir > line + 0.1) b.offsideIds.push(p.id);
    }
  }

  /** Initial velocity that delivers the ball to `to`. */
  private passVelocity(from: V2, to: V2, kind: 'pass' | 'through' | 'lob'): { vx: number; vy: number; vz: number } {
    const dx = to.x - from.x, dz = to.z - from.z;
    const d = Math.max(0.1, Math.hypot(dx, dz));
    if (kind === 'lob') {
      const T = clamp(0.9 + d / 28, 1.0, 2.3);
      const vh = (d / T) * 1.08;
      return { vx: (dx / d) * vh, vy: (GRAVITY * T) / 2, vz: (dz / d) * vh };
    }
    // Firm passes: arrive at 10–12 m/s so defenders have little time to intercept,
    // but softer when the target is near a line so the ball does not run out.
    const nearLine = Math.abs(to.z) > PITCH.halfWidth - 4 || Math.abs(to.x) > PITCH.halfLength - 5;
    // A through ball is driven: it has to beat the defenders to the space, and the runner meets it at speed.
    const through = kind === 'through';
    // (Not so hard that the runner cannot take it: a ball arriving much faster than this bounces off him.)
    const vEnd = nearLine ? (through ? 6.5 : 4.5) : through ? 14 : 10;
    const v0 = clamp(Math.sqrt(vEnd * vEnd + 2 * 1.9 * d), through ? 18 : 14, through ? 34 : 31);
    return { vx: (dx / d) * v0, vy: 0, vz: (dz / d) * v0 };
  }

  private leadPoint(q: Player, kind: 'pass' | 'through' | 'lob'): V2 {
    const dir = this.dir(q.team);
    if (kind === 'through') {
      return {
        x: clamp(q.pos.x + dir * 7 + q.vel.x * 0.55, -PITCH.halfLength + 2, PITCH.halfLength - 2),
        z: clamp(q.pos.z + q.vel.z * 0.55, -PITCH.halfWidth + 2, PITCH.halfWidth - 2),
      };
    }
    const lead = kind === 'lob' ? 0.6 : 0.4;
    return { x: q.pos.x + q.vel.x * lead, z: q.pos.z + q.vel.z * lead };
  }

  /** Direction a pass to `q` will set off in, for the wind-up. */
  private passAim(q: Player, kind: 'pass' | 'through' | 'lob'): number {
    const to = this.leadPoint(q, kind);
    return Math.atan2(to.z - this.ball.pos.z, to.x - this.ball.pos.x);
  }

  private passTo(p: Player, q: Player, kind: 'pass' | 'through' | 'lob'): void {
    const to = this.leadPoint(q, kind);
    const v = this.passVelocity(this.ball.pos, to, kind);
    const spread = 0.015 + (1 - p.stats.pass / 99) * 0.06;
    this.markOffside(p.team, p.id);
    strike(p, this.ball, v.vx, v.vy, v.vz, spread, 0, this.rng);
    this.ball.intendedId = q.id;
    if (this.isHuman(q.team)) this.ctrl[q.team] = q.id;
  }

  private doShot(p: Player, power: number, dir: V2): void {
    this.markOffside(p.team, p.id);
    shoot(p, this.ball, power, dir, this.rng);
    this.shots[p.team]++;
    this.events.push('shot');
  }

  /**
   * Assisted shot: if the player shoots roughly at goal, aim inside the post on the side
   * the stick favours (or away from the keeper); a quick tap picks power from distance.
   */
  assistShot(p: Player, dir: V2, power: number): { dir: V2; power: number } {
    const gx = this.dir(p.team) * PITCH.halfLength;
    const tx = gx - p.pos.x, tz = -p.pos.z;
    const d = Math.hypot(tx, tz);
    if (d > 40 || (dir.x * tx + dir.z * tz) / d < 0.55) return { dir, power };
    // Where the stick direction would cross the goal line.
    const t = Math.abs(dir.x) > 1e-3 ? tx / dir.x : Infinity;
    const zHit = Number.isFinite(t) && t > 0 ? p.pos.z + dir.z * t : 0;
    const gk = this.keeperFacing(p.team).p;
    const side = Math.abs(zHit) > 0.8 ? Math.sign(zHit) : (gk.pos.z > 0 ? -1 : 1);
    const aimZ = side * (GOAL.halfWidth - 0.75);
    const ax = gx - p.pos.x, az = aimZ - p.pos.z;
    const L = Math.hypot(ax, az);
    const auto = clamp(0.45 + d / 50, 0.5, 0.82);
    return { dir: { x: ax / L, z: az / L }, power: power <= TAP_POWER ? auto : Math.min(power, 0.86) };
  }

  /** Human kick: passes look for a teammate in the stick direction. */
  private humanKick(p: Player, kind: KickKind, power: number, dir: V2): void {
    const assist = this.assist.has(p.team);
    if (kind === 'shoot') {
      const s = assist ? this.assistShot(p, dir, power) : { dir, power };
      this.doShot(p, s.power, s.dir);
      return;
    }
    const pref = kind === 'lob' ? 15 + power * 35 : 18;
    const cone = assist ? 0.25 : 0.5;
    let best: Player | null = null, bestScore = -Infinity;
    for (const q of this.teammatesOf(p)) {
      const vx = q.pos.x - p.pos.x, vz = q.pos.z - p.pos.z;
      const d = Math.hypot(vx, vz);
      if (d < 3) continue;
      const cos = (vx * dir.x + vz * dir.z) / d;
      if (cos < cone) continue;
      const s = cos * 2 - Math.abs(d - pref) * 0.03;
      if (s > bestScore) { bestScore = s; best = q; }
    }
    if (best) { this.passTo(p, best, kind); return; }
    // No teammate that way: kick into space.
    this.markOffside(p.team, p.id);
    if (kind === 'lob') {
      strike(p, this.ball, dir.x * (10 + power * 17), 5 + power * 7, dir.z * (10 + power * 17), 0.05, 0, this.rng);
    } else {
      const sp = kind === 'through' ? 31 : 18;
      strike(p, this.ball, dir.x * sp, 0, dir.z * sp, 0.03, 0, this.rng);
    }
  }

  private inOwnBox(p: Player): boolean {
    const own = -this.dir(p.team);
    return p.pos.x * own > PITCH.halfLength - BOX.depth && Math.abs(p.pos.z) < BOX.halfWidth;
  }

  private tackle(t: Player): void {
    const b = this.ball;
    t.tackleAnim = 0.35;
    t.tackleCooldown = 0.9;
    t.vel.x += Math.cos(t.facing) * 2.5;
    t.vel.z += Math.sin(t.facing) * 2.5;
    const carrier = this.owner();
    if (b.held || !carrier || carrier.team === t.team) return;
    const d = ballDistance(t, b);
    const body = Math.hypot(carrier.pos.x - t.pos.x, carrier.pos.z - t.pos.z);
    // Coming in from behind: tackler faces roughly the same way as the carrier.
    let diff = Math.abs(t.facing - carrier.facing) % (Math.PI * 2);
    if (diff > Math.PI) diff = Math.PI * 2 - diff;
    const fromBehind = diff < 0.9;
    let won = false;
    if (d < 1.5) {
      const chance = clamp(0.5 + (t.stats.defense - carrier.stats.dribble) / 120 + (d < 0.8 ? 0.15 : 0), 0.2, 0.85);
      won = this.rng() < chance;
    }
    const foulChance = won ? (fromBehind ? 0.2 : 0.02) : (body < 0.8 ? 0.15 : 0);
    if (this.rng() < foulChance) { this.foul(t, carrier, fromBehind); return; }
    if (won) {
      b.ownerId = -1;
      b.vel.x = Math.cos(t.facing) * 3 + carrier.vel.x * 0.3;
      b.vel.z = Math.sin(t.facing) * 3 + carrier.vel.z * 0.3;
      b.lastTouch = t.team;
      b.kickId++;
      b.offsideIds = [];
      carrier.possessCooldown = 0.7;
      carrier.stumble = 0.3;
      t.possessCooldown = 0;
      this.events.push('tackle');
      return;
    }
    t.stumble = 0.55;
  }

  private foul(t: Player, victim: Player, fromBehind: boolean): void {
    const b = this.ball;
    victim.stumble = 0.6;
    b.ownerId = -1;
    b.vel.x = 0; b.vel.z = 0;
    this.events.push('foul');
    this.book(t, fromBehind);
    if (this.inOwnBox(t)) {
      this.events.push('penalty');
      this.enter('out', 1.6, { kind: 'penalty', team: victim.team });
    } else {
      const x = clamp(b.pos.x, -PITCH.halfLength + 1, PITCH.halfLength - 1);
      const z = clamp(b.pos.z, -PITCH.halfWidth + 1, PITCH.halfWidth - 1);
      this.enter('out', 1.6, { kind: 'freekick', team: victim.team, x, z });
    }
  }

  /** Referee's notebook: yellow cards, second yellows and straight reds. */
  private book(t: Player, fromBehind: boolean): void {
    const r = this.rng();
    const straightRed = fromBehind && r < 0.015;
    const yellow = !straightRed && r < (fromBehind ? 0.3 : 0.1);
    if (!straightRed && !yellow) return;
    if (yellow && t.yellow === 0) {
      t.yellow = 1;
      this.cards[t.team].yellow++;
      this.events.push('yellow');
      this.notices.push({ team: t.team, text: `옐로카드 · ${t.number} ${t.name}` });
      return;
    }
    // Second yellow or straight red: sent off.
    if (yellow) this.cards[t.team].yellow++;
    this.cards[t.team].red++;
    t.sentOff = true;
    t.vel.x = 0; t.vel.z = 0;
    t.pos.x = 0; t.pos.z = PITCH.halfWidth + 6; // off the pitch, by the bench
    this.events.push('red');
    this.notices.push({ team: t.team, text: `${yellow ? '경고 누적 퇴장' : '레드카드'} · ${t.number} ${t.name}` });
    const sq = this.squads[t.team];
    sq.queue = sq.queue.filter((q) => q.outId !== t.id);
    if (this.isHuman(t.team) && this.ctrl[t.team] === t.id) this.ctrl[t.team] = this.nearestField(t.team, this.ball.pos).id;
  }

  private keeperDistribute(k: Keeper): void {
    let best: Player | null = null, bestScore = -Infinity;
    for (const q of this.fieldOf(k.p.team)) {
      const s = passScore(this, k.p, q);
      if (s > bestScore) { bestScore = s; best = q; }
    }
    if (!best || bestScore < -2) {
      best = this.fieldOf(k.p.team).reduce((a, c) => (c.slot.x > a.slot.x ? c : a));
    }
    const d = Math.hypot(best.pos.x - k.p.pos.x, best.pos.z - k.p.pos.z);
    const kind = d > 25 ? 'lob' : 'pass';
    const to = this.leadPoint(best, kind);
    const v = this.passVelocity(this.ball.pos, to, kind);
    this.markOffside(k.p.team, k.p.id);
    keeperThrow(k, this.ball, v.vx, v.vy, v.vz);
    this.ball.kickerId = k.p.id;
    this.ball.intendedId = best.id;
    if (this.isHuman(best.team)) this.ctrl[best.team] = best.id;
  }

  // ---------- stamina ----------
  private updateEnergy(dt: number): void {
    const scale = 300 / this.matchSeconds; // the same tiredness over a short or long match
    for (const p of this.players) {
      if (p.sentOff || p.role === 'gk') continue;
      const sp = Math.hypot(p.vel.x, p.vel.z);
      const fit = 1.5 - p.stats.stamina / 99;
      let d: number;
      if (p.sprinting && sp > 5) d = -0.009 * fit;
      else if (sp > 2.5) d = -0.0016 * fit;
      else d = 0.001;
      p.energy = clamp(p.energy + d * dt * scale, 0.05, 1);
    }
  }

  // ---------- main tick ----------
  step(input: TeamActions, dt: number): void {
    const b = this.ball;
    this.postCooldown = Math.max(0, this.postCooldown - dt);
    for (const p of this.players) tickTimers(p, dt);

    if (this.phase === 'fulltime') return;
    if (this.phase === 'ready') {
      for (const p of this.players) { p.vel.x = 0; p.vel.z = 0; }
      if (b.ownerId >= 0 && !b.held) {
        const o = this.players[b.ownerId];
        b.pos.x = o.pos.x + Math.cos(o.facing) * 0.55;
        b.pos.z = o.pos.z + Math.sin(o.facing) * 0.55;
      }
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0) this.phase = 'play';
      return;
    }
    if (this.phase !== 'play') {
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0 && this.restart) {
        // A goal in extra time ends the match.
        if (this.phase === 'goal' && this.extraTime) { this.events.push('fulltime'); this.enter('fulltime', 0, null); return; }
        this.applyRestart(this.restart);
        return;
      }
    }
    const playing = this.phase === 'play';

    if (playing && this.pens) {
      // Shoot-out: the clock is stopped; a kick that is not taken, or not settled, in time is a miss.
      const pk = this.pens;
      pk.timer -= dt;
      if (!pk.live && b.kickId !== this.pensKickId && b.kickerId === pk.taker) { pk.live = true; pk.timer = 2.6; }
      if (pk.timer <= 0) { this.endPenalty(false, 'pen_missed'); return; }
    } else if (playing) {
      this.time += dt;
      this.playSinceRestart += dt;
      this.updateEnergy(dt);
      this.aiSubs();
      if (this.half === 1 && this.time >= this.matchSeconds / 2) {
        this.half = 2;
        this.events.push('halftime');
        this.enter('halftime', 2.5, { kind: 'kickoff', team: otherTeam(this.firstHalfKickoff) });
        b.ownerId = -1;
        this.switchEnds();
        for (const p of this.players) p.energy = Math.min(1, p.energy + 0.1); // half-time rest
        return;
      }
      const end = this.matchSeconds * (this.extraTime ? 1 + EXTRA_TIME : 1);
      if (this.time >= end) {
        this.time = end;
        if (this.config.decider && this.score.home === this.score.away) {
          if (!this.extraTime) {
            this.extraTime = true;
            this.events.push('extratime');
            this.enter('halftime', 2.5, { kind: 'kickoff', team: this.firstHalfKickoff });
            b.ownerId = -1;
            for (const p of this.players) p.energy = Math.min(1, p.energy + 0.1); // a short rest
            return;
          }
          this.startShootout();
          return;
        }
        this.events.push('fulltime');
        this.enter('fulltime', 0, null);
        return;
      }
    }

    // Possession changes drive automatic player switching for human teams.
    const owner = this.owner();
    const ownerTeam = owner ? owner.team : null;
    if (ownerTeam && ownerTeam !== this.lastOwnerTeam) {
      for (const team of this.humans) if (team !== ownerTeam) this.ctrl[team] = this.nearestField(team, b.pos).id;
      this.lastOwnerTeam = ownerTeam;
    }
    if (owner && owner.role === 'field' && this.isHuman(owner.team)) this.ctrl[owner.team] = owner.id;

    // ----- goal celebration: everyone is choreographed; any button skips it -----
    if (this.phase === 'goal') {
      const skip = [...this.humans].some((t) => (input[t]?.down.size ?? 0) > 0);
      if (skip && this.phaseTimer < GOAL_TIME - 1.2) this.phaseTimer = Math.min(this.phaseTimer, 0.01);
      for (const p of this.players) if (!p.sentOff && p.role === 'field') this.celebrateMove(p, dt);
      for (const team of ['home', 'away'] as const) updateKeeper(this.keepers[team], b, false, dt, this.rng, false);
      stepBall(b, dt);
      return;
    }

    if (playing) this.runWindups(dt);

    // ----- humans -----
    const humanMove = new Map<number, { mx: number; mz: number; sprint: boolean }>();
    for (const team of this.humans) {
      const a = input[team] ?? NO_INPUT;
      this.mode[team] = ownerTeam && ownerTeam !== team ? 'defend' : 'attack';
      const human = this.players[this.ctrl[team]];
      this.switchLock[team] = Math.max(0, this.switchLock[team] - dt);
      const mine = !!owner && owner.team === team;
      const comingToUs = b.ownerId === -1 && b.intendedId >= 0 && this.players[b.intendedId].team === team;
      if (playing && a.down.has('switch')) {
        // By hand: the next best-placed player, and the choice is left alone for a moment.
        if (!(owner && owner.id === human.id)) {
          this.ctrl[team] = this.bestPlaced(team, human.id).id;
          this.switchLock[team] = 1.6;
        }
      } else if (playing && !mine && !comingToUs && this.switchLock[team] === 0) {
        // Without the ball, control goes by itself to whoever is best placed to win it: the
        // nearest to where the ball is going, counting a player the play has gone past as
        // further away. It only changes when someone is clearly better, so it does not flicker.
        const best = this.bestPlaced(team);
        const now = this.reach(human), then = this.reach(best);
        // Easy control: a slightly better-placed player is enough, and pressing a defending button picks the best one at once.
        const easy = !!this.config.easyControl;
        const defendPress = easy && !!owner && owner.team !== team && (a.down.has('pass') || a.down.has('shoot'));
        const better = easy ? then < now - 0.7 && then < now * 0.93 : then < now - 1.6 && then < now * 0.84;
        if (best.id !== human.id && (better || (defendPress && then < now - 0.2))) {
          this.ctrl[team] = best.id;
          this.switchLock[team] = easy ? 0.35 : 0.4;
        }
      }
      const c = this.players[this.ctrl[team]];
      let mx = a.mx, mz = a.mz, sprint = a.sprint;
      // Instinct: whenever the stick is at rest and he does not have the ball, the selected
      // player goes for it himself — closing down an opponent, running onto a loose ball, or
      // offering himself to a teammate. It starts at once after a switch, and a moment after
      // the stick is let go otherwise; any push of the stick takes over again.
      const stick = Math.hypot(a.mx, a.mz) > 0.2;
      this.idle[team] = stick ? 0 : this.idle[team] + dt;
      if (c.id !== this.lastCtrl[team]) { if (this.lastCtrl[team] >= 0 && !stick) this.idle[team] = 1; this.lastCtrl[team] = c.id; }
      this.autoRun[team] = playing && !stick && b.ownerId !== c.id && this.idle[team] > 0.18;
      if (this.autoRun[team]) {
        const theirs = !!owner && owner.team !== team;
        const d = aiOffBall(this, c, theirs ? 'press' : mine ? 'support' : 'receive', dt);
        if (d.type === 'move' || d.type === 'tackle') { mx = d.mx; mz = d.mz; sprint = d.type === 'move' ? d.sprint : true; }
      }
      // Assist: pushing the stick all the way also sprints.
      if (this.assist.has(team) && Math.hypot(a.mx, a.mz) > 0.92) sprint = true;
      if (playing) {
        if (this.mode[team] === 'attack') {
          const req = readKickInput(c, b, a, dt);
          if (req && !c.windFire) {
            // Wind up first; the ball leaves the boot when the swing reaches it.
            const r = req;
            const delay = r.kind === 'shoot' ? (r.power > TAP_POWER ? 0.05 : 0.12) : r.kind === 'lob' ? 0.12 : 0.09;
            this.windup(c, r.kind, delay, () => this.humanKick(c, r.kind, r.power, r.dir), Math.atan2(r.dir.z, r.dir.x));
          }
        } else {
          c.pending = null;
          c.charge = { kind: null, t: 0 };
          if (this.config.easyControl && owner) {
            // Easy control: holding press or tackle sends him at the carrier by himself, and he
            // tackles only when he is within reach (no lunging at thin air from a distance).
            // (A tap shorter than one tick arrives as pressed and released at once, so it counts as held too.)
            const pressHeld = a.held.has('pass') || a.down.has('pass'), tackleHeld = a.held.has('shoot') || a.down.has('shoot');
            const dist = ballDistance(c, b);
            if (pressHeld || tackleHeld) {
              const f = footPoint(owner);
              const s = seek(c, f.x + owner.vel.x * 0.3, f.z + owner.vel.z * 0.3, 0.8);
              if (Math.hypot(a.mx, a.mz) < 0.2) { mx = s.x; mz = s.z; }
              else { mx = (a.mx + s.x) / 2; mz = (a.mz + s.z) / 2; }
              sprint = dist > 2.5 || a.sprint;
            }
            if (tackleHeld && c.tackleCooldown === 0 && dist < 1.3) this.tackle(c);
          } else if (a.held.has('pass') && owner) {
            // Press: run at the ball carrier.
            const s = seek(c, b.pos.x, b.pos.z, 0.8);
            if (Math.hypot(a.mx, a.mz) < 0.2) { mx = s.x; mz = s.z; }
            else { mx = (a.mx + s.x) / 2; mz = (a.mz + s.z) / 2; }
            sprint = true;
          }
          if (!this.config.easyControl && a.down.has('shoot') && c.tackleCooldown === 0) this.tackle(c);
        }
      }
      humanMove.set(c.id, { mx, mz, sprint });
    }
    if (playing && this.phase !== 'play') return; // a human foul stopped play

    // The wall holds its line until the free kick is struck.
    const wallActive = this.wall.length > 0 && b.kickId === this.wallKickId;
    if (!wallActive) this.wall = [];

    // ----- AI -----
    // Alternate which team acts first each tick so neither side always reacts to fresher positions.
    const roles = this.assignRoles();
    this.tick++;
    const order = this.tick % 2 ? this.players : [...this.players].reverse();
    for (const p of order) {
      if (p.role === 'gk' || p.sentOff) continue;
      const hasBall = b.ownerId === p.id;
      const w = wallActive ? this.wall.find((s) => s.id === p.id) : undefined;
      if (w && !humanMove.has(p.id)) {
        p.pos.x = w.x; p.pos.z = w.z; p.vel.x = 0; p.vel.z = 0;
        continue;
      }
      const hm = humanMove.get(p.id);
      if (this.pens) {
        // Shoot-out: only the taker acts, and he strikes it from where it is placed.
        if (p.id !== this.pens.taker || this.pens.live) { movePlayer(p, 0, 0, false, false, dt); continue; }
        if (hm) { movePlayer(p, 0, 0, false, hasBall, dt); continue; }
        const d = playing ? aiCarrier(this, p, dt) : null;
        if (d && d.type === 'shoot') this.applyAi(p, d, hasBall, dt); else movePlayer(p, 0, 0, false, hasBall, dt);
        continue;
      }
      if (hm) { movePlayer(p, hm.mx, hm.mz, hm.sprint, hasBall, dt); continue; }
      if (!playing) {
        // Walk back into shape during stoppages.
        const d = aiOffBall(this, p, 'shape', dt);
        if (d.type === 'move') movePlayer(p, d.mx, d.mz, false, false, dt);
        continue;
      }
      const role = roles.get(p.id) ?? 'shape';
      const d: AiDecision = role === 'carrier' ? aiCarrier(this, p, dt) : aiOffBall(this, p, role, dt);
      this.applyAi(p, d, hasBall, dt);
      if (this.phase !== 'play') return; // a foul stopped play
    }

    // ----- keepers -----
    for (const team of ['home', 'away'] as const) {
      const k = this.keepers[team];
      if (this.pens && team === this.pens.turn) continue; // the taker's keeper only watches
      if (this.pens && k.manual && this.pens.live && !this.pensDived && this.pens.timer > 2.6 - 0.22) {
        // A person in goal: the way the stick is held as the kick is struck (or just after) is the way he goes.
        const z = (input[team] ?? NO_INPUT).mz;
        if (Math.abs(z) > 0.3) { keeperDive(k, z); this.pensDived = true; }
      }
      const o = this.owner();
      const ev = updateKeeper(k, b, !!o && o.team !== team, dt, this.rng, playing);
      if (this.pens && this.pens.live && (ev === 'save' || ev === 'catch') && team !== this.pens.turn) { this.endPenalty(false, 'pen_saved'); return; }
      if (ev === 'save') this.events.push('save');
      if (ev === 'release') this.keeperDistribute(k);
      if (ev === 'catch' || ev === 'save') {
        b.offsideIds = [];
        for (const p of this.players) if (p !== k.p) p.possessCooldown = Math.max(p.possessCooldown, 0.4);
      }
    }

    this.separatePlayers();

    const o2 = this.owner();
    if (o2 && !b.held && o2.role === 'field') dribble(o2, b, dt);
    const hit = stepBall(b, dt);
    if ((hit === 'post' || hit === 'bar') && playing && this.postCooldown === 0) {
      this.events.push('post');
      this.postCooldown = 0.5;
    }

    if (this.phase === 'play' && this.pens) {
      // Shoot-out: nobody follows up; the kick ends in the net, in the keeper's hands or out of play.
      if (this.pens.live) b.ownerId = -1;
      this.checkGoalOrOut();
    } else if (this.phase === 'play') {
      if (!this.headBall()) {
        this.blockBall();
        this.resolvePossession();
      }
      if (this.phase === 'play') this.checkGoalOrOut();
    }
  }

  /** Pick the scorer and give everyone a role in the celebration. */
  private startCelebration(team: Team): void {
    const b = this.ball;
    const kicker = b.kickerId >= 0 ? this.players[b.kickerId] : null;
    const own = !!kicker && kicker.team !== team;
    // Own goals: the nearest attacker of the scoring team leads the celebration.
    const scorer = kicker && !own && kicker.role === 'field' ? kicker : this.nearestField(team, b.pos);
    this.lastGoal = { team, scorerId: scorer.id, minute: Math.max(1, this.clockMinute), own };
    this.notices.push({
      team,
      text: `골 · ${this.lastGoal.minute}' ${own && kicker ? `${kicker.name} (자책골)` : `${scorer.number} ${scorer.name}`}`,
    });
    // Run to the corner flag on the camera side of the attacking end.
    this.celebSpot = { x: Math.sign(b.pos.x || 1) * (PITCH.halfLength - 7), z: PITCH.halfWidth - 5 };
    scorer.celebPose = Math.floor(this.rng() * 3) as 0 | 1 | 2;
    for (const p of this.players) {
      p.celebrate = p === scorer ? 1 : p.team === team ? 2 : 3;
      p.pending = null;
      p.charge = { kind: null, t: 0 };
    }
  }

  private celebrateMove(p: Player, dt: number): void {
    const scorer = this.lastGoal ? this.players[this.lastGoal.scorerId] : null;
    if (!scorer) return;
    if (p.celebrate === 1) {
      const s = seek(p, this.celebSpot.x, this.celebSpot.z, 1.5);
      movePlayer(p, s.x, s.z, true, false, dt);
      // Turn to face the crowd (camera) on arrival.
      if (Math.hypot(s.x, s.z) < 0.2) p.facing = Math.PI / 2;
    } else if (p.celebrate === 2) {
      // Teammates pile in around the scorer.
      const i = p.id % 11;
      const a = (i / 11) * Math.PI * 2;
      const tx = scorer.pos.x + Math.cos(a) * 1.3, tz = scorer.pos.z + Math.sin(a) * 1.3;
      const far = Math.hypot(tx - p.pos.x, tz - p.pos.z);
      const s = seek(p, tx, tz, 1.2);
      movePlayer(p, s.x, s.z, far > 6, false, dt);
      if (far < 1.5) p.facing = Math.atan2(scorer.pos.z - p.pos.z, scorer.pos.x - p.pos.x);
    } else {
      // The conceding side trudges back toward its own half.
      const dir = this.dir(p.team);
      const tx = dir * (p.slot.x * 20 - 8), tz = p.slot.z * 20 * dir;
      const s = seek(p, tx, tz, 3);
      movePlayer(p, s.x * 0.45, s.z * 0.45, false, false, dt);
    }
  }

  /** Second half: swap ends. */
  // ---------- penalty shoot-out ----------
  private pensKickId = -1;
  /** Whether the person in goal has already dived at this kick. */
  private pensDived = false;

  private startShootout(): void {
    const order = (team: Team) => [...this.fieldOf(team)].sort((a, c) => c.stats.shoot - a.stats.shoot).map((p) => p.id);
    this.shootout = { home: 0, away: 0 };
    this.pens = {
      turn: this.rng() < 0.5 ? 'home' : 'away', kicks: { home: [], away: [] },
      order: { home: order('home'), away: order('away') }, taker: -1, live: false, timer: 0,
    };
    this.events.push('shootout');
    this.ball.ownerId = -1;
    this.enter('out', 2.6, { kind: 'shootout' });
  }

  /** Set up the next kick: everyone to the centre circle, the taker on the spot, the keeper on the line. */
  private nextPenalty(): void {
    const pk = this.pens!;
    const team = pk.turn;
    // Every kick is taken at the same end.
    if (this.dir(team) !== 1) this.switchEnds();
    const live = pk.order[team].filter((id) => !this.players[id].sentOff);
    pk.taker = live[pk.kicks[team].length % Math.max(1, live.length)] ?? this.fieldOf(team)[0].id;
    let i = 0;
    for (const p of this.players) {
      if (p.sentOff || p.id === pk.taker) continue;
      p.vel.x = 0; p.vel.z = 0;
      p.windFire = null; p.windT = 0;
      if (p.role === 'gk') continue;
      // Two lines either side of the halfway line, the kicking side nearer the camera.
      const row = p.team === team ? 1 : -1, n = i++ % 10;
      p.pos.x = (n - 4.5) * 1.6;
      p.pos.z = row * 3.2;
      p.facing = 0;
    }
    // The taker's own keeper waits beside the box.
    const mine = this.keepers[team].p;
    resetKeeper(this.keepers.home); resetKeeper(this.keepers.away);
    this.applyRestart({ kind: 'penalty', team, taker: pk.taker });
    this.keepers[otherTeam(team)].penalty = true;
    this.keepers[otherTeam(team)].manual = this.isHuman(otherTeam(team));
    this.pensDived = false;
    mine.pos.x = PITCH.halfLength - BOX.depth - 2; mine.pos.z = -BOX.halfWidth - 3; mine.facing = 0;
    pk.live = false;
    pk.timer = 9;
    this.pensKickId = this.ball.kickId;
  }

  /** A kick is over: count it, and either set up the next one or end the match. */
  private endPenalty(scored: boolean, event: MatchEvent): void {
    const pk = this.pens;
    if (!pk || this.phase !== 'play') return;
    const team = pk.turn, other = otherTeam(team);
    pk.kicks[team].push(scored);
    if (scored) this.shootout![team]++;
    this.events.push(event);
    this.notices.push({ team, text: `승부차기 · ${this.players[pk.taker].number} ${this.players[pk.taker].name} · ${scored ? '성공' : event === 'pen_saved' ? '선방에 막힘' : '실축'}` });
    const b = this.ball;
    b.ownerId = -1; b.held = false;
    for (const p of this.players) { p.windFire = null; p.windT = 0; p.pending = null; p.charge = { kind: null, t: 0 }; }
    // Best of five, then sudden death: it is over when one side cannot be caught, or leads after equal kicks beyond five.
    const s = this.shootout!, taken = { home: pk.kicks.home.length, away: pk.kicks.away.length };
    const left = (t: Team) => Math.max(0, 5 - taken[t]);
    const over = s.home > s.away + left('away') || s.away > s.home + left('home')
      || (taken.home === taken.away && taken.home >= 5 && s.home !== s.away);
    if (over) {
      this.pens = null;
      this.events.push('fulltime');
      this.enter('fulltime', 0, null);
      return;
    }
    pk.turn = other;
    pk.taker = -1;
    this.enter('out', 1.9, { kind: 'shootout' });
  }

  private switchEnds(): void {
    this.flipped = !this.flipped;
    for (const k of Object.values(this.keepers)) k.side = (-k.side) as 1 | -1;
  }

  /**
   * A loose ball at head height is headed by the nearest outfield player under it: at goal when he
   * is close enough to score, clear of danger in his own third, otherwise on to a teammate.
   * Returns true when the ball was headed (or an offside player went for it).
   */
  private headBall(): boolean {
    const b = this.ball;
    if (b.ownerId !== -1 || b.held || b.pos.y < 1.35 || b.pos.y > 2.45 || b.age < 0.3) return false;
    let p: Player | null = null, bd = 0.75;
    for (const q of this.players) {
      if (q.role === 'gk' || q.sentOff || q.stumble > 0 || q.kickCooldown > 0) continue;
      const d = Math.hypot(b.pos.x - q.pos.x, b.pos.z - q.pos.z);
      if (d < bd) { bd = d; p = q; }
    }
    if (!p) return false;
    if (b.offsideTeam === p.team && b.offsideIds.includes(p.id)) {
      this.events.push('offside');
      b.vel.x = 0; b.vel.z = 0;
      this.enter('out', 1.3, {
        kind: 'freekick', team: otherTeam(p.team),
        x: clamp(p.pos.x, -PITCH.halfLength + 1, PITCH.halfLength - 1),
        z: clamp(p.pos.z, -PITCH.halfWidth + 1, PITCH.halfWidth - 1),
      });
      return true;
    }
    const dir = this.dir(p.team), hl = PITCH.halfLength, gx = dir * hl;
    const dGoal = Math.hypot(gx - p.pos.x, p.pos.z);
    let vx: number, vy: number, vz: number, target: Player | null = null, shot = false;
    if (dGoal < 16 && Math.abs(p.pos.z) < 14) {
      // At goal, away from the keeper; the worse the finisher, the wider it can go.
      const gk = this.keeperFacing(p.team).p;
      const side = gk.pos.z > 0 ? -1 : 1;
      const err = (1.2 - p.stats.shoot / 99) * 3.2;
      const aimZ = side * (GOAL.halfWidth - 1.0) + (this.rng() - 0.5) * 2 * err;
      const dx = gx - b.pos.x, dz = aimZ - b.pos.z, L = Math.hypot(dx, dz) || 1;
      const sp = 13 + (p.stats.shoot / 99) * 4;
      vx = (dx / L) * sp; vz = (dz / L) * sp; vy = 0.5 + this.rng() * 1.5;
      shot = true;
    } else if (p.pos.x * dir < -hl + 30) {
      // In his own third: away from goal and toward the nearer touchline.
      const uz = (Math.sign(p.pos.z) || 1) * 0.6, L = Math.hypot(1, uz);
      vx = (dir / L) * 13; vz = (uz / L) * 13; vy = 5;
    } else {
      // On to the best-placed teammate within reach, or down in front of himself.
      let best = -Infinity;
      for (const q of this.teammatesOf(p)) {
        const d = Math.hypot(q.pos.x - p.pos.x, q.pos.z - p.pos.z);
        if (d > 22) continue;
        const s = passScore(this, p, q);
        if (s > best) { best = s; target = q; }
      }
      if (target && best > -Infinity) {
        const dx = target.pos.x + target.vel.x * 0.4 - b.pos.x, dz = target.pos.z + target.vel.z * 0.4 - b.pos.z;
        const d = Math.hypot(dx, dz) || 1, sp = clamp(d * 1.1, 7, 14);
        vx = (dx / d) * sp; vz = (dz / d) * sp; vy = 2.5;
      } else {
        target = null;
        vx = dir * 3; vz = 0; vy = -1;
      }
    }
    this.markOffside(p.team, p.id);
    b.vel.x = vx; b.vel.y = vy; b.vel.z = vz;
    b.spin = 0;
    b.intendedId = target ? target.id : -1;
    b.kickId++;
    b.kickerId = p.id;
    b.age = 0;
    b.lastTouch = p.team;
    p.kickCooldown = 0.4;
    p.possessCooldown = 0.3;
    p.headAnim = 0.45;
    this.events.push('header');
    if (shot) { this.shots[p.team]++; this.events.push('shot'); }
    if (target && this.isHuman(target.team)) this.ctrl[target.team] = target.id;
    return true;
  }

  /** A fast loose ball that hits a player's body bounces off instead of passing through. */
  private blockBall(): void {
    const b = this.ball;
    if (b.ownerId !== -1 || b.held || b.pos.y > 1.85) return;
    const v = b.vel;
    const speed = Math.hypot(v.x, v.z);
    if (speed < 7) return;
    for (const p of this.players) {
      if (p.sentOff || p.role === 'gk') continue;
      if (p.id === b.kickerId && b.age < 0.35) continue;
      if (canControl(p, b)) continue; // they will simply take it
      const dx = b.pos.x - p.pos.x, dz = b.pos.z - p.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.42 || d < 1e-4) continue;
      const nx = dx / d, nz = dz / d;
      const vn = v.x * nx + v.z * nz;
      if (vn >= 0) continue;
      v.x -= 1.6 * vn * nx; v.z -= 1.6 * vn * nz;
      v.x *= 0.55; v.z *= 0.55; v.y = Math.max(v.y * 0.5, 0.8);
      b.pos.x = p.pos.x + nx * 0.43; b.pos.z = p.pos.z + nz * 0.43;
      b.lastTouch = p.team;
      b.kickId++;
      b.kickerId = p.id;
      b.age = 0;
      if (p.team !== b.offsideTeam) b.offsideIds = [];
      this.events.push('block');
      return;
    }
  }

  /** Start a kick's wind-up; the fire callback strikes the ball when the swing arrives. */
  private windup(p: Player, kind: KickKind, delay: number, fire: () => void, aim: number | null = null): void {
    const b = this.ball;
    p.windKind = kind;
    p.windFire = fire;
    p.windAim = aim;
    // A pass across the body is played with the inside of the far foot; anything else with the foot nearer the ball.
    const turn = aim === null ? 0 : wrapAngle(aim - p.facing);
    const sideFoot = kind === 'pass' || kind === 'through';
    p.kickFoot = sideFoot && Math.abs(turn) > 0.35 && Math.abs(turn) < 2.2 ? (turn > 0 ? -1 : 1) : footFor(p, b);
    // The swing is timed to the ball: one that has run ahead needs longer to be brought to the foot.
    let wait = b.ownerId === p.id ? Math.min(0.3, kickSpot(p, b).gap / KICK_GATHER + 0.02) : 0;
    // A kick that goes behind the body waits for the turn.
    wait = Math.max(wait, (Math.abs(turn) - kickAcross(kind)) / KICK_TURN);
    p.windT = Math.max(delay, wait);
    p.windMax = p.windT;
  }

  /** Advance wind-ups; strike if the ball is within reach, otherwise wait a moment for it. */
  private runWindups(dt: number): void {
    for (const p of this.players) {
      if (!p.windFire) continue;
      p.windT -= dt;
      if (p.windT > 0) continue;
      if (kickReady(p, this.ball)) {
        const fire = p.windFire;
        p.windFire = null;
        p.windT = 0;
        p.kickKind = p.windKind;
        fire();
      } else if (p.windT < -0.5 || this.ball.ownerId !== p.id) {
        p.windFire = null; // the chance has gone
        p.windT = 0;
      }
    }
  }

  private applyAi(p: Player, d: AiDecision, hasBall: boolean, dt: number): void {
    switch (d.type) {
      case 'move':
        movePlayer(p, d.mx, d.mz, d.sprint, hasBall, dt);
        break;
      case 'tackle':
        p.facing = Math.atan2(d.mz, d.mx) || p.facing;
        this.tackle(p);
        movePlayer(p, d.mx, d.mz, false, false, dt);
        break;
      case 'shoot':
        if (hasBall && p.kickCooldown === 0 && !p.windFire) {
          const power = d.power, dir = d.dir;
          this.windup(p, 'shoot', 0.16, () => this.doShot(p, power, dir), Math.atan2(dir.z, dir.x));
        }
        movePlayer(p, 0, 0, false, hasBall, dt);
        break;
      case 'pass':
        if (hasBall && p.kickCooldown === 0 && !p.windFire) {
          const target = d.target, kind = d.kind;
          this.windup(p, kind, kind === 'lob' ? 0.13 : 0.09, () => this.passTo(p, target, kind), this.passAim(target, kind));
        }
        movePlayer(p, 0, 0, false, hasBall, dt);
        break;
    }
  }

  /** Who presses, who covers, who receives, who holds shape. */
  private assignRoles(): Map<number, Role> {
    const roles = new Map<number, Role>();
    const b = this.ball;
    const owner = this.owner();
    for (const team of ['home', 'away'] as const) {
      const humanSide = this.isHuman(team);
      const dir = this.dir(team);
      const mine = (p: Player) => !(humanSide && p.id === this.ctrl[team]);
      const pass = b.ownerId === -1 && b.intendedId >= 0 ? this.players[b.intendedId] : null;
      // ---- in possession (on the ball, or a pass on its way to a teammate) ----
      const holder = owner && owner.team === team ? owner : pass && pass.team === team ? pass : null;
      if (holder) {
        if (holder === owner) { if (owner.role === 'field' && mine(owner)) roles.set(owner.id, 'carrier'); }
        else if (mine(holder)) roles.set(holder.id, 'receive');
        const others = this.fieldOf(team).filter((p) => p !== holder && mine(p))
          .sort((p, q) => Math.hypot(p.pos.x - holder.pos.x, p.pos.z - holder.pos.z) - Math.hypot(q.pos.x - holder.pos.x, q.pos.z - holder.pos.z));
        // The two nearest come to offer a pass; the forward players stretch the defence.
        let support = 0;
        for (const p of others) {
          if (support < 2 && (p.pos.x - holder.pos.x) * dir < 14) { roles.set(p.id, 'support'); support++; }
          else if (p.slot.x > 0.1) roles.set(p.id, 'run');
        }
        continue;
      }
      if (b.held && owner && owner.team !== team) continue; // keeper has it: hold shape
      // ---- out of possession ----
      const sorted = [...this.fieldOf(team)].sort((p, q) =>
        Math.hypot(p.pos.x - b.pos.x, p.pos.z - b.pos.z) - Math.hypot(q.pos.x - b.pos.x, q.pos.z - b.pos.z));
      const ai = sorted.filter(mine);
      const humanFirst = humanSide && sorted[0]?.id === this.ctrl[team];
      if (!humanFirst && ai[0]) roles.set(ai[0].id, 'press');
      const coverer = humanFirst ? ai[0] : ai[1];
      if (coverer) {
        // A loose ball is chased by two; against a carrier the second man covers.
        if (!owner && !pass) roles.set(coverer.id, 'press');
        else if (owner) roles.set(coverer.id, 'cover');
      }
      // Everyone else picks up an opponent in his area: the most dangerous attackers first,
      // each taken by the defender whose position is nearest. A pass on its way makes its
      // receiver the first man to be closed down.
      // (The forwards stay up the pitch as the outlet for a counter-attack.)
      const free = this.fieldOf(team).filter((p) => mine(p) && !roles.has(p.id) && p.slot.x < 0.15);
      const spots = new Map(free.map((p) => [p.id, formationTarget(this, p)]));
      const threats = this.opponentsOf(team)
        .filter((o) => o.role === 'field' && o !== owner && (o === pass || PITCH.halfLength + o.pos.x * dir < 62))
        .sort((x, y) => (x === pass ? -1 : y === pass ? 1 : x.pos.x * dir - y.pos.x * dir));
      for (const o of threats) {
        let best: Player | null = null, bd = o === pass ? 16 : 9;
        for (const p of free) {
          if (roles.has(p.id)) continue;
          const s = spots.get(p.id)!;
          const d = Math.hypot(s.x - o.pos.x, s.z - o.pos.z);
          if (d < bd) { bd = d; best = p; }
        }
        if (best) { roles.set(best.id, 'mark'); best.aiMark = o.id; }
      }
    }
    return roles;
  }

  private separatePlayers(): void {
    const ps = this.players.filter((p) => !p.sentOff);
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i], c = ps[j];
        const dx = c.pos.x - a.pos.x, dz = c.pos.z - a.pos.z;
        const d = Math.hypot(dx, dz);
        const min = 0.7;
        if (d < min && d > 1e-4) {
          const push = (min - d) / 2;
          a.pos.x -= (dx / d) * push; a.pos.z -= (dz / d) * push;
          c.pos.x += (dx / d) * push; c.pos.z += (dz / d) * push;
        }
      }
    }
  }

  private resolvePossession(): void {
    const b = this.ball;
    if (b.held) return;
    const owner = this.owner();
    if (owner) {
      if (owner.role === 'field' && (ballDistance(owner, b) > 3 || b.pos.y > 1.0)) { b.ownerId = -1; return; }
      // A ball knocked too far ahead can be nicked by an opponent who gets there first.
      const gap = ballDistance(owner, b);
      if (owner.role === 'field' && gap > 0.9) {
        for (const o of this.opponentsOf(owner.team)) {
          if (o.role !== 'field' || !canControl(o, b) || ballDistance(o, b) >= gap) continue;
          b.ownerId = o.id;
          b.lastTouch = o.team;
          b.offsideIds = [];
          firstTouch(o, b);
          o.think = 0.15;
          owner.windFire = null;
          break;
        }
      }
      return;
    }
    let best: Player | null = null, bd = Infinity;
    for (const p of this.players) {
      if (p.role === 'gk' || p.sentOff || !canControl(p, b)) continue;
      const d = ballDistance(p, b);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return;
    if (b.offsideTeam === best.team && b.offsideIds.includes(best.id)) {
      // Flag goes up: indirect free kick where the offside player received it.
      this.events.push('offside');
      b.vel.x = 0; b.vel.z = 0;
      this.enter('out', 1.3, {
        kind: 'freekick', team: otherTeam(best.team),
        x: clamp(best.pos.x, -PITCH.halfLength + 1, PITCH.halfLength - 1),
        z: clamp(best.pos.z, -PITCH.halfWidth + 1, PITCH.halfWidth - 1),
      });
      return;
    }
    if (best.team !== b.offsideTeam) { b.offsideIds = []; b.offsideTeam = null; }
    else b.offsideIds = [];
    b.ownerId = best.id;
    b.intendedId = -1;
    b.lastTouch = best.team;
    b.vel.y = 0;
    best.think = 0.15;
    firstTouch(best, b);
  }

  private checkGoalOrOut(): void {
    const b = this.ball;
    const hl = PITCH.halfLength, hw = PITCH.halfWidth;
    const x = b.pos.x, z = b.pos.z;

    if (this.pens) {
      // Shoot-out: over the line in the goal is a goal; anywhere else out of play is a miss.
      if (Math.abs(x) > hl + R) this.endPenalty(b.inGoal !== 0, b.inGoal !== 0 ? 'pen_goal' : 'pen_missed');
      else if (Math.abs(z) > hw + R) this.endPenalty(false, 'pen_missed');
      return;
    }
    if (Math.abs(x) > hl + R) {
      b.ownerId = -1;
      const lineSide = Math.sign(x);
      // The team attacking toward this goal line.
      const attacking: Team = this.dir('home') === lineSide ? 'home' : 'away';
      const defending = otherTeam(attacking);
      if (b.inGoal !== 0) {
        const scorer: Team = this.dir('home') === b.inGoal ? 'home' : 'away';
        this.score[scorer]++;
        this.events.push(scorer === 'home' ? 'goal_home' : 'goal_away');
        this.startCelebration(scorer);
        this.enter('goal', GOAL_TIME, { kind: 'kickoff', team: otherTeam(scorer) });
        return;
      }
      if (b.lastTouch === defending) {
        this.events.push('corner');
        this.enter('out', 1.2, { kind: 'corner', team: attacking, x: lineSide * hl, z: Math.sign(z) * hw });
      } else {
        this.events.push('goalkick');
        this.enter('out', 1.2, { kind: 'goalkick', team: defending });
      }
      return;
    }
    if (Math.abs(z) > hw + R) {
      b.ownerId = -1;
      const team = b.lastTouch ? otherTeam(b.lastTouch) : 'home';
      this.events.push('throw');
      this.enter('out', 1.2, { kind: 'throw', team, x: clamp(x, -hl + 1, hl - 1), z: Math.sign(z) * hw });
    }
  }
}
