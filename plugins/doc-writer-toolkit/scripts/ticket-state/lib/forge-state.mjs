import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readFeed, watchDir } from './feed.mjs';

// The forge check's own memory (lib/forge-watch.mjs), apart from the full check's `feed.json`, so the two checks,
// which may run at the same time, never write one file: one file, one writer.
//   `<state>/watch/forge.json`: `sources` (a cursor per repo, as the feed's), `waits` (the tickets whose comments are
//   not quiet yet: { <key>: { prs, dueAt, why, since } }), `handOns` (the runs it started: { id, pid, keys, at }) and
//   `notified`. Written by the forge check only, under its lock; the full check and the tick read it.
//   `<state>/watch/hand-on/<id>.json`: what one detached run gave (written by that run only), collected and removed
//   by the next check of the one that started it (the forge check or the full check) after the run's process ended.
//   `<state>/watch/hand-on/<id>.step.json`: the one group's step a full check handed on (lib/watch.mjs), with the
//   check's `/usage` reading; written by the full check before the run's process starts, read by that run.
// The full check keeps the runs it started in its own `feed.json` (`handOns`, the same shape plus `group`, `stage` and
// `by`): every reader below takes the live runs of both files, so the forge check, the full check and the runner see
// the same runs going.

export const FORGE_VERSION = 1;
// A hand-on's process older than this is taken for a pid used again, not for the run: the watcher lock's rule.
export const HAND_ON_STALE_MS = 12 * 3600 * 1000;

export const forgePath = (state) => path.join(watchDir(state), 'forge.json');
export const handOnDir = (state) => path.join(watchDir(state), 'hand-on');
export const handOnFile = (state, id) => path.join(handOnDir(state), `${id}.json`);
export const handOnStepFile = (state, id) => path.join(handOnDir(state), `${id}.step.json`);

export const emptyForge = () => ({ schemaVersion: FORGE_VERSION, sources: {}, waits: {}, handOns: [], notified: {} });

export function readForge(state) {
  try {
    return { ...emptyForge(), ...JSON.parse(fs.readFileSync(forgePath(state), 'utf8')) };
  } catch (e) {
    if (e.code === 'ENOENT') return emptyForge();
    throw e;
  }
}

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
};

export const writeForge = (state, forge) => writeJson(forgePath(state), forge);
export const writeHandOn = (state, id, result) => writeJson(handOnFile(state, id), result);
export const writeHandOnStep = (state, id, task) => writeJson(handOnStepFile(state, id), task);

// The step a full check handed to run `id`, or null (a forge check's run has none: it finishes the tickets it names).
export function readHandOnStep(state, id) {
  try {
    return JSON.parse(fs.readFileSync(handOnStepFile(state, id), 'utf8'));
  } catch {
    return null;
  }
}
export const dropHandOnStep = (state, id) => fs.rmSync(handOnStepFile(state, id), { force: true });

export function takeHandOn(state, id) {
  const file = handOnFile(state, id);
  let r = null;
  try {
    r = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* none: the run ended without writing it */
  }
  fs.rmSync(file, { force: true });
  return r;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

// Whether a hand-on's run still goes on: its process lives, and is not older than HAND_ON_STALE_MS.
export const handOnLive = (h, { now = Date.now(), isAlive = alive } = {}) => Boolean(h?.pid) && isAlive(h.pid) && now - Date.parse(h.at) < HAND_ON_STALE_MS;

// The tickets of the forge check's runs that still go on. Their run may not have taken its group lock yet (it reads
// /usage and the status first), so a check holds them as it holds a locked ticket. A file that doesn't read: none.
export function liveHandOnKeys(state, { now = Date.now(), isAlive = alive } = {}) {
  let forge;
  try {
    forge = readForge(state);
  } catch {
    return new Set();
  }
  return new Set((forge.handOns ?? []).filter((h) => handOnLive(h, { now, isAlive })).flatMap((h) => h.keys));
}

// The runs going now across processes, as groups: each live group lock (a run holds it from its first step on), and
// each live run a check started that holds no lock yet (its /usage reading and its status come first), less those of
// `exceptPid`. The forge check, the full check and the runner count `limits.parallel` against this same set.
// `groupOf`: a ticket's group (its ledger's).
export function runsGoing({ locks = [], handOns = [], now = Date.now(), isAlive = alive, exceptPid = null, groupOf = (k) => k } = {}) {
  const groups = new Set(locks.filter((x) => x.live).map((x) => x.group));
  for (const h of handOns) {
    if (h.pid === exceptPid || !handOnLive(h, { now, isAlive })) continue;
    if (h.keys.map(groupOf).some((g) => groups.has(g))) continue;
    groups.add(`run:${h.id}`);
  }
  return groups;
}

// The same, read from the state folder: the group locks and both checks' records (a file that doesn't read: no runs).
export function runsGoingIn(state, { locks = [], now = Date.now(), isAlive = alive, exceptPid = null, groupOf = (k) => k } = {}) {
  return runsGoing({ locks, handOns: allHandOns(state), now, isAlive, exceptPid, groupOf });
}

// The starts a check handed on whose run holds no lock yet: until it takes its group's lock and records the start, the
// status doesn't count the group as open, so no other start is decided meanwhile (lib/watch.mjs).
export function startsInFlight(state, { locks = [], now = Date.now(), isAlive = alive } = {}) {
  const held = new Set(locks.filter((x) => x.live).map((x) => x.group));
  return fullHandOns(state).filter((h) => h.stage === 'start' && handOnLive(h, { now, isAlive }) && !held.has(h.group ?? h.keys[0]));
}
