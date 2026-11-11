import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from '../../doc-align/lib/parse.mjs';
import { worktreePath } from './worktree.mjs';

// The questions-first gates (D-044, D-052), each switched on in the shared file's `checks` (lib/settings.mjs). `record`
// runs them and refuses on what they return; none writes anything.
//   - `questionSources`: a question names every source it checked, and its comment, posted for it, is on the card;
//   - `markers`: no new `NEEDS CONFIRMATION` or `ToDo` marker in the UA pages a PR changed, at the PR's head;
//   - `places`: every place names its source and why it isn't confirmed, and the description lists it.

export const CHECKS = ['questionSources', 'markers', 'places'];
// What a place's claim rests on (the TASK-042 design, §3): the kind only; the session's words go in `why`. `docs` is a
// published page or an earlier ticket's notes, from the brief's docs lookup (lib/doc-evidence.mjs).
export const PLACE_SOURCES = ['app', 'apiCall', 'person', 'code', 'transcript', 'explanation', 'card', 'docs'];

const text = (v) => typeof v === 'string' && v.trim() !== '';
// A text as a comment or a description may carry it: no Markdown emphasis or code marks, spaces collapsed, any case.
const plain = (s) => String(s ?? '').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

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

// What the questions' comments (`comments`, as `read-card` gives them) don't show: a comment the card lacks, one posted
// before `since` (the ticket's last record: an older comment asked something else), and a question whose comment names
// neither the question as recorded nor every one of its sources' refs (an admin change: the question or its reason).
export function commentProblems(questions, comments, since) {
  const byId = new Map((comments ?? []).map((c) => [String(c.id), c]));
  const out = [];
  for (const id of [...new Set(questions.map((q) => String(q.commentId)))]) {
    const c = byId.get(id);
    if (!c) out.push(`the card has no comment ${id}`);
    else if (since && c.time && String(c.time) <= String(since)) out.push(`comment ${id} was posted at ${c.time}, before the ticket's last record (${since}): ask in a new comment`);
  }
  for (const [i, q] of questions.entries()) {
    const c = byId.get(String(q.commentId));
    if (!c) continue;
    const body = plain(c.text);
    const named = (s) => text(s) && body.includes(plain(s));
    const refs = q.kind === 'admin' ? [q.reason] : (q.sources ?? []).map((s) => s.ref);
    if (!named(q.text) && !(refs.length && refs.every(named))) out.push(`comment ${q.commentId} names neither question ${q.id ?? `#${i + 1}`} as recorded nor every one of its sources' refs`);
  }
  return out;
}

// What the places of a `pr` record lack: each `{ id, repo, pr, page, claim, source, why }`, its `pr` one of the record's
// PRs (`prs`: [{ repo, number }]) and its `source` one of PLACE_SOURCES; `why` is the session's words.
export function placeProblems(places, prs) {
  const out = [];
  (places ?? []).forEach((p, i) => {
    const name = p?.id ?? `#${i + 1}`;
    const missing = ['id', 'repo', 'page', 'claim', 'source', 'why'].filter((k) => !(text(p?.[k]) || (k === 'id' && typeof p?.id === 'number')));
    if (missing.length) out.push(`place ${name} has no ${missing.join(', ')}`);
    if (text(p?.source) && !PLACE_SOURCES.includes(p.source)) out.push(`place ${name}'s source '${p.source}' is not one of ${PLACE_SOURCES.join(', ')} (the words go in "why")`);
    if (!prs.some((x) => x.repo === p?.repo && Number(x.number) === Number(p?.pr))) out.push(`place ${name} is on ${p?.repo ?? '?'}#${p?.pr ?? '?'}, not one of this record's PRs`);
  });
  return out;
}

// The places of one PR the description doesn't list: a place with a line comment by the link to it
// (`#discussion_r<id>`, and not a longer id), one on an unchanged line (no comment) by its `why`.
export function placesNotListed(places, body) {
  const b = String(body ?? '');
  return (places ?? []).filter((p) => (p.commentId !== undefined && p.commentId !== null ? !new RegExp(`discussion_r${String(p.commentId).replace(/\D/g, '')}(?!\\d)`).test(b) : !plain(b).includes(plain(p.why))));
}

// The language of a place (a correctness rule, on whatever `checks` say): its `claim` and `why` are the words of its line
// comment, so they are in the language of the page it is on. A language is told by its script: the page's dominant one
// is counted in its prose, with code, link targets, tags, MDX comments and import lines left out, and the names and
// values a page writes bare too: a table cell of one word (a field, a type, yes or no) and a word shaped like code
// (with a digit, `_`, `/`, `.`, `:`, `@`, `#`, `=`, two capitals in a row or a capital after a small letter). The
// place's text has at least one letter of that script once its code spans are left out. A page that can't be read, has
// too few letters, or has no script clearly ahead of the others is no check.
const SCRIPTS = ['Latin', 'Cyrillic', 'Greek', 'Armenian', 'Georgian', 'Hebrew', 'Arabic', 'Devanagari', 'Bengali', 'Thai', 'Hangul', ['Han', 'Hiragana', 'Katakana']].map((s) => {
  const names = [s].flat();
  return { name: names.join('/'), re: new RegExp(names.map((n) => `\\p{Script=${n}}`).join('|'), 'gu') };
});
const MIN_LETTERS = 20;
// The page's top script counts at least twice the letters of the next one, or the page is mixed and gets no check.
const AHEAD = 2;
const noCode = (s) => String(s ?? '').replace(/(`{3,}|~{3,})[\s\S]*?(\1|$)/g, ' ').replace(/(`+)[\s\S]*?\1/g, ' ');
const CODE_WORD = /\d|[_/.:@#=]\S|\p{Lu}{2}|\p{Ll}\p{Lu}/u;
const lettersOf = (s, script) => (String(s).match(script.re) ?? []).length;

// The dominant script of a page's prose (`{ name, re }`), or null when it has none clearly ahead.
export function pageScript(page) {
  const prose = parse(String(page ?? '')).prose.join('\n')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/^\s*(import|export)\b.*$/gm, ' ')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .split('\n')
    .map((line) => (/^\s*\|/.test(line) ? line.split(/(?<!\\)\|/).filter((c) => /\S\s+\S/.test(c.trim())).join(' ') : line))
    .join('\n')
    .split(/\s+/)
    .filter((w) => !CODE_WORD.test(w))
    .join(' ');
  const counts = SCRIPTS.map((s) => ({ s, n: lettersOf(prose, s) })).sort((a, b) => b.n - a.n);
  if (counts[0].n < MIN_LETTERS || counts[0].n < AHEAD * counts[1].n) return null;
  return counts[0].s;
}

// Whether a place's text has a letter of the script, its code spans and fenced blocks left out.
export const inScript = (s, script) => lettersOf(noCode(s), script) > 0;

// A page as the PR's worktree has it at `head` (`git show`), or as its file there; null when neither can be read.
function pageAt(settings, pr, head, page) {
  const wt = pr ? worktreePath(settings, pr) : null;
  if (!wt || !fs.existsSync(wt) || !text(page)) return null;
  if (head) {
    try {
      return git(wt, ['show', `${head}:${page}`]);
    } catch {
      /* the file in the worktree */
    }
  }
  try {
    return fs.readFileSync(path.join(wt, page), 'utf8');
  } catch {
    return null;
  }
}

// The places whose `claim` or `why` has no letter of their page's script: `[{ id, page, script, fields }]`. Each place
// is read on its PR (`prs`: the ledger's entries, `{ repo, number, branch, lastSeenHead }`); one off the record's PRs,
// with no page, or on a page that can't be read is not checked. Only the fields a place gives are judged: whether it
// has them is `placeProblems`'s.
export function placeLanguageProblems(settings, places, prs) {
  const pages = new Map();
  const out = [];
  for (const place of places ?? []) {
    const p = (prs ?? []).find((x) => x && x.repo === place?.repo && Number(x.number) === Number(place?.pr));
    if (!p || !text(place?.page)) continue;
    const k = `${p.repo}\0${p.number}\0${place.page}`;
    if (!pages.has(k)) {
      const body = pageAt(settings, p, p.lastSeenHead, place.page);
      pages.set(k, body === null ? null : pageScript(body));
    }
    const script = pages.get(k);
    if (!script) continue;
    const fields = ['claim', 'why'].filter((f) => text(place[f]) && !inScript(place[f], script));
    if (fields.length) out.push({ id: place.id ?? '?', page: place.page, script: script.name, fields });
  }
  return out;
}

export const languageMessage = (found) => found.map((x) => `place ${x.id}'s ${x.fields.join(' and ')} ${x.fields.length > 1 ? 'are' : 'is'} not in the language of ${x.page} (${x.script} script)`).join('; ');

const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
const PAGE = /\.mdx?$/i;
// The toolkit's markers in any spelling a session writes: `{/* ToDo: … */}`, `{/* TODO - … */}`, `{/* ToDo */}`,
// `{/* NEEDS CONFIRMATION: … */}`.
const MARKER = /\{\/\*\s*(NEEDS CONFIRMATION|TODO)\b[\s:\-–—]*([\s\S]*?)\s*\*\/\}/gi;
const key = (m) => `${m.kind}\0${m.text}`;

// The markers of a page's prose, with their lines: fenced and inline code blanked by doc-align's parser, so a marker in
// a code sample is none.
export function markersIn(page) {
  const whole = parse(page).prose.join('\n');
  const lineAt = (offset) => whole.slice(0, offset).split('\n').length;
  return [...whole.matchAll(MARKER)].map((m) => ({ kind: m[1].toUpperCase().startsWith('N') ? 'NEEDS CONFIRMATION' : 'ToDo', text: m[2].replace(/\s+/g, ' ').trim(), line: lineAt(m.index) }));
}

// The PR's diff in its worktree: the merge base of `origin/<base>` (or the local base) and `head`, and the UA pages the
// branch added, changed or moved there, a moved one with the path it came from. `{ error }` when it can't be read.
export function prPages(settings, pr, head) {
  const wt = worktreePath(settings, pr);
  if (!wt || !fs.existsSync(wt)) return { error: `no worktree of ${pr.repo} ${pr.branch} at ${wt ?? '(no targets[].path)'} to check in; the runner makes it before the next try` };
  const roots = (pr.targets ?? []).map((id) => settings.targets.find((t) => t.id === id)?.uaRoot).filter((r) => typeof r === 'string');
  if (!roots.length) roots.push(...settings.targets.filter((t) => t.repo === pr.repo).map((t) => t.uaRoot));
  // `./`, `.` or an empty root is the whole repo.
  const tops = roots.map((r) => r.replace(/^(\.\/)+/, '').replace(/\/+$/, '').replace(/^\.$/, ''));
  const under = (p) => tops.some((r) => !r || p === r || p.startsWith(`${r}/`));
  const base = pr.base ?? 'main';
  try {
    let ref = base;
    try {
      git(wt, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${base}`]);
      ref = `origin/${base}`;
    } catch {
      /* the local base */
    }
    // Against the merge base, as the PR's own diff is: a base that moved since the branch began changes nothing here.
    const mergeBase = git(wt, ['merge-base', ref, head]).trim();
    const f = git(wt, ['diff', '-z', '--name-status', '-M', '--diff-filter=AMR', mergeBase, head]).split('\0');
    const pages = [];
    for (let i = 0; i < f.length && f[i]; ) {
      const renamed = f[i][0] === 'R';
      const entry = renamed ? { path: f[i + 2], from: f[i + 1] } : { path: f[i + 1], from: f[i][0] === 'A' ? null : f[i + 1] };
      i += renamed ? 3 : 2;
      if (PAGE.test(entry.path) && under(entry.path) && !/(^|\/)\.sources\//.test(entry.path)) pages.push(entry);
    }
    return { wt, ref, mergeBase, pages };
  } catch (e) {
    return { error: String(e.stderr ?? e.message).trim().split('\n').at(-1).slice(0, 300) };
  }
}

// The markers the PR's UA pages have at `head` and didn't have at the merge base (a marker already on a page stays the
// owner's, D-080), compared by kind and text so a line that moved, or a page that moved, brings no new marker. Run in
// the PR's worktree, as the image pair check is; one that can't run returns `{ error }`: the record is refused, never
// passed.
export function markersAt(settings, pr, head) {
  const d = prPages(settings, pr, head);
  if (d.error) return { found: [], error: d.error };
  try {
    const found = [];
    for (const { path: page, from } of d.pages) {
      const now = markersIn(git(d.wt, ['show', `${head}:${page}`]));
      let before = [];
      if (from) {
        try {
          before = markersIn(git(d.wt, ['show', `${d.mergeBase}:${from}`]));
        } catch {
          /* not at the merge base */
        }
      }
      const left = new Map();
      for (const m of before) left.set(key(m), (left.get(key(m)) ?? 0) + 1);
      for (const m of now) {
        const n = left.get(key(m)) ?? 0;
        if (n) left.set(key(m), n - 1);
        else found.push({ page, line: m.line, kind: m.kind, text: m.text });
      }
    }
    return { found, checked: d.pages.length, base: d.ref };
  } catch (e) {
    return { found: [], error: String(e.stderr ?? e.message).trim().split('\n').at(-1).slice(0, 300) };
  }
}

// The lines of `page` the PR changed (added or rewritten, at `head`), from its diff against the merge base: where a
// place gets a line comment. `{ error }` when it can't be read.
export function changedLines(settings, pr, head, page) {
  const d = prPages(settings, pr, head);
  if (d.error) return { error: d.error };
  try {
    const lines = new Set();
    const entry = d.pages.find((x) => x.path === page);
    if (!entry) return { lines };
    const paths = [...new Set([entry.from, page].filter(Boolean))];
    for (const m of git(d.wt, ['diff', '-U0', '-M', d.mergeBase, head, '--', ...paths]).matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
      for (let n = Number(m[1]); n < Number(m[1]) + Number(m[2] ?? 1); n++) lines.add(n);
    }
    return { lines };
  } catch (e) {
    return { error: String(e.stderr ?? e.message).trim().split('\n').at(-1).slice(0, 300) };
  }
}

export const markersMessage = (found) => found.map((m) => `${m.page}:${m.line} ${m.kind}${m.text ? `: ${m.text}` : ''}`).join('; ');
