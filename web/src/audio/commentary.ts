import type { Team } from '../sim/ball';
import type { Match, MatchEvent } from '../sim/match';

const STORE_KEY = 'pitchline.commentary.v1';
/** Choose one line, avoiding the ones said most recently so the booth does not repeat itself. */
const recent: string[] = [];
const pick = (xs: readonly string[]): string => {
  const fresh = xs.filter((x) => !recent.includes(x));
  const from = fresh.length ? fresh : xs;
  const x = from[(Math.random() * from.length) | 0];
  recent.push(x);
  if (recent.length > 14) recent.shift();
  return x;
};
/** Importance of a line: a more important one interrupts, a less important one is dropped while another is being said. */
const enum P { Colour = 1, Play = 2, Event = 3, Big = 4 }
/** The two voices in the booth: the play-by-play caster and the analyst beside him. */
type Who = 'caster' | 'analyst';
/**
 * How a line is delivered. The built-in voices have no acting in them, so feeling is put on from
 * outside: how fast, how high and how loud each line is said, and how it is worded (a goal is
 * drawn out and shouted, a miss is said low and slow).
 */
type Mood = 'calm' | 'quick' | 'tense' | 'shout' | 'joy' | 'sad' | 'shock';
const MOOD: Record<Mood, { rate: number; pitch: number; vol: number }> = {
  calm: { rate: 1, pitch: 1, vol: 0.8 },      // the analyst thinking aloud
  quick: { rate: 1.05, pitch: 1.04, vol: 0.85 }, // ordinary play-by-play
  tense: { rate: 1.22, pitch: 1.22, vol: 1 },  // a chance is on
  shout: { rate: 0.92, pitch: 1.75, vol: 1 },  // the big cry: drawn out, as high and loud as it goes
  joy: { rate: 1.16, pitch: 1.45, vol: 1 },    // thrilled
  sad: { rate: 0.8, pitch: 0.74, vol: 0.85 },  // a sigh
  shock: { rate: 1.12, pitch: 1.5, vol: 1 },   // "what was that!"
};
interface Line { who: Who; text: string; mood: Mood }
const C = (text: string, mood: Mood = 'quick'): Line => ({ who: 'caster', text, mood });
const A = (text: string, mood: Mood = 'calm'): Line => ({ who: 'analyst', text, mood });

/** Subject particle for a name: 이 after a final consonant, 가 otherwise ("블루 레인저스가", "크림슨이"). */
const iga = (word: string): string => {
  const w = word.trim(), c = w.charCodeAt(w.length - 1);
  if (c >= 0xac00 && c <= 0xd7a3) return `${word}${(c - 0xac00) % 28 ? '이' : '가'}`;
  return `${word}${/[lmnr136780]$/i.test(w) ? '이' : '가'}`; // Latin letters and digits: by how they are read aloud
};

/** Names of Korean voices known to be male, across Windows/Edge, Android and Apple devices. */
const MALE = /injoon|hyunsu|bongjin|gookmin|minho|x-ko[cd]-|\bmale\b|남성|남자/i;
const FEMALE = /sunhi|heami|jimin|seohyeon|soonbok|yujin|yuna|sora|x-kob-|x-ism-|female|여성|여자/i;

/**
 * Match commentary in Korean by two men in the booth: a fast-talking caster who calls the play
 * and an analyst who adds a remark after it. Each line is shown as a caption and, where the
 * browser has a Korean voice, spoken with the built-in speech synthesis (no audio files, so club
 * and player names — including ones the player has edited — are read out as they are written).
 * A male voice is used where the device has one; otherwise the voice it has is pitched down.
 */
export class Commentary {
  enabled = true;
  /** Voice on or off (follows the game's sound switch); captions are shown either way. */
  voiceOn = true;
  private el: HTMLElement;
  private synth: SpeechSynthesis | null = typeof speechSynthesis === 'undefined' ? null : speechSynthesis;
  private cast: Record<Who, { voice: SpeechSynthesisVoice | null; pitch: number; rate: number }> = {
    caster: { voice: null, pitch: 1, rate: 1.5 }, analyst: { voice: null, pitch: 1, rate: 1.32 },
  };
  private match: Match | null = null;
  /** Lines waiting to be said, the seconds the current one still needs, and how important this exchange is. */
  private queue: Line[] = [];
  private busy = 0;
  private busyP = 0;
  private captionTime = 0;
  private quiet = 0;
  private lastShot = -99;
  private lastKick = -1;
  private clock = 0;
  private unlocked = false;

  constructor(root: HTMLElement) {
    try { this.enabled = localStorage.getItem(STORE_KEY) !== 'off'; } catch { /* storage blocked */ }
    this.el = document.createElement('div');
    this.el.className = 'caption';
    this.el.setAttribute('aria-live', 'polite');
    root.appendChild(this.el);
    const find = () => {
      const ko = (this.synth?.getVoices() ?? []).filter((v) => v.lang.toLowerCase().startsWith('ko'));
      const men = ko.filter((v) => MALE.test(v.name) || MALE.test(v.voiceURI));
      const other = ko.filter((v) => !men.includes(v));
      // Voices not known to be female come before ones that are.
      other.sort((a, b) => Number(FEMALE.test(a.name)) - Number(FEMALE.test(b.name)));
      const first = men[0] ?? other[0] ?? null;
      const second = men[1] ?? (men[0] ? other[0] : other[1]) ?? first;
      const male = (v: SpeechSynthesisVoice | null) => !!v && men.includes(v);
      // A real male voice is used as it is; any other voice is pitched well down. The two men
      // also differ from each other, so it is clear who is talking.
      this.cast.caster = { voice: first, pitch: male(first) ? 1 : 0.55, rate: 1.5 };
      this.cast.analyst = { voice: second, pitch: male(second) ? (second === first ? 0.8 : 0.95) : second === first ? 0.8 : 0.6, rate: 1.32 };
    };
    find();
    this.synth?.addEventListener?.('voiceschanged', find);
    // Browsers only allow speech once the player has really touched the page, and phones only
    // count the end of a touch (not its start) as that. A silent line is spoken on each touch
    // until one is actually heard to start, which is what unlocks speech for the match.
    const unlock = () => {
      if (this.unlocked || !this.synth || this.unlockTries >= 8) return;
      this.unlockTries++;
      try {
        const u = new SpeechSynthesisUtterance('.');
        u.lang = 'ko-KR';
        u.volume = 0;
        u.onstart = u.onend = () => { this.unlocked = true; };
        u.onerror = (e) => { this.lastError = `unlock: ${e.error}`; };
        this.synth.resume();
        this.synth.speak(u);
      } catch (e) { this.lastError = `unlock: ${String(e)}`; }
    };
    for (const ev of ['pointerup', 'touchend', 'click', 'keydown'] as const) window.addEventListener(ev, unlock);
  }

  private unlockTries = 0;
  private started = 0;
  private lastError = '';
  /** What the speech side of this device is doing, for a tester's report. */
  get diagnostics(): string {
    if (!this.synth) return '음성 기능 없음 (이 브라우저는 자막만 나옵니다)';
    const ko = this.synth.getVoices().filter((v) => v.lang.toLowerCase().startsWith('ko')).length;
    return `한국어 음성 ${ko}개 · 잠금 ${this.unlocked ? '해제' : `안 풀림(${this.unlockTries}회 시도)`} · 말한 문장 ${this.started}개${this.lastError ? ` · 오류 ${this.lastError}` : ''}`;
  }

  /** Whether this device can speak Korean (otherwise the commentary is captions only). */
  get canSpeak(): boolean { return !!this.synth; }
  /** The voices in use, for checking a device. */
  get voices(): string { return `${this.cast.caster.voice?.name ?? '-'} (${this.cast.caster.pitch}) / ${this.cast.analyst.voice?.name ?? '-'} (${this.cast.analyst.pitch})`; }

  setEnabled(on: boolean): void {
    this.enabled = on;
    try { localStorage.setItem(STORE_KEY, on ? 'on' : 'off'); } catch { /* ignore */ }
    if (!on) this.hush();
  }

  /** Stop talking and clear the caption (pause, leaving the match, switching off). */
  hush(): void {
    // Only when the booth is actually talking: cancelling here would also cut off the silent
    // line that unlocks speech on a phone, which is spoken on the very tap that starts a match.
    if (this.busy > 0 || this.queue.length) { try { this.synth?.cancel(); } catch { /* ignore */ } }
    this.queue = [];
    this.busy = 0; this.busyP = 0; this.captionTime = 0;
    this.el.classList.remove('show');
  }

  /** Whether nothing is being said. */
  private get free(): boolean { return this.busy <= 0 && this.queue.length === 0; }

  /** Start an exchange (one line, or the caster's call and the analyst's remark). */
  private say(p: P, ...lines: Line[]): void {
    if (!this.enabled || !lines.length) return;
    // An exchange of the same or lesser weight does not cut in on one still going.
    if (!this.free && p <= this.busyP) return;
    if (!this.free) {
      try { this.synth?.cancel(); } catch { /* ignore */ }
      this.busy = 0.07; // some browsers drop a line spoken straight after a cancel
    }
    this.queue = lines;
    this.busyP = p;
    this.quiet = 0;
  }

  /** Say the next waiting line: caption now, voice if there is one. */
  private next(): void {
    const line = this.queue.shift();
    if (!line) { this.busyP = 0; return; }
    const who = this.cast[line.who];
    const mood = MOOD[line.mood];
    const rate = Math.min(2.4, who.rate * mood.rate);
    // Korean is read at about six syllables a second at normal speed.
    const syllables = line.text.replace(/[^가-힣a-zA-Z0-9]/g, '').length;
    this.busy = 0.3 + syllables / (6.2 * rate);
    this.el.innerHTML = `<b class="${line.who}">${line.who === 'caster' ? '캐스터' : '해설'}</b>`;
    this.el.appendChild(document.createTextNode(line.text));
    this.el.className = `caption show ${line.mood}`;
    this.captionTime = Math.max(1.8, this.busy + 0.9);
    if (!this.voiceOn || !this.synth) return;
    try {
      const u = new SpeechSynthesisUtterance(line.text);
      // Many phones do not list their voices but still speak when asked for Korean, so a
      // missing list is not a reason to stay silent.
      if (who.voice) { u.voice = who.voice; u.lang = who.voice.lang; } else u.lang = 'ko-KR';
      u.onstart = () => { this.started++; this.unlocked = true; };
      u.onerror = (e) => { this.lastError = e.error; };
      this.synth.resume(); // a phone that put the page in the background can leave speech paused
      u.rate = rate;
      // A voice that was pitched down to sound male must not climb back up to its own pitch when excited.
      u.pitch = Math.max(0.1, Math.min(2, who.pitch * (who.pitch < 0.9 ? mood.pitch ** 0.6 : mood.pitch)));
      u.volume = mood.vol;
      this.synth.speak(u);
    } catch { /* speech not available */ }
  }

  private scoreLine(m: Match): string {
    const { home, away } = m.score;
    if (home === away) return `${home} 대 ${away}, 동점입니다.`;
    const lead: Team = home > away ? 'home' : 'away';
    return `${Math.max(home, away)} 대 ${Math.min(home, away)}, ${iga(m.teams[lead].name)} 앞서 있습니다.`;
  }

  /** Call every frame before the HUD clears the match's events and notices. */
  update(m: Match, inMenu: boolean, dt: number): void {
    this.clock += dt;
    if (this.captionTime > 0) {
      this.captionTime -= dt;
      if (this.captionTime <= 0) this.el.classList.remove('show');
    }
    if (inMenu || !this.enabled) { if (this.match) { this.match = null; this.hush(); } return; }
    if (this.match !== m) { this.match = m; this.lastShot = -99; this.quiet = 0; this.lastKick = m.ball.kickId; this.hush(); }
    if (this.busy > 0) this.busy -= dt;
    if (this.busy <= 0 && this.queue.length) this.next();
    else if (this.busy <= 0) this.busyP = 0;

    const name = (id: number) => m.players[id]?.name ?? '';
    const kicker = () => (m.ball.kickerId >= 0 ? m.players[m.ball.kickerId] : null);
    const other = (t: Team): Team => (t === 'home' ? 'away' : 'home');
    // "옐로카드 · 9 홍길동" → "홍길동"
    const noticeName = (word: string) => m.notices.find((n) => n.text.includes(word))?.text.replace(/^.*·\s*\d+\s+/, '') ?? '';
    const late = m.time > m.matchSeconds * 0.8;
    const afterShot = this.clock - this.lastShot < 3;

    for (const ev of m.events as MatchEvent[]) {
      switch (ev) {
        case 'kickoff':
          if (m.time < 0.5) {
            this.say(P.Event, C(`안녕하십니까! ${m.teams.home.name} 대 ${m.teams.away.name}! 지금, 경기 시작합니다!`, 'joy'),
              A(pick(['네, 양 팀 모두 준비를 잘하고 나왔습니다. 기대되는 경기네요.', '초반 기 싸움이 중요합니다. 누가 먼저 주도권을 잡을지 보시죠.'])));
          } else if (m.half === 2 && Math.abs(m.time - m.matchSeconds / 2) < 0.5) {
            this.say(P.Event, C('후반전 시작됩니다!'), A(pick(['후반은 체력 싸움입니다. 교체 카드가 변수가 되겠네요.', '전반과는 다른 흐름이 나올 수 있습니다.'])));
          } else this.say(P.Play, C(pick(['다시 경기 이어갑니다.', '중앙에서 다시 시작합니다.'])));
          break;
        case 'shot': {
          this.lastShot = this.clock;
          const k = kicker();
          this.say(P.Play, C(k ? pick([`${k.name}, 슛!!`, `${k.name} 슈팅!!`, `${k.name}, 때립니다!!`, `${k.name}, 직접 노립니다!!`]) : '슛!!', 'tense'));
          break;
        }
        case 'goal_home':
        case 'goal_away': {
          const g = m.lastGoal;
          const team: Team = ev === 'goal_home' ? 'home' : 'away';
          const mine = m.score[team], theirs = m.score[other(team)];
          const tail = mine === theirs ? '동점골입니다!' : mine - theirs === 1 ? `${iga(m.teams[team].name)} 앞서 나갑니다!` : `${mine} 대 ${theirs}, 점수 차를 벌립니다!`;
          const remark = g?.own ? pick(['수비 입장에서는 정말 아쉬운 장면입니다.', '걷어내려다 그대로 들어가 버렸네요.'])
            : mine === theirs ? pick(['경기가 원점으로 돌아갔습니다. 이제부터가 진짜죠.', '포기하지 않은 결과입니다. 분위기가 완전히 넘어왔어요.'])
            : mine - theirs >= 2 ? pick(['이 골은 치명적입니다. 상대가 따라가기 쉽지 않겠어요.', '완전히 흐름을 탔습니다.'])
            : pick(['마무리가 아주 침착했습니다.', '수비가 순간적으로 공간을 내줬어요. 놓치지 않았습니다.', '보셨습니까, 완벽한 결정력입니다!']);
          const who = g ? name(g.scorerId) : '';
          if (g?.own) this.say(P.Big, C('아아아! 자책골!', 'shock'), C(`자책골입니다! 이게 무슨 일입니까! ${tail}`, 'shock'), A(remark, 'sad'));
          else {
            this.say(P.Big,
              C(pick(['고오오오오오오올!', '골! 골! 골! 골! 고오오오올!', '들어갔습니다아아! 고오오올!']), 'shout'),
              C(`${pick(['골입니다!', '터졌습니다!', '그물을 흔듭니다!'])} ${m.teams[team].name}, ${who}! ${who}! ${tail}`, 'joy'),
              A(`${pick(['와아! 정말 대단합니다!', '이야, 이걸 넣네요!', '소름이 돋습니다!'])} ${remark}`, 'joy'));
          }
          this.lastShot = -99;
          break;
        }
        case 'save': {
          // The keeper of the side that did not shoot.
          const k = kicker();
          const gk = k ? m.keepers[other(k.team)].p : null;
          this.say(P.Event, C(pick(['막았습니다아!', '선방! 슈퍼 세이브!', '아아, 막아냅니다!']), 'shout'),
            C(gk ? pick([`${gk.name} 골키퍼! 몸을 날려 걷어냅니다!`, `${gk.name} 골키퍼입니다! 엄청난 선방!`]) : '골키퍼가 걷어냅니다!', 'tense'),
            A(pick(['와, 이걸 막아내네요! 반응 속도가 정말 대단합니다!', '들어가는 줄 알았습니다! 골키퍼를 칭찬해야 해요!', '코스가 좋았는데, 골키퍼가 읽고 있었어요!']), 'joy'));
          this.lastShot = -99;
          break;
        }
        case 'post':
          this.say(P.Event, C(pick(['골대애애!', '아아아, 골대!']), 'shout'), C('골대를 맞고 나옵니다! 이럴 수가!', 'shock'),
            A(pick(['아아, 몇 센티미터 차이였는데요. 정말 너무 아깝습니다.', '하아, 골대가 살렸습니다. 운이 따르지 않네요.']), 'sad'));
          this.lastShot = -99;
          break;
        case 'goalkick':
          if (afterShot) this.say(P.Play, C(pick(['아아아, 빗나갑니다.', '아, 골문을 벗어납니다.', '아이고, 살짝 빗나갑니다.']), 'sad'),
            A(pick(['아, 이건 넣어 줬어야죠. 너무 아쉽습니다.', '하아, 힘이 너무 들어갔어요.', '아깝습니다. 그래도 이런 슈팅이 계속 나와야 해요.']), 'sad'));
          else this.say(P.Colour, C('골킥입니다.'));
          this.lastShot = -99;
          break;
        case 'corner':
          this.say(P.Play, C(afterShot ? '아, 수비 맞고 나갑니다! 코너킥!' : '코너킥입니다!', afterShot ? 'tense' : 'quick'), A(pick(['세트피스, 좋은 기회입니다!', '수비는 정신 바짝 차려야 할 순간이죠.'])));
          this.lastShot = -99;
          break;
        case 'throw': this.say(P.Colour, C(pick(['스로인입니다.', '터치라인 밖으로 나갑니다.']))); break;
        case 'tackle': {
          const o = m.owner();
          if (this.free && Math.random() < 0.6) this.say(P.Play, C(o ? pick([`${o.name}, 끊어냅니다!`, `${o.name}, 공을 빼앗습니다!`, `좋은 수비! ${o.name}!`]) : pick(['태클! 공을 빼앗습니다!', '끊어냅니다!']), 'tense'));
          break;
        }
        case 'block': if (this.free && Math.random() < 0.4) this.say(P.Colour, C(pick(['수비 맞고 굴절됩니다.', '몸으로 막아냅니다!']))); break;
        case 'foul': this.say(P.Play, C(pick(['아, 파울입니다!', '반칙! 휘슬이 울립니다!']), 'tense'), A(pick(['아이고, 조금 늦게 들어갔어요.', '무리한 시도였습니다.', '심판이 정확하게 봤네요.']))); break;
        case 'penalty': this.say(P.Big, C('페널티킥! 페널티킥!', 'shout'), C('심판이 페널티 지점을 가리킵니다! 엄청난 변수가 생겼습니다!', 'shock'), A('아아, 박스 안에서 저렇게 들어가면 안 되죠! 정말 치명적인 반칙입니다!', 'shock')); break;
        case 'offside': this.say(P.Play, C('아, 오프사이드! 깃발이 올라갑니다.', 'sad'), A(pick(['아쉽네요. 타이밍이 반 박자 빨랐어요.', '수비 라인이 정말 잘 올라왔습니다.']))); break;
        case 'yellow': this.say(P.Event, C(`옐로카드! ${noticeName('옐로카드')}, 경고를 받습니다!`, 'tense'), A('이제 정말 조심해야 합니다. 한 장 더 받으면 퇴장이에요.')); break;
        case 'red': this.say(P.Big, C('레드카드! 퇴장! 퇴장입니다!', 'shout'), C(`${noticeName('퇴장') || noticeName('레드카드')}, 그라운드를 떠납니다! 이게 웬일입니까!`, 'shock'), A('아아, 한 명이 부족해졌습니다! 경기 흐름이 완전히 바뀔 수 있어요!', 'shock')); break;
        case 'sub': this.say(P.Colour, C('선수 교체가 있습니다.'), A(pick(['체력 안배를 위한 교체로 보입니다.', '분위기를 바꿔 보겠다는 의도죠.']))); break;
        case 'halftime': {
          // (said evenly: a breather)
          const sh = m.shots, more: Team | null = sh.home === sh.away ? null : sh.home > sh.away ? 'home' : 'away';
          this.say(P.Event, C(`전반전 종료! ${this.scoreLine(m)}`),
            A(more ? `슈팅 수 ${sh.home} 대 ${sh.away}, ${m.teams[more].name} 쪽이 더 적극적이었습니다.` : '팽팽한 전반이었습니다. 후반에 승부가 갈리겠네요.'));
          break;
        }
        case 'extratime': this.say(P.Big, C('90분으로는 승부를 가리지 못했습니다! 연장전! 먼저 넣는 팀이 이깁니다!', 'tense'), A('이제 한 골이면 끝입니다! 실수 하나가 그대로 탈락이에요!', 'tense')); break;
        case 'shootout': this.say(P.Big, C('연장전에도 골이 없습니다! 승부차기! 운명의 승부차기로 갑니다!', 'tense'), A('아, 손에 땀이 납니다. 여기서부터는 심리전이에요.', 'tense')); break;
        case 'pen_goal': this.say(P.Event, C(pick(['성공! 넣었습니다아!', '골! 구석에 꽂힙니다!', '침착하게! 성공입니다!']), 'joy'), A(pick(['완벽한 킥이었어요! 골키퍼가 손도 못 썼습니다!', '강심장입니다, 정말!']), 'joy')); break;
        case 'pen_saved': this.say(P.Event, C(pick(['막았습니다아아!', '선방! 골키퍼가 막아냅니다!']), 'shout'), A(pick(['와, 방향을 완전히 읽었네요!', '골키퍼가 영웅이 되는 순간입니다!']), 'joy')); break;
        case 'pen_missed': this.say(P.Event, C(pick(['아아아, 실축! 실축입니다!', '아, 벗어납니다! 이럴 수가!']), 'shock'), A('하아, 부담감이 너무 컸던 것 같습니다. 고개를 들지 못하네요.', 'sad')); break;
        case 'fulltime': {
          const w = m.winner;
          const { home, away } = m.score;
          const how = m.shootout && home === away ? `승부차기 ${m.shootout.home} 대 ${m.shootout.away}, ` : `${Math.max(home, away)} 대 ${Math.min(home, away)}, `;
          this.say(P.Big, C('경기 종료! 휘슬이 울립니다!', 'shout'),
            C(w ? `${how}${m.teams[w].name}의 승리입니다! ${m.teams[w].name}!` : `${home} 대 ${away}, 무승부로 끝납니다.`, w ? 'joy' : 'quick'),
            A(w ? pick(['정말 대단한 경기였습니다! 이길 자격이 충분했어요!', '끝까지 집중력을 잃지 않은 쪽이 가져갔네요. 박수를 보냅니다!']) : '아, 양 팀 모두 아쉬움이 남는 결과입니다.', w ? 'joy' : 'sad'),
            C('지금까지 함께해 주셔서 감사합니다!'));
          break;
        }
      }
    }

    // ---- between the big moments: who has it, where it is going, and a word from the analyst ----
    if (m.phase !== 'play' || m.pens) return;
    const b = m.ball;
    if (b.kickId !== this.lastKick) {
      this.lastKick = b.kickId;
      const k = kicker(), to = b.intendedId >= 0 ? m.players[b.intendedId] : null;
      // A pass on its way to a teammate: call some of them, short enough to keep up.
      if (this.free && k && to && to.team === k.team && Math.random() < 0.45) {
        const long = Math.hypot(to.pos.x - k.pos.x, to.pos.z - k.pos.z) > 22;
        this.say(P.Colour, C(long ? pick([`${k.name}, 길게! ${to.name}!`, `${to.name} 쪽으로 길게 넘깁니다!`]) : pick([`${k.name}, ${to.name}!`, `${to.name}에게 연결.`, `${k.name}에서 ${to.name}.`])));
      }
    }
    this.quiet += dt;
    if (this.quiet > 4.5 && this.free && Math.random() < dt / 2.2) {
      const o = m.owner();
      if (!o || o.role !== 'field') { this.quiet = 2; return; }
      const depth = o.pos.x * m.dir(o.team); // metres toward the opponent's goal
      const t = m.teams[o.team].name, opp = m.teams[other(o.team)].name;
      const gap = m.score[o.team] - m.score[other(o.team)];
      const danger = depth > 30;
      const call = danger ? pick([`${o.name}! 박스 근처까지 왔습니다!`, `위험합니다! ${t}, 위험한 지역!`, `${o.name}, 안으로 파고듭니다! 기회예요!`])
        : depth > 0 ? pick([`${o.name}, 공 몰고 올라갑니다.`, `${t}의 공격.`, `${o.name}, 전방을 살핍니다.`, `${t}, 상대 진영에서 공을 돌립니다.`])
        : pick([`${t}, 뒤에서부터 풀어갑니다.`, `${o.name}, 공 잡았습니다.`, `${t}, 천천히 빌드업.`]);
      const remark = late && gap < 0 ? pick([`${t}, 시간이 없습니다. 과감해져야 해요.`, '이제는 위험을 감수해야 할 시간입니다.'])
        : late && gap > 0 ? pick([`${t}, 서두를 이유가 없죠. 시간을 써야 합니다.`, `${opp} 입장에서는 속이 타는 시간입니다.`])
        : late ? '후반 막판입니다. 체력이 떨어질 시간이라 집중력이 중요해요.'
        : danger ? pick(['여기서 마무리가 중요합니다!', '수비 숫자가 많아요, 침착해야 합니다!', '슈팅 각이 나옵니다! 때려야죠!'])
        : depth > 0 ? pick([`${opp} 수비가 간격을 잘 유지하고 있습니다.`, '측면을 활용하면 좋을 것 같은데요.', '패스 템포를 조금 더 올려야 합니다.', '침투하는 선수의 움직임이 좋습니다.'])
        : pick([`${opp}의 전방 압박이 강합니다.`, '무리하지 않는 선택이 좋아요.', '공간을 만드는 움직임이 필요합니다.']);
      // The analyst joins in about half the time.
      const cm: Mood = danger ? 'tense' : 'quick', am: Mood = danger ? 'tense' : late && gap < 0 ? 'tense' : 'calm';
      if (Math.random() < 0.55) this.say(P.Colour, C(call, cm), A(remark, am)); else this.say(P.Colour, C(call, cm));
    }
  }
}
