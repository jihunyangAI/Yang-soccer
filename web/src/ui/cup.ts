import {
  createCup, cupOver, cupRounds, knockedOutIn, loadCup, myTie, playCupRound, roundName, saveCup, tieWinner,
  type CupResult, type CupState, type Tie,
} from '../sim/cup';
import type { Difficulty, MatchConfig } from '../sim/match';
import { FORMATION_NAMES, overall, TEAMS } from '../sim/team';
import { crestSvg } from './crest';
import { teamGrid } from './picker';

const DIFF: Record<Difficulty, string> = { easy: '쉬움', normal: '보통', hard: '어려움' };

interface Draft { team: number; minutes: number; difficulty: Difficulty; offside: boolean; assist: boolean }

const seg = (act: string, items: [string, string][], cur: string, label: string) => `
  <div class="seg" role="group" aria-label="${label}">
    ${items.map(([v, text]) => `<button type="button" data-act="${act}" data-v="${v}" class="${cur === v ? 'on' : ''}">${text}</button>`).join('')}
  </div>`;

/**
 * Cup mode screens, drawn inside the menu card: setup, the hub between ties (next match and
 * the bracket round by round) and the summary once the cup is won or lost.
 */
export class CupScreen {
  state: CupState | null = loadCup();
  private draft: Draft = {
    team: 0, minutes: 5, difficulty: 'normal', offside: true,
    assist: window.matchMedia('(pointer: coarse)').matches,
  };
  /** Round shown in the bracket; null follows the latest round. */
  private viewRound: number | null = null;
  private confirmQuit = false;
  private picking = false;

  /** Short label for the main menu button. */
  get summary(): string {
    const s = this.state;
    if (!s) return '새 대회 시작';
    if (cupOver(s)) return `${s.edition}회 대회 종료 · 결과 보기`;
    return `이어하기 · ${TEAMS[s.team].short} · ${roundName(s.rounds.length - 1, cupRounds(s))}`;
  }

  /** Settings for the player's next tie. Their club always takes the engine's home side. */
  config(): Omit<MatchConfig, 'seed'> | null {
    const s = this.state, t = s && myTie(s);
    if (!s || !t) return null;
    const me = TEAMS[s.team], opp = TEAMS[t.opponent];
    return {
      home: me, away: opp, homeFormation: s.formation, awayFormation: opp.formation,
      seconds: s.minutes * 60, offside: s.offside, humans: ['home'], assist: s.assist ? ['home'] : [],
      difficulty: s.difficulty, decider: true,
    };
  }

  /** Record the player's finished tie and settle the round. */
  report(result: CupResult): void {
    const s = this.state;
    if (!s || !myTie(s)) return;
    playCupRound(s, result);
    saveCup(s);
    this.viewRound = null;
  }

  html(): string {
    const s = this.state;
    return s ? this.hubHtml(s) : this.setupHtml();
  }

  // ---------------------------------------------------------------- setup
  private setupHtml(): string {
    const d = this.draft, t = TEAMS[d.team];
    if (this.picking) {
      return `
        <div class="picker">
          <div class="picker-head"><b>컵 대회에 나갈 팀</b><button type="button" class="picker-close" data-act="cup-pick-close">닫기</button></div>
          ${teamGrid('cup-team', { selected: d.team })}
        </div>`;
    }
    return `
      <div class="lg-head">
        <div><h2>컵 대회</h2><span class="menu-sub">1부·2부 ${TEAMS.length}개 클럽 토너먼트 · 지면 탈락 · 자동 저장됩니다</span></div>
        <button type="button" class="lg-ghost" data-act="cup-exit">메인 메뉴</button>
      </div>
      <div class="team-card">
        <div class="card-label">내 팀</div>
        <button type="button" class="team-name" data-act="cup-pick" aria-label="팀 목록에서 고르기">
          ${crestSvg(t.crest, 46)}
          <span class="tn"><b>${t.name}</b><small>${t.style} · 전력 ${overall(t)} · 팀 목록 ▾</small></span>
        </button>
      </div>
      <div class="options">
        <div class="opt"><span>난이도</span>${seg('cup-diff', (['easy', 'normal', 'hard'] as const).map((x) => [x, DIFF[x]]), d.difficulty, '난이도')}</div>
        <div class="opt"><span>경기 시간</span>${seg('cup-min', [['3', '3분'], ['5', '5분'], ['10', '10분']], String(d.minutes), '경기 시간')}</div>
        <div class="opt"><span>오프사이드</span>${seg('cup-off', [['1', '켜기'], ['0', '끄기']], d.offside ? '1' : '0', '오프사이드')}</div>
        <div class="opt"><span>조작 보조</span>${seg('cup-assist', [['1', '켜기'], ['0', '끄기']], d.assist ? '1' : '0', '조작 보조')}</div>
      </div>
      <p class="assist-note">${roundName(0)}부터 결승까지 ${cupRounds()}번 이기면 우승입니다. 비기면 연장전에서 먼저 넣는 팀이 이기고, 그래도 골이 없으면 승부차기로 가려냅니다.</p>
      <button type="button" class="start" data-act="cup-new">대진 추첨하고 시작</button>`;
  }

  // ---------------------------------------------------------------- hub
  private hubHtml(s: CupState): string {
    const over = cupOver(s);
    const cur = s.rounds.length - 1;
    const head = `
      <div class="lg-head">
        <div>
          <h2>컵 대회 · ${s.edition}회</h2>
          <span class="menu-sub">${over ? '대회 종료' : `${roundName(cur, cupRounds(s))} 진행 중`} · ${TEAMS[s.team].name}</span>
        </div>
        <button type="button" class="lg-ghost" data-act="cup-exit">메인 메뉴</button>
      </div>`;
    const quit = this.confirmQuit
      ? `<div class="lg-quit"><span>이 대회 기록이 지워집니다.</span>
           <button type="button" class="lg-ghost danger" data-act="cup-quit-yes">지우고 그만두기</button>
           <button type="button" class="lg-ghost" data-act="cup-quit-no">취소</button></div>`
      : `<div class="lg-quit"><button type="button" class="lg-ghost" data-act="cup-quit">대회 그만두기</button></div>`;
    return `${head}${over ? this.finalHtml(s) : this.nextHtml(s)}${this.bracketHtml(s)}${over ? '' : quit}`;
  }

  private nextHtml(s: CupState): string {
    const t = myTie(s)!;
    const opp = TEAMS[t.opponent];
    const side = (i: number) => `
      <div class="lg-side ${i === s.team ? 'lg-me' : ''}">${crestSvg(TEAMS[i].crest, 44)}<b>${TEAMS[i].name}</b><small>${i === t.tie.home ? '홈' : '원정'}</small></div>`;
    return `
      <div class="lg-next">
        <div class="card-label">다음 경기 · ${roundName(s.rounds.length - 1, cupRounds(s))} · 단판 승부</div>
        <div class="lg-fix">${side(t.tie.home)}<span class="vs">VS</span>${side(t.tie.away)}</div>
        <div class="team-meta"><span>상대: ${opp.style} · 전력 ${overall(opp)}</span><span>난이도 ${DIFF[s.difficulty]} · ${s.minutes}분</span></div>
        <div class="opt"><span>내 포메이션</span>${seg('cup-form', FORMATION_NAMES.map((x) => [x, x]), s.formation, '포메이션')}</div>
        <div class="lg-actions">
          <button type="button" class="start" data-act="cup-play">경기 시작</button>
          <button type="button" class="lg-ghost" data-act="cup-sim">뛰지 않고 결과만 보기</button>
        </div>
      </div>`;
  }

  private finalHtml(s: CupState): string {
    const champ = TEAMS[s.champion!];
    const out = knockedOutIn(s);
    const line = out === null ? '우승을 차지했습니다!'
      : out === cupRounds(s) - 1 ? '결승에서 져 준우승으로 마쳤습니다.'
      : `${roundName(out, cupRounds(s))}에서 탈락했습니다. 다음 대회에 다시 도전해 보세요.`;
    return `
      <div class="lg-next lg-final">
        <div class="card-label">${s.edition}회 대회 종료</div>
        <div class="lg-champ">${crestSvg(champ.crest, 56)}<div><small>우승</small><b>${champ.name}</b></div></div>
        <p class="lg-line">${TEAMS[s.team].name}: ${line}</p>
        <div class="lg-actions">
          <button type="button" class="start" data-act="cup-again">같은 팀으로 다음 대회</button>
          <button type="button" class="lg-ghost" data-act="cup-fresh">팀을 바꿔 새로 시작</button>
        </div>
      </div>`;
  }

  /** One round of the bracket at a time, with tabs for the rounds drawn so far. */
  private bracketHtml(s: CupState): string {
    const total = cupRounds(s);
    const r = Math.min(s.rounds.length - 1, Math.max(0, this.viewRound ?? s.rounds.length - 1));
    const tabs = `
      <div class="seg" role="group" aria-label="라운드">
        ${Array.from({ length: total }, (_, i) => `<button type="button" data-act="cup-round" data-v="${i}" class="${i === r ? 'on' : ''}" ${i < s.rounds.length ? '' : 'disabled'}>${roundName(i, total)}</button>`).join('')}
      </div>`;
    const row = (t: Tie) => {
      const w = tieWinner(t);
      const mine = t.home === s.team || t.away === s.team;
      const name = (i: number) => `<span class="${w !== null && w !== i ? 'cup-out' : ''}">${TEAMS[i].name}</span>`;
      return `<div class="lg-row ${mine ? 'lg-me' : ''}">
        <span class="lg-team r">${name(t.home)}${crestSvg(TEAMS[t.home].crest, 20)}</span>
        <b class="lg-score">${t.score ? `${t.score[0]} : ${t.score[1]}` : 'vs'}${t.pens ? `<small class="cup-pens">승부차기 ${t.pens[0]}:${t.pens[1]}</small>` : ''}</b>
        <span class="lg-team">${crestSvg(TEAMS[t.away].crest, 20)}${name(t.away)}</span>
      </div>`;
    };
    return `${tabs}<div class="lg-list">${s.rounds[r].map(row).join('')}</div>`;
  }

  // ---------------------------------------------------------------- actions
  /** Handle a button; returns 'start' to kick off the next tie or 'exit' to leave cup mode. */
  act(act: string, v?: string): 'start' | 'exit' | void {
    const d = this.draft, s = this.state;
    if (act !== 'cup-quit') this.confirmQuit = false;
    const fresh = (team: number, from: Draft | CupState, edition: number, formation?: string) => {
      this.state = createCup({
        team, minutes: from.minutes, difficulty: from.difficulty, offside: from.offside, assist: from.assist,
        formation, edition, seed: (Math.random() * 2 ** 31) | 0,
      });
      this.viewRound = null;
      saveCup(this.state);
    };
    switch (act) {
      case 'cup-exit': this.picking = false; return 'exit';
      // setup
      case 'cup-pick': this.picking = true; break;
      case 'cup-pick-close': this.picking = false; break;
      case 'cup-team': d.team = Number(v); this.picking = false; break;
      case 'cup-diff': d.difficulty = v as Difficulty; break;
      case 'cup-min': d.minutes = Number(v); break;
      case 'cup-off': d.offside = v === '1'; break;
      case 'cup-assist': d.assist = v === '1'; break;
      case 'cup-new': fresh(d.team, d, 1); break;
      // hub
      case 'cup-form': if (s) { s.formation = v!; saveCup(s); } break;
      case 'cup-play': if (s && myTie(s)) return 'start'; break;
      case 'cup-sim': if (s && myTie(s)) { playCupRound(s, null); saveCup(s); this.viewRound = null; } break;
      case 'cup-round': if (s && Number(v) < s.rounds.length) this.viewRound = Number(v); break;
      case 'cup-quit': this.confirmQuit = true; break;
      case 'cup-quit-no': break;
      case 'cup-quit-yes': this.state = null; saveCup(null); break;
      case 'cup-again': if (s) fresh(s.team, s, s.edition + 1, s.formation); break;
      case 'cup-fresh':
        if (s) Object.assign(d, { team: s.team, minutes: s.minutes, difficulty: s.difficulty, offside: s.offside, assist: s.assist });
        this.state = null; saveCup(null);
        break;
    }
  }
}
