import { DIVISION_NAME, overall, TEAMS, type TeamDef } from '../sim/team';
import { crestSvg } from './crest';

interface GridOptions {
  /** Club index shown as chosen. */
  selected?: number;
  /** Club index that cannot be picked (the other side in a quick match). */
  disabled?: number;
  /** Text for the right-hand column; default is the club's overall rating. */
  tag?: (t: TeamDef, index: number) => string;
  tagClass?: string;
}

/** Every club's badge as a button grid, one block per division. Buttons carry `data-act` and the club index. */
export function teamGrid(act: string, o: GridOptions = {}): string {
  const block = (d: 1 | 2) => `
    <div class="picker-div">${DIVISION_NAME[d]}</div>
    <div class="picker-grid">
      ${TEAMS.map((t, i) => (t.division !== d ? '' : `
        <button type="button" class="pick ${o.selected === i ? 'on' : ''}" data-act="${act}" data-v="${i}" ${i === o.disabled ? 'disabled' : ''}>
          ${crestSvg(t.crest, 40)}
          <span class="pk-name">${t.name}</span>
          <span class="${o.tagClass ?? 'pk-ovr'}">${o.tag ? o.tag(t, i) : overall(t)}</span>
        </button>`)).join('')}
    </div>`;
  return block(1) + block(2);
}
