import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CliError } from './errors.mjs';

// One ledger per ticket, `<state>/tickets/<key>.json`, in the host's git-ignored state folder. Written only through
// `record` (and `handover`), to a temp file and renamed. It keeps only what the tracker, the forge and git can't show.
// The fields are in context/ticket-flow.md ("The ledger").

export const SCHEMA_VERSION = 1;

export const ticketsDir = (state) => path.join(state, 'tickets');
export const ledgerPath = (state, key) => path.join(ticketsDir(state), `${key}.json`);

// A key is the card's team number when its name has one, else its short reference. Safe as a file name.
export function keyOf(card) {
  const raw = card.number !== null && card.number !== undefined ? String(card.number) : String(card.shortLink ?? card.id ?? '');
  const key = raw.replace(/[^A-Za-z0-9._-]/g, '-');
  if (!key) throw new CliError('a card with no number, short link or id has no key', { code: 2 });
  return key;
}

export function checkKey(key) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(key ?? '')) || key === '.' || key === '..') throw new CliError(`'${key}' is not a ticket key (letters, digits, '.', '_', '-')`, { code: 2 });
  return String(key);
}

// Keys in order: numbers by value, then the others by text.
export function sortKeys(keys) {
  const num = (k) => /^\d+$/.test(k);
  return [...new Set(keys.map(String))].sort((a, b) => (num(a) && num(b) ? Number(a) - Number(b) : num(a) ? -1 : num(b) ? 1 : a < b ? -1 : a > b ? 1 : 0));
}

// A group id: its keys in order, joined with '-'.
export const groupId = (keys) => sortKeys(keys).join('-');

export function readLedger(state, key) {
  const file = ledgerPath(state, checkKey(key));
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  let ledger;
  try {
    ledger = JSON.parse(text);
  } catch (e) {
    throw new CliError(`cannot parse ${file}: ${e.message}`, { code: 2 });
  }
  if (ledger.schemaVersion !== SCHEMA_VERSION) throw new CliError(`${file}: schemaVersion ${ledger.schemaVersion}, this script reads ${SCHEMA_VERSION}`, { code: 2 });
  return ledger;
}

const ledgerKeys = (state) => {
  try {
    return fs.readdirSync(ticketsDir(state)).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort().map((n) => n.slice(0, -'.json'.length));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
};

export function readAllLedgers(state) {
  return ledgerKeys(state).map((k) => readLedger(state, k));
}

// Every ledger that reads, and the keys of those that don't, each with its reason (for the watcher: one bad file
// must not cost the events of the others).
export function readLedgersApart(state) {
  const ledgers = [];
  const bad = [];
  for (const k of ledgerKeys(state)) {
    try {
      ledgers.push(readLedger(state, k));
    } catch (e) {
      bad.push({ key: k, error: String(e.message ?? e).split('\n')[0] });
    }
  }
  return { ledgers, bad };
}

export function writeLedger(state, ledger) {
  const file = ledgerPath(state, checkKey(ledger.key));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return file;
}

export function newLedger({ key, card, now, mode = 'pipeline' }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    key,
    group: key,
    seq: 0,
    createdAt: now,
    updatedAt: now,
    mode,
    startedBy: null,
    priority: card?.priority ?? 'medium',
    card: card ? { id: card.id, shortLink: card.shortLink ?? null, url: card.url ?? null, name: card.name ?? null, createdAt: card.createdAt ?? null } : null,
    original: null,
    stage: null,
    stages: {},
    left: null,
    triage: null,
    plan: null,
    questions: [],
    prs: [],
    video: null,
    places: [],
    reviewComments: [],
    summaries: [],
    posted: { card: [], pr: [] },
    files: [],
    runs: [],
    log: [],
    legacy: null,
  };
}

// A PR entry of the ledger. `id` is how commands name it: `<repo>#<number>` once it has a number, `<repo>:<branch>`
// before.
export function newPr({ repo, targets = [], review = null, branch, base = 'main' }) {
  return {
    repo,
    targets,
    review,
    branch,
    base,
    number: null,
    url: null,
    stage: 'writing',
    resumeTo: null,
    label: null,
    reviewersRequested: [],
    pipelineCommits: [],
    readyForMerge: [],
    lastSeenHead: null,
    merged: null,
    chain: {},
    steps: {},
  };
}

export const prId = (pr) => (pr.number ? `${pr.repo}#${pr.number}` : `${pr.repo}:${pr.branch}`);

export function findPr(ledger, ref) {
  const r = String(ref ?? '').trim();
  const hit = ledger.prs.find((p) => prId(p) === r || (p.number && `${p.repo}#${p.number}` === r) || `${p.repo}:${p.branch}` === r || p.branch === r);
  if (!hit) throw new CliError(`ticket ${ledger.key} has no PR '${r}'. Known: ${ledger.prs.map(prId).join(', ') || 'none'}.`, { code: 2 });
  return hit;
}
