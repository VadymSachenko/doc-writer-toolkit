import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CliError, readJson, writeJson } from '../../ui-labels/lib/util.mjs';
import { uncommitted } from './git.mjs';
import { abs } from './pages.mjs';
import { localeRoot, resolveTargets } from './settings.mjs';
import { categoryFile } from './categories.mjs';

// A run writes in a fixed set of places: the locale roots, the locales' current.json, the state root (page states, term
// memory, label snapshot, run folder) and .gitattributes. Everything else that git sees as changed is stray, e.g. the
// scratch files a worker left in the repo root. Nothing is deleted here.
const under = (file, dir) => file === dir || file.startsWith(dir.endsWith('/') ? dir : `${dir}/`);

async function fingerprint(s, file) {
  try {
    return crypto.createHash('sha1').update(await fs.readFile(abs(s, file))).digest('hex');
  } catch {
    return null; // deleted
  }
}

// `save`: write the currently stray paths (with a content hash) as the baseline, so files that were already dirty before
// the run don't count. `baseline`: report only paths that are new since, or whose content changed.
export async function runStray(s, { baseline = null, save = null } = {}) {
  if (baseline && save) throw new CliError('Use --baseline or --save, not both.', { code: 2 });
  const { targets } = await resolveTargets(s);
  const allowed = [...targets.flatMap((l) => [localeRoot(s, l), categoryFile(s, l)]), '.gitattributes'];
  const state = path.relative(s.root, s.stateRoot).split(path.sep).join('/');
  if (state && !state.startsWith('..')) allowed.push(state);
  const changed = (await uncommitted(s.root, '.')).filter((f) => !allowed.some((a) => under(f.path, a)));

  const found = [];
  for (const f of changed) found.push({ path: f.path, status: f.status, hash: await fingerprint(s, f.path) });

  if (save) {
    await writeJson(path.resolve(save), { saved: found.map(({ path: p, hash }) => ({ path: p, hash })) });
    return { saved: path.resolve(save), paths: found.length };
  }
  const known = new Map(baseline ? ((await readJson(path.resolve(baseline)))?.saved ?? []).map((e) => [e.path, e.hash]) : []);
  const stray = [];
  for (const f of found) {
    if (known.has(f.path) && known.get(f.path) === f.hash) continue;
    let empty = false;
    try {
      empty = (await fs.stat(abs(s, f.path))).size === 0;
    } catch {
      /* deleted */
    }
    stray.push({ path: f.path, status: f.status, ...(empty ? { empty: true } : {}) });
  }
  return {
    ok: !stray.length,
    stray,
    ignored: found.length - stray.length,
    allowed,
    note: stray.length ? 'Nothing was deleted. Report these paths: the user removes them or commits them separately.' : undefined,
  };
}
