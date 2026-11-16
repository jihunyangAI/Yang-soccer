import { CREST_ICONS, CREST_PATTERNS, CREST_SHAPES, TEAMS, type Crest, type Kit } from './team';

/**
 * What the player has changed on their own device: club name, short name, badge (initials,
 * shape, picture, pattern, colours), kit colours and squad names. Only the differences from the built-in data are kept, keyed by club id and squad
 * index, so the built-in names can change without breaking a save. Nothing here is shared or
 * exported; it lives in this browser's storage only.
 */
export interface TeamCustom {
  name?: string;
  short?: string;
  initials?: string;
  /** Squad index (0–15, the order buildRoster returns) to name. */
  players?: Record<number, string>;
  /** Kit colours that differ from the built-in kit. */
  kit?: Partial<Record<KitPart, number>>;
  /** Badge parts that differ from the built-in badge; colours by position (field, pattern, trim). */
  crest?: Partial<Record<CrestPart, string>> & { colors?: Partial<Record<0 | 1 | 2, number>> };
}
export type KitPart = 'shirt' | 'sleeve' | 'shorts' | 'socks' | 'gk';
export type CrestPart = 'shape' | 'icon' | 'pattern';
export const KIT_PARTS: readonly KitPart[] = ['shirt', 'sleeve', 'shorts', 'socks', 'gk'];
const CREST_OPTIONS: Record<CrestPart, readonly string[]> = { shape: CREST_SHAPES, icon: CREST_ICONS, pattern: CREST_PATTERNS };
export type Custom = Record<string, TeamCustom>;
export type TeamField = 'name' | 'short' | 'initials';

export const NAME_LIMITS = { name: 20, short: 8, initials: 4, player: 18 } as const;
export const SQUAD_SIZE = 16;

/** Built-in values, captured before any override is applied. */
const DEFAULTS = new Map(TEAMS.map((t) => [t.id, {
  name: t.name, short: t.short, initials: t.crest.initials,
  kit: { ...t.kit } as Kit, crest: { ...t.crest, colors: [...t.crest.colors] } as Crest,
}]));
let custom: Custom = {};

/**
 * Names are placed into HTML and SVG by the screens, so markup characters are dropped here.
 * Returns '' for a name that is empty after cleaning.
 */
export function cleanName(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  const s = raw.replace(/[<>&"'`\\]/g, '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, max).join('').trim();
}

function apply(): void {
  for (const t of TEAMS) {
    const d = DEFAULTS.get(t.id)!, c = custom[t.id];
    t.name = c?.name ?? d.name;
    t.short = c?.short ?? d.short;
    t.kit = { ...d.kit, ...c?.kit };
    const cc = c?.crest;
    t.crest = {
      ...d.crest,
      shape: (cc?.shape ?? d.crest.shape) as Crest['shape'],
      icon: (cc?.icon ?? d.crest.icon) as Crest['icon'],
      pattern: (cc?.pattern ?? d.crest.pattern) as Crest['pattern'],
      colors: [0, 1, 2].map((i) => cc?.colors?.[i as 0 | 1 | 2] ?? d.crest.colors[i]) as [number, number, number],
      initials: c?.initials ?? d.initials,
    };
  }
}

const count = (o?: object) => Object.keys(o ?? {}).length;
const isEmpty = (c: TeamCustom) => !c.name && !c.short && !c.initials && !count(c.players) && !count(c.kit)
  && !count(c.crest?.colors) && !c.crest?.shape && !c.crest?.icon && !c.crest?.pattern;
const isColour = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffff;
/** The sleeve follows the shirt unless the kit gives it its own colour. */
const kitDefault = (kit: Kit, part: KitPart): number => (part === 'sleeve' ? kit.sleeve ?? kit.shirt : kit[part]);

/** Replace every override (bad or unknown entries are dropped) and apply it to TEAMS. */
export function setCustom(data: unknown): void {
  custom = {};
  if (data && typeof data === 'object') {
    for (const [id, raw] of Object.entries(data as Record<string, TeamCustom>)) {
      if (!DEFAULTS.has(id) || !raw || typeof raw !== 'object') continue;
      const c: TeamCustom = {};
      for (const f of ['name', 'short', 'initials'] as const) {
        const v = cleanName(raw[f], NAME_LIMITS[f]);
        if (v) c[f] = f === 'initials' ? v.toUpperCase() : v;
      }
      if (raw.players && typeof raw.players === 'object') {
        for (const [k, n] of Object.entries(raw.players)) {
          const i = Number(k), v = cleanName(n, NAME_LIMITS.player);
          if (Number.isInteger(i) && i >= 0 && i < SQUAD_SIZE && v) (c.players ??= {})[i] = v;
        }
      }
      const d = DEFAULTS.get(id)!;
      if (raw.kit && typeof raw.kit === 'object') {
        for (const part of KIT_PARTS) {
          const v = raw.kit[part];
          if (isColour(v) && (part === 'sleeve' ? v !== d.kit.sleeve : v !== d.kit[part])) (c.kit ??= {})[part] = v;
        }
      }
      if (raw.crest && typeof raw.crest === 'object') {
        for (const part of ['shape', 'icon', 'pattern'] as const) {
          const v = raw.crest[part];
          if (typeof v === 'string' && CREST_OPTIONS[part].includes(v) && v !== d.crest[part]) (c.crest ??= {})[part] = v;
        }
        for (const i of [0, 1, 2] as const) {
          const v = raw.crest.colors?.[i];
          if (isColour(v) && v !== d.crest.colors[i]) ((c.crest ??= {}).colors ??= {})[i] = v;
        }
      }
      if (!isEmpty(c)) custom[id] = c;
    }
  }
  apply();
}

/** Change one kit colour. The built-in colour removes the override. */
export function setKitColour(id: string, part: KitPart, value: number): void {
  const d = DEFAULTS.get(id);
  if (!d || !isColour(value) || !KIT_PARTS.includes(part)) return;
  const c = (custom[id] ??= {});
  // An untouched sleeve keeps following the shirt, so it only gets its own colour when it differs from the shirt in use.
  const same = part === 'sleeve' && d.kit.sleeve === undefined ? value === (c.kit?.shirt ?? d.kit.shirt) : value === kitDefault(d.kit, part);
  if (same) { if (c.kit) delete c.kit[part]; } else (c.kit ??= {})[part] = value;
  if (isEmpty(c)) delete custom[id];
  apply();
}

/** Change the badge's shape, picture or pattern. */
export function setCrestPart(id: string, part: CrestPart, value: string): void {
  const d = DEFAULTS.get(id);
  if (!d || !CREST_OPTIONS[part]?.includes(value)) return;
  const c = (custom[id] ??= {});
  if (value === d.crest[part]) { if (c.crest) delete c.crest[part]; } else (c.crest ??= {})[part] = value;
  if (isEmpty(c)) delete custom[id];
  apply();
}

/** Change one badge colour: 0 field, 1 pattern, 2 trim and picture. */
export function setCrestColour(id: string, index: 0 | 1 | 2, value: number): void {
  const d = DEFAULTS.get(id);
  if (!d || !isColour(value) || ![0, 1, 2].includes(index)) return;
  const c = (custom[id] ??= {});
  if (value === d.crest.colors[index]) { if (c.crest?.colors) delete c.crest.colors[index]; } else ((c.crest ??= {}).colors ??= {})[index] = value;
  if (isEmpty(c)) delete custom[id];
  apply();
}

/** Change one club text. An empty value, or the built-in one, removes the override. Returns the value now in use. */
export function setTeamText(id: string, field: TeamField, raw: string): string {
  const d = DEFAULTS.get(id);
  if (!d) return '';
  let v = cleanName(raw, NAME_LIMITS[field]);
  if (field === 'initials') v = v.toUpperCase();
  const c = (custom[id] ??= {});
  if (v && v !== d[field]) c[field] = v;
  else delete c[field];
  if (isEmpty(c)) delete custom[id];
  apply();
  return c[field] ?? d[field];
}

/** Change one squad name. `builtIn` is the generated name; an empty or equal value removes the override. */
export function setPlayerName(id: string, index: number, raw: string, builtIn: string): string {
  if (!DEFAULTS.has(id) || !Number.isInteger(index) || index < 0 || index >= SQUAD_SIZE) return builtIn;
  const v = cleanName(raw, NAME_LIMITS.player);
  const c = (custom[id] ??= {});
  if (v && v !== builtIn) (c.players ??= {})[index] = v;
  else if (c.players) delete c.players[index];
  if (isEmpty(c)) delete custom[id];
  return v || builtIn;
}

/** The player's own name for a squad member, if they set one. */
export const playerNameOverride = (id: string, index: number): string | undefined => custom[id]?.players?.[index];

/** Put one club, or every club when no id is given, back to the built-in names. */
export function resetCustom(id?: string): void {
  if (id) delete custom[id];
  else custom = {};
  apply();
}

export const isCustomised = (id: string): boolean => id in custom;
export const customCount = (): number => Object.keys(custom).length;
export const defaultTeamText = (id: string, field: TeamField): string => DEFAULTS.get(id)?.[field] ?? '';

// ---- saving ----
const KEY = 'pitchline.custom.v1';

export function loadCustom(): void {
  try {
    const raw = localStorage.getItem(KEY);
    setCustom(raw ? JSON.parse(raw) : null);
  } catch { setCustom(null); }
}

/** Returns false when the browser refused to store the names (they then last until the page closes). */
export function saveCustom(): boolean {
  try {
    if (customCount()) localStorage.setItem(KEY, JSON.stringify(custom));
    else localStorage.removeItem(KEY);
    return true;
  } catch { return false; }
}
