// Records the commentary and packs it for the game.
//   npm run voice          record whatever is missing, then pack everything into public/voice/
//   npm run voice -- pack  only pack what is already recorded
// Raw takes are kept in voice-src/ (not in git) so a re-run only records new lines. The API key
// is read from .env.local (OPENAI_API_KEY or open_ai) or the environment and is never printed.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allFragments, fragId, GOAL_CRY, iga, KEY, SCORE_MAX, scoreWords, SIDE, type Frag, type Mood, type Who } from '../../src/audio/lines';
import { buildRoster, KOREAN_POOL, LAST } from '../../src/sim/roster';
import { TEAMS } from '../../src/sim/team';

const web = process.cwd();
const SRC = join(web, 'voice-src'), TMP = join(web, 'voice-src', 'small'), OUT = join(web, 'public', 'voice');
for (const d of [SRC, TMP, OUT]) mkdirSync(d, { recursive: true });

function apiKey(): string | null {
  const names = ['OPENAI_API_KEY', 'open_ai', 'OPEN_AI', 'OPENAI_KEY', 'openai'];
  const file = join(web, '.env.local');
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && names.includes(m[1])) { const v = m[2].replace(/^["']|["']$/g, '').trim(); if (v) return v; }
    }
  }
  for (const n of names) if (process.env[n]) return process.env[n]!;
  return null;
}

// ---- who is speaking, and how ----
const VOICE: Record<Who, string> = { caster: 'ash', analyst: 'echo' };
const ACT: Record<Who, string> = {
  caster: `당신은 한국 지상파 방송의 베테랑 남자 축구 캐스터입니다. 지금 만원 관중의 경기장 중계석에서 생중계 중입니다.
한국 축구 중계 특유의 말투로 말합니다: 말이 빠르고, 문장 끝을 힘 있게 올리거나 끊어 치고, 선수 이름을 또렷하게 강조하며, 결정적인 순간에는 목청껏 소리칩니다.
기회를 놓치면 "아아" 하고 탄식합니다. 책을 읽는 것처럼 말하지 않습니다.
사용자가 주는 대사를 한 글자도 바꾸지 말고 그대로 연기하세요. 대사 외의 말은 절대 덧붙이지 마세요.`,
  analyst: `당신은 한국 지상파 축구 중계의 남자 해설위원입니다. 선수 출신으로, 캐스터 옆에 앉아 편하게 이야기하듯 해설합니다.
말투는 구어체로 자연스럽고, 감탄할 때는 진심으로 감탄하고 아쉬울 때는 한숨 섞어 말합니다. 책을 읽는 것처럼 말하지 않습니다.
사용자가 주는 대사를 한 글자도 바꾸지 말고 그대로 연기하세요. 대사 외의 말은 절대 덧붙이지 마세요.`,
};
const SCENE: Record<Mood, string> = {
  quick: '평소 경기 진행 상황. 빠르고 리듬감 있게.', tense: '결정적인 순간! 목소리가 급하게 올라가며 긴박하게.',
  shout: '엄청난 장면이 나왔다! 목청껏 크게 외친다.', joy: '방금 멋진 장면이 나와 흥분이 가라앉지 않았다. 들뜬 목소리로 힘차게.',
  sad: '결정적인 기회를 놓쳤다. 탄식하며 아쉽게.', shock: '믿기지 않는 일이 벌어졌다. 깜짝 놀라서.', calm: '편안하게 분석을 덧붙인다.',
};

interface Job { key: string; file: string; kind: 'act' | 'read'; who: Who; text: string; scene: string; /** Shipped in the pack of stand-in names, fetched only when a match needs them. */ extra?: boolean; /** Shipped in the pack of names for players who join in club development mode. */ pool?: boolean }
const safe = (s: string) => Buffer.from(s, 'utf8').toString('hex').slice(0, 80);
const jobs: Job[] = [];
for (const f of allFragments()) jobs.push({ key: KEY.frag(f), file: `f-${fragId(f)}.mp3`, kind: 'act', who: f.who, text: f.text, scene: SCENE[f.mood] });
const teamNames = [...new Set(TEAMS.map((t) => t.name))];
for (const name of teamNames) {
  jobs.push({ key: KEY.team('caster', name), file: `tc-${safe(name)}.mp3`, kind: 'act', who: 'caster', text: `${name}!`, scene: '경기 중 팀 이름을 힘 있게 짧게 부른다.' });
  jobs.push({ key: KEY.team('analyst', name), file: `ta-${safe(name)}.mp3`, kind: 'act', who: 'analyst', text: name, scene: '해설 도중 팀 이름을 말한다. 문장이 뒤에 이어질 것처럼 끝을 내리지 않는다.' });
  jobs.push({ key: KEY.teamGa(name), file: `tg-${safe(name)}.mp3`, kind: 'act', who: 'caster', text: iga(name), scene: '경기 중 팀 이름을 주어로 말한다. 문장이 뒤에 이어질 것처럼 끝을 내리지 않는다.' });
}
/** Player names per club, read by the cheaper speech model: 512 short calls. */
const squads = TEAMS.map((t) => ({ id: t.id, names: [...new Set(buildRoster(t, true).map((p) => p.name))] }));
for (const name of new Set(squads.flatMap((s) => s.names))) {
  jobs.push({ key: KEY.player(name), file: `p-${safe(name)}.mp3`, kind: 'read', who: 'caster', text: `${name}!`, scene: '한국 축구 중계의 남자 캐스터가 경기 중 선수 이름을 힘 있고 또렷하게 부른다. 짧게, 빠르게.' });
}

// The score, read out after a goal and at the whistle.
for (let h = 0; h <= SCORE_MAX; h++) for (let a = 0; a <= SCORE_MAX; a++) {
  jobs.push({ key: KEY.score(h, a), file: `sc-${h}-${a}.mp3`, kind: 'act', who: 'caster', text: `${scoreWords(h, a)}!`, scene: '경기 중 현재 점수를 힘 있고 또렷하게 알린다. 짧게, 빠르게.' });
}
// Stand-ins for names that have no recording: family names, shirt numbers, and "the home side".
const NAME_SCENE = '한국 축구 중계의 남자 캐스터가 경기 중 선수 이름을 힘 있고 또렷하게 부른다. 짧게, 빠르게.';
for (const last of LAST) jobs.push({ key: KEY.surname(last), file: `s-${safe(last)}.mp3`, kind: 'read', who: 'caster', text: `${last}!`, scene: NAME_SCENE, extra: true });
for (let n = 1; n <= 99; n++) {
  jobs.push({ key: KEY.number(n), file: `n-${n}.mp3`, kind: 'read', who: 'caster', text: `${n}번!`, scene: '한국 축구 중계의 남자 캐스터가 경기 중 선수를 등번호로 힘 있고 또렷하게 부른다. 짧게, 빠르게.', extra: true });
}
for (const name of Object.values(SIDE)) {
  jobs.push({ key: KEY.team('caster', name), file: `tc-${safe(name)}.mp3`, kind: 'act', who: 'caster', text: `${name}!`, scene: '경기 중 팀을 힘 있게 짧게 부른다.', extra: true });
  jobs.push({ key: KEY.team('analyst', name), file: `ta-${safe(name)}.mp3`, kind: 'act', who: 'analyst', text: name, scene: '해설 도중 팀을 가리켜 말한다. 문장이 뒤에 이어질 것처럼 끝을 내리지 않는다.', extra: true });
  jobs.push({ key: KEY.teamGa(name), file: `tg-${safe(name)}.mp3`, kind: 'act', who: 'caster', text: iga(name), scene: '경기 중 팀을 주어로 말한다. 문장이 뒤에 이어질 것처럼 끝을 내리지 않는다.', extra: true });
}

// The Korean names players who join in club development mode can have.
{
  const have = new Set(jobs.map((j) => j.key));
  for (const name of KOREAN_POOL) {
    if (have.has(KEY.player(name))) continue;
    jobs.push({ key: KEY.player(name), file: `p-${safe(name)}.mp3`, kind: 'read', who: 'caster', text: `${name}!`, scene: NAME_SCENE, pool: true });
  }
}

// ---- recording ----
const hangul = (s: string) => s.replace(/[^가-힣]/g, '');
async function record(key: string, j: Job): Promise<Buffer> {
  const auth = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  for (let attempt = 0; ; attempt++) {
    try {
      if (j.kind === 'read') {
        const r = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST', headers: auth,
          body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: VOICE[j.who], input: j.text, instructions: j.scene, response_format: 'mp3' }),
        });
        if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`);
        return Buffer.from(await r.arrayBuffer());
      }
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: auth,
        body: JSON.stringify({
          model: 'gpt-audio-1.5', modalities: ['text', 'audio'], audio: { voice: VOICE[j.who], format: 'mp3' },
          messages: [{ role: 'system', content: ACT[j.who] }, { role: 'user', content: `[상황] ${j.scene}\n[대사] ${j.text}` }],
        }),
      });
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`);
      const a = ((await r.json()) as { choices?: { message?: { audio?: { data?: string; transcript?: string } } }[] }).choices?.[0]?.message?.audio;
      if (!a?.data) throw new Error('no audio in the reply');
      // The model is told to say the line exactly; a take where it said something else is thrown away.
      if (hangul(a.transcript ?? '') !== hangul(j.text) && attempt < 2) throw new Error(`said "${a.transcript}"`);
      return Buffer.from(a.data, 'base64');
    } catch (e) {
      const msg = String((e as Error).message).replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***');
      if (/ 401 |insufficient_quota|billing/i.test(` ${msg}`) || attempt >= 4) throw new Error(msg);
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    }
  }
}

async function recordAll(): Promise<void> {
  // The goal cry is the take that was picked by ear, not a new one.
  const cry = join(web, 'voice-test', 'goal-e-ash.mp3'), cryFile = join(SRC, `f-${fragId(GOAL_CRY)}.mp3`);
  if (!existsSync(cryFile) && existsSync(cry)) copyFileSync(cry, cryFile);
  const todo = jobs.filter((j) => !existsSync(join(SRC, j.file)));
  console.log(`${jobs.length} clips in all, ${todo.length} to record (${todo.filter((j) => j.kind === 'act').length} acted, ${todo.filter((j) => j.kind === 'read').length} names read)`);
  if (!todo.length) return;
  const key = apiKey();
  if (!key) throw new Error('No API key: put OPENAI_API_KEY=... (or open_ai=...) in web/.env.local');
  let done = 0, failed = 0, stop = false;
  const worker = async () => {
    while (todo.length && !stop) {
      const j = todo.shift()!;
      try {
        writeFileSync(join(SRC, j.file), await record(key, j));
        if (++done % 25 === 0) console.log(`  ${done} recorded, ${todo.length} left`);
      } catch (e) {
        failed++;
        console.log(`  FAILED ${j.key} "${j.text}": ${(e as Error).message}`);
        if (/401|insufficient_quota|billing/i.test((e as Error).message)) stop = true;
      }
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  console.log(`recorded ${done}, failed ${failed}${stop ? ' (stopped: the account refused the request)' : ''}`);
}

// ---- shrinking and packing ----
function pack(): void {
  // Trim the silence at both ends, make it mono and small: these are short voice clips.
  const trim = 'silenceremove=start_periods=1:start_threshold=-46dB:start_silence=0.02,areverse,silenceremove=start_periods=1:start_threshold=-46dB:start_silence=0.06,areverse';
  const small = (file: string): Buffer | null => {
    const from = join(SRC, file), to = join(TMP, file);
    if (!existsSync(from)) return null;
    if (!existsSync(to) || statSync(to).mtimeMs < statSync(from).mtimeMs) {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', from, '-af', trim, '-ac', '1', '-ar', '24000', '-b:a', '40k', to]);
    }
    return readFileSync(to);
  };
  const byKey = new Map(jobs.map((j) => [j.key, j]));
  const playerKeys = new Set(squads.flatMap((s) => s.names.map((n) => KEY.player(n))));
  const groups: { name: string; keys: string[] }[] = [
    { name: 'core', keys: jobs.filter((j) => !playerKeys.has(j.key) && !j.extra && !j.pool).map((j) => j.key) },
    { name: 'extra', keys: jobs.filter((j) => j.extra).map((j) => j.key) },
    ...squads.map((s) => ({ name: `team-${s.id}`, keys: s.names.map((n) => KEY.player(n)) })),
    { name: 'pool', keys: jobs.filter((j) => j.pool).map((j) => j.key) },
  ];
  const index: { packs: string[]; clips: Record<string, [number, number, number]> } = { packs: [], clips: {} };
  let total = 0, missing = 0;
  for (const g of groups) {
    const parts: Buffer[] = [];
    let off = 0;
    for (const k of g.keys) {
      if (index.clips[k]) continue; // a name shared by two squads lives in the first one's pack
      const b = small(byKey.get(k)!.file);
      if (!b) { missing++; continue; }
      index.clips[k] = [index.packs.length, off, b.length];
      parts.push(b); off += b.length;
    }
    writeFileSync(join(OUT, `${g.name}.pack`), Buffer.concat(parts));
    index.packs.push(g.name);
    total += off;
  }
  writeFileSync(join(OUT, 'index.json'), JSON.stringify(index));
  console.log(`packed ${Object.keys(index.clips).length} clips into ${index.packs.length} files, ${(total / 1048576).toFixed(1)} MB (core ${(statSync(join(OUT, 'core.pack')).size / 1048576).toFixed(1)} MB), ${missing} not recorded yet`);
}

if (process.argv[2] !== 'pack') await recordAll();
pack();
