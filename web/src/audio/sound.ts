import type { Match } from '../sim/match';
import { FIREWORK_TIMES } from '../ui/goalfx';

const STORE_KEY = 'pitchline.sound.v1';

/**
 * All game audio is synthesized with the Web Audio API: no sound files to load.
 * Browsers only allow audio after a user gesture, so the context starts on the first tap or key.
 */
export class Sound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private crowd!: GainNode;
  private chatter!: GainNode;
  private noise!: AudioBuffer;
  private lastKickId = -1;
  private lastVy = 0;
  private match: Match | null = null;
  enabled: boolean;

  constructor() {
    let on = true;
    try { on = localStorage.getItem(STORE_KEY) !== 'off'; } catch { /* storage blocked */ }
    this.enabled = on;
    const unlock = () => this.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  /** The game's audio output once the player has unlocked it; recorded commentary plays through it too. */
  output(): { ctx: AudioContext; node: AudioNode } | null {
    return this.ctx && this.ctx.state === 'running' ? { ctx: this.ctx, node: this.master } : null;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    try { localStorage.setItem(STORE_KEY, on ? 'on' : 'off'); } catch { /* ignore */ }
    if (this.ctx) this.master.gain.setTargetAtTime(on ? 0.8 : 0, this.ctx.currentTime, 0.05);
  }

  /** Pause/resume all audio (game paused, tab hidden). */
  setSuspended(s: boolean): void {
    if (!this.ctx) return;
    if (s) void this.ctx.suspend(); else void this.ctx.resume();
  }

  private unlock(): void {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    try { this.ctx = new Ctx(); } catch { return; }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 0.8 : 0;
    this.master.connect(ctx.destination);

    // Shared 2-second white-noise buffer.
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    this.startCrowd();
  }

  // ---------- crowd bed ----------
  private startCrowd(): void {
    const ctx = this.ctx!;
    // Low rumble of a full stadium.
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 650;
    this.crowd = ctx.createGain();
    this.crowd.gain.value = 0.12;
    src.connect(low).connect(this.crowd).connect(this.master);
    src.start();

    // Voices: a band of mid frequencies that slowly swells and fades.
    const src2 = ctx.createBufferSource();
    src2.buffer = this.noise;
    src2.loop = true;
    src2.loopStart = 0.7;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1100;
    band.Q.value = 0.6;
    this.chatter = ctx.createGain();
    this.chatter.gain.value = 0.05;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.23;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 0.02;
    lfo.connect(lfoAmt).connect(this.chatter.gain);
    lfo.start();
    src2.connect(band).connect(this.chatter).connect(this.master);
    src2.start(0, 0.7);
  }

  private setCrowd(level: number): void {
    const ctx = this.ctx!;
    this.crowd.gain.setTargetAtTime(0.1 + level * 0.25, ctx.currentTime, 0.6);
    this.chatter.gain.setTargetAtTime(0.04 + level * 0.12, ctx.currentTime, 0.6);
  }

  // ---------- one-shots ----------
  private env(g: GainNode, t: number, peak: number, attack: number, decay: number): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private noiseBurst(t: number, filter: BiquadFilterType, freq: number, q: number, peak: number, attack: number, decay: number, sweepTo?: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + attack + decay);
    f.Q.value = q;
    const g = ctx.createGain();
    this.env(g, t, peak, attack, decay);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5);
    src.stop(t + attack + decay + 0.05);
  }

  /** Boot on ball: a low thump plus a leather slap; louder for harder strikes. */
  kick(power: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(140 + power * 40, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.09);
    const g = ctx.createGain();
    this.env(g, t, 0.25 + power * 0.45, 0.004, 0.12);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.15);
    this.noiseBurst(t, 'bandpass', 1500 + power * 900, 1.2, 0.12 + power * 0.25, 0.002, 0.05);
  }

  bounce(strength: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.06);
    const g = ctx.createGain();
    this.env(g, t, Math.min(0.25, strength * 0.05), 0.003, 0.08);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.1);
  }

  /** Pea whistle: ~2.8 kHz with a fast warble. `pattern` alternates on/off seconds. */
  whistle(pattern: number[]): void {
    const ctx = this.ctx!;
    let t = ctx.currentTime + 0.02;
    pattern.forEach((dur, i) => {
      if (i % 2 === 0) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = 2850;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 32;
        const depth = ctx.createGain();
        depth.gain.value = 140;
        lfo.connect(depth).connect(o.frequency);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
        g.gain.setValueAtTime(0.16, t + dur - 0.04);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(this.master);
        o.start(t); lfo.start(t);
        o.stop(t + dur + 0.02); lfo.stop(t + dur + 0.02);
      }
      t += dur;
    });
  }

  /**
   * Crowd erupts: a fast swell of tens of thousands of voices ("ahh" vowel bands),
   * a long sustain, then applause scattered across the stands.
   */
  roar(size: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const layer = (filter: BiquadFilterType, f: number, q: number, peak: number, sustain: number, sweep?: number) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const fl = ctx.createBiquadFilter();
      fl.type = filter;
      fl.frequency.setValueAtTime(f * 0.8, t);
      fl.frequency.exponentialRampToValueAtTime(sweep ?? f, t + 0.6);
      fl.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak * size, t + 0.35);
      g.gain.setValueAtTime(peak * size, t + 0.35 + sustain);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35 + sustain + 2.5);
      src.connect(fl).connect(g).connect(this.master);
      src.start(t, Math.random() * 1.5);
      src.stop(t + sustain + 3);
    };
    layer('lowpass', 900, 0.7, 0.75, 2.2);          // body of the roar
    layer('bandpass', 700, 2.5, 0.9, 2.0, 760);     // "ah" first formant
    layer('bandpass', 1150, 3.0, 0.5, 1.8, 1250);   // "ah" second formant
    layer('highpass', 2500, 0.5, 0.15, 1.5);        // whistles and shrieks
    // Applause: hundreds of tiny claps spread over a few seconds.
    for (let i = 0; i < 140; i++) {
      const at = t + 0.4 + Math.random() * 4;
      this.noiseBurst(at, 'bandpass', 1800 + Math.random() * 1600, 1.5, 0.05 * size * (0.5 + Math.random()), 0.002, 0.04);
    }
  }

  /** "Ooh!": a short swell that falls in pitch. */
  ooh(): void {
    const t = this.ctx!.currentTime;
    this.noiseBurst(t, 'bandpass', 750, 2.2, 0.3, 0.12, 0.9, 420);
  }

  /** Ball rattles the woodwork. */
  clang(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    for (const [f, a] of [[520, 0.18], [1310, 0.1], [2150, 0.06]] as const) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const g = ctx.createGain();
      this.env(g, t, a, 0.002, 0.8);
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + 0.85);
    }
  }

  net(): void {
    this.noiseBurst(this.ctx!.currentTime, 'highpass', 2500, 0.7, 0.18, 0.01, 0.3);
  }

  /**
   * Many voices singing a vowel: detuned sawtooth voices through two formant filters.
   * `notes` = [frequency, seconds] pairs sung one after another.
   */
  private choir(f1: number, f2: number, notes: [number, number][], gain: number, voices = 8, at = 0): number {
    const ctx = this.ctx!;
    let t = ctx.currentTime + at;
    const out = ctx.createGain();
    out.gain.value = gain * 5; // the narrow formant filters remove most of the energy
    const fa = ctx.createBiquadFilter(); fa.type = 'bandpass'; fa.frequency.value = f1; fa.Q.value = 5;
    const fb = ctx.createBiquadFilter(); fb.type = 'bandpass'; fb.frequency.value = f2; fb.Q.value = 7;
    const fbGain = ctx.createGain(); fbGain.gain.value = 0.5;
    fa.connect(out); fb.connect(fbGain).connect(out);
    out.connect(this.master);
    for (const [freq, dur] of notes) {
      for (let v = 0; v < voices; v++) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = freq * (v % 3 === 0 ? 0.5 : 1); // some voices an octave down
        o.detune.value = (Math.random() - 0.5) * 40;
        const vib = ctx.createOscillator();
        vib.frequency.value = 4.5 + Math.random() * 1.5;
        const vibAmt = ctx.createGain();
        vibAmt.gain.value = 6;
        vib.connect(vibAmt).connect(o.detune);
        const g = ctx.createGain();
        const start = t + Math.random() * 0.06; // people are never exactly together
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(1 / voices, start + 0.08);
        g.gain.setValueAtTime(1 / voices, start + Math.max(0.1, dur - 0.12));
        g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        o.connect(g);
        g.connect(fa); g.connect(fb);
        o.start(start); vib.start(start);
        o.stop(start + dur + 0.05); vib.stop(start + dur + 0.05);
      }
      t += dur;
    }
    return t - ctx.currentTime;
  }

  /** Fireworks for the goal sting: a deep pop, then a crackle of sparks, at each burst time. */
  fireworks(times: number[]): void {
    const ctx = this.ctx!;
    for (const at of times) {
      const t = ctx.currentTime + at;
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(160, t);
      o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
      const g = ctx.createGain();
      this.env(g, t, 0.45, 0.004, 0.3);
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + 0.35);
      this.noiseBurst(t, 'lowpass', 1200, 0.7, 0.35, 0.003, 0.18);
      for (let i = 0; i < 26; i++) {
        this.noiseBurst(t + 0.12 + Math.random() * 0.7, 'highpass', 3500 + Math.random() * 3000, 0.8, 0.05 + Math.random() * 0.07, 0.001, 0.02);
      }
    }
  }

  /** A crowd clap: a few hundred hands, slightly out of time. */
  private clap(at: number, gain: number): void {
    const t = this.ctx!.currentTime + at;
    for (let i = 0; i < 14; i++) {
      this.noiseBurst(t + Math.random() * 0.035, 'bandpass', 1300 + Math.random() * 1400, 1.4, gain * (0.5 + Math.random() * 0.5), 0.002, 0.05);
    }
  }

  /** Scattered applause for `dur` seconds. */
  applause(dur: number, gain = 0.12): void {
    const t = this.ctx!.currentTime;
    const n = Math.floor(dur * 80);
    for (let i = 0; i < n; i++) {
      const at = t + Math.pow(Math.random(), 1.4) * dur; // denser at the start
      this.noiseBurst(at, 'bandpass', 1600 + Math.random() * 1800, 1.5, gain * 2.5 * (0.6 + Math.random() * 0.8), 0.002, 0.05);
    }
  }

  /** Home fans' song: "오~ 오오오~ 오오~", then three claps and a shout. */
  chant(away = false): void {
    const k = away ? 0.84 : 1; // away end sings lower and quieter
    const A3 = 220 * k, C4 = 261.6 * k, D4 = 293.7 * k, E4 = 329.6 * k;
    const len = this.choir(430, 820, [[A3, 0.55], [A3, 0.28], [C4, 0.28], [D4, 0.6], [E4, 0.45], [D4, 0.35], [C4, 0.9]], away ? 0.26 : 0.4, 9);
    // 짝짝 짝짝짝
    [0, 0.3, 0.75, 1.05, 1.35].forEach((d) => this.clap(len + 0.15 + d, away ? 0.05 : 0.08));
    this.choir(700, 1150, [[E4, 0.5]], away ? 0.25 : 0.4, 9, len + 1.8);
  }

  /** "Ahh…" after a near miss: a falling vowel. */
  groan(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    this.noiseBurst(t, 'bandpass', 900, 2.2, 0.7, 0.1, 1.3, 380);
    this.choir(750, 1150, [[200, 0.35], [175, 0.45], [150, 0.6]], 0.6, 8);
  }

  /** Boos: a low "oo" with heavy vibrato. */
  boo(gain = 0.4): void {
    this.choir(320, 820, [[120, 1.4]], gain, 10);
  }

  // ---------- per-frame driver ----------
  private chantTimer = 18;
  private lastShot = -99;
  private clock = 0;

  /** Read this frame's match events (before the HUD clears them) and keep the crowd level right. */
  update(m: Match, inMenu: boolean, dt = 1 / 60, waving = false): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    this.clock += dt;
    if (this.match !== m) { this.match = m; this.lastKickId = m.ball.kickId; }
    const b = m.ball;

    // Kicks: every new kick id with the ball moving away fast.
    if (b.kickId !== this.lastKickId) {
      this.lastKickId = b.kickId;
      const sp = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
      if (sp > 3 && !b.held) this.kick(Math.min(1, sp / 32));
    }
    // Bounces: vertical velocity flips upward with some force.
    if (this.lastVy < -2 && b.vel.y > 1 && b.pos.y < 0.3) this.bounce(-this.lastVy);
    this.lastVy = b.vel.y;

    const quiet = inMenu ? 0.35 : 1;
    for (const ev of m.events) {
      switch (ev) {
        case 'kickoff': this.whistle([0.35]); if (!inMenu) this.applause(1.6, 0.08); break;
        case 'foul': this.whistle([0.28]); if (!inMenu) this.boo(0.22); break;
        case 'offside': this.whistle([0.28]); break;
        case 'penalty': this.whistle([0.7]); if (!inMenu) this.roar(0.45); break;
        case 'shootout': this.whistle([0.5, 0.15, 0.5]); break;
        case 'pen_goal': this.net(); if (!inMenu) this.roar(0.7); break;
        case 'pen_saved': this.ooh(); if (!inMenu) this.applause(1.8, 0.1); break;
        case 'pen_missed': if (!inMenu) this.groan(); break;
        case 'extratime': this.whistle([0.4, 0.15, 0.4]); break;
        case 'halftime': this.whistle([0.4, 0.15, 0.9]); if (!inMenu) this.applause(3, 0.1); break;
        case 'fulltime': this.whistle([0.4, 0.15, 0.4, 0.15, 1.1]); this.roar(0.6 * quiet); this.applause(5, 0.12 * quiet); break;
        case 'goal_home': case 'goal_away':
          this.net(); this.roar(quiet);
          if (!inMenu) this.fireworks(FIREWORK_TIMES);
          // The scoring end bursts into song once the roar settles.
          if (!inMenu) setTimeout(() => this.ctx && this.chant(ev === 'goal_away'), 3200);
          this.chantTimer = 30 + Math.random() * 15;
          break;
        case 'save': this.ooh(); if (!inMenu) this.applause(1.8, 0.1); break;
        case 'post': this.clang(); this.ooh(); break;
        case 'shot': this.lastShot = this.clock; break;
        case 'goalkick': case 'corner':
          // A shot that went wide: the crowd groans.
          if (this.clock - this.lastShot < 3 && !inMenu) this.groan();
          this.lastShot = -99;
          break;
      }
    }

    // Songs from the stands every half-minute or so while the game flows.
    if (!inMenu && m.phase === 'play') {
      this.chantTimer -= dt;
      if (this.chantTimer <= 0) {
        this.chant(Math.random() < 0.3);
        this.chantTimer = 28 + Math.random() * 20;
      }
    }

    // Crowd gets louder as the ball nears either goal, stays up through a celebration,
    // and lifts as a Mexican wave goes round.
    const nearGoal = Math.max(0, Math.min(1, (Math.abs(b.pos.x) - 25) / 22));
    const level = m.phase === 'goal' ? 1.6 : 0.25 + nearGoal * 0.75 + (waving ? 0.45 : 0);
    this.setCrowd(inMenu ? 0.1 : level);
  }
}
