import { quickScore, shootoutScore, type Score } from './league';
import type { Difficulty } from './match';
import { createRng, type Rng } from './rng';
import { TEAMS } from './team';

/**
 * Knock-out cup: every club is drawn into a bracket and one match decides each tie.
 * A level match goes to penalties, so every tie has a winner. The player's own tie is played
 * for real; the others are settled by the league's quick goal model. Once the player is
 * knocked out the rest of the cup is settled straight away. Plain data, so it can be saved.
 */
export interface Tie {
  home: number;
  away: number;
  score: Score | null;
  /** Shoot-out score when the match ended level. */
  pens: Score | null;
}

export interface CupState {
  v: 1;
  edition: number;
  /** The player's club, as an index into TEAMS. */
  team: number;
  seed: number;
  /** Rounds drawn so far; the last one is the round being played unless the cup is over. */
  rounds: Tie[][];
  champion: number | null;
  // Match settings for the player's games.
  minutes: number;
  difficulty: Difficulty;
  offside: boolean;
  assist: boolean;
  formation: string;
}

export interface CupOptions {
  team: number; seed: number; edition?: number;
  minutes: number; difficulty: Difficulty; offside: boolean; assist: boolean; formation?: string;
}

/** The player's result: goals as [player's side, opponent], and the shoot-out the same way if there was one. */
export interface CupResult { score: Score; pens: Score | null }

/** Number of rounds: 5 for all 32 clubs. A cup saved when there were 16 clubs keeps its 4. */
export const cupRounds = (s?: CupState): number => Math.round(Math.log2(s ? s.rounds[0].length * 2 : TEAMS.length));

/** Name of a round by its index, in a cup of `total` rounds. */
export function roundName(round: number, total = cupRounds()): string {
  const left = total - round; // rounds still to play, counting this one
  return left <= 1 ? '결승' : left === 2 ? '준결승' : `${2 ** left}강`;
}

const tie = (a: number, b: number, rng: Rng): Tie =>
  (rng() < 0.5 ? { home: a, away: b, score: null, pens: null } : { home: b, away: a, score: null, pens: null });

export function createCup(o: CupOptions): CupState {
  const rng = createRng(o.seed);
  const ids = TEAMS.map((_, i) => i);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const first: Tie[] = [];
  for (let i = 0; i < ids.length; i += 2) first.push(tie(ids[i], ids[i + 1], rng));
  return {
    v: 1, edition: o.edition ?? 1, team: o.team, seed: o.seed, rounds: [first], champion: null,
    minutes: o.minutes, difficulty: o.difficulty, offside: o.offside, assist: o.assist,
    formation: o.formation ?? TEAMS[o.team].formation,
  };
}

export const cupOver = (s: CupState): boolean => s.champion !== null;

/** Winner of a finished tie, or null if it has not been played. */
export function tieWinner(t: Tie): number | null {
  if (!t.score) return null;
  const [h, a] = t.score[0] !== t.score[1] ? t.score : t.pens ?? t.score;
  return h > a ? t.home : t.away;
}

/** The player's tie in the round being played, or null if they are out or the cup is over. */
export function myTie(s: CupState): { index: number; tie: Tie; home: boolean; opponent: number } | null {
  if (cupOver(s)) return null;
  const round = s.rounds[s.rounds.length - 1];
  const index = round.findIndex((t) => t.home === s.team || t.away === s.team);
  if (index < 0) return null;
  const t = round[index], home = t.home === s.team;
  return { index, tie: t, home, opponent: home ? t.away : t.home };
}

/** Round index where the player's cup ended in defeat, or null if they are still in or won it. */
export function knockedOutIn(s: CupState): number | null {
  for (let r = 0; r < s.rounds.length; r++) {
    const t = s.rounds[r].find((x) => x.home === s.team || x.away === s.team);
    if (!t) return null;
    const w = tieWinner(t);
    if (w !== null && w !== s.team) return r;
  }
  return null;
}

function settle(t: Tie, rng: Rng): void {
  // Both draws are always taken, so the other ties do not depend on the player's result.
  const score = quickScore(TEAMS[t.home], TEAMS[t.away], rng);
  const pens = shootoutScore(TEAMS[t.home], TEAMS[t.away], rng);
  if (t.score) return;
  t.score = score;
  t.pens = score[0] === score[1] ? pens : null;
}

/**
 * Finish the round being played. `mine` is the player's result; pass null to have it simulated.
 * If the player goes out, the remaining rounds are settled too.
 */
export function playCupRound(s: CupState, mine: CupResult | null): void {
  for (;;) {
    if (cupOver(s)) return;
    const r = s.rounds.length - 1, round = s.rounds[r];
    const me = myTie(s);
    if (me && mine) {
      const flip = (x: Score): Score => (me.home ? [x[0], x[1]] : [x[1], x[0]]);
      me.tie.score = flip(mine.score);
      me.tie.pens = mine.score[0] === mine.score[1] ? flip(mine.pens ?? [1, 0]) : null;
    }
    mine = null;
    const rng = createRng((s.seed ^ Math.imul(r + 1, 0x9e3779b1)) >>> 0);
    for (const t of round) settle(t, rng);
    const winners = round.map((t) => tieWinner(t)!);
    if (winners.length === 1) { s.champion = winners[0]; return; }
    const next: Tie[] = [];
    for (let i = 0; i < winners.length; i += 2) next.push(tie(winners[i], winners[i + 1], rng));
    s.rounds.push(next);
    if (winners.includes(s.team)) return; // still in: the next round waits for the player
  }
}

// ---- saving ----
const KEY = 'pitchline.cup.v1';

export function loadCup(): CupState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as CupState;
    // Reject saves from another version or a different club list.
    const ok = s && s.v === 1 && Array.isArray(s.rounds) && s.rounds.length > 0 && Array.isArray(s.rounds[0])
      && [8, TEAMS.length / 2].includes(s.rounds[0].length) && s.rounds.length <= cupRounds(s)
      && s.team >= 0 && s.team < TEAMS.length
      && s.rounds.every((r) => Array.isArray(r) && r.every((t) => TEAMS[t.home] && TEAMS[t.away]));
    return ok ? s : null;
  } catch { return null; }
}

export function saveCup(s: CupState | null): void {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch { /* storage unavailable: the cup lasts until the page closes */ }
}
