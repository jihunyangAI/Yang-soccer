/**
 * Recorded commentary clips. They are shipped as a few "pack" files (many small MP3s end to
 * end) with an index of where each clip sits, so a match needs three downloads instead of
 * hundreds: the common lines, and one pack of player names per club.
 * A build without the packs (the single-file artifact) simply has no clips, and the commentary
 * falls back to the browser's own voice.
 */
interface Index { packs: string[]; clips: Record<string, [pack: number, offset: number, length: number]> }

export class VoiceBank {
  private index: Index | null = null;
  private state: 'loading' | 'ready' | 'none' = 'loading';
  private packs = new Map<number, ArrayBuffer | 'loading' | 'failed'>();
  private clips = new Map<string, AudioBuffer | 'decoding' | 'failed'>();

  constructor(private base = 'voice/') {
    fetch(`${base}index.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: Index) => { this.index = j; this.state = 'ready'; this.loadPack(0); })
      .catch(() => { this.state = 'none'; });
  }

  /** Whether it is known yet if this build has recordings. */
  get settled(): boolean { return this.state !== 'loading'; }
  /** Number of recorded clips available (0 when this build has none). */
  get size(): number { return this.index ? Object.keys(this.index.clips).length : 0; }
  has(key: string): boolean { return !!this.index?.clips[key]; }

  private loadPack(i: number): void {
    if (!this.index || this.packs.has(i)) return;
    this.packs.set(i, 'loading');
    fetch(`${this.base}${this.index.packs[i]}.pack`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((b) => { this.packs.set(i, b); })
      .catch(() => { this.packs.set(i, 'failed'); });
  }

  /** Start fetching the name packs of the clubs in a match, so the first call of a name does not wait. */
  prefetch(teamIds: string[]): void {
    if (!this.index) return;
    for (const id of teamIds) {
      const i = this.index.packs.indexOf(`team-${id}`);
      if (i >= 0) this.loadPack(i);
    }
  }

  /**
   * Whether these clips can be played now. 'pending' means they are on their way (asking is
   * what starts the download and decoding); 'missing' means at least one will never come.
   */
  want(ctx: AudioContext, keys: string[]): 'ready' | 'pending' | 'missing' {
    if (this.state === 'loading') return 'pending';
    if (!this.index) return 'missing';
    let pending = false;
    for (const key of keys) {
      const at = this.index.clips[key];
      if (!at) return 'missing';
      const got = this.clips.get(key);
      if (got === 'failed') return 'missing';
      if (got && got !== 'decoding') continue;
      pending = true;
      if (got === 'decoding') continue;
      const pack = this.packs.get(at[0]);
      if (pack === 'failed') return 'missing';
      if (!pack || pack === 'loading') { this.loadPack(at[0]); continue; }
      this.clips.set(key, 'decoding');
      const bytes = pack.slice(at[1], at[1] + at[2]); // decodeAudioData takes ownership of what it is given
      const done = (b: AudioBuffer) => { this.clips.set(key, b); };
      const fail = () => { this.clips.set(key, 'failed'); };
      try {
        const p = ctx.decodeAudioData(bytes, done, fail);
        if (p && typeof p.then === 'function') p.then(done, fail);
      } catch { fail(); }
    }
    return pending ? 'pending' : 'ready';
  }

  /** A decoded clip (only after `want` said 'ready'). */
  get(key: string): AudioBuffer | null {
    const b = this.clips.get(key);
    return b && b !== 'decoding' && b !== 'failed' ? b : null;
  }
}
