import crypto from 'node:crypto';

// The live description of a pipeline PR (D-142): three sections the runner writes from the ledger after each round,
// with no model, between markers the host's PR template puts in the description:
//
//   <!-- ticket-flow:questions -->  …  <!-- /ticket-flow:questions -->   the open questions, by reader; the answered
//                                                                        ones folded under "resolved", struck through
//   <!-- ticket-flow:places -->     …  <!-- /ticket-flow:places -->      each place to check and its state
//   <!-- ticket-flow:rounds -->     …  <!-- /ticket-flow:rounds -->      each round, its commits and its review
//
// The rest of the description, what a person wrote among it, is never touched. The opening marker keeps a short hash of
// what the runner wrote (`h=…`): a section whose text no longer matches it was edited by a person since, and is left as
// it is, with a warning. A section whose markers aren't there (a PR from before the template had them) is left out. The
// words around the ledger's texts are the host's (`forge.reviewRounds.labels`), in the team's language; the defaults are
// English.

export const SECTIONS = ['questions', 'places', 'rounds'];

export const DEFAULT_LABELS = {
  // The heading of each reader's group (the description questions' `reader`); a reader not named here is shown as is.
  readers: {},
  resolved: 'Resolved',
  none: 'None.',
  place: 'Place',
  why: 'Why a question',
  proposal: 'Proposal',
  answer: 'answer',
  placeOpen: 'open thread',
  placeConfirmed: 'confirmed',
  placeDeleted: 'block deleted',
  threadClosed: 'thread closed',
  thread: 'thread',
  rounds: 'Rounds',
  review: 'review',
  lineComments: 'line comments',
  stages: { pr: 'first version', answerComments: 'comments', styleCheck: 'hand commit', enReview: 'EN review' },
};

const norm = (s) => String(s ?? '').replace(/\r\n?/g, '\n').trim();
export const sectionHash = (text) => crypto.createHash('sha1').update(norm(text)).digest('hex').slice(0, 8);
const oneLine = (s) => String(s ?? '').replace(/\s*\n+\s*/g, ' ').trim();
const SHA = /^[0-9a-f]{7,40}$/i;
const short = (sha) => String(sha).slice(0, 7);
const base = (url) => String(url ?? '').replace(/\/+$/, '');

// A link to an answer: a commit's sha as text (the forge links it in the description), a URL as a link.
function answerLink(link, labels) {
  if (!link) return '';
  if (SHA.test(String(link))) return ` · ${short(link)}`;
  return ` · [${labels.answer}](${link})`;
}

// The questions of the description (`prs[].questions`): the open ones by reader, each with its number, the answered
// ones folded under "resolved" with the answer in a few words and its link.
export function renderQuestions(questions, labels) {
  const open = (questions ?? []).filter((q) => !q.answer);
  const done = (questions ?? []).filter((q) => q.answer);
  if (!open.length && !done.length) return labels.none;
  const readers = [...new Set([...Object.keys(labels.readers ?? {}).filter((r) => open.some((q) => q.reader === r)), ...open.map((q) => q.reader ?? '')])];
  const out = [];
  for (const r of readers) {
    const list = open.filter((q) => (q.reader ?? '') === r);
    const items = list.map((q) => [
      `**${q.n}.** ${oneLine(q.text)}`,
      ...(q.place ? [`- **${labels.place}:** ${oneLine(q.place)}`] : []),
      ...(q.why ? [`- **${labels.why}:** ${oneLine(q.why)}`] : []),
      ...(q.proposal ? [`- **${labels.proposal}:** ${oneLine(q.proposal)}`] : []),
    ].join('\n'));
    out.push(`<details open>\n<summary>${labels.readers?.[r] ?? r} (${list.length})</summary>\n\n${items.join('\n\n')}\n\n</details>`);
  }
  if (!open.length) out.push(labels.none);
  if (done.length) {
    const items = done.map((q) => `**${q.n}.** ~~${oneLine(q.text)}~~ ${oneLine(q.answer.text)}${answerLink(q.answer.link, labels)}`);
    out.push(`<details>\n<summary>${labels.resolved} (${done.length})</summary>\n\n${items.join('\n\n')}\n\n</details>`);
  }
  return out.join('\n\n');
}

// Each place of the PR and its state: open, with a link to its thread; confirmed; or its block deleted, the thread
// settled by the pipeline.
export function renderPlaces(places, labels, prUrl) {
  if (!places?.length) return labels.none;
  const link = (p) => (p.commentId && prUrl ? `${base(prUrl)}#discussion_r${p.commentId}` : null);
  return places
    .map((p) => {
      const what = oneLine(p.claim ?? p.page ?? '');
      const url = link(p);
      const state = p.state === 'confirmed' ? `${labels.placeConfirmed}${url ? ` · [${labels.thread}](${url})` : ''}` : p.state === 'deleted' ? `${labels.placeDeleted} · ${labels.threadClosed}` : url ? `[${labels.placeOpen} ↗](${url})` : labels.placeOpen;
      return `- **${p.id}** ${what} — ${state}`;
    })
    .join('\n');
}

// Each round: its number, what it was, its commits and its review.
export function renderRounds(rounds, labels, prUrl) {
  if (!rounds?.length) return labels.none;
  const lines = rounds.map((r) => {
    const parts = [String(r.n), labels.stages?.[r.stage] ?? r.stage];
    if (r.comments) parts.push(`${labels.lineComments}: ${r.comments}`);
    if (r.commits?.length) parts.push(r.commits.map((c) => short(c.sha)).join(', '));
    if (r.review && prUrl) parts.push(`[${labels.review}](${base(prUrl)}#pullrequestreview-${r.review})`);
    return `- ${parts.join(' · ')}`;
  });
  return `<details>\n<summary>${labels.rounds} (${rounds.length})</summary>\n\n${lines.join('\n')}\n\n</details>`;
}

// The three sections of one PR, from its ledger.
export function renderSections(ledger, pr, labels) {
  const places = (ledger.places ?? []).filter((p) => p.repo === pr.repo && Number(p.pr) === Number(pr.number));
  return {
    questions: renderQuestions(pr.questions ?? [], labels),
    places: renderPlaces(places, labels, pr.url),
    rounds: renderRounds(pr.rounds ?? [], labels, pr.url),
  };
}

const OPEN = (name) => new RegExp(`<!--\\s*ticket-flow:${name}(?:\\s+h=([0-9a-f]{8}))?\\s*-->`);
const CLOSE = (name) => new RegExp(`<!--\\s*/ticket-flow:${name}\\s*-->`);

// The description with each section between its markers replaced by `sections[name]`. A section a person edited since
// the runner last wrote it (its text no longer matches the marker's hash) is kept, and named in `kept`; one with no
// markers is named in `missing`. Everything outside the markers stays byte for byte.
export function rewriteDescription(body, sections) {
  let text = String(body ?? '');
  const kept = [];
  const missing = [];
  for (const name of SECTIONS) {
    if (sections[name] === undefined) continue;
    const open = OPEN(name).exec(text);
    const close = open ? CLOSE(name).exec(text.slice(open.index + open[0].length)) : null;
    if (!open || !close) {
      missing.push(name);
      continue;
    }
    const from = open.index;
    const innerStart = open.index + open[0].length;
    const innerEnd = innerStart + close.index;
    const to = innerEnd + close[0].length;
    const inner = text.slice(innerStart, innerEnd);
    if (open[1] && sectionHash(inner) !== open[1]) {
      kept.push(name);
      continue;
    }
    const fresh = norm(sections[name]);
    text = `${text.slice(0, from)}<!-- ticket-flow:${name} h=${sectionHash(fresh)} -->\n${fresh}\n<!-- /ticket-flow:${name} -->${text.slice(to)}`;
  }
  return { body: text, changed: text !== String(body ?? ''), kept, missing };
}
