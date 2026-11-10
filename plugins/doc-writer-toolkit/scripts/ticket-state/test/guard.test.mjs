import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NOW, card, forgeAdapter, host, settingsFor, tmp, trackerAdapter } from './fakes.mjs';
import { ledger, read, world } from './helpers.mjs';
import { runRecord } from '../lib/record.mjs';
import { allowanceOf, parseUsage } from '../lib/allowance.mjs';
import { runDaily, spawnClaude, readUsageFromClaude } from '../lib/runner.mjs';
import { childEnv, prepareEnv, readTokenFile, TOKEN_VARIABLE } from '../lib/env.mjs';
import { notify, notificationsOf } from '../lib/notify.mjs';
import { main as watcherMain } from '../watcher.mjs';
import { againOf } from '../lib/watch.mjs';

// AC-2: the guard stops scheduled work at the day's allowance of the week (D-066), capped by maxWeekPercent (D-085),
// for the morning run, the watcher's runs and the skill jobs alike; a manual run is not guarded. Parallel steps only
// while the 5-hour session is not near its limit (D-067). The plan pays: no API key reaches a `claude` (stubbed /usage).

process.env.TZ = 'UTC';

// The week resets on Nov 14 at 06:00 UTC, so on NOW (Nov 10, 09:00) it is day 4 of the window: 40% with 10 a day.
const usageAt = (week, session = 10) => parseUsage(`Current session: ${session}% used · resets 2pm (UTC)\nCurrent week (all models): ${week}% used · resets Nov 14 at 6am (UTC)\n`);
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0.1, session_id: 's' });
const stageOf = (cmd) => /Stage `(\w+)`/.exec(cmd.args[cmd.args.indexOf('-p') + 1])[1];

// Two tickets the owner answered (next: `answers`, a writer step) and one ready group.
function answeredWorld(extra = {}) {
  const a = card({ number: 11, status: 'inProgress' });
  const b = card({ number: 12, status: 'inProgress' });
  const ready = card({ number: 13, status: 'ready', labels: ['Guide'] });
  const w = world({ cards: [a, b, ready], extra: { ...extra, limits: { estimates: { edit: 1 }, stepsPerTicket: 1, ...(extra.limits ?? {}) } } });
  for (const c of [a, b]) ledger(w, c, { stages: { triage: 'done', start: 'done', plan: 'done', questions: 'done' }, left: 'blocked', triage: { size: 'edit' } });
  ledger(w, ready, { stages: { triage: 'done' }, triage: { verdict: 'docs-required', targets: ['guide'], size: 'edit' } });
  return w;
}

// A session that records its stage done, as a role session would.
const recorder = (w, seen) => async (cmd) => {
  const stage = stageOf(cmd);
  const key = /record (\d+)/.exec(cmd.args[cmd.args.indexOf('-p') + 1])[1];
  seen.push([stage, key]);
  await runRecord({ settings: w.settings, clients: w.clients(), key, stage, status: 'done', now: NOW });
  return { code: 0, stdout: RESULT };
};

test('AC-2: the allowance is dailyPercent × the day of the week window; maxWeekPercent caps it', () => {
  const at = (iso) => new Date(iso);
  assert.deepEqual([allowanceOf(usageAt(5), { dailyPercent: 10, maxWeekPercent: null }, at('2026-11-07T07:00:00Z')).cap], [10], 'day 1');
  assert.equal(allowanceOf(usageAt(5), { dailyPercent: 10, maxWeekPercent: null }, at('2026-11-10T09:00:00Z')).cap, 40, 'day 4');
  assert.equal(allowanceOf(usageAt(5), { dailyPercent: 10, maxWeekPercent: null }, at('2026-11-14T05:00:00Z')).cap, 70, 'day 7');
  assert.equal(allowanceOf(usageAt(5), { dailyPercent: 15, maxWeekPercent: null }, at('2026-11-14T05:00:00Z')).cap, 100, 'never above the week');
  assert.equal(allowanceOf(usageAt(5), { dailyPercent: 15, maxWeekPercent: 90 }, at('2026-11-14T05:00:00Z')).cap, 90, 'capped');
  assert.equal(allowanceOf(null, { dailyPercent: 10 }, at('2026-11-10T09:00:00Z')), null, 'no reading, no allowance');
});

test('AC-2: the watcher run is guarded like a scheduled one: at the allowance nothing starts; below it only the named tickets finish', async () => {
  const w = answeredWorld();
  const held = await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: () => usageAt(40), now: () => NOW, spawnClaude: () => assert.fail('the guard stops it') }, options: { trigger: 'watcher', named: ['11'] } });
  assert.deepEqual([held.ran, held.starts, held.triage], [[], [], null]);
  assert.match(held.guard[0].reason, /the week is at 40%, the allowance by now is 40%/);

  const seen = [];
  const out = await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: () => usageAt(5), now: () => NOW, spawnClaude: recorder(w, seen) }, options: { trigger: 'watcher', named: ['11'] } });
  assert.deepEqual(seen[0], ['answers', '11']);
  assert.ok(seen.every(([, k]) => k === '11'), 'the other answered ticket and the ready group wait for their own event or the morning run');
  assert.deepEqual(out.starts, [], 'the watcher starts no ready group');
  assert.deepEqual([...new Set(read(w, '11').runs.map((r) => r.trigger))], ['watcher']);
});

test('AC-2: no usage reading, no scheduled start; a manual run is not guarded', async () => {
  const w = answeredWorld();
  const out = await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: () => null, now: () => NOW, spawnClaude: () => assert.fail('no reading') }, options: {} });
  assert.ok(out.guard.every((g) => g.reason === 'no usage reading: no scheduled start'));
  assert.ok(out.guard.length >= 1);
  const seen = [];
  await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: () => usageAt(95), now: () => NOW, spawnClaude: recorder(w, seen) }, options: { trigger: 'manual', named: ['12'] } });
  assert.deepEqual(seen[0], ['answers', '12'], 'the owner started it: past the allowance');
});

// A stand-in claude whose `/usage` gives no reading for its first `fails` runs, then answers a low week. `runs()` counts them.
function flakyUsage(fails) {
  const dir = tmp();
  const count = path.join(dir, 'runs');
  const fake = path.join(dir, 'claude');
  fs.writeFileSync(fake, `#!/bin/sh\nn=$(cat "${count}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${count}"\nif [ "$n" -le ${fails} ]; then echo "no reading this time" >&2; exit 1; fi\necho "Current session: 10% used · resets 2pm (UTC)"\necho "Current week (all models): 5% used · resets Nov 14 at 6am (UTC)"\n`, { mode: 0o755 });
  return { fake, runs: () => Number(fs.existsSync(count) ? fs.readFileSync(count, 'utf8').trim() : 0) };
}

test('AC-2: a /usage run that gives no reading is tried again, 10 s later: one failure followed by a reading runs the step', async () => {
  const w = answeredWorld();
  const { fake, runs } = flakyUsage(1);
  const seen = [];
  const sleeps = [];
  const out = await runDaily({ settings: w.settings, clients: w.clients(), io: { now: () => NOW, spawnClaude: recorder(w, seen), sleep: async (ms) => void sleeps.push(ms) }, options: { trigger: 'watcher', named: ['11'], claude: fake } });
  assert.deepEqual(out.guard, []);
  assert.deepEqual(seen[0], ['answers', '11'], 'the step ran on the second reading');
  assert.equal(out.usage.week.percent, 5);
  assert.deepEqual(sleeps, [10000], 'one wait, between the failed run and the good one');
  assert.ok(runs() >= 2);
});

test('AC-2: three /usage runs with no reading stop the step; the guard says how many tries failed', async () => {
  const w = answeredWorld();
  const { fake, runs } = flakyUsage(99);
  const sleeps = [];
  const out = await runDaily({ settings: w.settings, clients: w.clients(), io: { now: () => NOW, spawnClaude: () => assert.fail('no reading'), sleep: async (ms) => void sleeps.push(ms) }, options: { trigger: 'watcher', named: ['11'], claude: fake } });
  assert.ok(out.guard.length >= 1);
  assert.ok(out.guard.every((g) => g.reason === 'no usage reading after 3 tries: no scheduled start'));
  assert.equal(runs(), 3);
  assert.deepEqual(sleeps, [10000, 10000], 'no wait after the last try');
  const notes = notificationsOf({ run: out, today: '2026-11-10' });
  assert.ok(notes.length && notes.every((n) => n.title === 'Ticket flow: no usage reading'), 'still a reading problem, not a limit reached');
});

test('AC-2: with maxWeekPercent set the guard stops at the cap even when the day allows more', async () => {
  const w = answeredWorld({ limits: { dailyPercent: 15, maxWeekPercent: 50 } });
  const out = await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: () => usageAt(50), now: () => NOW, spawnClaude: () => assert.fail('at the cap') }, options: {} });
  assert.match(out.guard[0].reason, /the week is at 50%, the allowance by now is 50%/);
});

test('D-067: steps run in parallel only while the 5-hour session is below limits.sessionPercent', async () => {
  const peak = async (session) => {
    const w = answeredWorld();
    let now = 0;
    let max = 0;
    const spawn = async (cmd) => {
      now++;
      max = Math.max(max, now);
      await new Promise((r) => setTimeout(r, 20));
      const res = await recorder(w, [])(cmd);
      now--;
      return res;
    };
    await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: () => usageAt(5, session), now: () => NOW, spawnClaude: spawn }, options: { trigger: 'watcher', named: ['11', '12'] } });
    return max;
  };
  assert.equal(await peak(10), 2);
  assert.equal(await peak(85), 1);
});

test('the plan pays: no API key or auth token reaches a claude; the sign-in token comes from a private file and is never printed', async () => {
  const env = { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-test-should-not-pass', ANTHROPIC_AUTH_TOKEN: 'also-not', KEEP: '1' };
  assert.deepEqual(Object.keys(childEnv(env)).sort(), ['KEEP', 'PATH']);
  // A real child process: it sees neither variable.
  const probe = 'process.stdout.write(JSON.stringify({ key: process.env.ANTHROPIC_API_KEY ?? null, auth: process.env.ANTHROPIC_AUTH_TOKEN ?? null, keep: process.env.KEEP }))';
  const r = await spawnClaude({ bin: process.execPath, args: ['-e', probe], cwd: tmp() }, { env });
  assert.deepEqual(JSON.parse(r.stdout), { key: null, auth: null, keep: '1' });
  const u = fs.mkdtempSync(path.join(tmp(), 'u-'));
  const fake = path.join(u, 'claude');
  fs.writeFileSync(fake, `#!/bin/sh\n[ -z "$ANTHROPIC_API_KEY" ] && echo "Current week (all models): 7% used · resets Nov 14 at 6am (UTC)"\n`, { mode: 0o755 });
  assert.equal((await readUsageFromClaude(fake, env)).week.percent, 7, '/usage is read without the key too');

  // The token file: mode 600 is used; a file others can read is refused; the notes name no value.
  const root = tmp();
  const file = path.join(root, 'token');
  fs.writeFileSync(file, 'sk-ant-oat-secret-value\n', { mode: 0o600 });
  const settings = { root, schedule: { tokenFile: 'token' } };
  const target = { ANTHROPIC_API_KEY: 'sk-test', KEEP: '1' };
  const { notes, claudeEnv } = prepareEnv(settings, target);
  assert.equal(claudeEnv[TOKEN_VARIABLE], 'sk-ant-oat-secret-value', 'the claude sessions get the token');
  assert.equal(claudeEnv.KEEP, '1');
  assert.deepEqual(target, { KEEP: '1' }, 'the run own environment: no key, and never the token');
  assert.ok(!JSON.stringify(notes).includes('secret-value') && !JSON.stringify(notes).includes('sk-test'));
  fs.chmodSync(file, 0o644);
  assert.match(readTokenFile('token', root).refused, /readable by others .* chmod 600/);
  const loose = {};
  const refused = prepareEnv(settings, loose);
  assert.match(refused.notes.join(' '), /the sign-in token was not used/);
  assert.equal(refused.claudeEnv[TOKEN_VARIABLE], undefined);
});

test('the sign-in token reaches only the claude a check starts: never a host script, its job log, the output or the environment', async () => {
  const TOKEN = 'sk-ant-oat-fake-token-5f00000000';
  const root = host({
    shared: { hostJobs: [{ name: 'printenv', every: 5, run: { script: 'scripts/env.mjs' } }, { name: 'notes', every: 5, run: { skill: 'notes-writer' } }] },
    local: { schedule: { tokenFile: 'secret/token', morning: '23:59' } },
  });
  fs.mkdirSync(path.join(root, 'secret'));
  fs.writeFileSync(path.join(root, 'secret', 'token'), `${TOKEN}\n`, { mode: 0o600 });
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'env.mjs'), 'process.stdout.write(JSON.stringify(process.env));\n');
  // A stand-in claude: /usage answers a low week; a session answers success. Each notes whether it had the token.
  const seen = path.join(root, 'seen');
  const fake = path.join(root, 'claude');
  fs.writeFileSync(fake, `#!/bin/sh\n[ "$CLAUDE_CODE_OAUTH_TOKEN" = "${TOKEN}" ] && echo "$2" | head -c 6 >> "${seen}" && echo >> "${seen}"\nif [ "$2" = "/usage" ]; then echo "Current week (all models): 1% used · resets Nov 14 at 6am (UTC)"; else echo '${RESULT}'; fi\n`, { mode: 0o755 });
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ANTHROPIC_API_KEY: 'sk-test-should-not-pass' };
  let printed = '';
  // The full check, as a tick starts it (a tick with no flag starts it as a process of its own).
  await watcherMain(['--full', '--root', root, '--claude', fake], { env, stdout: { write: (x) => (printed += x) }, trackerAdapter: trackerAdapter(), forgeAdapter: forgeAdapter(), now: () => NOW });
  const out = JSON.parse(printed);
  assert.deepEqual(out.jobs.map((j) => [j.name, j.outcome]), [['printenv', 'done'], ['notes', 'done']]);
  const logs = fs.readdirSync(path.join(root, '.flow', 'watch', 'jobs')).map((f) => fs.readFileSync(path.join(root, '.flow', 'watch', 'jobs', f), 'utf8'));
  const scriptLog = logs.find((x) => x.includes('"PATH"'));
  assert.ok(scriptLog && !scriptLog.includes(TOKEN) && !scriptLog.includes(TOKEN_VARIABLE), 'the host script never had it');
  assert.ok(!logs.some((x) => x.includes(TOKEN)), 'no job log holds it');
  assert.ok(!printed.includes(TOKEN));
  assert.equal(env[TOKEN_VARIABLE], undefined);
  assert.deepEqual(fs.readFileSync(seen, 'utf8').trim().split('\n'), ['/usage', '/notes'], 'the claude sessions had the token');
  assert.equal(process.env[TOKEN_VARIABLE], undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test('the notification: the text goes to osascript as an argument, never into the script; urgent only for its two reasons', () => {
  const calls = [];
  const r = notify({ title: 'Ticket flow', text: 'A card "quoted" end tell', urgent: true }, { osascript: '/usr/bin/osascript', spawnSync: (bin, args) => (calls.push([bin, args]), { status: 0 }) });
  assert.equal(r.sent, true);
  const [, args] = calls[0];
  const script = args.filter((a, i) => args[i - 1] === '-e').join('\n');
  assert.ok(!script.includes('quoted'), 'the text is not part of the script');
  assert.deepEqual(args.slice(-2), ['Ticket flow', 'A card "quoted" end tell']);
  assert.match(script, /sound name/);
  const today = '2026-11-10';
  const plain = notificationsOf({ morning: { mode: 'on', ran: [{ outcome: 'done' }], starts: [], guard: [] }, today });
  assert.deepEqual(plain.map((n) => n.urgent), [false]);
  const urgent = notificationsOf({ run: { ran: [{ stage: 'write', keys: ['1'], group: '1', outcome: 'failed', note: 'failed; no model above to retry with' }], guard: [] }, today });
  assert.deepEqual(urgent, [], 'one failure is not urgent');
  const triage = notificationsOf({ morning: { mode: 'on', ran: [], starts: [], guard: [], triage: { stage: 'triage', keys: ['5', '6'], group: null, outcome: 'failed', note: 'failed twice' } }, today });
  assert.deepEqual(triage.filter((n) => n.urgent).map((n) => n.text), ['triage of 5, 6 failed twice. See /ticket-report.'], 'a triage that failed twice is urgent too');
  const noReading = notificationsOf({ run: { ran: [], guard: [{ kind: 'guard', reason: 'no usage reading: no scheduled start' }] }, jobs: [{ name: 'notes', held: 'no usage reading: no scheduled start' }], today });
  assert.deepEqual(noReading.map((n) => n.title), ['Ticket flow: no usage reading'], 'not a limit reached, and once a day');
});

test('limits.usageGuard off: /usage is never run, no step waits for a reading, and the allowance is unlimited', async () => {
  const w = answeredWorld({ limits: { usageGuard: false } });
  const { fake, runs } = flakyUsage(99);
  const seen = [];
  const out = await runDaily({ settings: w.settings, clients: w.clients(), io: { now: () => NOW, spawnClaude: recorder(w, seen), sleep: async () => assert.fail('no reading to wait for') }, options: { trigger: 'watcher', named: ['11'], claude: fake } });
  assert.equal(runs(), 0, 'claude -p /usage never ran');
  assert.deepEqual(out.guard, []);
  assert.equal(out.usageOff, true);
  assert.ok(seen.some(([stage]) => stage === 'answers'), 'a scheduled model step ran with no reading');
  assert.deepEqual(againOf(out), {}, 'no reading is no passing reason to hold the next start pass');
  assert.deepEqual(allowanceOf(null, { dailyPercent: 10, usageGuard: false }).remaining, 100);
  assert.equal(allowanceOf(usageAt(99), { dailyPercent: 10, usageGuard: false }).unlimited, true, 'a high week holds nothing');
});

test('limits.usageGuard must be true or false', () => {
  assert.throws(() => settingsFor(tmp(), { limits: { usageGuard: 'off' } }), /limits\.usageGuard must be true or false/);
});
