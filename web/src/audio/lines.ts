/**
 * Everything the commentary booth can say, as fixed fragments. A spoken line is one or more
 * fragments with club and player names slotted between them, so every fragment (and every
 * built-in name) can be recorded ahead of time and stitched together when it is needed.
 * This file has no browser code: the recording script reads the same catalogue.
 */
export type Who = 'caster' | 'analyst';
/** How a line is delivered (see MOOD in commentary.ts for the fallback voice, and the recording script for the acted one). */
export type Mood = 'calm' | 'quick' | 'tense' | 'shout' | 'joy' | 'sad' | 'shock';
export interface Frag { who: Who; mood: Mood; text: string }

const C = (mood: Mood, ...texts: string[]): Frag[] => texts.map((text) => ({ who: 'caster', mood, text }));
const A = (mood: Mood, ...texts: string[]): Frag[] => texts.map((text) => ({ who: 'analyst', mood, text }));

/** Stable id of a fragment: the same words in the same voice and mood keep their recording. */
export function fragId(f: Frag): string {
  let h = 2166136261;
  const s = `${f.who}|${f.mood}|${f.text}`;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Clip keys: fragments, player names (caster only), club names per voice, and club names with the subject particle. */
export const KEY = {
  frag: (f: Frag) => `f:${fragId(f)}`,
  player: (name: string) => `p:${name}`,
  team: (who: Who, name: string) => `t:${who === 'caster' ? 'c' : 'a'}:${name}`,
  teamGa: (name: string) => `g:${name}`,
};

/** Subject particle for a name: 이 after a final consonant, 가 otherwise ("블루 레인저스가", "크림슨이"). */
export const iga = (word: string): string => {
  const w = word.trim(), c = w.charCodeAt(w.length - 1);
  if (c >= 0xac00 && c <= 0xd7a3) return `${word}${(c - 0xac00) % 28 ? '이' : '가'}`;
  return `${word}${/[lmnr136780]$/i.test(w) ? '이' : '가'}`;
};

/** The goal cry the user picked from the trial takes; its recording is kept as it is. */
export const GOAL_CRY: Frag = { who: 'caster', mood: 'shout', text: '들어갔습니다! 고오오오올!' };

export const CAT = {
  // ---- start, restarts, end ----
  start: C('joy', '안녕하십니까! 축구 팬 여러분, 지금 경기 시작합니다!'),
  startA: A('calm', '네, 양 팀 모두 준비를 잘하고 나왔습니다. 기대되는 경기네요.', '초반 기 싸움이 중요합니다. 누가 먼저 주도권을 잡을지 보시죠.'),
  second: C('quick', '후반전 시작됩니다!'),
  secondA: A('calm', '후반은 체력 싸움입니다. 교체 카드가 변수가 되겠네요.', '전반과는 다른 흐름이 나올 수 있습니다.'),
  restart: C('quick', '다시 경기 이어갑니다.', '중앙에서 다시 시작합니다.'),
  half: C('quick', '전반전 종료!'),
  level: C('quick', '동점입니다.'),
  ahead: C('quick', '앞서 있습니다.'),
  halfShotsA: A('calm', '쪽이 전반에 더 적극적이었습니다.'),
  halfEvenA: A('calm', '팽팽한 전반이었습니다. 후반에 승부가 갈리겠네요.'),
  full: C('shout', '경기 종료! 휘슬이 울립니다!'),
  win: C('joy', '승리를 가져갑니다!'),
  winPens: C('joy', '승부차기 끝에 승리를 가져갑니다!'),
  draw: C('quick', '무승부로 끝납니다.'),
  winA: A('joy', '정말 대단한 경기였습니다! 이길 자격이 충분했어요!', '끝까지 집중력을 잃지 않은 쪽이 가져갔네요. 박수를 보냅니다!'),
  drawA: A('sad', '아, 양 팀 모두 아쉬움이 남는 결과입니다.'),
  bye: C('quick', '지금까지 함께해 주셔서 감사합니다!'),
  // ---- shots and goals ----
  shot: C('tense', '슛!', '슈팅!', '때립니다!', '직접 노립니다!'),
  goalCall: C('joy', '골입니다!', '터졌습니다!', '그물을 흔듭니다!'),
  goalEqual: C('joy', '동점골입니다!'),
  goalLead: C('joy', '앞서 나갑니다!'),
  goalMore: C('joy', '점수 차를 벌립니다!'),
  goalWow: A('joy', '와아! 정말 대단합니다!', '이야, 이걸 넣네요!', '소름이 돋습니다!'),
  goalEqualA: A('joy', '경기가 원점으로 돌아갔습니다. 이제부터가 진짜죠.', '포기하지 않은 결과입니다. 분위기가 완전히 넘어왔어요.'),
  goalMoreA: A('joy', '이 골은 치명적입니다. 상대가 따라가기 쉽지 않겠어요.', '완전히 흐름을 탔습니다.'),
  goalA: A('joy', '마무리가 아주 침착했습니다.', '수비가 순간적으로 공간을 내줬어요. 놓치지 않았습니다.', '보셨습니까, 완벽한 결정력입니다!'),
  own: C('shock', '아아아! 자책골!'),
  own2: C('shock', '자책골입니다! 이게 무슨 일입니까!'),
  ownA: A('sad', '수비 입장에서는 정말 아쉬운 장면입니다.', '걷어내려다 그대로 들어가 버렸네요.'),
  save: C('shout', '막았습니다아!', '선방! 슈퍼 세이브!', '아아, 막아냅니다!'),
  saveKeeper: C('tense', '골키퍼! 몸을 날려 걷어냅니다!', '골키퍼입니다! 엄청난 선방!'),
  saveNoName: C('tense', '골키퍼가 걷어냅니다!'),
  saveA: A('joy', '와, 이걸 막아내네요! 반응 속도가 정말 대단합니다!', '들어가는 줄 알았습니다! 골키퍼를 칭찬해야 해요!', '코스가 좋았는데, 골키퍼가 읽고 있었어요!'),
  post: C('shout', '골대애애!', '아아아, 골대!'),
  post2: C('shock', '골대를 맞고 나옵니다! 이럴 수가!'),
  postA: A('sad', '아아, 몇 센티미터 차이였는데요. 정말 너무 아깝습니다.', '하아, 골대가 살렸습니다. 운이 따르지 않네요.'),
  miss: C('sad', '아아아, 빗나갑니다.', '아, 골문을 벗어납니다.', '아이고, 살짝 빗나갑니다.'),
  missA: A('sad', '아, 이건 넣어 줬어야죠. 너무 아쉽습니다.', '하아, 힘이 너무 들어갔어요.', '아깝습니다. 그래도 이런 슈팅이 계속 나와야 해요.'),
  // ---- set pieces and stoppages ----
  goalkick: C('quick', '골킥입니다.'),
  cornerShot: C('tense', '아, 수비 맞고 나갑니다! 코너킥!'),
  corner: C('quick', '코너킥입니다!'),
  cornerA: A('calm', '세트피스, 좋은 기회입니다!', '수비는 정신 바짝 차려야 할 순간이죠.'),
  throwIn: C('quick', '스로인입니다.', '터치라인 밖으로 나갑니다.'),
  tackle: C('tense', '끊어냅니다!', '공을 빼앗습니다!', '좋은 수비입니다!'),
  tackleNoName: C('tense', '태클! 공을 빼앗습니다!', '끊어냅니다!'),
  block: C('quick', '수비 맞고 굴절됩니다.', '몸으로 막아냅니다!'),
  foul: C('tense', '아, 파울입니다!', '반칙! 휘슬이 울립니다!'),
  foulA: A('calm', '아이고, 조금 늦게 들어갔어요.', '무리한 시도였습니다.', '심판이 정확하게 봤네요.'),
  penalty: C('shout', '페널티킥! 페널티킥!'),
  penalty2: C('shock', '심판이 페널티 지점을 가리킵니다! 엄청난 변수가 생겼습니다!'),
  penaltyA: A('shock', '아아, 박스 안에서 저렇게 들어가면 안 되죠! 정말 치명적인 반칙입니다!'),
  offside: C('sad', '아, 오프사이드! 깃발이 올라갑니다.'),
  offsideA: A('calm', '아쉽네요. 타이밍이 반 박자 빨랐어요.', '수비 라인이 정말 잘 올라왔습니다.'),
  yellow: C('tense', '옐로카드!'),
  yellow2: C('tense', '경고를 받습니다!'),
  yellowA: A('calm', '이제 정말 조심해야 합니다. 한 장 더 받으면 퇴장이에요.'),
  red: C('shout', '레드카드! 퇴장! 퇴장입니다!'),
  red2: C('shock', '그라운드를 떠납니다! 이게 웬일입니까!'),
  redA: A('shock', '아아, 한 명이 부족해졌습니다! 경기 흐름이 완전히 바뀔 수 있어요!'),
  sub: C('quick', '선수 교체가 있습니다.'),
  subA: A('calm', '체력 안배를 위한 교체로 보입니다.', '분위기를 바꿔 보겠다는 의도죠.'),
  // ---- extra time and the shoot-out ----
  extra: C('tense', '90분으로는 승부를 가리지 못했습니다! 연장전! 먼저 넣는 팀이 이깁니다!'),
  extraA: A('tense', '이제 한 골이면 끝입니다! 실수 하나가 그대로 탈락이에요!'),
  shootout: C('tense', '연장전에도 골이 없습니다! 승부차기! 운명의 승부차기로 갑니다!'),
  shootoutA: A('tense', '아, 손에 땀이 납니다. 여기서부터는 심리전이에요.'),
  penGoal: C('joy', '성공! 넣었습니다아!', '골! 구석에 꽂힙니다!', '침착하게! 성공입니다!'),
  penGoalA: A('joy', '완벽한 킥이었어요! 골키퍼가 손도 못 썼습니다!', '강심장입니다, 정말!'),
  penSaved: C('shout', '막았습니다아아!', '선방! 골키퍼가 막아냅니다!'),
  penSavedA: A('joy', '와, 방향을 완전히 읽었네요!', '골키퍼가 영웅이 되는 순간입니다!'),
  penMissed: C('shock', '아아아, 실축! 실축입니다!', '아, 벗어납니다! 이럴 수가!'),
  penMissedA: A('sad', '하아, 부담감이 너무 컸던 것 같습니다. 고개를 들지 못하네요.'),
  // ---- open play ----
  longPass: C('quick', '길게 넘깁니다!', '길게 연결합니다!'),
  danger: C('tense', '박스 근처까지 왔습니다!', '안으로 파고듭니다! 기회예요!'),
  dangerTeam: C('tense', '위험한 지역입니다!'),
  mid: C('quick', '공 몰고 올라갑니다.', '전방을 살핍니다.'),
  midTeam: C('quick', '공격 전개합니다.', '상대 진영에서 공을 돌립니다.'),
  back: C('quick', '공 잡았습니다.'),
  backTeam: C('quick', '뒤에서부터 풀어갑니다.', '천천히 빌드업 합니다.'),
  lateLosingTeamA: A('tense', '시간이 없습니다. 과감해져야 해요.'),
  lateLosingA: A('tense', '이제는 위험을 감수해야 할 시간입니다.'),
  lateWinningTeamA: A('calm', '서두를 이유가 없죠. 시간을 써야 합니다.'),
  lateWinningOppA: A('calm', '입장에서는 속이 타는 시간입니다.'),
  lateA: A('calm', '후반 막판입니다. 체력이 떨어질 시간이라 집중력이 중요해요.'),
  dangerA: A('tense', '여기서 마무리가 중요합니다!', '수비 숫자가 많아요, 침착해야 합니다!', '슈팅 각이 나옵니다! 때려야죠!'),
  midOppA: A('calm', '수비가 간격을 잘 유지하고 있습니다.'),
  midA: A('calm', '측면을 활용하면 좋을 것 같은데요.', '패스 템포를 조금 더 올려야 합니다.', '침투하는 선수의 움직임이 좋습니다.'),
  backOppA: A('calm', '전방 압박이 강합니다.'),
  backA: A('calm', '무리하지 않는 선택이 좋아요.', '공간을 만드는 움직임이 필요합니다.'),
} satisfies Record<string, Frag[]>;

/** Every fragment there is, for the recording script. */
export const allFragments = (): Frag[] => [GOAL_CRY, ...Object.values(CAT).flat()];
