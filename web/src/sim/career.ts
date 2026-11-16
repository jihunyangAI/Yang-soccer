import { createLeague, isOver, myFixture, seasonMoves, table, type LeagueOptions, type LeagueState } from './league';
import type { Look, Stats } from './player';
import { createRng, type Rng } from './rng';
import { buildRoster, personFor, pickLineup, playerOverall, type Category, type RosterPlayer } from './roster';
import { FORMATIONS, TEAMS, type TeamDef } from './team';

/**
 * Club development mode: the league, played over many seasons with a squad that changes.
 * Players have an age and a ceiling; they improve by playing while young and fade when old.
 * Matches bring in money, which buys players from a market that changes every round.
 * Everything is plain data, so a career can be saved and resumed.
 */
export interface CareerPlayer extends RosterPlayer {
  id: number;
  age: number;
  /** The overall rating this player can grow to. */
  potential: number;
}

export interface CareerState {
  v: 1;
  /** The player's club, as an index into TEAMS. */
  team: number;
  seed: number;
  /** Budget in units of 100 million. */
  money: number;
  squad: CareerPlayer[];
  /** Players on offer this round. */
  market: CareerPlayer[];
  nextId: number;
  league: LeagueState;
  /** What happened last: growth after a round, changes at the end of a season. */
  news: string[];
  history: { season: number; division: 1 | 2; position: number }[];
}

export const SQUAD_MIN = 16;
export const SQUAD_MAX = 22;
const STAT_KEYS = ['speed', 'dribble', 'pass', 'shoot', 'defense'] as const;
const STAT_NAME: Record<typeof STAT_KEYS[number] | 'reflex', string> = { speed: '속도', dribble: '드리블', pass: '패스', shoot: '슛', defense: '수비', reflex: '반응' };
const cap = (v: number) => Math.max(35, Math.min(97, Math.round(v)));

/** A new player of about the given overall rating. */
function makePlayer(rng: Rng, id: number, cat: Category, overall: number, age: number, number: number, used: Set<string>): CareerPlayer {
  const d = { speed: 0, dribble: 0, pass: 0, shoot: 0, defense: 0 };
  if (cat === 'DF') { d.defense = 9; d.shoot = -9; d.dribble = -3; }
  if (cat === 'MF') { d.pass = 5; d.dribble = 2; d.shoot = -3; d.defense = -3; }
  if (cat === 'FW') { d.shoot = 8; d.speed = 4; d.defense = -13; }
  if (cat === 'GK') { d.speed = -8; d.shoot = -20; d.dribble = -16; }
  const v = (x: number) => cap(overall + x + (rng() - 0.5) * 9);
  const stats: Stats = { speed: v(d.speed), dribble: v(d.dribble), pass: v(d.pass), shoot: v(d.shoot), defense: v(d.defense), stamina: v(2) };
  const who = personFor(rng, used);
  const p: CareerPlayer = { id, name: who.name, look: who.look as Look, number, cat, stats, reflex: cat === 'GK' ? cap(overall + (rng() - 0.5) * 6) : 0, age, potential: 0 };
  // Room to grow shrinks with age.
  const room = age <= 20 ? 6 + rng() * 14 : age <= 24 ? 3 + rng() * 10 : age <= 28 ? rng() * 5 : 0;
  p.potential = Math.min(96, Math.round(playerOverall(p) + room));
  return p;
}

const freeNumber = (squad: CareerPlayer[]): number => {
  const used = new Set(squad.map((p) => p.number));
  for (let n = 2; n < 100; n++) if (!used.has(n)) return n;
  return 99;
};

/** Price of a player: steeply more for quality, more for youth with room to grow, less for veterans. */
export function playerValue(p: CareerPlayer): number {
  const ovr = playerOverall(p);
  const base = Math.max(0, ovr - 52) ** 2 / 16;
  const age = p.age <= 23 ? 1.25 : p.age <= 29 ? 1 : p.age <= 32 ? 0.6 : 0.3;
  const growth = 1 + Math.max(0, p.potential - ovr) * 0.035;
  return Math.max(0.5, Math.round(base * age * growth * 2) / 2);
}
/** What the club gets for selling: less than the asking price for the same player. */
export const sellValue = (p: CareerPlayer): number => Math.max(0.5, Math.round(playerValue(p) * 0.6 * 2) / 2);

function fillMarket(c: CareerState): void {
  const rng = createRng((c.seed ^ Math.imul(c.league.season * 97 + c.league.round + 1, 0x85ebca6b)) >>> 0);
  const level = TEAMS[c.team].division === 1 || c.league.division === 1 ? 74 : 68;
  const used = new Set(c.squad.map((p) => p.name));
  const cats: Category[] = ['GK', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'FW', 'FW', 'FW'];
  c.market = cats.map((cat) => {
    const age = 17 + Math.floor(rng() * 17);
    // Mostly players around the division's level, now and then a star or a bargain youngster.
    const ovr = level + (rng() - 0.5) * 14 + (rng() < 0.15 ? 6 : 0) - (age <= 19 ? 7 : 0);
    return makePlayer(rng, c.nextId++, cat, ovr, age, 0, used);
  });
}

export interface CareerOptions extends Omit<LeagueOptions, 'division' | 'clubs' | 'other' | 'season'> {}

export function createCareer(o: CareerOptions): CareerState {
  const team = TEAMS[o.team];
  const rng = createRng((o.seed ^ 0x27d4eb2f) >>> 0);
  let id = 1;
  const squad = buildRoster(team).map((r): CareerPlayer => {
    const age = 18 + Math.floor(rng() * 15);
    const p: CareerPlayer = { ...r, stats: { ...r.stats }, id: id++, age, potential: 0 };
    const room = age <= 20 ? 6 + rng() * 14 : age <= 24 ? 3 + rng() * 10 : age <= 28 ? rng() * 5 : 0;
    p.potential = Math.min(96, Math.round(playerOverall(p) + room));
    return p;
  });
  const c: CareerState = {
    v: 1, team: o.team, seed: o.seed, money: team.division === 1 ? 40 : 25, squad, market: [], nextId: id,
    league: createLeague(o), news: [], history: [],
  };
  fillMarket(c);
  return c;
}

/** The sixteen who go to a match: the best eleven for the formation and the best of the rest, a keeper among them. */
export function matchSquad(c: CareerState): RosterPlayer[] {
  const formation = FORMATIONS[c.league.formation] ?? FORMATIONS['4-4-2'];
  const { starters, bench } = pickLineup(c.squad, formation);
  const rest = [...bench].sort((a, b) => playerOverall(b) - playerOverall(a));
  const gk = rest.find((p) => p.cat === 'GK');
  const picked = rest.filter((p) => p !== gk).slice(0, gk ? 4 : 5);
  return [...starters, ...(gk ? [gk] : []), ...picked];
}

/** The club as its squad makes it: the ratings used when a match is settled without being played. */
export function careerClub(c: CareerState): TeamDef {
  const base = TEAMS[c.team];
  const formation = FORMATIONS[c.league.formation] ?? FORMATIONS['4-4-2'];
  const { starters } = pickLineup(c.squad, formation);
  const field = starters.filter((p) => p.cat !== 'GK');
  const avg = (k: keyof Stats) => Math.round(field.reduce((x, p) => x + p.stats[k], 0) / Math.max(1, field.length));
  const keeper = starters.find((p) => p.cat === 'GK');
  return {
    ...base,
    field: { speed: avg('speed'), dribble: avg('dribble'), pass: avg('pass'), shoot: avg('shoot'), defense: avg('defense'), stamina: avg('stamina') },
    keeperReflex: keeper ? keeper.reflex : base.keeperReflex - 15,
  };
}

/** Overall rating of the best eleven. */
export function squadRating(c: CareerState): number {
  const formation = FORMATIONS[c.league.formation] ?? FORMATIONS['4-4-2'];
  const { starters } = pickLineup(c.squad, formation);
  return Math.round(starters.reduce((x, p) => x + playerOverall(p), 0) / Math.max(1, starters.length));
}

/**
 * A round has just been settled: pay the gate money, let those who played improve, and bring
 * new players to the market. `played` is false when the match was settled without being played.
 */
export function afterRound(c: CareerState, played: boolean): void {
  const s = c.league;
  const round = s.round - 1;
  const f = myFixture(s, round);
  const res = f && s.results[round][f.index];
  if (!f || !res) return;
  const my = f.home ? res[0] : res[1], their = f.home ? res[1] : res[0];
  const top = s.division === 1 ? 1.5 : 1;
  const income = Math.round((my > their ? 3 : my === their ? 1.5 : 1) * top * (f.home ? 1.2 : 1) * 2) / 2;
  c.money += income;
  c.news = [`${round + 1}라운드 ${my > their ? '승리' : my === their ? '무승부' : '패배'} · 수입 +${income}억`];

  const rng = createRng((c.seed ^ Math.imul(s.season * 131 + s.round, 0xc2b2ae35)) >>> 0);
  const formation = FORMATIONS[s.formation] ?? FORMATIONS['4-4-2'];
  const starters = new Set(pickLineup(c.squad, formation).starters);
  for (const p of c.squad) {
    const room = p.potential - playerOverall(p);
    if (room <= 0) continue;
    const ageMul = p.age <= 21 ? 1.4 : p.age <= 25 ? 1.1 : p.age <= 29 ? 0.7 : 0.25;
    // Starters learn most; a match that was actually played teaches more than one that was skipped.
    const chance = Math.min(0.22, 0.05 + room * 0.01) * ageMul * (starters.has(p) ? 1 : 0.3) * (played ? 1 : 0.6);
    const keys: (typeof STAT_KEYS[number] | 'reflex')[] = p.cat === 'GK' ? ['reflex', 'reflex', 'pass'] : [...STAT_KEYS];
    for (const k of keys) {
      if (rng() >= chance) continue;
      if (k === 'reflex') p.reflex = cap(p.reflex + 1); else p.stats[k] = cap(p.stats[k] + 1);
      if (c.news.length < 7) c.news.push(`${p.name} · ${STAT_NAME[k]} +1`);
    }
  }
  fillMarket(c);
}

/**
 * The season is over and the next one (`next`) has been drawn: prize money, a year older,
 * veterans fade or retire, and a youngster comes through.
 */
export function afterSeason(c: CareerState, next: LeagueState): void {
  const old = c.league;
  const rows = table(old);
  const pos = rows.findIndex((r) => r.team === c.team) + 1;
  const moves = isOver(old) ? seasonMoves(old) : { up: [], down: [] };
  const prize = Math.round((rows.length + 1 - pos) * (old.division === 1 ? 2 : 1.2) + (moves.up.includes(c.team) ? 10 : 0));
  c.money += prize;
  c.history.push({ season: old.season, division: old.division, position: pos });
  c.news = [`시즌 ${old.season} ${pos}위 · 상금 +${prize}억${moves.up.includes(c.team) ? ' (승격 보너스 포함)' : ''}`];

  const rng = createRng((c.seed ^ Math.imul(old.season + 7, 0x165667b1)) >>> 0);
  const level = next.division === 1 ? 72 : 66;
  const used = new Set(c.squad.map((p) => p.name));
  c.squad = c.squad.map((p) => {
    p.age++;
    if (p.age >= 36 || (p.age >= 34 && rng() < 0.4)) {
      // Retires; a youth player takes the shirt.
      const y = makePlayer(rng, c.nextId++, p.cat, level - 9 + rng() * 5, 17 + Math.floor(rng() * 2), p.number, used);
      c.news.push(`${p.name} 은퇴 → 유소년 ${y.name} 합류`);
      return y;
    }
    if (p.age >= 31) {
      const drop = p.age >= 34 ? 2 : 1;
      for (const k of STAT_KEYS) if (rng() < 0.55) p.stats[k] = cap(p.stats[k] - drop);
      if (p.cat === 'GK' && rng() < 0.5) p.reflex = cap(p.reflex - drop);
      p.potential = Math.min(p.potential, playerOverall(p));
    }
    return p;
  });
  if (c.squad.length < SQUAD_MAX) {
    const cat = (['DF', 'MF', 'FW'] as const)[Math.floor(rng() * 3)];
    const y = makePlayer(rng, c.nextId++, cat, level - 9 + rng() * 5, 17, freeNumber(c.squad), used);
    c.squad.push(y);
    c.news.push(`유소년 ${y.name} 승격`);
  }
  c.league = next;
  fillMarket(c);
}

/** Why a signing cannot be made, or null if it can. */
export function buyBlock(c: CareerState, p: CareerPlayer): string | null {
  if (c.squad.length >= SQUAD_MAX) return `선수단이 가득 찼습니다 (최대 ${SQUAD_MAX}명)`;
  if (c.money < playerValue(p)) return '예산이 부족합니다';
  return null;
}

export function buy(c: CareerState, id: number): boolean {
  const i = c.market.findIndex((p) => p.id === id);
  if (i < 0 || buyBlock(c, c.market[i])) return false;
  const [p] = c.market.splice(i, 1);
  c.money -= playerValue(p);
  p.number = freeNumber(c.squad);
  c.squad.push(p);
  c.news = [`${p.name} 영입`];
  return true;
}

/** Why a player cannot be sold, or null if he can. */
export function sellBlock(c: CareerState, p: CareerPlayer): string | null {
  if (c.squad.length <= SQUAD_MIN) return `최소 ${SQUAD_MIN}명은 있어야 합니다`;
  if (p.cat === 'GK' && c.squad.filter((x) => x.cat === 'GK').length <= 2) return '골키퍼는 2명 이상 필요합니다';
  const left = c.squad.filter((x) => x !== p && x.cat !== 'GK').length;
  if (p.cat !== 'GK' && left < 13) return '필드 선수가 부족해집니다';
  return null;
}

export function sell(c: CareerState, id: number): boolean {
  const p = c.squad.find((x) => x.id === id);
  if (!p || sellBlock(c, p)) return false;
  c.squad = c.squad.filter((x) => x !== p);
  c.money += sellValue(p);
  c.news = [`${p.name} 방출 · +${sellValue(p)}억`];
  return true;
}

// ---- saving ----
const KEY = 'pitchline.career.v1';

export function loadCareer(): CareerState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as CareerState;
    const ok = c && c.v === 1 && TEAMS[c.team] && Array.isArray(c.squad) && c.squad.length >= 11 && Array.isArray(c.market)
      && c.league && c.league.v === 2 && c.league.team === c.team && Array.isArray(c.league.clubs) && c.league.clubs.includes(c.team)
      && typeof c.money === 'number' && c.squad.every((p) => p && p.stats && typeof p.name === 'string');
    return ok ? c : null;
  } catch { return null; }
}

export function saveCareer(c: CareerState | null): void {
  try {
    if (c) localStorage.setItem(KEY, JSON.stringify(c));
    else localStorage.removeItem(KEY);
  } catch { /* storage unavailable: the career lasts until the page closes */ }
}
