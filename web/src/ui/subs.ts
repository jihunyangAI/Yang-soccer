import type { Team } from '../sim/ball';
import type { Match } from '../sim/match';
import { playerOverall } from '../sim/roster';

const CAT_LABEL = { GK: 'GK', DF: '수비', MF: '미드', FW: '공격' } as const;

/** Substitution screen: pick a player on the pitch, then one from the bench. */
export class SubsPanel {
  private el: HTMLElement;
  private match: Match | null = null;
  private team: Team = 'home';
  private outId = -1;
  private message = '';
  onClose: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'subs';
    this.el.hidden = true;
    root.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-s]');
      if (!t || !this.match) return;
      const act = t.dataset.s!;
      if (act === 'close') { this.hide(); this.onClose?.(); return; }
      if (act === 'team') { this.team = t.dataset.v as Team; this.outId = -1; this.message = ''; }
      if (act === 'out') { this.outId = Number(t.dataset.v); this.message = ''; }
      if (act === 'in' && this.outId >= 0) {
        const ok = this.match.requestSub(this.team, this.outId, Number(t.dataset.v));
        this.message = ok ? '교체를 예약했습니다. 다음에 경기가 멈출 때 들어갑니다.' : '이 교체는 할 수 없습니다. (골키퍼는 골키퍼끼리, 교체 횟수 확인)';
        if (ok) this.outId = -1;
      }
      this.render();
    });
  }

  show(m: Match): void {
    this.match = m;
    this.team = m.isHuman('home') ? 'home' : 'away';
    this.outId = -1;
    this.message = '';
    this.el.hidden = false;
    this.render();
  }

  hide(): void { this.el.hidden = true; }

  private render(): void {
    const m = this.match!;
    const sq = m.squads[this.team];
    const queuedOut = new Set(sq.queue.map((q) => q.outId));
    const queuedIn = new Set(sq.queue.map((q) => q.benchIdx));
    // The last (MAX - subsLeft) bench entries are players who already came off.
    const usedFrom = sq.bench.length - (3 - sq.subsLeft);
    const left = sq.subsLeft - sq.queue.length;
    const pct = (e: number) => Math.round(e * 100);
    const field = m.players.filter((p) => p.team === this.team);
    const out = field.find((p) => p.id === this.outId);
    const twoTeams = m.isHuman('home') && m.isHuman('away');

    this.el.innerHTML = `
      <div class="subs-card">
        <div class="subs-head">
          <b>선수 교체</b>
          ${twoTeams ? `<div class="seg"><button type="button" data-s="team" data-v="home" class="${this.team === 'home' ? 'on' : ''}">P1</button><button type="button" data-s="team" data-v="away" class="${this.team === 'away' ? 'on' : ''}">P2</button></div>` : ''}
          <span class="subs-left">남은 교체 ${left}회</span>
          <button type="button" class="subs-close" data-s="close">닫기</button>
        </div>
        <p class="subs-hint">${this.message || (out ? `${out.number} ${out.name} 대신 들어갈 선수를 고르세요.` : '나갈 선수를 먼저 고르세요. 체력이 낮은 선수는 느려지고 실수가 늘어납니다.')}</p>
        <div class="subs-cols">
          <div class="subs-col">
            <div class="col-title">경기 중</div>
            ${field.map((p) => `
              <button type="button" class="row ${p.id === this.outId ? 'sel' : ''}" data-s="out" data-v="${p.id}" ${p.sentOff || queuedOut.has(p.id) || left <= 0 ? 'disabled' : ''}>
                <span class="num">${p.number}</span>
                <span class="nm">${p.name}${p.yellow ? ' <i class="card y"></i>' : ''}${p.sentOff ? ' <i class="card r"></i>' : ''}${queuedOut.has(p.id) ? ' <em>교체 예정</em>' : ''}</span>
                <span class="pos">${p.posLabel}</span>
                <span class="en"><span style="width:${pct(p.energy)}%" class="${p.energy < 0.5 ? 'low' : ''}"></span></span>
              </button>`).join('')}
          </div>
          <div class="subs-col">
            <div class="col-title">벤치</div>
            ${sq.bench.map((r, i) => `
              <button type="button" class="row" data-s="in" data-v="${i}" ${i >= usedFrom || queuedIn.has(i) || !out ? 'disabled' : ''}>
                <span class="num">${r.number}</span>
                <span class="nm">${r.name}${i >= usedFrom ? ' <em>교체됨</em>' : queuedIn.has(i) ? ' <em>투입 예정</em>' : ''}</span>
                <span class="pos">${CAT_LABEL[r.cat]}</span>
                <span class="ovr">${playerOverall(r)}</span>
              </button>`).join('')}
          </div>
        </div>
      </div>`;
  }
}
