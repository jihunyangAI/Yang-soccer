import type { Match } from '../sim/match';
import { crestSvg } from './crest';

/** When each firework bursts (seconds after the goal); the sound layer uses the same schedule. */
export const FIREWORK_TIMES = [0.25, 0.55, 0.8, 1.15, 1.45, 1.8, 2.2];

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

interface Spark { x: number; y: number; px: number; py: number; vx: number; vy: number; life: number; max: number; color: string; size: number }
interface Confetti { x: number; y: number; vx: number; vy: number; rot: number; vr: number; w: number; h: number; color: string; life: number }

/**
 * TV-style goal sting: the scoring club's badge punches in at the centre of the screen,
 * fireworks burst around it in club colours and gold, confetti falls, and a lower third
 * shows the scorer and minute. Purely a 2D overlay above the match view.
 */
export class GoalFx {
  private el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private sparks: Spark[] = [];
  private confetti: Confetti[] = [];
  private t = -1;
  private bursts: number[] = [];
  private palette: string[] = [];
  private raf = 0;
  private last = 0;
  private running = false;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'goalfx';
    this.el.hidden = true;
    this.el.innerHTML = `
      <canvas class="gfx-canvas"></canvas>
      <div class="gfx-center">
        <div class="gfx-ring"></div>
        <div class="gfx-crest"></div>
        <div class="gfx-word">GOAL</div>
      </div>
      <div class="gfx-third"><span class="gfx-crest-sm"></span><span class="gfx-name"></span><span class="gfx-min"></span></div>`;
    root.appendChild(this.el);
    this.canvas = this.el.querySelector('canvas')!;
    this.g = this.canvas.getContext('2d')!;
    window.addEventListener('resize', () => this.fit());
  }

  private fit(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Start the sting for the goal just scored. */
  play(m: Match): void {
    const goal = m.lastGoal;
    if (!goal) return;
    const team = m.teams[goal.team];
    const scorer = m.players[goal.scorerId];
    this.el.querySelector('.gfx-crest')!.innerHTML = crestSvg(team.crest, 220);
    this.el.querySelector('.gfx-crest-sm')!.innerHTML = crestSvg(team.crest, 26);
    this.el.querySelector('.gfx-name')!.textContent = goal.own ? `${team.name} · 상대 자책골` : `${scorer.number} ${scorer.name}`;
    this.el.querySelector('.gfx-min')!.textContent = `${goal.minute}'`;
    (this.el.querySelector('.gfx-third') as HTMLElement).style.setProperty('--team', hex(team.kit.shirt));
    (this.el.querySelector('.gfx-ring') as HTMLElement).style.setProperty('--team', hex(team.kit.shirt));
    this.palette = [hex(team.kit.shirt), hex(team.crest.colors[2]), '#ffd54a', '#ffffff', hex(team.crest.colors[1])];
    this.fit();
    this.sparks = [];
    this.confetti = [];
    this.bursts = [...FIREWORK_TIMES];
    this.t = 0;
    // Restart the CSS animations.
    this.el.hidden = false;
    this.el.classList.remove('play');
    void this.el.offsetWidth;
    this.el.classList.add('play');
    for (let i = 0; i < 140; i++) this.spawnConfetti(true);
    if (!this.running) {
      this.running = true;
      this.last = performance.now();
      this.raf = requestAnimationFrame((n) => this.tick(n));
    }
  }

  /** Stop early (goal skipped, match left). */
  stop(): void {
    this.t = -1;
    this.el.hidden = true;
    this.el.classList.remove('play');
    this.sparks = [];
    this.confetti = [];
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private spawnConfetti(initial: boolean): void {
    const W = window.innerWidth;
    this.confetti.push({
      x: Math.random() * W, y: initial ? -Math.random() * window.innerHeight * 0.8 : -20,
      vx: (Math.random() - 0.5) * 60, vy: 70 + Math.random() * 90,
      rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 9,
      w: 6 + Math.random() * 6, h: 3 + Math.random() * 4,
      color: this.palette[(Math.random() * this.palette.length) | 0], life: 4.5,
    });
  }

  private burst(): void {
    const W = window.innerWidth, H = window.innerHeight;
    // Around the badge, never on top of it.
    const ang = Math.random() * Math.PI * 2;
    const r = Math.min(W, H) * (0.28 + Math.random() * 0.14);
    const cx = W / 2 + Math.cos(ang) * r * 1.4, cy = H * 0.42 + Math.sin(ang) * r * 0.8;
    const color = this.palette[(Math.random() * 3) | 0];
    const n = 70;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.1;
      const sp = 140 + Math.random() * 260;
      const max = 1.0 + Math.random() * 0.6;
      this.sparks.push({ x: cx, y: cy, px: cx, py: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: max, max, color: Math.random() < 0.25 ? '#fff6d0' : color, size: 1.6 + Math.random() * 1.6 });
    }
  }

  private tick(now: number): void {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.t >= 0) this.t += dt;
    while (this.bursts.length && this.t >= this.bursts[0]) { this.bursts.shift(); this.burst(); }
    if (this.t > 0 && this.t < 3 && Math.random() < dt * 25) this.spawnConfetti(false);

    const g = this.g;
    const W = window.innerWidth, H = window.innerHeight;
    g.clearRect(0, 0, W, H);
    g.globalCompositeOperation = 'lighter';
    for (const s of this.sparks) {
      s.px = s.x; s.py = s.y;
      s.vx *= Math.exp(-1.6 * dt); s.vy *= Math.exp(-1.6 * dt);
      s.vy += 160 * dt;
      s.x += s.vx * dt; s.y += s.vy * dt;
      s.life -= dt;
      const a = Math.max(0, s.life / s.max);
      g.strokeStyle = s.color;
      g.globalAlpha = a;
      g.lineWidth = s.size;
      g.beginPath(); g.moveTo(s.px, s.py); g.lineTo(s.x, s.y); g.stroke();
      // Twinkle as the spark dies.
      if (a < 0.35 && Math.random() < 0.3) { g.fillStyle = '#fff'; g.fillRect(s.x, s.y, 2, 2); }
    }
    g.globalCompositeOperation = 'source-over';
    for (const c of this.confetti) {
      c.vy += 40 * dt;
      c.x += (c.vx + Math.sin(c.rot * 2) * 30) * dt; c.y += c.vy * dt;
      c.rot += c.vr * dt;
      c.life -= dt;
      g.globalAlpha = Math.min(1, c.life);
      g.save();
      g.translate(c.x, c.y);
      g.rotate(c.rot);
      g.scale(1, Math.cos(c.rot * 1.7)); // flutter
      g.fillStyle = c.color;
      g.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
      g.restore();
    }
    g.globalAlpha = 1;
    this.sparks = this.sparks.filter((s) => s.life > 0);
    this.confetti = this.confetti.filter((c) => c.life > 0 && c.y < H + 30);

    if (this.t > 4.6 && !this.sparks.length) {
      this.el.hidden = true;
      this.t = -1;
    }
    if (this.t < 0 && !this.sparks.length && !this.confetti.length) { this.running = false; return; }
    this.raf = requestAnimationFrame((n) => this.tick(n));
  }
}
