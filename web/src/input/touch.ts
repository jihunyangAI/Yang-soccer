import type { Action, Input } from './input';

const JOY_RADIUS = 56;

/** Short haptic tick where supported (Android); silently ignored elsewhere. */
export function buzz(ms: number): void {
  try { navigator.vibrate?.(ms); } catch { /* not allowed */ }
}

/**
 * Button layouts.
 * 'thumb': the buttons sit on an arc round where the right thumb rests, biggest and nearest
 *   for what is used most, and sprinting is done by pushing the stick past its ring — so the
 *   right thumb never has to hold one button while pressing another.
 * 'classic': the original layout, with a separate sprint button.
 */
export type TouchLayout = 'thumb' | 'classic';
const LAYOUT_KEY = 'pitchline.touch.v1';
/** How far past the stick's ring (in ring radii) the thumb has to go to sprint. */
const SPRINT_PUSH = 1.3;

export interface TouchControls {
  /** Relabel buttons for attack (pass/shoot) or defence (press/tackle). */
  setMode(mode: 'attack' | 'defend'): void;
  readonly layout: TouchLayout;
  setLayout(layout: TouchLayout): void;
}

/**
 * On-screen controls for phones: a floating joystick on the left half,
 * action buttons on the right. Buttons report press and release so
 * shoot and lob can charge while held.
 */
export function mountTouchControls(root: HTMLElement, input: Input): TouchControls {
  const layer = document.createElement('div');
  layer.className = 'touch';
  layer.innerHTML = `
    <div class="joy-zone"><div class="joy-base"><div class="joy-knob"></div></div></div>
    <div class="buttons">
      <button class="btn btn-shoot" data-action="shoot">슛</button>
      <button class="btn btn-pass" data-action="pass">패스</button>
      <button class="btn btn-through" data-action="through">스루</button>
      <button class="btn btn-lob" data-action="lob">로빙</button>
      <button class="btn btn-sprint" data-action="sprint">달리기</button>
      <button class="btn btn-switch" data-action="switch">전환</button>
    </div>`;
  root.appendChild(layer);

  const zone = layer.querySelector<HTMLDivElement>('.joy-zone')!;
  const base = layer.querySelector<HTMLDivElement>('.joy-base')!;
  const knob = layer.querySelector<HTMLDivElement>('.joy-knob')!;
  let joyId: number | null = null;
  let ox = 0, oy = 0;
  let layout: TouchLayout = 'thumb';
  try { if (localStorage.getItem(LAYOUT_KEY) === 'classic') layout = 'classic'; } catch { /* storage blocked */ }
  layer.classList.add(layout);
  let joySprint = false;
  const setJoySprint = (on: boolean) => {
    if (on === joySprint) return;
    joySprint = on;
    base.classList.toggle('sprint', on);
    if (on) { input.touchPress('sprint'); buzz(8); } else input.touchRelease('sprint');
  };

  const show = () => document.body.classList.add('touch-mode');

  zone.addEventListener('pointerdown', (e) => {
    if (joyId !== null) return;
    show();
    joyId = e.pointerId;
    zone.setPointerCapture(e.pointerId);
    const r = zone.getBoundingClientRect();
    ox = e.clientX; oy = e.clientY;
    base.style.left = `${ox - r.left}px`;
    base.style.top = `${oy - r.top}px`;
    base.classList.add('active');
    knob.style.transform = 'translate(-50%, -50%)';
    e.preventDefault();
  });
  zone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== joyId) return;
    let dx = e.clientX - ox, dy = e.clientY - oy;
    const d = Math.hypot(dx, dy);
    // Thumb layout: dragging well past the ring is the sprint.
    setJoySprint(layout === 'thumb' && d > JOY_RADIUS * SPRINT_PUSH);
    if (d > JOY_RADIUS) { dx = (dx / d) * JOY_RADIUS; dy = (dy / d) * JOY_RADIUS; }
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    input.setTouchMove(dx / JOY_RADIUS, dy / JOY_RADIUS);
  });
  const endJoy = (e: PointerEvent) => {
    if (e.pointerId !== joyId) return;
    joyId = null;
    base.classList.remove('active');
    setJoySprint(false);
    input.setTouchMove(0, 0);
  };
  zone.addEventListener('pointerup', endJoy);
  zone.addEventListener('pointercancel', endJoy);

  for (const btn of layer.querySelectorAll<HTMLButtonElement>('.btn')) {
    const action = btn.dataset.action as Action;
    btn.addEventListener('pointerdown', (e) => {
      show();
      btn.setPointerCapture(e.pointerId);
      btn.classList.add('pressed');
      input.touchPress(action);
      buzz(10);
      e.preventDefault();
    });
    const up = () => {
      btn.classList.remove('pressed');
      input.touchRelease(action);
    };
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  window.addEventListener('touchstart', show, { once: true, passive: true });
  if (window.matchMedia('(pointer: coarse)').matches) show();

  // Size the buttons to the screen: small phones shrink, tablets grow.
  const fit = () => {
    const s = Math.max(0.78, Math.min(1.3, Math.min(window.innerWidth, window.innerHeight) / 400));
    layer.style.setProperty('--btn-scale', s.toFixed(2));
  };
  fit();
  window.addEventListener('resize', fit);

  const shootBtn = layer.querySelector<HTMLButtonElement>('.btn-shoot')!;
  const passBtn = layer.querySelector<HTMLButtonElement>('.btn-pass')!;
  let current: 'attack' | 'defend' = 'attack';
  return {
    get layout() { return layout; },
    setLayout(next) {
      setJoySprint(false);
      input.touchRelease('sprint');
      layer.classList.remove(layout);
      layout = next;
      layer.classList.add(layout);
      try { localStorage.setItem(LAYOUT_KEY, next); } catch { /* ignore */ }
    },
    setMode(mode) {
      if (mode === current) return;
      current = mode;
      shootBtn.textContent = mode === 'attack' ? '슛' : '태클';
      passBtn.textContent = mode === 'attack' ? '패스' : '압박';
      layer.classList.toggle('defend', mode === 'defend');
    },
  };
}
