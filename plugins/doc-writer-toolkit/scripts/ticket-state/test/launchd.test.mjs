import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { host, tmp } from './fakes.mjs';
import { loadSettings } from '../lib/settings.mjs';
import { agentFor, install, labelOf, uninstall } from '../lib/launchd.mjs';
import { main as launchdMain } from '../launchd.mjs';
import { main as watcherMain } from '../watcher.mjs';
import { main as stateMain } from '../ticket-state.mjs';
import { emptyForge, writeForge } from '../lib/forge-state.mjs';

test('uninstall names the detached processes it leaves running: the full check a tick started and the forge check\'s runs', async () => {
  const settings = await settingsOf();
  const agentsDir = tmp('agents-');
  const env = io(agentsDir, []);
  install(settings, { io: env });
  const at = new Date().toISOString();
  writeForge(settings.state, { ...emptyForge(), handOns: [{ id: 'h1', pid: 4101, keys: ['481'], at }, { id: 'h2', pid: 4102, keys: ['482'], at }] });
  let out = '';
  await launchdMain(['uninstall', '--root', settings.root], { ...env, isAlive: (p) => p === 4101, stdout: { write: (s) => (out += s) } });
  const r = JSON.parse(out);
  assert.equal(r.left, false);
  assert.deepEqual(r.stillRunning.map((x) => [x.kind, x.pid, x.tickets]), [['run', 4101, ['481']]]);
});

// AC-3: install and uninstall leave no stray job (with a stand-in for launchctl here; the evidence of a real install and
// uninstall on a Mac is in the task's evidence). And `set`: the plain-words settings command edits the local file only.

const io = (agentsDir, calls, loaded = new Set()) => ({
  agentsDir,
  uid: 501,
  home: '/Users/owner',
  node: '/opt/node/bin/node',
  which: (n) => `/opt/${n}/bin/${n}`,
  launchctl: (args) => {
    calls.push(args);
    const [cmd, target] = args;
    if (cmd === 'bootstrap') {
      loaded.add(path.basename(args[2], '.plist'));
      return { status: 0, stdout: '', stderr: '' };
    }
    const label = target?.split('/').pop();
    if (cmd === 'bootout') return loaded.delete(label) ? { status: 0, stdout: '', stderr: '' } : { status: 3, stdout: '', stderr: 'No such process' };
    if (cmd === 'print') return loaded.has(label) ? { status: 0, stdout: 'state = waiting', stderr: '' } : { status: 113, stdout: '', stderr: 'Could not find service' };
    return { status: 1, stdout: '', stderr: 'unknown' };
  },
});

async function settingsOf(local = {}) {
  const root = host({ local: { schedule: { watchMinutes: 5, tokenFile: '~/.config/acme/claude-token' }, ...local } });
  const named = path.join(tmp('host-'), 'acme-docs');
  fs.renameSync(root, named);
  return loadSettings({ root: named });
}

test('AC-3: install writes one plist and loads it; uninstall unloads it and removes it, and nothing is left', async () => {
  const settings = await settingsOf();
  const agentsDir = tmp('agents-');
  const calls = [];
  const env = io(agentsDir, calls);
  const r = install(settings, { io: env });
  assert.deepEqual([r.installed, r.loaded, r.fileExists], [true, true, true]);
  assert.match(r.label, /^dev\.doc-toolkit\.ticket-flow\.acme-docs-[0-9a-f]{8}$/);
  assert.deepEqual(fs.readdirSync(agentsDir), [`${r.label}.plist`]);
  assert.deepEqual(calls.map((c) => c[0]), ['bootout', 'bootstrap', 'print']);
  assert.equal(calls[1][1], 'gui/501');
  const text = fs.readFileSync(path.join(agentsDir, `${r.label}.plist`), 'utf8');
  // The tick: the forge check every schedule.forgeSeconds (60 by default); the watcher runs the full one every 5 minutes.
  assert.match(text, /<key>StartInterval<\/key>\n {2}<integer>60<\/integer>/);
  assert.deepEqual([r.everySeconds, r.fullEveryMinutes], [60, 5]);
  assert.match(text, /<string>--quiet<\/string>/);
  assert.match(text, new RegExp(`<string>${settings.root}</string>`));
  // Paths only: the token file's path and any key stay out of the plist; PATH holds node, claude, git, gh, and ffmpeg
  // and ffprobe for the video gate.
  assert.ok(!/token|ANTHROPIC|TRELLO|TEST_TOKEN/i.test(text));
  assert.match(text, /<key>PATH<\/key>\n {4}<string>\/opt\/node\/bin:\/opt\/claude\/bin:\/opt\/git\/bin:\/opt\/gh\/bin:\/opt\/ffmpeg\/bin:\/opt\/ffprobe\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
  if (process.platform === 'darwin') assert.equal(spawnSync('/usr/bin/plutil', ['-lint', path.join(agentsDir, `${r.label}.plist`)]).status, 0, 'a valid plist');

  // Installing again replaces it: still one file, one job.
  install(settings, { io: env });
  assert.equal(fs.readdirSync(agentsDir).length, 1);

  const u = uninstall(settings.root, { io: env });
  assert.deepEqual([u.bootout, u.fileRemoved, u.loaded, u.fileExists, u.left], ['unloaded', true, false, false, false]);
  assert.deepEqual(fs.readdirSync(agentsDir), []);
  // Uninstalling what isn't there is fine and still reports nothing left.
  const again = uninstall(settings.root, { io: env });
  assert.deepEqual([again.bootout, again.left], ['was not loaded', false]);
});

test('AC-3: the noop agent has its own label and runs the watcher with --noop, which reads nothing', async () => {
  const settings = await settingsOf();
  const a = agentFor(settings, { noop: true, io: io(tmp(), []) });
  assert.equal(a.label, `${labelOf(settings.root)}.noop`);
  assert.ok(a.programArguments.includes('--noop'));
  assert.ok(!a.programArguments.includes('--settings'));
  let out = '';
  const code = await watcherMain(['--noop', '--root', '/nonexistent/host'], { stdout: { write: (s) => (out += s) } });
  assert.deepEqual([code, JSON.parse(out)], [0, { ok: true, command: 'watch', noop: true }]);
});

test('AC-3: install stops when claude, git or gh is missing (the runs need them), and a failed load leaves no plist', async () => {
  const settings = await settingsOf();
  const agentsDir = tmp('agents-');
  assert.throws(() => install(settings, { io: { ...io(agentsDir, []), which: (n) => (n === 'gh' ? null : `/bin/${n}`) } }), /not found on PATH: gh/);
  // ffmpeg and ffprobe are not needed to install: missing, the agent installs, says so, and its PATH goes without them.
  const noFfmpeg = install(settings, { io: { ...io(agentsDir, []), which: (n) => (['ffmpeg', 'ffprobe'].includes(n) ? null : `/opt/${n}/bin/${n}`) } });
  assert.deepEqual([noFfmpeg.installed, noFfmpeg.optionalMissing], [true, ['ffmpeg', 'ffprobe']]);
  assert.match(fs.readFileSync(noFfmpeg.file, 'utf8'), /<string>\/opt\/node\/bin:\/opt\/claude\/bin:\/opt\/git\/bin:\/opt\/gh\/bin:\/usr\/bin:/);
  fs.rmSync(noFfmpeg.file);
  const failing = { ...io(agentsDir, []), launchctl: (args) => (args[0] === 'bootstrap' ? { status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' } : { status: 3, stdout: '', stderr: '' }) };
  assert.throws(() => install(settings, { io: failing }), /bootstrap failed: Bootstrap failed/);
  assert.deepEqual(fs.readdirSync(agentsDir), []);
});

test('the launchd CLI: print shows the plist and installs nothing; status reads the state', async () => {
  const settings = await settingsOf();
  const agentsDir = tmp('agents-');
  let out = '';
  await launchdMain(['print', '--root', settings.root], { ...io(agentsDir, []), stdout: { write: (s) => (out += s) } });
  const r = JSON.parse(out);
  assert.match(r.plist, /<key>Label<\/key>/);
  assert.deepEqual(fs.readdirSync(agentsDir), []);
  out = '';
  await launchdMain(['status', '--root', settings.root], { ...io(agentsDir, []), stdout: { write: (s) => (out += s) } });
  assert.deepEqual([JSON.parse(out).loaded, JSON.parse(out).fileExists], [false, false]);
  assert.equal(JSON.parse(out).wantSeconds, 60);
});

test('the forge check is in the LaunchAgent: one agent at schedule.forgeSeconds; none set, every watchMinutes; status says when to install again', async () => {
  // An agent installed before the forge check: every 5 minutes. Its status asks for an install again.
  const before = await settingsOf({ schedule: { watchMinutes: 5, forgeSeconds: null } });
  const agentsDir = tmp('agents-');
  const env = io(agentsDir, []);
  const r = install(before, { io: env });
  assert.equal(r.everySeconds, 300);
  const status = async (root) => {
    let out = '';
    await launchdMain(['status', '--root', root], { ...env, stdout: { write: (s) => (out += s) } });
    return JSON.parse(out);
  };
  let s = await status(before.root);
  assert.deepEqual([s.everySeconds, s.wantSeconds, s.installAgain], [300, 300, false]);
  assert.equal(s.checks, 'the full check every 5 min');
  // The owner's local file drops the null: the default 60 s applies, and the installed agent is behind.
  const local = path.join(before.root, '.claude', 'ticket-flow.local.json');
  fs.writeFileSync(local, JSON.stringify({ schedule: { watchMinutes: 5 } }));
  s = await status(before.root);
  assert.deepEqual([s.everySeconds, s.wantSeconds, s.installAgain], [300, 60, true]);
  assert.equal(s.checks, 'the forge check every 60 s, the full check every 5 min');
  const after = install(await loadSettings({ root: before.root }), { io: env });
  assert.equal(after.everySeconds, 60);
  assert.equal(fs.readdirSync(agentsDir).length, 1, 'one host, one agent');
  s = await status(before.root);
  assert.deepEqual([s.everySeconds, s.installAgain], [60, false]);
  // A forge interval not shorter than the full one is no forge check: every tick is a full check.
  const slow = await settingsOf({ schedule: { watchMinutes: 1, forgeSeconds: 90 } });
  assert.match(agentFor(slow, { io: env }).text, /<key>StartInterval<\/key>\n {2}<integer>60<\/integer>/);
});

test('set: one key of the local file, checked before it is written; the shared file is never touched', async () => {
  const root = host({ local: { mode: 'observe' } });
  const shared = fs.readFileSync(path.join(root, '.claude', 'ticket-flow.json'), 'utf8');
  const run = async (...args) => {
    let out = '';
    await stateMain(['set', ...args, '--root', root], { stdout: { write: (s) => (out += s) } });
    return JSON.parse(out);
  };
  // "one at a time"
  const one = await run('limits.inProgress', '1');
  assert.deepEqual([one.key, one.before, one.after, one.changed, one.file], ['limits.inProgress', 3, 1, true, path.join('.claude', 'ticket-flow.local.json')]);
  assert.deepEqual((await run('mode', 'on')).after, 'on');
  assert.deepEqual((await run('schedule.morning', '06:30')).after, '06:30');
  assert.deepEqual((await run('limits.maxWeekPercent', 'null')).after, null);
  const local = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'ticket-flow.local.json'), 'utf8'));
  assert.deepEqual([local.mode, local.limits.inProgress, local.schedule.morning], ['on', 1, '06:30']);
  assert.equal(fs.readFileSync(path.join(root, '.claude', 'ticket-flow.json'), 'utf8'), shared);
  // Bad values and keys of the shared file write nothing.
  const before = fs.readFileSync(path.join(root, '.claude', 'ticket-flow.local.json'), 'utf8');
  await assert.rejects(run('mode', 'sometimes'), /mode must be one of off, observe, on/);
  await assert.rejects(run('schedule.morning', '7am'), /schedule.morning must be a time/);
  await assert.rejects(run('tracker.board', 'x'), /not a key of the local settings file/);
  assert.equal(fs.readFileSync(path.join(root, '.claude', 'ticket-flow.local.json'), 'utf8'), before);
  // No setting re-arms a held step; only `set retry <key>` or `set retry all` does, in the state folder.
  const stamp = path.join(root, '.flow', 'rearmed.json');
  assert.equal(fs.existsSync(stamp), false);
  const all = await run('retry', 'all');
  assert.deepEqual([all.key, all.ticket, all.changed], ['retry', 'all', true]);
  assert.equal(JSON.parse(fs.readFileSync(stamp, 'utf8')).all, all.at);
  await assert.rejects(run('retry', '9999'), /ticket 9999 has no ledger/);
  assert.equal(fs.readFileSync(path.join(root, '.claude', 'ticket-flow.local.json'), 'utf8'), before, 'the settings files are untouched');
  // --unset drops the key: the default comes back.
  assert.deepEqual((await run('limits.inProgress', '--unset')).after, 3);
});

test('the label is unique per host: the folder name (ASCII) and a hash of the path; uninstall needs only the path', async () => {
  const one = await settingsOf();
  const two = await settingsOf();
  assert.equal(path.basename(one.root), path.basename(two.root));
  assert.notEqual(labelOf(one.root), labelOf(two.root), 'two hosts with the same folder name');
  assert.match(labelOf('/Users/owner/Документи'), /^dev\.doc-toolkit\.ticket-flow\.host-[0-9a-f]{8}$/, 'still ASCII');
  const agentsDir = tmp('agents-');
  const calls = [];
  const env = io(agentsDir, calls);
  install(one, { io: env });
  install(two, { io: env });
  assert.equal(fs.readdirSync(agentsDir).length, 2, 'the second host does not replace the first');

  // The first host moves away: its settings no longer load, and uninstall by its old path still removes its agent.
  fs.rmSync(one.root, { recursive: true, force: true });
  let out = '';
  await launchdMain(['uninstall', '--root', one.root], { ...env, stdout: { write: (x) => (out += x) } });
  const u = JSON.parse(out);
  assert.deepEqual([u.label, u.bootout, u.fileRemoved, u.left], [labelOf(one.root), 'unloaded', true, false]);
  assert.deepEqual(fs.readdirSync(agentsDir), [`${labelOf(two.root)}.plist`]);

  // An agent installed under an earlier label is found by its plist's --root: install replaces it, uninstall removes it.
  const old = path.join(agentsDir, 'dev.doc-toolkit.ticket-flow.acme-docs.plist');
  fs.writeFileSync(old, agentFor(two, { io: env }).text);
  install(two, { io: env });
  assert.deepEqual(fs.readdirSync(agentsDir), [`${labelOf(two.root)}.plist`]);
  fs.writeFileSync(old, agentFor(two, { io: env }).text);
  const both = uninstall(two.root, { io: env });
  assert.deepEqual([both.others.map((a) => a.label), both.left], [['dev.doc-toolkit.ticket-flow.acme-docs'], false]);
  assert.deepEqual(fs.readdirSync(agentsDir), []);
});
