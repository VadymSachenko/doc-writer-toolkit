import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CliError, exists, gitBlobHash, log, readJson, writeJson } from './util.mjs';
import { deriveLocaleRoot, requireRoots } from './config.mjs';
import { isLib, loadStore, PENDING_DIFF } from './store.mjs';
import { uiParts } from './lookup.mjs';
import { categoryContext, categoryFile, categoryShows, isCategoryId, patchCategory } from './categories.mjs';

const run = promisify(execFile);
const git = (cwd, args) => run('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout);

async function walkJson(dir) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkJson(full)));
    else if (e.name.endsWith('.json')) out.push(full);
  }
  return out;
}

async function findPage(root, rel) {
  for (const ext of ['.md', '.mdx']) {
    const file = path.join(root, rel + ext);
    if (await exists(file)) return file;
  }
  return null;
}

// Replaces **old** with **new** outside fenced code blocks. Returns the new text and the patched lines.
export function replaceBold(text, oldText, newText) {
  const needle = `**${oldText}**`;
  const replacement = `**${newText}**`;
  const lines = text.split('\n');
  const hits = [];
  let fence = null;
  lines.forEach((line, i) => {
    const f = line.match(/^\s*(```+|~~~+)/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return;
    }
    if (fence || !line.includes(needle)) return;
    lines[i] = line.split(needle).join(replacement);
    hits.push({ line: i + 1, text: lines[i].trim().slice(0, 240) });
  });
  return { text: lines.join('\n'), hits };
}

function planChanges(diff) {
  const changes = [
    ...diff.changed.map((c) => ({ fromKey: c.key, toKey: c.key, locales: c.locales })),
    ...diff.rekeyed.map((r) => ({ fromKey: r.from, toKey: r.to, locales: r.locales })),
  ].filter((c) => !isLib(c.fromKey));
  // The same old string renamed to different new strings cannot be patched by replacement; leave those to a writer.
  const targets = new Map();
  for (const c of changes) {
    for (const [locale, v] of Object.entries(c.locales)) {
      if (v.old && v.new && v.old !== v.new) {
        const id = `${locale}\0${v.old}`;
        targets.set(id, new Set([...(targets.get(id) ?? []), v.new]));
      }
    }
  }
  const ambiguous = new Set([...targets].filter(([, set]) => set.size > 1).map(([id]) => id));
  return { changes, ambiguous };
}

async function isDirty(top, files) {
  const out = await git(top, ['-c', 'core.quotePath=false', 'status', '--porcelain', '--', ...files]);
  return out.trim().length > 0;
}

const syncMessage = (store) => `Sync UI labels to ${store.meta.source.repo ?? store.meta.source.type}@${store.meta.commit.replace(/^content:/, '').slice(0, 7)}`;

// One commit holding only these paths: `Sync UI labels to <repo>@<sha7>`. Returns its SHA, or null when nothing changed.
async function commitSync(top, store, paths) {
  await git(top, ['add', '--', ...paths]);
  const staged = (await git(top, ['diff', '--cached', '--name-only', '--', ...paths])).trim();
  if (!staged) return null;
  const message = syncMessage(store);
  await git(top, ['commit', '-m', message, '--', ...paths]);
  log(message);
  return (await git(top, ['rev-parse', 'HEAD'])).trim();
}

// Without `--commit`, the commit the user should make: the message and the changed paths (repo-relative), or null.
async function suggestCommit(top, store, paths) {
  const out = await git(top, ['-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=all', '--', ...paths]);
  const changed = out.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, '')).filter((p) => !p.endsWith(PENDING_DIFF));
  return changed.length ? { message: syncMessage(store), paths: changed.sort() } : null;
}

export async function runSync(settings, { commit = false, dryRun = false, diffFile } = {}) {
  const pendingPath = path.join(settings.labelsDir, PENDING_DIFF);
  const diff = diffFile ? await readJson(path.resolve(diffFile)) : await readJson(pendingPath);
  if (!diff) {
    // No label diff (a first import, or one where only the overlay or the recorded commit moved): `--commit` still
    // commits the new snapshot, so it never lingers as uncommitted changes on the branch.
    const store = !dryRun ? await loadStore(settings.labelsDir) : null;
    if (!store) return { status: 'nothing-to-sync' };
    const top = (await git(settings.root, ['rev-parse', '--show-toplevel'])).trim();
    if (!commit) return { status: 'nothing-to-sync', suggestedCommit: await suggestCommit(top, store, [settings.labelsDir]) };
    return { status: 'nothing-to-sync', commit: await commitSync(top, store, [settings.labelsDir]) };
  }
  const store = await loadStore(settings.labelsDir);
  if (!store) throw new CliError('No label snapshot found. Run `import` first.', { code: 2 });
  const roots = requireRoots(settings);

  const top = (await git(settings.root, ['rev-parse', '--show-toplevel'])).trim();
  const localeRoots = { uk: path.resolve(settings.root, roots.ua), en: path.resolve(settings.root, roots.en) };
  for (const l of store.meta.locales) if (l !== 'uk' && l !== 'en') localeRoots[l] = path.resolve(settings.root, deriveLocaleRoot(roots.en, l));

  const { changes, ambiguous } = planChanges(diff);
  const removed = new Set(diff.removed.map((r) => r.key));

  // Sibling keys: unchanged keys that still carry the changed key's old UA string. A page bound to a sibling keeps
  // showing the old string, so it is reported for a writer instead of being patched or silently skipped.
  const baseUk = store.labels.uk ?? {};
  const inChange = new Set(changes.flatMap((c) => [c.fromKey, c.toKey]));
  const siblings = new Map();
  for (const c of changes) {
    const oldUk = c.locales.uk?.old ?? baseUk[c.toKey];
    if (!oldUk) continue;
    for (const [key, text] of Object.entries(baseUk)) {
      if (text === oldUk && !inChange.has(key) && !isLib(key)) siblings.set(key, [...(siblings.get(key) ?? []), c]);
    }
  }

  const report = { status: 'synced', from: diff.from, to: diff.to, patched: [], alreadyCurrent: [], notFound: [], unpatched: [], checkBinding: [], markupParts: [], broken: [], rekeyed: [], renamedEntries: [], undocumented: [], skipped: [], pagesTouched: 0, commit: null, pendingRemains: false };
  const touched = new Set();
  const brokenBy = new Map();

  const pagesDir = path.join(settings.stateRoot, 'pages');
  for (const stateFile of (await walkJson(pagesDir)).sort()) {
    const rel = path.relative(pagesDir, stateFile).replace(/\.json$/, '');
    const state = await readJson(stateFile);
    const spans = state?.spans ?? {};
    const bound = new Map();
    for (const [text, decision] of Object.entries(spans)) {
      if (decision.startsWith('label:')) bound.set(decision.slice(6), [...(bound.get(decision.slice(6)) ?? []), text]);
    }
    for (const key of bound.keys()) if (removed.has(key)) brokenBy.set(key, [...(brokenBy.get(key) ?? []), rel]);
    const relevant = changes.filter((c) => bound.has(c.fromKey));
    // A `term` span with markup (`⋮&nbsp;>&nbsp;Переглянути`) is written part by part from the store, so no key is bound
    // to it and nothing here patches it. A part that is a changed string is listed for a writer instead of going stale.
    for (const [text, decision] of Object.entries(spans)) {
      if (decision !== 'term' || !uiParts(text).markup) continue;
      for (const c of changes) {
        const ua = c.locales.uk;
        if (ua?.old && ua.old !== ua.new && uiParts(text).parts.includes(ua.old)) report.markupParts.push({ page: rel, span: text, changedKey: c.toKey, old: ua.old, new: ua.new });
      }
    }
    const siblingChecks = [...bound.keys()].flatMap((key) => (siblings.get(key) ?? []).filter((c) => !relevant.includes(c)).map((change) => ({ key, change })));
    if (!relevant.length && !siblingChecks.length) continue;
    for (const c of relevant) if (c.fromKey !== c.toKey) report.rekeyed.push({ from: c.fromKey, to: c.toKey, page: rel });

    // A page is a markdown file per locale. A sidebar category is the UA `_category_.json` plus an entry in each locale's
    // current.json, which every category of that locale shares.
    const category = isCategoryId(rel);
    const files = {};
    for (const [locale, root] of Object.entries(localeRoots)) {
      const file = category ? categoryFile(localeRoots, locale, rel) : await findPage(root, rel);
      if (file && (!category || (await exists(file)))) files[locale] = file;
    }
    if (!files.uk) {
      report.skipped.push({ page: rel, reason: category ? 'UA category file not found' : 'UA page not found' });
      continue;
    }
    const original = {};
    for (const [locale, file] of Object.entries(files)) original[locale] = await fs.readFile(file, 'utf8');
    if (category && !categoryContext(original.uk)) {
      report.skipped.push({ page: rel, reason: 'the UA category file is not valid JSON' });
      continue;
    }
    // The entry keys of a category without `key` follow its UA label: they are only renamed once the UA label has the new value.
    let uaLabelOk = true;
    const categoryCtx = (c) => (category ? { ...categoryContext(original.uk, c.locales.uk), renameKeys: uaLabelOk } : null);
    const shows = (text, locale, v, c) => (category ? categoryShows(text, locale, v.old, categoryCtx(c)) : replaceBold(text, v.old, v.new).hits);
    // One change applied to one file: { text, hits, current, renamed, error }.
    const apply = (text, locale, v, c) => {
      if (category) return patchCategory(text, locale, v, categoryCtx(c));
      const r = replaceBold(text, v.old, v.new);
      return { ...r, current: !r.hits.length && replaceBold(text, v.new, v.new).hits.length > 0, renamed: [] };
    };

    for (const { key, change } of siblingChecks) {
      for (const [locale, v] of Object.entries(change.locales)) {
        if (!v.old || !v.new || v.old === v.new || original[locale] === undefined) continue;
        const hits = shows(original[locale], locale, v, change);
        if (hits.length) {
          report.checkBinding.push({ page: rel, locale, boundKey: key, changedKey: change.toKey, old: v.old, new: v.new, lines: hits.map((h) => h.line) });
        }
      }
    }
    if (!relevant.length) continue;

    // Files written earlier in this run (a current.json shared by several categories) are ours, not uncommitted work.
    if (!dryRun && (await isDirty(top, Object.values(files).filter((f) => !touched.has(f))))) {
      report.skipped.push({ page: rel, reason: 'uncommitted changes in the page or its translations; commit them and re-run sync' });
      continue;
    }

    const texts = {};
    const results = {};
    let anyChange = false;
    for (const locale of Object.keys(files)) {
      let text = original[locale];
      texts[locale] = { before: text };
      results[locale] = true;
      for (const c of relevant) {
        const v = c.locales[locale];
        if (!v) continue; // string identical in this locale
        const entry = { page: rel, locale, key: c.toKey };
        if (!v.old || !v.new) {
          report.unpatched.push({ ...entry, reason: v.new ? 'string was missing in the previous snapshot' : 'string removed for this locale' });
          results[locale] = false;
          continue;
        }
        if (ambiguous.has(`${locale}\0${v.old}`)) {
          report.unpatched.push({ ...entry, old: v.old, reason: 'the same old string was renamed differently for several keys' });
          results[locale] = false;
          continue;
        }
        const r = apply(text, locale, v, c);
        if (category && locale === 'uk') uaLabelOk = uaLabelOk && !r.error && (Boolean(r.hits?.length) || r.current === true);
        if (r.error) {
          report.unpatched.push({ ...entry, old: v.old, new: v.new, reason: r.error });
          results[locale] = false;
        } else if (r.hits.length || r.renamed.length) {
          text = r.text;
          anyChange = true;
          const file = path.relative(top, files[locale]);
          for (const h of r.hits) report.patched.push({ ...entry, file, old: v.old, new: v.new, ...h });
          for (const rn of r.renamed) report.renamedEntries.push({ page: rel, locale, file, ...rn });
        } else if (r.current) {
          report.alreadyCurrent.push({ ...entry, new: v.new });
        } else {
          report.notFound.push({ ...entry, old: v.old });
          results[locale] = false;
        }
      }
      texts[locale].after = text;
    }

    // Rebind spans (and rename UA span text) in the state file.
    const newSpans = { ...spans };
    for (const c of relevant) {
      for (const text of bound.get(c.fromKey)) {
        const uk = c.locales.uk;
        // A category's span is its UA label: it only follows the label once the UA file really has the new value.
        const renamed = uk?.old === text && uk.new && (!category || uaLabelOk) ? uk.new : text;
        if (renamed !== text) delete newSpans[text];
        newSpans[renamed] = `label:${c.toKey}`;
      }
    }
    // Locale pages that were up to date with the UA blob stay up to date with the patched UA blob.
    const blobBefore = gitBlobHash(texts.uk.before);
    const blobAfter = gitBlobHash(texts.uk.after);
    const newLocales = structuredClone(state.locales ?? {});
    for (const [locale, entry] of Object.entries(newLocales)) {
      if (entry.sourceBlob !== blobBefore) continue;
      entry.sourceBlob = blobAfter;
      if (results[locale] !== false) entry.labelSnapshot = store.meta.commit;
    }

    if (!dryRun) {
      for (const [locale, t] of Object.entries(texts)) {
        if (t.after !== t.before) {
          await fs.writeFile(files[locale], t.after);
          touched.add(files[locale]);
        }
      }
      if (anyChange || JSON.stringify(newSpans) !== JSON.stringify(spans)) {
        await writeJson(stateFile, { ...state, spans: newSpans, locales: newLocales });
        touched.add(stateFile);
      }
    }
    if (anyChange) report.pagesTouched++;
  }

  report.broken = [...brokenBy].map(([key, pages]) => ({ key, pages, old: diff.removed.find((r) => r.key === key)?.values?.uk ?? null }));
  report.undocumented = diff.added.filter((a) => !isLib(a.key)).map((a) => ({ key: a.key, uk: a.values.uk ?? null, en: a.values.en ?? null }));
  report.pendingRemains = report.skipped.length > 0;

  if (dryRun) return { ...report, dryRun: true };

  if (!report.pendingRemains && !diffFile) await fs.rm(pendingPath, { force: true });

  if (commit) report.commit = await commitSync(top, store, [...touched, settings.labelsDir]);
  else report.suggestedCommit = await suggestCommit(top, store, [...touched, settings.labelsDir]);
  return report;
}
