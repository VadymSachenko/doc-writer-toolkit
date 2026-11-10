import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parse } from '../../doc-align/lib/parse.mjs';
import { worktreePath } from './worktree.mjs';

// The questions-first gates (D-044, D-052), each switched on in the shared file's `checks` (lib/settings.mjs). `record`
// runs them and refuses on what they return; none writes anything.
//   - `questionSources`: a question names every source it checked, and its comment is on the card;
//   - `markers`: no new `NEEDS CONFIRMATION` or `ToDo` marker in the UA pages a PR changed, at the PR's head;
//   - `places`: every place names its source and why it isn't confirmed, and the description lists it.

export const CHECKS = ['questionSources', 'markers', 'places'];

const text = (v) => typeof v === 'string' && v.trim() !== '';

// What a `questions` record's questions lack: each `{ text, sources: [{ kind, ref, result }], commentId }`. An admin
// change the work needs (`kind: "admin"`, A9) is no question a source answers: it gives its `reason` instead of
// sources. The kinds of source are the session's words (the card, a page, the code, the app, an API call): not a list.
export function questionProblems(questions) {
  if (!Array.isArray(questions) || !questions.length) return ['no "questions": a questions record asks at least one'];
  const out = [];
  questions.forEach((q, i) => {
    const name = q?.id ?? `#${i + 1}`;
    if (!text(q?.text)) out.push(`question ${name} has no "text"`);
    if (q?.commentId === undefined || q?.commentId === null || q.commentId === '') out.push(`question ${name} has no "commentId": the card comment it was asked in`);
    if (q?.kind === 'admin') {
      if (!text(q.reason)) out.push(`question ${name} asks for an admin change: give the "reason" the work needs it`);
      return;
    }
    const sources = q?.sources;
    if (!Array.isArray(sources) || !sources.length) {
      out.push(`question ${name} names no source it checked: "sources": [{ "kind", "ref", "result" }]`);
      return;
    }
    sources.forEach((s, j) => {
      const missing = ['kind', 'ref', 'result'].filter((k) => !text(s?.[k]));
      if (missing.length) out.push(`question ${name}, source ${j + 1}: no ${missing.join(', ')}`);
    });
  });
  return out;
}

// The questions' comments that are not on the card (`comments`, as `read-card` gives them). The ids are compared as
// texts; the comment's words are the host's and are not compared.
export function commentsMissing(questions, comments) {
  const ids = new Set((comments ?? []).map((c) => String(c.id)));
  return [...new Set(questions.map((q) => String(q.commentId)))].filter((id) => !ids.has(id));
}

// What the places of a `pr` record lack: each `{ id, page, claim, source, why }`. `source` and `why` are the session's
// words (`code; ticket #916 …`, `codeOnly`, a sentence): no list.
export function placeProblems(places) {
  const out = [];
  (places ?? []).forEach((p, i) => {
    const missing = ['id', 'page', 'claim', 'source', 'why'].filter((k) => !(text(p?.[k]) || (k === 'id' && typeof p?.id === 'number')));
    if (missing.length) out.push(`place ${p?.id ?? `#${i + 1}`} has no ${missing.join(', ')}`);
  });
  return out;
}

// The places of one PR the description doesn't list: a place with a line comment by the link to it
// (`#discussion_r<id>`), one on an unchanged line (no comment) by its page.
export function placesNotListed(places, body) {
  const b = String(body ?? '');
  return (places ?? []).filter((p) => (p.commentId !== undefined && p.commentId !== null ? !b.includes(`discussion_r${p.commentId}`) : !b.includes(String(p.page))));
}

const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
const PAGE = /\.mdx?$/i;
const key = (m) => `${m.kind}\0${m.text}`;

// The markers the PR's UA pages have at `head` and didn't have at the base (a marker already on a page stays the
// owner's, D-080), compared by kind and text so a line that moved is no new marker. Pages: `.md`/`.mdx` the branch
// changed (`<base>...<head>`) under its targets' `uaRoot`, outside `.sources/`. Run in the PR's worktree, as the image
// pair check is; one that can't run (no worktree, git fails) returns `{ error }`: the record is refused, never passed.
export function markersAt(settings, pr, head) {
  const wt = worktreePath(settings, pr);
  if (!wt || !fs.existsSync(wt)) return { found: [], error: `no worktree of ${pr.repo} ${pr.branch} at ${wt ?? '(no targets[].path)'} to check in; the runner makes it before the next try` };
  const roots = (pr.targets ?? []).map((id) => settings.targets.find((t) => t.id === id)?.uaRoot).filter(Boolean);
  if (!roots.length) roots.push(...settings.targets.filter((t) => t.repo === pr.repo).map((t) => t.uaRoot));
  const under = (p) => roots.some((r) => p.startsWith(r.endsWith('/') ? r : `${r}/`));
  const base = pr.base ?? 'main';
  try {
    let ref = base;
    try {
      git(wt, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${base}`]);
      ref = `origin/${base}`;
    } catch {
      /* the local base */
    }
    const changed = git(wt, ['diff', '-z', '--name-only', '--no-renames', '--diff-filter=AM', `${ref}...${head}`]).split('\0').filter(Boolean);
    const pages = changed.filter((p) => PAGE.test(p) && under(p) && !/(^|\/)\.sources\//.test(p));
    const found = [];
    for (const page of pages) {
      const now = parse(git(wt, ['show', `${head}:${page}`])).markers;
      let before = [];
      try {
        before = parse(git(wt, ['show', `${ref}:${page}`])).markers;
      } catch {
        /* a new page */
      }
      const left = new Map();
      for (const m of before) left.set(key(m), (left.get(key(m)) ?? 0) + 1);
      for (const m of now) {
        const n = left.get(key(m)) ?? 0;
        if (n) left.set(key(m), n - 1);
        else found.push({ page, line: m.line, kind: m.kind, text: m.text });
      }
    }
    return { found, checked: pages.length, base: ref };
  } catch (e) {
    return { found: [], error: String(e.stderr ?? e.message).trim().split('\n').at(-1).slice(0, 300) };
  }
}

export const markersMessage = (found) => found.map((m) => `${m.page}:${m.line} ${m.kind}: ${m.text}`).join('; ');
