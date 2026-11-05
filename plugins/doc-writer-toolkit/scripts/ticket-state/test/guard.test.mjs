import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NOW, card, tmp } from './fakes.mjs';
import { ledger, read, world } from './helpers.mjs';
import { runRecord } from '../lib/record.mjs';
import { allowanceOf, parseUsage } from '../lib/allowance.mjs';
import { runDaily, spawnClaude, readUsageFromClaude } from '../lib/runner.mjs';
import { childEnv, prepareEnv, readTokenFile, TOKEN_VARIABLE } from '../lib/env.mjs';
import { notify, notificationsOf } from '../lib/notify.mjs';

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
  assert.equal(readUsageFromClaude(fake, env).week.percent, 7, '/usage is read without the key too');

  // The token file: mode 600 is used; a file others can read is refused; the notes name no value.
  const root = tmp();
  const file = path.join(root, 'token');
  fs.writeFileSync(file, 'sk-ant-oat-secret-value\n', { mode: 0o600 });
  const settings = { root, schedule: { tokenFile: 'token' } };
  const target = { ANTHROPIC_API_KEY: 'sk-test' };
  const notes = prepareEnv(settings, target);
  assert.equal(target[TOKEN_VARIABLE], 'sk-ant-oat-secret-value');
  assert.equal(target.ANTHROPIC_API_KEY, undefined);
  assert.ok(!JSON.stringify(notes).includes('secret-value') && !JSON.stringify(notes).includes('sk-test'));
  fs.chmodSync(file, 0o644);
  assert.match(readTokenFile('token', root).refused, /readable by others .* chmod 600/);
  const loose = {};
  assert.match(prepareEnv(settings, loose).join(' '), /the sign-in token was not used/);
  assert.equal(loose[TOKEN_VARIABLE], undefined);
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
});
