import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from '../../doc-align/lib/parse.mjs';
import { EXPLICIT_ID, enHeadingIds, uaHeadingId } from '../../doc-align/lib/headings.mjs';
import { headingIdMismatches, renameIds, withExplicitId } from '../../doc-align/lib/ids.mjs';
import { deriveLocaleRoot, loadSettings as loadDocSettings, readDocusaurusI18n, requirePairs } from '../../ui-labels/lib/config.mjs';

// The heading ids after a person's edit of an EN page on a translated PR (the `idSync` step, the runner's own, no model;
// context/doc-rules/project-rules/heading-anchors.md, rules 2, 4, 6 and 7). In the PR's worktree, for each changed EN
// page and its UA page (the root pairs of the worktree's CLAUDE.md), `scripts/doc-align` compares the heading ids. For
// each `HEADING-ID-MISMATCH`:
//   - a heading the base doesn't have (new in the PR): the UA `{/* #id */}` takes the EN heading's anchor, and so does
//     the same comment on every further locale's page (rule 7); every link to the old id under the content roots is
//     rewritten (`renamed`);
//   - a heading already on the base (published, rule 4): the EN heading gets the old id explicitly, `\{#old}` (rule 6)
//     (`kept`).
// A rename the owner asked for in a `kept` thread is the first branch for that heading: the EN heading's explicit id is
// taken off, and the UA id takes the anchor its words give (`asked`). Ids change, and the links to them; never a word.
// A heading whose rename can't be made (`blocked`) leaves its whole page as it is. Everything is one commit in the
// worktree, which the runner pushes. Returns { commit, fixes, notes, files }, or { error } (the worktree reset to its
// head) when the worktree's declarations can't be read or a write or the commit fails.

const git = (wt, args) => execFileSync('git', ['-C', wt, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
const tryGit = (wt, args) => {
  try {
    return git(wt, args);
  } catch {
    return null;
  }
};
const posix = (p) => p.split(path.sep).join('/');
const under = (file, dir) => file.startsWith(`${dir.replace(/\/+$/, '')}/`);

// The root pairs and the further locales' roots, from the worktree's own declarations at its head.
async function layoutOf(wt) {
  const ds = await loadDocSettings({ root: wt });
  const pairs = requirePairs(ds);
  let further = [];
  try {
    const i18n = await readDocusaurusI18n(ds);
    further = i18n.locales.filter((l) => l !== i18n.defaultLocale && l !== 'en');
  } catch {
    // No docusaurus.config: no further locale.
  }
  return pairs.map((p) => ({ ...p, ua: p.ua.replace(/\/+$/, ''), en: p.en.replace(/\/+$/, ''), locales: further.map((l) => ({ locale: l, root: deriveLocaleRoot(`${p.en.replace(/\/+$/, '')}/`, l).replace(/\/+$/, '') })) }));
}

// A page's text at the base, or null when the base doesn't have it.
function atBase(wt, base, rel) {
  const ref = tryGit(wt, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${base}`]) ? `refs/remotes/origin/${base}` : base;
  return tryGit(wt, ['show', `${ref}:${rel}`]);
}
// The ids a page's headings have on the base, so live: the UA page's `{/* #id */}` comments and the EN page's anchors
// (its explicit ids, else the slugs of its words). A page published before UA ids existed has none on UA (the translator
// adds them in the chain, rule 10), but its EN anchors are live all the same.
function publishedIds(uaText, enText) {
  const ids = new Set();
  if (uaText !== null) for (const h of parse(uaText).headings) if (h.level >= 2 && uaHeadingId(h.raw).id) ids.add(uaHeadingId(h.raw).id);
  if (enText !== null) {
    const heads = parse(enText).headings;
    enHeadingIds(heads).forEach((x, i) => heads[i].level >= 2 && x.id && ids.add(x.id));
  }
  return ids;
}

// `pages`: the EN pages the hand commits changed (repo paths). `asked`: [{ page, id }], a rename the owner asked for.
// Whatever fails once it writes (a write, a rename, a commit a hook or signing refuses) leaves the worktree as it found
// it: reset to the head it started at, so the next check finds it clean, and { error }.
export async function syncIds({ wt, base, pages = [], asked = [], message = 'Heading ids: UA and the locales in step with EN' }) {
  const start = tryGit(wt, ['rev-parse', 'HEAD']);
  try {
    return await syncPages({ wt, base, pages, asked, message });
  } catch (e) {
    const reset = start ? tryGit(wt, ['reset', '-q', '--hard', start]) !== null : false;
    return { error: `the heading ids: ${String(e.stderr || e.message || e).trim().split('\n')[0].slice(0, 300)}${reset ? '' : ' (and the worktree could not be reset)'}`, reset };
  }
}

async function syncPages({ wt, base, pages, asked, message }) {
  let layout;
  try {
    layout = await layoutOf(wt);
  } catch (e) {
    return { error: `the worktree's root pairs can't be read: ${String(e.message ?? e).split('\n')[0]}` };
  }
  const roots = layout.flatMap((p) => [{ dir: path.join(wt, p.ua), prefix: p.urlPrefix ?? '/' }, { dir: path.join(wt, p.en), prefix: '/' }, ...p.locales.map((l) => ({ dir: path.join(wt, l.root), prefix: '/' }))]).filter((r) => fs.existsSync(r.dir));
  const fixes = [];
  const notes = [];
  const touched = new Set();
  const enPages = [...new Set([...pages, ...asked.map((a) => a.page)])];
  for (const enRel of enPages) {
    const pair = layout.find((p) => under(enRel, p.en));
    if (!pair) {
      notes.push(`${enRel}: not under an EN i18n root the worktree declares: not checked`);
      continue;
    }
    const rel = enRel.slice(pair.en.length + 1);
    const uaRel = `${pair.ua}/${rel}`;
    const [uaAbs, enAbs] = [path.join(wt, uaRel), path.join(wt, enRel)];
    if (!fs.existsSync(uaAbs) || !fs.existsSync(enAbs)) {
      notes.push(`${enRel}: ${fs.existsSync(enAbs) ? `no UA page ${uaRel}` : 'the page is gone'}: not checked`);
      continue;
    }
    let enText = fs.readFileSync(enAbs, 'utf8');
    const uaText = fs.readFileSync(uaAbs, 'utf8');
    // A rename the owner asked for: the explicit id the runner gave the EN heading comes off, so its words give the id.
    const ua = parse(uaText);
    const wanted = asked.filter((a) => a.page === enRel);
    if (wanted.length) {
      const en = parse(enText);
      const lines = enText.split('\n');
      for (const a of wanted) {
        const i = ua.headings.findIndex((h) => h.level >= 2 && uaHeadingId(h.raw).id === a.id);
        const eh = i >= 0 && en.headings.length === ua.headings.length ? en.headings[i] : null;
        if (!eh) {
          notes.push(`${enRel}: no heading with the id '${a.id}' lines up with EN: the rename is not made`);
          continue;
        }
        const ex = eh.raw.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').match(EXPLICIT_ID);
        if (ex?.[1] === a.id) lines[eh.line - 1] = lines[eh.line - 1].replace(/[ \t]*\\?\{#[^}\s]+\}[ \t]*(\r?)$/, '$1');
      }
      enText = lines.join('\n');
    }
    const found = headingIdMismatches(ua, parse(enText));
    if (found === null) {
      notes.push(`${enRel}: the UA and EN pages have different heading counts: their ids are not compared`);
      continue;
    }
    if (!found.length) {
      if (wanted.length) notes.push(`${enRel}: the EN heading already has the id '${wanted.map((a) => a.id).join("', '")}': nothing to rename`);
      continue;
    }
    const published = publishedIds(atBase(wt, base, uaRel), atBase(wt, base, enRel));
    const renames = [];
    const keep = [];
    for (const m of found) {
      const ask = wanted.some((a) => a.id === m.uaId);
      if (ask || !published.has(m.uaId)) renames.push({ m, from: m.uaId, to: m.enId, kind: ask ? 'asked' : 'renamed' });
      else keep.push(m);
    }
    const locales = pair.locales.map((l) => path.join(wt, l.root, rel)).filter((f) => fs.existsSync(f)).map((f) => ({ path: f, text: fs.readFileSync(f, 'utf8') }));
    const opts = { uaPath: uaAbs, enPath: enAbs, locales, roots, renames: renames.map(({ from, to }) => ({ from, to })) };
    // A rename that can't be made (its target taken once every rename is made, say): nothing on the page changes, so no
    // rename is half made, and each such heading is `blocked`, for a line comment.
    const dry = renames.length ? await renameIds(uaText, enText, { ...opts, write: false }) : null;
    if (dry?.skipped.length) {
      for (const sk of dry.skipped) {
        const x = renames.find((y) => y.from === sk.from);
        fixes.push({ kind: 'blocked', page: enRel, ua: uaRel, line: x?.m.enLine ?? null, old: sk.from, new: sk.to, why: sk.reason });
      }
      notes.push(`${enRel}: ${dry.skipped.map((sk) => `the id '${sk.from}' can't become '${sk.to}' (${sk.reason})`).join('; ')}: no heading id on the page is changed`);
      continue;
    }
    if (wanted.length) {
      fs.writeFileSync(enAbs, enText);
      touched.add(enRel);
    }
    if (renames.length) {
      const r = await renameIds(uaText, enText, { ...opts, write: true });
      for (const f of r.written ?? []) touched.add(posix(path.relative(wt, path.resolve(f))));
      for (const u of r.unresolved) notes.push(`${posix(path.relative(wt, path.resolve(u.file)))}:${u.line}: ${u.url} may reach the heading and is left as it is (${u.reason})`);
      for (const x of r.renamed) {
        const { m, kind } = renames.find((y) => y.from === x.from);
        fixes.push({ kind, page: enRel, ua: uaRel, line: m.enLine, old: x.from, new: x.to, links: r.links.filter((l) => l.heading === x.line).length, locales: x.locales.length });
      }
      enText = fs.readFileSync(enAbs, 'utf8');
    }
    if (keep.length) {
      const lines = enText.split('\n');
      for (const m of keep) {
        lines[m.enLine - 1] = withExplicitId(lines[m.enLine - 1], m.uaId);
        // `new`: the anchor the person's EN heading had, which a rename would give the UA heading.
        fixes.push({ kind: 'kept', page: enRel, ua: uaRel, line: m.enLine, old: m.uaId, new: m.enId });
      }
      fs.writeFileSync(enAbs, lines.join('\n'));
      touched.add(enRel);
    }
  }
  if (!touched.size) return { commit: null, fixes, notes };
  git(wt, ['add', '--', ...touched]);
  if (tryGit(wt, ['diff', '--cached', '--quiet']) !== null) return { commit: null, fixes: fixes.filter((f) => f.kind === 'blocked'), notes };
  git(wt, ['commit', '-q', '-m', message]);
  return { commit: git(wt, ['rev-parse', 'HEAD']), fixes, notes, files: [...touched] };
}

// A line comment's text from a template: `<old>`, `<new>`, `<links>`, `<rename>` and `<why>` filled in.
export function idCommentText(template, fix, rename) {
  return String(template).replaceAll('<old>', fix.old).replaceAll('<new>', fix.new).replaceAll('<links>', String(fix.links ?? 0)).replaceAll('<rename>', rename).replaceAll('<why>', fix.why ?? '');
}
