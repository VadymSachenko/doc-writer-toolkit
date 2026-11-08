import { padTable } from '../../ui-labels/lib/util.mjs';
import { isNa } from './sources.mjs';

const NA = 'n/a';
const cell = (v, pick) => (isNa(v) ? NA : pick(v));

// The per-PR table and the totals, as text. A measure that could not be made shows n/a, and its reason is listed once
// under the table.
export function renderTable(result) {
  const { range, prs, summary } = result;
  const head = ['PR', 'state', 'pipeline', 'owner', 'owner lines', 'draft markers', 'markers at SME', 'open Q', 'final edit', 'reviewer'];
  const rows = [head];
  for (const p of prs) {
    rows.push([
      `#${p.number}`,
      p.state,
      p.commits.pipeline,
      p.commits.owner,
      p.owner.lines,
      cell(p.draft, (d) => d.markers),
      isNa(p.markersAtSmeReview) ? NA : p.markersAtSmeReview,
      p.openQuestions.section ? p.openQuestions.items : 0,
      cell(p.finalEdit, (f) => f.lines),
      cell(p.review, (r) => (r.hadReviewer ? 'yes' : 'no')),
    ]);
  }
  const out = [];
  out.push(`Pipeline measures, ${range.from} to ${range.to}: ${summary.prs.total} PRs (${summary.prs.merged} merged, ${summary.prs.open} open, ${summary.prs.closed} closed)`);
  out.push('');
  out.push(padTable(rows));
  out.push('');
  out.push('Totals');
  const t = [];
  t.push(`commits: ${summary.commits.pipeline} pipeline, ${summary.commits.owner} owner, ${summary.commits.merge} merge (merges not counted above)`);
  t.push(`owner edits: ${summary.owner.commits} commits in ${summary.owner.prsWithOwnerCommits} PRs, ${summary.owner.lines} changed lines (+${summary.owner.linesAdded} -${summary.owner.linesRemoved})`);
  t.push(isNa(summary.draft) ? `draft markers: ${NA}` : `draft markers: ${summary.draft.markers} in ${summary.draft.draftsWithMarkers} of ${summary.draft.measured} drafts (most in one: ${summary.draft.most})`);
  t.push(isNa(summary.smeReview) ? `SME review: ${NA}` : `SME review: ${summary.smeReview.measured} of ${summary.smeReview.of} PRs reached it; ${summary.smeReview.enteredWithMarkers} with markers still open (${summary.smeReview.markersAtEntry} in all)`);
  t.push(`open questions: ${summary.openQuestions.prsWithSection} of ${summary.prs.total} PRs have the section, ${summary.openQuestions.items} items`);
  t.push(isNa(summary.finalEdit) ? `final edit: ${NA}` : `final edit: ${summary.finalEdit.measured} of ${summary.finalEdit.of} PRs, ${summary.finalEdit.lines} changed lines in ${summary.finalEdit.commits} commits`);
  t.push(isNa(summary.review) ? `reviewer: ${NA}` : `reviewer: ${summary.review.withReviewer} of ${summary.review.measured} PRs had one`);
  t.push(isNa(summary.places) ? `places: ${NA}` : `places: ${summary.places.listed} listed, ${summary.places.passedToReviewer} passed on, ${summary.places.corrected} corrected`);
  t.push(isNa(summary.cost) ? `cost: ${NA}` : `cost: $${summary.cost.cost.toFixed(2)} over ${summary.cost.measured} PRs`);
  out.push(...t.map((l) => `  ${l}`));

  // Each reason once, for every n/a in the summary and in the table's columns.
  const reasons = new Map();
  const note = (name, v) => {
    if (isNa(v)) reasons.set(`${name}: ${v.na}`, true);
  };
  for (const [name, v] of Object.entries(summary)) note(name, v);
  for (const p of prs) for (const k of ['draft', 'markersAtSmeReview', 'finalEdit', 'review', 'places', 'cost']) note(k, p[k]);
  if (reasons.size) {
    out.push('');
    out.push('n/a');
    out.push(...[...reasons.keys()].map((r) => `  ${r}`));
  }
  if (result.warnings.length) {
    out.push('');
    out.push('Warnings');
    out.push(...result.warnings.map((w) => `  ${w}`));
  }
  return out.join('\n');
}
