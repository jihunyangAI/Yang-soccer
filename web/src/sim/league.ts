import type { Difficulty } from './match';
import { createRng, type Rng } from './rng';
import { divisionClubs, DIV_SIZE, MOVES, TEAMS, type TeamDef } from './team';

/**
 * League season: the clubs of one division meet each other once (or home and away), three points
 * for a win. At the end the bottom clubs of the first division swap with the top clubs of the second.
 * The other division is not shown during the season; its final table is worked out from the seed.
 * The player's own match is played for real; the rest of each round is settled by a quick
 * goal model driven by the clubs' ratings. Everything here is plain data, so a season can be
 * saved and resumed.
 */
export type Fixture = [home: number, away: number];
export type Score = [home: number, away: number];

export interface LeagueState {
  v: 2;
  season: number;
  /** The player's club, as an index into TEAMS. */
  team: number;
  /** The division the player's club is in this season. */
  division: 1 | 2;
  /** Clubs in the player's division this season, and in the other one (indices into TEAMS). */
  clubs: number[];
  other: number[];
  legs: 1 | 2;
  seed: number;
  /** Index of the next round to play; equals rounds.length when the season is over. */
  round: number;
  rounds: Fixture[][];
  results: (Score | null)[][];
  // Match settings for the player's games.
  minutes: number;
  difficulty: Difficulty;
  offside: boolean;
  assist: boolean;
  formation: string;
}

export interface LeagueOptions {
  team: number; legs: 1 | 2; seed: number; season?: number;
  /** Division line-ups carried over from the last season; default is where each club starts. */
  division?: 1 | 2; clubs?: number[]; other?: number[];
  minutes: number; difficulty: Difficulty; offside: boolean; assist: boolean; formation?: string;
}

export interface Row {
  team: number; played: number; won: number; drawn: number; lost: number;
  gf: number; ga: number; gd: number; pts: number;
  /** Results of the last five matches, oldest first. */
  form: ('W' | 'D' | 'L')[];
}

/**
 * Round-robin by the circle method: one club stays put, the others rotate around it.
 * Home and away alternate so nobody plays a long run on one side.
 */
export function schedule(n: number, legs: 1 | 2, rng: Rng): Fixture[][] {
  const ids = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {           // shuffle so every season has a different calendar
    const j = Math.floor(rng() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const first: Fixture[][] = [];
  const ring = ids.slice(1);
  for (let r = 0; r < n - 1; r++) {
    const order = [ids[0], ...ring];
    const round: Fixture[] = [];
    for (let k = 0; k < n / 2; k++) {
      const a = order[k], b = order[n - 1 - k];
      // The fixed club alternates sides each round. The others swap sides by seat, and since
      // they move one seat per round, their home and away games alternate too.
      const flip = k === 0 ? r % 2 === 1 : k % 2 === 1;
      round.push(flip ? [b, a] : [a, b]);
    }
    first.push(round);
    ring.unshift(ring.pop()!);
  }
  if (legs === 1) return first;
  return [...first, ...first.map((round) => round.map(([h, a]): Fixture => [a, h]))];
}

export function createLeague(o: LeagueOptions): LeagueState {
  const division = o.division ?? TEAMS[o.team].division;
  const clubs = o.clubs ?? divisionClubs(division);
  const other = o.other ?? divisionClubs(division === 1 ? 2 : 1);
  // The calendar is drawn on seats 0..n-1, then the seats are filled with this division's clubs.
  const rounds = schedule(clubs.length, o.legs, createRng(o.seed))
    .map((round) => round.map(([h, a]): Fixture => [clubs[h], clubs[a]]));
  return {
    v: 2, season: o.season ?? 1, team: o.team, division, clubs, other, legs: o.legs, seed: o.seed, round: 0,
    rounds, results: rounds.map((r) => r.map(() => null)),
    minutes: o.minutes, difficulty: o.difficulty, offside: o.offside, assist: o.assist,
    formation: o.formation ?? TEAMS[o.team].formation,
  };
}

export const isOver = (s: LeagueState): boolean => s.round >= s.rounds.length;

/** The player's fixture in a round (default: the next one), or null once the season is over. */
export function myFixture(s: LeagueState, round = s.round): { index: number; fixture: Fixture; home: boolean; opponent: number } | null {
  const r = s.rounds[round];
  if (!r) return null;
  const index = r.findIndex(([h, a]) => h === s.team || a === s.team);
  const fixture = r[index];
  const home = fixture[0] === s.team;
  return { index, fixture, home, opponent: home ? fixture[1] : fixture[0] };
}

const attack = (t: TeamDef) => 0.35 * t.field.shoot + 0.25 * t.field.pass + 0.2 * t.field.dribble + 0.2 * t.field.speed;
const defence = (t: TeamDef) => 0.7 * t.field.defense + 0.3 * t.keeperReflex;

function poisson(mean: number, rng: Rng): number {
  const limit = Math.exp(-mean);
  let k = 0, p = rng();
  while (p > limit && k < 9) { k++; p *= rng(); }
  return k;
}

/** Expected goals for one side: its attack against the other's defence, with a home edge. */
export function expectedGoals(home: TeamDef, away: TeamDef): Score {
  const xg = (a: TeamDef, d: TeamDef, edge: number) => 1.3 * edge * Math.exp((attack(a) - defence(d) - 3.5) / 13);
  return [xg(home, away, 1.12), xg(away, home, 0.9)];
}

/** Settle a match without playing it. */
export function quickScore(home: TeamDef, away: TeamDef, rng: Rng): Score {
  const [h, a] = expectedGoals(home, away);
  return [poisson(h, rng), poisson(a, rng)];
}

/**
 * Penalty shoot-out without playing it: five kicks each, then sudden death.
 * Better finishers against a weaker keeper convert a little more often.
 */
export function shootoutScore(home: TeamDef, away: TeamDef, rng: Rng): Score {
  const chance = (a: TeamDef, d: TeamDef) => Math.max(0.55, Math.min(0.9, 0.76 + (a.field.shoot - d.keeperReflex) / 250));
  const ph = chance(home, away), pa = chance(away, home);
  let h = 0, a = 0;
  for (let i = 0; i < 5; i++) { if (rng() < ph) h++; if (rng() < pa) a++; }
  for (let i = 0; h === a; i++) {
    const hs = rng() < ph, as = rng() < pa;
    if (hs) h++;
    if (as) a++;
    if (i > 40 && h === a) h++; // never loops forever
  }
  return [h, a];
}

/**
 * Finish the current round. `mine` is the player's result as [home goals, away goals] of the
 * fixture; pass null to have it simulated too. Every other match is simulated.
 */
export function playRound(s: LeagueState, mine: Score | null, club?: TeamDef): void {
  if (isOver(s)) return;
  // `club`: the player's club as its squad makes it (club development mode), for a match that is not played.
  const def = (i: number) => (club && i === s.team ? club : TEAMS[i]);
  const rng = createRng((s.seed ^ Math.imul(s.round + 1, 0x9e3779b1)) >>> 0);
  const me = myFixture(s)!.index;
  s.rounds[s.round].forEach(([h, a], i) => {
    const sim = quickScore(def(h), def(a), rng); // always drawn, so the others do not depend on `mine`
    s.results[s.round][i] = i === me && mine ? [mine[0], mine[1]] : sim;
  });
  s.round++;
}

/** Standings of a set of clubs from a calendar and its results. */
function standings(clubs: number[], rounds: Fixture[][], results: (Score | null)[][]): Row[] {
  const byClub = new Map<number, Row>(clubs.map((team) => [team, { team, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, pts: 0, form: [] }]));
  const rows = [...byClub.values()];
  rounds.forEach((round, r) => round.forEach(([h, a], i) => {
    const res = results[r][i];
    if (!res) return;
    const add = (row: Row, f: number, g: number) => {
      row.played++; row.gf += f; row.ga += g; row.gd = row.gf - row.ga;
      if (f > g) { row.won++; row.pts += 3; row.form.push('W'); }
      else if (f === g) { row.drawn++; row.pts += 1; row.form.push('D'); }
      else { row.lost++; row.form.push('L'); }
    };
    add(byClub.get(h)!, res[0], res[1]);
    add(byClub.get(a)!, res[1], res[0]);
  }));
  for (const row of rows) row.form = row.form.slice(-5);
  // Points, then goal difference, then goals scored, then name.
  return rows.sort((x, y) => y.pts - x.pts || y.gd - x.gd || y.gf - x.gf || TEAMS[x.team].name.localeCompare(TEAMS[y.team].name));
}

export const table = (s: LeagueState): Row[] => standings(s.clubs, s.rounds, s.results);

/** Final table of the other division: a whole season settled by the quick goal model. */
export function otherTable(s: LeagueState): Row[] {
  const rng = createRng((s.seed ^ 0x5bd1e995) >>> 0);
  const rounds = schedule(s.other.length, s.legs, rng).map((round) => round.map(([h, a]): Fixture => [s.other[h], s.other[a]]));
  const results = rounds.map((round) => round.map(([h, a]) => quickScore(TEAMS[h], TEAMS[a], rng)));
  return standings(s.other, rounds, results);
}

/** Clubs changing division after a finished season: `up` join the first division, `down` leave it. */
export function seasonMoves(s: LeagueState): { up: number[]; down: number[] } {
  const mine = table(s).map((r) => r.team), theirs = otherTable(s).map((r) => r.team);
  const [first, second] = s.division === 1 ? [mine, theirs] : [theirs, mine];
  return { up: second.slice(0, MOVES), down: first.slice(-MOVES) };
}

/** The next season for the same club, with promoted and relegated clubs swapped over. */
export function nextSeason(s: LeagueState, seed: number): LeagueState {
  const { up, down } = seasonMoves(s);
  const [first, second] = s.division === 1 ? [s.clubs, s.other] : [s.other, s.clubs];
  const newFirst = [...first.filter((c) => !down.includes(c)), ...up];
  const newSecond = [...second.filter((c) => !up.includes(c)), ...down];
  const division = newFirst.includes(s.team) ? 1 : 2;
  return createLeague({
    team: s.team, legs: s.legs, seed, season: s.season + 1, division,
    clubs: division === 1 ? newFirst : newSecond, other: division === 1 ? newSecond : newFirst,
    minutes: s.minutes, difficulty: s.difficulty, offside: s.offside, assist: s.assist, formation: s.formation,
  });
}

/** 1-based league position of a club. */
export const positionOf = (s: LeagueState, team: number): number => table(s).findIndex((r) => r.team === team) + 1;

// ---- saving ----
const KEY = 'pitchline.league.v1';

export function loadLeague(): LeagueState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as LeagueState;
    if (!s || !Array.isArray(s.rounds) || !Array.isArray(s.results)) return null;
    if ((s.v as number) === 1) {
      // A season started when there was one division of 16: those clubs are today's first division.
      s.v = 2; s.division = 1; s.clubs = divisionClubs(1); s.other = divisionClubs(2);
    }
    // Reject saves from another version or a different club list.
    const club = (c: unknown) => Number.isInteger(c) && (c as number) >= 0 && (c as number) < TEAMS.length;
    const ok = s.v === 2 && Array.isArray(s.clubs) && Array.isArray(s.other)
      && s.clubs.length === DIV_SIZE && s.other.length === DIV_SIZE
      && new Set([...s.clubs, ...s.other]).size === TEAMS.length && [...s.clubs, ...s.other].every(club)
      && s.clubs.includes(s.team) && s.rounds.length > 0 && s.results.length === s.rounds.length
      && s.rounds.every((r) => Array.isArray(r) && r.length === DIV_SIZE / 2 && r.every(([h, a]) => s.clubs.includes(h) && s.clubs.includes(a)));
    return ok ? s : null;
  } catch { return null; }
}

export function saveLeague(s: LeagueState | null): void {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch { /* storage unavailable: the season lasts until the page closes */ }
}
