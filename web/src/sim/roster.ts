import type { Look, Stats } from './player';
import { playerNameOverride } from './custom';
import { createRng, type Rng } from './rng';
import type { SlotDef, TeamDef } from './team';

export type Category = 'GK' | 'DF' | 'MF' | 'FW';

export interface RosterPlayer {
  name: string;
  number: number;
  cat: Category;
  stats: Stats;
  /** Goalkeepers only. */
  reflex: number;
  look: Look;
}

const SURNAMES = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임', '한', '오', '서', '신', '권', '황', '안', '송', '류', '홍', '전', '고', '문', '양', '손', '배', '백', '허', '남', '노'];
const SYLLABLES = ['민', '준', '서', '현', '우', '지', '도', '윤', '하', '진', '태', '성', '호', '재', '영', '수', '훈', '빈', '혁', '원', '석', '규', '찬', '경', '동', '형', '승', '기', '정', '연'];
// International squad: invented first-name + surname pairs (combos that match famous players were removed).
const FIRST = ['마르코', '루카스', '토마스', '다니엘', '제임스', '올리버', '마테오', '하비에르', '라파엘', '안드레', '니콜라스',
  '사무엘', '이삭', '요나스', '에밀', '빅토르', '알렉스', '레오', '카를로스', '파블로', '이브라힘', '무사', '유수프', '라이언',
  '조엘', '니코', '아담', '막스', '하루토', '켄지', '아마두', '오스카', '펠릭스', '이반', '미겔', '안톤', '라스', '닐스', '테오', '줄리안'];
export const LAST = ['벨리니', '하르트', '페레이라', '콜린스', '오코로', '모로', '반더베르크', '노박', '로시', '가르시아', '마르틴', '베버',
  '클라인', '디알로', '은도예', '산토스', '코바치', '린드', '에릭손', '피셔', '브라운', '워커', '해리스', '로페스', '사토', '다나카',
  '니콜스', '맥길', '오브라이언', '몬테로', '레예스', '카스트로', '야블론스키', '페트로프', '루소', '베르나르', '뒤부아',
  '에스포지토', '퀸', '테일러', '바스케스', '하산', '오카포', '홀름', '바렌', '스텐', '모레노', '멘사', '아도', '케레스'];
const SKINS = [0xf1c7a5, 0xe0ac86, 0xc98d64, 0x9a6440, 0x6b4428];
const HAIRS = [0x1d1510, 0x2a1d14, 0x4a2f1c, 0x8a5a2b, 0xc9a35a, 0x111111];

/** Where each formation slot label sits for squad selection. */
export function slotCategory(pos: string): Category {
  if (pos === 'GK') return 'GK';
  if (['LB', 'CB', 'RB'].includes(pos)) return 'DF';
  if (['ST', 'LW', 'RW'].includes(pos)) return 'FW';
  return 'MF'; // DM, CM, LM, RM, AM, LWB, RWB
}

/**
 * The Korean names new players can have (club development mode). There are far too many
 * possible Korean names to record them all for the commentary, so newcomers draw from this
 * fixed list, every name of which has a recording.
 */
export const KOREAN_POOL: readonly string[] = (() => {
  const rng = createRng(0x4b4f5245);
  const out = new Set<string>();
  while (out.size < 160) {
    const a = SYLLABLES[(rng() * SYLLABLES.length) | 0], b = SYLLABLES[(rng() * SYLLABLES.length) | 0];
    if (a !== b) out.add(SURNAMES[(rng() * SURNAMES.length) | 0] + a + b);
  }
  return [...out];
})();

const EYES = [0x4a2f1c, 0x4a2f1c, 0x2e1c10, 0x2e1c10, 0x3d6fa8, 0x4f7a43, 0x6b4a2a];

/** An invented name and face for a new player (club development mode); `used` keeps names unique. */
export function personFor(rng: Rng, used: Set<string>): { name: string; look: Look } {
  const pick = <T>(arr: readonly T[]) => arr[(rng() * arr.length) | 0];
  let name = '';
  for (let tries = 0; tries < 50; tries++) {
    name = rng() < 0.2 ? pick(KOREAN_POOL) : `${pick(FIRST)} ${pick(LAST)}`;
    if (!used.has(name)) break;
  }
  used.add(name);
  return { name, look: { skin: pick(SKINS), hair: pick(HAIRS), style: pick([0, 0, 1, 2, 3] as const), eye: pick(EYES) } };
}

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/**
 * 16 fictional players per team; the same team always gets the same squad.
 * Names the player changed in the editor replace the generated ones unless `builtIn` is set.
 */
export function buildRoster(team: TeamDef, builtIn = false): RosterPlayer[] {
  const rng = createRng(hash(team.id));
  const pick = <T>(arr: T[]) => arr[(rng() * arr.length) | 0];
  const used = new Set<string>();
  const name = () => {
    for (;;) {
      // Mostly international names, with some Korean players in every squad.
      let n: string;
      if (rng() < 0.2) {
        const a = pick(SYLLABLES);
        let b = pick(SYLLABLES);
        while (b === a) b = pick(SYLLABLES);
        n = pick(SURNAMES) + a + b;
      } else {
        n = `${pick(FIRST)} ${pick(LAST)}`;
      }
      if (!used.has(n)) { used.add(n); return n; }
    }
  };
  const nameFor = (i: number, generated: string) => (builtIn ? undefined : playerNameOverride(team.id, i)) ?? generated;
  const numbers = new Set<number>();
  const number = (pref: number[]) => {
    for (const n of pref) if (!numbers.has(n)) { numbers.add(n); return n; }
    for (;;) {
      const n = 2 + ((rng() * 40) | 0);
      if (!numbers.has(n)) { numbers.add(n); return n; }
    }
  };
  const base = team.field;
  const v = (x: number, d: number) => Math.max(40, Math.min(95, Math.round(x + d + (rng() - 0.5) * 10)));
  const look = (): Look => ({ skin: pick(SKINS), hair: pick(HAIRS), style: pick([0, 0, 1, 2, 3] as const), eye: pick(EYES) });

  const plan: [Category, number[]][] = [
    ['GK', [1]], ['GK', [12]],
    ['DF', [2, 3, 4, 5]], ['DF', [3, 4, 5]], ['DF', [4, 5, 15]], ['DF', [5, 15]], ['DF', [15, 22]], ['DF', [22, 24]],
    ['MF', [6, 8]], ['MF', [8, 10]], ['MF', [10, 14]], ['MF', [7, 16]], ['MF', [16, 18]],
    ['FW', [9]], ['FW', [11, 19]], ['FW', [19, 20]],
  ];
  return plan.map(([cat, pref], i) => {
    const d = { speed: 0, dribble: 0, pass: 0, shoot: 0, defense: 0 };
    if (cat === 'DF') { d.defense = 6; d.shoot = -10; d.dribble = -4; }
    if (cat === 'MF') { d.pass = 5; d.dribble = 2; }
    if (cat === 'FW') { d.shoot = 6; d.speed = 3; d.defense = -14; }
    if (cat === 'GK') { d.speed = -12; d.shoot = -25; d.dribble = -20; }
    // The last players in each group are squad players, a little weaker.
    const depth = [1, 7, 12, 15].includes(i) ? -4 : 0;
    const stats: Stats = {
      speed: v(base.speed, d.speed + depth), dribble: v(base.dribble, d.dribble + depth),
      pass: v(base.pass, d.pass + depth), shoot: v(base.shoot, d.shoot + depth),
      defense: v(base.defense, d.defense + depth), stamina: v(base.stamina, depth),
    };
    return {
      name: nameFor(i, name()), number: number(pref), cat, stats,
      reflex: cat === 'GK' ? Math.round(team.keeperReflex + (i === 0 ? 2 : -8)) : 0,
      look: look(),
    };
  });
}

export const playerOverall = (r: RosterPlayer): number =>
  r.cat === 'GK' ? r.reflex
    : Math.round((r.stats.speed + r.stats.dribble + r.stats.pass + r.stats.shoot + r.stats.defense) / 5);

/** Best eleven for a formation (slot order), and the bench. */
export function pickLineup(roster: RosterPlayer[], formation: SlotDef[]): { starters: RosterPlayer[]; bench: RosterPlayer[] } {
  const free = [...roster];
  const starters = formation.map((slot) => {
    const want = slotCategory(slot.pos);
    const order = want === 'GK' ? ['GK'] : [want, 'MF', 'DF', 'FW'];
    for (const cat of order) {
      const cands = free.filter((r) => r.cat === cat).sort((a, b) => playerOverall(b) - playerOverall(a));
      if (cands.length) { free.splice(free.indexOf(cands[0]), 1); return cands[0]; }
    }
    return free.shift()!;
  });
  return { starters, bench: free };
}
