import fs from 'node:fs/promises';
import path from 'node:path';
import { CliError, readJson, writeFileAtomic } from '../../ui-labels/lib/util.mjs';
import { runBlocks } from './blocks.mjs';
import { abs, readIfExists } from './pages.mjs';
import { cachedBlob } from './plan.mjs';

const isBlank = (l) => l.trim() === '';
const toLines = (text) => text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');

// Translations as JSON ({ "c1": "<translated block>", … }), or as text, which is easier to write without escaping:
//   @@@ c1
//   <translated block>
//   @@@ c2
//   …
const MARK = /^@@@ (\S+)\s*$/;
async function readTranslations(file) {
  const p = path.resolve(file);
  if (/\.json$/i.test(p)) return readJson(p);
  const raw = await fs.readFile(p, 'utf8').catch(() => {
    throw new CliError(`${file} not found.`, { code: 2 });
  });
  const out = {};
  let id = null;
  for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
    const m = line.match(MARK);
    if (m) out[(id = m[1])] = [];
    else if (id) out[id].push(line);
    else if (line.trim()) throw new CliError(`${file}: text before the first '@@@ <change id>' line.`, { code: 2 });
  }
  return Object.fromEntries(Object.entries(out).map(([k, lines]) => [k, lines.join('\n').replace(/^\n+|\n+$/g, '')]));
}

// Writes a candidate file from the translations of the blocks `blocks` returned: { "c1": "<translated block>", … }, or
// { "full": "<translated page>" } for a page translated in full. The splicing is done here, not by the translator:
// replaced blocks take the place of their `target` lines, added blocks go after their anchor with the blank lines UA
// has before them, removed blocks go with the blank lines before them. Every other byte of the translation stays.
// With `redo` (the same value given to `blocks --redo`), the changes are the re-translated blocks of a current page.
export async function runApply(s, page, { translations: file, out, redo = null }) {
  if (!file || !out) throw new CliError('Usage: locale-sync apply <page> --locales <locale> --translations <file.json> --out <candidate file>', { code: 2 });
  const given = await readTranslations(file);
  if (!given || typeof given !== 'object' || Array.isArray(given) || Object.values(given).some((v) => typeof v !== 'string')) {
    throw new CliError(`${file} must hold { "<change id>": "<translated block>" } or { "full": "<translated page>" }, as JSON or as '@@@ <change id>' sections.`, { code: 2 });
  }
  const { results } = await runBlocks(s, { selectors: [page], redo });
  if (results.length !== 1) throw new CliError('apply needs exactly one page and one locale (--locales <locale>).', { code: 2 });
  const r = results[0];
  if (r.kind === 'category') throw new CliError('A sidebar category has no blocks to apply: pass its { entryKey: message } file to check and record as --candidate.', { code: 2 });
  const base = { page: r.page, locale: r.locale, mode: r.mode, candidate: out };

  if (r.mode === 'full') {
    if (typeof given.full !== 'string') throw new CliError(`${r.page} [${r.locale}] is translated in full: pass { "full": "<translated page>" }.`, { code: 2 });
    await writeFileAtomic(path.resolve(out), given.full.replace(/\r\n/g, '\n').replace(/\n*$/, '\n'));
    return { ...base, applied: ['full'], unmapped: [] };
  }
  if (r.mode !== 'incremental' && r.mode !== 'redo') throw new CliError(`${r.page} [${r.locale}] has nothing to apply (mode ${r.mode}).${r.error ? ` ${r.error}` : ''}`, { code: 2, data: { mode: r.mode } });

  const t = toLines(await readIfExists(abs(s, r.target.path)));
  const b = toLines(await cachedBlob(s.root, r.blob));
  const missing = r.changes.filter((c) => c.op !== 'remove' && !c.verbatim && typeof given[c.id] !== 'string').map((c) => c.id);
  if (missing.length) throw new CliError(`No translation for ${missing.join(', ')}.`, { code: 2, data: { missing } });
  const unknown = Object.keys(given).filter((id) => !r.changes.some((c) => c.id === id));
  if (unknown.length) throw new CliError(`${unknown.join(', ')} are not changes of ${r.page} [${r.locale}]. Run blocks again (with the same --redo): the ids follow the current files.`, { code: 2, data: { unknown } });

  const textOf = (c) => toLines(c.verbatim && typeof given[c.id] !== 'string' ? c.ua.text : given[c.id]);
  const replaceAt = new Map(); // start index -> { end, lines }
  const drop = new Set();
  const insertAfter = new Map(); // index -> [lines…] in the listed order; -1 = start of the file
  const placed = new Map(); // change id -> anchor index, for insertAfterChange chains
  for (const c of r.changes) {
    if (c.op === 'replace') {
      replaceAt.set(c.target.lines[0] - 1, { end: c.target.lines[1] - 1, lines: textOf(c) });
    } else if (c.op === 'remove') {
      let from = c.target.lines[0] - 1;
      while (from > 0 && isBlank(t[from - 1]) && !drop.has(from - 1)) from--;
      for (let i = from; i <= c.target.lines[1] - 1; i++) drop.add(i);
    } else {
      const at = c.insertAfterChange ? placed.get(c.insertAfterChange) : c.insertAtStart ? -1 : c.insertAfter.lines[1] - 1;
      let blanks = 0;
      for (let i = c.ua.lines[0] - 2; i >= 0 && isBlank(b[i]); i--) blanks++;
      const lines = [...Array(at === -1 ? 0 : blanks).fill(''), ...textOf(c), ...(at === -1 ? Array(blanks || 1).fill('') : [])];
      insertAfter.set(at, [...(insertAfter.get(at) ?? []), ...lines]);
      placed.set(c.id, at);
    }
  }

  const outLines = [...(insertAfter.get(-1) ?? [])];
  for (let i = 0; i < t.length; i++) {
    const rep = replaceAt.get(i);
    if (rep) {
      outLines.push(...rep.lines);
      for (let k = i; k <= rep.end; k++) outLines.push(...(insertAfter.get(k) ?? []));
      i = rep.end;
      continue;
    }
    if (!drop.has(i)) outLines.push(t[i]);
    outLines.push(...(insertAfter.get(i) ?? []));
  }
  await writeFileAtomic(path.resolve(out), outLines.join('\n') + '\n');
  return { ...base, source: r.source, applied: r.changes.map((c) => `${c.id}:${c.op}`), unmapped: r.unmapped };
}
