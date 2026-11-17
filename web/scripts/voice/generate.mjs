// Generates commentary audio with OpenAI's speech model.
//   node scripts/voice/generate.mjs test     ten sample lines read by the speech model → voice-test/index.html
//   node scripts/voice/generate.mjs test2    the same lines performed by the audio chat model → voice-test/round2.html
// The API key is read from web/.env.local (OPENAI_API_KEY, or open_ai) or the environment.
// It is never printed.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const web = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function apiKey() {
  const names = ['OPENAI_API_KEY', 'open_ai', 'OPEN_AI', 'OPENAI_KEY', 'openai'];
  const file = join(web, '.env.local');
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && names.includes(m[1])) {
        const v = m[2].replace(/^["']|["']$/g, '').trim();
        if (v) return { key: v, from: `.env.local (${m[1]})` };
      }
    }
  }
  for (const n of names) if (process.env[n]) return { key: process.env[n], from: `environment (${n})` };
  return null;
}

/** How each mood is acted. The model takes directions in plain words. */
const BOOTH = '한국 TV 축구 중계. 실제 경기장 중계석에서 말하는 것처럼 자연스럽게, 책 읽는 투가 아니라 현장감 있게.';
export const DIRECTION = {
  caster: {
    quick: `${BOOTH} 남자 캐스터. 빠르고 또렷하게, 경기 흐름을 따라가며 리듬감 있게 말한다.`,
    tense: `${BOOTH} 남자 캐스터. 결정적인 기회가 온 순간. 목소리가 올라가고 말이 빨라지며 긴박하다.`,
    shout: `${BOOTH} 남자 캐스터. 골이 터진 순간! 목이 터져라 길게 끌며 외친다. 최대한 크고 흥분해서, 환호하듯.`,
    joy: `${BOOTH} 남자 캐스터. 방금 골이 들어가 흥분이 가라앉지 않은 상태. 들뜨고 빠르고 힘차게, 선수 이름을 힘주어 부른다.`,
    sad: `${BOOTH} 남자 캐스터. 결정적인 기회를 놓쳐 탄식한다. "아아" 하고 한숨 섞인 아쉬운 목소리, 조금 느리고 낮게.`,
    shock: `${BOOTH} 남자 캐스터. 믿기지 않는 일이 벌어져 깜짝 놀랐다. 높고 빠르게, 놀란 목소리로.`,
  },
  analyst: {
    calm: `${BOOTH} 남자 해설위원(전직 선수). 캐스터 옆에서 편안하게 분석을 덧붙인다. 차분하고 낮은 목소리, 대화하듯.`,
    tense: `${BOOTH} 남자 해설위원. 위험한 상황이라 다급하게 말한다.`,
    joy: `${BOOTH} 남자 해설위원. 멋진 골에 감탄해서 흥분했다. "와아" 하고 감탄하며 웃음기 섞인 들뜬 목소리.`,
    sad: `${BOOTH} 남자 해설위원. 너무 아쉬워서 안타까워한다. 한숨을 쉬며 낮고 느리게.`,
    shock: `${BOOTH} 남자 해설위원. 믿을 수 없다는 듯 놀라서 말한다.`,
  },
};

async function speak(key, { voice, text, instructions }) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: text, instructions, response_format: 'mp3' }),
  });
  if (!res.ok) {
    const body = (await res.text()).replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***').slice(0, 300);
    throw new Error(`${res.status} ${body}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

const SAMPLES = [
  { who: 'caster', mood: 'quick', text: '안녕하십니까! 블루 레인저스 대 오렌지 시티! 지금, 경기 시작합니다!' },
  { who: 'caster', mood: 'quick', text: '백진윤에서 오승호. 오승호, 공 몰고 올라갑니다.' },
  { who: 'caster', mood: 'tense', text: '이브라힘 로시! 박스 근처까지 왔습니다! 직접 노립니다, 슛!!' },
  { who: 'caster', mood: 'shout', text: '고오오오오오올! 골! 골! 골입니다아!' },
  { who: 'caster', mood: 'joy', text: '터졌습니다! 블루 레인저스, 이브라힘 로시! 이브라힘 로시! 블루 레인저스가 앞서 나갑니다!' },
  { who: 'caster', mood: 'sad', text: '아아아, 빗나갑니다. 골문을 살짝 벗어납니다.' },
  { who: 'analyst', mood: 'calm', text: '초반 기 싸움이 중요합니다. 누가 먼저 주도권을 잡을지 보시죠.' },
  { who: 'analyst', mood: 'joy', text: '와아! 정말 대단합니다! 수비가 순간적으로 공간을 내줬어요. 놓치지 않았습니다!' },
  { who: 'analyst', mood: 'sad', text: '아, 이건 넣어 줬어야죠. 너무 아쉽습니다.' },
  { who: 'analyst', mood: 'calm', text: '오렌지 시티 수비가 간격을 잘 유지하고 있습니다. 측면을 활용하면 좋을 것 같은데요.' },
];
/** Candidate voices to compare for each seat. */
const VOICES = { caster: ['ash', 'onyx'], analyst: ['echo', 'ballad'] };
const MOOD_KO = { quick: '평소', tense: '긴박', shout: '외침', joy: '환호', sad: '아쉬움', shock: '놀람', calm: '차분' };

async function test(key) {
  const out = join(web, 'voice-test');
  mkdirSync(out, { recursive: true });
  const rows = [];
  let bytes = 0, failed = 0;
  for (const [i, s] of SAMPLES.entries()) {
    const cells = [];
    for (const voice of VOICES[s.who]) {
      const name = `${String(i + 1).padStart(2, '0')}-${s.who}-${s.mood}-${voice}.mp3`;
      try {
        const audio = await speak(key, { voice, text: s.text, instructions: DIRECTION[s.who][s.mood] });
        writeFileSync(join(out, name), audio);
        bytes += audio.length;
        cells.push(`<td><b>${voice}</b><audio controls preload="none" src="${name}"></audio></td>`);
        console.log(`ok  ${name}  ${(audio.length / 1024).toFixed(0)} KB`);
      } catch (e) {
        failed++;
        cells.push(`<td><b>${voice}</b> 실패</td>`);
        console.log(`ERR ${name}  ${e.message}`);
        if (/401|insufficient_quota|billing/i.test(e.message)) { console.log('stopping: the account cannot make this request'); return false; }
      }
    }
    rows.push(`<tr><th>${s.who === 'caster' ? '캐스터' : '해설'}<small>${MOOD_KO[s.mood]}</small></th><td class="t">${s.text}</td>${cells.join('')}</tr>`);
  }
  writeFileSync(join(out, 'index.html'), `<!doctype html><html lang="ko"><meta charset="utf-8"><title>해설 음성 시험</title>
<style>body{font:15px "Malgun Gothic",system-ui,sans-serif;background:#14321d;color:#f4f7f2;margin:24px}h1{font-size:22px}
table{border-collapse:collapse;width:100%}td,th{border-top:1px solid #ffffff2e;padding:10px 8px;text-align:left;vertical-align:middle}
th small{display:block;font-weight:400;opacity:.7}td.t{max-width:36ch;line-height:1.5}td b{display:block;font-size:12px;opacity:.75;margin-bottom:4px}audio{width:240px;height:34px}
p{opacity:.8;line-height:1.6}</style>
<h1>해설 음성 시험 — 목소리 고르기</h1>
<p>같은 문장을 목소리 두 가지로 만들었습니다. 캐스터는 <b>ash</b>와 <b>onyx</b>, 해설위원은 <b>echo</b>와 <b>ballad</b> 중에서 골라 주세요.<br>
억양과 감정(외침, 환호, 아쉬움)이 살아 있는지 들어 보시면 됩니다.</p>
<table>${rows.join('\n')}</table></html>`);
  console.log(`\n${SAMPLES.length * 2 - failed} clips, ${(bytes / 1024).toFixed(0)} KB total, ${failed} failed`);
  return failed === 0;
}

// ---- second attempt: a model that performs the line, rather than one that reads it out ----
const ACT = {
  caster: `당신은 한국 지상파 방송의 베테랑 남자 축구 캐스터입니다. 지금 만원 관중의 경기장 중계석에서 생중계 중입니다.
한국 축구 중계 특유의 말투로 말합니다: 말이 빠르고, 문장 끝을 힘 있게 올리거나 끊어 치고, 선수 이름을 또렷하게 강조하며, 결정적인 순간에는 목청껏 소리칩니다.
골 장면에서는 "고오오올"을 길게 끌며 진짜로 환호합니다. 기회를 놓치면 "아아" 하고 탄식합니다. 책을 읽는 것처럼 말하지 않습니다.
사용자가 주는 대사를 한 글자도 바꾸지 말고 그대로 연기하세요. 대사 외의 말은 절대 덧붙이지 마세요.`,
  analyst: `당신은 한국 지상파 축구 중계의 남자 해설위원입니다. 선수 출신으로, 캐스터 옆에 앉아 편하게 이야기하듯 해설합니다.
말투는 구어체로 자연스럽고("~했어요", "~거든요", "~죠"), 감탄할 때는 진심으로 감탄하고 아쉬울 때는 한숨 섞어 말합니다. 책을 읽는 것처럼 말하지 않습니다.
사용자가 주는 대사를 한 글자도 바꾸지 말고 그대로 연기하세요. 대사 외의 말은 절대 덧붙이지 마세요.`,
};
const SCENE = {
  quick: '평소 경기 진행 상황. 빠르고 리듬감 있게.', tense: '결정적인 득점 기회! 목소리가 급하게 올라가며 긴박하게.',
  shout: '방금 골이 들어갔다! 목이 터져라 길게 외치며 환호한다.', joy: '골 직후, 흥분이 가라앉지 않은 채 들뜬 목소리로 빠르게.',
  sad: '결정적인 기회를 놓쳤다. 탄식하며 아쉽게.', shock: '믿기지 않는 일이 벌어졌다. 깜짝 놀라서.', calm: '편안하게 분석을 덧붙인다.',
};

async function act(key, { model, voice, who, mood, text }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, modalities: ['text', 'audio'], audio: { voice, format: 'mp3' },
      messages: [
        { role: 'system', content: ACT[who] },
        { role: 'user', content: `[상황] ${SCENE[mood]}
[대사] ${text}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***').slice(0, 300)}`);
  const a = (await res.json()).choices?.[0]?.message?.audio;
  if (!a?.data) throw new Error('no audio in the reply');
  return { audio: Buffer.from(a.data, 'base64'), said: a.transcript ?? '' };
}

async function test2(key) {
  const out = join(web, 'voice-test');
  mkdirSync(out, { recursive: true });
  const model = 'gpt-audio-1.5';
  const voices = { caster: ['cedar', 'ash'], analyst: ['verse', 'echo'] };
  const rows = [];
  let failed = 0, changed = 0;
  for (const [i, s] of SAMPLES.entries()) {
    const cells = [];
    for (const voice of voices[s.who]) {
      const name = `r2-${String(i + 1).padStart(2, '0')}-${s.who}-${s.mood}-${voice}.mp3`;
      try {
        const r = await act(key, { model, voice, ...s });
        writeFileSync(join(out, name), r.audio);
        // The model is asked to say the line exactly; note when it did not.
        const same = r.said.replace(/[^가-힣]/g, '') === s.text.replace(/[^가-힣]/g, '');
        if (!same) changed++;
        cells.push(`<td><b>${voice}${same ? '' : ' (대사가 바뀜)'}</b><audio controls preload="none" src="${name}"></audio>${same ? '' : `<small>${r.said}</small>`}</td>`);
        console.log(`ok  ${name}  ${(r.audio.length / 1024).toFixed(0)} KB${same ? '' : '  SAID: ' + r.said}`);
      } catch (e) {
        failed++;
        cells.push(`<td><b>${voice}</b> 실패</td>`);
        console.log(`ERR ${name}  ${e.message}`);
        if (/401|insufficient_quota|billing/i.test(e.message)) return false;
      }
    }
    rows.push(`<tr><th>${s.who === 'caster' ? '캐스터' : '해설'}<small>${MOOD_KO[s.mood]}</small></th><td class="t">${s.text}</td>${cells.join('')}</tr>`);
  }
  writeFileSync(join(out, 'round2.html'), `<!doctype html><html lang="ko"><meta charset="utf-8"><title>해설 음성 시험 2차</title>
<style>body{font:15px "Malgun Gothic",system-ui,sans-serif;background:#14321d;color:#f4f7f2;margin:24px}h1{font-size:22px}
table{border-collapse:collapse;width:100%}td,th{border-top:1px solid #ffffff2e;padding:10px 8px;text-align:left;vertical-align:middle}
th small,td small{display:block;font-weight:400;opacity:.7}td.t{max-width:36ch;line-height:1.5}td b{display:block;font-size:12px;opacity:.75;margin-bottom:4px}audio{width:240px;height:34px}
p{opacity:.8;line-height:1.6}</style>
<h1>해설 음성 시험 2차 — 연기하는 모델</h1>
<p>1차는 글을 읽어 주는 모델이었고, 이번은 대사를 연기하는 모델(${model})입니다. 캐스터는 <b>cedar</b>와 <b>ash</b>, 해설위원은 <b>verse</b>와 <b>echo</b>입니다.</p>
<table>${rows.join('')}</table></html>`);
  console.log(`${SAMPLES.length * 2 - failed} clips, ${failed} failed, ${changed} said something other than the line`);
  return failed === 0;
}

// ---- the goal cry on its own: several ways of writing and directing it, to pick from ----
const GOAL_SCENE = `방금 골이 들어갔다! 경기장이 터져 나갈 듯한 함성 속에서, 캐스터가 목이 터져라 외친다.
"골"의 모음을 3초 이상 끊지 않고 길게 끌며 점점 더 크게, 음을 높여 가며 외친다 (남미·한국 축구 중계의 "고~~~~~올!" 처럼).
글자를 한 음절씩 또박또박 읽지 말고, 하나의 긴 함성으로 이어서 낸다. 숨이 찰 만큼 흥분해 있고, 진짜로 기뻐서 소리 지른다.`;
const GOAL_TAKES = [
  { id: 'a', note: '길게 한 번', text: '고오오오오오오올!' },
  { id: 'b', note: '길게 + 골입니다', text: '고오오오오올! 골입니다!' },
  { id: 'c', note: '물결표로 길게', text: '골~~~~~~~! 골! 골입니다!' },
  { id: 'd', note: '연속으로 외침', text: '골! 골! 골! 골! 고오오올!' },
  { id: 'e', note: '들어갔습니다 + 골', text: '들어갔습니다! 고오오오올!' },
  { id: 'f', note: '골 + 선수 이름', text: '고오오오올! 이브라힘 로시! 이브라힘 로시의 골입니다!' },
];

async function goal(key) {
  const out = join(web, 'voice-test');
  mkdirSync(out, { recursive: true });
  const rows = [];
  let failed = 0;
  for (const t of GOAL_TAKES) {
    const cells = [];
    for (const voice of ['cedar', 'ash']) {
      const name = `goal-${t.id}-${voice}.mp3`;
      try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-audio-1.5', modalities: ['text', 'audio'], audio: { voice, format: 'mp3' },
            messages: [{ role: 'system', content: ACT.caster }, { role: 'user', content: `[상황] ${GOAL_SCENE}\n[대사] ${t.text}` }],
          }),
        });
        if (!res.ok) throw new Error(`${res.status} ${(await res.text()).replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***').slice(0, 200)}`);
        const a = (await res.json()).choices?.[0]?.message?.audio;
        if (!a?.data) throw new Error('no audio in the reply');
        const audio = Buffer.from(a.data, 'base64');
        writeFileSync(join(out, name), audio);
        cells.push(`<td><b>${voice}</b><audio controls preload="none" src="${name}"></audio></td>`);
        console.log(`ok  ${name}  ${(audio.length / 1024).toFixed(0)} KB  said: ${a.transcript ?? ''}`);
      } catch (e) {
        failed++;
        cells.push(`<td><b>${voice}</b> 실패</td>`);
        console.log(`ERR ${name}  ${e.message}`);
      }
    }
    rows.push(`<tr><th>${t.id.toUpperCase()}<small>${t.note}</small></th><td class="t">${t.text}</td>${cells.join('')}</tr>`);
  }
  writeFileSync(join(out, 'goal.html'), `<!doctype html><html lang="ko"><meta charset="utf-8"><title>골 외침 시험</title>
<style>body{font:15px "Malgun Gothic",system-ui,sans-serif;background:#14321d;color:#f4f7f2;margin:24px}h1{font-size:22px}
table{border-collapse:collapse;width:100%}td,th{border-top:1px solid #ffffff2e;padding:10px 8px;text-align:left;vertical-align:middle}
th small{display:block;font-weight:400;opacity:.7}td.t{max-width:36ch;line-height:1.5}td b{display:block;font-size:12px;opacity:.75;margin-bottom:4px}audio{width:240px;height:34px}
p{opacity:.8;line-height:1.6}</style>
<h1>골 외침만 다시 — 6가지 × 목소리 2개</h1>
<p>골 외침을 쓰는 방법과 연기 지시를 바꿔 12개를 만들었습니다. 마음에 드는 것의 <b>기호(A~F)와 목소리</b>를 알려 주세요. 여러 개를 골라도 됩니다(게임에서 번갈아 나옵니다).</p>
<table>${rows.join('')}</table></html>`);
  console.log(`${GOAL_TAKES.length * 2 - failed} clips, ${failed} failed`);
  return failed === 0;
}

const found = apiKey();
if (!found) { console.error('No API key: put OPENAI_API_KEY=... (or open_ai=...) in web/.env.local'); process.exit(1); }
console.log(`key from ${found.from}, length ${found.key.length}`);
const mode = process.argv[2] ?? 'test';
if (mode === 'test') process.exit((await test(found.key)) ? 0 : 1);
if (mode === 'test2') process.exit((await test2(found.key)) ? 0 : 1);
if (mode === 'goal') process.exit((await goal(found.key)) ? 0 : 1);
console.error(`unknown mode: ${mode}`);
process.exit(1);
