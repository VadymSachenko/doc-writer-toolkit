import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
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
// On the PATH when found, not needed to install: the video gate's cut (`video-parts`) runs them; without them, a stage
// that cuts a video fails and says so.
export const OPTIONAL = ['ffmpeg', 'ffprobe'];

// The label: the host folder's name (ASCII) and a short hash of its absolute path, so two hosts with the same folder
// name never share an agent, and the label is known from the path alone (an uninstall needs no settings).
export const slugOf = (root) => path.basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'host';
const hashOf = (root) => crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 8);
export const labelOf = (root, { noop = false } = {}) => `${LABEL_PREFIX}.${slugOf(root)}-${hashOf(root)}${noop ? '.noop' : ''}`;
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
  const optional = Object.fromEntries(OPTIONAL.map((n) => [n, which(n)]));
  const optionalMissing = OPTIONAL.filter((n) => !optional[n]);
  const dirs = [path.dirname(node), ...[...NEEDED.map((n) => found[n]), ...OPTIONAL.map((n) => optional[n])].filter(Boolean).map((f) => path.dirname(f)), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const label = labelOf(settings.root, { noop });
  const args = [node, io.watcher ?? WATCHER, noop ? '--noop' : '--quiet', '--root', settings.root, ...(settings.file && !noop ? ['--settings', settings.file] : []), ...(found.claude && !noop ? ['--claude', found.claude] : [])];
  const logFile = path.join(watchDir(settings.state), noop ? 'launchd-noop.log' : 'launchd.log');
  const file = path.join(agentsDirOf(io), `${label}.plist`);
  const text = plistText({ label, programArguments: args, workingDirectory: settings.root, intervalSeconds: Math.round(settings.schedule.watchMinutes * 60), env: { PATH: [...new Set(dirs)].join(':'), HOME: io.home ?? os.homedir() }, logFile });
  return { label, file, text, logFile, missing, optionalMissing, programArguments: args };
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
  // An agent of this host under another label (an earlier one) goes first: one host, one agent.
  for (const old of agentsOf(settings.root, { noop, io }).filter((a) => a.label !== agent.label)) {
    launchctl(['bootout', `${domainOf(io)}/${old.label}`]);
    fs.rmSync(old.file, { force: true });
  }
  fs.writeFileSync(agent.file, agent.text, { mode: 0o644 });
  launchctl(['bootout', `${domainOf(io)}/${agent.label}`]);
  const boot = launchctl(['bootstrap', domainOf(io), agent.file]);
  if (boot.status !== 0) {
    fs.rmSync(agent.file, { force: true });
    throw new CliError(`launchctl bootstrap failed: ${boot.stderr.trim() || `exit ${boot.status}`}; the plist was removed`, { code: 1 });
  }
  return { installed: true, noop, ...agentState(agent.label, agent.file, io), ...(agent.optionalMissing.length ? { optionalMissing: agent.optionalMissing } : {}), logFile: agent.logFile, programArguments: agent.programArguments, everySeconds: Math.round(settings.schedule.watchMinutes * 60) };
}

// The agents of a host: the one its label names, and any other of ours whose plist starts the watcher for this root
// (one installed under an earlier label).
export function agentsOf(root, { noop = false, io = {} } = {}) {
  const dir = agentsDirOf(io);
  const label = labelOf(root, { noop });
  const labels = new Set([label]);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    /* no agents folder */
  }
  const arg = `<string>--root</string>\n    <string>${esc(path.resolve(root))}</string>`;
  for (const n of names) {
    if (!n.startsWith(`${LABEL_PREFIX}.`) || !n.endsWith('.plist') || n.endsWith('.noop.plist') !== noop) continue;
    try {
      if (fs.readFileSync(path.join(dir, n), 'utf8').includes(arg)) labels.add(n.slice(0, -'.plist'.length));
    } catch {
      /* unreadable: not ours to judge */
    }
  }
  return [...labels].map((l) => ({ label: l, file: path.join(dir, `${l}.plist`) }));
}

// By the host's path only: a host that moved, or whose settings no longer load, can still be uninstalled.
export function uninstall(root, { noop = false, io = {} } = {}) {
  const launchctl = io.launchctl ?? defaultLaunchctl;
  const agents = agentsOf(root, { noop, io }).map(({ label, file }) => {
    const out = launchctl(['bootout', `${domainOf(io)}/${label}`]);
    const removed = fs.existsSync(file);
    fs.rmSync(file, { force: true });
    const after = agentState(label, file, io);
    return { bootout: out.status === 0 ? 'unloaded' : 'was not loaded', fileRemoved: removed, ...after };
  });
  const [own, ...others] = agents;
  return { uninstalled: true, noop, ...own, ...(others.length ? { others } : {}), left: agents.some((a) => a.loaded || a.fileExists) };
}
