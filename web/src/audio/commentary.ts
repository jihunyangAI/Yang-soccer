import type { Team } from '../sim/ball';
import type { Match, MatchEvent } from '../sim/match';
import { CAT, GOAL_CRY, iga, KEY, SCORE_MAX, SIDE, surnameOf, type Frag, type Mood, type Who } from './lines';
import { VoiceBank } from './voicebank';

const STORE_KEY = 'pitchline.commentary.v1';
/** Importance of a line: a more important one interrupts, a less important one is dropped while another is being said. */
const enum P { Colour = 1, Play = 2, Event = 3, Big = 4 }

/** One piece of a line: a recorded fragment, or a club or player name slotted between fragments. */
interface Part { key: string; text: string; kind: 'frag' | 'player' | 'team' | 'score'; /** Recordings to use instead, in order, when `key` has none. */ alts?: string[] }
interface Line { who: Who; mood: Mood; parts: Part[] }
/**
 * What a line is built from: a group to pick a fragment from, a player (`n` = his shirt number),
 * a club (`side` = which one it is in this match), a club as the subject of a sentence, or the score.
 */
type Item = Frag[] | { p: string; n?: number } | { t: string; side?: Team } | { g: string; side?: Team } | { s: [number, number] };

/** How the browser's own voice delivers each mood, when a line has no recording. */
const MOOD: Record<Mood, { rate: number; pitch: number; vol: number }> = {
  calm: { rate: 1, pitch: 1, vol: 0.8 },
  quick: { rate: 1.05, pitch: 1.04, vol: 0.85 },
  tense: { rate: 1.22, pitch: 1.22, vol: 1 },
  shout: { rate: 0.92, pitch: 1.75, vol: 1 },
  joy: { rate: 1.16, pitch: 1.45, vol: 1 },
  sad: { rate: 0.8, pitch: 0.74, vol: 0.85 },
  shock: { rate: 1.12, pitch: 1.5, vol: 1 },
};
/** How loud a recorded line is played: shouts carry over the crowd, the analyst sits under the caster. */
const GAIN: Record<Mood, number> = { calm: 1.25, quick: 1.4, tense: 1.6, shout: 1.9, joy: 1.7, sad: 1.3, shock: 1.7 };

/** Choose one fragment, avoiding the ones said most recently so the booth does not repeat itself. */
const recent: string[] = [];
const pick = (xs: readonly Frag[]): Frag => {
  const fresh = xs.filter((x) => !recent.includes(x.text));
  const from = fresh.length ? fresh : xs;
  const x = from[(Math.random() * from.length) | 0];
  recent.push(x.text);
  if (recent.length > 16) recent.shift();
  return x;
};

/** Names of Korean voices known to be male, across Windows/Edge, Android and Apple devices. */
const MALE = /injoon|hyunsu|bongjin|gookmin|minho|x-ko[cd]-|\bmale\b|남성|남자/i;
const FEMALE = /sunhi|heami|jimin|seohyeon|soonbok|yujin|yuna|sora|x-kob-|x-ism-|female|여성|여자/i;

/** Where recorded lines are played: the game's own audio output, once the player has unlocked it. */
export interface VoiceOut { ctx: AudioContext; node: AudioNode }

/**
 * Match commentary in Korean by two men in the booth: a fast-talking caster who calls the play
 * and an analyst who adds a remark after it. Each line is shown as a caption and spoken.
 *
 * The voice is a set of recordings (an acted AI voice, see scripts/voice): fixed fragments
 * with club and player names slotted in, stitched together as they are needed and played
 * through the same output as the sound effects, so they work wherever the effects do.
 * A line that has no recording — an edited name, or a build shipped without the recordings —
 * is spoken by the browser's built-in voice instead, where it has one.
 */
export class Commentary {
  enabled = true;
  /** Voice on or off (follows the game's sound switch); captions are shown either way. */
  voiceOn = true;
  private el: HTMLElement;
  private bank = new VoiceBank();
  private playing: AudioBufferSourceNode[] = [];
  private synth: SpeechSynthesis | null = typeof speechSynthesis === 'undefined' ? null : speechSynthesis;
  private cast: Record<Who, { voice: SpeechSynthesisVoice | null; pitch: number; rate: number }> = {
    caster: { voice: null, pitch: 1, rate: 1.5 }, analyst: { voice: null, pitch: 1, rate: 1.32 },
  };
  private match: Match | null = null;
  /** Lines waiting to be said, the seconds the current one still needs, and how important this exchange is. */
  private queue: Line[] = [];
  private busy = 0;
  private busyP = 0;
  /** Seconds the next line has been waiting for its recording to load. */
  private waiting = 0;
  private captionTime = 0;
  private quiet = 0;
  private lastShot = -99;
  private lastKick = -1;
  private clock = 0;
  private unlocked = false;
  private unlockTries = 0;
  private started = 0;
  private recorded = 0;
  private lastError = '';

  constructor(root: HTMLElement, private out: () => VoiceOut | null = () => null) {
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
      // A real male voice is used as it is; any other voice is pitched well down.
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

  /** Whether this device can give the commentary a voice at all (recordings or the browser's own). */
  get canSpeak(): boolean { return this.bank.size > 0 || !!this.synth; }
  /** True once it is certain this device has no way to voice the commentary (no recordings, no browser speech). */
  get silent(): boolean { return this.bank.settled && this.bank.size === 0 && !this.synth; }
  /** What the voice side of this device is doing, for a tester's report. */
  get diagnostics(): string {
    const rec = `녹음 음성 ${this.bank.size}개 · 재생한 녹음 ${this.recorded}줄`;
    if (!this.synth) return `${rec} · 브라우저 음성 없음`;
    const ko = this.synth.getVoices().filter((v) => v.lang.toLowerCase().startsWith('ko')).length;
    return `${rec} · 브라우저 한국어 음성 ${ko}개 (잠금 ${this.unlocked ? '해제' : '안 풀림'}, ${this.started}줄 말함)${this.lastError ? ` · 오류 ${this.lastError}` : ''}`;
  }

  /**
   * Play one line out loud, straight from a button press, and report in words what happened.
   * A recorded line is used if this build has them; otherwise the browser's own voice.
   */
  test(): Promise<string> {
    return new Promise((resolve) => {
      const out = this.out();
      const line = this.build([CAT.start]);
      if (out && this.bank.size > 0) {
        const keys = line.parts.map((p) => p.key);
        let tries = 0;
        const attempt = () => {
          const st = this.bank.want(out.ctx, keys);
          if (st === 'ready') { this.playRecorded(out, line); resolve('녹음된 해설 음성이 재생되고 있습니다. 들리지 않으면 휴대폰의 미디어 음량과 무음 모드를 확인해 주세요.'); }
          else if (st === 'missing' || ++tries > 40) resolve('녹음된 해설 음성을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.');
          else setTimeout(attempt, 100);
        };
        attempt();
        return;
      }
      const synth = this.synth;
      if (!synth) { resolve('이 브라우저에는 음성 기능이 없고, 녹음된 해설도 아직 불러오지 못했습니다. 잠시 뒤 다시 눌러 주세요.'); return; }
      let done = false;
      const finish = (msg: string) => { if (!done) { done = true; resolve(msg); } };
      try {
        synth.cancel();
        const u = new SpeechSynthesisUtterance('안녕하십니까! 해설 음성 테스트입니다.');
        const v = this.cast.caster.voice;
        if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'ko-KR';
        u.volume = 1; u.rate = 1.2;
        u.onstart = () => { this.unlocked = true; this.started++; finish('브라우저 음성이 재생되고 있습니다. 들리지 않으면 휴대폰의 미디어 음량과 무음 모드를 확인해 주세요.'); };
        u.onerror = (e) => { this.lastError = `test: ${e.error}`; finish(`음성을 재생하지 못했습니다 (${e.error}).`); };
        synth.resume();
        synth.speak(u);
        setTimeout(() => finish('브라우저가 음성 요청에 응답하지 않습니다.'), 3500);
      } catch (e) { finish(`음성 기능 오류: ${String(e)}`); }
    });
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    try { localStorage.setItem(STORE_KEY, on ? 'on' : 'off'); } catch { /* ignore */ }
    if (!on) this.hush();
  }

  /** Stop talking and clear the caption (pause, leaving the match, switching off). */
  hush(): void {
    for (const s of this.playing) { try { s.stop(); } catch { /* already ended */ } }
    this.playing = [];
    // Only when the browser voice is actually talking: cancelling here would also cut off the
    // silent line that unlocks speech on a phone, which is spoken on the very tap that starts a match.
    if (this.busy > 0 || this.queue.length) { try { this.synth?.cancel(); } catch { /* ignore */ } }
    this.queue = [];
    this.busy = 0; this.busyP = 0; this.captionTime = 0; this.waiting = 0;
    this.el.classList.remove('show');
  }

  /** Whether nothing is being said. */
  private get free(): boolean { return this.busy <= 0 && this.queue.length === 0; }

  /** Put a line together: a fragment is picked from each group, names go in between. */
  private build(items: Item[]): Line {
    const first = items.find((i): i is Frag[] => Array.isArray(i));
    const lead = first ? first[0] : GOAL_CRY;
    const parts = items.map((i): Part => {
      if (Array.isArray(i)) { const f = pick(i); return { key: KEY.frag(f), text: f.text, kind: 'frag' }; }
      if ('p' in i) {
        // No recording of the full name: his family name alone, or failing that his shirt number.
        const last = surnameOf(i.p);
        return { key: KEY.player(i.p), text: i.p, kind: 'player', alts: [...(last ? [KEY.surname(last)] : []), ...(i.n ? [KEY.number(i.n)] : [])] };
      }
      if ('s' in i) return { key: KEY.score(i.s[0], i.s[1]), text: `${i.s[0]} 대 ${i.s[1]}`, kind: 'score' };
      // A renamed club is "the home side" or "the away side".
      if ('g' in i) return { key: KEY.teamGa(i.g), text: iga(i.g), kind: 'team', alts: i.side ? [KEY.teamGa(SIDE[i.side])] : [] };
      return { key: KEY.team(lead.who, i.t), text: i.t, kind: 'team', alts: i.side ? [KEY.team(lead.who, SIDE[i.side])] : [] };
    });
    return { who: lead.who, mood: lead.mood, parts };
  }

  /** Start an exchange (one line, or the caster's call and the analyst's remark). */
  private say(p: P, ...lines: Item[][]): void {
    if (!this.enabled || !lines.length) return;
    // An exchange of the same or lesser weight does not cut in on one still going.
    if (!this.free && p <= this.busyP) return;
    if (!this.free) {
      for (const s of this.playing) { try { s.stop(); } catch { /* already ended */ } }
      this.playing = [];
      try { this.synth?.cancel(); } catch { /* ignore */ }
      this.busy = 0.07; // some browsers drop a line spoken straight after a cancel
    }
    this.queue = lines.filter((l) => l.length).map((l) => this.build(l));
    this.busyP = p;
    this.quiet = 0;
    this.waiting = 0;
  }

  /** The words of a line as they read on screen. */
  private caption(line: Line): string {
    return line.parts.map((p, i) => {
      const next = line.parts[i + 1];
      // A name called before the rest of the line gets a comma; a club name leading into its sentence does not.
      return p.kind === 'player' && next ? `${p.text},` : p.kind === 'player' ? `${p.text}!` : p.kind === 'score' ? `${p.text}!` : p.text;
    }).join(' ');
  }

  private show(line: Line): void {
    this.el.innerHTML = `<b class="${line.who}">${line.who === 'caster' ? '캐스터' : '해설'}</b>`;
    this.el.appendChild(document.createTextNode(this.caption(line)));
    this.el.className = `caption show ${line.mood}`;
    this.captionTime = Math.max(1.8, this.busy + 0.9);
  }

  /** Play a line from its recordings, back to back. Returns how long it runs. */
  private playRecorded(out: VoiceOut, line: Line, keys = line.parts.map((p) => p.key)): number {
    const gain = out.ctx.createGain();
    gain.gain.value = GAIN[line.mood] * (line.who === 'analyst' ? 0.92 : 1);
    gain.connect(out.node);
    let t = out.ctx.currentTime + 0.03;
    const start = t;
    for (const key of keys) {
      const buf = this.bank.get(key);
      if (!buf) continue;
      const src = out.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(gain);
      src.start(t);
      this.playing.push(src);
      src.onended = () => { this.playing = this.playing.filter((s) => s !== src); };
      t += buf.duration + 0.04;
    }
    this.recorded++;
    return t - start;
  }

  /** Say the next waiting line: caption now, voice from the recordings or, failing that, the browser. */
  private next(dt: number): void {
    const line = this.queue[0];
    if (!line) { this.busyP = 0; return; }
    const out = this.voiceOn ? this.out() : null;
    if (out && this.bank.size > 0) {
      // Each part is said from its own recording or the first stand-in there is: a player with
      // no recording of his name (edited, or new in club development mode) is called by his
      // family name or his number, a renamed club is "the home side". A name or score with
      // nothing at all is left out rather than switching voices in the middle of a match.
      const keys = line.parts.map((p) => [p.key, ...(p.alts ?? [])].find((k) => this.bank.has(k)) ?? null);
      const fragsOk = line.parts.every((p, i) => p.kind !== 'frag' || keys[i]);
      const play = keys.filter((k): k is string => !!k);
      const st = fragsOk && play.length ? this.bank.want(out.ctx, play) : 'missing';
      // Give a recording that is still loading a moment before giving up on it for this line.
      if (st === 'pending' && (this.waiting += dt) < 0.8) return;
      if (st === 'ready') {
        this.queue.shift();
        this.waiting = 0;
        this.busy = this.playRecorded(out, line, play) + 0.1;
        this.show(line);
        return;
      }
    }
    this.queue.shift();
    this.waiting = 0;
    const who = this.cast[line.who];
    const mood = MOOD[line.mood];
    const text = this.caption(line);
    const rate = Math.min(2.4, who.rate * mood.rate);
    // Korean is read at about six syllables a second at normal speed.
    this.busy = 0.3 + text.replace(/[^가-힣a-zA-Z0-9]/g, '').length / (6.2 * rate);
    this.show(line);
    if (!this.voiceOn || !this.synth) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      // Many phones do not list their voices but still speak when asked for Korean.
      if (who.voice) { u.voice = who.voice; u.lang = who.voice.lang; } else u.lang = 'ko-KR';
      u.onstart = () => { this.started++; this.unlocked = true; };
      u.onerror = (e) => { this.lastError = e.error; };
      this.synth.resume();
      u.rate = rate;
      // A voice that was pitched down to sound male must not climb back up to its own pitch when excited.
      u.pitch = Math.max(0.1, Math.min(2, who.pitch * (who.pitch < 0.9 ? mood.pitch ** 0.6 : mood.pitch)));
      u.volume = mood.vol;
      this.synth.speak(u);
    } catch { /* speech not available */ }
  }

  /** Call every frame before the HUD clears the match's events and notices. */
  update(m: Match, inMenu: boolean, dt: number): void {
    this.clock += dt;
    if (this.captionTime > 0) {
      this.captionTime -= dt;
      if (this.captionTime <= 0) this.el.classList.remove('show');
    }
    if (inMenu || !this.enabled) { if (this.match) { this.match = null; this.hush(); } return; }
    if (this.match !== m) {
      this.match = m; this.lastShot = -99; this.quiet = 0; this.lastKick = m.ball.kickId;
      this.hush();
      this.bank.prefetch([m.teams.home.id, m.teams.away.id]);
      // Players who are not in their club's built-in squad (signed or come through in club development mode).
      this.bank.prefetchKeys(m.players.map((p) => KEY.player(p.name)));
      // The stand-in names are only fetched for a match that has someone to use them on.
      if (m.players.some((p) => !this.bank.has(KEY.player(p.name))) || !this.bank.has(KEY.teamGa(m.teams.home.name)) || !this.bank.has(KEY.teamGa(m.teams.away.name))) {
        this.bank.prefetchPack('extra');
      }
    }
    if (this.busy > 0) this.busy -= dt;
    if (this.busy <= 0 && this.queue.length) this.next(dt);
    else if (this.busy <= 0) this.busyP = 0;

    const kicker = () => (m.ball.kickerId >= 0 ? m.players[m.ball.kickerId] : null);
    const other = (t: Team): Team => (t === 'home' ? 'away' : 'home');
    /** A player, a club, a club as the subject, and the score, as pieces of a line. */
    const P_ = (p: { name: string; number: number }): Item => ({ p: p.name, n: p.number });
    const T = (side: Team): Item => ({ t: m.teams[side].name, side });
    const G = (side: Team): Item => ({ g: m.teams[side].name, side });
    const score = (): Item[] => (m.score.home <= SCORE_MAX && m.score.away <= SCORE_MAX ? [{ s: [m.score.home, m.score.away] }] : []);
    // "옐로카드 · 9 홍길동" → the player it names
    const noticed = (word: string): Item | null => {
      const x = m.notices.find((n) => n.text.includes(word))?.text.match(/·\s*(\d+)\s+(.+)$/);
      return x ? { p: x[2], n: Number(x[1]) } : null;
    };
    const late = m.time > m.matchSeconds * 0.8;
    const afterShot = this.clock - this.lastShot < 3;

    for (const ev of m.events as MatchEvent[]) {
      switch (ev) {
        case 'kickoff':
          if (m.time < 0.5) this.say(P.Event, [CAT.start], [CAT.startA]);
          else if (m.half === 2 && Math.abs(m.time - m.matchSeconds / 2) < 0.5) this.say(P.Event, [CAT.second], [CAT.secondA]);
          else this.say(P.Play, [CAT.restart]);
          break;
        case 'shot': {
          this.lastShot = this.clock;
          const k = kicker();
          this.say(P.Play, k ? [P_(k), CAT.shot] : [CAT.shot]);
          break;
        }
        case 'goal_home':
        case 'goal_away': {
          const g = m.lastGoal;
          const team: Team = ev === 'goal_home' ? 'home' : 'away';
          const mine = m.score[team], theirs = m.score[other(team)];
          // The score, then what it means: "2 대 1! 블루 레인저스가 앞서 나갑니다!"
          const tail: Item[] = [...score(), ...(mine === theirs ? [CAT.goalEqual] : mine - theirs === 1 ? [G(team), CAT.goalLead] : [CAT.goalMore])];
          if (g?.own) this.say(P.Big, [CAT.own], [CAT.own2], tail, [CAT.ownA]);
          else {
            const who = g ? m.players[g.scorerId] : null;
            const remark = mine === theirs ? CAT.goalEqualA : mine - theirs >= 2 ? CAT.goalMoreA : CAT.goalA;
            this.say(P.Big, [[GOAL_CRY]], who ? [CAT.goalCall, T(team), P_(who), P_(who)] : [CAT.goalCall, T(team)], tail, [CAT.goalWow, remark]);
          }
          this.lastShot = -99;
          break;
        }
        case 'save': {
          // The keeper of the side that did not shoot.
          const k = kicker();
          const gk = k ? m.keepers[other(k.team)].p : null;
          this.say(P.Event, [CAT.save], gk ? [P_(gk), CAT.saveKeeper] : [CAT.saveNoName], [CAT.saveA]);
          this.lastShot = -99;
          break;
        }
        case 'post': this.say(P.Event, [CAT.post], [CAT.post2], [CAT.postA]); this.lastShot = -99; break;
        case 'goalkick':
          if (afterShot) this.say(P.Play, [CAT.miss], [CAT.missA]);
          else this.say(P.Colour, [CAT.goalkick]);
          this.lastShot = -99;
          break;
        case 'corner':
          this.say(P.Play, [afterShot ? CAT.cornerShot : CAT.corner], [CAT.cornerA]);
          this.lastShot = -99;
          break;
        case 'throw': this.say(P.Colour, [CAT.throwIn]); break;
        case 'tackle': {
          const o = m.owner();
          if (this.free && Math.random() < 0.6) this.say(P.Play, o ? [P_(o), CAT.tackle] : [CAT.tackleNoName]);
          break;
        }
        case 'block': if (this.free && Math.random() < 0.4) this.say(P.Colour, [CAT.block]); break;
        case 'foul': this.say(P.Play, [CAT.foul], [CAT.foulA]); break;
        case 'penalty': this.say(P.Big, [CAT.penalty], [CAT.penalty2], [CAT.penaltyA]); break;
        case 'offside': this.say(P.Play, [CAT.offside], [CAT.offsideA]); break;
        case 'yellow': {
          const who = noticed('옐로카드');
          this.say(P.Event, who ? [CAT.yellow, who, CAT.yellow2] : [CAT.yellow, CAT.yellow2], [CAT.yellowA]);
          break;
        }
        case 'red': {
          const who = noticed('퇴장') ?? noticed('레드카드');
          this.say(P.Big, [CAT.red], who ? [who, CAT.red2] : [CAT.red2], [CAT.redA]);
          break;
        }
        case 'sub': this.say(P.Colour, [CAT.sub], [CAT.subA]); break;
        case 'halftime': {
          const { home, away } = m.score;
          const sh = m.shots, more: Team | null = sh.home === sh.away ? null : sh.home > sh.away ? 'home' : 'away';
          const lead: Team = home > away ? 'home' : 'away';
          this.say(P.Event, [CAT.half], [...score(), ...(home === away ? [CAT.level] : [G(lead), CAT.ahead])],
            more ? [T(more), CAT.halfShotsA] : [CAT.halfEvenA]);
          break;
        }
        case 'extratime': this.say(P.Big, [CAT.extra], [CAT.extraA]); break;
        case 'shootout': this.say(P.Big, [CAT.shootout], [CAT.shootoutA]); break;
        case 'pen_goal': this.say(P.Event, [CAT.penGoal], [CAT.penGoalA]); break;
        case 'pen_saved': this.say(P.Event, [CAT.penSaved], [CAT.penSavedA]); break;
        case 'pen_missed': this.say(P.Event, [CAT.penMissed], [CAT.penMissedA]); break;
        case 'fulltime': {
          const w = m.winner;
          const pens = !!m.shootout && m.score.home === m.score.away;
          this.say(P.Big, [CAT.full], [...(pens ? [] : score()), ...(w ? [T(w), pens ? CAT.winPens : CAT.win] : [CAT.draw])], [w ? CAT.winA : CAT.drawA], [CAT.bye]);
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
        this.say(P.Colour, long ? [P_(k), CAT.longPass, P_(to)] : [P_(k), P_(to)]);
      }
    }
    this.quiet += dt;
    if (this.quiet > 4.5 && this.free && Math.random() < dt / 2.2) {
      const o = m.owner();
      if (!o || o.role !== 'field') { this.quiet = 2; return; }
      const depth = o.pos.x * m.dir(o.team); // metres toward the opponent's goal
      const t = T(o.team), opp = T(other(o.team)), me = P_(o);
      const gap = m.score[o.team] - m.score[other(o.team)];
      const coin = Math.random() < 0.5;
      const danger = depth > 30;
      const call: Item[] = danger ? (coin ? [me, CAT.danger] : [t, CAT.dangerTeam])
        : depth > 0 ? (coin ? [me, CAT.mid] : [t, CAT.midTeam])
        : coin ? [me, CAT.back] : [t, CAT.backTeam];
      const remark: Item[] = late && gap < 0 ? (coin ? [t, CAT.lateLosingTeamA] : [CAT.lateLosingA])
        : late && gap > 0 ? (coin ? [t, CAT.lateWinningTeamA] : [opp, CAT.lateWinningOppA])
        : late ? [CAT.lateA]
        : danger ? [CAT.dangerA]
        : depth > 0 ? (Math.random() < 0.3 ? [opp, CAT.midOppA] : [CAT.midA])
        : Math.random() < 0.35 ? [opp, CAT.backOppA] : [CAT.backA];
      // The analyst joins in about half the time.
      if (Math.random() < 0.55) this.say(P.Colour, call, remark); else this.say(P.Colour, call);
    }
  }
}
