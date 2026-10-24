import fs from 'node:fs/promises';
import path from 'node:path';
import { CliError, writeJson } from '../../ui-labels/lib/util.mjs';
import { cleanDir, within, requireMultilocale } from './config.mjs';

const posix = path.posix;
const IMAGE = /^[^/\\]+\.(png|jpe?g|webp|gif)$/i;
const PAGE = /\.(md|mdx)$/;

export async function readManifest(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new CliError(`No manifest at ${file}. Write the shots first (screenshot-locales.md).`, { code: 2 });
    throw e;
  }
  let m;
  try {
    m = JSON.parse(text);
  } catch (e) {
    throw new CliError(`Cannot parse the manifest ${file}: ${e.message}`, { code: 2 });
  }
  if (!m || !Array.isArray(m.scenarios) || m.scenarios.some((sc) => !sc || !Array.isArray(sc.shots))) {
    throw new CliError(`The manifest ${file} needs "scenarios": [ { "scenarioId", "shots": [ … ] } ].`, { code: 2 });
  }
  return m;
}

export const allShots = (m) => m.scenarios.flatMap((sc) => sc.shots.map((shot) => ({ scenarioId: sc.scenarioId ?? null, shot })));

// 'file' | 'symlink' | 'missing' (an lstat: a symlink is never followed).
export async function kind(abs) {
  try {
    const st = await fs.lstat(abs);
    return st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : 'other';
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return 'missing';
    throw e;
  }
}

async function isCapture(abs) {
  if ((await kind(abs)) !== 'file') return false;
  return (await fs.stat(abs)).size > 0;
}

// Where one shot goes in every locale it needs: { problems, required, output, staged }.
export function planShot(cfg, shot) {
  const problems = [];
  const id = shot.shotId;
  const fail = (message) => problems.push({ shotId: id ?? null, message });
  if (typeof id !== 'string' || !id.trim()) fail('A shot needs a "shotId".');
  if (typeof shot.file !== 'string' || !IMAGE.test(shot.file)) fail(`"file" must be an image file name with no folder (got ${JSON.stringify(shot.file)}).`);
  if (typeof shot.page !== 'string' || !PAGE.test(shot.page)) fail(`"page" must be the page's path from the repo root, ending in .md or .mdx (got ${JSON.stringify(shot.page)}).`);
  if (problems.length) return { problems };

  const page = cleanDir(shot.page);
  const pair = cfg.pairs.find((p) => within(page, cleanDir(p.ua)));
  if (!pair) {
    fail(`"page" ${page} is under no declared UA content root (${cfg.pairs.map((p) => `${cleanDir(p.ua)}/`).join(', ')}). Its locale folders can't be derived.`);
    return { problems };
  }
  let required = cfg.locales;
  if (shot.locales !== undefined) {
    if (!Array.isArray(shot.locales) || !shot.locales.length) fail('"locales", when present, lists the locales of a locale-scoped request.');
    else {
      const unknown = shot.locales.filter((l) => !cfg.locales.includes(l));
      if (unknown.length) fail(`"locales" names ${unknown.join(', ')}, not a declared screenshot locale (declared: ${cfg.locales.join(', ')}).`);
      required = cfg.locales.filter((l) => shot.locales.includes(l));
    }
  }
  if (problems.length) return { problems };

  const rel = posix.relative(cleanDir(pair.ua), posix.dirname(page));
  const ext = posix.extname(shot.file);
  const stem = shot.file.slice(0, -ext.length);
  const output = {};
  const staged = {};
  for (const locale of required) {
    output[locale] = posix.join(cfg.roots[pair.id][locale], rel, '.assets', shot.file);
    staged[locale] = posix.join(cfg.stagingRoot, posix.dirname(page), stem, `${locale}${ext}`);
  }
  return { problems, pair: pair.id, required, output, staged };
}

const today = () => new Date().toISOString().slice(0, 10);
const committed = (shot) => Array.isArray(shot.requiredLocales) && shot.requiredLocales.length > 0 && shot.requiredLocales.every((l) => shot.status?.[l] === 'committed');
const parseIds = (spec) => (spec ? new Set(String(spec).split(',').map((x) => x.trim()).filter(Boolean)) : null);

function checkIds(m, selected) {
  const problems = [];
  const seen = new Set();
  for (const { shot } of allShots(m)) {
    if (seen.has(shot.shotId)) problems.push({ shotId: shot.shotId, message: `Two shots have the shotId '${shot.shotId}'.` });
    seen.add(shot.shotId);
  }
  for (const id of selected ?? []) if (!seen.has(id)) problems.push({ shotId: id, message: `--shot ${id}: no such shot in the manifest.` });
  return problems;
}

// Fills the paths of every shot and sets the shots to capture to `pending`: the shots `--shot` names, or else every
// shot not yet committed in all its locales. Deletes leftover staged files of those shots, so a capture from an
// earlier run can never be promoted. Writes nothing when anything can't be resolved.
export async function resolveManifest(cfg, file, { shot: shotSpec, dryRun } = {}) {
  requireMultilocale(cfg);
  const m = await readManifest(file);
  const selected = parseIds(shotSpec);
  const problems = checkIds(m, selected);
  const plans = new Map();
  const outputs = new Map();
  for (const { shot } of allShots(m)) {
    const plan = planShot(cfg, shot);
    problems.push(...plan.problems);
    if (plan.problems.length) continue;
    plans.set(shot, plan);
    for (const out of Object.values(plan.output)) {
      if (outputs.has(out)) problems.push({ shotId: shot.shotId, message: `Shots '${outputs.get(out)}' and '${shot.shotId}' both write ${out}.` });
      outputs.set(out, shot.shotId);
    }
  }
  if (problems.length) throw new CliError(`The manifest can't be resolved: ${problems.map((p) => p.message).join(' ')}`, { code: 2, data: { problems } });

  const shots = [];
  for (const { scenarioId, shot } of allShots(m)) {
    const plan = plans.get(shot);
    const reset = selected ? selected.has(shot.shotId) : !committed(shot);
    if (reset) {
      shot.requiredLocales = plan.required;
      shot.outputPathPerLocale = plan.output;
      shot.stagedPathPerLocale = plan.staged;
      shot.status = Object.fromEntries(plan.required.map((l) => [l, 'pending']));
      shot.failureReason = Object.fromEntries(plan.required.map((l) => [l, null]));
      if (!dryRun) await discardStaged(cfg.root, shot);
    }
    shots.push({ shotId: shot.shotId, scenarioId, page: cleanDir(shot.page), file: shot.file, toCapture: reset, requiredLocales: shot.requiredLocales, staged: shot.stagedPathPerLocale, output: shot.outputPathPerLocale, status: shot.status });
  }
  m.screenshotLocales = cfg.locales;
  if (!dryRun) {
    await writeJson(file, m);
    const ignore = path.join(cfg.root, cfg.stagingRoot, '.gitignore');
    await fs.mkdir(path.dirname(ignore), { recursive: true });
    await fs.writeFile(ignore, '*\n');
  }
  return { ok: true, dryRun: Boolean(dryRun), manifest: file, switch: cfg.localeSwitch, envPrefix: cfg.envPrefix, shots };
}

async function discardStaged(root, shot) {
  const dirs = new Set();
  for (const rel of Object.values(shot.stagedPathPerLocale ?? {})) {
    await fs.rm(path.join(root, rel), { force: true });
    await fs.rm(path.join(root, `${rel}.previous`), { force: true });
    dirs.add(path.dirname(path.join(root, rel)));
  }
  for (const dir of dirs) await fs.rmdir(dir).catch(() => {});
}

function findShot(m, id) {
  const hit = allShots(m).find(({ shot }) => shot.shotId === id);
  if (!hit) throw new CliError(`No shot '${id}' in the manifest.`, { code: 2 });
  if (!Array.isArray(hit.shot.requiredLocales)) throw new CliError(`Shot '${id}' is not resolved yet: run \`resolve\` first.`, { code: 2 });
  return hit.shot;
}

// Records that one locale of a shot could not be captured, and why.
export async function failShot(file, { shot: id, locale, reason }) {
  if (!id || !locale || !reason) throw new CliError('fail needs --shot <id> --locale <locale> --reason <text>.', { code: 2 });
  const m = await readManifest(file);
  const shot = findShot(m, id);
  if (!shot.requiredLocales.includes(locale)) throw new CliError(`Shot '${id}' does not need '${locale}' (it needs ${shot.requiredLocales.join(', ')}).`, { code: 2 });
  shot.status[locale] = 'failed';
  shot.failureReason[locale] = reason;
  await writeJson(file, m);
  return { ok: true, shotId: id, locale, status: 'failed', reason };
}

async function move(from, to) {
  try {
    await fs.rename(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    const k = await kind(from);
    if (k === 'symlink') await fs.symlink(await fs.readlink(from), to);
    else await fs.copyFile(from, to);
    await fs.rm(from, { force: true });
  }
}

// Moves a complete staged set into place. The live file of each locale (a real file or a symlink to another locale's
// image) is moved aside first and never written through. On any error every locale is put back as it was.
async function promoteSet(root, shot) {
  const done = [];
  const aside = [];
  const createdFolders = [];
  try {
    for (const locale of shot.requiredLocales) {
      const live = path.join(root, shot.outputPathPerLocale[locale]);
      const staged = path.join(root, shot.stagedPathPerLocale[locale]);
      const dir = path.dirname(live);
      if ((await kind(dir)) === 'missing') createdFolders.push(cleanDir(path.relative(root, dir)));
      await fs.mkdir(dir, { recursive: true });
      if ((await kind(live)) !== 'missing') {
        await move(live, `${staged}.previous`);
        aside.push([`${staged}.previous`, live]);
      }
      await move(staged, live);
      done.push([live, staged]);
    }
  } catch (e) {
    for (const [live, staged] of done.reverse()) await move(live, staged).catch(() => {});
    for (const [prev, live] of aside.reverse()) await move(prev, live).catch(() => {});
    throw e;
  }
  for (const [prev] of aside) await fs.rm(prev, { force: true });
  await discardStaged(root, shot);
  return { replaced: aside.length, createdFolders };
}

// Promotes every shot whose staged set is complete, all locales or none. A shot with a failed or missing locale is
// not promoted: its staged files are discarded, its previous images stay, and each locale records why.
export async function promoteManifest(cfg, file, { shot: shotSpec, dryRun } = {}) {
  const m = await readManifest(file);
  const selected = parseIds(shotSpec);
  const problems = checkIds(m, selected);
  if (problems.length) throw new CliError(problems.map((p) => p.message).join(' '), { code: 2, data: { problems } });
  const results = [];
  for (const { shot } of allShots(m)) {
    if (selected ? !selected.has(shot.shotId) : !Array.isArray(shot.requiredLocales) || committed(shot)) continue;
    if (!Array.isArray(shot.requiredLocales)) throw new CliError(`Shot '${shot.shotId}' is not resolved yet: run \`resolve\` first.`, { code: 2 });
    if (committed(shot)) {
      results.push({ shotId: shot.shotId, promoted: false, skipped: 'already committed in every locale' });
      continue;
    }
    const missing = [];
    for (const locale of shot.requiredLocales) {
      if (shot.status[locale] === 'failed' || !(await isCapture(path.join(cfg.root, shot.stagedPathPerLocale[locale])))) missing.push(locale);
    }
    const previous = {};
    for (const locale of shot.requiredLocales) previous[locale] = await kind(path.join(cfg.root, shot.outputPathPerLocale[locale]));
    if (missing.length) {
      for (const locale of shot.requiredLocales) {
        shot.failureReason[locale] = missing.includes(locale)
          ? shot.failureReason[locale] ?? `no capture at ${shot.stagedPathPerLocale[locale]}`
          : `not promoted: ${missing.join(', ')} failed; the previous image stays`;
        shot.status[locale] = 'failed';
      }
      if (!dryRun) await discardStaged(cfg.root, shot);
      results.push({ shotId: shot.shotId, promoted: false, failed: missing, reasons: { ...shot.failureReason }, kept: previous });
      continue;
    }
    if (dryRun) {
      results.push({ shotId: shot.shotId, promoted: false, wouldPromote: shot.requiredLocales, previous });
      continue;
    }
    try {
      const { replaced, createdFolders } = await promoteSet(cfg.root, shot);
      for (const locale of shot.requiredLocales) {
        shot.status[locale] = 'committed';
        shot.failureReason[locale] = null;
      }
      shot.promotedAt = today();
      results.push({ shotId: shot.shotId, promoted: true, locales: shot.requiredLocales, replaced, createdFolders, output: shot.outputPathPerLocale });
    } catch (e) {
      for (const locale of shot.requiredLocales) {
        shot.status[locale] = 'failed';
        shot.failureReason[locale] = `promotion failed (${e.code ?? e.message}); every locale was put back as it was`;
      }
      results.push({ shotId: shot.shotId, promoted: false, failed: shot.requiredLocales, reasons: { ...shot.failureReason }, kept: previous });
    }
  }
  if (!dryRun) await writeJson(file, m);
  const ok = results.every((r) => r.promoted || r.skipped || r.wouldPromote);
  return { ok, dryRun: Boolean(dryRun), results };
}

// The state of every shot, from the manifest and the disk: complete, pending, failed or mixed (some required locales
// have their image and some don't). `missingLocales`: declared screenshot locales a shot doesn't cover yet.
export async function manifestStatus(cfg, file) {
  const m = await readManifest(file);
  const shots = [];
  for (const { scenarioId, shot } of allShots(m)) {
    const required = Array.isArray(shot.requiredLocales) ? shot.requiredLocales : [];
    const locales = {};
    for (const locale of required) {
      const live = await kind(path.join(cfg.root, shot.outputPathPerLocale[locale]));
      const staged = await isCapture(path.join(cfg.root, shot.stagedPathPerLocale[locale]));
      locales[locale] = { status: shot.status?.[locale] ?? null, live, staged, reason: shot.failureReason?.[locale] ?? null };
    }
    const lives = Object.values(locales).map((l) => l.live === 'file');
    let state;
    if (!required.length) state = 'unresolved';
    else if (lives.some(Boolean) && !lives.every(Boolean)) state = 'mixed';
    else if (Object.values(locales).some((l) => l.status === 'failed')) state = 'failed';
    else if (committed(shot) && lives.every(Boolean)) state = 'complete';
    else state = 'pending';
    const missingLocales = cfg.multilocale && !cfg.problems.length && shot.locales === undefined ? cfg.locales.filter((l) => !required.includes(l)) : [];
    shots.push({ shotId: shot.shotId, scenarioId, page: shot.page, file: shot.file, state, locales, missingLocales });
  }
  const count = (state) => shots.filter((s) => s.state === state).length;
  const summary = Object.fromEntries(['complete', 'pending', 'failed', 'mixed', 'unresolved'].map((s) => [s, count(s)]));
  return { ok: shots.every((s) => s.state === 'complete'), summary, shots };
}
