// Headless checks for the match simulation (no browser needed).
// Run: npm run check
import { DT } from '../src/sim/constants';
import { Match, type MatchEvent } from '../src/sim/match';
import type { Actions, Player } from '../src/sim/player';
import { DIV_SIZE, divisionClubs, FORMATION_NAMES, KIT_CLASH, matchKits, MOVES, TEAMS } from '../src/sim/team';
import { customCount, playerNameOverride, resetCustom, setCrestColour, setCrestPart, setCustom, setKitColour, setPlayerName, setTeamText } from '../src/sim/custom';
import { buildRoster } from '../src/sim/roster';
import { createCup, cupOver, cupRounds, knockedOutIn, myTie, playCupRound, tieWinner } from '../src/sim/cup';

const idle = (): Actions => ({ mx: 0, mz: 0, sprint: false, held: new Set(), down: new Set(), up: new Set() });
const press = (k: string, extra: Partial<Actions> = {}): Actions => ({ ...idle(), down: new Set([k]), ...extra });
let failures = 0;
const check = (name: string, ok: boolean, info = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`);
  if (!ok) failures++;
};
// Access private methods for scenario setup.
type Internals = { foul(t: Player, v: Player, fromBehind: boolean): void };

// 1. Full AI-vs-AI 11v11 matches across teams and formations.
{
  const N = 8;
  let totalGoals = 0, totalShots = 0, worstStuck = 0, nan = false, finished = 0;
  const counts: Partial<Record<MatchEvent, number>> = {};
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const home = TEAMS[i % TEAMS.length], away = TEAMS[(i + 2) % TEAMS.length];
    const m = new Match({
      home, away, seed: i + 1, seconds: 300, humans: [],
      homeFormation: FORMATION_NAMES[i % 4], awayFormation: FORMATION_NAMES[(i + 1) % 4],
    });
    let stuck = 0;
    for (let k = 0; k < 60 * 600 && m.phase !== 'fulltime'; k++) {
      m.step({}, DT);
      for (const e of m.events) counts[e] = (counts[e] ?? 0) + 1;
      m.events.length = 0;
      const b = m.ball;
      if (m.phase === 'play' && b.ownerId === -1 && Math.hypot(b.vel.x, b.vel.z) < 0.2) stuck += DT;
      else stuck = 0;
      worstStuck = Math.max(worstStuck, stuck);
      if (!Number.isFinite(b.pos.x) || m.players.some((p) => !Number.isFinite(p.pos.x))) nan = true;
    }
    if (m.phase === 'fulltime') finished++;
    totalGoals += m.score.home + m.score.away;
    totalShots += m.shots.home + m.shots.away;
  }
  const ms = (Date.now() - t0) / N;
  check('all matches reach full time', finished === N, `${finished}/${N}`);
  check('no NaN positions', !nan);
  check('ball never sits loose and still for 4 s', worstStuck < 4, `worst=${worstStuck.toFixed(1)}s`);
  check('AI takes shots (≥ 6 per match)', totalShots / N >= 6, `avg shots=${(totalShots / N).toFixed(1)}`);
  check('goals per match between 0.5 and 7', totalGoals / N >= 0.5 && totalGoals / N <= 7, `avg goals=${(totalGoals / N).toFixed(1)}`);
  const fpm = (counts.foul ?? 0) / N;
  check('fouls per match between 1 and 14', fpm >= 1 && fpm <= 14, `${fpm.toFixed(1)}`);
  check('goal kicks happen (shots can miss)', (counts.goalkick ?? 0) > 0);
  check('simulating a 5-min match takes < 1.5 s', ms < 1500, `${ms.toFixed(0)} ms`);
  console.log('      events:', JSON.stringify(counts));
}

// 2. Human pass finds a teammate and control switches to the receiver.
{
  const m = new Match({ seed: 7 });
  while (m.phase === 'ready') m.step({ home: idle() }, DT);
  const passer = m.controlledId;
  m.step({ home: press('pass', { mx: -1, mz: 0 }) }, DT);
  // The kick lands at the end of a short wind-up.
  for (let i = 0; i < 15 && m.ball.intendedId < 0; i++) m.step({ home: idle() }, DT);
  check('pass switches control to receiver', m.controlledId !== passer && m.ball.intendedId === m.controlledId,
    `passer=${passer} now=${m.controlledId}`);
  let received = false;
  for (let i = 0; i < 180 && !received; i++) {
    m.step({ home: idle() }, DT);
    if (m.ball.ownerId === m.controlledId) received = true;
  }
  check('teammate receives the pass', received);
}

// 3. Human tackles: some win the ball, some are fouls.
{
  let wins = 0, fouls = 0;
  for (let seed = 10; seed < 50; seed++) {
    const m = new Match({ seed });
    while (m.phase === 'ready') m.step({ home: idle() }, DT);
    const carrier = m.fieldOf('away')[5];
    const me = m.controlled;
    m.ball.ownerId = carrier.id;
    carrier.pos.x = 0; carrier.pos.z = 10; carrier.facing = Math.PI;
    me.pos.x = -1.1; me.pos.z = 10; me.facing = 0;
    m.ball.pos.x = carrier.pos.x - 0.5; m.ball.pos.z = 10;
    m.step({ home: idle() }, DT);
    m.step({ home: press('shoot') }, DT);
    if (m.events.includes('foul')) fouls++;
    for (let i = 0; i < 20; i++) m.step({ home: idle() }, DT);
    if (m.owner()?.team === 'home') wins++;
  }
  check('front-on tackles win the ball 25–90%', wins >= 10 && wins <= 36, `${wins}/40`);
  check('front-on tackles are rarely fouls', fouls <= 6, `${fouls}/40`);
}

// 4. Foul in the box gives a penalty that gets taken.
{
  const m = new Match({ seed: 3, humans: [] });
  while (m.phase === 'ready') m.step({}, DT);
  const defender = m.fieldOf('away')[1];
  const attacker = m.fieldOf('home')[9];
  defender.pos.x = 45; defender.pos.z = 2;
  attacker.pos.x = 44; attacker.pos.z = 2;
  m.ball.ownerId = attacker.id;
  (m as unknown as Internals).foul(defender, attacker, false);
  const sawPenalty = m.events.includes('penalty');
  let onSpot = false, shot = false;
  for (let i = 0; i < 60 * 6; i++) {
    m.step({}, DT);
    if (m.phase === 'ready' && Math.abs(m.ball.pos.x - 41.5) < 0.2 && Math.abs(m.ball.pos.z) < 0.2) onSpot = true;
    if (m.events.includes('shot')) shot = true;
    m.events.length = 0;
  }
  check('foul in the box → penalty from the spot, then a shot', sawPenalty && onSpot && shot, `penalty=${sawPenalty} spot=${onSpot} shot=${shot}`);
}

// 5. Passing to a player beyond the defensive line is flagged offside.
{
  const m = new Match({ seed: 4 });
  while (m.phase === 'ready') m.step({ home: idle() }, DT);
  const passer = m.controlled;
  passer.pos.x = 5; passer.pos.z = 0; passer.facing = 0;
  m.ball.ownerId = passer.id;
  m.ball.pos.x = 5.5; m.ball.pos.z = 0;
  const runner = m.teammatesOf(passer).find((q) => q.slot.x > 0)!;
  runner.pos.x = 40; runner.pos.z = 0;
  // Defenders stay level at x = 25, away from the passing lane.
  m.fieldOf('away').forEach((o, i) => { o.pos.x = 25; o.pos.z = (i % 2 ? 1 : -1) * (10 + i * 2); });
  for (const q of m.teammatesOf(passer)) if (q !== runner) q.pos.z = 25;
  const pinned = m.fieldOf('away').map((o) => ({ o, x: o.pos.x, z: o.pos.z }));
  m.step({ home: press('pass', { mx: 1, mz: 0 }) }, DT);
  for (let i = 0; i < 15 && m.ball.intendedId < 0; i++) {
    m.step({ home: idle() }, DT);
    runner.pos.x = 40; runner.pos.z = 0;
    for (const p of pinned) { p.o.pos.x = p.x; p.o.pos.z = p.z; }
  }
  const aimed = m.ball.intendedId === runner.id && m.ball.offsideIds.includes(runner.id);
  let offside = false;
  for (let i = 0; i < 60 * 6 && !offside; i++) {
    m.step({ home: idle() }, DT);
    runner.pos.x = 40; runner.pos.z = m.ball.pos.z; // runner waits on the line of the ball
    for (const p of pinned) { p.o.pos.x = p.x; p.o.pos.z = p.z; }
    if (m.events.includes('offside')) offside = true;
  }
  check('offside is called', aimed && offside, `aimed=${aimed}`);
}

// 6. Ball over the sideline → throw-in for the other team, taken from the line.
{
  const m = new Match({ seed: 5, humans: [] });
  while (m.phase === 'ready') m.step({}, DT);
  m.ball.ownerId = -1;
  m.ball.pos.x = 10; m.ball.pos.z = 32; m.ball.vel.x = 0; m.ball.vel.z = 12;
  m.ball.lastTouch = 'home';
  let threw = false;
  for (let i = 0; i < 120; i++) { m.step({}, DT); if (m.events.includes('throw')) threw = true; m.events.length = 0; }
  const taker = m.owner();
  check('throw-in restarts with an away player on the line', threw && taker?.team === 'away' && Math.abs(m.ball.pos.z) > 30,
    `owner=${taker?.team} z=${m.ball.pos.z.toFixed(1)}`);
}

// 7. Assist mode: quick taps toward goal score more often than without assist.
{
  const run = (assist: boolean) => {
    let goals = 0, onTarget = 0;
    for (let seed = 100; seed < 160; seed++) {
      const m = new Match({ seed, assist: assist ? ['home'] : [] });
      while (m.phase === 'ready') m.step({ home: idle() }, DT);
      const me = m.controlled;
      // Clear defenders away; only the keeper remains.
      for (const o of m.fieldOf('away')) { o.pos.x = -30; }
      const z = ((seed % 5) - 2) * 4;
      me.pos.x = 33; me.pos.z = z; me.facing = 0;
      m.ball.ownerId = me.id; m.ball.pos.x = 33.5; m.ball.pos.z = z;
      // Stick roughly toward goal, quick tap on shoot.
      const dx = 52.5 - 33, dz = -z * 0.5, L = Math.hypot(dx, dz);
      m.step({ home: { ...idle(), mx: dx / L, mz: dz / L, held: new Set(['shoot']), down: new Set(['shoot']) } }, DT);
      m.step({ home: { ...idle(), mx: dx / L, mz: dz / L, up: new Set(['shoot']) } }, DT);
      let target = false;
      for (let i = 0; i < 150; i++) {
        m.step({ home: idle() }, DT);
        if (m.events.includes('save') || m.events.includes('goal_home')) target = true;
        m.events.length = 0;
        for (const o of m.fieldOf('away')) o.pos.x = -30;
      }
      goals += m.score.home;
      if (target) onTarget++;
    }
    return { goals, onTarget };
  };
  const off = run(false), on = run(true);
  check('assist raises tap-shot goals', on.goals > off.goals, `assist ${on.goals}/60 (on target ${on.onTarget}) vs manual ${off.goals}/60 (on target ${off.onTarget})`);
}

// 8. Season-feel features over full AI matches: stamina, subs, cards, blocks.
{
  const counts: Partial<Record<MatchEvent, number>> = {};
  let endEnergy = 0, n = 0;
  for (let seed = 200; seed < 206; seed++) {
    const m = new Match({ seed, humans: [], home: TEAMS[seed % 5], away: TEAMS[(seed + 1) % 5] });
    for (let k = 0; k < 60 * 600 && m.phase !== 'fulltime'; k++) {
      m.step({}, DT);
      for (const e of m.events) counts[e] = (counts[e] ?? 0) + 1;
      m.events.length = 0;
      m.notices.length = 0;
    }
    for (const p of m.players) if (p.role === 'field' && !p.sentOff) { endEnergy += p.energy; n++; }
  }
  const avg = endEnergy / n;
  check('players tire over a match (avg energy at full time 0.3–0.9)', avg > 0.3 && avg < 0.9, avg.toFixed(2));
  check('AI managers make substitutions', (counts.sub ?? 0) > 0, `${counts.sub ?? 0} subs in 6 matches`);
  check('referee shows yellow cards', (counts.yellow ?? 0) > 0, `${counts.yellow ?? 0} yellows, ${counts.red ?? 0} reds`);
  check('defenders block shots and passes', (counts.block ?? 0) > 0, `${counts.block ?? 0} blocks`);
}

// 9. Second half: ends switch and goals still count for the right team.
{
  const m = new Match({ seed: 9, humans: [], seconds: 60 });
  while (m.half === 1) m.step({}, DT);
  while (m.phase !== 'play') m.step({}, DT);
  const swapped = m.dir('home') === -1 && m.keepers.home.side === 1 && m.keepers.away.side === -1;
  // Roll the ball into the goal at x = -52.5, which home now attacks.
  m.ball.ownerId = -1; m.ball.held = false;
  m.ball.pos.x = -46; m.ball.pos.z = 0; m.ball.pos.y = 0.11;
  m.ball.vel.x = -30; m.ball.vel.z = 0; m.ball.vel.y = 0;
  m.keepers.away.p.pos.z = 20; // keeper out of the way
  m.ball.lastTouch = 'home';
  const before = m.score.home;
  for (let i = 0; i < 60 && m.score.home === before; i++) { m.step({}, DT); m.keepers.away.p.pos.z = 20; }
  check('ends switch at half time and home scores at the other goal', swapped && m.score.home === before + 1, `swapped=${swapped} home=${m.score.home}`);
}

// 10. Human substitution waits for a stoppage, then a new player comes on.
{
  const m = new Match({ seed: 11 });
  while (m.phase === 'ready') m.step({ home: idle() }, DT);
  const out = m.fieldOf('home')[2];
  const oldName = out.name, oldVersion = out.version;
  const benchIdx = m.squads.home.bench.findIndex((r) => r.cat !== 'GK');
  const inName = m.squads.home.bench[benchIdx].name;
  const ok = m.requestSub('home', out.id, benchIdx);
  m.step({ home: idle() }, DT);
  const stillOld = out.name === oldName;
  // Force a stoppage: ball over the sideline.
  m.ball.ownerId = -1; m.ball.pos.z = 33.5; m.ball.vel.z = 10; m.ball.lastTouch = 'away';
  for (let i = 0; i < 150; i++) m.step({ home: idle() }, DT);
  check('substitution happens at the next stoppage', ok && stillOld && out.name === inName && out.version > oldVersion && m.squads.home.subsLeft === 2,
    `${oldName} → ${out.name}`);
}

// 11. Free kick near goal brings a defensive wall 9.15 m away.
{
  const m = new Match({ seed: 12, humans: [] });
  while (m.phase === 'ready') m.step({}, DT);
  const t = m.fieldOf('away')[3], v = m.fieldOf('home')[9];
  t.pos.x = 30; t.pos.z = 6; v.pos.x = 31; v.pos.z = 6;
  m.ball.ownerId = v.id; m.ball.pos.x = 31.5; m.ball.pos.z = 6;
  (m as unknown as Internals).foul(t, v, false);
  for (let i = 0; i < 100; i++) { m.step({}, DT); if (m.phase === 'ready') break; }
  const ball = m.ball.pos;
  const wall = m.fieldOf('away').filter((p) => Math.abs(Math.hypot(p.pos.x - ball.x, p.pos.z - ball.z) - 9.15) < 0.9 && p.pos.x > ball.x);
  check('free kick in range gets a wall of 3–4 defenders', wall.length >= 3, `${wall.length} in the wall`);
}

// 12. Against the same normal-level opponent, hard AI does better than easy AI.
{
  const margin = (level: 'easy' | 'hard') => {
    let diff = 0;
    for (let seed = 300; seed < 308; seed++) {
      const m = new Match({ seed, humans: [], seconds: 180, levels: { home: 'normal', away: level } });
      for (let k = 0; k < 60 * 400 && m.phase !== 'fulltime'; k++) { m.step({}, DT); m.events.length = 0; m.notices.length = 0; }
      diff += m.score.away - m.score.home;
    }
    return diff;
  };
  const easy = margin('easy'), hard = margin('hard');
  check('hard AI beats a normal team by more than easy AI does', hard > easy + 3, `goal difference: easy ${easy}, hard ${hard}`);
}

// 13. Every club plays a full match without stalling (32 teams, 16 pairings, both halves).
{
  let ok = 0, maxRestarts = 0;
  for (let i = 0; i < 16; i++) {
    const m = new Match({ seed: 400 + i, humans: [], seconds: 180, home: TEAMS[i], away: TEAMS[i + 16],
      homeFormation: TEAMS[i].formation, awayFormation: TEAMS[i + 16].formation });
    let restarts = 0;
    for (let k = 0; k < 60 * 400 && m.phase !== 'fulltime'; k++) {
      m.step({}, DT);
      restarts += m.events.filter((e) => e === 'throw' || e === 'corner').length;
      m.events.length = 0; m.notices.length = 0;
    }
    if (m.phase === 'fulltime') ok++;
    maxRestarts = Math.max(maxRestarts, restarts);
  }
  check('all 32 clubs finish their matches, no restart loops', ok === 16 && maxRestarts < 40, `${ok}/16 finished, max throw-ins+corners ${maxRestarts}`);
}

// 14. Goal celebration: scorer runs to the corner, teammates follow, any button skips to kickoff.
{
  const m = new Match({ seed: 21 });
  while (m.phase === 'ready') m.step({ home: idle() }, DT);
  const shooter = m.controlled;
  shooter.pos.x = 44; shooter.pos.z = 2; shooter.facing = 0;
  m.ball.ownerId = shooter.id; m.ball.pos.x = 44.5; m.ball.pos.z = 2;
  m.keepers.away.p.pos.z = -3.5;
  const held = new Set(['shoot']);
  m.step({ home: { ...idle(), mx: 1, mz: 0.08, held, down: new Set(['shoot']) } }, DT);
  for (let i = 0; i < 30; i++) m.step({ home: { ...idle(), mx: 1, mz: 0.08, held } }, DT);
  m.step({ home: { ...idle(), up: new Set(['shoot']) } }, DT);
  for (let i = 0; i < 120 && m.phase !== 'goal'; i++) { m.step({ home: idle() }, DT); m.keepers.away.p.pos.z = -3.5; }
  const scored = m.phase === 'goal' && m.lastGoal?.scorerId === shooter.id;
  const startDist = Math.hypot(shooter.pos.x - 45.5, shooter.pos.z - 29);
  for (let i = 0; i < 100; i++) m.step({ home: idle() }, DT);
  const ranToCorner = Math.hypot(shooter.pos.x - 45.5, shooter.pos.z - 29) < startDist - 5 && shooter.celebrate === 1;
  const mates = m.fieldOf('home').filter((p) => p.celebrate === 2).length;
  m.step({ home: press('pass') }, DT);
  for (let i = 0; i < 3; i++) m.step({ home: idle() }, DT);
  const skipped = m.phase === 'ready';
  check('goal → scorer celebrates at the corner, teammates join, button skips', scored && ranToCorner && mates === 9 && skipped,
    `scored=${scored} corner=${ranToCorner} mates=${mates} skipped=${skipped}`);
}

// 15. Dribbling by touches: the ball runs ahead and is knocked on, not glued to the foot.
{
  const m = new Match({ seed: 31, humans: ['home'] });
  while (m.phase === 'ready') m.step({ home: idle() }, DT);
  const me = m.controlled;
  // Clear the way.
  for (const o of m.fieldOf('away')) { o.pos.x = -40; o.pos.z = -30; }
  me.pos.x = -20; me.pos.z = 0; me.facing = 0;
  m.ball.ownerId = me.id; m.ball.pos.x = -19.5; m.ball.pos.z = 0;
  let touches = 0, minGap = 9, maxGap = 0, kept = true;
  for (let i = 0; i < 60 * 3; i++) {
    const before = me.touchAnim;
    m.step({ home: { ...idle(), mx: 1, sprint: true } }, DT);
    for (const o of m.fieldOf('away')) { o.pos.x = -40; o.pos.z = -30; }
    if (me.touchAnim > before) touches++;
    if (i > 30) {
      const gap = Math.hypot(m.ball.pos.x - me.pos.x, m.ball.pos.z - me.pos.z);
      minGap = Math.min(minGap, gap); maxGap = Math.max(maxGap, gap);
    }
    if (m.ball.ownerId !== me.id) kept = false;
  }
  check('dribble: 3–9 touches in 3 s of sprinting, ball runs 0.4–3 m ahead, never lost',
    kept && touches >= 3 && touches <= 9 && minGap > 0.2 && maxGap > 1.0 && maxGap < 3,
    `touches=${touches} gap ${minGap.toFixed(2)}–${maxGap.toFixed(2)} m kept=${kept}`);
}

// League season: a full calendar, every round settled, a consistent table.
{
  const { createLeague, isOver, myFixture, playRound, table, expectedGoals } = await import('../src/sim/league');
  for (const legs of [1, 2] as const) {
    const s = createLeague({ team: 3, legs, seed: 4242 + legs, minutes: 5, difficulty: 'normal', offside: true, assist: false });
    const n = DIV_SIZE;
    const pairs = new Map<string, number>();
    let roundsOk = true, mineOk = true;
    for (const round of s.rounds) {
      const seen = new Set<number>();
      for (const [h, a] of round) { seen.add(h); seen.add(a); pairs.set(`${h}-${a}`, (pairs.get(`${h}-${a}`) ?? 0) + 1); }
      if (seen.size !== n || round.length !== n / 2) roundsOk = false;
    }
    // Every pairing appears once per leg (in either order for one leg, each order once for two).
    let pairOk = true;
    for (const i of s.clubs) for (const j of s.clubs) {
      if (i >= j) continue;
      const ab = pairs.get(`${i}-${j}`) ?? 0, ba = pairs.get(`${j}-${i}`) ?? 0;
      if (legs === 1 ? ab + ba !== 1 : ab !== 1 || ba !== 1) pairOk = false;
    }
    const homes = s.clubs.map((t) => s.rounds.filter((r) => r.some(([h]) => h === t)).length);
    let k = 0;
    while (!isOver(s)) {
      const f = myFixture(s)!;
      const mine: [number, number] | null = k % 2 === 0 ? [2, 1] : null;
      const idx = f.index, r = s.round;
      playRound(s, mine);
      if (mine && (s.results[r][idx]![0] !== 2 || s.results[r][idx]![1] !== 1)) mineOk = false;
      k++;
    }
    const rows = table(s);
    const games = (n - 1) * legs;
    const played = rows.every((r) => r.played === games && r.won + r.drawn + r.lost === games);
    const gf = rows.reduce((x, r) => x + r.gf, 0), ga = rows.reduce((x, r) => x + r.ga, 0);
    const sorted = rows.every((r, i) => i === 0 || rows[i - 1].pts >= r.pts);
    const avg = gf / (games * n / 2);
    check(`league (${legs} leg): calendar complete, table adds up`, roundsOk && pairOk && mineOk && played && gf === ga && sorted && avg > 1.6 && avg < 4 && Math.max(...homes) - Math.min(...homes) <= 1,
      `rounds=${s.rounds.length} home games ${Math.min(...homes)}–${Math.max(...homes)} goals/match=${avg.toFixed(2)} champion=${TEAMS[rows[0].team].short} ${rows[0].pts}pts`);
  }
  const [xh, xa] = expectedGoals(TEAMS[0], TEAMS[0]);
  check('league: home side has the edge between equal teams', xh > xa, `${xh.toFixed(2)} vs ${xa.toFixed(2)}`);
}

// Penalty shoot-out: kicks alternate from the spot until one side cannot be caught.
{
  // Run a knock-out match straight to the end of extra time with the scores level.
  const toShootout = (seed: number, humans: ('home' | 'away')[]) => {
    const m = new Match({ seed, humans, seconds: 60, home: TEAMS[1], away: TEAMS[5], decider: true });
    m.time = 59.9;
    for (let k = 0; k < 60 * 30 && !m.extraTime; k++) { m.score.home = m.score.away; m.step({}, DT); m.events.length = 0; }
    m.time = 60 * (4 / 3) - 0.05;
    for (let k = 0; k < 60 * 30 && !m.pens; k++) { m.score.home = m.score.away; m.step({}, DT); m.events.length = 0; }
    return m;
  };
  let ok = true, kicks = 0, goals = 0, offSpot = 0, longest = 0, shootouts = 0;
  for (let i = 0; i < 12; i++) {
    const m = toShootout(40 + i, []);
    if (!m.pens) { ok = false; continue; }
    shootouts++;
    const order: string[] = [];
    let kickId = m.ball.kickId, last = { x: m.ball.pos.x, z: m.ball.pos.z }, ended = 0;
    const far = m.players.filter((p) => p.role === 'field');
    for (let k = 0; k < 60 * 240 && m.phase !== 'fulltime'; k++) {
      const turn = m.pens?.turn, taker = m.pens && !m.pens.live ? m.pens.taker : -1;
      m.step({}, DT);
      if (m.ball.kickId !== kickId) {
        kickId = m.ball.kickId;
        if (m.pens && taker !== undefined && taker >= 0 && m.ball.kickerId === taker) {
          // Struck from the spot at the +x end, by the side whose turn it is.
          if (Math.hypot(last.x - (52.5 - 11), last.z) > 0.25) offSpot++;
          if (m.players[m.ball.kickerId].team !== turn) ok = false;
        }
      }
      for (const e of m.events) {
        if (e === 'pen_goal' || e === 'pen_saved' || e === 'pen_missed') { order.push(turn!); kicks++; if (e === 'pen_goal') goals++; }
        if (e === 'fulltime') ended++;
      }
      m.events.length = 0;
      // Nobody but the taker and the keeper comes near the ball.
      if (m.pens && m.phase === 'play' && far.some((p) => p.id !== m.pens!.taker && Math.hypot(p.pos.x - m.ball.pos.x, p.pos.z - m.ball.pos.z) < 6 && Math.abs(p.pos.x) > 30)) ok = false;
      last = { x: m.ball.pos.x, z: m.ball.pos.z };
    }
    const s = m.shootout!;
    const h = order.filter((t) => t === 'home').length, a = order.length - h;
    longest = Math.max(longest, order.length);
    if (m.phase !== 'fulltime' || ended !== 1 || m.pens || s.home === s.away || m.winner === null || m.score.home !== m.score.away) ok = false;
    if (Math.abs(h - a) > 1 || order.some((t, j) => j > 0 && t === order[j - 1])) ok = false; // strictly alternating
    if (order.length < 6 || (order.length < 10 && Math.max(s.home, s.away) < 3)) ok = false;   // not ended early
  }
  const rate = goals / Math.max(1, kicks);
  check('shoot-out: sides alternate from the spot, it ends when one cannot be caught, AI scores 55–92%', ok && shootouts === 12 && offSpot === 0 && rate > 0.55 && rate < 0.92,
    `${shootouts} shoot-outs, ${kicks} kicks, ${(rate * 100).toFixed(0)}% scored, ${offSpot} not from the spot, longest ${longest} kicks`);

  // A person takes the kick with the shoot button; doing nothing is a miss after a while.
  const m = toShootout(77, ['home']);
  let took = false, timedOut = false, humanKicks = 0, waited = 0;
  for (let k = 0; k < 60 * 400 && m.phase !== 'fulltime' && m.pens; k++) {
    const mine = m.pens.turn === 'home' && m.phase === 'play' && !m.pens.live;
    // Take the first kick properly, leave the second one alone.
    const act = mine && humanKicks === 0 ? (k % 20 < 4 ? press('shoot') : { ...idle(), up: new Set(['shoot']) }) : idle();
    if (mine && humanKicks === 1) waited += DT;
    const before = m.pens.kicks.home.length, kickId = m.ball.kickId, taker = m.pens.taker;
    m.step({ home: act }, DT);
    if (m.ball.kickId !== kickId && taker >= 0 && m.ball.kickerId === taker && m.players[taker].team === 'home' && humanKicks === 0) took = true;
    if (m.pens && m.pens.kicks.home.length > before) { humanKicks++; if (humanKicks === 2 && waited > 8 && !m.pens.kicks.home[1]) timedOut = true; }
    m.events.length = 0;
    if (humanKicks >= 2) break;
  }
  check('shoot-out: a person takes the kick with the shoot button, and a kick not taken is a miss', took && timedOut, `took=${took} timed out=${timedOut} after ${waited.toFixed(1)} s`);
  // A person in goal: he goes the way the stick is held, stays put without it, and saves more by going the right way.
  {
    const run = (guess: 'right' | 'wrong' | 'none') => {
      let faced = 0, saved = 0, dives = 0, moved = 0;
      for (let i = 0; i < 10; i++) {
        const g = toShootout(120 + i, ['home']);
        for (let k = 0; k < 60 * 300 && g.phase !== 'fulltime' && g.pens; k++) {
          const facing = g.pens.turn === 'away' && g.phase === 'play';
          // The shot's direction is known a moment after it is struck, inside the time allowed for a late dive.
          const vz = g.pens.live ? Math.sign(g.ball.vel.z) || 1 : 0;
          const mz = !facing || guess === 'none' ? 0 : guess === 'right' ? vz : -vz;
          // On the player's own kicks, shoot.
          const act = g.pens.turn === 'home' && g.phase === 'play' && !g.pens.live ? (k % 20 < 4 ? press('shoot') : { ...idle(), up: new Set(['shoot']) }) : { ...idle(), mz };
          const z0 = g.keepers.home.p.pos.z, was = g.keepers.home.state;
          g.step({ home: act }, DT);
          if (facing && was === 'guard' && g.keepers.home.state === 'dive') { dives++; }
          if (facing && g.pens?.live) moved = Math.max(moved, Math.abs(g.keepers.home.p.pos.z - z0) / DT);
          for (const e of g.events) {
            if ((e === 'pen_goal' || e === 'pen_saved' || e === 'pen_missed') && facing) { faced++; if (e === 'pen_saved') saved++; }
          }
          g.events.length = 0;
        }
      }
      return { faced, saved, dives, moved };
    };
    const right = run('right'), wrong = run('wrong'), none = run('none');
    check('shoot-out: a person in goal dives the way the stick is held, and going the right way saves kicks',
      right.faced > 25 && right.dives >= right.faced * 0.9 && none.dives === 0 && right.saved / right.faced > 0.3 && right.saved > wrong.saved * 2 && wrong.saved / Math.max(1, wrong.faced) < 0.15,
      `right way: ${right.saved}/${right.faced} saved (${right.dives} dives), wrong way: ${wrong.saved}/${wrong.faced}, no stick: ${none.saved}/${none.faced} saved with ${none.dives} dives`);
  }
}

// Club development: players grow and age, money comes in, signings and sales keep a workable squad.
{
  const C = await import('../src/sim/career');
  const L = await import('../src/sim/league');
  const { playerOverall } = await import('../src/sim/roster');
  const c = C.createCareer({ team: 20, legs: 1, seed: 555, minutes: 5, difficulty: 'normal', offside: true, assist: false });
  const start = { money: c.money, rating: C.squadRating(c), size: c.squad.length };
  const young = c.squad.filter((p) => p.age <= 22 && p.potential - playerOverall(p) >= 5).map((p) => ({ p, was: playerOverall(p) }));
  const startOk = c.league.division === 2 && c.squad.length === 16 && c.market.length === 10 && c.squad.every((p) => p.age >= 18 && p.age <= 33 && p.potential >= playerOverall(p));
  // A match with the career squad: the sixteen who travel are the ones on the pitch and the bench.
  const squad = C.matchSquad(c);
  const m = new Match({ seed: 9, humans: [], home: TEAMS[20], away: TEAMS[21], rosters: { home: squad } });
  const names = new Set(squad.map((p) => p.name));
  const matchOk = squad.length === 16 && squad.filter((p) => p.cat === 'GK').length === 2
    && m.players.filter((p) => p.team === 'home').every((p) => names.has(p.name)) && m.squads.home.bench.length === 5;
  // Transfers: cannot overspend, cannot strip the squad.
  const cheap = [...c.market].sort((a, b) => C.playerValue(a) - C.playerValue(b))[0];
  const dear = [...c.market].sort((a, b) => C.playerValue(b) - C.playerValue(a))[0];
  c.money = C.playerValue(cheap);
  const refused = dear !== cheap && C.playerValue(dear) > c.money ? !C.buy(c, dear.id) : true;
  const bought = C.buy(c, cheap.id) && c.squad.length === 17 && c.money === 0 && cheap.number > 0;
  const sold = C.sell(c, cheap.id) && c.squad.length === 16;
  const floor = !C.sell(c, c.squad[5].id) && c.squad.length === 16;
  // Three seasons, alternating played and skipped rounds.
  let seasons = 0, retired = 0, ok = true;
  c.money = start.money;
  for (; seasons < 3; seasons++) {
    let k = 0;
    while (!L.isOver(c.league)) {
      const played = k++ % 2 === 0;
      L.playRound(c.league, played ? [2, 1] : null, C.careerClub(c));
      C.afterRound(c, played);
      if (c.market.length !== 10) ok = false;
    }
    const before = c.squad.map((p) => p.id);
    const next = L.nextSeason(c.league, 700 + seasons);
    C.afterSeason(c, next);
    retired += before.filter((id) => !c.squad.some((p) => p.id === id)).length;
    if (c.league !== next || c.league.season !== seasons + 2 || c.squad.length < 16 || c.squad.length > C.SQUAD_MAX) ok = false;
    if (c.squad.filter((p) => p.cat === 'GK').length < 2) ok = false;
  }
  const grew = young.filter((y) => playerOverall(y.p) > y.was).length;
  const sane = c.squad.every((p) => Object.values(p.stats).every((v) => Number.isFinite(v) && v >= 35 && v <= 97) && p.name.length > 0);
  const saved = JSON.parse(JSON.stringify(c));
  check('career: squad grows with play, ages by season, money comes in, transfers keep a workable squad',
    startOk && matchOk && refused && bought && sold && floor && ok && sane && c.money > start.money && (young.length === 0 || grew >= young.length / 2) && c.history.length === 3 && saved.squad.length === c.squad.length,
    `start ok=${startOk} match ok=${matchOk} transfers=${refused}/${bought}/${sold}/${floor} young players improved ${grew}/${young.length}, best XI ${start.rating}→${C.squadRating(c)}, money ${start.money}→${c.money}, retired ${retired}, history ${c.history.map((h) => `${h.division}부 ${h.position}위`).join(', ')}`);
}

// Club development: an eleven picked by hand is the one that plays; contracts run out; training steers growth.
{
  const C = await import('../src/sim/career');
  const L = await import('../src/sim/league');
  const { playerOverall } = await import('../src/sim/roster');
  const mk = () => C.createCareer({ team: 22, legs: 1, seed: 99, minutes: 5, difficulty: 'normal', offside: true, assist: false });
  const c = mk();
  const first = C.lineup(c);
  const auto = !c.lineup && first.starters.length === 11 && first.starters[0].cat === 'GK';
  // A reserve for a starter, two starters swapping places, and what is not allowed.
  const out = first.starters[9], sub = first.bench.find((p) => p.cat !== 'GK')!, gk2 = first.bench.find((p) => p.cat === 'GK')!;
  const swapped = C.swap(c, out.id, sub.id) && C.lineup(c).starters[9] === sub && C.lineup(c).bench.includes(out);
  const a = C.lineup(c).starters[2], b = C.lineup(c).starters[7];
  const moved = C.swap(c, a.id, b.id) && C.lineup(c).starters[2] === b && C.lineup(c).starters[7] === a;
  const blocked = !C.swap(c, C.lineup(c).starters[0].id, sub.id) && !C.swap(c, gk2.id, a.id) && !C.swap(c, out.id, first.bench.find((p) => p !== sub && p !== out && p.cat !== 'GK')!.id);
  const keeper = C.swap(c, C.lineup(c).starters[0].id, gk2.id) && C.lineup(c).starters[0] === gk2;
  // The match fields exactly that eleven, slot by slot.
  const eleven = C.lineup(c).starters.map((p) => p.name);
  const m = new Match({ seed: 4, humans: [], home: TEAMS[22], away: TEAMS[23], rosters: { home: C.matchSquad(c) }, lineupGiven: ['home'] });
  const fielded = m.players.filter((p) => p.team === 'home').map((p) => p.name);
  const plays = eleven.every((n, i) => fielded[i] === n) && m.squads.home.bench.length === 5 && m.squads.home.bench.some((p) => p.cat === 'GK');
  // A change of formation keeps the same eleven; a sold starter is replaced; automatic picks the best again.
  const before = new Set(C.lineup(c).starters.map((p) => p.id));
  c.league.formation = '3-5-2';
  const kept = C.lineup(c).starters.every((p) => before.has(p.id)) && C.lineup(c).starters[0].cat === 'GK';
  c.squad = c.squad.filter((p) => p !== sub);
  const repaired = C.lineup(c).starters.length === 11 && !C.lineup(c).starters.includes(sub) && new Set(C.lineup(c).starters).size === 11;
  C.autoLineup(c);
  const back = !c.lineup;

  // Contracts: wages are paid each round, a contract that runs out costs the player, renewing keeps him.
  const d = mk();
  const bill = C.wageBill(d);
  const leaving = d.squad.filter((p) => p.contract === 1 && p.age < 33);
  const keep = leaving[0], go = leaving[1];
  d.money = 100;
  const renewed = !!keep && C.renew(d, keep.id) && keep.contract === 3 && d.money < 100;
  const capped = !!keep && C.renew(d, keep.id) && !C.renew(d, keep.id) && keep.contract === 5;
  const m0 = d.money;
  L.playRound(d.league, [1, 1], C.careerClub(d));
  C.afterRound(d, true);
  const paid = bill > 0.3 && bill < 2.5 && Math.abs(d.money - (m0 + 1.5 * (L.myFixture(d.league, 0)!.home ? 1.2 : 1) - bill)) < 0.26;
  while (!L.isOver(d.league)) { L.playRound(d.league, null, C.careerClub(d)); C.afterRound(d, false); }
  C.afterSeason(d, L.nextSeason(d.league, 5));
  const left = !!go && !d.squad.includes(go) && d.squad.includes(keep) && d.squad.length >= 16 && d.news.some((n) => n.includes('계약 만료'));

  // Training: the focus is what improves most; a one-to-one session gives a point, once a round, for money.
  const gain = (focus: 'balance' | 'shoot') => {
    const e = mk();
    e.focus = focus;
    const was = e.squad.map((p) => ({ p, shoot: p.stats.shoot, rest: p.stats.speed + p.stats.dribble + p.stats.pass + p.stats.defense }));
    while (!L.isOver(e.league)) { L.playRound(e.league, [2, 1], C.careerClub(e)); C.afterRound(e, true); }
    return { shoot: was.reduce((x, w) => x + w.p.stats.shoot - w.shoot, 0), rest: was.reduce((x, w) => x + w.p.stats.speed + w.p.stats.dribble + w.p.stats.pass + w.p.stats.defense - w.rest, 0) };
  };
  const even = gain('balance'), lean = gain('shoot');
  const steered = lean.shoot > even.shoot * 1.4 && lean.rest < even.rest;
  const t = mk();
  t.focus = 'pass';
  const pupil = t.squad.find((p) => p.cat === 'MF' && p.potential - playerOverall(p) > 2)!;
  const full = t.squad.find((p) => p.potential - playerOverall(p) <= 0);
  t.money = 50;
  const pass0 = pupil.stats.pass;
  const drilled = C.drill(t, pupil.id) !== null && pupil.stats.pass === pass0 + 1 && t.money < 50;
  const once = C.drill(t, pupil.id) === null && (!full || C.drillBlock(t, full) !== null);
  L.playRound(t.league, null, C.careerClub(t)); C.afterRound(t, false);
  const again = C.drillBlock(t, pupil) === null || pupil.potential - playerOverall(pupil) <= 0;

  // The economy still works with wages: three seasons of ordinary results do not bankrupt the club.
  const z = mk();
  let low = z.money;
  for (let sN = 0; sN < 3; sN++) {
    let k = 0;
    while (!L.isOver(z.league)) { L.playRound(z.league, [[2, 1], [1, 1], [0, 1]][k++ % 3] as [number, number], C.careerClub(z)); C.afterRound(z, true); low = Math.min(low, z.money); }
    for (const p of z.squad) if (p.contract <= 1 && !C.renewBlock(z, p)) C.renew(z, p.id);
    C.afterSeason(z, L.nextSeason(z.league, 40 + sN));
  }
  const solvent = low > 5 && z.money > 25;
  const old = JSON.parse(JSON.stringify(mk()));
  for (const p of [...old.squad, ...old.market]) { delete p.contract; delete p.wage; }
  check('career: a hand-picked eleven plays, contracts run out or are renewed, training steers growth',
    auto && swapped && moved && blocked && keeper && plays && kept && repaired && back && renewed && capped && paid && left && steered && drilled && once && again && solvent,
    `line-up auto=${auto} sub=${swapped} swap=${moved} refusals=${blocked} keeper=${keeper} fielded=${plays} formation=${kept} repaired=${repaired} reset=${back}; wages ${bill}억/round paid=${paid} renewed=${renewed}/${capped} left=${left}; focus shoot +${lean.shoot} vs +${even.shoot} (others +${lean.rest} vs +${even.rest}), drill=${drilled}/${once}/${again}; money over 3 seasons low ${low.toFixed(1)} end ${z.money.toFixed(1)}`);
}

// Automatic switching: without the ball, control settles on a player near it and does not flicker.
{
  let near = 0, ticks = 0, switches = 0, seconds = 0;
  for (let g = 0; g < 3; g++) {
    const m = new Match({ seed: 60 + g, humans: ['home'], seconds: 600, home: TEAMS[2 + g], away: TEAMS[9 + g] });
    let last = m.ctrl.home;
    for (let k = 0; k < 60 * 40; k++) {
      m.step({ home: idle() }, DT);
      m.events.length = 0;
      const o = m.owner();
      if (m.phase !== 'play' || !o || o.team !== 'away' || o.role !== 'field') { last = m.ctrl.home; continue; }
      seconds += DT;
      if (m.ctrl.home !== last) { switches++; last = m.ctrl.home; }
      // Is the controlled player among the three home players nearest the ball?
      const d = (p: Player) => Math.hypot(p.pos.x - m.ball.pos.x, p.pos.z - m.ball.pos.z);
      const order = m.players.filter((p) => p.team === 'home' && p.role === 'field' && !p.sentOff).sort((x, y) => d(x) - d(y));
      ticks++;
      if (order.slice(0, 3).some((p) => p.id === m.ctrl.home)) near++;
    }
  }
  const share = near / Math.max(1, ticks), rate = switches / Math.max(1, seconds);
  check('auto switch: while defending, control stays with a player near the ball without flickering', ticks > 600 && share > 0.85 && rate < 1.2,
    `one of the 3 nearest ${(share * 100).toFixed(0)}% of the time, ${rate.toFixed(2)} switches a second over ${seconds.toFixed(0)} s`);
}

// Switching player: with the stick at rest the new player goes for the ball; moving the stick takes over.
{
  const m = new Match({ seed: 31, humans: ['home'], seconds: 600 });
  const still = idle();
  // Leave the pad alone until the other side has the ball and control has passed to a nearby player.
  let k = 0;
  for (; k < 60 * 60; k++) {
    m.step({ home: still }, DT);
    const o = m.owner();
    if (m.phase === 'play' && o && o.team === 'away' && o.role === 'field' && m.autoRun.home) break;
  }
  const found = m.autoRun.home;
  const me = m.players[m.ctrl.home];
  const d0 = Math.hypot(me.pos.x - m.ball.pos.x, me.pos.z - m.ball.pos.z);
  let moved = 0, top = 0;
  for (let i = 0; i < 45 && m.phase === 'play' && m.ctrl.home === me.id; i++) {
    const x = me.pos.x, z = me.pos.z;
    m.step({ home: still }, DT);
    moved += Math.hypot(me.pos.x - x, me.pos.z - z);
    top = Math.max(top, Math.hypot(me.vel.x, me.vel.z));
  }
  // The button does the same: switch, and the next player sets off too.
  const before = m.ctrl.home;
  m.step({ home: press('switch') }, DT);
  const switched = m.ctrl.home !== before, runs = m.autoRun.home;
  // Touching the stick ends it.
  m.step({ home: { ...idle(), mx: 0, mz: 1 } }, DT);
  const handed = !m.autoRun.home;
  check('switching player: he runs for the ball until the stick is moved', found && moved > 1.5 && top > 3 && switched && runs && handed,
    `auto-run=${found} ran ${moved.toFixed(1)} m in 0.75 s from ${d0.toFixed(1)} m away (top ${top.toFixed(1)} m/s), button switch=${switched}/${runs}, stick takes over=${handed}`);
}

// Feet and ball: touches and kicks only happen where a foot can reach the ball.
{
  const { createPlayer, dribble, movePlayer, tickTimers, FOOT_REACH, FOLLOW_THROUGH } = await import('../src/sim/player');
  const { createBall, stepBall } = await import('../src/sim/ball');
  // Dribbling through turns, cuts, stops and changes of pace.
  const runs: [string, (t: number) => [number, number, boolean]][] = [
    ['zigzag', (t) => [Math.cos((Math.floor(t / 1.2) % 2 ? 1 : -1) * 0.6), Math.sin((Math.floor(t / 1.2) % 2 ? 1 : -1) * 0.6), false]],
    ['cuts', (t) => [Math.cos(Math.floor(t / 2) * Math.PI / 2), Math.sin(Math.floor(t / 2) * Math.PI / 2), false]],
    ['turn back', (t) => [Math.floor(t / 2.5) % 2 ? -1 : 1, 0, false]],
    ['curve sprint', (t) => [Math.cos(t * 0.5), Math.sin(t * 0.5), true]],
    ['stop and go', (t) => (t % 2 > 1.4 ? [0, 0, false] : [1, 0, Math.floor(t / 2) % 2 === 1])],
  ];
  let touches = 0, far = 0, worst = 0, lost = false, fewest = 99;
  for (const [, input] of runs) {
    const p = createPlayer(1, 'home', 'field', { x: 0, z: 0 }, 9, { speed: 80, dribble: 75, pass: 80, shoot: 80, defense: 80, stamina: 80 });
    const b = createBall();
    b.pos.x = 0.45; b.ownerId = p.id;
    let n = 0;
    for (let t = 0; t < 12; t += DT) {
      tickTimers(p, DT);
      const [ix, iz, sprint] = input(t);
      movePlayer(p, ix, iz, sprint, true, DT);
      if (Math.abs(p.pos.x) > 45 || Math.abs(p.pos.z) > 28) { b.pos.x -= p.pos.x; b.pos.z -= p.pos.z; p.pos.x = 0; p.pos.z = 0; }
      const fx = Math.cos(p.facing), fz = Math.sin(p.facing), dx = b.pos.x - p.pos.x, dz = b.pos.z - p.pos.z;
      const ahead = dx * fx + dz * fz, side = -dx * fz + dz * fx;
      if (dribble(p, b, DT)) {
        n++; touches++;
        const out = Math.max(FOOT_REACH.near - ahead, ahead - FOOT_REACH.far, Math.abs(side) - FOOT_REACH.side, 0);
        worst = Math.max(worst, out);
        if (out > 0.02) far++;
      }
      stepBall(b, DT);
      if (Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z) > 3.2) lost = true;
    }
    fewest = Math.min(fewest, n);
  }
  check('dribble through turns: every touch is within reach of a foot, ball never lost', far === 0 && !lost && fewest >= 8,
    `${touches} touches, ${far} out of reach (worst ${worst.toFixed(2)} m), fewest per run ${fewest}`);

  // Kicks in real matches: the ball is beside the kicker's feet when it is struck.
  let kicks = 0, farKicks = 0, worstKick = 0, late = 0;
  for (let i = 0; i < 4; i++) {
    const m = new Match({ seed: 810 + i, humans: [], seconds: 240, home: TEAMS[i * 3], away: TEAMS[i * 3 + 17] });
    let kickId = m.ball.kickId;
    const before = { x: m.ball.pos.x, z: m.ball.pos.z, owner: m.ball.ownerId };
    const wind = m.players.map(() => 0);
    for (let k = 0; k < 60 * 700 && m.phase !== 'fulltime'; k++) {
      m.step({}, DT);
      m.events.length = 0;
      const b = m.ball;
      if (b.kickId !== kickId) {
        kickId = b.kickId;
        const p = b.kickerId >= 0 ? m.players[b.kickerId] : null;
        if (p && p.role === 'field' && p.kickAnim > FOLLOW_THROUGH - 0.03 && before.owner === p.id) {
          kicks++;
          const d = Math.hypot(before.x - p.pos.x, before.z - p.pos.z);
          worstKick = Math.max(worstKick, d);
          if (d > 0.8) farKicks++;
          if (wind[p.id] < -0.1) late++;
        }
      }
      m.players.forEach((p, j) => { wind[j] = p.windFire ? p.windT : wind[j]; });
      before.x = b.pos.x; before.z = b.pos.z; before.owner = b.ownerId;
    }
  }
  check('kicks: the ball is at the feet of the kicker when struck, and swings are rarely kept waiting', kicks > 150 && farKicks === 0 && late / kicks < 0.1,
    `${kicks} kicks, ${farKicks} from over 0.8 m (furthest ${worstKick.toFixed(2)} m), ${late} struck late`);
}

// Two divisions: promotion and relegation swap clubs, and every club stays in exactly one division.
{
  const { createLeague, isOver, playRound, table, otherTable, seasonMoves, nextSeason } = await import('../src/sim/league');
  let ok = true, promoted = 0, relegated = 0;
  for (const team of [3, 20]) {
    let s = createLeague({ team, legs: 1, seed: 99 + team, minutes: 5, difficulty: 'normal', offside: true, assist: false });
    if (s.division !== TEAMS[team].division || s.clubs.join() !== divisionClubs(s.division).join()) ok = false;
    for (let season = 0; season < 6; season++) {
      // Win everything in the second division, lose everything in the first.
      while (!isOver(s)) {
        const f = s.rounds[s.round].find(([h, a]) => h === team || a === team)!;
        const win = s.division === 2;
        playRound(s, (f[0] === team) === win ? [3, 0] : [0, 3]);
      }
      const { up, down } = seasonMoves(s);
      const mine = table(s).map((r) => r.team), theirs = otherTable(s).map((r) => r.team);
      if (up.length !== MOVES || down.length !== MOVES || theirs.length !== DIV_SIZE) ok = false;
      if (otherTable(s).some((r) => r.played !== DIV_SIZE - 1)) ok = false;
      const was = s.division;
      const expectMove = was === 2 ? mine.indexOf(team) < MOVES : mine.indexOf(team) >= DIV_SIZE - MOVES;
      const n = nextSeason(s, 1000 + season);
      const all = [...n.clubs, ...n.other];
      if (n.clubs.length !== DIV_SIZE || n.other.length !== DIV_SIZE || new Set(all).size !== TEAMS.length || !n.clubs.includes(team)) ok = false;
      if (n.season !== s.season + 1 || (n.division !== was) !== expectMove) ok = false;
      const first = n.division === 1 ? n.clubs : n.other;
      if (!up.every((c) => first.includes(c)) || down.some((c) => first.includes(c))) ok = false;
      if (n.rounds.some((r) => r.some(([h, a]) => !n.clubs.includes(h) || !n.clubs.includes(a)))) ok = false;
      if (n.division === 1 && was === 2) promoted++;
      if (n.division === 2 && was === 1) relegated++;
      s = n;
    }
  }
  check('divisions: top clubs go up, bottom clubs go down, 16 clubs in each', ok && promoted > 0 && relegated > 0, `promoted ${promoted}x, relegated ${relegated}x over 12 seasons`);
  const avg = (d: 1 | 2) => divisionClubs(d).reduce((x, i) => x + TEAMS[i].field.shoot + TEAMS[i].field.pass + TEAMS[i].field.defense, 0) / DIV_SIZE / 3;
  check('divisions: the first division is the stronger one', divisionClubs(1).length === DIV_SIZE && divisionClubs(2).length === DIV_SIZE && avg(1) > avg(2) + 3, `${avg(1).toFixed(1)} vs ${avg(2).toFixed(1)}`);

  const gap = (a: number, b: number) => Math.hypot(((a >> 16) & 255) - ((b >> 16) & 255), ((a >> 8) & 255) - ((b >> 8) & 255), (a & 255) - (b & 255));
  let worst = 999, changes = 0, homeKept = true;
  for (const h of TEAMS) for (const a of TEAMS) {
    if (h === a) continue;
    const k = matchKits(h.kit, a.kit);
    if (k.home !== h.kit) homeKept = false;
    if (k.away !== a.kit) changes++;
    worst = Math.min(worst, gap(k.home.shirt, k.away.shirt));
  }
  check('kits: no pairing leaves two similar shirts on the pitch', worst >= KIT_CLASH && homeKept && changes > 0, `closest shirts ${worst.toFixed(0)}, away side changes in ${changes} of ${TEAMS.length * (TEAMS.length - 1)} pairings`);
}

// Name editor: overrides apply to clubs and squads, clean up after themselves, and reset.
{
  const t = TEAMS[2], before = { name: t.name, short: t.short, ini: t.crest.initials };
  const base = buildRoster(t, true);
  setTeamText(t.id, 'name', '  우리 <b>동네</b> FC  ');
  setTeamText(t.id, 'initials', 'ab');
  setPlayerName(t.id, 13, '홍길동', base[13].name);
  setPlayerName(t.id, 14, '홍길동', base[14].name); // the same name twice is allowed
  const squad = buildRoster(t);
  const m = new Match({ seed: 5, humans: [], home: t, away: TEAMS[0] });
  for (let k = 0; k < 60 * 30; k++) { m.step({}, DT); m.events.length = 0; }
  const inMatch = [...m.players, ...m.squads.home.bench].filter((p) => p.name === '홍길동').length;
  const statsSame = squad.every((p, i) => p.number === base[i].number && p.stats.speed === base[i].stats.speed && (i === 13 || i === 14 || p.name === base[i].name));
  check('editor: club and squad names apply without changing the squad',
    t.name === '우리 b동네/b FC' && t.crest.initials === 'AB' && t.short === before.short && squad[13].name === '홍길동' && statsSame && inMatch === 2 && customCount() === 1,
    `name="${t.name}" initials=${t.crest.initials} in match=${inMatch}`);
  setTeamText(t.id, 'name', '');
  setTeamText(t.id, 'initials', before.ini);
  setPlayerName(t.id, 13, '', base[13].name);
  setPlayerName(t.id, 14, base[14].name, base[14].name);
  check('editor: clearing a field restores the built-in name and drops the override',
    t.name === before.name && t.crest.initials === before.ini && customCount() === 0 && buildRoster(t)[13].name === base[13].name);
  setCustom({ [t.id]: { name: 'x'.repeat(50), players: { 3: 'A', 99: 'B', x: 'C' } }, nosuch: { name: 'Z' }, [TEAMS[0].id]: 'bad' });
  check('editor: saved data is cleaned on load',
    t.name.length === 20 && customCount() === 1 && playerNameOverride(t.id, 3) === 'A' && playerNameOverride(t.id, 99) === undefined);
  resetCustom();
  {
    // Kit and badge: changes apply, follow the rules for sleeves, clean up after themselves, and survive a save.
    const k = TEAMS[0], kit0 = { ...k.kit }, crest0 = { ...k.crest, colors: [...k.crest.colors] };
    setKitColour(k.id, 'shirt', 0x112233);
    const sleeveFollows = k.kit.sleeve === undefined && k.kit.shirt === 0x112233;
    setKitColour(k.id, 'sleeve', 0xffffff);
    setKitColour(k.id, 'gk', 0x00ff00);
    setCrestPart(k.id, 'shape', 'hex');
    setCrestPart(k.id, 'icon', 'bird');
    setCrestPart(k.id, 'icon', 'not-an-icon');
    setCrestColour(k.id, 2, 0xabcdef);
    setKitColour(k.id, 'shorts', -5);
    const applied = k.kit.sleeve === 0xffffff && k.kit.gk === 0x00ff00 && k.kit.shorts === kit0.shorts && k.crest.shape === 'hex'
      && k.crest.icon === 'bird' && k.crest.colors[2] === 0xabcdef && k.crest.colors[0] === crest0.colors[0] && k.crest.initials === crest0.initials;
    const m = new Match({ seed: 6, humans: [], home: k, away: TEAMS[3] });
    const worn = m.kits.home.shirt === 0x112233;
    // A round trip through saved data gives the same club.
    const saved = JSON.parse(JSON.stringify({ [k.id]: { kit: { shirt: 0x112233, sleeve: 0xffffff, gk: 0x00ff00, socks: 'red' }, crest: { shape: 'hex', icon: 'bird', pattern: 'zigzag', colors: { 2: 0xabcdef, 5: 1 } } } }));
    setCustom(saved);
    const reloaded = k.kit.shirt === 0x112233 && k.kit.sleeve === 0xffffff && k.kit.socks === kit0.socks && k.crest.shape === 'hex' && k.crest.pattern === crest0.pattern && k.crest.colors[2] === 0xabcdef;
    setKitColour(k.id, 'shirt', kit0.shirt);
    setKitColour(k.id, 'sleeve', kit0.shirt);
    setKitColour(k.id, 'gk', kit0.gk);
    setCrestPart(k.id, 'shape', crest0.shape);
    setCrestPart(k.id, 'icon', crest0.icon);
    setCrestColour(k.id, 2, crest0.colors[2]);
    const back = customCount() === 0 && k.kit.shirt === kit0.shirt && k.kit.sleeve === kit0.sleeve && k.crest.shape === crest0.shape && k.crest.icon === crest0.icon;
    check('editor: kit colours and badge parts apply, are worn in a match, reload, and undo cleanly', sleeveFollows && applied && worn && reloaded && back,
      `sleeve follows shirt=${sleeveFollows} applied=${applied} worn=${worn} reloaded=${reloaded} undone=${back}`);
  }
  check('editor: reset restores every club', t.name === before.name && customCount() === 0 && TEAMS.every((x) => x.name.length > 0));
}

// Cup: knock-out matches always produce a winner, and the bracket runs to a champion.
{
  let extra = 0, pens = 0, decided = 0, golden = 0;
  const N = 6;
  for (let i = 0; i < N; i++) {
    // Evenly matched, defensive sides on a short clock, so some matches are level at full time.
    const m = new Match({ seed: 900 + i, humans: [], seconds: 60, home: TEAMS[4], away: TEAMS[10], decider: true });
    let ended = 0;
    for (let k = 0; k < 60 * 200 && m.phase !== 'fulltime'; k++) {
      m.step({}, DT);
      ended += m.events.filter((e) => e === 'fulltime').length;
      m.events.length = 0;
    }
    if (m.extraTime) extra++;
    if (m.shootout) pens++;
    if (m.extraTime && !m.shootout) golden++;
    const okTime = m.time <= 60 * (4 / 3) + 0.01 && (m.extraTime || m.time <= 60.01);
    const okPens = !m.shootout || (m.score.home === m.score.away && m.shootout.home !== m.shootout.away);
    const okGolden = !(m.extraTime && !m.shootout) || Math.abs(m.score.home - m.score.away) === 1;
    if (m.phase === 'fulltime' && m.winner !== null && ended === 1 && okTime && okPens && okGolden) decided++;
  }
  check('cup match: level games go to extra time, then penalties; every match has a winner',
    decided === N && extra > 0, `decided ${decided}/${N}, extra time ${extra}, golden goal ${golden}, penalties ${pens}`);
  const plain = new Match({ seed: 900, humans: [], seconds: 60, home: TEAMS[4], away: TEAMS[10] });
  for (let k = 0; k < 60 * 200 && plain.phase !== 'fulltime'; k++) { plain.step({}, DT); plain.events.length = 0; }
  check('cup match: ordinary matches still end at 90 minutes', !plain.extraTime && !plain.shootout && plain.time <= 60.01);

  const n = TEAMS.length, R = cupRounds();
  let ok = true, wins = 0, outs = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const s = createCup({ team: seed % n, seed, minutes: 5, difficulty: 'normal', offside: true, assist: false });
    const drawn = new Set(s.rounds[0].flatMap((t) => [t.home, t.away]));
    if (drawn.size !== n) ok = false;
    let guard = 0;
    while (!cupOver(s) && guard++ < 10) {
      const t = myTie(s);
      if (!t) { ok = false; break; }
      // Alternate: play and win 2-1, draw and win on penalties, or let it be simulated.
      const mode = (seed + guard) % 3;
      playCupRound(s, mode === 0 ? { score: [2, 1], pens: null } : mode === 1 ? { score: [1, 1], pens: [5, 4] } : null);
    }
    if (!cupOver(s) || s.rounds.length !== R) ok = false;
    s.rounds.forEach((round, r) => {
      if (round.length !== n / 2 ** (r + 1)) ok = false;
      for (const t of round) {
        if (!t.score || tieWinner(t) === null) ok = false;
        if (t.score && t.score[0] === t.score[1] && (!t.pens || t.pens[0] === t.pens[1])) ok = false;
        if (t.score && t.score[0] !== t.score[1] && t.pens) ok = false;
      }
      if (r > 0) {
        const prev = s.rounds[r - 1].map((t) => tieWinner(t));
        const here = round.flatMap((t) => [t.home, t.away]);
        if (here.length !== prev.length || here.some((x) => !prev.includes(x))) ok = false;
      }
    });
    if (s.champion !== tieWinner(s.rounds[R - 1][0])) ok = false;
    const out = knockedOutIn(s);
    if ((out === null) !== (s.champion === s.team)) ok = false;
    if (out === null) wins++; else outs++;
  }
  check('cup: full bracket, winners advance, one champion', ok && wins > 0 && outs > 0, `40 cups: won ${wins}, knocked out ${outs}`);
  const a = createCup({ team: 3, seed: 77, minutes: 5, difficulty: 'normal', offside: true, assist: false });
  const b = createCup({ team: 3, seed: 77, minutes: 5, difficulty: 'normal', offside: true, assist: false });
  const first = myTie(a)!;
  playCupRound(a, { score: [3, 0], pens: null });
  playCupRound(b, { score: [1, 1], pens: [4, 2] });
  const others = (s: typeof a) => JSON.stringify(s.rounds[0].filter((_, i) => i !== first.index));
  const mineA = a.rounds[0][first.index], mineB = b.rounds[0][first.index];
  const side = first.home ? 0 : 1;
  check('cup: the player\'s result is recorded on the right side and does not change the other ties',
    others(a) === others(b) && mineA.score![side] === 3 && mineA.pens === null && mineB.pens![side] === 4 && tieWinner(mineA) === 3 && tieWinner(mineB) === 3);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
