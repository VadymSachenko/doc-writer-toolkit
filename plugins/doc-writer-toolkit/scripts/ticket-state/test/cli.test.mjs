import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NOW, ago, card, forgeAdapter, host, quietGit, trackerAdapter } from './fakes.mjs';
import { snapshot } from './helpers.mjs';
import { main as stateMain } from '../ticket-state.mjs';
import { main as runnerMain } from '../runner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'ticket-state.mjs');
const RUNNER = path.join(ROOT, 'runner.mjs');

const run = (file, args) => {
  const r = spawnSync(process.execPath, [file, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, json: (() => {
    try {
      return JSON.parse(r.stdout);
    } catch {
      return null;
    }
  })() };
};

async function inProcess(main, argv, io) {
  let out = '';
  const code = await main(argv, { stdout: { write: (s) => (out += s) }, env: {}, git: quietGit, now: () => NOW, ...io });
  return { code, out, json: (() => {
    try {
      return JSON.parse(out);
    } catch {
      return null;
    }
  })() };
}

test('exit codes: 0 help, 2 bad usage (an unknown command too), 1 a refused record, with the JSON on stdout', () => {
  const root = host();
  const help = run(CLI, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /^ticket-state <command>/);
  const unknown = run(CLI, ['frobnicate', '--root', root]);
  assert.equal(unknown.code, 2);
  assert.deepEqual([unknown.json.ok, unknown.json.error], [false, "unknown command 'frobnicate'."]);
  assert.equal(run(CLI, ['record', '--root', root]).code, 2, 'record needs the key');
  assert.equal(run(CLI, ['status', 'extra', '--root', root]).code, 2);
  assert.equal(run(CLI, ['status', '--bogus', '--root', root]).code, 2);
  const refused = run(CLI, ['record', '999', '--stage', 'plan', '--status', 'done', '--root', root]);
  assert.equal(refused.code, 1);
  assert.deepEqual([refused.json.ok, refused.json.refused], [false, 'noLedger']);
  assert.match(refused.json.error, /^nothing recorded: ticket 999 has no ledger/);
  assert.equal(fs.existsSync(path.join(root, '.flow')), false, 'nothing written');
  assert.equal(run(RUNNER, ['--help']).code, 0);
  assert.equal(run(RUNNER, ['--ticket', '5', '--root', root]).code, 2, '--ticket goes with --manual');
  assert.equal(run(RUNNER, ['now', '--root', root]).code, 2);
  const noSettings = run(CLI, ['status', '--root', path.join(root, '.claude')]);
  assert.equal(noSettings.code, 2);
  assert.match(noSettings.json.error, /no settings file/);
});

test('config prints the merged settings with no credential value', async () => {
  const root = host({ local: { mode: 'observe', limits: { inProgress: 2 } } });
  const r = await inProcess(stateMain, ['config', '--root', root], {});
  assert.equal(r.code, 0);
  assert.deepEqual([r.json.file, r.json.localFile, r.json.settings.mode, r.json.settings.limits.inProgress, r.json.settings.limits.waiting], ['.claude/ticket-flow.json', '.claude/ticket-flow.local.json', 'observe', 2, 5]);
  assert.deepEqual(r.json.settings.tracker.credentials, { envFile: '.env', key: 'TEST_KEY', token: 'TEST_TOKEN' });
  assert.deepEqual(r.json.settings.cleanup, { mode: 'trash', keep: ['**/sme-interview.md', '**/app-notes.md'], trashDir: null });
});

test('status, intake, lock and unlock through the CLI; status reads only', async () => {
  const root = host();
  const cards = [card({ number: 1501, status: 'intake', labels: ['Guide'], lastActivity: ago(5) }), card({ number: 1502, status: 'intake', labels: ['Guide'], lastActivity: ago(1) })];
  const tracker = trackerAdapter({ cards });
  const io = { trackerAdapter: tracker, forgeAdapter: forgeAdapter() };
  const usageFile = path.join(root, 'usage.txt');
  fs.writeFileSync(usageFile, 'Current week (all models): 12% used · resets Nov 14 at 6am (UTC)\n');
  const before = snapshot(root);
  const st = await inProcess(stateMain, ['status', '--root', root, '--usage-file', usageFile], io);
  assert.equal(st.code, 0);
  assert.deepEqual([st.json.intake.due.map((c) => c.key), st.json.intake.waiting.map((c) => c.key), st.json.allowance.remaining], [['1501'], ['1502'], 28]);
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(tracker.log, []);
  const intake = await inProcess(stateMain, ['intake', '--root', root], io);
  assert.deepEqual(intake.json.intake.due.map((c) => c.key), ['1501']);
  const lock = await inProcess(stateMain, ['lock', '--group', '1501', '--kind', 'manual', '--root', root], io);
  assert.equal(lock.json.taken, true);
  await assert.rejects(inProcess(stateMain, ['lock', '--group', '1501', '--kind', 'schedule', '--root', root], io), (e) => e.exitCode === 1 && e.data.refused === 'locked');
  const unlock = await inProcess(stateMain, ['unlock', '--group', '1501', '--root', root], io);
  assert.equal(unlock.json.released, true);
  await assert.rejects(inProcess(stateMain, ['lock', '--root', root, '--kind', 'manual'], io), /a ticket key or --group/);
});

test('the runner dry run through the CLI: the plan, the requests it sent (reads only) and the caught writes (none)', async () => {
  const root = host();
  const cards = [card({ number: 1601, status: 'intake', labels: ['Guide'], lastActivity: ago(5) })];
  const tracker = trackerAdapter({ cards });
  const usageFile = path.join(root, 'usage.txt');
  fs.writeFileSync(usageFile, 'Current week (all models): 12% used · resets Nov 14 at 6am (UTC)\n');
  const before = snapshot(root);
  const r = await inProcess(runnerMain, ['--dry-run', '--morning', '--root', root, '--usage-file', usageFile], { trackerAdapter: tracker, forgeAdapter: forgeAdapter() });
  assert.equal(r.code, 0);
  assert.deepEqual([r.json.dryRun, r.json.triage.stage, r.json.triage.keys], [true, 'triage', ['1601']]);
  assert.deepEqual(r.json.caught, { tracker: [], forge: [] });
  assert.deepEqual(r.json.requests.writes, []);
  assert.match(r.json.report, /^# Ticket flow/);
  assert.deepEqual(snapshot(root), before);
});

// ------------------------------------------------------------------ the folder itself

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test('the folder has no dependency: every import is node: or a file here or in the sibling scripts', () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies, undefined);
  for (const file of walk(ROOT).filter((f) => f.endsWith('.mjs'))) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+['"]([^'"]+)['"]|import\(['"]([^'"]+)['"]\)/g)) {
      const spec = m[1] ?? m[2];
      assert.ok(spec.startsWith('node:') || spec.startsWith('.'), `${path.relative(ROOT, file)} imports ${spec}`);
    }
  }
});

test('the folder names no real id: every 24-character id in it is an invented one', () => {
  for (const file of walk(ROOT)) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/\b[0-9a-f]{24}\b/g)) assert.ok(m[0].startsWith('5f00000000'), `${path.relative(ROOT, file)} holds ${m[0]}`);
  }
});

test('the README documents every command, flag, exit code, setting and the id-only definition', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  for (const file of [CLI, RUNNER, path.join(ROOT, 'watcher.mjs'), path.join(ROOT, 'launchd.mjs')]) {
    const source = fs.readFileSync(file, 'utf8');
    for (const m of source.matchAll(/^\s{2}'?([a-z-]+)'?: \{ type/gm)) if (m[1] !== 'help') assert.ok(readme.includes(`--${m[1]}`), `README lacks --${m[1]}`);
  }
  for (const c of ['status', 'record', 'handover', 'lock', 'unlock', 'config', 'intake', 'report', 'set', 'import', 'print', 'install', 'uninstall']) assert.ok(readme.includes(`\`${c}`), `README lacks ${c}`);
  for (const w of ['inProgress', 'waiting', 'dailyPercent', 'maxWeekPercent', 'estimates', 'priority', 'roles', 'modelLadder', 'cleanup.keep', 'cleanup.mode', 'trashDir', 'quietHours', 'refused', 'Exit codes', 'files', 'hostJobs', 'every', 'tokenFile', 'watchMinutes', 'feed.json', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'DOC_TOOLKIT_JOB', 'limits.open', 'limits.startOrder', 'easiest', 'legacyMarkdown', 'misses']) assert.ok(readme.includes(w), `README lacks ${w}`);
  const definition = 'A UA change is id-only when its only differences from the approved version are (1) `{/* #id */}` comments added to headings that had none, and (2) link fragments rewritten from such a heading\'s old fragment to its new id. Anything else makes it a real change: a changed or removed id, a changed heading text, or any other edit.';
  assert.ok(readme.replace(/\s+/g, ' ').includes(definition), 'the README gives the id-only definition word for word');
});
