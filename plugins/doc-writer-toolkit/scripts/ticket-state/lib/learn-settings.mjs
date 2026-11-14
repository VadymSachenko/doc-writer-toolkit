import { CliError } from './errors.mjs';

// The `learning` settings of the ticket flow (TASK-054, lib/learn.mjs), and the default words of the texts the learning
// posts. The words are English; the host gives its team's in `learning.labels`.

export const LEARN_LABELS = {
  title: "Rules from the owner's edits, <week>",
  commit: "Rules from the owner's edits",
  answerCommit: "Rules from the owner's edits: the reply by number",
  trend: "The owner's edits per PR: <now> last week (<prs> PRs), <before> a week on average in the <weeks> weeks before.",
  trendFirst: "The owner's edits per PR: <now> last week (<prs> PRs); no earlier week to compare.",
  kinds: { product: 'product', general: 'general', exception: 'exception to a general rule' },
  why: 'Why',
  example: 'was → now',
  overrides: 'overrides',
  description: "Rules drawn from the owner's edits that repeat on at least two PRs, each with its reason and examples. Merging the PR adds them to the product rules. A reply by number changes or drops a rule before the merge.",
  removedOnly: "The general rules below are in the shared rules now: their copies in the product rules are removed.",
  changes: 'List of changes',
  added: 'added rules <list>',
  removed: 'removed the copies of rules now in the shared rules: <list>',
  taskLink: 'Task link',
  noTask: 'No card: a weekly proposal.',
  questions: 'Open questions',
  reader: 'For the writer',
  none: 'None.',
  how: 'Reply by number in one comment: «N — yes», «N — no», «N — "the rule\'s new text"», «N — how to reword it», «N — general», «N — product» or «N — exception to a general rule». The merge accepts what is left.',
  replyTitle: 'Done by number:',
  done: { keep: 'kept', reject: 'removed, not proposed again', verbatim: 'reworded', rewrite: 'reworded', kind: 'kind changed', ask: 'not changed' },
  rejectedMark: 'removed',
};

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const fail = (m) => {
  throw new CliError(`ticket flow settings: ${m}`, { code: 2 });
};

// `learning` in the shared file (it names a clone the runner pushes from, so never the local file). Absent: no log,
// no weekly session, nothing.
export function validateLearning(raw) {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) fail('learning must be an object');
  const known = ['since', 'authors', 'branch', 'section', 'labels', 'toolkit', 'names', 'horizonWeeks'];
  for (const k of Object.keys(raw)) if (!known.includes(k)) fail(`learning.${k} is not a setting (${known.join(', ')})`);
  // `since` is required: the collector never reads the whole history silently.
  const since = raw.since ?? null;
  if (!isIso(since)) fail('learning.since is required: an ISO date-time with its zone, such as 2026-11-09T00:00:00+02:00 (the merged PRs the log covers)');
  // `authors`: the owner's git identities (author emails or names): a commit by anyone else (an expert's push) is not the
  // owner's taste.
  const authors = raw.authors;
  if (!Array.isArray(authors) || !authors.length || authors.some((a) => typeof a !== 'string' || !a.trim())) fail("learning.authors is required: the owner's git author emails or names, such as [\"owner@example.com\"]");
  const branch = raw.branch ?? 'rules-from-edits-<week>';
  if (typeof branch !== 'string' || !branch.includes('<week>') || !/^[A-Za-z0-9._/<>-]+$/.test(branch)) fail('learning.branch must be a branch name with <week> in it');
  const section = raw.section ?? '## Other rules';
  if (typeof section !== 'string' || !/^#{2,4} \S/.test(section)) fail('learning.section must be a heading line, such as "## Other rules"');
  const labels = raw.labels ?? {};
  if (!isObject(labels)) fail('learning.labels must be an object');
  for (const [k, v] of Object.entries(labels)) {
    if (!(k in LEARN_LABELS)) fail(`learning.labels.${k} is not a label`);
    if (isObject(LEARN_LABELS[k]) ? !isObject(v) || Object.entries(v).some(([kk, vv]) => !(kk in LEARN_LABELS[k]) || typeof vv !== 'string') : typeof v !== 'string' || !v.trim()) fail(`learning.labels.${k} has the wrong shape`);
  }
  let toolkit = null;
  if (raw.toolkit !== undefined && raw.toolkit !== null) {
    const t = raw.toolkit;
    if (!isObject(t) || typeof t.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(t.repo) || typeof t.path !== 'string' || !t.path.trim()) fail('learning.toolkit needs "repo" (owner/name) and "path" (its clone, from the host root), and "base"');
    toolkit = { repo: t.repo, path: t.path, base: typeof t.base === 'string' && t.base.trim() ? t.base : 'main' };
  }
  const names = raw.names ?? [];
  if (!Array.isArray(names) || names.some((n) => typeof n !== 'string' || !n.trim())) fail('learning.names must be a list of names');
  // The settings can't know the product's and the company's names: with a toolkit to write to, the host gives them.
  if (toolkit && !names.length) fail("learning.names is required with learning.toolkit: the product's and the company's names, which never go into the toolkit");
  const horizonWeeks = raw.horizonWeeks ?? 12;
  if (!Number.isInteger(horizonWeeks) || horizonWeeks < 1) fail('learning.horizonWeeks must be a whole number of weeks');
  const merged = { ...LEARN_LABELS, ...labels, kinds: { ...LEARN_LABELS.kinds, ...(labels.kinds ?? {}) }, done: { ...LEARN_LABELS.done, ...(labels.done ?? {}) } };
  return { since, authors: authors.map((a) => a.trim()), branch, section, labels: merged, toolkit, names, horizonWeeks };
}

export const isIso = (s) => typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(s) && !Number.isNaN(Date.parse(s));
