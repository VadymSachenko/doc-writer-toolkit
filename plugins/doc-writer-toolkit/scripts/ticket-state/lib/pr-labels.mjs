import { prId, readLedger } from './ledger.mjs';

// Two labels the runner keeps on a PR from its ledger, after each step it runs, a session's or its own (no model, and
// never a role: lib/role-hook.mjs denies the label commands):
//   - `forge.readyLabel`, the pipeline's recommendation to merge: put on when the PR is marked ready for merge (the
//     `readyForMerge` record), taken off when it leaves ready for merge (sent back to the owner's queue, taken into the
//     chain again by a person's move, a question on it, the card moved back). The owner's own merge label is never
//     touched: the settings don't name it.
//   - `forge.checkLabel`, after each `answerComments` and `styleCheck` record, from the PR's open questions to the owner
//     (`openQuestions`, lib/record.mjs): any, the label is on, put back if the owner took it off; none, it comes off.
//     Between two such records it stays as a person left it. A person's forward move takes it off (`follow`, D-128).
// A label the forge refuses after the record stood is a warning: the step stays done.

// Each PR of the tickets as it stands in each ledger (a PR with two cards is in two, each with its own record
// numbers): its stage, how often it was marked ready, and which record last set its open questions.
const slot = (key, p) => `${key}|${prId(p)}`;
export function labelSnapshot(state, keys) {
  const out = new Map();
  for (const key of keys) {
    for (const p of readLedger(state, key)?.prs ?? []) if (p.number) out.set(slot(key, p), { stage: p.stage, ready: p.readyForMerge?.length ?? 0, asked: p.openQuestions?.seq ?? null });
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
      const was = before.get(slot(key, p)) ?? { stage: null, ready: 0, asked: null };
      const change = (label, add) => {
        const k = `${prId(p)}|${label}`;
        out.set(k, { repo: p.repo, number: p.number, label, add: add || Boolean(out.get(k)?.add) });
      };
      if (forge.readyLabel) {
        if (p.stage === 'readyForMerge' && (was.stage !== 'readyForMerge' || (p.readyForMerge?.length ?? 0) > was.ready)) change(forge.readyLabel, true);
        else if (was.stage === 'readyForMerge' && p.stage !== 'readyForMerge') change(forge.readyLabel, false);
      }
      if (forge.checkLabel && p.openQuestions && p.openQuestions.seq !== was.asked && ['answerComments', 'styleCheck'].includes(p.openQuestions.stage)) change(forge.checkLabel, p.openQuestions.items.length > 0);
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
