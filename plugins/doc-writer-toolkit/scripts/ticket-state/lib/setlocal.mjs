import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { deepMerge, localSettingsPath, readJsonFile } from '../../tracker/lib/settings.mjs';
import { validateSettings } from './settings.mjs';
import { CliError } from './errors.mjs';
import { checkKey, readLedger } from './ledger.mjs';

// `set`: one key of the owner's local settings file, the file a command in plain words edits (D-060): the mode, the
// limits, the schedule, the roles, the video gate, the cleanup. The shared file is never touched. The merged result is
// checked as every script checks it before the file is written (temp file, then rename); a bad value writes nothing.

const SETTABLE = /^(mode|modelLadder|limits\.[A-Za-z]+(\.[A-Za-z]+)?|schedule\.[A-Za-z]+|roles\.(triage|writer|reviewer|translator)\.[A-Za-z]+|video\.[A-Za-z]+|cleanup\.[A-Za-z]+)$/;

const getPath = (obj, key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
function setPath(obj, key, value) {
  const parts = key.split('.');
  let o = obj;
  for (const k of parts.slice(0, -1)) o = o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) ? o[k] : (o[k] = {});
  if (value === undefined) delete o[parts.at(-1)];
  else o[parts.at(-1)] = value;
}

// A value as typed: JSON when it parses (10, null, true, ["a"]), else the text itself (on, 07:00).
export function parseValue(text) {
  try {
    return JSON.parse(text);
  } catch {
    return String(text);
  }
}

// `set retry <key>` or `set retry all`: the owner gives a held step (after failing, or at its daily session cap), or
// one that waits for the morning run, one more try (lib/rule.mjs). Only this re-arms; no other setting does. The times
// live in the state folder, never in the settings files: { all, tickets: { <key>: time } }.
export const rearmPath = (state) => path.join(state, 'rearmed.json');
export function readRearm(state) {
  try {
    const r = JSON.parse(fs.readFileSync(rearmPath(state), 'utf8'));
    return { all: r.all ?? null, tickets: r.tickets ?? {}, jobs: r.jobs ?? {} };
  } catch {
    return { all: null, tickets: {}, jobs: {} };
  }
}

// When a ticket was last re-armed (ms), or null; `latestRearm`: the last re-arm of any ticket.
export const rearmedAt = (r, key) => Math.max(...[r.all, r.tickets[key]].map((t) => (t ? Date.parse(t) : 0))) || null;
export const latestRearm = (r) => Math.max(...[r.all, ...Object.values(r.tickets)].map((t) => (t ? Date.parse(t) : 0))) || null;

// `set retry job <name>`: a host job the watcher disarmed (lib/rearm.mjs) runs again at its next due check.
function rearm({ settings, which, name, now }) {
  if (which === undefined || which === '') throw new CliError("set retry needs a ticket key, 'all', or 'job <name>'", { code: 2 });
  const job = which === 'job';
  if (job && !(settings.hostJobs ?? []).some((j) => j.name === name)) throw new CliError(name ? `'${name}' is not a host job (hostJobs: ${(settings.hostJobs ?? []).map((j) => j.name).join(', ') || 'none'})` : 'set retry job needs the job name', { code: 2 });
  if (!job && which !== 'all' && !readLedger(settings.state, checkKey(which))) throw new CliError(`ticket ${which} has no ledger`, { code: 2 });
  const r = readRearm(settings.state);
  const at = new Date(now).toISOString();
  if (job) r.jobs[name] = at;
  else if (which === 'all') r.all = at;
  else r.tickets[which] = at;
  fs.mkdirSync(settings.state, { recursive: true });
  const tmp = `${rearmPath(settings.state)}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2) + '\n');
  fs.renameSync(tmp, rearmPath(settings.state));
  return { file: path.relative(settings.root, rearmPath(settings.state)), key: 'retry', ...(job ? { job: name } : { ticket: which }), at, changed: true };
}

export function setLocal({ settings, key, value, name, unset = false, now = Date.now() }) {
  if (key === 'retry') {
    if (unset) throw new CliError('set retry takes no --unset', { code: 2 });
    return rearm({ settings, which: value, name, now });
  }
  if (!SETTABLE.test(String(key ?? ''))) throw new CliError(`'${key}' is not a key of the local settings file: mode, limits.*, schedule.*, roles.<role>.*, modelLadder, video.*, cleanup.*`, { code: 2 });
  if (/^roles\.[a-z]+\.(allowedTools|disallowedTools)$/.test(key)) throw new CliError(`'${key}' is read only from the tracked settings file, at HEAD: change it there and commit`, { code: 2 });
  if (unset === (value !== undefined)) throw new CliError('set needs a value, or --unset to drop the key and take the default', { code: 2 });
  const localFile = localSettingsPath(settings.file);
  const shared = readJsonFile(settings.file, 'settings file');
  const local = readJsonFile(localFile, 'local settings file') ?? { schemaVersion: 1 };
  const next = structuredClone(local);
  setPath(next, key, unset ? undefined : parseValue(value));
  const checked = validateSettings(deepMerge(shared, next), { root: settings.root, stateRootDefault: settings.stateRel });
  const before = getPath(settings, key) ?? null;
  const after = getPath(checked, key) ?? null;
  const changed = JSON.stringify(getPath(local, key)) !== JSON.stringify(getPath(next, key));
  if (changed) {
    const tmp = `${localFile}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, localFile);
  }
  return { file: path.relative(settings.root, localFile), key, before, after, changed };
}
