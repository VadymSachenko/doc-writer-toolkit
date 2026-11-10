// The vocabulary of the ticket flow: the stages a record names, who runs each, the TW final review chain, the PR stages
// in the order a card follows them, and the order a scheduled run finishes work in. The stages' own work is done by
// the role sessions and by the host's skills; this file only names them.

// Ticket-level stages (before or around the PRs).
export const TICKET_STAGES = ['triage', 'start', 'plan', 'questions', 'planGate', 'planApproval', 'videoGate', 'videoTry', 'videoBlock', 'videoExtract', 'videoImport', 'answers', 'write', 'uaReview', 'pr', 'follow', 'close'];

// The translation chain of one PR, in order. It runs only at the PR stage `translation`: a person moved the card there.
export const CHAIN = ['translate', 'enReview', 'locales', 'align', 'labelSync', 'build', 'visualPack'];

// PR-level stages: a record names the PR with --pr.
// `untranslated` and `idSync` are the runner's own, with the translated label only (`forge.translatedLabel`).
// `baseMerge` and `baseFix` keep a PR up to date with its base (`forge.keepFresh`): the runner's merge of the base into
// the branch, and the session that resolves a merge that conflicted.
export const PR_STAGES = ['move', 'follow', 'answerComments', 'styleCheck', 'questions', 'answers', ...CHAIN, 'readyForMerge', 'resync', 'untranslated', 'idSync', 'baseMerge', 'baseFix'];

export const STATUSES = ['running', 'done', 'failed'];

// Who runs a stage: a role (one `claude -p` session) or null (the runner itself, with no model). The chain's `build` is
// the runner's: the host's build command in the PR's worktree, under the build lock (lib/build-lock.mjs). So is the
// video's `videoExtract`: the frame sweep with every part's transcript, before the import's session.
export const ROLE_OF = {
  triage: 'triage',
  start: 'writer',
  plan: 'writer',
  questions: 'writer',
  planGate: 'writer',
  planApproval: null,
  videoGate: 'writer',
  videoTry: null,
  videoBlock: null,
  videoExtract: null,
  videoImport: 'writer',
  answers: 'writer',
  write: 'writer',
  uaReview: 'reviewer',
  pr: 'writer',
  follow: null,
  close: null,
  move: null,
  answerComments: 'writer',
  styleCheck: 'writer',
  translate: 'translator',
  enReview: 'reviewer',
  locales: 'translator',
  align: 'translator',
  labelSync: 'translator',
  build: null,
  visualPack: 'reviewer',
  readyForMerge: null,
  resync: 'translator',
  untranslated: null,
  idSync: null,
  // The runner's own, like the build: `git merge` of the base in the PR's worktree, and the push.
  baseMerge: null,
  // The writer, or the translator when every conflicting file is outside the UA roots (lib/rule.mjs).
  baseFix: 'writer',
};

// The stage of one PR, least advanced first. The card stands in the status of its least advanced PR.
// `finalReview` is the owner's read of the UA, and starts nothing; `translation` runs the chain.
export const PR_ORDER = ['questions', 'writing', 'reworkWait', 'smeReview', 'finalReview', 'translation', 'readyForMerge', 'merged'];
export const CARD_STATUS_OF = {
  questions: 'blocked',
  writing: 'inProgress',
  reworkWait: 'inProgress',
  smeReview: 'smeReview',
  finalReview: 'finalReview',
  translation: 'translation',
  readyForMerge: 'finalReview',
  merged: 'done',
};
// The stage label a PR carries at each stage (a target's `labels` key), or null to leave it. `translation` here is the
// fallback for a target with no translation label; `stageLabelOf` is what the runner and the records use.
export const LABEL_OF = { writing: 'inProgress', reworkWait: 'inProgress', smeReview: 'review', finalReview: 'finalReview', translation: 'finalReview', readyForMerge: 'finalReview' };
// The `labels` key a PR at this stage carries on a target: `translation` when the target names a label for it (the PR
// is in the chain), else the final review's, as before the translation label existed. Null: leave the label.
export const stageLabelOf = (stage, target) => (stage === 'translation' && target?.labels?.translation ? 'translation' : LABEL_OF[stage] ?? null);

// Where a person's move of the card puts the PRs at the card's stage.
export const PR_STAGE_OF_STATUS = { inProgress: 'reworkWait', smeReview: 'smeReview', finalReview: 'finalReview', translation: 'translation' };

// Whether a PR at this stage follows a person's move of the card. The PRs at the card's stage do. A move to `translation`
// approves the whole ticket from wherever the card stood, so every PR below ready for merge goes (one card can't approve
// half a ticket: a PR left behind would pull the card back while the other's chain runs); a ready or merged one stays.
const below = (stage, of) => PR_ORDER.includes(stage) && PR_ORDER.indexOf(stage) < PR_ORDER.indexOf(of);
export const followsMove = (stage, from, to) => Boolean(PR_STAGE_OF_STATUS[to]) && (to === 'translation' ? below(stage, 'readyForMerge') : CARD_STATUS_OF[stage] === from);

// A person's forward move of the card (D-128): one that takes the card past the final review status, to In translation or
// done. The owner's check is done, so the check label comes off. A move into the final review (from In progress, from the
// expert's review, or the expert's Approve) keeps it: the owner's check only begins there; so do moves between In
// progress and the expert's review, and every move back.
export const forwardMove = (from, to) => from !== to && (to === 'translation' || to === 'done');

// Ticket states and what they count as (design §1, §7).
export const IN_PROGRESS = ['planning', 'writing'];
export const WAITING = ['questions', 'planGate', 'videoGate', 'ownerBlock', 'reworkWait'];

// The order a scheduled run finishes work in: merged first, writing last (design §7). Lower runs first.
export function finishRank(step) {
  if (step.stage === 'close') return 0;
  if (['readyForMerge', 'resync', 'untranslated', 'idSync', 'baseMerge', 'baseFix'].includes(step.stage)) return 1;
  if (CHAIN.includes(step.stage) || (['move', 'follow'].includes(step.stage) && ['finalReview', 'translation'].includes(step.to))) return 2;
  if (step.stage === 'answerComments' || step.stage === 'styleCheck' || (step.stage === 'move' && step.to === 'smeReview') || step.stage === 'follow' || step.stage === 'move') return 3;
  if (['answers', 'planApproval', 'videoImport', 'videoTry', 'videoBlock', 'videoExtract'].includes(step.stage)) return 4;
  return 5;
}

export const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
