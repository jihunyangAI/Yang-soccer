import {
  afterRound, afterSeason, autoLineup, buy, buyBlock, careerClub, createCareer, drill, drillBlock, drillCost, drillStat,
  FOCUS_NAME, lineup, loadCareer, matchSquad, playerValue, renew, renewBlock, renewCost, saveCareer, sell, sellBlock,
  sellValue, squadRating, SQUAD_MAX, statName, swap, swapBlock, wageBill, type CareerPlayer, type CareerState, type Focus,
} from '../sim/career';
import { isOver } from '../sim/league';
import type { Difficulty, MatchConfig } from '../sim/match';
import { playerOverall } from '../sim/roster';
import { DIVISION_NAME, divisionClubs, FORMATIONS, overall, TEAMS } from '../sim/team';
import { crestSvg } from './crest';
import { LeagueScreen } from './league';
import { teamGrid } from './picker';

const DIFF: Record<Difficulty, string> = { easy: '쉬움', normal: '보통', hard: '어려움' };
const CAT_LABEL = { GK: 'GK', DF: '수비', MF: '미드', FW: '공격' } as const;
type Tab = 'league' | 'squad' | 'train' | 'market';

const seg = (act: string, items: [string, string][], cur: string, label: string) => `
  <div class="seg" role="group" aria-label="${label}">
    ${items.map(([v, text]) => `<button type="button" data-act="${act}" data-v="${v}" class="${cur === v ? 'on' : ''}">${text}</button>`).join('')}
  </div>`;
const money = (v: number) => `${Number.isInteger(v) ? v : Number(v.toFixed(2))}억`;
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
  /** Squad screen: the player chosen to change places with another. */
  private moving: number | null = null;
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
        <div class="cr-stat"><small>주급 합계</small><b>${money(wageBill(c))}</b></div>
        <div class="cr-stat"><small>선수단</small><b>${c.squad.length}명</b></div>
      </div>
      ${c.news.length ? `<ul class="cr-news">${c.news.map((n) => `<li>${n}</li>`).join('')}</ul>` : ''}
      ${seg('cr-tab', [['league', '리그'], ['squad', '선수단'], ['train', '훈련'], ['market', `이적 시장 (${c.market.length})`]], this.tab, '화면')}`;
    const body = this.tab === 'squad' ? this.squadHtml(c) : this.tab === 'train' ? this.trainHtml(c)
      : this.tab === 'market' ? this.marketHtml(c) : this.league.html();
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
    const formation = FORMATIONS[c.league.formation] ?? FORMATIONS['4-4-2'];
    const { starters, bench } = lineup(c);
    const rest = [...bench].sort((a, b) => order[a.cat] - order[b.cat] || playerOverall(b) - playerOverall(a));
    const moving = c.squad.find((p) => p.id === this.moving) ?? null;
    const row = (p: CareerPlayer, slot: string | null) => {
      const sellNo = sellBlock(c, p), renewNo = renewBlock(c, p);
      let move: string;
      if (!moving) move = `<button type="button" class="lg-ghost cr-btn" data-act="cr-move" data-v="${p.id}">교체</button>`;
      else if (moving === p) move = `<button type="button" class="lg-ghost cr-btn cr-on" data-act="cr-move" data-v="${p.id}">취소</button>`;
      else {
        const no = swapBlock(c, moving.id, p.id);
        move = `<button type="button" class="lg-ghost cr-btn cr-go" data-act="cr-swap" data-v="${p.id}" ${no ? `disabled title="${no}"` : ''}>여기로</button>`;
      }
      const last = p.contract <= 1;
      return `
        <tr class="${slot ? 'lg-me' : ''} ${moving === p ? 'cr-moving' : ''}">
          <td class="x">${p.number || '–'}</td>
          <td class="l">${p.name}</td>
          <td>${slot ? `<b>${slot}</b>` : `<span class="cr-dim">후보</span>`} <small class="cr-dim">${CAT_LABEL[p.cat]}</small></td>
          <td>${p.age}</td><td><b>${playerOverall(p)}</b></td><td>${growth(p)}</td>
          <td class="${last ? 'cr-warn' : ''}">${p.contract}년<small class="cr-dim"> · ${money(p.wage)}</small></td>
          <td class="cr-acts">
            ${move}
            <button type="button" class="lg-ghost cr-btn" data-act="cr-renew" data-v="${p.id}" ${renewNo ? `disabled title="${renewNo}"` : `title="2년 연장 · ${money(renewCost(p))}"`}>재계약 ${money(renewCost(p))}</button>
            <button type="button" class="lg-ghost cr-btn" data-act="cr-sell" data-v="${p.id}" ${sellNo ? `disabled title="${sellNo}"` : ''}>방출</button>
          </td>
        </tr>`;
    };
    return `
      <p class="lg-key">노란 줄이 선발 11명(${c.league.formation})입니다. <b>교체</b>를 누른 뒤 바꿀 선수의 <b>여기로</b>를 누르면 두 선수의 자리가 바뀝니다. 계약이 1년 남은 선수는 시즌이 끝나면 떠나므로 그 전에 재계약하세요(2년 연장).</p>
      <div class="cr-tools">
        <button type="button" class="lg-ghost cr-btn" data-act="cr-auto">자동 선발 (가장 좋은 11명)</button>
        <span class="cr-dim">${c.lineup ? '직접 고른 선발' : '자동 선발 중'}${moving ? ` · ${moving.name} 선택됨` : ''}</span>
      </div>
      <div class="lg-scroll">
        <table class="lg-table cr-table">
          <thead><tr><th class="x">#</th><th class="l">이름</th><th>자리</th><th>나이</th><th>종합</th><th>성장</th><th>계약 · 주급</th><th></th></tr></thead>
          <tbody>
            ${starters.map((p, i) => row(p, formation[i].pos)).join('')}
            ${rest.map((p) => row(p, null)).join('')}
          </tbody>
        </table>
      </div>
      ${this.noteHtml()}`;
  }

  private trainHtml(c: CareerState): string {
    const order = { GK: 0, DF: 1, MF: 2, FW: 3 };
    const list = [...c.squad].sort((a, b) => order[a.cat] - order[b.cat] || playerOverall(b) - playerOverall(a));
    const focus = c.focus ?? 'balance';
    return `
      <div class="options">
        <div class="opt"><span>팀 훈련</span>${seg('cr-focus', (Object.keys(FOCUS_NAME) as Focus[]).map((k) => [k, FOCUS_NAME[k]]), focus, '팀 훈련')}</div>
      </div>
      <p class="lg-key">팀 훈련으로 고른 능력은 경기 뒤 더 빨리 오르고, 나머지는 조금 느려집니다(균형은 고르게). <b>개인 훈련</b>은 돈을 내고 한 선수의 능력을 바로 1 올리며, 라운드마다 한 번만 할 수 있습니다.</p>
      <div class="lg-scroll">
        <table class="lg-table cr-table">
          <thead><tr><th class="l">이름</th><th>위치</th><th>나이</th><th>속도</th><th>드리블</th><th>패스</th><th>슛</th><th>수비</th><th>종합</th><th>성장</th><th></th></tr></thead>
          <tbody>
            ${list.map((p) => {
              const no = drillBlock(c, p);
              const st = p.stats;
              const cell = (k: Focus, v: number) => `<td class="${k === focus ? 'cr-hi' : ''}">${v}</td>`;
              return `
                <tr>
                  <td class="l">${p.name}</td><td>${CAT_LABEL[p.cat]}</td><td>${p.age}</td>
                  ${cell('speed', st.speed)}${cell('dribble', st.dribble)}${cell('pass', st.pass)}${cell('shoot', st.shoot)}${cell('defense', st.defense)}
                  <td><b>${playerOverall(p)}</b></td><td>${growth(p)}</td>
                  <td><button type="button" class="lg-ghost cr-btn" data-act="cr-drill" data-v="${p.id}" ${no ? `disabled title="${no}"` : ''}>${statName(drillStat(c, p))} +1 · ${money(drillCost(p))}</button></td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
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
    return ['cr-buy', 'cr-sell', 'cr-move', 'cr-swap', 'cr-auto', 'cr-renew', 'cr-focus', 'cr-drill', 'cr-diff', 'cr-min', 'cr-assist', 'lg-tab', 'lg-form', 'lg-rprev', 'lg-rnext', 'lg-quit', 'lg-quit-no'].includes(act);
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
      case 'cr-tab': this.tab = v as Tab; this.moving = null; break;
      case 'cr-move': this.moving = this.moving === Number(v) ? null : Number(v); break;
      case 'cr-swap':
        if (c && this.moving !== null) {
          const no = swapBlock(c, this.moving, Number(v));
          if (!no && swap(c, this.moving, Number(v))) { this.note = '선발 명단을 바꿨습니다'; saveCareer(c); }
          else this.note = no ?? '';
          this.moving = null;
        }
        break;
      case 'cr-auto': if (c) { autoLineup(c); this.moving = null; this.note = '가장 좋은 11명으로 되돌렸습니다'; saveCareer(c); } break;
      case 'cr-renew':
        if (c) {
          const p = c.squad.find((x) => x.id === Number(v));
          const no = p ? renewBlock(c, p) : '';
          const cost = p ? renewCost(p) : 0;
          if (p && renew(c, p.id)) { this.note = `${p.name} 재계약 · ${p.contract}년 (−${money(cost)})`; saveCareer(c); }
          else this.note = no ?? '';
        }
        break;
      case 'cr-focus': if (c) { c.focus = v as Focus; saveCareer(c); } break;
      case 'cr-drill':
        if (c) {
          const p = c.squad.find((x) => x.id === Number(v));
          const no = p ? drillBlock(c, p) : '';
          const cost = p ? drillCost(p) : 0;
          const got = p ? drill(c, p.id) : null;
          if (got) { this.note = `개인 훈련: ${got} (−${money(cost)})`; saveCareer(c); }
          else this.note = no ?? '';
        }
        break;
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
