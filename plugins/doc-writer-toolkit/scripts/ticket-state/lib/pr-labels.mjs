import { prId, readLedger } from './ledger.mjs';

// Three labels the runner keeps on a PR from its ledger, after each step it runs, a session's or its own (no model, and
// never a role: lib/role-hook.mjs denies the label commands):
//   - `forge.readyLabel`, the pipeline's recommendation to merge: put on when the PR is marked ready for merge (the
//     `readyForMerge` record), taken off when it leaves ready for merge (sent back to the owner's queue, taken into the
//     chain again by a person's move, a question on it, the card moved back). The owner's own merge label is never
//     touched: the settings don't name it.
//   - `forge.checkLabel`, after each `answerComments`, `styleCheck` and PR `answerPass` record, from the PR's open questions to the owner
//     (`openQuestions`, lib/record.mjs): any, the label is on, put back if the owner took it off; none, it comes off.
//     Between two such records it stays as a person left it. A person's forward move takes it off (`follow`, D-128).
//     The first record of a PR with none kept only puts it on, never takes it off (a PR from before the switch).
//   - `forge.translatedLabel`, whether the PR's translations match its UA, next to the stage label: put on when the
//     translations are made for the PR's head (a `readyForMerge` or `resync` record, `pr.translated`), taken off when
//     the rule sees UA change in words since that head, at any stage (the `untranslated` step clears it). A card's
//     move, an EN-only commit, an id-only change, the runner's own id commits and an image change leave it.
// A label follows a change of the ledger: one the forge refuses is a warning and is not retried; the next change of
// that PR sets it again.
// A label the forge refuses after the record stood is a warning: the step stays done.

// Each PR of the tickets as it stands in each ledger (a PR with two cards is in two, each with its own record
// numbers): its stage, how often it was marked ready, which record last set its open questions, and which record
// last said its translations match.
const slot = (key, p) => `${key}|${prId(p)}`;
export function labelSnapshot(state, keys) {
  const out = new Map();
  for (const key of keys) {
    for (const p of readLedger(state, key)?.prs ?? []) if (p.number) out.set(slot(key, p), { stage: p.stage, ready: p.readyForMerge?.length ?? 0, asked: p.openQuestions?.seq ?? null, translated: p.translated?.seq ?? null });
  }
  return out;
}

// The label changes the ledgers ask for since `before`, each ledger against its own snapshot: `[{ repo, number,
// label, add }]`, one per PR and label. Two ledgers of one PR that disagree: on wins (a question open in either).
export function labelChanges(before, state, keys, forge) {
  const out = new Map();
  for (const key of keys) {
    for (const p of readLedger(state, key)?.prs ?? []) {
      if (!p.number || p.merged || p.stage === 'merged') continue;
      const was = before.get(slot(key, p)) ?? { stage: null, ready: 0, asked: null, translated: null };
      const change = (label, add) => {
        const k = `${prId(p)}|${label}`;
        out.set(k, { repo: p.repo, number: p.number, label, add: add || Boolean(out.get(k)?.add) });
      };
      if (forge.readyLabel) {
        if (p.stage === 'readyForMerge' && (was.stage !== 'readyForMerge' || (p.readyForMerge?.length ?? 0) > was.ready)) change(forge.readyLabel, true);
        else if (was.stage === 'readyForMerge' && p.stage !== 'readyForMerge') change(forge.readyLabel, false);
      }
      // The first such record of a PR with no open questions kept (one from before the questions were recorded, or
      // after a forward move cleared them) only puts the label on: the questions of earlier summaries are not known,
      // so a label already there stays.
      const open = p.openQuestions?.items?.length > 0;
      // Each record that says the translations match puts it on (a new head too); the `untranslated` record takes it off.
      if (forge.translatedLabel) {
        const now = p.translated?.seq ?? null;
        if (now !== null && now !== was.translated) change(forge.translatedLabel, true);
        else if (now === null && (was.translated ?? null) !== null) change(forge.translatedLabel, false);
      }
      // A round's new questions wait for the answer pass (`answerPassDue`): the label waits with them, and the pass's
      // record sets it from what it left open.
      if (forge.checkLabel && !p.answerPassDue && p.openQuestions && p.openQuestions.seq !== was.asked && ['answerComments', 'styleCheck', 'answerPass'].includes(p.openQuestions.stage) && (open || was.asked !== null)) change(forge.checkLabel, open);
    }
  }
  return [...out.values()];
}

// Sets them on the forge. Returns the warnings.
export async function followLabels({ settings, clients, keys, before }) {
  const warnings = [];
  for (const c of labelChanges(before, settings.state, keys, settings.forge)) {
    try {
      const args = { repo: c.repo, number: c.number, label: c.label };
      await (c.add ? clients.forge.addLabel(args) : clients.forge.removeLabel(args));
    } catch (err) {
      warnings.push(`${c.repo}#${c.number}: the label '${c.label}' was not ${c.add ? 'added' : 'removed'}: ${err.message}`);
    }
  }
  return warnings;
}
