import type { Actions } from '../sim/player';

export type Action = 'pass' | 'shoot' | 'through' | 'lob' | 'sprint' | 'switch';
type Slot = 0 | 1;

interface KeyMap { up: string[]; down: string[]; left: string[]; right: string[]; actions: Record<string, Action> }

// One player: WASD or arrows. Two players: P1 = WASD side, P2 = arrows + numpad (or , . / ;).
const P1_KEYS: KeyMap = {
  up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
  actions: { KeyJ: 'pass', KeyK: 'shoot', KeyL: 'through', KeyI: 'lob', ShiftLeft: 'sprint', Space: 'switch' },
};
const P1_SOLO_EXTRA: KeyMap = {
  up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
  actions: { ShiftRight: 'sprint' },
};
const P2_KEYS: KeyMap = {
  up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
  actions: {
    Numpad1: 'pass', Numpad2: 'shoot', Numpad3: 'through', Numpad5: 'lob', Numpad0: 'switch', NumpadEnter: 'sprint',
    Comma: 'pass', Period: 'shoot', Slash: 'through', Semicolon: 'lob', ShiftRight: 'sprint', Quote: 'switch',
  },
};

// Standard gamepad mapping: A=0, B=1, X=2, Y=3, LB=4, RB=5, RT=7.
const PAD_ACTIONS: [number, Action][] = [
  [0, 'pass'], [1, 'shoot'], [3, 'through'], [2, 'lob'], [4, 'switch'], [5, 'sprint'], [7, 'sprint'],
];

class SlotState {
  keyHeld = new Set<Action>();
  touchHeld = new Set<Action>();
  padHeld = new Set<Action>();
  touchMove = { x: 0, z: 0 };
  padMove = { x: 0, z: 0 };
  down = new Set<Action>();
  up = new Set<Action>();

  press(set: Set<Action>, a: Action): void {
    if (!set.has(a)) { set.add(a); this.down.add(a); }
  }
  release(set: Set<Action>, a: Action): void {
    if (set.has(a)) { set.delete(a); this.up.add(a); }
  }
}

/**
 * Merges keyboard, gamepad and touch into one Actions snapshot per player per sim tick.
 * Button presses are latched as edges so a tap shorter than a frame still counts.
 * Screen axes map to the pitch: right = +x, up = -z (camera sits on the near sideline).
 */
export class Input {
  private keys = new Set<string>();
  private slots: [SlotState, SlotState] = [new SlotState(), new SlotState()];
  private twoPlayer = false;
  usingTouch = false;
  /** Fired for keys that are not game actions (e.g. help, camera). */
  onKey: ((code: string) => void) | null = null;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return; // typing a name in the editor
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Slash', 'Quote'].includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      const hit = this.actionFor(e.code);
      if (hit) this.slots[hit.slot].press(this.slots[hit.slot].keyHeld, hit.action);
      else this.onKey?.(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      const hit = this.actionFor(e.code);
      if (!hit) return;
      const stillHeld = [...this.keys].some((k) => {
        const h = this.actionFor(k);
        return h && h.slot === hit.slot && h.action === hit.action;
      });
      if (!stillHeld) this.slots[hit.slot].release(this.slots[hit.slot].keyHeld, hit.action);
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      for (const s of this.slots) for (const a of [...s.keyHeld]) s.release(s.keyHeld, a);
    });
  }

  setTwoPlayer(on: boolean): void { this.twoPlayer = on; }

  private maps(slot: Slot): KeyMap[] {
    if (slot === 1) return this.twoPlayer ? [P2_KEYS] : [];
    return this.twoPlayer ? [P1_KEYS] : [P1_KEYS, P1_SOLO_EXTRA];
  }

  private actionFor(code: string): { slot: Slot; action: Action } | null {
    for (const slot of [0, 1] as const) {
      for (const m of this.maps(slot)) {
        const a = m.actions[code];
        if (a) return { slot, action: a };
      }
    }
    return null;
  }

  // ---- touch API used by the on-screen controls (always player 1) ----
  setTouchMove(x: number, z: number): void {
    this.slots[0].touchMove.x = x; this.slots[0].touchMove.z = z;
  }
  touchPress(a: Action): void { this.usingTouch = true; this.slots[0].press(this.slots[0].touchHeld, a); }
  touchRelease(a: Action): void { this.slots[0].release(this.slots[0].touchHeld, a); }

  /** Read gamepads once per animation frame: pad 1 → player 1, pad 2 → player 2. */
  poll(): void {
    const pads = (navigator.getGamepads ? [...navigator.getGamepads()] : []).filter((p): p is Gamepad => !!p && p.connected);
    for (const slot of [0, 1] as const) {
      const s = this.slots[slot];
      const pad = slot === 1 && !this.twoPlayer ? undefined : pads[slot];
      if (!pad) {
        s.padMove.x = 0; s.padMove.z = 0;
        for (const a of [...s.padHeld]) s.release(s.padHeld, a);
        continue;
      }
      const dead = (v: number) => (Math.abs(v) < 0.2 ? 0 : v);
      s.padMove.x = dead(pad.axes[0] ?? 0);
      s.padMove.z = dead(pad.axes[1] ?? 0);
      const now = new Set<Action>();
      for (const [i, a] of PAD_ACTIONS) {
        const btn = pad.buttons[i];
        if (btn && (btn.pressed || btn.value > 0.3)) now.add(a);
      }
      for (const a of now) s.press(s.padHeld, a);
      for (const a of [...s.padHeld]) if (!now.has(a)) s.release(s.padHeld, a);
    }
  }

  /** Snapshot for one simulation tick; clears the latched edges. */
  consume(slot: Slot): Actions {
    const s = this.slots[slot];
    let mx = 0, mz = 0;
    for (const m of this.maps(slot)) {
      if (m.left.some((k) => this.keys.has(k))) mx -= 1;
      if (m.right.some((k) => this.keys.has(k))) mx += 1;
      if (m.up.some((k) => this.keys.has(k))) mz -= 1;
      if (m.down.some((k) => this.keys.has(k))) mz += 1;
    }
    mx = Math.max(-1, Math.min(1, mx)) + s.touchMove.x + s.padMove.x;
    mz = Math.max(-1, Math.min(1, mz)) + s.touchMove.z + s.padMove.z;
    const mag = Math.hypot(mx, mz);
    if (mag > 1) { mx /= mag; mz /= mag; }

    const held = new Set<Action>([...s.keyHeld, ...s.touchHeld, ...s.padHeld]);
    const result: Actions = { mx, mz, sprint: held.has('sprint'), held, down: new Set(s.down), up: new Set(s.up) };
    s.down.clear();
    s.up.clear();
    return result;
  }
}
