import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CliError } from './errors.mjs';

// One lock per group: `<state>/locks/<group>/owner.json`. Taken with mkdir, so two takers can't both win. A lease, not a
// pid: a manual session's shell exits at once. Every record renews it; the runner renews it while its session lives.
// A lock past its lease is stale; only the runner releases one (moved into `<state>/locks/stale/`), never a model.

export const KINDS = ['schedule', 'manual'];
export const locksDir = (state) => path.join(state, 'locks');
const lockDir = (state, group) => path.join(locksDir(state), checkGroup(group));

function checkGroup(group) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(group ?? '')) || ['.', '..', 'stale'].includes(group)) throw new CliError(`'${group}' is not a group id`, { code: 2 });
  return String(group);
}

function writeOwner(dir, owner) {
  const file = path.join(dir, 'owner.json');
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(owner, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function readOwner(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'));
  } catch {
    // A lock folder whose owner file isn't written yet (or is broken) is held, with no lease to read.
    return null;
  }
}

// The lock of a group as it stands: null when free; else its owner and whether its lease is live at `now`.
export function lockOf(state, group, now = Date.now()) {
  const dir = lockDir(state, group);
  if (!fs.existsSync(dir)) return null;
  const owner = readOwner(dir);
  const expires = owner?.expiresAt ? Date.parse(owner.expiresAt) : NaN;
  // An owner file being written right now has no lease yet: count it live for a minute from the folder's time.
  const live = Number.isFinite(expires) ? expires > now : fs.statSync(dir).mtimeMs + 60000 > now;
  return { group, ...(owner ?? {}), live };
}

export function allLocks(state, now = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(locksDir(state), { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  return names.filter((d) => d.isDirectory() && d.name !== 'stale').map((d) => lockOf(state, d.name, now));
}

export function takeLock(state, { group, kind, stage = null, pid = process.pid, leaseMinutes, now = Date.now() }) {
  if (!KINDS.includes(kind)) throw new CliError(`--kind must be ${KINDS.join(' or ')}`, { code: 2 });
  const dir = lockDir(state, group);
  fs.mkdirSync(locksDir(state), { recursive: true });
  try {
    fs.mkdirSync(dir);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return { taken: false, held: lockOf(state, group, now) };
  }
  const owner = { group, kind, stage, pid, startedAt: new Date(now).toISOString(), expiresAt: new Date(now + leaseMinutes * 60000).toISOString() };
  writeOwner(dir, owner);
  return { taken: true, lock: { ...owner, live: true } };
}

export function renewLock(state, group, { leaseMinutes, stage, now = Date.now() } = {}) {
  const dir = lockDir(state, group);
  if (!fs.existsSync(dir)) return null;
  const owner = readOwner(dir) ?? { group };
  const next = { ...owner, ...(stage !== undefined ? { stage } : {}), expiresAt: new Date(now + leaseMinutes * 60000).toISOString() };
  writeOwner(dir, next);
  return next;
}

export function releaseLock(state, group) {
  const dir = lockDir(state, group);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

// A stale lock is moved, not removed: `<state>/locks/stale/<group>-<time>/`, so what it held stays readable.
export function moveStaleLock(state, group, now = Date.now()) {
  const dir = lockDir(state, group);
  if (!fs.existsSync(dir)) return null;
  const staleDir = path.join(locksDir(state), 'stale');
  fs.mkdirSync(staleDir, { recursive: true });
  const dest = path.join(staleDir, `${group}-${new Date(now).toISOString().replace(/[:.]/g, '-')}`);
  fs.renameSync(dir, dest);
  return dest;
}
