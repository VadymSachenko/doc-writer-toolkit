import fs from 'node:fs';
import path from 'node:path';
import { loadClaudeConfig } from '../../ui-labels/lib/config.mjs';
import { CliError } from './errors.mjs';

export const DEFAULT_SETTINGS_FILE = '.claude/ticket-flow.json';

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

// A key in the local file overrides the shared one; objects merge key by key, anything else is replaced.
export function deepMerge(base, over) {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

export function readJsonFile(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new CliError(`cannot read ${what} ${file}: ${e.code ?? 'error'}`, { code: 2 });
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CliError(`${what} ${file} is not valid JSON: ${e.message}`, { code: 2 });
  }
}

// `.claude/ticket-flow.json` -> `.claude/ticket-flow.local.json`
export const localSettingsPath = (file) => file.replace(/(\.json)?$/, '.local.json');

const fail = (msg) => {
  throw new CliError(`ticket flow settings: ${msg}`, { code: 2 });
};

const names = (value, where) => {
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || !list.length || list.some((n) => typeof n !== 'string' || !n.trim())) {
    fail(`${where} must be a list of list names (strings), at least one`);
  }
  return list;
};

// Checks the `tracker` object of the settings and returns it in a fixed shape. Nothing here talks to the tracker.
// `targets`: the settings' targets, for the people each one adds to a card (`cardMembers`).
export function validateTracker(t, targets = []) {
  if (!isObject(t)) fail("the file has no 'tracker' object");
  if (typeof t.kind !== 'string' || !t.kind) fail("tracker.kind is required (for example 'trello')");
  if (typeof t.board !== 'string' || !t.board) fail('tracker.board is required (the board id)');
  if (!isObject(t.statuses) || !Object.keys(t.statuses).length) fail('tracker.statuses is required: { status: [list names] }');
  const statuses = {};
  for (const [status, value] of Object.entries(t.statuses)) statuses[status] = names(value, `tracker.statuses.${status}`);
  const known = (status, where) => {
    if (!(status in statuses)) fail(`${where} names '${status}', which is not in tracker.statuses`);
    return status;
  };
  const neverRead = (t.neverRead ?? []).map((s) => known(s, 'tracker.neverRead'));
  if (!Array.isArray(t.transitions ?? [])) fail('tracker.transitions must be a list of [from, to] pairs');
  const transitions = (t.transitions ?? []).map((pair, i) => {
    if (!Array.isArray(pair) || pair.length !== 2) fail(`tracker.transitions[${i}] must be a [from, to] pair`);
    return [known(pair[0], `tracker.transitions[${i}]`), known(pair[1], `tracker.transitions[${i}]`)];
  });
  const labels = t.labels ?? {};
  if (!isObject(labels) || Object.values(labels).some((v) => typeof v !== 'string')) fail('tracker.labels must map a name to a label name');
  const watchBoards = t.watchBoards ?? [];
  if (!Array.isArray(watchBoards) || watchBoards.some((b) => typeof b !== 'string')) fail('tracker.watchBoards must be a list of board ids');
  const c = t.credentials;
  if (!isObject(c) || typeof c.key !== 'string' || typeof c.token !== 'string' || !c.key || !c.token) {
    fail("tracker.credentials must name the two environment variables: { \"key\": \"…\", \"token\": \"…\" } and, optionally, \"envFile\"");
  }
  const { owner, members } = validateMembers(t.owner, targets);
  return {
    kind: t.kind,
    board: t.board,
    watchBoards,
    statuses,
    neverRead,
    transitions,
    labels,
    priority: validatePriority(t.priority),
    owner,
    members,
    credentials: { key: c.key, token: c.token, envFile: c.envFile ?? '.env' },
  };
}

// The people the settings name on the tracker, by username: the owner (`tracker.owner`), added to every card the triage
// moves into the ready status, and each target's `cardMembers`, added to the card when a person calls the expert
// review. Only these may be added to a card; each must be a member of the board (checked against the board when the
// statuses are resolved, like the list names).
function validateMembers(rawOwner, targets) {
  const user = (v, where) => {
    if (typeof v !== 'string' || !v.replace(/^@/, '').trim()) fail(`${where} must be a username on the tracker`);
    return v.replace(/^@/, '').trim();
  };
  const owner = rawOwner === undefined || rawOwner === null ? null : user(rawOwner, 'tracker.owner');
  const members = owner ? [{ name: owner, where: 'tracker.owner' }] : [];
  for (const [i, tg] of (Array.isArray(targets) ? targets : []).entries()) {
    const list = tg?.cardMembers;
    if (list === undefined || list === null) continue;
    const where = `targets '${tg?.id ?? i}'.cardMembers`;
    if (!Array.isArray(list)) fail(`${where} must be a list of usernames on the tracker`);
    for (const v of list) members.push({ name: user(v, where), where });
  }
  return { owner, members };
}

// The labels that mark a card's priority: `{ high: <label name>, low: <label name> }`. A card with neither is medium.
export const DEFAULT_PRIORITY = { high: 'high', low: 'low' };

function validatePriority(p) {
  if (p === undefined || p === null) return { ...DEFAULT_PRIORITY };
  if (!isObject(p)) fail('tracker.priority must be { "high": <label name>, "low": <label name> }');
  const out = { ...DEFAULT_PRIORITY };
  for (const [level, name] of Object.entries(p)) {
    if (!(level in DEFAULT_PRIORITY)) fail(`tracker.priority.${level} is not a level: name the labels for "high" and "low"; a card with neither is "medium"`);
    if (typeof name !== 'string' || !name.trim()) fail(`tracker.priority.${level} must be a label name`);
    out[level] = name;
  }
  return out;
}

// Where the settings file is: the flag, else the 'Ticket flow settings:' field of CLAUDE.md, else the default.
export async function settingsFile(root, flag) {
  if (flag) return path.resolve(root, flag);
  const claude = await loadClaudeConfig(root);
  return path.resolve(root, claude['ticket flow settings'] || DEFAULT_SETTINGS_FILE);
}

export async function loadSettings({ root, settings: flag }) {
  const file = await settingsFile(root, flag);
  const shared = readJsonFile(file, 'settings file');
  if (!shared) throw new CliError(`no settings file at ${file}. Declare 'Ticket flow settings:' in CLAUDE.md or pass --settings.`, { code: 2 });
  const local = readJsonFile(localSettingsPath(file), 'local settings file');
  const merged = deepMerge(shared, local ?? {});
  return { root, file, local: Boolean(local), tracker: validateTracker(merged.tracker, merged.targets) };
}

/** KEY=value lines, as in a .env file. Nothing is evaluated. */
export function parseEnvFile(text) {
  const vars = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const quoted = /^(['"])(.*)\1$/.exec(m[2]);
    vars[m[1]] = quoted ? quoted[2] : m[2].replace(/\s+#.*$/, '');
  }
  return vars;
}

// The two variables the settings name: from the environment first, then from the credentials file. Exit 2 when
// either is missing; the message names the variables, never a value.
export function loadCredentials({ root, credentials, env = process.env }) {
  let fileVars = {};
  try {
    fileVars = parseEnvFile(fs.readFileSync(path.resolve(root, credentials.envFile), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new CliError(`cannot read the credentials file: ${e.code ?? 'error'}`, { code: 2 });
  }
  const pick = (name) => (env[name] ? env[name] : fileVars[name] || null);
  const key = pick(credentials.key);
  const token = pick(credentials.token);
  const missing = [!key && credentials.key, !token && credentials.token].filter(Boolean);
  if (missing.length) {
    throw new CliError(`missing credentials: set ${missing.join(' and ')} in the environment or in ${credentials.envFile}`, { code: 2, data: { missing } });
  }
  return { key, token };
}
