import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CliError, exists, flatten, log, readJson, sha256, sortKeys, unique, writeFileAtomic, writeJson } from './util.mjs';
import { compare, latestCommit, listBranches, listDir, readFile } from './gh.mjs';
import { matchesTicket, requireSource, resolveLocaleFiles, resolveLocales } from './config.mjs';
import { diffIsEmpty, diffSnapshots, diffSummary } from './diff.mjs';
import { detectLibraries, importLibrary } from './libs.mjs';
import { isLib, loadStore, PENDING_DIFF } from './store.mjs';

const run = promisify(execFile);
const MIN_COVERAGE = 0.8;

function parseLocaleFile(text, label) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new CliError(`${label} is not valid JSON: ${e.message}`);
  }
  try {
    return flatten(data);
  } catch (e) {
    throw new CliError(`${label}: ${e.message}`);
  }
}

// Reads every locale file of the source at `ref` (a commit SHA or branch). Returns { labels, files }.
async function fetchGithubSet(src, ref, locales, overrides, { tolerant = false, only = null } = {}) {
  const entries = await listDir(src.repo, ref, src.dir);
  const names = entries.filter((e) => e.type === 'file' && e.name.endsWith('.json') && src.fileRe.test(e.name)).map((e) => e.name);
  const { map } = resolveLocaleFiles(locales, names, overrides, { tolerant });
  const wanted = Object.entries(map).filter(([, file]) => !only || only.has(file));
  const texts = await Promise.all(wanted.map(([, file]) => readFile(src.repo, ref, `${src.dir}/${file}`)));
  const labels = {};
  const files = {};
  wanted.forEach(([locale, file], i) => {
    labels[locale] = parseLocaleFile(texts[i], `${src.repo}@${ref.slice(0, 7)} ${src.dir}/${file}`);
    files[locale] = file;
  });
  return { labels, files };
}

async function fetchCommandSet(src, locales, cwd) {
  const labels = {};
  const files = {};
  const texts = [];
  for (const locale of locales) {
    if (!/^[\w-]+$/.test(locale)) throw new CliError(`Unsafe locale code '${locale}'`, { code: 2 });
    let stdout;
    try {
      ({ stdout } = await run('sh', ['-c', src.command.replaceAll('{locale}', locale)], { cwd, maxBuffer: 64 * 1024 * 1024 }));
    } catch (e) {
      throw new CliError(`UI label command failed for '${locale}': ${(e.stderr || e.message).trim()}`);
    }
    labels[locale] = parseLocaleFile(stdout, `command output for '${locale}'`);
    files[locale] = `command:${locale}`;
    texts.push(`${locale}\0${stdout}`);
  }
  return { labels, files, commit: `content:${sha256(texts.join('\0'))}` };
}

// Keys the ticket branch itself added or changed (relative to where it forked from the base), still different from the base.
async function branchOverlay(src, branch, baseCommit, base, locales, overrides) {
  const { mergeBase, files: changedFiles } = await compare(src.repo, baseCommit, branch);
  const touched = new Set(changedFiles.filter((f) => f.startsWith(`${src.dir}/`)).map((f) => f.slice(src.dir.length + 1)));
  const commit = await latestCommit(src.repo, branch, src.dir);
  if (!touched.size) return { commit, mergeBase, keys: {} };
  const [head, fork] = await Promise.all([
    fetchGithubSet(src, branch, locales, overrides, { tolerant: true, only: touched }),
    fetchGithubSet(src, mergeBase, locales, overrides, { tolerant: true, only: touched }),
  ]);
  const keys = {};
  for (const [locale, labels] of Object.entries(head.labels)) {
    for (const [key, text] of Object.entries(labels)) {
      if (fork.labels[locale]?.[key] === text || base[locale]?.[key] === text) continue;
      (keys[key] ??= {})[locale] = text;
    }
  }
  return { commit, mergeBase, keys: sortKeys(keys) };
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

function missingKeys(labels, locales) {
  const reference = unique(['uk', 'en'].flatMap((l) => Object.keys(labels[l] ?? {}))).filter((k) => !isLib(k));
  const out = {};
  for (const locale of locales) {
    const gone = reference.filter((k) => labels[locale]?.[k] === undefined).sort();
    if (gone.length) out[locale] = gone;
  }
  return out;
}

function checkCoverage(labels) {
  const count = (l) => Object.keys(labels[l]).filter((k) => !isLib(k)).length;
  const enCount = count('en');
  const thin = Object.keys(labels).filter((l) => count(l) < MIN_COVERAGE * enCount);
  if (thin.length) {
    throw new CliError(
      `Locale file(s) for ${thin.map((l) => `${l} (${count(l)}/${enCount} keys)`).join(', ')} have under ${MIN_COVERAGE * 100}% of the EN keys. The previous snapshot is untouched.`,
    );
  }
}

export async function runImport(settings, { dryRun = false, noLibs = false, discardPending = false } = {}) {
  const src = requireSource(settings);
  const locales = (await resolveLocales(settings)).all;
  const dir = settings.labelsDir;
  const pendingPath = path.join(dir, PENDING_DIFF);

  if (!discardPending && (await exists(pendingPath))) {
    throw new CliError('The previous import has a label diff that was not synced yet. Run `sync` first (or pass --discard-pending).', { code: 3 });
  }
  const previous = await loadStore(dir);

  let labels;
  let files;
  let commit;
  let overlayBranches = {};
  let libs = {};
  const warnings = [];

  if (src.type === 'github-json') {
    commit = await latestCommit(src.repo, src.branch, src.dir);
    if (!commit) throw new CliError(`No commit found touching ${src.dir} on ${src.repo}@${src.branch}`);
    ({ labels, files } = await fetchGithubSet(src, commit, locales, settings.localeFileOverrides));

    if (!noLibs) {
      const pkg = await readFile(src.repo, commit, 'package.json').catch(() => '{}');
      for (const [name, version] of Object.entries(detectLibraries(pkg))) {
        const prev = previous?.meta.libs?.[name];
        try {
          if (prev?.version === version && sameSet(previous.meta.locales, locales)) {
            const keep = (l) => Object.fromEntries(Object.entries(previous.labels[l] ?? {}).filter(([k]) => k.startsWith(`lib.${name}.`)));
            for (const l of locales) Object.assign(labels[l], keep(l));
            libs[name] = prev;
          } else {
            const { strings, info } = await importLibrary(name, version, locales, files);
            for (const [l, map] of Object.entries(strings)) Object.assign(labels[l], map);
            libs[name] = info;
          }
        } catch (e) {
          warnings.push(`library ${name}@${version} skipped: ${e.message}`);
        }
      }
    }
    checkCoverage(labels);

    if (settings.tickets.length) {
      const branches = (await listBranches(src.repo)).filter((b) => b !== src.branch && matchesTicket(b, settings.tickets));
      for (const branch of branches) {
        try {
          overlayBranches[branch] = await branchOverlay(src, branch, commit, labels, locales, settings.localeFileOverrides);
        } catch (e) {
          warnings.push(`overlay branch ${branch} skipped: ${e.message}`);
        }
      }
    }
  } else {
    ({ labels, files, commit } = await fetchCommandSet(src, locales, settings.root));
    checkCoverage(labels);
    if (settings.tickets.length) warnings.push('ticket overlay is not available for the `command` adapter');
  }

  const libKeyCounts = (l) => Object.keys(labels[l]).filter(isLib).length;
  const diff = previous ? diffSnapshots(previous.labels, labels) : null;
  const meta = {
    version: 1,
    source: src.type === 'github-json' ? { type: src.type, repo: src.repo, branch: src.branch, path: src.glob } : { type: src.type, command: src.command },
    commit,
    importedAt: new Date().toISOString(),
    locales,
    localeMap: files,
    keyCounts: Object.fromEntries(locales.map((l) => [l, Object.keys(labels[l]).length - libKeyCounts(l)])),
    missing: missingKeys(labels, locales),
    ...(Object.keys(libs).length ? { libs } : {}),
  };
  const overlay = {
    tickets: settings.tickets,
    branches: Object.fromEntries(Object.entries(overlayBranches).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  meta.overlay = { tickets: overlay.tickets, branches: Object.fromEntries(Object.entries(overlay.branches).map(([b, o]) => [b, o.commit])) };

  const summary = {
    commit,
    source: meta.source,
    locales,
    localeMap: files,
    keyCounts: meta.keyCounts,
    missing: Object.fromEntries(Object.entries(meta.missing).map(([l, k]) => [l, k.length])),
    libs: Object.fromEntries(Object.entries(libs).map(([n, i]) => [n, { version: i.version, missingLocales: i.missingLocales }])),
    overlay: Object.fromEntries(Object.entries(overlay.branches).map(([b, o]) => [b, { commit: o.commit, keys: Object.keys(o.keys).length }])),
    firstImport: !previous,
    diff: diff ? diffSummary(diff) : null,
    warnings,
    dryRun,
  };
  if (dryRun) return summary;

  // Everything above succeeded, so the previous snapshot can be replaced.
  await Promise.all(locales.map((l) => writeJson(path.join(dir, `${l}.json`), sortKeys(labels[l]))));
  await writeJson(path.join(dir, 'overlay.json'), overlay);
  await writeJson(path.join(dir, 'meta.json'), meta);
  const ignore = path.join(dir, '.gitignore');
  if (!(await exists(ignore))) await writeFileAtomic(ignore, `${PENDING_DIFF}\n`);
  if (diff && !diffIsEmpty(diff)) {
    await writeJson(pendingPath, { from: previous.meta.commit, to: commit, locales, ...diff });
    log(`Label diff saved for \`sync\`: ${JSON.stringify(diffSummary(diff))}`);
  } else {
    await fs.rm(pendingPath, { force: true });
  }
  return summary;
}

export const readPendingDiff = (dir) => readJson(path.join(dir, PENDING_DIFF));
