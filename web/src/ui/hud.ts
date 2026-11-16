import type { Match, MatchEvent } from '../sim/match';
import { MAX_CHARGE } from '../sim/player';
import { crestSvg } from './crest';

const BANNERS: Partial<Record<MatchEvent, { text: string; cls: string; time: number }>> = {
  save: { text: '선방', cls: 'mid', time: 1.0 },
  post: { text: '골대!', cls: 'mid', time: 1.0 },
  tackle: { text: '태클 성공', cls: 'small', time: 0.8 },
  corner: { text: '코너킥', cls: 'small', time: 1.1 },
  goalkick: { text: '골킥', cls: 'small', time: 1.1 },
  throw: { text: '스로인', cls: 'small', time: 1.1 },
  kickoff: { text: '킥오프', cls: 'small', time: 1.0 },
  halftime: { text: '전반 종료', cls: 'mid', time: 2.4 },
  shootout: { text: '승부차기', cls: 'big', time: 2.4 },
  pen_goal: { text: '성공!', cls: 'mid', time: 1.5 },
  pen_saved: { text: '선방!', cls: 'mid warn', time: 1.5 },
  pen_missed: { text: '실축', cls: 'mid warn', time: 1.5 },
  extratime: { text: '연장전 · 먼저 넣으면 승리', cls: 'mid', time: 2.4 },
  foul: { text: '파울', cls: 'mid', time: 1.2 },
  penalty: { text: '페널티킥!', cls: 'big warn', time: 1.6 },
  offside: { text: '오프사이드', cls: 'mid', time: 1.3 },
  red: { text: '퇴장!', cls: 'mid warn', time: 1.6 },
};

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
/** Dark text on light kits, white text on dark kits. */
const ink = (c: number) => {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1d2330' : '#ffffff';
};

export class Hud {
  private el: HTMLElement;
  private q: (id: string) => HTMLElement;
  private bannerTime = 0;
  private noticeQueue: { text: string; cls: string }[] = [];
  private noticeTime = 0;
  onRestart: (() => void) | null = null;
  onMenu: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = `
      <div class="scoreboard">
        <span class="team home-tag" data-id="hname">홈</span>
        <b class="num" data-id="home">0</b>
        <span class="dash">:</span>
        <b class="num" data-id="away">0</b>
        <span class="team away-tag" data-id="aname">상대</span>
        <span class="clock" data-id="clock">0'</span>
      </div>
      <div class="pens" data-id="pens" hidden></div>
      <div class="stats" data-id="stats"></div>
      <div class="me" data-id="me">
        <span class="me-name" data-id="mename"></span>
        <span class="me-bar" title="체력"><span data-id="meen"></span></span>
      </div>
      <div class="notice" data-id="notice"></div>
      <div class="banner" data-id="banner"></div>
      <div class="banner-sub" data-id="bsub"></div>
      <div class="skip-hint" data-id="skip" hidden>아무 버튼이나 누르면 건너뜁니다</div>
      <div class="gauge" data-id="gauge"><div class="gauge-fill" data-id="fill"></div><span data-id="glabel"></span></div>
      <div class="help" data-id="help">
        <b data-id="helptitle">PITCHLINE</b>
        <div data-id="help1">
          <div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 이동 · <kbd>Shift</kbd> 달리기 · <kbd>Space</kbd> 선수 전환</div>
          <div class="row-title">공격</div>
          <div><kbd>J</kbd> 패스 · <kbd>L</kbd> 스루패스 · <kbd>I</kbd> 로빙 · <kbd>K</kbd> 슛 (길게)</div>
          <div class="row-title">수비</div>
          <div><kbd>J</kbd> 누르고 있기 = 압박 · <kbd>K</kbd> 태클</div>
        </div>
        <div data-id="help2" hidden>
          <div class="row-title">P1 (노랑)</div>
          <div><kbd>WASD</kbd> 이동 · <kbd>J</kbd> 패스/압박 · <kbd>K</kbd> 슛/태클 · <kbd>L</kbd> 스루 · <kbd>I</kbd> 로빙 · <kbd>L-Shift</kbd> 달리기 · <kbd>Space</kbd> 전환</div>
          <div class="row-title">P2 (하늘)</div>
          <div><kbd>방향키</kbd> 이동 · <kbd>,</kbd> 패스/압박 · <kbd>.</kbd> 슛/태클 · <kbd>/</kbd> 스루 · <kbd>;</kbd> 로빙 · <kbd>R-Shift</kbd> 달리기 · <kbd>'</kbd> 전환</div>
          <div class="muted">숫자패드: 1 패스 · 2 슛 · 3 스루 · 5 로빙 · 0 전환 · Enter 달리기</div>
        </div>
        <div class="muted"><kbd>Z</kbd> 카메라 · <kbd>C</kbd> 해설 · <kbd>M</kbd> 소리 · <kbd>H</kbd> 도움말 숨기기 · <kbd>Esc</kbd> 일시정지 · 게임패드 지원</div>
      </div>
      <div class="result" data-id="result" hidden>
        <div class="result-card">
          <div class="result-title">경기 종료</div>
          <div class="result-score" data-id="rscore"></div>
          <div class="result-line" data-id="rline"></div>
          <div class="result-stats" data-id="rstats"></div>
          <div class="result-actions">
            <button type="button" data-id="again">다시 하기</button>
            <button type="button" class="ghost" data-id="tomenu">메뉴</button>
          </div>
        </div>
      </div>
      <div class="rotate-hint">가로 화면으로 돌리면 더 넓게 보입니다</div>`;
    root.appendChild(this.el);
    this.q = (id: string) => this.el.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
    this.q('again').addEventListener('click', () => this.onRestart?.());
    this.q('tomenu').addEventListener('click', () => this.onMenu?.());
  }

  /** League and cup matches cannot be replayed, and the result screen leads back to the competition. */
  setCompetition(name: string | null): void {
    const on = name !== null;
    this.q('again').hidden = on;
    this.q('tomenu').textContent = on ? `${name} 돌아가기` : '메뉴';
    this.q('tomenu').classList.toggle('ghost', !on);
  }

  setVisible(on: boolean): void {
    this.el.hidden = !on;
  }

  toggleHelp(): void {
    const h = this.q('help');
    h.hidden = !h.hidden;
  }

  reset(m: Match): void {
    for (const [id, team] of [['hname', 'home'], ['aname', 'away']] as const) {
      const el = this.q(id);
      const c = m.kits[team].shirt;
      el.innerHTML = `${crestSvg(m.teams[team].crest, 16)}<span>${m.teams[team].short}</span>`;
      el.style.background = hex(c);
      el.style.color = ink(c);
    }
    const two = m.isHuman('home') && m.isHuman('away');
    this.q('help1').hidden = two;
    this.q('help2').hidden = !two;
    this.q('helptitle').textContent = two ? 'PITCHLINE · 2인 대전' : `PITCHLINE · ${m.teams.home.name} vs ${m.teams.away.name}`;
    this.q('result').hidden = true;
    this.bannerTime = 0;
    this.q('banner').className = 'banner';
    this.noticeQueue = [];
    this.noticeTime = 0;
    this.q('notice').className = 'notice';
  }

  update(m: Match, dt: number): void {
    const banner = this.q('banner');
    for (const ev of m.events) {
      if (ev === 'fulltime') this.showResult(m);
      const b = BANNERS[ev];
      if (!b) continue;
      banner.textContent = b.text;
      banner.className = `banner show ${b.cls}`;
      this.bannerTime = b.time;
    }
    m.events.length = 0;
    if (this.bannerTime > 0) {
      this.bannerTime -= dt;
      if (this.bannerTime <= 0) banner.className = 'banner';
    }
    this.q('skip').hidden = !(m.phase === 'goal' && m.humans.size > 0);

    // Cards and substitutions roll through a small ticker, one at a time.
    for (const n of m.notices) {
      const cls = n.text.startsWith('옐로') ? 'y' : n.text.startsWith('교체') ? 's' : n.text.startsWith('골') ? 'g' : 'r';
      const team = m.teams[n.team].short;
      this.noticeQueue.push({ text: `${team} · ${n.text}`, cls });
    }
    m.notices.length = 0;
    const notice = this.q('notice');
    if (this.noticeTime > 0) {
      this.noticeTime -= dt;
      if (this.noticeTime <= 0) notice.className = 'notice';
    } else if (this.noticeQueue.length) {
      const n = this.noticeQueue.shift()!;
      notice.innerHTML = `<i class="card ${n.cls}"></i>${n.text}`;
      notice.className = 'notice show';
      this.noticeTime = 3;
    }

    this.q('home').textContent = String(m.score.home);
    this.q('away').textContent = String(m.score.away);
    this.q('clock').textContent = `${m.extraTime ? '연장 ' : m.half === 2 ? '후반 ' : ''}${m.clockMinute}'`;
    this.q('stats').textContent = `슛 ${m.shots.home} : ${m.shots.away}`;
    // Shoot-out: each side's kicks as dots (scored / missed / still to come of the first five).
    const pens = this.q('pens');
    pens.hidden = !m.pens;
    if (m.pens) {
      const dots = (t: 'home' | 'away') => {
        const k = m.pens!.kicks[t];
        const n = Math.max(5, k.length + (m.pens!.turn === t ? 1 : 0));
        return Array.from({ length: n }, (_, i) => `<i class="${i < k.length ? (k[i] ? 'ok' : 'no') : ''}"></i>`).join('');
      };
      const key = `${m.pens.kicks.home.join()}|${m.pens.kicks.away.join()}|${m.pens.turn}`;
      if (pens.dataset.key !== key) {
        pens.dataset.key = key;
        pens.innerHTML = `<b>승부차기</b>
          <span class="${m.pens.turn === 'home' ? 'on' : ''}">${m.teams.home.short} ${dots('home')} <b>${m.shootout?.home ?? 0}</b></span>
          <span class="${m.pens.turn === 'away' ? 'on' : ''}">${m.teams.away.short} ${dots('away')} <b>${m.shootout?.away ?? 0}</b></span>
          ${m.isHuman(m.pens.turn) ? '<small>방향을 잡고 슛 버튼으로 찹니다</small>' : ''}`;
      }
    }

    // Who I control, and how much they have left in the tank.
    const me = m.controlled;
    const show = m.isHuman('home') && !me.sentOff;
    this.q('me').hidden = !show;
    if (show) {
      this.q('mename').textContent = `${me.number} ${me.name} · ${me.posLabel}`;
      const en = this.q('meen');
      en.style.width = `${Math.round(me.energy * 100)}%`;
      en.className = me.energy < 0.35 ? 'low' : me.energy < 0.6 ? 'mid' : '';
    }

    const c = m.controlled.charge;
    const gauge = this.q('gauge');
    if (c.kind) {
      const v = Math.min(1, c.t / MAX_CHARGE);
      gauge.classList.add('show');
      const fill = this.q('fill');
      fill.style.width = `${v * 100}%`;
      fill.classList.toggle('over', v > 0.85);
      this.q('glabel').textContent = c.kind === 'shoot' ? '슛 파워' : '로빙 거리';
    } else {
      gauge.classList.remove('show');
    }
  }

  private showResult(m: Match): void {
    const { home, away } = m.score;
    this.q('rscore').innerHTML = `${crestSvg(m.teams.home.crest, 34)}<span>${m.teams.home.short} ${home} : ${away} ${m.teams.away.short}</span>${crestSvg(m.teams.away.crest, 34)}`;
    const two = m.isHuman('home') && m.isHuman('away');
    const won = m.winner, pens = home === away ? m.shootout : null;
    this.q('rline').textContent = `${pens ? `승부차기 ${pens.home} : ${pens.away} · ` : m.extraTime && won ? '연장전 골든골 · ' : ''}${
      !won ? '무승부입니다.'
        : two ? `${won === 'home' ? 'P1' : 'P2'} 승리!`
        : won === 'home' ? '승리했습니다!' : '패배했습니다.'}`;
    const c = m.cards;
    this.q('rstats').textContent = `슛 ${m.shots.home} : ${m.shots.away} · 경고 ${c.home.yellow} : ${c.away.yellow} · 퇴장 ${c.home.red} : ${c.away.red}`;
    this.q('result').hidden = false;
  }
}
