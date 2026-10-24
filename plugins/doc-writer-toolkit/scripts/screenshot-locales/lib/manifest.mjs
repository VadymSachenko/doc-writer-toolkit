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

// The real path of `abs`, resolved through its nearest existing ancestor (the rest may not exist yet).
async function realOf(abs) {
  let dir = abs;
  const rest = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(dir), ...rest);
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const up = path.dirname(dir);
      if (up === dir) throw e;
      rest.unshift(path.basename(dir));
      dir = up;
    }
  }
}

// An output folder reached through a symlink would put one locale's image into another locale's folder (or anywhere
// else), and two outputs that are one real file would overwrite each other. Both are refused before anything moves.
// A `.previous` file in staging is the earlier image of an interrupted promotion: it is never overwritten or deleted.
export async function pathProblems(root, entries) {
  const problems = [];
  const realRoot = await fs.realpath(root);
  const seen = new Map();
  for (const { shotId, locale, output, staged } of entries) {
    const dir = posix.dirname(output);
    const real = await realOf(path.join(root, dir));
    if (real !== path.join(realRoot, dir)) {
      problems.push({ shotId, locale, message: `The ${locale} folder ${dir} of shot '${shotId}' leads through a symlink to ${cleanDir(path.relative(realRoot, real)) || real}. Each locale needs a real folder of its own.` });
    }
    const file = path.join(real, posix.basename(output));
    if (seen.has(file)) {
      const other = seen.get(file);
      problems.push({ shotId, locale, message: `Shot '${shotId}' (${locale}) and shot '${other.shotId}' (${other.locale}) would write the same file ${output}.` });
    } else seen.set(file, { shotId, locale });
    if (staged && (await kind(path.join(root, `${staged}.previous`))) !== 'missing') {
      problems.push({ shotId, locale, message: `${staged}.previous holds the earlier ${locale} image of an interrupted promotion of ${output}. Put it back (or delete it) first.` });
    }
  }
  return problems;
}

const entriesOf = (shotId, output, staged) => Object.keys(output).map((locale) => ({ shotId, locale, output: output[locale], staged: staged?.[locale] }));

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
  if (shot.locales !== undefined) {
    fail('A shot has no "locales" field: a locale-scoped request is one-off, passed as `resolve --shot <id> --locales <list>`.');
    return { problems };
  }
  const required = cfg.locales;

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
// The locales the current round captures: all required ones unless the round is locale-scoped.
const captureOf = (shot) => (Array.isArray(shot.captureLocales) ? shot.captureLocales : shot.requiredLocales);
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

// Sets the shots to capture to `pending`: the shots `--shot` names, or else only the shots never resolved. A shot
// keeps its staged captures, its failure and its reason until `--shot` names it. `--locales` (with `--shot`) is a
// one-off locale-scoped request: only those locales are captured this time, and the shot's other locales must already
// be committed. Deletes leftover staged files of the shots it resets, so a capture from an earlier run can never be
// promoted. Writes nothing when anything can't be resolved.
export async function resolveManifest(cfg, file, { shot: shotSpec, dryRun } = {}) {
  requireMultilocale(cfg);
  const m = await readManifest(file);
  const selected = parseIds(shotSpec);
  const scoped = cfg.requested;
  const problems = checkIds(m, selected);
  if (scoped && !selected) problems.push({ shotId: null, message: '--locales is a locale-scoped request for existing shots: name them with --shot.' });
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
  const isReset = (shot) => (selected ? selected.has(shot.shotId) : !Array.isArray(shot.requiredLocales));
  for (const { shot } of allShots(m)) {
    const plan = plans.get(shot);
    if (!plan || !isReset(shot)) continue;
    problems.push(...(await pathProblems(cfg.root, entriesOf(shot.shotId, plan.output, plan.staged))));
    if (scoped) {
      const others = plan.required.filter((l) => !scoped.includes(l) && shot.status?.[l] !== 'committed');
      if (others.length) problems.push({ shotId: shot.shotId, message: `Shot '${shot.shotId}' is not committed in ${others.join(', ')}: a locale-scoped request would leave a partial set. Capture the full set (no --locales).` });
    }
  }
  if (problems.length) throw new CliError(`The manifest can't be resolved: ${problems.map((p) => p.message).join(' ')}`, { code: 2, data: { problems } });

  const shots = [];
  for (const { scenarioId, shot } of allShots(m)) {
    const plan = plans.get(shot);
    const reset = isReset(shot);
    if (reset) {
      const capture = scoped ? plan.required.filter((l) => scoped.includes(l)) : plan.required;
      if (!dryRun) await discardStaged(cfg.root, shot);
      shot.requiredLocales = plan.required;
      shot.captureLocales = capture;
      shot.outputPathPerLocale = plan.output;
      shot.stagedPathPerLocale = plan.staged;
      shot.status = Object.fromEntries(plan.required.map((l) => [l, capture.includes(l) ? 'pending' : shot.status[l]]));
      shot.failureReason = Object.fromEntries(plan.required.map((l) => [l, capture.includes(l) ? null : shot.failureReason?.[l] ?? null]));
      if (!dryRun) await discardStaged(cfg.root, shot);
    }
    shots.push({ shotId: shot.shotId, scenarioId, page: cleanDir(shot.page), file: shot.file, toCapture: reset ? shot.captureLocales : [], requiredLocales: shot.requiredLocales, staged: shot.stagedPathPerLocale, output: shot.outputPathPerLocale, status: shot.status });
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
  const capture = captureOf(shot);
  if (!capture.includes(locale)) throw new CliError(`Shot '${id}' is not being captured in '${locale}' (it is in ${capture.join(', ')}).`, { code: 2 });
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
// image) is moved aside first and never written through. On any error each locale is put back; `notRestored` lists
// what could not be, so the failure reason says exactly where the earlier image is.
async function promoteSet(root, shot, locales) {
  const done = [];
  const aside = [];
  const createdFolders = [];
  try {
    for (const locale of locales) {
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
    const notRestored = [];
    const rel = (p) => cleanDir(path.relative(root, p));
    for (const [live, staged] of done.reverse()) await move(live, staged).catch(() => notRestored.push(`${rel(live)} (the new capture is still there)`));
    for (const [prev, live] of aside.reverse()) await move(prev, live).catch(() => notRestored.push(`${rel(live)} (its earlier image is at ${rel(prev)})`));
    e.notRestored = notRestored;
    throw e;
  }
  for (const [prev] of aside) await fs.rm(prev, { force: true });
  await discardStaged(root, shot);
  return { replaced: aside.length, createdFolders };
}

// Promotes every shot whose staged set is complete: all the locales of the round or none. A shot with a failed or
// missing locale is not promoted: its staged files are discarded, its previous images stay, and each locale records
// why. Refuses (exit 2, nothing moved) when an output folder leads through a symlink, when two outputs are one real
// file, or when an interrupted promotion left a `.previous` image.
export async function promoteManifest(cfg, file, { shot: shotSpec, dryRun } = {}) {
  const m = await readManifest(file);
  const selected = parseIds(shotSpec);
  const problems = checkIds(m, selected);
  if (problems.length) throw new CliError(problems.map((p) => p.message).join(' '), { code: 2, data: { problems } });
  const picked = allShots(m).map(({ shot }) => shot).filter((shot) => (selected ? selected.has(shot.shotId) : Array.isArray(shot.requiredLocales) && !committed(shot)));
  for (const shot of picked) {
    if (!Array.isArray(shot.requiredLocales)) throw new CliError(`Shot '${shot.shotId}' is not resolved yet: run \`resolve\` first.`, { code: 2 });
  }
  const unsafe = await pathProblems(cfg.root, picked.filter((shot) => !committed(shot)).flatMap((shot) => entriesOf(shot.shotId, shot.outputPathPerLocale, shot.stagedPathPerLocale)));
  if (unsafe.length) throw new CliError(`Nothing promoted: ${unsafe.map((p) => p.message).join(' ')}`, { code: 2, data: { problems: unsafe } });
  const results = [];
  for (const shot of picked) {
    if (committed(shot)) {
      results.push({ shotId: shot.shotId, promoted: false, skipped: 'already committed in every locale' });
      continue;
    }
    const capture = captureOf(shot);
    const missing = [];
    for (const locale of capture) {
      if (shot.status[locale] === 'failed' || !(await isCapture(path.join(cfg.root, shot.stagedPathPerLocale[locale])))) missing.push(locale);
    }
    const previous = {};
    for (const locale of capture) previous[locale] = await kind(path.join(cfg.root, shot.outputPathPerLocale[locale]));
    if (missing.length) {
      for (const locale of capture) {
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
      results.push({ shotId: shot.shotId, promoted: false, wouldPromote: capture, previous });
      continue;
    }
    try {
      const { replaced, createdFolders } = await promoteSet(cfg.root, shot, capture);
      for (const locale of capture) {
        shot.status[locale] = 'committed';
        shot.failureReason[locale] = null;
      }
      delete shot.captureLocales;
      shot.promotedAt = today();
      results.push({ shotId: shot.shotId, promoted: true, locales: capture, replaced, createdFolders, output: shot.outputPathPerLocale });
    } catch (e) {
      const back = e.notRestored?.length ? `NOT put back: ${e.notRestored.join('; ')}` : 'every locale was put back as it was';
      for (const locale of capture) {
        shot.status[locale] = 'failed';
        shot.failureReason[locale] = `promotion failed (${e.code ?? e.message}); ${back}`;
      }
      results.push({ shotId: shot.shotId, promoted: false, failed: capture, reasons: { ...shot.failureReason }, kept: previous, notRestored: e.notRestored ?? [] });
    }
  }
  if (!dryRun) await writeJson(file, m);
  const ok = results.every((r) => r.promoted || r.skipped || r.wouldPromote);
  return { ok, dryRun: Boolean(dryRun), results };
}

// The state of every shot, from the manifest and the disk: complete, pending, failed, mixed (some required locales
// have their image and some don't), interrupted (a `.previous` image is left in staging) or unsafe (an output
// folder leads through a symlink, so the images on disk are not what they seem). `missingLocales`: declared screenshot locales a shot doesn't cover yet.
export async function manifestStatus(cfg, file) {
  const m = await readManifest(file);
  const shots = [];
  for (const { scenarioId, shot } of allShots(m)) {
    const required = Array.isArray(shot.requiredLocales) ? shot.requiredLocales : [];
    const locales = {};
    for (const locale of required) {
      const live = await kind(path.join(cfg.root, shot.outputPathPerLocale[locale]));
      const staged = await isCapture(path.join(cfg.root, shot.stagedPathPerLocale[locale]));
      const previous = (await kind(path.join(cfg.root, `${shot.stagedPathPerLocale[locale]}.previous`))) !== 'missing';
      locales[locale] = { status: shot.status?.[locale] ?? null, live, staged, previous, reason: shot.failureReason?.[locale] ?? null };
    }
    const lives = Object.values(locales).map((l) => l.live === 'file');
    const unsafe = required.length ? (await pathProblems(cfg.root, entriesOf(shot.shotId, shot.outputPathPerLocale))).map((p) => p.message) : [];
    let state;
    if (!required.length) state = 'unresolved';
    else if (unsafe.length) state = 'unsafe';
    else if (Object.values(locales).some((l) => l.previous)) state = 'interrupted';
    else if (lives.some(Boolean) && !lives.every(Boolean)) state = 'mixed';
    else if (Object.values(locales).some((l) => l.status === 'failed')) state = 'failed';
    else if (committed(shot) && lives.every(Boolean)) state = 'complete';
    else state = 'pending';
    const missingLocales = cfg.multilocale && !cfg.problems.length ? cfg.locales.filter((l) => !required.includes(l)) : [];
    shots.push({ shotId: shot.shotId, scenarioId, page: shot.page, file: shot.file, state, locales, missingLocales, ...(unsafe.length ? { problems: unsafe } : {}) });
  }
  const count = (state) => shots.filter((s) => s.state === state).length;
  const summary = Object.fromEntries(['complete', 'pending', 'failed', 'mixed', 'interrupted', 'unsafe', 'unresolved'].map((s) => [s, count(s)]));
  return { ok: shots.every((s) => s.state === 'complete'), summary, shots };
}
