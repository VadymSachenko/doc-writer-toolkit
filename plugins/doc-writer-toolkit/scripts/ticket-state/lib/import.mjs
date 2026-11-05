import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CliError } from './errors.mjs';
import { checkKey, newLedger, newPr, readLedger, writeLedger } from './ledger.mjs';
import { prLinks } from './world.mjs';
import { moveToTrash } from './cleanup.mjs';
import { PR_STAGE_FROM_CARD } from './handover.mjs';
import { SIZES } from './settings.mjs';

// `import`: a host's Markdown ledgers from before the JSON ones (`<from>/<key>.md`, one `name: value` line per fact, an
// append log in which a name may repeat), each into `<state>/tickets/<key>.json`. Every line of the Markdown goes into
// the JSON verbatim, with its line number (`legacy.mapped` for the lines that also filled a field, `legacy.fields` for
// the rest), so the JSON holds all of it. Then the tracker and the forge say where each ticket is:
//   - closed (no PR open, and the card done, out of scope, archived or gone): `mode hand` with its close recorded; its
//     Markdown is removed once a check shows that the JSON rebuilds it byte for byte;
//   - open, its card in the ready status, no PR, the last stage `triaged`: a ready ticket the pipeline may start
//     (`mode pipeline`), as a triaged ready card with no ledger already is;
//   - any other open ticket: `mode hand` until `handover`, its Markdown untouched.
// The JSON's stages are the ones `handover` rebuilds (`pr` with a PR, else `start` once the card left the ready
// status); the old stage lines are in the log. The removal is this module's own step, never a session's command, and
// the morning run repeats it for tickets that closed since (`removeClosedMarkdown`).

const LINE = /^([A-Za-z_][\w.-]*(?:\[[^\]\n]*\])?): (.*)$/;
const URL_RE = /https?:\/\/[^\s)>"'«»]+/;

// The old stage words, as the JSON ledger's stages. `translated` was the EN translation, a PR stage now.
export const LEGACY_STAGE = { triaged: 'triage', gathered: 'start', planned: 'plan', 'blocked-video': 'videoGate', 'blocked-plan': 'planGate', drafted: 'write', 'pr-open': 'pr', translated: 'pr', closed: 'close' };

// The lines of a Markdown ledger: { n, key, value } for `name: value`, { n, raw } for anything else.
export function parseMarkdown(text) {
  const endsWithNewline = text.endsWith('\n');
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split('\n');
  return {
    endsWithNewline,
    lines: lines.map((raw, i) => {
      const m = LINE.exec(raw);
      return m ? { n: i + 1, key: m[1], value: m[2] } : { n: i + 1, raw };
    }),
  };
}

const lineText = (e) => (e.raw !== undefined ? e.raw : `${e.key}: ${e.value}`);

// Does the JSON's `legacy` rebuild this Markdown exactly? Every line once, in order, byte for byte.
export function holdsEveryLine(legacy, text) {
  if (!legacy?.mapped || !legacy?.fields) return { ok: false, why: 'no legacy lines' };
  const all = [...legacy.mapped, ...legacy.fields].sort((a, b) => a.n - b.n);
  for (let i = 0; i < all.length; i++) if (all[i].n !== i + 1) return { ok: false, why: `line ${i + 1} is missing or repeated` };
  const count = parseMarkdown(text).lines.length;
  if (all.length !== count) return { ok: false, why: `the Markdown has ${count} lines, the JSON holds ${all.length} (changed since the import)` };
  const rebuilt = all.map(lineText).join('\n') + (legacy.endsWithNewline ? '\n' : '');
  if (rebuilt !== text) return { ok: false, why: 'the Markdown differs from what the JSON holds (changed since the import)' };
  return { ok: true };
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const shortLinkOf = (url) => /\/c\/([A-Za-z0-9]+)/.exec(url ?? '')?.[1] ?? null;
// `—`, or `— (why)`: nothing.
const empty = (v) => /^[—–-]?$/.test(String(v ?? '').trim()) || /^[—–-]\s/.test(String(v ?? '').trim());
const words = (s) => String(s).toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ');

// A repo by its name or its last part (`api` for `acme-api`).
function repoNamed(settings, word) {
  const w = String(word ?? '').toLowerCase();
  if (w.length < 3) return null;
  return settings.forge.repos.find((r) => r.toLowerCase() === w) ?? settings.forge.repos.find((r) => r.toLowerCase().endsWith(`-${w}`)) ?? null;
}

// The per-repo forms of a name: `branch[R]`, `branch.R`, or `branch` with the value `R=...`.
function perRepo(key, value) {
  let m = /^(\w+)\[([^\]]+)\]$/.exec(key);
  if (m) return { name: m[1], repo: m[2], value };
  m = /^(\w+)\.(.+)$/.exec(key);
  if (m) return { name: m[1], repo: m[2], value };
  m = /^([A-Za-z][\w.-]*)=(.*)$/.exec(value);
  if (m) return { name: key, repo: m[1], value: m[2] };
  return { name: key, repo: null, value };
}

// `targets`: `Label → where; Label → where; Label — not documented`. A label is a target's app label (the same words
// in any order); a part with no arrow is not a target.
function targetsOf(value, settings) {
  const ids = [];
  const unknown = [];
  if (empty(value)) return { ids, unknown };
  for (const part of value.split(';')) {
    const m = /^\s*([^→]+?)\s*→/.exec(part);
    if (!m) continue;
    const t = settings.targets.find((x) => x.appLabel && words(x.appLabel) === words(m[1]));
    if (t) {
      if (!ids.includes(t.id)) ids.push(t.id);
    } else unknown.push(m[1]);
  }
  return { ids, unknown };
}

// `pages`: `REPO path — what; path (what), path`. A part with no repo takes the one before it.
function pagesOf(value, settings) {
  const out = [];
  if (empty(value)) return out;
  let repo = null;
  for (const part of value.split(';')) {
    const head = part.split(/\s+[—–]\s+|\s+\(/)[0].trim();
    const tokens = head.split(/\s+/).filter(Boolean);
    const named = repoNamed(settings, tokens[0]);
    if (named) {
      repo = named;
      tokens.shift();
    }
    for (const item of tokens.join(' ').split(/,\s*/)) {
      const p = item.trim().split(/\s+/)[0];
      if (p && /[./]/.test(p) && !out.some((x) => x.repo === repo && x.path === p)) out.push({ repo, path: p });
    }
  }
  return out;
}

// `relations`: ticket keys, with notes in brackets; a number after `#` (`PR #51`) is not one.
function relationsOf(value) {
  if (empty(value)) return [];
  const bare = value.replace(/\([^)]*\)/g, ' ');
  return [...new Set([...bare.matchAll(/(?:^|[\s,;])([A-Za-z]?\d+)(?=$|[\s,;])/g)].map((m) => m[1]))];
}

// One Markdown ledger as a JSON ledger, before the tracker and the forge are asked. `sizes`: { host word: size }.
export function fromMarkdown({ key, file, text, settings, sizes = {}, now }) {
  const at = new Date(now).toISOString();
  const { lines, endsWithNewline } = parseMarkdown(text);
  const l = newLedger({ key, card: null, now: at, mode: 'hand' });
  const mapped = [];
  const fields = [];
  const map = (e, to) => mapped.push({ ...e, to });
  const triage = { verdict: null, targets: [], size: null, relations: [], pages: [], at: null };
  const misses = [];
  const byRepo = new Map(); // repo -> { branch, links }
  const entry = (repo) => {
    if (!byRepo.has(repo)) byRepo.set(repo, { branch: null, links: [] });
    return byRepo.get(repo);
  };
  const stages = [];

  for (const e of lines) {
    if (e.raw !== undefined) {
      fields.push(e);
      continue;
    }
    const v = e.value.trim();
    const pr = perRepo(e.key, e.value);
    switch (pr.repo ? pr.name : e.key) {
      case 'key':
        if (v === key) map(e, 'key');
        else fields.push(e);
        break;
      case 'stage':
        stages.push(v);
        map(e, 'log');
        break;
      case 'group':
        if (/^[A-Za-z0-9._-]+$/.test(v)) {
          l.group = v;
          map(e, 'group');
        } else fields.push(e);
        break;
      case 'docs_card': {
        const url = URL_RE.exec(v)?.[0];
        if (url && !l.card) {
          l.card = { id: null, shortLink: shortLinkOf(url), url, name: null, createdAt: null };
          map(e, 'card');
        } else fields.push(e);
        break;
      }
      case 'original': {
        const url = URL_RE.exec(v)?.[0];
        if (url && !l.original) {
          l.original = { shortLink: shortLinkOf(url), url };
          map(e, 'original');
        } else fields.push(e);
        break;
      }
      case 'verdict':
        triage.verdict = v;
        map(e, 'triage.verdict');
        break;
      case 'targets': {
        const t = targetsOf(e.value, settings);
        triage.targets = t.ids;
        if (t.unknown.length) misses.push(`target label(s) ${t.unknown.map((x) => `'${x}'`).join(', ')} name no target`);
        map(e, 'triage.targets');
        break;
      }
      case 'size':
        triage.size = empty(v) ? null : SIZES.includes(v) ? v : sizes[v] ?? null;
        if (!empty(v) && !triage.size) misses.push(`size '${v}' (no --size for it)`);
        map(e, 'triage.size');
        break;
      case 'relations':
        triage.relations = relationsOf(e.value);
        map(e, 'triage.relations');
        break;
      case 'pages':
        triage.pages = pagesOf(e.value, settings);
        map(e, 'triage.pages');
        break;
      case 'triaged_at': {
        const t = Date.parse(v);
        if (Number.isNaN(t)) fields.push(e);
        else {
          triage.at = new Date(t).toISOString();
          map(e, 'triage.at');
        }
        break;
      }
      case 'branch': {
        const repo = pr.repo ? repoNamed(settings, pr.repo) : null;
        const branch = /^\s*([A-Za-z0-9][\w./-]*)/.exec(pr.value)?.[1];
        if (repo && branch) {
          if (!entry(repo).branch) entry(repo).branch = branch;
          map(e, `prs[${repo}].branch`);
        } else fields.push(e);
        break;
      }
      case 'pr': {
        const repo = pr.repo ? repoNamed(settings, pr.repo) : null;
        const own = prLinks(e.value, settings).filter((x) => !repo || x.repo === repo);
        if (own.length) {
          for (const x of own) if (!entry(x.repo).links.includes(x.number)) entry(x.repo).links.push(x.number);
          map(e, 'prs');
        } else fields.push(e);
        break;
      }
      default:
        fields.push(e);
    }
  }

  l.triage = triage;
  for (const [repo, x] of byRepo) {
    for (const number of x.links) {
      const targets = settings.targets.filter((t) => t.repo === repo);
      const named = targets.filter((t) => triage.targets.includes(t.id));
      const use = named.length ? named : targets;
      const p = newPr({ repo, targets: use.map((t) => t.id), review: use.some((t) => t.review === 'sme') ? 'sme' : 'places', branch: x.branch });
      p.number = number;
      p.url = `https://github.com/${settings.forge.owner}/${repo}/pull/${number}`;
      l.prs.push(p);
    }
  }
  const branchOnly = [...byRepo].filter(([, x]) => x.branch && !x.links.length).map(([r]) => r);
  if (branchOnly.length) misses.push(`a branch with no PR link in ${branchOnly.join(', ')} (kept in the legacy lines only)`);

  for (const s of stages) {
    l.seq += 1;
    l.log.push({ seq: l.seq, at, stage: LEGACY_STAGE[s] ?? 'legacy', outcome: 'done', note: `imported: the Markdown ledger's stage '${s}'` });
  }
  const last = stages.at(-1) ?? null;
  if (!last) misses.push('no stage line');
  else if (!LEGACY_STAGE[last]) misses.push(`stage '${last}' is not a known old stage`);
  if (!l.card) misses.push('no card URL (docs_card)');
  l.stage = stages.map((s) => LEGACY_STAGE[s]).filter(Boolean).at(-1) ?? null;
  l.createdAt = triage.at ?? at;
  l.legacy = { from: path.basename(file), importedAt: at, sha256: sha256(text), endsWithNewline, lastStage: last, misses, mapped, fields };
  return l;
}

// Where a ticket is now: its card (by the URL the ledger names, archived too) and each PR's state. A card or PR the
// service no longer has counts as gone.
export async function whereIs(l, clients) {
  let card = null;
  if (l.card?.id || l.card?.url) card = (await clients.tracker.findCards({ link: l.card.id ?? l.card.url })).cards[0] ?? null;
  const prs = [];
  for (const p of l.prs ?? []) {
    if (!p.number) continue;
    try {
      const st = await clients.forge.prState({ repo: p.repo, number: p.number });
      prs.push({ id: `${p.repo}#${p.number}`, state: st.state, st });
    } catch (e) {
      if (e.data?.status !== 404) throw e;
      prs.push({ id: `${p.repo}#${p.number}`, state: 'gone', st: null });
    }
  }
  const cardClosed = !card || Boolean(card.closed) || ['done', 'outOfScope'].includes(card.status);
  return { card, prs, closed: cardClosed && !prs.some((p) => p.state === 'open') };
}

// What the tracker and the forge say, into an imported ledger: the card, each PR's state, the mode, and for a closed
// ticket its close. Returns `closed`, `ready` or `open`.
function settle(l, where, at) {
  const { card } = where;
  if (card) {
    l.card = { id: card.id, shortLink: card.shortLink ?? l.card?.shortLink ?? null, url: card.url ?? l.card?.url ?? null, name: card.name ?? null, createdAt: card.createdAt ?? null };
    l.priority = card.priority ?? 'medium';
    if (card.status && !card.closed) l.left = { status: card.status, list: { id: card.list?.id ?? null, name: card.list?.name ?? null }, at };
  }
  for (const p of l.prs) {
    const v = where.prs.find((x) => x.id === `${p.repo}#${p.number}`)?.st;
    if (!v) continue;
    p.branch = p.branch ?? v.head ?? null;
    p.base = v.base ?? p.base;
    p.url = v.url ?? p.url;
    p.lastSeenHead = v.headCommit ?? null;
    p.stage = v.state === 'merged' ? 'merged' : PR_STAGE_FROM_CARD[card?.status] ?? 'finalReview';
    if (v.state === 'merged') p.merged = { at: v.mergedAt ?? null, commit: v.mergeCommit ?? null };
  }
  let state;
  l.seq += 1;
  if (where.closed) {
    state = 'closed';
    l.mode = 'hand';
    l.stages.close = { status: 'done', seq: l.seq, at, note: 'imported closed' };
    l.stage = 'close';
  } else if (card?.status === 'ready' && !l.prs.length && l.legacy.lastStage === 'triaged') {
    state = 'ready';
    l.mode = 'pipeline';
    l.stages.triage = { status: 'done', seq: l.seq, at, note: 'imported' };
    l.stage = 'triage';
  } else {
    state = 'open';
    l.mode = 'hand';
    if (l.prs.length) l.stages.pr = { status: 'done', seq: l.seq, at, note: 'imported' };
    else if (card?.status && card.status !== 'ready') l.stages.start = { status: 'done', seq: l.seq, at, note: 'imported' };
  }
  l.seq += 1;
  l.log.push({ seq: l.seq, at, stage: 'import', outcome: 'done', note: `imported from ${l.legacy.from}: ${state}, mode ${l.mode}, ${l.prs.length} PR(s)` });
  l.legacy.seq = l.seq;
  l.updatedAt = at;
  return state;
}

const mdFiles = (dir) => {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.md') && !n.startsWith('.')).sort();
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
};

const defaultTrash = (settings) => settings.cleanup.trashDir ?? path.join(os.homedir(), '.Trash');

// The import. `from`: the folder of the Markdown ledgers (default: the state folder). `sizes`: { host word: size }.
// An imported ledger nothing has recorded into since is imported again when its Markdown changed; any other existing
// ledger is left alone.
export async function runImport({ settings, clients, from = null, sizes = {}, dryRun = false, now = Date.now(), trashDir = defaultTrash(settings) }) {
  for (const [word, size] of Object.entries(sizes)) if (!SIZES.includes(size)) throw new CliError(`--size ${word}=${size}: the size must be one of ${SIZES.join(', ')}`, { code: 2 });
  const dir = from ? path.resolve(settings.root, from) : settings.state;
  const at = new Date(now).toISOString();
  const out = { from: path.relative(settings.root, dir) || '.', dryRun, imported: [], skipped: [], removed: [], kept: [] };
  const planned = new Map();
  for (const name of mdFiles(dir)) {
    const key = name.slice(0, -'.md'.length);
    try {
      checkKey(key);
    } catch {
      out.skipped.push({ file: name, why: 'the file name is not a ticket key' });
      continue;
    }
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const existing = readLedger(settings.state, key);
    if (existing && !existing.legacy?.mapped) {
      out.skipped.push({ key, file: name, why: 'a ledger with this key exists, not from an import: nothing written, the Markdown kept' });
      continue;
    }
    if (existing && existing.legacy.seq !== existing.seq) {
      out.skipped.push({ key, file: name, why: 'imported before and recorded into since: not imported again' });
      continue;
    }
    if (existing && existing.legacy.sha256 === sha256(text)) {
      out.skipped.push({ key, file: name, why: 'imported before, unchanged' });
      continue;
    }
    const l = fromMarkdown({ key, file: name, text, settings, sizes, now });
    const state = settle(l, await whereIs(l, clients), at);
    const check = holdsEveryLine(l.legacy, text);
    if (!check.ok) throw new Error(`import of ${name}: ${check.why}`); // a fault of this module: stop before writing
    if (dryRun) planned.set(key, { state, legacy: l.legacy });
    else writeLedger(settings.state, l);
    out.imported.push({ key, file: name, again: Boolean(existing), state, mode: l.mode, stage: l.stage, lastStage: l.legacy.lastStage, group: l.group, card: l.card?.shortLink ?? null, prs: l.prs.map((p) => `${p.repo}#${p.number}${p.stage === 'merged' ? ' merged' : ''}`), triage: { verdict: l.triage.verdict, size: l.triage.size, targets: l.triage.targets, relations: l.triage.relations, pages: l.triage.pages.length }, lines: { mapped: l.legacy.mapped.length, kept: l.legacy.fields.length }, misses: l.legacy.misses });
  }
  const r = await removeClosedMarkdown({ settings, clients, from: dir, dryRun, trashDir, planned, now });
  out.removed = r.removed;
  out.kept = r.kept;
  return out;
}

// The removal, alone: each Markdown ledger whose JSON came from it is removed (to the Trash, or deleted with
// `cleanup.mode: delete`) once its ticket is closed and the JSON rebuilds it exactly. The morning run repeats it.
// An imported ticket that closed since, still the owner's and with nothing recorded into it, gets its close recorded
// first, as the import records it for a ticket closed already. `planned`: in a dry run, what the import would have
// written, by key.
export async function removeClosedMarkdown({ settings, clients, from = null, dryRun = false, trashDir = defaultTrash(settings), planned = new Map(), now = Date.now() }) {
  const dir = from ?? settings.state;
  const removed = [];
  const kept = [];
  const at = new Date(now).toISOString();
  for (const name of mdFiles(dir)) {
    const key = name.slice(0, -'.md'.length);
    let l = null;
    try {
      l = readLedger(settings.state, checkKey(key));
    } catch {
      continue;
    }
    const plan = planned.get(key);
    const legacy = plan?.legacy ?? l?.legacy;
    if (!legacy?.mapped || legacy.from !== name) continue;
    const abs = path.join(dir, name);
    const closed = plan ? plan.state === 'closed' : l.stages?.close?.status === 'done' || (await whereIs(l, clients)).closed;
    if (!closed) {
      kept.push({ key, file: name, why: plan?.state === 'ready' ? 'open: ready, the pipeline may start it' : 'open' });
      continue;
    }
    if (!plan && !dryRun && l.mode === 'hand' && l.stages?.close?.status !== 'done' && l.legacy.seq === l.seq) {
      l.seq += 1;
      l.stages.close = { status: 'done', seq: l.seq, at, note: 'closed after the import' };
      l.stage = 'close';
      l.log.push({ seq: l.seq, at, stage: 'close', outcome: 'done', note: 'imported ticket closed since: its card done or archived, no PR open' });
      l.legacy.seq = l.seq;
      l.updatedAt = at;
      writeLedger(settings.state, l);
    }
    const check = holdsEveryLine(legacy, fs.readFileSync(abs, 'utf8'));
    if (!check.ok) {
      kept.push({ key, file: name, why: `closed, but ${check.why}: run the import again` });
      continue;
    }
    if (dryRun) removed.push({ key, file: name, to: settings.cleanup.mode === 'delete' ? 'deleted' : 'the Trash', dryRun: true });
    else if (settings.cleanup.mode === 'delete') {
      fs.unlinkSync(abs);
      removed.push({ key, file: name, to: 'deleted' });
    } else removed.push({ key, file: name, to: moveToTrash(abs, trashDir) });
  }
  return { removed, kept };
}
