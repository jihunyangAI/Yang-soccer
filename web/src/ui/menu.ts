import type { Difficulty, MatchConfig } from '../sim/match';
import { DIVISION_NAME, FORMATION_NAMES, overall, TEAMS } from '../sim/team';
import { copyText, deviceReport, helpHtml, testVoice } from './about';
import { CareerScreen } from './career';
import { crestSvg } from './crest';
import { CupScreen } from './cup';
import { EditorScreen } from './editor';
import { LeagueScreen } from './league';
import { teamGrid } from './picker';

export type Competition = 'league' | 'cup' | 'career';

interface MenuState {
  mode: 1 | 2;
  home: number;
  away: number;
  homeFormation: string;
  awayFormation: string;
  minutes: number;
  offside: boolean;
  assist: boolean;
  difficulty: Difficulty;
}

const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: '쉬움', normal: '보통', hard: '어려움' };

const STORE_KEY = 'pitchline.menu.v1';
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

function load(): MenuState {
  const base: MenuState = {
    mode: 1, home: 0, away: 3,
    homeFormation: TEAMS[0].formation, awayFormation: TEAMS[3].formation,
    minutes: 5, offside: true,
    // Assist on by default for touch screens, off for keyboard/gamepad.
    assist: window.matchMedia('(pointer: coarse)').matches,
    difficulty: 'normal',
  };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...base, ...JSON.parse(raw) };
  } catch { /* storage unavailable */ }
  return base;
}

function save(s: MenuState): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

/** Pre-match screen: teams, formations, match length, offside, 1P/2P. */
export class Menu {
  private el: HTMLElement;
  private s: MenuState = load();
  /** Which side's team grid is open, if any. */
  private picking: 'home' | 'away' | null = null;
  /** League mode lives inside the menu card. */
  readonly league = new LeagueScreen();
  /** Cup mode, drawn the same way. */
  readonly cup = new CupScreen();
  /** Club development mode: the league over many seasons with a squad that grows. */
  readonly career = new CareerScreen();
  readonly editor = new EditorScreen();
  private screen: 'quick' | 'league' | 'cup' | 'career' | 'editor' | 'help' = 'quick';
  /** `comp` names the competition the match counts toward, if any. */
  onStart: ((c: Omit<MatchConfig, 'seed'>, comp: Competition | null) => void) | null = null;

  constructor(root: HTMLElement, private allowTwoPlayer: () => boolean) {
    this.el = document.createElement('div');
    this.el.className = 'menu';
    root.appendChild(this.el);
    this.render();
  }

  show(): void { this.el.hidden = false; this.render(); }
  hide(): void { this.el.hidden = true; }
  get visible(): boolean { return !this.el.hidden; }

  private teamCard(side: 'home' | 'away'): string {
    const t = TEAMS[this.s[side]];
    const label = side === 'home' ? (this.s.mode === 2 ? 'P1 팀' : '내 팀') : (this.s.mode === 2 ? 'P2 팀' : '상대 팀');
    const fKey = side === 'home' ? 'homeFormation' : 'awayFormation';
    return `
      <div class="team-card">
        <div class="card-label">${label}</div>
        <div class="team-pick">
          <button type="button" class="arrow" data-act="prev-${side}" aria-label="이전 팀">‹</button>
          <button type="button" class="team-name" data-act="pick-${side}" aria-label="팀 목록에서 고르기">
            ${crestSvg(t.crest, 46)}
            <span class="tn">
              <b>${t.name}</b>
              <small><span class="kit" style="background:${hex(t.kit.shirt)}"></span>${DIVISION_NAME[t.division]} · EST. ${t.crest.founded} · 팀 목록 ▾</small>
            </span>
          </button>
          <button type="button" class="arrow" data-act="next-${side}" aria-label="다음 팀">›</button>
        </div>
        <div class="team-meta"><span>${t.style}</span><span class="ovr">전력 ${overall(t)}</span></div>
        <div class="seg" role="group" aria-label="포메이션">
          ${FORMATION_NAMES.map((f) => `<button type="button" data-act="form-${side}" data-v="${f}" class="${this.s[fKey] === f ? 'on' : ''}">${f}</button>`).join('')}
        </div>
      </div>`;
  }

  /** Grid of every club's badge for quick picking. */
  private pickerHtml(side: 'home' | 'away'): string {
    const other = this.s[side === 'home' ? 'away' : 'home'];
    return `
      <div class="picker">
        <div class="picker-head">
          <b>${side === 'home' ? (this.s.mode === 2 ? 'P1 팀' : '내 팀') : (this.s.mode === 2 ? 'P2 팀' : '상대 팀')} 고르기</b>
          <button type="button" class="picker-close" data-act="pick-close">닫기</button>
        </div>
        ${teamGrid(`choose-${side}`, { selected: this.s[side], disabled: other })}
      </div>`;
  }

  /** `keepScroll`: the same screen is being redrawn, so stay where the player has scrolled to. */
  private render(keepScroll = false): void {
    const s = this.s;
    const two = this.allowTwoPlayer();
    if (!two && s.mode === 2) s.mode = 1;
    if (this.screen === 'league') {
      this.el.innerHTML = `<div class="menu-card lg">${this.league.html()}</div>`;
      this.bind();
      this.el.scrollTop = 0;
      return;
    }
    if (this.screen === 'help') {
      this.el.innerHTML = `<div class="menu-card lg">${helpHtml(!two)}</div>`;
      this.bind();
      this.el.scrollTop = 0;
      return;
    }
    if (this.screen === 'career') {
      const top = keepScroll ? this.el.scrollTop : 0;
      this.el.innerHTML = `<div class="menu-card lg">${this.career.html()}</div>`;
      this.bind();
      this.el.scrollTop = top;
      return;
    }
    if (this.screen === 'cup') {
      this.el.innerHTML = `<div class="menu-card lg">${this.cup.html()}</div>`;
      this.bind();
      this.el.scrollTop = 0;
      return;
    }
    if (this.screen === 'editor') {
      const top = keepScroll ? this.el.scrollTop : 0;
      this.el.innerHTML = `<div class="menu-card lg">${this.editor.html()}</div>`;
      this.bind();
      this.el.scrollTop = top;
      return;
    }
    if (this.picking) {
      this.el.innerHTML = `<div class="menu-card">${this.pickerHtml(this.picking)}</div>`;
      this.bind();
      return;
    }
    this.el.innerHTML = `
      <div class="menu-card">
        <div class="menu-head">
          <h1>PITCHLINE</h1>
          <span class="menu-sub">11대11 · ${TEAMS.length}개 클럽 · 베타</span>
          <button type="button" class="lg-ghost menu-help" data-act="help">조작법</button>
        </div>
        ${two ? `<div class="seg mode" role="group" aria-label="인원">
          <button type="button" data-act="mode" data-v="1" class="${s.mode === 1 ? 'on' : ''}">1인 · AI 상대</button>
          <button type="button" data-act="mode" data-v="2" class="${s.mode === 2 ? 'on' : ''}">2인 대전 (키보드)</button>
        </div>` : ''}
        <div class="teams">${this.teamCard('home')}<div class="vs">VS</div>${this.teamCard('away')}</div>
        <div class="options">
          ${s.mode === 1 ? `<div class="opt">
            <span>난이도</span>
            <div class="seg" role="group" aria-label="난이도">
              ${(['easy', 'normal', 'hard'] as const).map((d) => `<button type="button" data-act="diff" data-v="${d}" class="${s.difficulty === d ? 'on' : ''}">${DIFFICULTY_LABEL[d]}</button>`).join('')}
            </div>
          </div>` : ''}
          <div class="opt">
            <span>경기 시간</span>
            <div class="seg" role="group" aria-label="경기 시간">
              ${[3, 5, 10].map((m) => `<button type="button" data-act="min" data-v="${m}" class="${s.minutes === m ? 'on' : ''}">${m}분</button>`).join('')}
            </div>
          </div>
          <div class="opt">
            <span>오프사이드</span>
            <div class="seg" role="group" aria-label="오프사이드">
              <button type="button" data-act="off" data-v="1" class="${s.offside ? 'on' : ''}">켜기</button>
              <button type="button" data-act="off" data-v="0" class="${!s.offside ? 'on' : ''}">끄기</button>
            </div>
          </div>
          <div class="opt">
            <span>조작 보조</span>
            <div class="seg" role="group" aria-label="조작 보조">
              <button type="button" data-act="assist" data-v="1" class="${s.assist ? 'on' : ''}">켜기</button>
              <button type="button" data-act="assist" data-v="0" class="${!s.assist ? 'on' : ''}">끄기</button>
            </div>
          </div>
        </div>
        <p class="assist-note">${s.assist
          ? '조작 보조: 골대 쪽으로 슛하면 구석을 노려 주고, 슛을 짧게 누르면 거리에 맞는 파워로 찹니다. 패스 방향도 넓게 인식합니다.'
          : '조작 보조 꺼짐: 슛 방향과 파워를 직접 정합니다.'}</p>
        <button type="button" class="start" data-act="start">경기 시작</button>
        <div class="entries">
          <button type="button" class="league-entry" data-act="league"><b>리그 모드</b><span>${this.league.summary}</span></button>
          <button type="button" class="league-entry" data-act="cup"><b>컵 대회</b><span>${this.cup.summary}</span></button>
          <button type="button" class="league-entry" data-act="career"><b>클럽 육성</b><span>${this.career.summary}</span></button>
          <button type="button" class="league-entry" data-act="editor"><b>팀 에디터</b><span>${this.editor.summary}</span></button>
        </div>
      </div>`;
    this.bind();
  }

  private bind(): void {
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('[data-act]')) {
      b.addEventListener('click', () => this.act(b.dataset.act!, b.dataset.v));
    }
    const card = this.el.querySelector<HTMLElement>('.menu-card')!;
    for (const i of this.el.querySelectorAll<HTMLInputElement>('input[data-ed]')) {
      i.addEventListener('change', () => this.editor.change(i, card));
      i.addEventListener('keydown', (e) => { if (e.key === 'Enter') i.blur(); });
    }
    for (const i of this.el.querySelectorAll<HTMLInputElement>('input[data-edc]')) {
      i.addEventListener('input', () => this.editor.colour(i, card, false));
      i.addEventListener('change', () => this.editor.colour(i, card, true));
    }
  }

  private act(act: string, v?: string): void {
    const s = this.s;
    const n = TEAMS.length;
    if (this.screen === 'career' && (act.startsWith('lg-') || act.startsWith('cr-'))) {
      const r = this.career.act(act, v);
      if (r === 'start') {
        const c = this.career.config();
        if (c) { this.onStart?.(c, 'career'); return; }
      }
      if (r === 'exit') this.screen = 'quick';
      this.render(CareerScreen.staysPut(act));
      return;
    }
    if (act.startsWith('lg-')) {
      const r = this.league.act(act, v);
      if (r === 'start') {
        const c = this.league.config();
        if (c) { this.onStart?.(c, 'league'); return; }
      }
      if (r === 'exit') this.screen = 'quick';
      this.render();
      return;
    }
    if (act.startsWith('cup-')) {
      const r = this.cup.act(act, v);
      if (r === 'start') {
        const c = this.cup.config();
        if (c) { this.onStart?.(c, 'cup'); return; }
      }
      if (r === 'exit') this.screen = 'quick';
      this.render();
      return;
    }
    if (act.startsWith('ed-')) {
      if (this.editor.act(act, v) === 'exit') this.screen = 'quick';
      this.render(EditorScreen.staysPut(act));
      return;
    }
    const step = (side: 'home' | 'away', d: number) => {
      let i = s[side];
      do { i = (i + d + n) % n; } while (i === s[side === 'home' ? 'away' : 'home']);
      s[side] = i;
      s[side === 'home' ? 'homeFormation' : 'awayFormation'] = TEAMS[i].formation;
    };
    switch (act) {
      case 'league': this.screen = 'league'; break;
      case 'cup': this.screen = 'cup'; break;
      case 'career': this.screen = 'career'; break;
      case 'help': this.screen = 'help'; break;
      case 'help-exit': this.screen = 'quick'; break;
      case 'help-voice': {
        const note = this.el.querySelector('[data-id="voice-note"]');
        if (note) note.textContent = '확인하는 중…';
        void testVoice().then((msg) => { const n = this.el.querySelector('[data-id="voice-note"]'); if (n) n.textContent = msg; });
        return;
      }
      case 'help-copy':
        void copyText(deviceReport(!this.allowTwoPlayer())).then((ok) => {
          const note = this.el.querySelector('[data-id="copy-note"]');
          if (note) note.textContent = ok ? '복사했습니다.' : '복사하지 못했습니다. 화면을 캡처해서 보내 주세요.';
        });
        return;
      case 'editor': this.screen = 'editor'; break;
      case 'mode': s.mode = v === '2' ? 2 : 1; break;
      case 'prev-home': step('home', -1); break;
      case 'next-home': step('home', 1); break;
      case 'prev-away': step('away', -1); break;
      case 'next-away': step('away', 1); break;
      case 'form-home': s.homeFormation = v!; break;
      case 'form-away': s.awayFormation = v!; break;
      case 'min': s.minutes = Number(v); break;
      case 'off': s.offside = v === '1'; break;
      case 'assist': s.assist = v === '1'; break;
      case 'diff': s.difficulty = v as Difficulty; break;
      case 'pick-home': this.picking = 'home'; break;
      case 'pick-away': this.picking = 'away'; break;
      case 'pick-close': this.picking = null; break;
      case 'choose-home':
      case 'choose-away': {
        const side = act === 'choose-home' ? 'home' : 'away';
        s[side] = Number(v);
        s[side === 'home' ? 'homeFormation' : 'awayFormation'] = TEAMS[s[side]].formation;
        this.picking = null;
        break;
      }
      case 'start':
        save(s);
        this.onStart?.({
          home: TEAMS[s.home], away: TEAMS[s.away],
          homeFormation: s.homeFormation, awayFormation: s.awayFormation,
          seconds: s.minutes * 60, offside: s.offside,
          humans: s.mode === 2 ? ['home', 'away'] : ['home'],
          assist: s.assist ? (s.mode === 2 ? ['home', 'away'] : ['home']) : [],
          difficulty: s.difficulty,
        }, null);
        return;
    }
    save(s);
    this.render();
  }
}
