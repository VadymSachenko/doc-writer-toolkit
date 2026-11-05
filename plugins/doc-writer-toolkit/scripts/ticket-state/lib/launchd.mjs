import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CliError } from './errors.mjs';
import { watchDir } from './feed.mjs';

// The LaunchAgent that starts the watcher (macOS, launchd): one per host, in ~/Library/LaunchAgents, running
// `watcher.mjs --quiet` every `schedule.watchMinutes`. launchd runs a missed interval once after the Mac wakes, and never
// two copies of one job at once. The plist holds paths only: no token, no key (it is a plain file); the watcher reads
// the token from `schedule.tokenFile` itself. The morning run needs no agent of its own: the watcher starts it at the
// first check after `schedule.morning`.

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WATCHER = path.resolve(HERE, '..', 'watcher.mjs');
export const LABEL_PREFIX = 'dev.doc-toolkit.ticket-flow';
export const NEEDED = ['claude', 'git', 'gh'];

export const slugOf = (root) => path.basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'host';
export const labelOf = (root, { noop = false } = {}) => `${LABEL_PREFIX}.${slugOf(root)}${noop ? '.noop' : ''}`;
export const agentsDirOf = (io = {}) => io.agentsDir ?? path.join(os.homedir(), 'Library', 'LaunchAgents');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function plistText({ label, programArguments, workingDirectory, intervalSeconds, env, logFile }) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>\n  <string>${esc(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...programArguments.map((a) => `    <string>${esc(a)}</string>`),
    '  </array>',
    `  <key>WorkingDirectory</key>\n  <string>${esc(workingDirectory)}</string>`,
    `  <key>StartInterval</key>\n  <integer>${intervalSeconds}</integer>`,
    '  <key>RunAtLoad</key>\n  <true/>',
    '  <key>ProcessType</key>\n  <string>Background</string>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(env).map(([k, v]) => `    <key>${esc(k)}</key>\n    <string>${esc(v)}</string>`),
    '  </dict>',
    `  <key>StandardOutPath</key>\n  <string>${esc(logFile)}</string>`,
    `  <key>StandardErrorPath</key>\n  <string>${esc(logFile)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ];
  return lines.join('\n');
}

const defaultWhich = (name) => {
  const r = spawnSync('/usr/bin/which', [name], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

// The agent for a host: its label, file and plist. `noop` makes a test agent that runs `watcher.mjs --noop` (it reads
// nothing and exits), under its own label, for an install and uninstall check.
export function agentFor(settings, { noop = false, io = {} } = {}) {
  const which = io.which ?? defaultWhich;
  // The node on the PATH (a stable link) before this process's own path, which a version upgrade may move.
  const node = io.node ?? which('node') ?? process.execPath;
  const found = Object.fromEntries(NEEDED.map((n) => [n, which(n)]));
  const missing = NEEDED.filter((n) => !found[n]);
  const dirs = [path.dirname(node), ...NEEDED.map((n) => found[n] && path.dirname(found[n])).filter(Boolean), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const label = labelOf(settings.root, { noop });
  const args = [node, io.watcher ?? WATCHER, noop ? '--noop' : '--quiet', '--root', settings.root, ...(settings.file && !noop ? ['--settings', settings.file] : []), ...(found.claude && !noop ? ['--claude', found.claude] : [])];
  const logFile = path.join(watchDir(settings.state), noop ? 'launchd-noop.log' : 'launchd.log');
  const file = path.join(agentsDirOf(io), `${label}.plist`);
  const text = plistText({ label, programArguments: args, workingDirectory: settings.root, intervalSeconds: Math.round(settings.schedule.watchMinutes * 60), env: { PATH: [...new Set(dirs)].join(':'), HOME: io.home ?? os.homedir() }, logFile });
  return { label, file, text, logFile, missing, programArguments: args };
}

const defaultLaunchctl = (args) => {
  const r = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? r.error?.message ?? '' };
};

const domainOf = (io) => `gui/${io.uid ?? process.getuid()}`;

export function agentState(label, file, io = {}) {
  const launchctl = io.launchctl ?? defaultLaunchctl;
  const loaded = launchctl(['print', `${domainOf(io)}/${label}`]).status === 0;
  return { label, file, fileExists: fs.existsSync(file), loaded };
}

export function install(settings, { noop = false, io = {} } = {}) {
  const launchctl = io.launchctl ?? defaultLaunchctl;
  const agent = agentFor(settings, { noop, io });
  if (agent.missing.length && !noop) throw new CliError(`not found on PATH: ${agent.missing.join(', ')}; the watcher's runs need them`, { code: 2 });
  fs.mkdirSync(path.dirname(agent.logFile), { recursive: true });
  fs.mkdirSync(path.dirname(agent.file), { recursive: true });
  fs.writeFileSync(agent.file, agent.text, { mode: 0o644 });
  launchctl(['bootout', `${domainOf(io)}/${agent.label}`]);
  const boot = launchctl(['bootstrap', domainOf(io), agent.file]);
  if (boot.status !== 0) {
    fs.rmSync(agent.file, { force: true });
    throw new CliError(`launchctl bootstrap failed: ${boot.stderr.trim() || `exit ${boot.status}`}; the plist was removed`, { code: 1 });
  }
  return { installed: true, noop, ...agentState(agent.label, agent.file, io), logFile: agent.logFile, programArguments: agent.programArguments, everySeconds: Math.round(settings.schedule.watchMinutes * 60) };
}

export function uninstall(settings, { noop = false, io = {} } = {}) {
  const launchctl = io.launchctl ?? defaultLaunchctl;
  const label = labelOf(settings.root, { noop });
  const file = path.join(agentsDirOf(io), `${label}.plist`);
  const out = launchctl(['bootout', `${domainOf(io)}/${label}`]);
  const removed = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  const after = agentState(label, file, io);
  return { uninstalled: true, noop, bootout: out.status === 0 ? 'unloaded' : 'was not loaded', fileRemoved: removed, ...after, left: after.loaded || after.fileExists };
}
