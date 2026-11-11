// The host's own docs as evidence, with no model: the ticket's terms, taken literally from its text, searched in the
// published pages of the hub and of each sibling doc repo the host declares (`docRepos`), and in the earlier tickets'
// work folders in the hub. The writer's brief lists the hits next to the code repos and the ticket's commits.
//
// The published pages are read with `git grep` at a ref of each repo (`origin/<base>` as last fetched, else `HEAD`),
// never in a working tree, and nothing is written there. The work folders are never committed (a host ignores its
// `.sources/`), so they are read from the files, read only: no link followed, no binary file, no file past `FILE_MAX`.
// Never searched: the current ticket's own folder, the release notes and the host's other exclusions, under every
// content root of every doc repo, `.assets`, `.sources` inside a content root, frames and the label store
// (`.doc-toolkit`). The terms go to git as fixed strings, each after `-e`, so none can become an option. Nothing here
// throws: a git error, a time out or a fault is a note.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// The bounds: hits listed in all, lines listed per file, the excerpt's length, the terms searched, a term's shortest
// length, the whole lookup's time and each git call's.
export const HITS_MAX = 30;
export const PER_FILE = 3;
export const EXCERPT_MAX = 200;
export const TERMS_MAX = 20;
export const TERM_MIN = 4;
export const BUDGET_MS = 45_000;
const GIT_TIMEOUT_MS = 20_000;
const FILE_MAX = 1024 * 1024;
const WALK_FILES_MAX = 200;
const WALK_DEPTH_MAX = 3;
// What falls past the bound is listed by file, this many, then counted.
export const PAST_SHOWN = 10;

// The host's defaults (`docEvidence`, lib/settings.mjs): what is never searched, and the files of an earlier ticket's
// work folder that are (a name ending in `/` is a folder, read with what is under it). An exclusion is a folder's name
// (`release-notes/`: that folder at any depth, in every repo), or a path under a content root (`drafts/`, or
// `docs/drafts/` with the root in it), left out under every content root, UA and EN, of every doc repo, and from each
// repo's top. The release notes are always left out: the host's list is added to the default, never put in its place.
export const DEFAULT_EXCLUDE = ['release-notes/'];
export const DEFAULT_TICKET_FILES = ['app-notes.md', 'api-check.md', 'code-check.md', 'ticket.md', 'sme-interview.md', 'api/'];
// Never searched, in every repo and every work folder.
const NEVER = ['.assets', '.sources', '.doc-toolkit', 'frames', 'node_modules', '.git'];

// ------------------------------------------------------------------ the terms

// Words too generic to tell a page apart, any case: HTTP methods, JSON types, common values and words of a ticket, and
// the field labels of a ticket's or a note's template, in English and Ukrainian.
const GENERIC = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'true', 'false', 'null', 'none', 'nil', 'undefined', 'string', 'number', 'integer',
  'boolean', 'bool', 'object', 'array', 'json', 'yaml', 'http', 'https', 'html', 'markdown', 'todo', 'readme', 'api', 'url', 'uri', 'uuid',
  'id', 'ok', 'error', 'errors', 'test', 'tests', 'main', 'master', 'docs', 'doc', 'note', 'notes', 'data', 'value', 'values', 'name',
  'type', 'list', 'item', 'items', 'text', 'link', 'page', 'pages', 'file', 'files', 'info', 'description', 'status', 'result', 'response',
  'request', 'body', 'query', 'header', 'headers', 'example', 'default', 'setting', 'settings', 'config', 'admin', 'user', 'users',
  'card', 'original', 'summary', 'priority', 'steps', 'expected', 'actual', 'context', 'goal', 'source', 'sources', 'attachments', 'comments',
  'question', 'questions', 'answer', 'answers', 'important', 'warning', 'date', 'author',
  'опис', 'приклад', 'приклади', 'примітка', 'примітки', 'пріоритет', 'статус', 'назва', 'тип', 'значення', 'поле', 'поля', 'крок', 'кроки',
  'результат', 'відповідь', 'запит', 'параметр', 'параметри', 'увага', 'важливо', 'порада', 'нотатки', 'коментар', 'коментарі', 'оригінал',
  'джерело', 'джерела', 'посилання', 'вкладення', 'задача', 'завдання', 'картка', 'мета', 'контекст', 'сторінка', 'розділ', 'дата', 'автор',
  'питання', 'очікувано', 'фактично', 'тест', 'тести', 'помилка', 'налаштування', 'документація',
]);
// The last part of a dotted word that makes it a file name or a host name, not an identifier.
const NOT_IDENT = new Set(['com', 'org', 'net', 'io', 'fyi', 'dev', 'app', 'ua', 'ru', 'eu', 'co', 'me', 'md', 'mdx', 'go', 'ts', 'tsx', 'js',
  'mjs', 'cjs', 'jsx', 'json', 'yml', 'yaml', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'mp4', 'mp3', 'mov', 'txt', 'html', 'css', 'py', 'sh',
  'pdf', 'csv', 'xml', 'env', 'lock', 'log', 'zip', 'sql', 'java', 'kt', 'rb', 'php', 'cs']);
const METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/;
const PARAM = /^(\{[^}]*\}|<[^>]*>|:[A-Za-z_]\w*|\[[^\]]*\])$/;

// An endpoint path cut before its first parameter (`/api/v1/t/{otp}` → `/api/v1/t/`), or null when it isn't one worth
// a search: a single short part, or only `api` and versions.
export function endpointOf(raw) {
  const parts = raw.replace(/[).,;:!?»"'`]+$/, '').split('/').slice(1);
  const kept = [];
  let cut = false;
  for (const p of parts) {
    if (PARAM.test(p) || /[{}<>]/.test(p)) {
      cut = true;
      break;
    }
    if (!/^[A-Za-z0-9_.-]*$/.test(p)) return null;
    kept.push(p);
  }
  if (kept.length && kept[kept.length - 1] === '') kept.pop();
  if (!kept.length || kept.some((p) => p === '')) return null;
  const meaningful = kept.filter((p) => !/^(api|v\d+)$/i.test(p));
  if (!meaningful.length) return null;
  if (kept.length < 2 && kept[0].length < TERM_MIN) return null;
  return `/${kept.join('/')}${cut || /\/$/.test(raw) ? '/' : ''}`;
}

const tidy = (s) => s.replace(/\s+/g, ' ').trim();
// Whether a term names a ticket key: a key of four characters or more anywhere in it (`QUASI:tw4242x`), a shorter one
// only as a whole word, so the key `d2` leaves `grid2Layout` alone.
const namesKey = (t, k) => {
  if (!k) return false;
  if (k.length >= 4) return t.includes(k);
  return new RegExp(`(^|[^A-Za-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9])`, 'i').test(t);
};
// A term worth a search: long enough, not a number, a URL, a file path or a generic word, and not a ticket key.
function keep(term, keys) {
  const t = tidy(term).replace(/^[\s.,;:!?«»"'(]+|[\s.,;:!?«»"')]+$/g, '');
  if (t.length < TERM_MIN || t.length > 80) return null;
  if (!/[A-Za-zЀ-ӿ]/.test(t)) return null;
  if (/:\/\//.test(t) || /^www\./i.test(t)) return null;
  if (GENERIC.has(t.toLowerCase())) return null;
  if (keys.some((k) => namesKey(t, k))) return null;
  // A file path from the code (`services/x/y.go`) or a file name: the docs don't name them.
  if (/^[\w./-]+\.[A-Za-z0-9]{1,5}$/.test(t) && NOT_IDENT.has(t.split('.').pop().toLowerCase())) return null;
  return t;
}

// A text with its fenced blocks taken out, fence lines and content: a block of code or of a raw response names the
// code's own identifiers, which crowd out the terms a page would use. With `plain`, a fence with no language after it
// keeps its content (a person's spec pasted into the card as a block, not code), and only its fence lines go.
export function withoutFences(text, { plain = false } = {}) {
  const out = [];
  let open = null;
  for (const line of String(text).split('\n')) {
    const f = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (open) {
      if (f && f[1][0] === open.mark[0] && f[1].length >= open.mark.length && !f[2].trim()) open = null;
      else if (open.keep) out.push(line);
      continue;
    }
    if (f) {
      open = { mark: f[1], keep: plain && !f[2].trim() };
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

// A bold span that is a field's label, not a name: its text ends in a colon (`**Card:**`), a separator follows it
// (`**Опис**:`, `**Опис** — …`), or it is the whole line, after a list, heading or quote mark (`**Приклад**`).
function boldLabel(text, m) {
  if (/:\s*$/.test(m[1])) return true;
  const after = text.slice(m.index + m[0].length);
  if (/^\s*[:—–]|^\s+-\s/.test(after)) return true;
  const start = text.lastIndexOf('\n', m.index) + 1;
  const end = text.indexOf('\n', m.index + m[0].length);
  const line = text.slice(start, end < 0 ? text.length : end);
  return /^\s*(?:[-*+]|\d+[.)]|#{1,6}|>)?\s*$/.test(line.slice(0, m.index - start)) && /^\s*[.:]?\s*$/.test(line.slice(m.index - start + m[0].length));
}

// The terms of a ticket's texts, matched later as they are written: endpoint paths, code spans, CamelCase and dotted
// identifiers, and bold spans that aren't a field's label; no term twice, the ones the texts name most often first, at
// most `max` (`more` counts the rest). A text is a string, its fenced blocks left out whole, or `{ text, plain: true }`
// (the ticket's own text: its card and `ticket.md`), where a block with no language keeps its content. `keys` are the
// step's ticket keys: never a term, nor in one (a test record named after the ticket). URLs are taken out first, so a
// link's path gives no term.
export function extractTerms(texts, { keys = [], max = TERMS_MAX } = {}) {
  const text = (Array.isArray(texts) ? texts : [texts])
    .map((x) => (typeof x === 'string' ? withoutFences(x) : typeof x?.text === 'string' ? withoutFences(x.text, { plain: Boolean(x.plain) }) : null))
    .filter((x) => x !== null).join('\n')
    .replace(/https?:\/\/[^\s)\]>»"'`]+/g, ' ');
  const found = { endpoint: [], code: [], ident: [], bold: [] };
  // Endpoint paths, with code marks inside them taken out (`/transaction/`cardDetails`` → `/transaction/cardDetails`).
  const flat = text.replace(/`([^`\n]*)`/g, '$1');
  for (const m of flat.matchAll(/(?<![\w./:@-])\/[A-Za-z0-9_{}<>:.-]+(?:\/[A-Za-z0-9_{}<>:.\-[\]]*)+/g)) {
    const e = endpointOf(m[0]);
    if (e) found.endpoint.push(e);
  }
  for (const m of text.matchAll(/`([^`\n]{2,120})`/g)) {
    let span = tidy(m[1]).replace(METHOD, '');
    if (span.startsWith('/')) continue; // an endpoint: taken above
    if (span.split(' ').length > 3) continue; // a code line, not a name
    // A plain lowercase word or two (`amount`, `not found`): a common field or value, not a name to tell pages apart.
    if (/^[a-z]+( [a-z]+)*$/.test(span)) continue;
    found.code.push(span);
  }
  for (const m of flat.matchAll(/(?<![\w./@-])([a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+)(?![\w-])/g)) found.ident.push(m[1]);
  for (const m of flat.matchAll(/(?<![\w./@-])([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+)(?![\w(-])/g)) {
    const last = m[1].split('.').pop().toLowerCase();
    if (!NOT_IDENT.has(last) && !/^(e\.g|i\.e|etc)$/i.test(m[1])) found.ident.push(m[1]);
  }
  for (const m of text.matchAll(/\*\*([^*\n]{2,80})\*\*/g)) {
    if (boldLabel(text, m)) continue;
    const b = tidy(m[1].replace(/`/g, ''));
    if (b.split(' ').length <= 6) found.bold.push(b);
  }
  // Each term once, the most often named first (in all the texts, as written), then by kind, then as it comes.
  const seen = new Map();
  [...found.endpoint, ...found.code, ...found.ident, ...found.bold].forEach((t, i) => {
    const k = keep(t, keys);
    if (k && !seen.has(k)) seen.set(k, { term: k, at: i, count: flat.split(k).length - 1 });
  });
  const out = [...seen.values()].sort((a, b) => b.count - a.count || a.at - b.at).map((x) => x.term);
  return { terms: out.slice(0, max), more: Math.max(0, out.length - max) };
}

// ------------------------------------------------------------------ the search

const git = (dir, args, timeout) =>
  execFileSync('git', ['-C', dir, '-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
const gitError = (e, timeout) => (e?.code === 'ETIMEDOUT' || (e?.signal === 'SIGTERM' && e?.status === null) ? `timed out after ${Math.round(timeout / 1000)} s` : String(e?.stderr || e?.message || e).trim().split('\n')[0].slice(0, 200));
const posix = (p) => String(p).replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');

// A line as an excerpt: one line of text, no control characters, at most `EXCERPT_MAX` characters, from a little before
// the first of `terms` (the rarest first) that it holds.
export function excerptOf(line, terms) {
  const t = String(line).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length <= EXCERPT_MAX) return t;
  const at = terms.map((x) => t.indexOf(x)).find((i) => i >= 0) ?? Infinity;
  const from = Number.isFinite(at) ? Math.max(0, Math.min(at - 60, t.length - EXCERPT_MAX)) : 0;
  const head = from > 0 ? '…' : '';
  const room = EXCERPT_MAX - head.length;
  const body = t.slice(from, from + room);
  return `${head}${from + room < t.length ? `${body.slice(0, -1)}…` : body}`;
}

// The ref a doc repo's pages are read at: `origin/<base>` as last fetched (the published pages), else `HEAD`; with
// its commit. Never the working tree.
export function refOf(dir, base, timeoutMs = GIT_TIMEOUT_MS) {
  for (const ref of [`refs/remotes/origin/${base}`, 'HEAD']) {
    try {
      const commit = git(dir, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], timeoutMs).trim();
      if (commit) return { ref: ref === 'HEAD' ? 'HEAD' : `origin/${base}`, full: ref, commit };
    } catch {
      /* the next */
    }
  }
  return null;
}

// The pathspecs that leave out the exclusions (`DEFAULT_EXCLUDE`) in a repo with these content roots: a name with no
// `/` in it is that folder at any depth, and a page of that name; a path is left out from the repo's top and under every
// root, with the root it starts with, if any, taken off first (`docs/drafts/` is `drafts/` under `portal/` too). `known`
// are the roots a path may start with: every doc repo's, so a hub's path holds in a sibling with other roots.
export function excludeSpecs(exclude, roots, known = roots) {
  const under = roots.map(posix).filter((r) => r && r !== '.');
  const prefixes = [...new Set([...known, ...roots].map(posix).filter((r) => r && r !== '.'))].sort((a, b) => b.length - a.length);
  return [...new Set(exclude.map(posix).filter(Boolean).flatMap((e) => {
    if (!e.includes('/')) return [`:(exclude,glob)**/${e}/**`, `:(exclude,glob)**/${e}.md`, `:(exclude,glob)**/${e}.mdx`];
    const root = prefixes.find((r) => e.startsWith(`${r}/`));
    const rest = root ? e.slice(root.length + 1) : e;
    return [`:(exclude)${e}`, ...under.map((r) => `:(exclude)${r}/${rest}`)];
  }))];
}

// The published pages of one repo that hold a term: `git grep` at the ref, over the Markdown files of its content
// roots, with the exclusions under each (`known`: `excludeSpecs`). Returns { hits: [{ file, line, text }], error? }.
export function grepPages(dir, { full, roots, exclude, known = roots, terms, timeoutMs }) {
  const pathspecs = [
    ...roots.flatMap((r) => (posix(r) === '' || posix(r) === '.' ? [':(glob)**/*.md', ':(glob)**/*.mdx'] : [`:(glob)${posix(r)}/**/*.md`, `:(glob)${posix(r)}/**/*.mdx`])),
    ...excludeSpecs(exclude, roots, known),
    ...NEVER.map((n) => `:(exclude,glob)**/${n}/**`),
  ];
  let out;
  try {
    out = git(dir, ['grep', '--no-color', '-I', '-n', '--null', '-F', ...terms.flatMap((t) => ['-e', t]), full, '--', ...pathspecs], timeoutMs);
  } catch (e) {
    // Exit 1 with nothing said: no line matched.
    if (e?.status === 1 && !String(e?.stderr ?? '').trim()) return { hits: [] };
    return { hits: [], error: `git grep: ${gitError(e, timeoutMs)}` };
  }
  const hits = [];
  for (const row of out.split('\n')) {
    if (!row) continue;
    const [where, line, ...rest] = row.split('\0');
    const file = where.startsWith(`${full}:`) ? where.slice(full.length + 1) : where.replace(/^[^:]*:/, '');
    hits.push({ file, line: Number(line), text: rest.join('\0') });
  }
  return { hits };
}

// The files of a ticket's work folder that are searched: each name of `files` that is a plain file there, and what is
// under each name ending in `/` (no link followed, no dot or never-searched folder). Paths from the folder, and what the
// bounds left out (`skipped`): the files over `FILE_MAX` (`big`), the folders `WALK_DEPTH_MAX` levels down that are not
// entered (`deep`), and whether the walk stopped at `WALK_FILES_MAX` files (`many`).
function ticketFilesOf(folder, files) {
  const out = [];
  const skipped = { big: [], deep: [], many: false };
  const plain = (p, rel) => {
    try {
      const st = fs.lstatSync(p);
      if (st.isFile() && st.size > FILE_MAX) skipped.big.push(rel);
      return st.isFile() && st.size <= FILE_MAX;
    } catch {
      return false;
    }
  };
  const walk = (rel, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(folder, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (skipped.many) return;
      if (e.name.startsWith('.') || NEVER.includes(e.name)) continue;
      const r = path.posix.join(rel, e.name);
      if (e.isDirectory()) {
        if (depth < WALK_DEPTH_MAX) walk(r, depth + 1);
        else skipped.deep.push(r);
      } else if (e.isFile() && plain(path.join(folder, r), r)) {
        if (out.length >= WALK_FILES_MAX) skipped.many = true;
        else out.push(r);
      }
    }
  };
  for (const f of files) {
    if (f.endsWith('/')) {
      const d = posix(f);
      try {
        if (fs.lstatSync(path.join(folder, d)).isDirectory()) walk(d, 1);
      } catch {
        /* none */
      }
    } else if (plain(path.join(folder, f), posix(f))) out.push(posix(f));
  }
  return { files: out, skipped };
}

// What the bounds of the work folders left out, as one note (`ticketFilesOf`'s `skipped`, per ticket), or null. A few
// files and folders are named, the rest counted.
export function skippedNote(list, lead = 'not searched in the work folders') {
  const named = (items) => `${items.slice(0, 3).join(', ')}${items.length > 3 ? `, and ${items.length - 3} more` : ''}`;
  const big = list.flatMap((x) => x.skipped.big.map((f) => `${x.ticket} ${f}`));
  const deep = list.flatMap((x) => x.skipped.deep.map((f) => `${x.ticket} ${f}/`));
  const many = list.filter((x) => x.skipped.many).map((x) => x.ticket);
  const parts = [
    big.length ? `${big.length} file(s) over ${Math.round(FILE_MAX / 1024 / 1024)} MB (${named(big)})` : null,
    deep.length ? `${deep.length} folder(s) more than ${WALK_DEPTH_MAX} levels down (${named(deep)})` : null,
    many.length ? `what is past the first ${WALK_FILES_MAX} files of the folder of ${named(many)}` : null,
  ].filter(Boolean);
  return parts.length ? `${lead}: ${parts.join('; ')}` : null;
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

// The texts of a ticket's own work folder that its terms come from: `ticket.md` first (the ticket as the start
// gathered it), then the other Markdown files of `files` (the session's own notes: the live check, the API check; a raw
// response under `api/` gives no term). Returns { texts: [{ name, text }], skipped } (`ticketFilesOf`).
export function ownTexts(root, workFolder, key, files = DEFAULT_TICKET_FILES) {
  const none = { texts: [], skipped: { big: [], deep: [], many: false } };
  if (!workFolder || !/^[\w-][\w.-]*$/.test(key)) return none;
  const folder = path.resolve(root, workFolder.split('<key>').join(key));
  const order = [...files].sort((a, b) => (b === 'ticket.md') - (a === 'ticket.md'));
  const { files: found, skipped } = ticketFilesOf(folder, order);
  const texts = found.filter((rel) => /\.md$/i.test(rel)).flatMap((rel) => {
    try {
      const buf = fs.readFileSync(path.join(folder, rel));
      return isBinary(buf) ? [] : [{ name: rel, text: buf.toString('utf8') }];
    } catch {
      return [];
    }
  });
  return { texts, skipped };
}

// The earlier tickets' work folders: every folder the host's `workFolder` pattern gives for another key, the step's own
// keys left out. Returns { hits: [{ ticket, name (from its folder), file (from the host root), line, text }], folders,
// skipped: [{ ticket, skipped }] (what the bounds left out, `ticketFilesOf`), error? }; `stopAt` is the time the lookup
// must stop by, and what it no longer covers is said.
export function grepTickets(root, workFolder, { own = [], files, terms, now, stopAt }) {
  const [head] = workFolder.split('<key>');
  const base = path.resolve(root, head || '.');
  const hits = [];
  const skipped = [];
  let names;
  try {
    names = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[\w-][\w.-]*$/.test(e.name)).map((e) => e.name);
  } catch (e) {
    return { hits, folders: 0, skipped, ...(e?.code === 'ENOENT' ? {} : { error: `the work folders: ${String(e?.message ?? e).slice(0, 200)}` }) };
  }
  // Newest first, by the number in the key where there is one.
  names.sort((a, b) => (Number(b.replace(/\D/g, '')) || 0) - (Number(a.replace(/\D/g, '')) || 0) || a.localeCompare(b));
  const others = names.filter((n) => !own.includes(n));
  let folders = 0;
  for (const key of others) {
    if (now() >= stopAt) return { hits, folders, skipped, error: `the time ran out after ${folders} of ${others.length} earlier tickets' folders` };
    const folder = path.resolve(root, workFolder.split('<key>').join(key));
    if (!folder.startsWith(base + path.sep)) continue;
    try {
      if (!fs.lstatSync(folder).isDirectory()) continue;
    } catch {
      continue;
    }
    folders += 1;
    const found = ticketFilesOf(folder, files);
    if (found.skipped.big.length || found.skipped.deep.length || found.skipped.many) skipped.push({ ticket: key, skipped: found.skipped });
    for (const rel of found.files) {
      let buf;
      try {
        buf = fs.readFileSync(path.join(folder, rel));
      } catch {
        continue;
      }
      if (isBinary(buf)) continue;
      const lines = buf.toString('utf8').split(/\r?\n/);
      lines.forEach((text, i) => {
        if (terms.some((t) => text.includes(t))) hits.push({ ticket: key, name: rel, file: posix(path.relative(root, path.join(folder, rel))), line: i + 1, text });
      });
    }
  }
  return { hits, folders, skipped };
}

// A repo's content roots as root pairs: a `{ ua, en }` pair (`en` may be none), or a root alone (a string), which is a
// pair of its own with no twin.
export const pairsOf = (roots) => (roots ?? []).map((r) => (typeof r === 'string' ? { ua: r, en: null } : { ua: r?.ua ?? null, en: r?.en ?? null })).filter((p) => p.ua || p.en);

// The whole lookup. `repos`: [{ repo, dir, base, roots (`pairsOf`) }], the hub first; `tickets`: { workFolder, own,
// files } or null; `exclude`: the host's exclusions, added to `DEFAULT_EXCLUDE` (`excludeSpecs`). Returns { terms:
// [{ term, files }], files: [{ repo?, dir?, ticket?, ref?, commit?, file, abs, count, terms, hits: [{ line, excerpt }],
// more, twins }], past: { files, hits, shown: [{ label, count }] }, searched: { repos: [{ repo, ref, commit, dir }],
// folders }, notes }. Files are ranked by the terms they hold, a rarer term weighing more (1 / the files it is in), then
// by their hits; at most `PER_FILE` lines of a file and `HITS_MAX` in all are listed, and the files past that are
// counted, the first `PAST_SHOWN` named. A page whose twin in the other language (the same path under the other root
// of its root pair) is listed is named with it (`twins`), with no lines of its own; two pairs' pages never fold.
export function docEvidence({ root, repos = [], tickets = null, exclude = [], terms = [], now = Date.now, budgetMs = BUDGET_MS, grep = grepPages, ref = refOf }) {
  const out = { terms: [], files: [], past: { files: 0, hits: 0, shown: [] }, searched: { repos: [], folders: 0 }, notes: [] };
  const excluded = [...new Set([...DEFAULT_EXCLUDE, ...(exclude ?? [])])];
  const flatOf = (r) => [...new Set(pairsOf(r.roots).flatMap((p) => [p.ua, p.en].filter(Boolean)))];
  const known = [...new Set(repos.flatMap(flatOf))];
  if (!terms.length) return out;
  const stopAt = now() + budgetMs;
  const left = () => stopAt - now();
  const all = [];
  if (tickets?.workFolder) {
    const r = grepTickets(root, tickets.workFolder, { own: tickets.own ?? [], files: tickets.files ?? DEFAULT_TICKET_FILES, terms, now, stopAt });
    out.searched.folders = r.folders;
    if (r.error) out.notes.push(r.error);
    const skipped = skippedNote(r.skipped ?? []);
    if (skipped) out.notes.push(skipped);
    for (const h of r.hits) all.push({ ...h, abs: path.join(root, h.file), id: `ticket ${h.ticket}` });
  }
  for (const r of repos) {
    if (left() <= 0) {
      out.notes.push(`${r.repo}: not searched (the lookup's time, ${Math.round(budgetMs / 1000)} s, ran out)`);
      continue;
    }
    const at = ref(r.dir, r.base ?? 'main', Math.max(1, Math.min(GIT_TIMEOUT_MS, left())));
    if (!at) {
      out.notes.push(`${r.repo}: not searched (no commit to read at ${r.dir})`);
      continue;
    }
    const pairs = pairsOf(r.roots);
    const flat = flatOf(r);
    if (!flat.length) {
      out.notes.push(`${r.repo}: not searched (no content root)`);
      continue;
    }
    const g = grep(r.dir, { full: at.full, roots: flat, exclude: excluded, known, terms, timeoutMs: Math.max(1, Math.min(GIT_TIMEOUT_MS, left())) });
    out.searched.repos.push({ repo: r.repo, ref: at.ref, commit: at.commit, dir: r.dir });
    if (g.error) out.notes.push(`${r.repo}: ${g.error}`);
    // A page's twin key: its root pair and its path under the pair's root, which a UA page and its EN twin share. Only a
    // pair with both roots has twins, and the longest root that holds the page decides its pair.
    const roots = pairs.flatMap((p, i) => (p.ua && p.en ? [p.ua, p.en].map((x) => ({ root: posix(x), pair: i })) : [])).filter((x) => x.root && x.root !== '.').sort((a, b) => b.root.length - a.root.length);
    const twinOf = (file) => {
      const x = roots.find((y) => file.startsWith(`${y.root}/`));
      return x ? `${r.dir}\0${x.pair}\0${file.slice(x.root.length + 1)}` : null;
    };
    for (const h of g.hits ?? []) all.push({ ...h, repo: r.repo, dir: r.dir, ref: at.ref, commit: at.commit, abs: path.join(r.dir, h.file), twin: twinOf(h.file) });
  }
  // Per file: its hits and the terms they hold.
  const byFile = new Map();
  for (const h of all) {
    const f = byFile.get(h.abs) ?? { repo: h.repo, dir: h.dir, ticket: h.ticket, name: h.name, ref: h.ref, commit: h.commit, file: h.file, abs: h.abs, twin: h.twin ?? null, hits: [], terms: new Set() };
    const held = terms.filter((t) => h.text.includes(t));
    for (const t of held) f.terms.add(t);
    f.hits.push({ line: h.line, text: h.text, held });
    byFile.set(h.abs, f);
  }
  // The rarer a term, the more a file that holds it weighs: each term counts 1 / the number of files it is in.
  const df = new Map(terms.map((t) => [t, [...byFile.values()].filter((f) => f.terms.has(t)).length]));
  const weight = (f) => [...f.terms].reduce((s, t) => s + 1 / df.get(t), 0);
  const files = [...byFile.values()].map((f) => ({ ...f, weight: weight(f) })).sort((a, b) => b.weight - a.weight || b.hits.length - a.hits.length || a.abs.localeCompare(b.abs));
  out.terms = terms.map((t) => ({ term: t, files: df.get(t) }));
  let listed = 0;
  // A page's twin in the other language of the same repo is named with the first of the two listed, not listed again.
  const twins = new Map();
  for (const f of files) {
    const first = f.twin ? twins.get(f.twin) : null;
    if (first) {
      first.twins.push(f.file);
      continue;
    }
    const room = Math.min(PER_FILE, HITS_MAX - listed);
    const label = f.ticket ? `ticket ${f.ticket}, ${f.file}` : `${f.repo} ${f.file}`;
    if (room <= 0) {
      out.past.files += 1;
      out.past.hits += f.hits.length;
      if (out.past.shown.length < PAST_SHOWN) out.past.shown.push({ label, count: f.hits.length });
      continue;
    }
    // A file's lines that hold its rarest terms, in the file's order.
    const lineWeight = (h) => h.held.reduce((s, t) => s + 1 / df.get(t), 0);
    const rarest = (held) => [...held].sort((a, b) => df.get(a) - df.get(b));
    const hits = [...f.hits].sort((a, b) => lineWeight(b) - lineWeight(a) || a.line - b.line).slice(0, room).sort((a, b) => a.line - b.line).map((h) => ({ line: h.line, excerpt: excerptOf(h.text, rarest(h.held)) }));
    listed += hits.length;
    const entry = { ...(f.repo ? { repo: f.repo, dir: f.dir, ref: f.ref, commit: f.commit } : { ticket: f.ticket, name: f.name }), file: f.file, abs: f.abs, count: f.hits.length, terms: [...f.terms], hits, more: f.hits.length - hits.length, twins: [] };
    out.files.push(entry);
    if (f.twin) twins.set(f.twin, entry);
  }
  return out;
}
