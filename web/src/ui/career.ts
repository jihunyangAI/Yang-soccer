import {
  afterRound, afterSeason, buy, buyBlock, careerClub, createCareer, loadCareer, matchSquad, playerValue, saveCareer,
  sell, sellBlock, sellValue, squadRating, SQUAD_MAX, type CareerPlayer, type CareerState,
} from '../sim/career';
import { isOver } from '../sim/league';
import type { Difficulty, MatchConfig } from '../sim/match';
import { pickLineup, playerOverall } from '../sim/roster';
import { DIVISION_NAME, divisionClubs, FORMATIONS, overall, TEAMS } from '../sim/team';
import { crestSvg } from './crest';
import { LeagueScreen } from './league';
import { teamGrid } from './picker';

const DIFF: Record<Difficulty, string> = { easy: '쉬움', normal: '보통', hard: '어려움' };
const CAT_LABEL = { GK: 'GK', DF: '수비', MF: '미드', FW: '공격' } as const;
type Tab = 'league' | 'squad' | 'market';

const seg = (act: string, items: [string, string][], cur: string, label: string) => `
  <div class="seg" role="group" aria-label="${label}">
    ${items.map(([v, text]) => `<button type="button" data-act="${act}" data-v="${v}" class="${cur === v ? 'on' : ''}">${text}</button>`).join('')}
  </div>`;
const money = (v: number) => `${Number.isInteger(v) ? v : v.toFixed(1)}억`;
/** How much a player can still improve, in words. */
const growth = (p: CareerPlayer) => {
  const room = p.potential - playerOverall(p);
  return room >= 8 ? '<b class="cr-hi">높음</b>' : room >= 3 ? '보통' : room > 0 ? '낮음' : '<span class="cr-dim">없음</span>';
};

/**
 * Club development mode screens, drawn inside the menu card: setup, then a hub with the league
 * (the same screens as league mode), the squad and the transfer market.
 */
export class CareerScreen {
  state: CareerState | null = loadCareer();
  private tab: Tab = 'league';
  private draft = {
    team: divisionClubs(2)[0], minutes: 5, difficulty: 'normal' as Difficulty,
    assist: window.matchMedia('(pointer: coarse)').matches,
  };
  private picking = false;
  private note = '';
  /** The career's league, run by the ordinary league screens. */
  private league = new LeagueScreen({
    load: () => this.state?.league ?? null,
    save: (s) => {
      if (!this.state) return;
      if (s) { this.state.league = s; saveCareer(this.state); } else { this.state = null; saveCareer(null); }
    },
    club: () => careerClub(this.state!),
    squad: () => matchSquad(this.state!),
    roundDone: (played) => { if (this.state) afterRound(this.state, played); },
    seasonDone: (next) => { if (this.state) afterSeason(this.state, next); },
  });

  /** Short label for the main menu button. */
  get summary(): string {
    const c = this.state;
    if (!c) return '선수를 키우고 영입해 1부 우승까지';
    const s = c.league;
    return `이어하기 · ${TEAMS[c.team].short} · 시즌 ${s.season}${isOver(s) ? ' 종료' : ` ${s.round + 1}/${s.rounds.length}R`} · ${money(c.money)}`;
  }

  config(): Omit<MatchConfig, 'seed'> | null { return this.state ? this.league.config() : null; }
  report(mine: number, theirs: number): void { if (this.state) { this.league.report(mine, theirs); this.tab = 'league'; } }

  html(): string {
    const c = this.state;
    return c ? this.hubHtml(c) : this.setupHtml();
  }

  // ---------------------------------------------------------------- setup
  private setupHtml(): string {
    const d = this.draft, t = TEAMS[d.team];
    if (this.picking) {
      return `
        <div class="picker">
          <div class="picker-head"><b>키울 클럽</b><button type="button" class="picker-close" data-act="cr-pick-close">닫기</button></div>
          ${teamGrid('cr-team', { selected: d.team })}
        </div>`;
    }
    return `
      <div class="lg-head">
        <div><h2>클럽 육성</h2><span class="menu-sub">여러 시즌 동안 선수를 키우고 영입합니다 · 자동 저장</span></div>
        <button type="button" class="lg-ghost" data-act="cr-exit">메인 메뉴</button>
      </div>
      <div class="team-card">
        <div class="card-label">내 클럽</div>
        <button type="button" class="team-name" data-act="cr-pick" aria-label="팀 목록에서 고르기">
          ${crestSvg(t.crest, 46)}
          <span class="tn"><b>${t.name}</b><small>${DIVISION_NAME[t.division]} · 전력 ${overall(t)} · 팀 목록 ▾</small></span>
        </button>
      </div>
      <div class="options">
        <div class="opt"><span>난이도</span>${seg('cr-diff', (['easy', 'normal', 'hard'] as const).map((x) => [x, DIFF[x]]), d.difficulty, '난이도')}</div>
        <div class="opt"><span>경기 시간</span>${seg('cr-min', [['3', '3분'], ['5', '5분'], ['10', '10분']], String(d.minutes), '경기 시간')}</div>
        <div class="opt"><span>조작 보조</span>${seg('cr-assist', [['1', '켜기'], ['0', '끄기']], d.assist ? '1' : '0', '조작 보조')}</div>
      </div>
      <p class="assist-note">리그를 시즌마다 이어서 치릅니다. 선수는 경기를 뛰면 성장하고(어릴수록, 성장 여지가 클수록 빠르게) 나이가 들면 기량이 떨어집니다. 경기 수입과 시즌 상금으로 이적 시장에서 선수를 영입할 수 있습니다. 2부 팀으로 시작해 승격을 노려 보세요.</p>
      <button type="button" class="start" data-act="cr-new">${t.name}(으)로 시작</button>`;
  }

  // ---------------------------------------------------------------- hub
  private hubHtml(c: CareerState): string {
    const t = TEAMS[c.team];
    const bar = `
      <div class="cr-bar">
        ${crestSvg(t.crest, 40)}
        <div class="cr-title"><b>${t.name}</b><small>클럽 육성 · ${DIVISION_NAME[c.league.division]} · 시즌 ${c.league.season}</small></div>
        <div class="cr-stat"><small>예산</small><b>${money(c.money)}</b></div>
        <div class="cr-stat"><small>베스트 11</small><b>${squadRating(c)}</b></div>
        <div class="cr-stat"><small>선수단</small><b>${c.squad.length}명</b></div>
      </div>
      ${c.news.length ? `<ul class="cr-news">${c.news.map((n) => `<li>${n}</li>`).join('')}</ul>` : ''}
      ${seg('cr-tab', [['league', '리그'], ['squad', '선수단'], ['market', `이적 시장 (${c.market.length})`]], this.tab, '화면')}`;
    const body = this.tab === 'squad' ? this.squadHtml(c) : this.tab === 'market' ? this.marketHtml(c) : this.league.html();
    return `${bar}${body}`;
  }

  private rows(c: CareerState, list: CareerPlayer[], action: (p: CareerPlayer) => string, starters = new Set<CareerPlayer>()): string {
    return `
      <div class="lg-scroll">
        <table class="lg-table cr-table">
          <thead><tr><th class="x">#</th><th class="l">이름</th><th>위치</th><th>나이</th><th>종합</th><th>성장</th><th>가치</th><th></th></tr></thead>
          <tbody>
            ${list.map((p) => `
              <tr class="${starters.has(p) ? 'lg-me' : ''}">
                <td class="x">${p.number || '–'}</td>
                <td class="l">${p.name}</td>
                <td>${CAT_LABEL[p.cat]}</td><td>${p.age}</td><td><b>${playerOverall(p)}</b></td>
                <td>${growth(p)}</td>
                <td>${money(c.squad.includes(p) ? sellValue(p) : playerValue(p))}</td>
                <td>${action(p)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  private squadHtml(c: CareerState): string {
    const order = { GK: 0, DF: 1, MF: 2, FW: 3 };
    const list = [...c.squad].sort((a, b) => order[a.cat] - order[b.cat] || playerOverall(b) - playerOverall(a));
    const starters = new Set(pickLineup(c.squad, FORMATIONS[c.league.formation] ?? FORMATIONS['4-4-2']).starters as CareerPlayer[]);
    return `
      <p class="lg-key">노란 줄은 지금 포메이션(${c.league.formation})의 선발 11명입니다. 선발은 자동으로 가장 좋은 선수가 나섭니다.</p>
      ${this.rows(c, list, (p) => {
        const block = sellBlock(c, p);
        return `<button type="button" class="lg-ghost cr-btn" data-act="cr-sell" data-v="${p.id}" ${block ? `disabled title="${block}"` : ''}>방출</button>`;
      }, starters)}
      ${this.noteHtml()}`;
  }

  private marketHtml(c: CareerState): string {
    const list = [...c.market].sort((a, b) => playerOverall(b) - playerOverall(a));
    return `
      <p class="lg-key">이적 시장은 라운드마다 바뀝니다. 선수단은 최대 ${SQUAD_MAX}명입니다.</p>
      ${list.length ? this.rows(c, list, (p) => {
        const block = buyBlock(c, p);
        return `<button type="button" class="lg-ghost cr-btn" data-act="cr-buy" data-v="${p.id}" ${block ? `disabled title="${block}"` : ''}>영입</button>`;
      }) : '<p class="lg-line">지금은 나온 선수가 없습니다.</p>'}
      ${this.noteHtml()}`;
  }

  private noteHtml(): string {
    return `<p class="ed-note" role="status">${this.note}</p>`;
  }

  /** Whether a button keeps the player on the same screen (so the menu should not jump back to the top). */
  static staysPut(act: string): boolean {
    return ['cr-buy', 'cr-sell', 'cr-diff', 'cr-min', 'cr-assist', 'lg-tab', 'lg-form', 'lg-rprev', 'lg-rnext', 'lg-quit', 'lg-quit-no'].includes(act);
  }

  // ---------------------------------------------------------------- actions
  /** Handle a button; returns 'start' to kick off the next match or 'exit' to leave the mode. */
  act(act: string, v?: string): 'start' | 'exit' | void {
    const c = this.state, d = this.draft;
    this.note = '';
    if (act.startsWith('lg-')) {
      if (!c) return;
      const r = this.league.act(act, v);
      // A new season may bring news worth seeing first.
      if (act === 'lg-again') this.tab = 'league';
      return r;
    }
    switch (act) {
      case 'cr-exit': this.picking = false; return 'exit';
      case 'cr-pick': this.picking = true; break;
      case 'cr-pick-close': this.picking = false; break;
      case 'cr-team': d.team = Number(v); this.picking = false; break;
      case 'cr-diff': d.difficulty = v as Difficulty; break;
      case 'cr-min': d.minutes = Number(v); break;
      case 'cr-assist': d.assist = v === '1'; break;
      case 'cr-new':
        this.state = createCareer({
          team: d.team, legs: 1, seed: (Math.random() * 2 ** 31) | 0,
          minutes: d.minutes, difficulty: d.difficulty, offside: true, assist: d.assist,
        });
        saveCareer(this.state);
        this.league.reload();
        this.tab = 'league';
        break;
      case 'cr-tab': this.tab = v as Tab; break;
      case 'cr-buy':
        if (c) {
          const p = c.market.find((x) => x.id === Number(v));
          const block = p ? buyBlock(c, p) : '이미 팔린 선수입니다';
          if (p && buy(c, p.id)) { this.note = `${p.name} 영입 완료 (−${money(playerValue(p))})`; saveCareer(c); }
          else this.note = block ?? '';
        }
        break;
      case 'cr-sell':
        if (c) {
          const p = c.squad.find((x) => x.id === Number(v));
          const block = p ? sellBlock(c, p) : '';
          if (p && sell(c, p.id)) { this.note = `${p.name} 방출 (+${money(sellValue(p))})`; saveCareer(c); }
          else this.note = block ?? '';
        }
        break;
    }
  }
}
