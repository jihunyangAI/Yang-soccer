import {
  createLeague, isOver, loadLeague, myFixture, nextSeason, playRound, saveLeague, seasonMoves, table,
  type LeagueState, type Row,
} from '../sim/league';
import type { Difficulty, MatchConfig } from '../sim/match';
import type { RosterPlayer } from '../sim/roster';
import { DIV_SIZE, DIVISION_NAME, FORMATION_NAMES, MOVES, overall, TEAMS, type TeamDef } from '../sim/team';
import { crestSvg } from './crest';
import { teamGrid } from './picker';

const DIFF: Record<Difficulty, string> = { easy: '쉬움', normal: '보통', hard: '어려움' };
type Tab = 'table' | 'round' | 'mine';

interface Draft { team: number; legs: 1 | 2; minutes: number; difficulty: Difficulty; offside: boolean; assist: boolean }

const seg = (act: string, items: [string, string][], cur: string, label: string) => `
  <div class="seg" role="group" aria-label="${label}">
    ${items.map(([v, text]) => `<button type="button" data-act="${act}" data-v="${v}" class="${cur === v ? 'on' : ''}">${text}</button>`).join('')}
  </div>`;

/** Where a league's season is kept, and what a club development career adds to it. */
export interface LeagueHost {
  load(): LeagueState | null;
  save(s: LeagueState | null): void;
  /** Career only: the player's club as its squad makes it, and the squad that goes to a match. */
  club?(): TeamDef;
  squad?(): RosterPlayer[];
  /** Career only: a round was settled (`played` = the match was really played); a new season was drawn. */
  roundDone?(played: boolean): void;
  seasonDone?(next: LeagueState): void;
}

/**
 * League mode screens, drawn inside the menu card: season setup, the hub between matches
 * (next fixture, standings, results, the player's calendar) and the end-of-season summary.
 * The same screens run the league inside club development mode.
 */
export class LeagueScreen {
  state: LeagueState | null;
  constructor(private host: LeagueHost = { load: loadLeague, save: saveLeague }) {
    this.state = host.load();
  }
  /** Read the season again from where it is kept (the career may have replaced it). */
  reload(): void { this.state = this.host.load(); }
  private draft: Draft = {
    team: 0, legs: 1, minutes: 5, difficulty: 'normal', offside: true,
    assist: window.matchMedia('(pointer: coarse)').matches,
  };
  private tab: Tab = 'table';
  /** Round shown in the results tab; null follows the latest finished round. */
  private viewRound: number | null = null;
  private confirmQuit = false;
  private picking = false;

  /** Short label for the main menu button. */
  get summary(): string {
    const s = this.state;
    if (!s) return '새 시즌 시작';
    if (isOver(s)) return `시즌 ${s.season} 종료 · 결과 보기`;
    return `이어하기 · ${TEAMS[s.team].short} · ${s.round + 1}/${s.rounds.length} 라운드`;
  }

  /** Settings for the player's next league match. Their club always takes the engine's home side. */
  config(): Omit<MatchConfig, 'seed'> | null {
    const s = this.state, f = s && myFixture(s);
    if (!s || !f) return null;
    const me = TEAMS[s.team], opp = TEAMS[f.opponent];
    const squad = this.host.squad?.();
    return {
      home: me, away: opp, homeFormation: s.formation, awayFormation: opp.formation,
      seconds: s.minutes * 60, offside: s.offside, humans: ['home'], assist: s.assist ? ['home'] : [],
      difficulty: s.difficulty, ...(squad ? { rosters: { home: squad }, lineupGiven: ['home' as const] } : {}),
    };
  }

  /** Record the player's finished match (their goals, the opponent's) and settle the round. */
  report(mine: number, theirs: number): void {
    const s = this.state, f = s && myFixture(s);
    if (!s || !f) return;
    playRound(s, f.home ? [mine, theirs] : [theirs, mine]);
    this.host.roundDone?.(true);
    this.host.save(s);
    this.viewRound = null;
    this.tab = 'round';
  }

  html(): string {
    const s = this.state;
    if (!s) return this.setupHtml();
    return this.hubHtml(s);
  }

  // ---------------------------------------------------------------- setup
  private setupHtml(): string {
    const d = this.draft, t = TEAMS[d.team];
    if (this.picking) {
      return `
        <div class="picker">
          <div class="picker-head"><b>리그에서 맡을 팀</b><button type="button" class="picker-close" data-act="lg-pick-close">닫기</button></div>
          ${teamGrid('lg-team', { selected: d.team })}
        </div>`;
    }
    const games = (DIV_SIZE - 1) * d.legs;
    return `
      <div class="lg-head">
        <div><h2>리그 모드</h2><span class="menu-sub">1부·2부 각 ${DIV_SIZE}개 클럽 · 시즌마다 ${MOVES}팀 승격·강등 · 자동 저장됩니다</span></div>
        <button type="button" class="lg-ghost" data-act="lg-exit">메인 메뉴</button>
      </div>
      <div class="team-card">
        <div class="card-label">내 팀</div>
        <button type="button" class="team-name" data-act="lg-pick" aria-label="팀 목록에서 고르기">
          ${crestSvg(t.crest, 46)}
          <span class="tn"><b>${t.name}</b><small>${DIVISION_NAME[t.division]} · 전력 ${overall(t)} · 팀 목록 ▾</small></span>
        </button>
      </div>
      <div class="options">
        <div class="opt"><span>시즌 길이</span>${seg('lg-legs', [['1', `한 번씩 (${DIV_SIZE - 1}경기)`], ['2', `홈·원정 (${(DIV_SIZE - 1) * 2}경기)`]], String(d.legs), '시즌 길이')}</div>
        <div class="opt"><span>난이도</span>${seg('lg-diff', (['easy', 'normal', 'hard'] as const).map((x) => [x, DIFF[x]]), d.difficulty, '난이도')}</div>
        <div class="opt"><span>경기 시간</span>${seg('lg-min', [['3', '3분'], ['5', '5분'], ['10', '10분']], String(d.minutes), '경기 시간')}</div>
        <div class="opt"><span>오프사이드</span>${seg('lg-off', [['1', '켜기'], ['0', '끄기']], d.offside ? '1' : '0', '오프사이드')}</div>
        <div class="opt"><span>조작 보조</span>${seg('lg-assist', [['1', '켜기'], ['0', '끄기']], d.assist ? '1' : '0', '조작 보조')}</div>
      </div>
      <p class="assist-note">${DIVISION_NAME[t.division]}에서 시작합니다. 내 경기 ${games}번을 직접 뛰고, 다른 팀들의 경기는 전력에 따라 자동으로 결과가 정해집니다. ${t.division === 1 ? `하위 ${MOVES}팀은 2부로 강등됩니다.` : `상위 ${MOVES}팀은 1부로 승격합니다.`}</p>
      <button type="button" class="start" data-act="lg-new">시즌 시작</button>`;
  }

  // ---------------------------------------------------------------- hub
  private hubHtml(s: LeagueState): string {
    const rows = table(s);
    const pos = rows.findIndex((r) => r.team === s.team) + 1;
    const over = isOver(s);
    const total = s.rounds.length;
    const head = `
      <div class="lg-head">
        <div>
          <h2>${DIVISION_NAME[s.division]} · 시즌 ${s.season}</h2>
          <span class="menu-sub">${over ? '시즌 종료' : `${s.round + 1} / ${total} 라운드`} · ${TEAMS[s.team].name} ${s.round > 0 ? `${pos}위` : ''}</span>
        </div>
        <button type="button" class="lg-ghost" data-act="lg-exit">메인 메뉴</button>
      </div>`;
    const tabs = seg('lg-tab', [['table', '순위표'], ['round', '라운드 결과'], ['mine', '내 일정']], this.tab, '보기');
    const body = this.tab === 'table' ? this.tableHtml(s, rows) : this.tab === 'round' ? this.roundHtml(s) : this.mineHtml(s);
    const quit = this.confirmQuit
      ? `<div class="lg-quit"><span>${this.host.club ? '선수단과 예산을 포함한 모든 기록이 지워집니다.' : '이 시즌 기록이 지워집니다.'}</span>
           <button type="button" class="lg-ghost danger" data-act="lg-quit-yes">지우고 그만두기</button>
           <button type="button" class="lg-ghost" data-act="lg-quit-no">취소</button></div>`
      : `<div class="lg-quit"><button type="button" class="lg-ghost" data-act="lg-quit">${this.host.club ? '클럽 육성 그만두기' : '시즌 그만두기'}</button></div>`;
    return `${head}${over ? this.finalHtml(s, rows, pos) : this.nextHtml(s, rows)}${tabs}${body}${over ? '' : quit}`;
  }

  private nextHtml(s: LeagueState, rows: Row[]): string {
    const f = myFixture(s)!;
    const [h, a] = f.fixture;
    const opp = TEAMS[f.opponent];
    const oppPos = rows.findIndex((r) => r.team === f.opponent) + 1;
    const side = (i: number) => `
      <div class="lg-side ${i === s.team ? 'lg-me' : ''}">${crestSvg(TEAMS[i].crest, 44)}<b>${TEAMS[i].name}</b><small>${i === h ? '홈' : '원정'}</small></div>`;
    return `
      <div class="lg-next">
        <div class="card-label">다음 경기 · ${s.round + 1}라운드 · ${f.home ? '홈 경기' : '원정 경기'}</div>
        <div class="lg-fix">${side(h)}<span class="vs">VS</span>${side(a)}</div>
        <div class="team-meta"><span>상대: ${opp.style} · 전력 ${overall(opp)}${s.round > 0 ? ` · 현재 ${oppPos}위` : ''}</span><span>난이도 ${DIFF[s.difficulty]} · ${s.minutes}분</span></div>
        <div class="opt"><span>내 포메이션</span>${seg('lg-form', FORMATION_NAMES.map((x) => [x, x]), s.formation, '포메이션')}</div>
        <div class="lg-actions">
          <button type="button" class="start" data-act="lg-play">경기 시작</button>
          <button type="button" class="lg-ghost" data-act="lg-sim">뛰지 않고 결과만 보기</button>
        </div>
      </div>`;
  }

  private finalHtml(s: LeagueState, rows: Row[], pos: number): string {
    const champ = TEAMS[rows[0].team];
    const me = rows[pos - 1];
    const { up, down } = seasonMoves(s);
    const names = (ids: number[]) => ids.map((i) => (i === s.team ? `<b>${TEAMS[i].name}</b>` : TEAMS[i].name)).join(', ');
    const place = pos === 1 ? '우승을 차지했습니다!' : `${pos}위로 시즌을 마쳤습니다.`;
    const line = up.includes(s.team) ? `${place} 다음 시즌은 1부 리그에서 뜁니다!`
      : down.includes(s.team) ? `${place} 다음 시즌은 2부 리그로 내려갑니다.`
      : place;
    return `
      <div class="lg-next lg-final">
        <div class="card-label">시즌 ${s.season} 종료</div>
        <div class="lg-champ">${crestSvg(champ.crest, 56)}<div><small>우승</small><b>${champ.name}</b><small>승점 ${rows[0].pts}</small></div></div>
        <p class="lg-line">${TEAMS[s.team].name}: ${line} (${me.won}승 ${me.drawn}무 ${me.lost}패, 승점 ${me.pts})</p>
        <p class="lg-moves"><span class="lg-up">▲ 1부 승격</span> ${names(up)}<br><span class="lg-down">▼ 2부 강등</span> ${names(down)}</p>
        <div class="lg-actions">
          <button type="button" class="start" data-act="lg-again">같은 팀으로 다음 시즌</button>
          ${this.host.club ? '' : '<button type="button" class="lg-ghost" data-act="lg-fresh">팀을 바꿔 새로 시작</button>'}
        </div>
      </div>`;
  }

  private tableHtml(s: LeagueState, rows: Row[]): string {
    // Promotion places in the second division, relegation places in the first.
    const zone = (i: number) => (s.division === 2 && i < MOVES ? 'lg-up' : s.division === 1 && i >= rows.length - MOVES ? 'lg-down' : '');
    const formDot = (f: 'W' | 'D' | 'L') => `<i class="f-${f}" title="${f === 'W' ? '승' : f === 'D' ? '무' : '패'}"></i>`;
    return `
      <div class="lg-scroll">
        <table class="lg-table">
          <thead><tr><th>#</th><th class="l">팀</th><th>경기</th><th>승</th><th>무</th><th>패</th><th class="x">득</th><th class="x">실</th><th>득실</th><th>승점</th><th class="x l">최근</th></tr></thead>
          <tbody>
            ${rows.map((r, i) => `
              <tr class="${r.team === s.team ? 'lg-me' : ''}">
                <td class="${zone(i)}">${i + 1}</td>
                <td class="l"><span class="lg-team">${crestSvg(TEAMS[r.team].crest, 20)}<span>${TEAMS[r.team].name}</span></span></td>
                <td>${r.played}</td><td>${r.won}</td><td>${r.drawn}</td><td>${r.lost}</td>
                <td class="x">${r.gf}</td><td class="x">${r.ga}</td><td>${r.gd > 0 ? '+' : ''}${r.gd}</td><td><b>${r.pts}</b></td>
                <td class="x l"><span class="lg-form">${r.form.map(formDot).join('')}</span></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="lg-key">${s.division === 1 ? `<span class="lg-down">▼</span> 하위 ${MOVES}팀은 2부 리그로 강등` : `<span class="lg-up">▲</span> 상위 ${MOVES}팀은 1부 리그로 승격`}</p>`;
  }

  private roundHtml(s: LeagueState): string {
    const total = s.rounds.length;
    const r = Math.min(total - 1, Math.max(0, this.viewRound ?? Math.max(0, s.round - 1)));
    const played = r < s.round;
    return `
      <div class="lg-rnav">
        <button type="button" class="arrow" data-act="lg-rprev" aria-label="이전 라운드" ${r === 0 ? 'disabled' : ''}>‹</button>
        <b>${r + 1}라운드 ${played ? '결과' : '일정'}</b>
        <button type="button" class="arrow" data-act="lg-rnext" aria-label="다음 라운드" ${r === total - 1 ? 'disabled' : ''}>›</button>
      </div>
      <div class="lg-list">
        ${s.rounds[r].map(([h, a], i) => {
          const res = s.results[r][i];
          const mine = h === s.team || a === s.team;
          return `<div class="lg-row ${mine ? 'lg-me' : ''}">
            <span class="lg-team r"><span>${TEAMS[h].name}</span>${crestSvg(TEAMS[h].crest, 20)}</span>
            <b class="lg-score">${res ? `${res[0]} : ${res[1]}` : 'vs'}</b>
            <span class="lg-team">${crestSvg(TEAMS[a].crest, 20)}<span>${TEAMS[a].name}</span></span>
          </div>`;
        }).join('')}
      </div>`;
  }

  private mineHtml(s: LeagueState): string {
    return `
      <div class="lg-list">
        ${s.rounds.map((_, r) => {
          const f = myFixture(s, r)!;
          const res = s.results[r][f.index];
          const my = res ? (f.home ? res[0] : res[1]) : 0, their = res ? (f.home ? res[1] : res[0]) : 0;
          const mark = !res ? '' : my > their ? 'W' : my === their ? 'D' : 'L';
          return `<div class="lg-row mine ${r === s.round ? 'lg-me' : ''}">
            <span class="lg-r">${r + 1}R</span>
            <span class="lg-ha">${f.home ? '홈' : '원정'}</span>
            <span class="lg-team">${crestSvg(TEAMS[f.opponent].crest, 20)}<span>${TEAMS[f.opponent].name}</span></span>
            <b class="lg-score">${res ? `${my} : ${their}` : r === s.round ? '다음' : ''}</b>
            <span class="lg-form">${mark ? `<i class="f-${mark}"></i>` : ''}</span>
          </div>`;
        }).join('')}
      </div>`;
  }

  // ---------------------------------------------------------------- actions
  /** Handle a button; returns 'start' to kick off the next match or 'exit' to leave league mode. */
  act(act: string, v?: string): 'start' | 'exit' | void {
    const d = this.draft, s = this.state;
    if (act !== 'lg-quit') this.confirmQuit = false;
    switch (act) {
      case 'lg-exit': this.picking = false; return 'exit';
      // setup
      case 'lg-pick': this.picking = true; break;
      case 'lg-pick-close': this.picking = false; break;
      case 'lg-team': d.team = Number(v); this.picking = false; break;
      case 'lg-legs': d.legs = v === '2' ? 2 : 1; break;
      case 'lg-diff': d.difficulty = v as Difficulty; break;
      case 'lg-min': d.minutes = Number(v); break;
      case 'lg-off': d.offside = v === '1'; break;
      case 'lg-assist': d.assist = v === '1'; break;
      case 'lg-new':
        this.state = createLeague({ ...d, seed: (Math.random() * 2 ** 31) | 0 });
        this.tab = 'table'; this.viewRound = null;
        this.host.save(this.state);
        break;
      // hub
      case 'lg-tab': this.tab = v as Tab; break;
      case 'lg-form': if (s) { s.formation = v!; this.host.save(s); } break;
      case 'lg-play': if (s && !isOver(s)) return 'start'; break;
      case 'lg-sim':
        if (s && !isOver(s)) { playRound(s, null, this.host.club?.()); this.host.roundDone?.(false); this.host.save(s); this.viewRound = null; this.tab = 'round'; }
        break;
      case 'lg-rprev':
      case 'lg-rnext':
        if (s) {
          const cur = this.viewRound ?? Math.max(0, s.round - 1);
          this.viewRound = Math.min(s.rounds.length - 1, Math.max(0, cur + (act === 'lg-rnext' ? 1 : -1)));
        }
        break;
      case 'lg-quit': this.confirmQuit = true; break;
      case 'lg-quit-no': break;
      case 'lg-quit-yes': this.state = null; this.host.save(null); break;
      case 'lg-again':
        if (s) {
          this.state = nextSeason(s, (Math.random() * 2 ** 31) | 0);
          this.tab = 'table'; this.viewRound = null;
          this.host.seasonDone?.(this.state);
          this.host.save(this.state);
        }
        break;
      case 'lg-fresh':
        if (s) Object.assign(d, { team: s.team, legs: s.legs, minutes: s.minutes, difficulty: s.difficulty, offside: s.offside, assist: s.assist });
        this.state = null; this.host.save(null);
        break;
    }
  }
}
