import { na, isNa } from './sources.mjs';

const OID = 12;
const short = (oid) => oid.slice(0, OID);

// The "Open questions" section of a PR description: whether it is there and how many items it lists. A section is
// the heading's text up to the next heading of the same or a higher level; an item is a list line at the margin.
export function openQuestions(body, heading) {
  const lines = String(body).replace(/\r\n/g, '\n').split('\n');
  const want = heading.trim().toLowerCase();
  let level = 0;
  let items = 0;
  let found = false;
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      if (found && h[1].length <= level) break;
      if (!found && h[2].trim().toLowerCase().startsWith(want)) {
        found = true;
        level = h[1].length;
      }
      continue;
    }
    if (found && /^([-*+]|\d+[.)])\s+\S/.test(line)) items++;
  }
  return { section: found, items };
}

const sum = (rows, key) => rows.reduce((n, r) => n + (r.stats?.[key] ?? 0), 0);
const fileCount = (rows) => new Set(rows.flatMap((r) => r.stats?.files ?? [])).size;

function linesOf(rows) {
  const added = sum(rows, 'added');
  const removed = sum(rows, 'removed');
  return { linesAdded: added, linesRemoved: removed, lines: added + removed, files: fileCount(rows) };
}

// All measures of one pull request, from the sources. A measure that cannot be made says so: { na: reason }.
export async function measurePr(pr, ctx) {
  const { s, sources } = ctx;
  const commits = await sources.commits(pr);
  const stats = await sources.stats(commits.map((c) => c.oid));
  const warnings = [];

  const rows = commits.map((c) => {
    const st = stats.get(c.oid) ?? null;
    const merge = st ? st.parents.length > 1 : /^Merge /.test(c.subject);
    const tag = merge ? { role: 'merge', draft: false, ready: false } : sources.classify(pr, c);
    return { ...c, stats: st, ...tag };
  });
  const real = rows.filter((r) => r.role !== 'merge');
  const missing = real.filter((r) => !r.stats);
  if (missing.length) warnings.push(`${missing.length} commit(s) are not in the clone, so their lines are not counted (run with --fetch)`);

  const pipeline = real.filter((r) => r.role === 'pipeline');
  const owner = real.filter((r) => r.role === 'owner');
  const firstPipeline = real.findIndex((r) => r.role === 'pipeline');

  const out = {
    number: pr.number,
    branch: pr.branch,
    title: pr.title,
    state: pr.state,
    createdAt: pr.createdAt,
    mergedAt: pr.mergedAt,
    commits: {
      pipeline: pipeline.length,
      owner: owner.length,
      merge: rows.length - real.length,
      notInClone: missing.length,
      pipelineOids: pipeline.map((r) => short(r.oid)),
      ownerOids: owner.map((r) => short(r.oid)),
    },
  };

  // Markers in the draft: marker lines the draft commits add.
  const drafts = real.filter((r) => r.draft);
  if (!drafts.length) out.draft = na(s.draftPattern ? 'no commit matches the draft pattern' : 'no draft commit pattern declared (Draft commit pattern:)');
  else if (drafts.some((r) => !r.stats)) out.draft = na('a draft commit is not in the clone (run with --fetch)');
  else out.draft = { commits: drafts.length, markers: sum(drafts, 'markersAdded') };

  // The owner's commits: those that are not the pipeline's own, with their changed lines.
  out.owner = {
    commits: owner.length,
    beforePipeline: firstPipeline === -1 ? 0 : owner.filter((r) => real.indexOf(r) < firstPipeline).length,
    ...linesOf(owner),
  };

  // The card's entry into SME review, and the markers still open in the PR at that moment.
  const sme = await sources.smeEntry(pr);
  out.smeReview = sme;
  if (isNa(sme)) out.markersAtSmeReview = sme;
  else {
    const upTo = real.filter((r) => r.date && Date.parse(r.date) <= Date.parse(sme.at));
    out.markersAtSmeReview = upTo.some((r) => !r.stats)
      ? na('a commit before the entry is not in the clone (run with --fetch)')
      : Math.max(0, sum(upTo, 'markersAdded') - sum(upTo, 'markersRemoved'));
  }

  out.openQuestions = openQuestions(pr.body, s.questionsHeading);

  // The owner's final edit: the owner's commits after the last ready-for-merge commit, up to the merge (or the head).
  const readyAt = real.map((r) => r.ready).lastIndexOf(true);
  if (!s.readyPattern && !real.some((r) => r.ready)) out.finalEdit = na('no ready-for-merge marker is defined (Ready commit pattern:)');
  else if (readyAt === -1) out.finalEdit = na('no commit marks the PR ready for merge');
  else {
    const after = real.slice(readyAt + 1).filter((r) => r.role === 'owner');
    out.finalEdit = after.some((r) => !r.stats)
      ? na('a commit after the ready commit is not in the clone (run with --fetch)')
      : { readyCommit: short(real[readyAt].oid), until: pr.state === 'merged' ? 'merge' : 'head', commits: after.length, ...linesOf(after), oids: after.map((r) => short(r.oid)) };
  }

  // Review of the developer and API docs (D-052): only where the host's policy is places.
  if (s.reviewPolicy === 'sme') out.review = na('the review policy is sme: the host reviews by SME, not by places');
  else out.review = { hadReviewer: pr.reviewRequests + pr.reviewsByOthers > 0, requested: pr.reviewRequests, reviewed: pr.reviewsByOthers };
  out.places = await sources.places(pr);

  out.cost = await sources.runs(pr);
  if (warnings.length) out.warnings = warnings;
  return out;
}

// One number per measure across the pull requests. A measure no pull request could make is n/a with the reason of
// the first; one that some could make says how many it covers.
function covered(prs, pick, build) {
  const values = prs.map(pick);
  const made = values.filter((v) => !isNa(v));
  if (!made.length) return values.length ? values.find(isNa) : na('no pull request in the window');
  return { measured: made.length, of: prs.length, ...build(made) };
}

export function summarize(prs) {
  const count = (f) => prs.filter(f).length;
  const total = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
  return {
    prs: { total: prs.length, merged: count((p) => p.state === 'merged'), open: count((p) => p.state === 'open'), closed: count((p) => p.state === 'closed') },
    commits: { pipeline: total(prs, (p) => p.commits.pipeline), owner: total(prs, (p) => p.commits.owner), merge: total(prs, (p) => p.commits.merge) },
    draft: covered(prs, (p) => p.draft, (d) => ({ draftsWithMarkers: d.filter((x) => x.markers > 0).length, markers: total(d, (x) => x.markers), most: Math.max(...d.map((x) => x.markers)) })),
    owner: { commits: total(prs, (p) => p.owner.commits), linesAdded: total(prs, (p) => p.owner.linesAdded), linesRemoved: total(prs, (p) => p.owner.linesRemoved), lines: total(prs, (p) => p.owner.lines), prsWithOwnerCommits: count((p) => p.owner.commits > 0) },
    smeReview: covered(prs, (p) => p.smeReview, (d) => ({ enteredWithMarkers: prs.filter((p) => typeof p.markersAtSmeReview === 'number' && p.markersAtSmeReview > 0).length, markersAtEntry: total(prs, (p) => (typeof p.markersAtSmeReview === 'number' ? p.markersAtSmeReview : 0)), cardsEntered: d.length })),
    openQuestions: { prsWithSection: count((p) => p.openQuestions.section), items: total(prs, (p) => p.openQuestions.items) },
    finalEdit: covered(prs, (p) => p.finalEdit, (d) => ({ commits: total(d, (x) => x.commits), lines: total(d, (x) => x.lines) })),
    review: covered(prs, (p) => p.review, (d) => ({ withReviewer: d.filter((x) => x.hadReviewer).length })),
    places: covered(prs, (p) => p.places, (d) => ({ listed: total(d, (x) => x.listed), passedToReviewer: total(d, (x) => x.passedToReviewer), corrected: total(d, (x) => x.corrected) })),
    cost: covered(prs, (p) => p.cost, (d) => ({ cost: total(d, (x) => x.total.cost), inputTokens: total(d, (x) => x.total.inputTokens), outputTokens: total(d, (x) => x.total.outputTokens) })),
  };
}
