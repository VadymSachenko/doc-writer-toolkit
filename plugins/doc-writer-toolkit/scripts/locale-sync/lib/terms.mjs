import fs from 'node:fs/promises';
import path from 'node:path';
import { CliError, readJson, writeFileAtomic } from '../../ui-labels/lib/util.mjs';
import { runLookup } from '../../ui-labels/lib/lookup.mjs';
import { isLib } from '../../ui-labels/lib/store.mjs';
import { readIfExists } from './pages.mjs';
import { withLock } from './lock.mjs';

// Per-locale term memory (`context/locale-translation.md`, §5): `<state root>/terms/<locale>.tsv`, one
// `<UA term><TAB><translation>` per line, sorted by the UA term in byte order, merged with `merge=union`.

export const termsFile = (s, locale) => path.join(s.stateRoot, 'terms', `${locale}.tsv`);
const norm = (t) => t.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('uk');
const byBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// Entries in file order. A UA term on two lines (two branches merged with different translations) is a conflict:
// the first line wins until a writer deletes one.
export async function readTerms(s, locale) {
  const raw = (await readIfExists(termsFile(s, locale))) ?? '';
  const entries = [];
  const seen = new Map();
  const conflicts = [];
  const bad = [];
  raw.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    const parts = line.replace(/\r$/, '').split('\t');
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) return bad.push({ line: i + 1, text: line });
    const [ua, target] = parts;
    const first = seen.get(norm(ua));
    if (first) {
      if (first.target !== target) conflicts.push({ ua, used: first.target, ignored: target, line: i + 1 });
      return;
    }
    const entry = { ua, target };
    seen.set(norm(ua), entry);
    entries.push(entry);
  });
  return { entries, conflicts, bad, byUa: seen };
}

// A UA word in dictionary form matches its inflected forms by prefix: short words exactly, a 4-letter word without
// its last letter, longer words without their last two. Extra matches only cost a table row.
function stem(word) {
  const letters = [...word];
  if (letters.length <= 3) return { text: word, open: false };
  return { text: letters.slice(0, Math.max(3, letters.length - (letters.length === 4 ? 1 : 2))).join(''), open: true };
}
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD = "[\\p{L}\\p{N}'’ʼ-]";

export function termMatcher(ua) {
  const words = ua.normalize('NFC').trim().split(/\s+/).map(stem);
  const body = words.map((w) => esc(w.text) + (w.open ? `${WORD}*` : '')).join('\\s+');
  return new RegExp(`(?<!${WORD})${body}(?!${WORD})`, 'iu');
}

// The entries whose UA term occurs in `text` (T4): never the whole file.
export function matchTerms(entries, text) {
  const t = text.normalize('NFC');
  return entries.filter((e) => termMatcher(e.ua).test(t));
}

// Entries to add: a TSV file in the term-memory format, or JSON ({ ua: target } or [{ ua, target }]).
async function readAdditions(file) {
  const p = path.resolve(file);
  if (/\.json$/i.test(p)) {
    const data = await readJson(p);
    const list = Array.isArray(data) ? data : data && typeof data === 'object' ? Object.entries(data).map(([ua, target]) => ({ ua, target })) : null;
    if (!list || list.some((e) => typeof e?.ua !== 'string' || typeof e?.target !== 'string')) {
      throw new CliError(`${file} must be a JSON object { "<UA term>": "<translation>" } or an array of { ua, target }.`, { code: 2 });
    }
    return list;
  }
  const raw = await fs.readFile(p, 'utf8').catch(() => {
    throw new CliError(`${file} not found.`, { code: 2 });
  });
  return raw
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim())
    .map((l) => {
      const parts = l.split('\t');
      if (parts.length !== 2) throw new CliError(`${file}: '${l}' is not '<UA term><TAB><translation>'.`, { code: 2 });
      return { ua: parts[0], target: parts[1] };
    });
}

// Appends new entries; a recorded term is never re-translated (T2), so a different translation is a conflict, not written.
export async function addTerms(s, locale, file, { dryRun = false } = {}) {
  const additions = await readAdditions(file);
  const target = termsFile(s, locale);
  return withLock(target, async () => {
    const { byUa } = await readTerms(s, locale);
    const raw = (await readIfExists(target)) ?? '';
    const lines = raw.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
    const added = [];
    const existing = [];
    const conflicts = [];
    const rejected = [];
    for (const { ua: u, target: t } of additions) {
      const ua = u.normalize('NFC').trim();
      const tr = t.normalize('NFC').trim();
      if (!ua || !tr || /[\t\n]/.test(ua + tr)) {
        rejected.push({ ua: u, target: t, reason: 'empty, or contains a tab or a line break' });
        continue;
      }
      const known = byUa.get(norm(ua));
      if (known) {
        (known.target === tr ? existing : conflicts).push({ ua, recorded: known.target, ...(known.target === tr ? {} : { proposed: tr }) });
        continue;
      }
      const entry = { ua, target: tr };
      byUa.set(norm(ua), entry);
      added.push(entry);
      lines.push(`${ua}\t${tr}`);
    }
    if (!dryRun && added.length) {
      lines.sort((a, b) => byBytes(a.split('\t')[0], b.split('\t')[0]) || byBytes(a, b));
      await writeFileAtomic(target, lines.join('\n') + '\n');
    }
    const gitattributes = dryRun ? 'dry-run' : await ensureUnionMerge(s);
    return { locale, file: path.relative(s.root, target), dryRun, added, existing, conflicts, rejected, gitattributes };
  });
}

// For the terminology pass: per UA term (dictionary form), the app's string when the term equals a UI string (T1), and
// the recorded translation per locale (T2). `missing` lists the terms with no entry yet; for one with a `ui` string the
// entry to record is that string, so only the others need a translation. `blocks` applies T1 again when it reads them.
export async function lookupTerms(s, terms, locales) {
  const warnings = [];
  let ui = null;
  try {
    ui = await runLookup(s, { spans: terms, locales });
  } catch (e) {
    if (!(e instanceof CliError) || e.exitCode !== 2) throw e;
    warnings.push(`${e.message} Terms are not compared with the UI strings.`);
  }
  const memory = {};
  for (const l of locales) memory[l] = await readTerms(s, l);
  const missing = Object.fromEntries(locales.map((l) => [l, []]));
  const rows = terms.map((ua, i) => {
    const hit = ui?.results[i];
    // Library strings don't count for T1 (as in `blocks`): a library's aria labels and defaults are not the app's words.
    const uiRow = hit?.class === 'label' && hit.match !== 'pattern' && !isLib(hit.key) ? { key: hit.key, values: hit.values } : null;
    const recorded = Object.fromEntries(locales.map((l) => [l, memory[l].byUa.get(norm(ua))?.target ?? null]));
    for (const l of locales) if (!recorded[l]) missing[l].push(ua);
    return { ua, ui: uiRow, ...(hit?.status === 'ambiguous' ? { uiCandidates: hit.candidates.map((c) => c.key) } : {}), recorded };
  });
  const conflicts = Object.fromEntries(locales.filter((l) => memory[l].conflicts.length).map((l) => [l, memory[l].conflicts]));
  return { locales, terms: rows, missing, conflicts, warnings };
}

// `.gitattributes` keeps both branches' new lines when term files merge (locale-translation.md, §5).
async function ensureUnionMerge(s) {
  const rel = path.relative(s.root, path.join(s.stateRoot, 'terms')).split(path.sep).join('/');
  if (rel.startsWith('..') || path.isAbsolute(rel)) return 'outside-repo'; // a state root outside the repo: nothing to merge
  const line = `${rel}/*.tsv merge=union`;
  const file = path.join(s.root, '.gitattributes');
  const raw = (await readIfExists(file)) ?? '';
  if (raw.split('\n').some((l) => l.trim() === line)) return 'present';
  await fs.appendFile(file, `${raw && !raw.endsWith('\n') ? '\n' : ''}${line}\n`);
  return 'added';
}
