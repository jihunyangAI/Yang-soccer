import './style.css';
import { Input } from './input/input';
import { buzz, mountTouchControls } from './input/touch';
import { GameView } from './render/scene';
import { DT } from './sim/constants';
import { Match, type MatchConfig, type TeamActions } from './sim/match';
import { loadCustom } from './sim/custom';
import { TEAMS } from './sim/team';
import { showCrash } from './ui/about';
import { Hud } from './ui/hud';
import { Menu, type Competition } from './ui/menu';
import { SubsPanel } from './ui/subs';
import { Commentary } from './audio/commentary';
import { Sound } from './audio/sound';
import { GoalFx } from './ui/goalfx';

const root = document.getElementById('app')!;
const newSeed = () => (Math.random() * 2 ** 31) | 0;
const isTouch = () => document.body.classList.contains('touch-mode');

loadCustom(); // the player's own team and squad names, before anything draws them
const view = new GameView(root);
const hud = new Hud(root);
const input = new Input();
const touch = mountTouchControls(root, input);
const menu = new Menu(root, () => !isTouch());

/** AI-vs-AI match that plays behind the menu. */
const demo = () => {
  const a = (Math.random() * TEAMS.length) | 0;
  const b = (a + 1 + ((Math.random() * (TEAMS.length - 1)) | 0)) % TEAMS.length;
  return new Match({
    home: TEAMS[a], away: TEAMS[b], homeFormation: TEAMS[a].formation, awayFormation: TEAMS[b].formation,
    seconds: 600, humans: [], assist: [], difficulty: 'normal', seed: newSeed(),
  });
};

let match = demo();
let lastConfig: Omit<MatchConfig, 'seed'> | null = null;
/** The competition the current match counts toward; its result is recorded at full time. */
let live: Competition | null = null;
/** "Back to …" for each competition. */
const COMP_BACK: Record<Competition, string> = { league: '리그로', cup: '컵 대회로', career: '클럽 육성으로' };
view.snapCamera(match);
hud.setVisible(false);
document.body.classList.add('in-menu');

// ---- pause ----
let paused = false;
const pauseEl = document.createElement('div');
pauseEl.className = 'pause';
pauseEl.hidden = true;
pauseEl.innerHTML = `<div class="pause-card">
  <div class="title">일시정지</div>
  <button type="button" class="primary" data-p="resume">계속하기</button>
  <button type="button" data-p="subs">선수 교체</button>
  <button type="button" data-p="restart">처음부터</button>
  <button type="button" data-p="menu">메뉴로</button>
</div>`;
root.appendChild(pauseEl);
const subs = new SubsPanel(root);
subs.onClose = () => { pauseEl.hidden = false; };
function setPaused(on: boolean): void {
  if (menu.visible || match.phase === 'fulltime') on = false;
  paused = on;
  pauseEl.hidden = !on;
  if (!on) subs.hide();
  sound?.setSuspended(on);
  if (on) talk?.hush();
}
pauseEl.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-p]')?.dataset.p;
  if (act === 'resume') setPaused(false);
  if (act === 'subs') { pauseEl.hidden = true; subs.show(match); }
  if (act === 'restart' && lastConfig) { setPaused(false); startMatch(lastConfig); }
  if (act === 'menu') { setPaused(false); toMenu(); }
});

function startMatch(c: Omit<MatchConfig, 'seed'>, comp: Competition | null = null): void {
  lastConfig = c;
  live = comp;
  hud.setCompetition(comp && COMP_BACK[comp]);
  pauseEl.querySelector<HTMLElement>('[data-p="restart"]')!.hidden = comp !== null;
  pauseEl.querySelector<HTMLElement>('[data-p="menu"]')!.textContent = comp ? `${COMP_BACK[comp]} (이 경기는 무효)` : '메뉴로';
  input.setTwoPlayer(c.humans.length === 2);
  match = new Match({ ...c, seed: newSeed() });
  view.snapCamera(match);
  hud.reset(match);
  hud.setVisible(true);
  menu.hide();
  document.body.classList.remove('in-menu');
}

function toMenu(): void {
  live = null;
  match = demo();
  view.snapCamera(match);
  hud.setVisible(false);
  menu.show();
  document.body.classList.add('in-menu');
}

menu.onStart = startMatch;
hud.onRestart = () => { if (lastConfig && !live) startMatch(lastConfig); };
hud.onMenu = toMenu;

const ZOOMS = [1, 0.75, 1.3];
let zoomIdx = 0;
const cycleZoom = () => { zoomIdx = (zoomIdx + 1) % ZOOMS.length; view.zoom = ZOOMS[zoomIdx]; };
const sound = new Sound();
const talk = new Commentary(root, () => sound.output());
talk.voiceOn = sound.enabled;
// A browser with no speech at all (some in-app browsers) still gets the captions.
const talkLabel = () => (talk.enabled ? '해설 켬' : '해설 끔');
const toggleTalk = () => {
  talk.setEnabled(!talk.enabled);
  talkBtn.textContent = talkLabel();
  talkBtn.setAttribute('aria-pressed', String(talk.enabled));
};
const goalFx = new GoalFx(root);
const toggleSound = () => {
  sound.setEnabled(!sound.enabled);
  talk.voiceOn = sound.enabled; // the voice goes quiet with the rest of the sound; captions stay
  if (!sound.enabled) talk.hush();
  soundBtn.textContent = sound.enabled ? '소리 켬' : '소리 끔';
  soundBtn.setAttribute('aria-pressed', String(sound.enabled));
};
input.onKey = (code) => {
  if (code === 'KeyH') hud.toggleHelp();
  if (code === 'KeyZ') cycleZoom();
  if (code === 'KeyM') toggleSound();
  if (code === 'KeyC') toggleTalk();
  if ((code === 'Escape' || code === 'KeyP') && !menu.visible) setPaused(!paused);
};

const toggleFullscreen = () => {
  const d = document;
  const p = d.fullscreenElement ? d.exitFullscreen() : d.documentElement.requestFullscreen({ navigationUI: 'hide' });
  // Some hosts and iOS Safari refuse fullscreen; the game still works without it.
  p?.catch?.(() => { fsBtn.hidden = true; });
};
const tools = document.createElement('div');
tools.className = 'tools';
tools.innerHTML = `
  <button type="button" id="btn-sound" aria-pressed="${sound.enabled}">${sound.enabled ? '소리 켬' : '소리 끔'}</button>
  <button type="button" id="btn-talk" aria-pressed="${talk.enabled}">${talkLabel()}</button>
  <button type="button" id="btn-zoom">카메라</button>
  <button type="button" id="btn-fs">전체화면</button>
  <button type="button" id="btn-pause">일시정지</button>`;
root.appendChild(tools);
const fsBtn = document.getElementById('btn-fs')!;
const soundBtn = document.getElementById('btn-sound')!;
const talkBtn = document.getElementById('btn-talk')!;
fsBtn.hidden = !document.fullscreenEnabled;
for (const [id, fn] of [['btn-sound', toggleSound], ['btn-talk', toggleTalk], ['btn-zoom', cycleZoom], ['btn-fs', toggleFullscreen], ['btn-pause', () => setPaused(true)]] as const) {
  const b = document.getElementById(id)!;
  b.addEventListener('click', () => { fn(); b.blur(); });
}

// Fixed-step simulation, render every animation frame.
let goalLive = false;
let last = performance.now();
let acc = 0;
function frame(now: number): void {
  // An error in a frame stops the game with a message rather than a frozen or flickering picture.
  try { runFrame(now); } catch (e) { console.error(e); showCrash(root, e); return; }
  requestAnimationFrame(frame);
}
function runFrame(now: number): void {
  const frameDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  input.poll();
  if (paused) {
    acc = 0;
    input.consume(0); input.consume(1); // drop presses made while paused
  } else {
    acc += frameDt;
  }
  while (acc >= DT) {
    const acts: TeamActions = {};
    const p1 = input.consume(0);
    const p2 = input.consume(1);
    if (match.isHuman('home')) acts.home = p1;
    if (match.isHuman('away')) acts.away = p2;
    match.step(acts, DT);
    acc -= DT;
  }
  if (match.phase === 'fulltime' && menu.visible) match = demo();
  if (match.phase !== 'goal' && match.phase !== 'fulltime' && goalLive) goalFx.stop(); // skipped
  goalLive = match.phase === 'goal';
  touch.setMode(match.mode.home);
  view.render(match, frameDt);
  sound.update(match, menu.visible, frameDt, view.crowdWaving); // reads events before the HUD clears them
  if (!paused) talk.update(match, menu.visible, frameDt);
  if (!menu.visible) {
    if (live && match.events.includes('fulltime')) {
      // Saved straight away, so closing the page on the result screen cannot lose the match.
      const { home, away } = match.score, pens = match.shootout;
      if (live === 'league') menu.league.report(home, away);
      else if (live === 'career') menu.career.report(home, away);
      else menu.cup.report({ score: [home, away], pens: pens && [pens.home, pens.away] });
      live = null;
    }
    if (match.events.includes('goal_home') || match.events.includes('goal_away')) { buzz(60); goalFx.play(match); }
    else if (match.events.includes('tackle')) buzz(15);
    hud.update(match, frameDt);
  } else {
    match.events.length = 0;
    match.notices.length = 0;
  }
}
requestAnimationFrame(frame);

document.addEventListener('visibilitychange', () => {
  last = performance.now();
  acc = 0;
  // Leaving the app (phone call, home button) pauses the match and the sound.
  if (document.hidden && !menu.visible) setPaused(true);
  sound.setSuspended(document.hidden || paused);
  if (document.hidden) talk.hush();
});

// Exposed for automated browser checks.
const w = window as unknown as { __game: () => Match; __start: (c?: Partial<MatchConfig>) => void };
w.__game = () => match;
(window as unknown as { __view: GameView }).__view = view;
(window as unknown as { __sound: Sound }).__sound = sound;
(window as unknown as { __talk: Commentary }).__talk = talk;
(window as unknown as { __goalFx: GoalFx }).__goalFx = goalFx;
w.__start = (c = {}) => startMatch({
  home: TEAMS[0], away: TEAMS[3], homeFormation: '4-4-2', awayFormation: '4-4-2',
  seconds: 300, offside: true, humans: ['home'], assist: [], difficulty: 'normal', ...c,
});
