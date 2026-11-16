import {
  customCount, defaultTeamText, isCustomised, NAME_LIMITS, resetCustom, saveCustom,
  setCrestColour, setCrestPart, setKitColour, setPlayerName, setTeamText,
  type CrestPart, type KitPart, type TeamField,
} from '../sim/custom';
import { buildRoster } from '../sim/roster';
import {
  CREST_ICONS, CREST_PATTERNS, CREST_SHAPES, TEAMS,
  type Crest, type CrestIcon, type CrestPattern, type CrestShape, type Kit,
} from '../sim/team';
import { crestSvg } from './crest';
import { teamGrid } from './picker';

const CAT_LABEL = { GK: 'GK', DF: '수비', MF: '미드', FW: '공격' } as const;
const FIELD_LABEL: Record<TeamField, string> = { name: '팀 이름', short: '짧은 이름 (점수판)', initials: '엠블럼 글자' };
const KIT_LABEL: Record<KitPart, string> = { shirt: '상의', sleeve: '소매', shorts: '하의', socks: '양말', gk: '골키퍼' };
const SHAPE_LABEL: Record<CrestShape, string> = { shield: '방패', round: '원형', hex: '육각', pointed: '뾰족 방패' };
const PATTERN_LABEL: Record<CrestPattern, string> = { plain: '단색', stripes: '줄무늬', halves: '반반', chevron: '갈매기', sash: '사선', quarters: '사분할' };
const ICON_LABEL: Record<CrestIcon, string> = {
  star: '별', crown: '왕관', wave: '물결', tower: '탑', bolt: '번개', tree: '나무',
  sun: '태양', anchor: '닻', key: '열쇠', ball: '공', bird: '새', mountain: '산',
};
const CREST_COLOUR_LABEL = ['바탕', '무늬', '테두리·그림'];

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const kitColour = (k: Kit, part: KitPart): number => (part === 'sleeve' ? k.sleeve ?? k.shirt : k[part]);

/** The outfield kit seen from the front, with the keeper's shirt beside it. */
function kitSvg(k: Kit): string {
  const shirt = hex(k.shirt), sleeve = hex(k.sleeve ?? k.shirt), shorts = hex(k.shorts), socks = hex(k.socks), gk = hex(k.gk);
  const line = 'stroke="#0006" stroke-width="1.5" stroke-linejoin="round"';
  const top = (x: number, body: string, arm: string, s: number) => `
    <g transform="translate(${x} 0) scale(${s})">
      <polygon points="22,10 4,24 12,40 26,30" fill="${arm}" ${line}/>
      <polygon points="78,10 96,24 88,40 74,30" fill="${arm}" ${line}/>
      <path d="M22 10 L40 6 Q50 14 60 6 L78 10 L74 30 V70 H26 V30 Z" fill="${body}" ${line}/>
    </g>`;
  return `<svg width="150" height="132" viewBox="0 0 170 150" role="img" aria-label="유니폼 미리보기">
    ${top(0, shirt, sleeve, 1)}
    <path d="M26 72 H74 L78 104 H54 L50 88 L46 104 H22 Z" fill="${shorts}" ${line}/>
    <rect x="27" y="112" width="15" height="32" rx="3" fill="${socks}" ${line}/>
    <rect x="58" y="112" width="15" height="32" rx="3" fill="${socks}" ${line}/>
    ${top(108, gk, gk, 0.6)}
    <text x="138" y="60" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">골키퍼</text>
  </svg>`;
}

/**
 * Team editor, drawn inside the menu card: a club list, then one club's names, badge, kit and
 * squad. A text field is saved when it loses focus or Enter is pressed (clearing it restores the
 * built-in name); colours and badge parts are saved as they are picked.
 */
export class EditorScreen {
  /** Club being edited, or null for the club list. */
  private team: number | null = null;
  private confirm: 'team' | 'all' | null = null;
  private note = '';

  /** Short label for the main menu button. */
  get summary(): string {
    const n = customCount();
    return n ? `${n}개 팀 수정됨` : '이름·유니폼·엠블럼 바꾸기';
  }

  html(): string {
    return this.team === null ? this.listHtml() : this.teamHtml(this.team);
  }

  private listHtml(): string {
    const n = customCount();
    return `
      <div class="lg-head">
        <div><h2>팀 에디터</h2><span class="menu-sub">바꾼 내용은 이 기기에만 저장됩니다</span></div>
        <button type="button" class="lg-ghost" data-act="ed-exit">메인 메뉴</button>
      </div>
      ${teamGrid('ed-team', { tag: (t) => (isCustomised(t.id) ? '수정됨' : ''), tagClass: 'ed-tag' })}
      ${n ? `<div class="lg-actions">${this.confirm === 'all'
        ? `<span class="ed-ask">${n}개 팀을 모두 기본값으로 되돌릴까요?</span>
           <button type="button" class="lg-ghost danger" data-act="ed-reset-all-yes">되돌리기</button>
           <button type="button" class="lg-ghost" data-act="ed-cancel">취소</button>`
        : '<button type="button" class="lg-ghost" data-act="ed-reset-all">전체 기본값으로</button>'}</div>` : ''}
      ${this.noteHtml()}`;
  }

  private teamHtml(index: number): string {
    const t = TEAMS[index];
    const squad = buildRoster(t), builtIn = buildRoster(t, true);
    const field = (f: TeamField) => `
      <label class="ed-field"><span>${FIELD_LABEL[f]}</span>
        <input type="text" data-ed="${f}" value="${f === 'initials' ? t.crest.initials : t[f]}"
          maxlength="${NAME_LIMITS[f]}" placeholder="${defaultTeamText(t.id, f)}" autocomplete="off" spellcheck="false" enterkeyhint="done">
      </label>`;
    const colour = (key: string, label: string, value: number) => `
      <label class="ed-colour"><input type="color" data-edc="${key}" value="${hex(value)}"><span>${label}</span></label>`;
    const options = <T extends string>(part: CrestPart, list: readonly T[], labels: Record<T, string>, cur: T) => `
      <div class="seg" role="group">
        ${list.map((v) => `<button type="button" data-act="ed-${part}" data-v="${v}" class="${cur === v ? 'on' : ''}">${labels[v]}</button>`).join('')}
      </div>`;
    // The pictures are shown on a plain badge in the club's own colours.
    const sample = (icon: CrestIcon): Crest => ({ ...t.crest, shape: 'round', pattern: 'plain', icon, initials: '' });
    return `
      <div class="lg-head">
        <div><h2>팀 에디터</h2><span class="menu-sub">이름 칸을 비우면 기본 이름으로 돌아갑니다</span></div>
        <button type="button" class="lg-ghost" data-act="ed-back">팀 목록</button>
      </div>
      <div class="ed-team">
        <div class="ed-crest">${crestSvg(t.crest, 64)}</div>
        <div class="ed-fields">${field('name')}${field('short')}${field('initials')}</div>
      </div>
      <div class="ed-card">
        <div class="card-label">엠블럼</div>
        <div class="opt"><span>모양</span>${options('shape', CREST_SHAPES, SHAPE_LABEL, t.crest.shape)}</div>
        <div class="opt"><span>무늬</span>${options('pattern', CREST_PATTERNS, PATTERN_LABEL, t.crest.pattern)}</div>
        <div class="ed-icons" role="group" aria-label="그림">
          ${CREST_ICONS.map((v) => `<button type="button" class="ed-icon ${t.crest.icon === v ? 'on' : ''}" data-act="ed-icon" data-v="${v}" aria-label="${ICON_LABEL[v]}" title="${ICON_LABEL[v]}">${crestSvg(sample(v), 30)}</button>`).join('')}
        </div>
        <div class="ed-colours">${t.crest.colors.map((c, i) => colour(`crest:${i}`, CREST_COLOUR_LABEL[i], c)).join('')}</div>
      </div>
      <div class="ed-card">
        <div class="card-label">유니폼</div>
        <div class="ed-kitrow">
          <div class="ed-kit">${kitSvg(t.kit)}</div>
          <div class="ed-colours">${(['shirt', 'sleeve', 'shorts', 'socks', 'gk'] as const).map((p) => colour(`kit:${p}`, KIT_LABEL[p], kitColour(t.kit, p))).join('')}</div>
        </div>
        <p class="assist-note">상대 팀과 상의 색이 비슷하면 원정 경기에서는 자동으로 흰색이나 어두운색 유니폼을 입습니다.</p>
      </div>
      <div class="card-label">선수 이름</div>
      <div class="ed-squad">
        ${squad.map((p, i) => `
          <label class="ed-row">
            <span class="ed-num">${p.number}</span><span class="ed-cat">${CAT_LABEL[p.cat]}</span>
            <input type="text" data-ed="player" data-i="${i}" value="${p.name}" maxlength="${NAME_LIMITS.player}"
              placeholder="${builtIn[i].name}" aria-label="${p.number}번 선수 이름" autocomplete="off" spellcheck="false" enterkeyhint="done">
          </label>`).join('')}
      </div>
      <div class="lg-actions">${this.confirm === 'team'
        ? `<span class="ed-ask">이 팀의 이름·유니폼·엠블럼을 모두 기본값으로 되돌릴까요?</span>
           <button type="button" class="lg-ghost danger" data-act="ed-reset-team-yes">되돌리기</button>
           <button type="button" class="lg-ghost" data-act="ed-cancel">취소</button>`
        : `<button type="button" class="lg-ghost" data-act="ed-reset-team" ${isCustomised(t.id) ? '' : 'hidden'}>이 팀 기본값으로</button>`}</div>
      ${this.noteHtml()}`;
  }

  private noteHtml(): string {
    return `<p class="ed-note" role="status">${this.note}</p>`;
  }

  /** Whether a button keeps the player on the same screen (so the menu should not jump back to the top). */
  static staysPut(act: string): boolean {
    return !['ed-exit', 'ed-team', 'ed-back'].includes(act);
  }

  /** Button presses. Returns 'exit' to go back to the main menu; the menu redraws afterwards. */
  act(act: string, v?: string): 'exit' | void {
    const was = this.confirm;
    this.confirm = null;
    this.note = '';
    const t = this.team === null ? null : TEAMS[this.team];
    switch (act) {
      case 'ed-exit': this.team = null; return 'exit';
      case 'ed-team': this.team = Number(v); break;
      case 'ed-back': this.team = null; break;
      case 'ed-shape':
      case 'ed-icon':
      case 'ed-pattern':
        if (t && v) { setCrestPart(t.id, act.slice(3) as CrestPart, v); this.saved('저장했습니다.'); }
        break;
      case 'ed-reset-team': this.confirm = 'team'; break;
      case 'ed-reset-all': this.confirm = 'all'; break;
      case 'ed-reset-team-yes':
        if (was === 'team' && t) { resetCustom(t.id); this.saved('기본값으로 되돌렸습니다.'); }
        break;
      case 'ed-reset-all-yes':
        if (was === 'all') { resetCustom(); this.saved('모든 팀을 기본값으로 되돌렸습니다.'); }
        break;
    }
  }

  private saved(text: string): void {
    this.note = saveCustom() ? text : '이 브라우저에서는 저장할 수 없어, 페이지를 닫으면 기본값으로 돌아갑니다.';
  }

  /** Bring the parts of the card that show the club up to date without redrawing it. */
  private refresh(card: HTMLElement): void {
    if (this.team === null) return;
    const t = TEAMS[this.team];
    card.querySelector('.ed-crest')!.innerHTML = crestSvg(t.crest, 64);
    card.querySelector('.ed-kit')!.innerHTML = kitSvg(t.kit);
    card.querySelector('.ed-note')!.textContent = this.note;
    const reset = card.querySelector<HTMLElement>('[data-act="ed-reset-team"]');
    if (reset) reset.hidden = !isCustomised(t.id);
  }

  /**
   * A text field was committed. The card is not redrawn (that would drop the focus the player
   * just moved to another field), so the affected parts are updated in place.
   */
  change(input: HTMLInputElement, card: HTMLElement): void {
    if (this.team === null) return;
    const t = TEAMS[this.team], kind = input.dataset.ed!;
    if (kind === 'player') {
      const i = Number(input.dataset.i);
      input.value = setPlayerName(t.id, i, input.value, buildRoster(t, true)[i].name);
    } else {
      input.value = setTeamText(t.id, kind as TeamField, input.value);
    }
    this.saved('저장했습니다.');
    this.refresh(card);
  }

  /**
   * A colour is being picked: the previews follow while the picker is open, and the choice is
   * saved once it is made (`commit`).
   */
  colour(input: HTMLInputElement, card: HTMLElement, commit: boolean): void {
    if (this.team === null) return;
    const t = TEAMS[this.team];
    const [group, key] = input.dataset.edc!.split(':');
    const value = parseInt(input.value.slice(1), 16);
    if (!Number.isFinite(value)) return;
    if (group === 'kit') {
      setKitColour(t.id, key as KitPart, value);
      // A sleeve without a colour of its own follows the shirt.
      const sleeve = card.querySelector<HTMLInputElement>('input[data-edc="kit:sleeve"]');
      if (sleeve && sleeve !== input) sleeve.value = hex(kitColour(t.kit, 'sleeve'));
    } else {
      setCrestColour(t.id, Number(key) as 0 | 1 | 2, value);
    }
    if (commit) this.saved('저장했습니다.');
    this.refresh(card);
  }
}
