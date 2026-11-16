import type { Team } from './ball';
import type { Stats } from './player';
import type { V2 } from './math';

/** +1 if the team attacks toward x = +52.5. */
export const attackDir = (t: Team): 1 | -1 => (t === 'home' ? 1 : -1);
export const otherTeam = (t: Team): Team => (t === 'home' ? 'away' : 'home');

export interface SlotDef { slot: V2; number: number; role: 'field' | 'gk'; pos: string }

const gk: SlotDef = { slot: { x: -1, z: 0 }, number: 1, role: 'gk', pos: 'GK' };
const f = (x: number, z: number, number: number, pos: string): SlotDef => ({ slot: { x, z }, number, role: 'field', pos });
const BACK_FOUR = [f(-0.6, -0.72, 3, 'LB'), f(-0.7, -0.25, 4, 'CB'), f(-0.7, 0.25, 5, 'CB'), f(-0.6, 0.72, 2, 'RB')];

/**
 * Formations in team space: x from -1 (own goal line) to +1 (opponent goal line),
 * z from -1 (left touchline, facing the attack) to +1. Index 0 is always the keeper.
 */
export const FORMATIONS: Record<string, SlotDef[]> = {
  '4-4-2': [gk, ...BACK_FOUR,
    f(-0.2, -0.72, 11, 'LM'), f(-0.3, -0.22, 6, 'CM'), f(-0.3, 0.22, 8, 'CM'), f(-0.2, 0.72, 7, 'RM'),
    f(0.25, -0.22, 10, 'ST'), f(0.25, 0.22, 9, 'ST')],
  '4-3-3': [gk, ...BACK_FOUR,
    f(-0.38, 0, 6, 'DM'), f(-0.2, -0.4, 8, 'CM'), f(-0.2, 0.4, 10, 'CM'),
    f(0.2, -0.7, 11, 'LW'), f(0.3, 0, 9, 'ST'), f(0.2, 0.7, 7, 'RW')],
  '4-2-3-1': [gk, ...BACK_FOUR,
    f(-0.38, -0.2, 6, 'DM'), f(-0.38, 0.2, 8, 'DM'),
    f(0, -0.65, 11, 'LM'), f(0.02, 0, 10, 'AM'), f(0, 0.65, 7, 'RM'),
    f(0.32, 0, 9, 'ST')],
  '3-5-2': [gk, f(-0.7, -0.45, 4, 'CB'), f(-0.72, 0, 5, 'CB'), f(-0.7, 0.45, 6, 'CB'),
    f(-0.25, -0.8, 3, 'LWB'), f(-0.35, 0, 8, 'DM'), f(-0.2, -0.35, 10, 'CM'), f(-0.2, 0.35, 14, 'CM'), f(-0.25, 0.8, 2, 'RWB'),
    f(0.28, -0.2, 11, 'ST'), f(0.28, 0.2, 9, 'ST')],
};
export const FORMATION_NAMES = Object.keys(FORMATIONS);

export interface Kit {
  shirt: number;
  /** Sleeve colour; defaults to the shirt. */
  sleeve?: number;
  shorts: number;
  socks: number;
  gk: number;
}

const colourGap = (a: number, b: number): number =>
  Math.hypot(((a >> 16) & 255) - ((b >> 16) & 255), ((a >> 8) & 255) - ((b >> 8) & 255), (a & 255) - (b & 255));
/** Shirts closer than this are hard to tell apart on the pitch. */
export const KIT_CLASH = 95;

/**
 * Kits for one match. The home side wears its own; if the away shirt is too close to it, the
 * away side changes into a white or dark shirt (whichever stands out more) trimmed in its own colour.
 */
export function matchKits(home: Kit, away: Kit): { home: Kit; away: Kit } {
  if (colourGap(home.shirt, away.shirt) >= KIT_CLASH) return { home, away };
  const light = 0xf1f2f4, dark = 0x1b1e25;
  const shirt = colourGap(light, home.shirt) >= colourGap(dark, home.shirt) ? light : dark;
  // Keep the club colour on sleeves and shorts unless that is the clashing colour's twin of the new shirt.
  const own = colourGap(away.shirt, shirt) >= KIT_CLASH ? away.shirt : away.shorts;
  return { home, away: { shirt, sleeve: own, shorts: own, socks: shirt, gk: away.gk } };
}

export const CREST_SHAPES = ['shield', 'round', 'hex', 'pointed'] as const;
export const CREST_ICONS = ['star', 'crown', 'wave', 'tower', 'bolt', 'tree', 'sun', 'anchor', 'key', 'ball', 'bird', 'mountain'] as const;
export const CREST_PATTERNS = ['plain', 'stripes', 'halves', 'chevron', 'sash', 'quarters'] as const;
export type CrestShape = typeof CREST_SHAPES[number];
export type CrestIcon = typeof CREST_ICONS[number];
export type CrestPattern = typeof CREST_PATTERNS[number];

/** An original club badge, drawn from these parts. */
export interface Crest {
  shape: CrestShape;
  icon: CrestIcon;
  pattern: CrestPattern;
  /** Field colour, pattern colour, trim/icon colour. */
  colors: [number, number, number];
  initials: string;
  founded: number;
}

export interface TeamDef {
  id: string;
  name: string;
  short: string;
  /** One-line playing style shown in the menu. */
  style: string;
  kit: Kit;
  crest: Crest;
  field: Stats;
  keeperReflex: number;
  formation: string;
  /** The division the club starts in: 1 is the top flight. Seasons can move clubs between them. */
  division: 1 | 2;
}

const stats = (speed: number, dribble: number, pass: number, shoot: number, defense: number, stamina = 75): Stats =>
  ({ speed, dribble, pass, shoot, defense, stamina });

const team = (
  id: string, name: string, short: string, style: string, kit: Kit, crest: Crest,
  field: Stats, keeperReflex: number, formation: string,
): TeamDef => ({ id, name, short, style, kit, crest, field, keeperReflex, formation, division: 1 });
/** A club that starts in the second division. */
const team2 = (...a: Parameters<typeof team>): TeamDef => ({ ...team(...a), division: 2 });

/**
 * Fictional league: 32 invented clubs from invented towns, 16 in each of two divisions
 * (the first 16 are the top flight). Names, colours and badges are original; none copies a real club.
 * Club ids and the order of this list are used by saved games, so only add to the end.
 */
export const TEAMS: TeamDef[] = [
  team('blue', '블루 레인저스', '블루', '균형 잡힌 전력',
    { shirt: 0x2f6fed, shorts: 0xf2f4f8, socks: 0x2f6fed, gk: 0x3fbf6f },
    { shape: 'shield', icon: 'star', pattern: 'plain', colors: [0x2f6fed, 0x2f6fed, 0xf2f4f8], initials: 'BR', founded: 1902 },
    stats(78, 76, 76, 78, 72), 72, '4-4-2'),
  team('crimson', '크림슨 FC', '크림슨', '강한 슈팅과 압박',
    { shirt: 0xc8322f, shorts: 0x1a1a1f, socks: 0xc8322f, gk: 0xf2c94c },
    { shape: 'round', icon: 'bolt', pattern: 'halves', colors: [0xc8322f, 0x1a1a1f, 0xf2c94c], initials: 'CFC', founded: 1889 },
    stats(80, 77, 74, 83, 74), 74, '4-3-3'),
  team('white', '화이트 스타즈', '화이트', '정확한 패스 축구',
    { shirt: 0xf3f4f6, sleeve: 0x22252d, shorts: 0x22252d, socks: 0xf3f4f6, gk: 0x9b59d0 },
    { shape: 'hex', icon: 'star', pattern: 'chevron', colors: [0xf3f4f6, 0x22252d, 0x22252d], initials: 'WS', founded: 1911 },
    stats(74, 79, 84, 74, 70), 70, '4-2-3-1'),
  team('orange', '오렌지 시티', '오렌지', '빠른 역습',
    { shirt: 0xe8783b, shorts: 0x1d2330, socks: 0xe8783b, gk: 0x5b6475 },
    { shape: 'round', icon: 'sun', pattern: 'plain', colors: [0xe8783b, 0xe8783b, 0x1d2330], initials: 'OC', founded: 1921 },
    stats(84, 75, 70, 74, 68), 68, '4-4-2'),
  team('black', '블랙 울브스', '블랙', '단단한 수비',
    { shirt: 0x24262c, shorts: 0x24262c, socks: 0xd9a531, gk: 0xe8e86a },
    { shape: 'pointed', icon: 'mountain', pattern: 'sash', colors: [0x24262c, 0xd9a531, 0xd9a531], initials: 'BW', founded: 1896 },
    stats(73, 70, 72, 71, 82), 78, '3-5-2'),
  team('silverbridge', '실버브리지 FC', '실버', '노련한 미드필드',
    { shirt: 0x9aa3ad, sleeve: 0x1c2b4a, shorts: 0x1c2b4a, socks: 0x9aa3ad, gk: 0xe0603a },
    { shape: 'shield', icon: 'tower', pattern: 'quarters', colors: [0x1c2b4a, 0x9aa3ad, 0xf2f4f8], initials: 'SFC', founded: 1884 },
    stats(74, 77, 81, 75, 75), 73, '4-3-3'),
  team('redmoor', '레드무어 로버스', '레드무어', '측면 돌파',
    { shirt: 0xd23a3a, shorts: 0x1b2a4a, socks: 0xf4f4f4, gk: 0x2e8b57 },
    { shape: 'shield', icon: 'mountain', pattern: 'stripes', colors: [0xd23a3a, 0x1b2a4a, 0xf4f4f4], initials: 'RR', founded: 1893 },
    stats(82, 79, 74, 77, 70), 71, '4-4-2'),
  team('kingsharbor', '킹스하버 애슬레틱', '킹스하버', '전방 압박',
    { shirt: 0x1d2c5e, shorts: 0x1d2c5e, socks: 0xf1c40f, gk: 0x9be15d },
    { shape: 'round', icon: 'crown', pattern: 'plain', colors: [0x1d2c5e, 0x1d2c5e, 0xf1c40f], initials: 'KA', founded: 1878 },
    stats(79, 76, 77, 76, 78), 75, '4-3-3'),
  team('greenvale', '그린베일 원더러스', '그린베일', '점유율 축구',
    { shirt: 0x1f7a44, shorts: 0xf5f5f0, socks: 0x1f7a44, gk: 0xf28c28 },
    { shape: 'pointed', icon: 'tree', pattern: 'plain', colors: [0x1f7a44, 0x1f7a44, 0xf5f5f0], initials: 'GW', founded: 1905 },
    stats(73, 80, 82, 72, 72), 70, '4-2-3-1'),
  team('skyport', '스카이포트 시티', '스카이포트', '빠른 패스 전개',
    { shirt: 0x7cc4f2, shorts: 0x0f2340, socks: 0x7cc4f2, gk: 0xf4d03f },
    { shape: 'round', icon: 'wave', pattern: 'halves', colors: [0x7cc4f2, 0xf5f8fb, 0x0f2340], initials: 'SPC', founded: 1930 },
    stats(80, 80, 82, 79, 73), 76, '4-3-3'),
  team('irongate', '아이언게이트', '아이언', '몸싸움과 제공권',
    { shirt: 0x6b1d2e, sleeve: 0x1b1b1b, shorts: 0x1b1b1b, socks: 0x6b1d2e, gk: 0xf2f25a },
    { shape: 'hex', icon: 'key', pattern: 'chevron', colors: [0x6b1d2e, 0x1b1b1b, 0xe8c547], initials: 'IFC', founded: 1899 },
    stats(72, 71, 72, 75, 80), 74, '4-4-2'),
  team('sunsetcoast', '선셋코스트', '선셋', '공격 축구',
    { shirt: 0xf6c21c, shorts: 0x161616, socks: 0x161616, gk: 0x3a7bd5 },
    { shape: 'shield', icon: 'sun', pattern: 'stripes', colors: [0xf6c21c, 0x161616, 0x161616], initials: 'SCFC', founded: 1919 },
    stats(81, 78, 73, 80, 67), 69, '4-3-3'),
  team('noblefield', '노블필드 유나이티드', '노블필드', '조직적인 수비',
    { shirt: 0x5b2a86, shorts: 0xf3f3f3, socks: 0x5b2a86, gk: 0x26c281 },
    { shape: 'pointed', icon: 'crown', pattern: 'sash', colors: [0x5b2a86, 0xf3f3f3, 0xf3f3f3], initials: 'NU', founded: 1888 },
    stats(74, 73, 76, 72, 79), 77, '4-2-3-1'),
  team('stonecrest', '스톤크레스트', '스톤크레스트', '역습 한 방',
    { shirt: 0x4a4f57, sleeve: 0xe85d2a, shorts: 0x4a4f57, socks: 0xe85d2a, gk: 0x7ed6df },
    { shape: 'shield', icon: 'mountain', pattern: 'plain', colors: [0x4a4f57, 0x4a4f57, 0xe85d2a], initials: 'SC', founded: 1910 },
    stats(80, 72, 70, 76, 74), 72, '4-4-2'),
  team('harborlight', '하버라이트 FC', '하버라이트', '젊은 패기',
    { shirt: 0x138a8a, shorts: 0xf08a24, socks: 0x138a8a, gk: 0xe84393 },
    { shape: 'round', icon: 'anchor', pattern: 'quarters', colors: [0x138a8a, 0xf08a24, 0xf5f5f5], initials: 'HFC', founded: 1946 },
    stats(83, 77, 72, 74, 69), 68, '3-5-2'),
  team('eastriver', '이스트리버 SC', '이스트리버', '세트피스 강자',
    { shirt: 0x1e3a8a, sleeve: 0xf5f5f5, shorts: 0xf5f5f5, socks: 0xd33b3b, gk: 0x2ecc71 },
    { shape: 'hex', icon: 'ball', pattern: 'halves', colors: [0x1e3a8a, 0xd33b3b, 0xf5f5f5], initials: 'ERSC', founded: 1901 },
    stats(75, 74, 78, 77, 77), 75, '4-2-3-1'),

  // ---- second division ----
  team2('winterholm', '윈터홀름 FC', '윈터홀름', '끈끈한 수비',
    { shirt: 0xdfe7ee, sleeve: 0x2b4a6f, shorts: 0x2b4a6f, socks: 0xdfe7ee, gk: 0xe2574c },
    { shape: 'hex', icon: 'mountain', pattern: 'plain', colors: [0x2b4a6f, 0x2b4a6f, 0xdfe7ee], initials: 'WFC', founded: 1907 },
    stats(69, 66, 68, 66, 76), 72, '4-4-2'),
  team2('briarrock', '브라이어록 타운', '브라이어록', '거친 압박',
    { shirt: 0x7a3b1e, shorts: 0xf0e6d2, socks: 0x7a3b1e, gk: 0x3aa0c8 },
    { shape: 'shield', icon: 'tower', pattern: 'sash', colors: [0x7a3b1e, 0xf0e6d2, 0xf0e6d2], initials: 'BT', founded: 1894 },
    stats(72, 67, 66, 69, 72), 68, '4-3-3'),
  team2('copperhill', '코퍼힐 유나이티드', '코퍼힐', '긴 패스와 제공권',
    { shirt: 0xc46a2b, shorts: 0x263238, socks: 0x263238, gk: 0x8bc34a },
    { shape: 'round', icon: 'key', pattern: 'quarters', colors: [0xc46a2b, 0x263238, 0xf5f0e6], initials: 'CU', founded: 1912 },
    stats(70, 66, 71, 70, 70), 69, '4-4-2'),
  team2('foxmere', '폭스미어', '폭스미어', '빠른 측면',
    { shirt: 0xe9547a, shorts: 0x1c1c22, socks: 0x1c1c22, gk: 0x4dd0e1 },
    { shape: 'pointed', icon: 'bolt', pattern: 'plain', colors: [0x1c1c22, 0x1c1c22, 0xe9547a], initials: 'FM', founded: 1926 },
    stats(77, 71, 66, 68, 64), 66, '4-3-3'),
  team2('glenwater', '글렌워터 로버스', '글렌워터', '짧은 패스 축구',
    { shirt: 0x3fb8a4, shorts: 0xf4f6f5, socks: 0x3fb8a4, gk: 0x7e57c2 },
    { shape: 'round', icon: 'wave', pattern: 'chevron', colors: [0x3fb8a4, 0xf4f6f5, 0x14403a], initials: 'GR', founded: 1903 },
    stats(68, 72, 75, 67, 66), 67, '4-2-3-1'),
  team2('ashdown', '애시다운 애슬레틱', '애시다운', '균형과 끈기',
    { shirt: 0x8d939c, shorts: 0x8d939c, socks: 0xc2185b, gk: 0xffb300 },
    { shape: 'shield', icon: 'tree', pattern: 'halves', colors: [0x8d939c, 0x3a3f47, 0xc2185b], initials: 'AA', founded: 1891 },
    stats(70, 69, 70, 69, 70), 70, '4-4-2'),
  team2('northcape', '노스케이프', '노스케이프', '역습 축구',
    { shirt: 0x0f3d5c, sleeve: 0x8fd3e8, shorts: 0x0f3d5c, socks: 0x8fd3e8, gk: 0xf06292 },
    { shape: 'pointed', icon: 'anchor', pattern: 'plain', colors: [0x0f3d5c, 0x0f3d5c, 0x8fd3e8], initials: 'NC', founded: 1923 },
    stats(75, 68, 67, 70, 68), 71, '3-5-2'),
  team2('oldmill', '올드밀 FC', '올드밀', '노련한 경기 운영',
    { shirt: 0x5d6b2f, shorts: 0xf2ead3, socks: 0x5d6b2f, gk: 0xff7043 },
    { shape: 'hex', icon: 'sun', pattern: 'stripes', colors: [0x5d6b2f, 0xf2ead3, 0xf2ead3], initials: 'OM', founded: 1882 },
    stats(65, 70, 74, 68, 71), 72, '4-2-3-1'),
  team2('lakehaven', '레이크헤이븐', '레이크헤이븐', '점유율 축구',
    { shirt: 0xb39ddb, shorts: 0x2a2145, socks: 0x2a2145, gk: 0xdce775 },
    { shape: 'round', icon: 'bird', pattern: 'plain', colors: [0x2a2145, 0x2a2145, 0xb39ddb], initials: 'LH', founded: 1934 },
    stats(69, 73, 73, 66, 65), 66, '4-3-3'),
  team2('stormford', '스톰포드', '스톰포드', '강한 중거리 슛',
    { shirt: 0x37474f, shorts: 0x37474f, socks: 0xcddc39, gk: 0xff8a65 },
    { shape: 'shield', icon: 'bolt', pattern: 'chevron', colors: [0x37474f, 0xcddc39, 0xcddc39], initials: 'SF', founded: 1909 },
    stats(71, 67, 67, 75, 67), 67, '4-4-2'),
  team2('belltower', '벨타워 시티', '벨타워', '세트피스 한 방',
    { shirt: 0xf3e9d2, sleeve: 0x7b1f3a, shorts: 0x7b1f3a, socks: 0xf3e9d2, gk: 0x26a69a },
    { shape: 'pointed', icon: 'tower', pattern: 'halves', colors: [0xf3e9d2, 0x7b1f3a, 0x7b1f3a], initials: 'BC', founded: 1886 },
    stats(67, 68, 72, 71, 69), 70, '4-2-3-1'),
  team2('pineridge', '파인리지', '파인리지', '많이 뛰는 축구',
    { shirt: 0x1b4d3e, shorts: 0x1b4d3e, socks: 0xf28b30, gk: 0xe6e6e6 },
    { shape: 'hex', icon: 'tree', pattern: 'sash', colors: [0x1b4d3e, 0xf28b30, 0xf28b30], initials: 'PR', founded: 1915 },
    stats(74, 66, 66, 67, 71), 68, '3-5-2'),
  team2('saltmarsh', '솔트마시 타운', '솔트마시', '단단한 수비 블록',
    { shirt: 0xd9c9a3, shorts: 0x3b5b7a, socks: 0x3b5b7a, gk: 0xef5350 },
    { shape: 'round', icon: 'anchor', pattern: 'stripes', colors: [0xd9c9a3, 0x3b5b7a, 0x3b5b7a], initials: 'ST', founded: 1898 },
    stats(66, 65, 69, 65, 75), 73, '4-4-2'),
  team2('highmoor', '하이무어 원더러스', '하이무어', '젊고 빠른 팀',
    { shirt: 0x4527a0, shorts: 0x4527a0, socks: 0xa5d63f, gk: 0xffa726 },
    { shape: 'shield', icon: 'star', pattern: 'sash', colors: [0x4527a0, 0xa5d63f, 0xa5d63f], initials: 'HW', founded: 1938 },
    stats(76, 72, 66, 69, 63), 65, '4-3-3'),
  team2('emberfield', '엠버필드', '엠버필드', '과감한 공격',
    { shirt: 0xff7b54, shorts: 0x10243f, socks: 0xff7b54, gk: 0xb2dfdb },
    { shape: 'pointed', icon: 'sun', pattern: 'quarters', colors: [0xff7b54, 0x10243f, 0xfff3e0], initials: 'EF', founded: 1920 },
    stats(73, 71, 68, 73, 62), 65, '4-3-3'),
  team2('crowfield', '크로우필드 SC', '크로우필드', '끈질긴 맨마킹',
    { shirt: 0x15171c, sleeve: 0x8a8f98, shorts: 0x15171c, socks: 0x15171c, gk: 0xd4e157 },
    { shape: 'hex', icon: 'bird', pattern: 'plain', colors: [0x15171c, 0x15171c, 0xc9ced6], initials: 'CSC', founded: 1904 },
    stats(68, 67, 68, 67, 74), 71, '4-4-2'),
];

/** Clubs per division. */
export const DIV_SIZE = 16;
/** Clubs promoted and relegated at the end of a season. */
export const MOVES = 3;
export const DIVISION_NAME: Record<1 | 2, string> = { 1: '1부 리그', 2: '2부 리그' };
/** Club indices that start in a division. */
export const divisionClubs = (d: 1 | 2): number[] => TEAMS.map((t, i) => (t.division === d ? i : -1)).filter((i) => i >= 0);

export const overall = (t: TeamDef): number => {
  const s = t.field;
  return Math.round((s.speed + s.dribble + s.pass + s.shoot + s.defense) / 5);
};
