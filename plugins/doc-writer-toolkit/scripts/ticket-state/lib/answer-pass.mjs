import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CliError, Refused } from './errors.mjs';
import { inScript, pageScript } from './gates.mjs';
import { codeClonePath, worktreePath } from './worktree.mjs';
import { prId } from './ledger.mjs';

// The answer pass (TASK-105): a writer's session between the UA review and the PR whose only job is to answer what the
// write and the review left open, with every company repo, the docs, the earlier tickets and the test environment in
// reach. It also runs on a PR after a review round asked new questions, before they are shown. No AI here: what the
// pass is given (frozen before its session), what its record must carry, what the `pr` stage then reads.
//
// An item of the pass (`input.items`), each with an `id` of the pass's own:
//   q<n>  a question the write left (`write`'s `open.questions`), as recorded
//   p<n>  a place the write left (`write`'s `open.places`), as recorded
//   m<n>  a NEEDS CONFIRMATION or ToDo marker the branch added to its UA pages
//   f<n>  a finding the UA review left open (`uaReview`'s `open`)
//   d<n>  a description question a review round asked (on a PR, with review rounds)
// A stage's own question (a fit stop, a refused video, a conflict, a person's comment that needs the owner) is never an
// item: the card's `questions` and the PR's answers to people stay as they are.

export const OUTCOMES = ['answered', 'confirmed', 'kept'];
// What an answer rests on: a code reference at a commit, a page or an earlier ticket's file, the log of a live check or
// an API call made now, or a rule of the host's or the role's (an owner's standing decision written there).
export const EVIDENCE_KINDS = ['code', 'docs', 'live', 'rule'];

const text = (v) => typeof v === 'string' && v.trim() !== '';
const trimmed = (v) => (text(v) ? v.trim() : null);
const oneLine = (s) => String(s ?? '').replace(/\s*\n+\s*/g, ' ').trim();

// ------------------------------------------------------------------ what the write leaves for the PR

// The `write` record's `open`: { questions: [{ text, reader, why, proposal, place, sources }], places: [{ repo,
// branch, page, line, claim, why, source, refs }] }, what the write leaves for the PR (each place with its PR's branch
// when the ticket has more than one). A malformed one is a usage error: nothing is posted at the write.
export function checkWriteOpen(open) {
  if (open === undefined || open === null) return null;
  const bad = (m) => {
    throw new CliError(`write: "open" ${m}`, { code: 2 });
  };
  if (typeof open !== 'object' || Array.isArray(open)) bad('is { "questions": [...], "places": [...] }: what the write leaves for the PR');
  for (const k of Object.keys(open)) if (!['questions', 'places'].includes(k)) bad(`has no "${k}" (questions, places)`);
  for (const [i, q] of (open.questions ?? []).entries()) if (!q || !text(q.text)) bad(`question ${i + 1} has no "text"`);
  for (const [i, p] of (open.places ?? []).entries()) if (!p || !text(p.claim) || !text(p.page)) bad(`place ${i + 1} needs its "page" and "claim"`);
  if (open.questions !== undefined && !Array.isArray(open.questions)) bad('questions is a list');
  if (open.places !== undefined && !Array.isArray(open.places)) bad('places is a list');
  return { questions: open.questions ?? [], places: open.places ?? [] };
}

// ------------------------------------------------------------------ the input, frozen before the session

const pick = (x, keys) => Object.fromEntries(keys.filter((k) => x?.[k] !== undefined && x[k] !== null && x[k] !== '').map((k) => [k, x[k]]));

// The items of a ticket's pass, from its ledger and the markers the branches added (`markers`: Map `<repo>:<branch>` ->
// `{ found, error }` as `markersAt` gives them). Returns { items, notes }: a marker check that couldn't run is a note.
export function passInput(l, { markers = new Map() } = {}) {
  const items = [];
  const notes = [];
  const prOf = (repo, branch) => (l.prs ?? []).find((p) => p.repo === repo && (!branch || p.branch === branch)) ?? (l.prs ?? []).find((p) => p.repo === repo) ?? null;
  const open = l.stages?.write?.result?.open ?? {};
  (open.questions ?? []).forEach((q, i) => items.push({ id: `q${i + 1}`, kind: 'question', from: 'write', ...pick(q, ['text', 'reader', 'why', 'proposal', 'place', 'sources', 'refs', 'repo', 'branch', 'page', 'line']), ...(q.id !== undefined ? { ref: String(q.id) } : {}) }));
  (open.places ?? []).forEach((p, i) => {
    const pr = prOf(p.repo, p.branch);
    items.push({ id: `p${i + 1}`, kind: 'place', from: 'write', ...pick(p, ['claim', 'why', 'source', 'refs', 'page', 'line', 'reason']), repo: p.repo ?? pr?.repo ?? null, branch: p.branch ?? pr?.branch ?? null, ...(p.id !== undefined ? { ref: String(p.id) } : {}) });
  });
  let m = 0;
  for (const pr of l.prs ?? []) {
    const got = markers.get(`${pr.repo}:${pr.branch}`);
    if (!got) continue;
    if (got.error) {
      notes.push(`the markers of ${pr.repo} ${pr.branch} were not read (${got.error}): read the branch's diff for them yourself`);
      continue;
    }
    for (const x of got.found ?? []) items.push({ id: `m${++m}`, kind: 'marker', from: 'write', repo: pr.repo, branch: pr.branch, page: x.page, line: x.line, text: `${x.kind}${x.text ? `: ${x.text}` : ''}` });
  }
  (l.stages?.uaReview?.result?.open ?? []).forEach((f, i) => {
    const t = typeof f === 'string' ? f : f?.text;
    if (text(t)) items.push({ id: `f${i + 1}`, kind: 'finding', from: 'uaReview', text: t.trim(), ...(typeof f === 'object' ? pick(f, ['page', 'block']) : {}) });
  });
  return { items, notes };
}

// The items of a PR's pass after a review round: the description questions the round asked, held from the description
// until the pass records (`held`).
export function roundInput(pr) {
  return { items: (pr.questions ?? []).filter((q) => q.held && !q.answer).map((q) => ({ id: `d${q.n}`, kind: 'question', from: q.stage, n: q.n, ...pick(q, ['text', 'reader', 'place', 'why', 'proposal']) })), notes: [] };
}

// The frozen input the record checks against: the ticket's (`l.answerInput`) or the PR's (`pr.answerInput`), kept while
// the pass it was made for has no done record after it.
export const inputOf = (l, pr) => (pr ? pr.answerInput : l.answerInput) ?? null;

// Whether a ticket-level input still stands for the pass to come: made after the last UA review, and no pass done since.
export function inputStands(l) {
  const i = l.answerInput;
  const ua = l.stages?.uaReview;
  const done = l.stages?.answerPass?.status === 'done' ? l.stages.answerPass.seq : 0;
  return Boolean(i && ua && i.after === ua.seq && i.seq > done);
}

// ------------------------------------------------------------------ the record's gate

const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
const blobAt = (dir, commit, file) => {
  try {
    git(dir, ['cat-file', '-e', `${commit}:${String(file).replace(/^\.?\/+/, '')}`]);
    return true;
  } catch {
    return false;
  }
};

// The doc repos' clones by name, the hub first (as lib/runner.mjs `docReposOf` lists them), for a page reference.
export function docDirsOf(settings) {
  const hub = (settings.targets ?? []).find((t) => t.path && path.resolve(settings.root, t.path) === path.resolve(settings.root));
  return [{ repo: hub?.repo ?? path.basename(path.resolve(settings.root)), dir: path.resolve(settings.root) }, ...(settings.docRepos ?? []).map((r) => ({ repo: r.repo, dir: path.resolve(settings.root, r.path) })), ...(settings.targets ?? []).filter((t) => t.path).map((t) => ({ repo: t.repo, dir: path.resolve(settings.root, t.path) }))];
}

// The checks an evidence entry gets against the files, made by default with git on this machine: a code reference's
// commit and path in the runner's clone of its repo (or a doc repo's clone); a page's commit and path in its doc repo;
// an earlier ticket's file in its work folder; a live log under the host root or the state folder.
export function evidenceChecks(settings, { docRepos = [] } = {}) {
  const inside = (abs) => [settings.root, settings.state].some((r) => abs === r || abs.startsWith(r + path.sep));
  const repoDir = (repo) => {
    const clone = codeClonePath(settings, { repo });
    if (fs.existsSync(path.join(clone, 'HEAD'))) return clone;
    const doc = docRepos.find((d) => d.repo === repo);
    return doc && fs.existsSync(doc.dir) ? doc.dir : null;
  };
  return {
    code: (e) => {
      const dir = repoDir(e.repo);
      if (!dir) return `no clone of ${e.repo} on this machine: cite a checkout the brief names`;
      return blobAt(dir, e.commit, e.path) ? null : `${e.repo} has no ${e.path} at ${String(e.commit).slice(0, 12)}`;
    },
    page: (e) => {
      const dir = repoDir(e.repo);
      if (!dir) return `no clone of ${e.repo} on this machine: cite a page the brief lists`;
      return blobAt(dir, e.commit, e.path) ? null : `${e.repo} has no ${e.path} at ${String(e.commit).slice(0, 12)}`;
    },
    ticket: (e) => {
      if (!settings.workFolder) return 'the host has no workFolder: an earlier ticket\'s file is not known';
      const file = path.resolve(settings.root, settings.workFolder.split('<key>').join(String(e.ticket)), String(e.file));
      return fs.existsSync(file) ? null : `ticket ${e.ticket} has no ${e.file}`;
    },
    log: (e) => {
      const file = path.resolve(settings.root, String(e.log));
      if (!inside(file)) return `the log ${e.log} is outside the host repo and the state folder`;
      return fs.existsSync(file) ? null : `the log ${e.log} is not there`;
    },
  };
}

// What one evidence entry lacks, or null.
function evidenceProblem(e, checks, settings) {
  if (!e || !EVIDENCE_KINDS.includes(e.kind)) return `an evidence entry's "kind" is one of ${EVIDENCE_KINDS.join(', ')}`;
  if (e.kind === 'code') {
    const missing = ['repo', 'path', 'lines', 'commit'].filter((k) => !text(String(e[k] ?? '')));
    if (missing.length) return `a code reference has no ${missing.join(', ')}`;
    if (!/^[0-9a-f]{7,40}$/i.test(String(e.commit))) return `a code reference's commit '${e.commit}' is no sha`;
    return checks.code(e);
  }
  if (e.kind === 'docs') {
    if (e.ticket !== undefined && e.ticket !== null) return text(String(e.ticket)) && text(e.file) ? checks.ticket(e) : 'an earlier ticket\'s file names its "ticket" and "file"';
    const missing = ['repo', 'path', 'commit'].filter((k) => !text(String(e[k] ?? '')));
    if (missing.length) return `a page reference has no ${missing.join(', ')} (or an earlier ticket's "ticket" and "file")`;
    return checks.page(e);
  }
  if (e.kind === 'live') {
    if (!text(e.log)) return 'a live check names its "log", the file the check or the call wrote, from the host root';
    if (!text(e.setup)) return 'a live check says its "setup": the test data it made, or why none was needed';
    return checks.log(e);
  }
  // A rule: a key of the host's rules, or the role's own rules (`role`), with the rule's words.
  if (!text(e.ref) || !text(e.text)) return 'a rule names its "ref" (a key of the host\'s rules, or "role") and its "text", the rule\'s words';
  if (e.ref !== 'role' && !Object.keys(settings.hostRules ?? {}).includes(e.ref)) return `the rule '${e.ref}' is neither a key of the host's rules (${Object.keys(settings.hostRules ?? {}).join(', ') || 'none'}) nor "role"`;
  return null;
}

// The page a kept item's `why` must be written in, when it can be read: its PR's worktree at its head.
function pageOf(settings, l, pr, item) {
  if (!text(item.page)) return null;
  const p = pr ?? (l.prs ?? []).find((x) => x.repo === item.repo && (!item.branch || x.branch === item.branch));
  const wt = p ? worktreePath(settings, p) : null;
  if (!wt || !fs.existsSync(wt)) return null;
  try {
    return git(wt, ['show', `HEAD:${item.page}`]);
  } catch {
    try {
      return fs.readFileSync(path.join(wt, item.page), 'utf8');
    } catch {
      return null;
    }
  }
}

// What a pass's record lacks, against its frozen input: every item once, by its id, and no other; each with its outcome
// and what that outcome needs. `checks` are `evidenceChecks` (injectable). Returns a list of problems.
export function passProblems(input, result, { settings, l, pr = null, checks = evidenceChecks(settings) }) {
  const out = [];
  const given = Array.isArray(result?.items) ? result.items : null;
  if (!given) return ['no "items": every item of the pass, by its id, with its outcome'];
  const ids = new Map((input?.items ?? []).map((x) => [x.id, x]));
  const seen = new Set();
  const scripts = new Map();
  for (const r of given) {
    const id = r?.id;
    const item = ids.get(id);
    if (!item) {
      out.push(`item ${id ?? '?'} is not one of this pass's (${[...ids.keys()].join(', ') || 'none'}): a stage's own question, and anything not listed, stays as it is`);
      continue;
    }
    if (seen.has(id)) {
      out.push(`item ${id} is given twice`);
      continue;
    }
    seen.add(id);
    if (!OUTCOMES.includes(r.outcome)) {
      out.push(`item ${id}'s outcome is one of ${OUTCOMES.join(', ')}`);
      continue;
    }
    if (r.outcome === 'answered' || r.outcome === 'confirmed') {
      if (!text(r.answer)) out.push(`item ${id} is ${r.outcome}: give the "answer", in the page's language`);
      const ev = Array.isArray(r.evidence) ? r.evidence : [];
      if (!ev.length) out.push(`item ${id} is ${r.outcome} with no "evidence": a code reference at a commit, a page, an earlier ticket's file, a live check's log, or a rule`);
      for (const e of ev) {
        const p = evidenceProblem(e, checks, settings);
        if (p) out.push(`item ${id}: ${p}`);
      }
      if (r.outcome === 'confirmed' && item.kind !== 'place') out.push(`item ${id} is a ${item.kind}: only a place is confirmed (seen working); a ${item.kind} that is settled is answered`);
      if (r.outcome === 'confirmed' && !ev.some((e) => e?.kind === 'live')) out.push(`item ${id} is confirmed: a place is confirmed only when it was seen working, with that check's log (evidence of kind live)`);
      continue;
    }
    // Kept: on to the owner, with every source tried and why none answered it, in the page's language.
    const sources = Array.isArray(r.sources) ? r.sources : [];
    if (!sources.length) out.push(`item ${id} is kept with no "sources": [{ "kind", "ref", "result" }], every source tried`);
    sources.forEach((s, j) => {
      const missing = ['kind', 'ref', 'result'].filter((k) => !text(s?.[k]));
      if (missing.length) out.push(`item ${id}, source ${j + 1}: no ${missing.join(', ')}`);
    });
    if (!text(r.why)) out.push(`item ${id} is kept: give the "why", why none of its sources answered it`);
    // A place behaviour decides is checked on the test environment first (missing test data is set up, never a reason
    // by itself): a kept place names that check, with the setup it made.
    if (item.kind === 'place' && !sources.some((s) => s?.kind === 'live' && text(s.setup))) out.push(`item ${id} is a place kept: name the live check you ran for it, a source of kind "live" with its "setup" (the test data made, or why the test environment can't reach it)`);
    if (text(r.why) && text(item.page)) {
      const k = `${item.repo}\0${item.branch}\0${item.page}`;
      if (!scripts.has(k)) {
        const page = pageOf(settings, l, pr, item);
        scripts.set(k, page === null ? null : pageScript(page));
      }
      const script = scripts.get(k);
      if (script && !inScript(r.why, script)) out.push(`item ${id}'s why is not in the language of ${item.page} (${script.name} script)`);
    }
  }
  for (const id of ids.keys()) if (!seen.has(id)) out.push(`item ${id} has no outcome: every item of the pass is answered, confirmed or kept`);
  // The page edits: each replaces a marker or a claim with what an answered or confirmed item found.
  const settled = new Set(given.filter((r) => ids.has(r?.id) && ['answered', 'confirmed'].includes(r.outcome)).map((r) => r.id));
  if (result.edits !== undefined && !Array.isArray(result.edits)) out.push('"edits" is a list of { "repo", "branch", "page", "block", "before", "after", "item" }');
  for (const [i, e] of (result.edits ?? []).entries()) {
    const name = `edit ${i + 1}`;
    if (!text(e?.page) || typeof e?.before !== 'string' || typeof e?.after !== 'string') out.push(`${name} needs its "page" and the exact "before" and "after" texts`);
    if (!settled.has(e?.item)) out.push(`${name} names no answered or confirmed item ("item"): the pass edits a page only to put in what it found`);
    if (!pr && !(l.prs ?? []).some((p) => p.repo === e?.repo && (!e.branch || p.branch === e.branch))) out.push(`${name} is on ${e?.repo ?? '?'} ${e?.branch ?? ''}, not a PR of this ticket`);
    if (pr && !(Number.isInteger(Number(e?.n)) && Number(e.n) >= 1)) out.push(`${name} has no "n": a round's edits are numbered on from the number in the brief`);
    if (pr && (e?.commentId === undefined || e?.commentId === null)) out.push(`${name} has no "commentId": each edit of a round's pass gets its line comment in the pass's review`);
  }
  if ((result.edits ?? []).length && !(Array.isArray(result.commits) && result.commits.length) && !(result.prs ?? []).some((p) => (p.commits ?? []).length)) out.push('the edits were pushed in commits: give them (`prs[].commits`, or `commits` on a PR)');
  if (pr && (result.edits ?? []).length && !result.review) out.push('a round\'s pass with edits posts one review with their line comments: give "review": { "id", "commits": [{ "sha", "role": "answers" }] }');
  return out;
}

export const refuse = (problems) => new Refused('answers', `${problems.join('; ')}. Each item of the pass is answered (with its evidence), confirmed (a place seen working, with its log) or kept (with every source tried and why none answered it)`, { problems });

// The settled items of a done pass: Map id -> { item, result }.
export function settledOf(rec) {
  const input = rec?.result?.input?.items ?? [];
  const byId = new Map(input.map((x) => [x.id, x]));
  const out = new Map();
  for (const r of rec?.result?.items ?? []) if (byId.has(r.id)) out.set(r.id, { item: byId.get(r.id), result: r });
  return out;
}

// The ticket's pass done for the PR to come: done after the last UA review, or null.
export function passFor(l) {
  const a = l.stages?.answerPass;
  const ua = l.stages?.uaReview;
  return a?.status === 'done' && (!ua || a.seq > ua.seq) ? a : null;
}

// ------------------------------------------------------------------ the brief

const itemLine = (x) => {
  const where = [x.repo, x.page ? `${x.page}${x.line ? `:${x.line}` : ''}` : null].filter(Boolean).join(' ');
  const what = {
    question: `a question ${x.from === 'write' ? 'the write left' : `a ${x.from} round asked`}${x.reader ? `, for ${x.reader}` : ''}`,
    place: 'a place the write left',
    marker: 'a marker the branch added',
    finding: 'a finding the UA review left open',
  }[x.kind];
  const parts = [`- **${x.id}** (${what}${where ? `, ${where}` : ''}): ${oneLine(x.text ?? x.claim ?? '')}`];
  if (x.place) parts.push(`  - place: ${oneLine(x.place)}`);
  if (x.why) parts.push(`  - why: ${oneLine(x.why)}`);
  if (x.proposal) parts.push(`  - proposal: ${oneLine(x.proposal)}`);
  if (x.source) parts.push(`  - source: ${x.source}`);
  for (const s of x.sources ?? []) parts.push(`  - tried: ${[s.kind, s.ref, s.result].filter(Boolean).map(oneLine).join(' · ')}`);
  for (const r of x.refs ?? []) parts.push(`  - ref: ${[r.repo, r.path, r.lines, r.commit, r.file, r.url].filter(Boolean).join(' ')}`);
  return parts.join('\n');
};

// The lines a pass's brief carries before the common ones: the framing, the items, what it may read and do, and how to
// record. `company` is what the runner resolved (`{ from, notes }`).
export function passLines(step, settings) {
  const items = step.answerItems ?? [];
  const onPr = Boolean(step.pr);
  const live = Object.keys(settings.hostRules ?? {}).length ? "the host's rules (`hostRules`: the live check, the test data, the API calls)" : "the host's rules";
  return [
    `The answer pass${onPr ? ` on ${step.pr}, after a review round asked new questions: they are held from the description until you record` : ', between the UA review and the PR'}. Each item below has an answer in the company's systems. Find it. An item you can't answer stays, with every source you tried.`,
    items.length ? `Items (answer each by its id, and no other; a stage's own question, such as a fit stop, a refused video, a conflict or a person's comment that needs the owner, is not here and stays as it is):\n${items.map(itemLine).join('\n')}` : 'No item was left open: record the stage done with `"items": []`.',
    ...(step.answerNotes ?? []).map((n) => `Note: ${n}.`),
    `Where the answers are: the code repos and the company repos below, each a read-only checkout at the commit the runner fetched (search them all for an item's names: its endpoint, field, status, component, label; the caller's side, a frontend or a widget, often holds what a screen shows); the ticket's commits in each; the host's own docs and the earlier tickets' notes (below: an earlier ticket's live check is what it saw on its date); and the test environment, by ${live}: a behaviour the test environment can reach is checked there, under the browser lock, after the setup those rules allow on the owner's test accounts (missing test data is made, never a reason). A state no screen gives (an action a cabinet hides for that status) is often set through the backend route the screens call (read it in the code), with the test accounts the host's rules name; then read the result the way the page's reader would (the client API, the cabinet). An API call is a Playwright spec run under the browser lock, its log written into the ticket's work folder, never committed with the pages.`,
    "The bar for `answered`: a name, a path or a value read directly (cited with repo, path, lines and commit), a page or an earlier ticket's file that states it, behaviour seen working now (with the check's log), or a rule of the host's or the role's that decides it (a question whose proposal is to leave the page as it is, or that the card's words answer, is decided by the role's question rule: answered, with that rule). Behaviour read from code only stays a place: kept, citing that code. `confirmed` is for a place you saw working: it leaves the places.",
    `Never change a setting several accounts share unless the host's rules allow it by name; never drop or answer a stage's own question; never write to a company repo (the checkouts are read-only). ${onPr ? 'An answer that changes the page: the smallest edit that puts it in (replace the marker or the claim), one commit, pushed, then one review with a line comment under each such edit (`forge.mjs review-on-lines --outside-in-body`), numbered on from the number in the brief.' : "An answer that changes the page: the smallest edit that puts it in (replace the marker or the claim), in the worktree, committed and pushed. The PR stage lists your edits in the description's list of edits after the UA review's fixes, numbered on, so the owner can undo each by number."}`,
    `Record: \`--result '{ "items": [{ "id", "outcome": "answered" | "confirmed" | "kept", "answer", "evidence": [{ "kind": "code", "repo", "path", "lines", "commit", "url" } | { "kind": "docs", "repo", "path", "commit" } | { "kind": "docs", "ticket", "file" } | { "kind": "live", "log", "setup" } | { "kind": "rule", "ref", "text" }], "sources": [{ "kind", "ref", "result", "setup" }], "why" }], "edits": [{ ${onPr ? '"n", "commentId", ' : '"repo", "branch", '}"page", "block", "before", "after", "item" }], ${onPr ? '"commits", "review": { "id", "commits": [{ "sha", "role": "answers" }] }, "posted"' : '"prs": [{ "repo", "branch", "commits" }]'} }'\`. \`answer\` is the answer in the page's language; \`evidence\` every source it rests on; a kept item's \`sources\` every source you tried (a place's live check among them, with its \`setup\`) and its \`why\` in the page's language. \`record\` checks each code reference's commit and path in the runner's clone, each page and earlier ticket's file, each log, each rule's key, and refuses an item with none.`,
  ];
}

// The lines the `pr` brief carries after a ticket's pass: what it settled (not to post), what it kept (to carry on, with
// what it tried), and its page edits for the description's list. Empty when no pass ran.
export function prLinesAfterPass(ledgers, settings) {
  const out = [];
  for (const l of ledgers.filter(Boolean)) {
    const rec = passFor(l);
    if (!rec) continue;
    const settled = [...settledOf(rec).values()];
    const done = settled.filter((s) => s.result.outcome !== 'kept');
    const kept = settled.filter((s) => s.result.outcome === 'kept');
    const edits = rec.result.edits ?? [];
    const title = settings.reviewRounds?.labels?.answerEdits ?? 'Edits from the answers';
    out.push(`The answer pass of ${l.key} settled ${done.length} of ${settled.length} item(s) and kept ${kept.length}. Give each question and place you post the \`item\` it carries (its id below); post none of the settled ones: their answers are in the pages.`);
    for (const s of done) out.push(`- ${s.item.id} ${s.result.outcome}: ${oneLine(s.item.text ?? s.item.claim ?? '')} → ${oneLine(s.result.answer)}`);
    if (kept.length) {
      out.push('Kept, for the description and the places as before, each with what the pass tried (in its `why` and `sources`):');
      for (const s of kept) out.push(`- ${s.item.id} (${s.item.kind}): ${oneLine(s.item.text ?? s.item.claim ?? '')}; why: ${oneLine(s.result.why)}; tried: ${(s.result.sources ?? []).map((x) => `${x.kind} ${x.ref}`).join('; ')}`);
    }
    if (edits.length) {
      out.push(`The pass's page edits go on the description's numbered list of edits after the UA review's fixes, numbered on, under the heading «${title}» (in the description's language), each recorded in that PR's \`edits\` with the same page, before and after:`);
      for (const e of edits) out.push(`- ${e.repo}${e.branch ? ` ${e.branch}` : ''} · \`${e.page}\` · ${e.block ?? ''}: «${oneLine(e.before)}» → «${oneLine(e.after)}» (${e.item})`);
    }
  }
  return out;
}

// What the `pr` record of a ticket whose pass ran must show: each of the pass's edits for an entry's PR in that entry's
// `edits` (by page, before and after), and, with review rounds, no question that repeats a settled item (`item`).
// Returns { problems, warnings, marks: [[pr, edit item]] } for the record to mark the edits it took.
export function prAfterPass(l, entries, { rounds = false } = {}) {
  const rec = passFor(l);
  const out = { problems: [], warnings: [] };
  if (!rec) return out;
  const settled = settledOf(rec);
  const isSettled = (id) => settled.has(id) && settled.get(id).result.outcome !== 'kept';
  for (const e of entries) {
    const p = (l.prs ?? []).find((x) => x.branch === e.branch && (!e.repo || x.repo === e.repo));
    if (!p) continue;
    const mine = (rec.result.edits ?? []).filter((x) => x.repo === p.repo && (!x.branch || x.branch === p.branch));
    const listed = e.edits ?? [];
    const missing = mine.filter((x) => !listed.some((y) => y?.page === x.page && y?.before === x.before && y?.after === x.after));
    if (missing.length) out.problems.push(`${p.repo} ${p.branch}: the description's list of edits lacks the answer pass's edit${missing.length > 1 ? 's' : ''} ${missing.map((x) => `on ${x.page} (${x.item})`).join(', ')}: put each on the list after the UA review's fixes, numbered on, with its exact before and after, and record it in "edits"`);
    for (const q of e.questions ?? []) {
      if (!isSettled(q?.item)) continue;
      const msg = `${p.repo} ${p.branch}: question ${q.n ?? '?'} repeats item ${q.item}, which the answer pass settled`;
      if (rounds) out.problems.push(`${msg}: leave it out (its answer is in the page)`);
      else out.warnings.push(msg);
    }
  }
  return out;
}
