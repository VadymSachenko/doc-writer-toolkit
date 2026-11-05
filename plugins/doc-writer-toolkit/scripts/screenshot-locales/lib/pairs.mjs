import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CliError } from '../../ui-labels/lib/util.mjs';
import { within } from './config.mjs';

// The UA → EN image pair check of a branch: in a host whose screenshot locales include `en`, every image the branch
// changed in a default-locale root (added, changed or removed) must have its EN counterpart changed too, at the same
// path under the pair's EN i18n root, unless the EN file is a link to the UA one. Run before ready-for-merge (the
// ticket flow's align stage). Images in a `.sources/` folder are work files, not page images, and are skipped. The
// further locales' links to EN are `locale-sync`'s check, not this one.

export const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

const git = (root, args) => {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    throw new CliError(`git ${args.join(' ')} failed: ${String(e.stderr ?? e.message).trim().split('\n').at(-1)}`, { code: 2 });
  }
};

// The EN file at `head` is a link to the UA file: a change to UA changes what EN shows too.
function linksTo(root, head, enPath, uaPath) {
  const entry = git(root, ['ls-tree', head, '--', enPath]).trim();
  if (!entry.startsWith('120000 ')) return false;
  const target = git(root, ['cat-file', '-p', entry.split(/\s+/)[2]]).trim();
  return path.posix.normalize(path.posix.join(path.posix.dirname(enPath), target)) === uaPath;
}

export function checkPairs(cfg, { base, head = 'HEAD' } = {}) {
  if (!base) throw new CliError('pairs needs --base <ref>: the branch the PR goes into (origin/main, say).', { code: 2 });
  if (!cfg.multilocale || !cfg.locales.includes('en')) {
    return { ok: true, applies: false, why: cfg.multilocale ? "'en' is not a screenshot locale: no EN image is required" : "no 'Screenshot locales:' declared: no EN image is required" };
  }
  if (cfg.problems.length) throw new CliError(`The screenshot locales can't be resolved: ${cfg.problems.map((p) => p.message).join(' ')}`, { code: 2, data: { problems: cfg.problems } });
  // `-z`: status and path each end in NUL, so a non-ASCII name is never quoted (and so never missed).
  const out = git(cfg.root, ['diff', '-z', '--name-status', '--no-renames', `${base}...${head}`]).split('\0');
  const changed = new Map();
  for (let i = 0; i + 1 < out.length; i += 2) if (out[i]) changed.set(out[i + 1], out[i][0]);
  // Each pair's default-locale root and EN root, the longest UA root first, so a nested root wins.
  const pairs = cfg.pairs
    .map((p) => ({ id: p.id, ua: cfg.roots[p.id]?.[cfg.defaultLocale], en: cfg.roots[p.id]?.en }))
    .filter((p) => p.ua && p.en)
    .sort((a, b) => b.ua.length - a.ua.length);
  const checked = [];
  const missing = [];
  for (const [file, status] of changed) {
    if (!IMAGE.test(file) || file.split('/').includes('.sources')) continue;
    const pair = pairs.find((p) => within(file, p.ua) && !within(file, p.en));
    if (!pair) continue;
    const en = `${pair.en}/${file.slice(pair.ua.length + 1)}`;
    checked.push(file);
    if (changed.has(en)) continue;
    if (status !== 'D' && linksTo(cfg.root, head, en, file)) continue;
    missing.push({ ua: file, en, change: status === 'A' ? 'added' : status === 'D' ? 'removed' : 'changed' });
  }
  return { ok: !missing.length, applies: true, base, head, checked: checked.length, missing };
}

// The text a refusal or a failed stage carries: each UA image with the EN file it needs.
export const pairsMessage = (r) => r.missing.map((m) => `${m.ua} ${m.change} without ${m.en}`).join('; ');
