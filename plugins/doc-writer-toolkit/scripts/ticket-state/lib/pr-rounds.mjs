import { prId, readLedger } from './ledger.mjs';
import { appendSections, renderSections, rewriteDescription } from './pr-description.mjs';

// What the runner does on a PR after each step, a session's or its own, when the host takes review rounds
// (`forge.reviewRounds`, D-142), with no model and never a role (lib/role-hook.mjs denies the two forge commands):
//   - the description's open questions, places and rounds, rewritten from the ledger between their markers
//     (lib/pr-description.mjs); a section a person edited since is kept, with a warning;
//   - a place the step recorded confirmed, or its block deleted, gets its thread settled (`forge resolve-thread`): the
//     pipeline's own thread only, and its reply saying why is already there (the record requires it);
//   - a new round's review replaces the PR's older summary comments: each is removed once (`forge delete-comment`),
//     only an id in `posted`, the forge checking it is the pipeline's. A submitted review can't be removed and stays.
// Nothing here changes the ledger. What the forge refuses, or a comment the owner already deleted (its 404), is a
// warning: the step stays done, and nothing is posted again. A person's comment or thread is never touched.

const slot = (key, p) => `${key}|${prId(p)}`;

// Each PR of the tickets as the ledgers stand: the ledger's record count, the PR's rounds, its places' states.
export function roundSnapshot(state, keys) {
  const out = new Map();
  for (const key of keys) {
    const l = readLedger(state, key);
    for (const p of l?.prs ?? []) {
      if (!p.number) continue;
      const places = new Map((l.places ?? []).filter((x) => x.repo === p.repo && Number(x.pr) === p.number).map((x) => [x.id, x.state ?? 'open']));
      out.set(slot(key, p), { seq: l.seq, rounds: p.rounds?.length ?? 0, places });
    }
  }
  return out;
}

const gone = (err) => err?.data?.status === 404 || /\b404\b/.test(String(err?.message ?? ''));

export async function followRounds({ settings, clients, keys, before }) {
  if (!settings.reviewRounds) return [];
  const warnings = [];
  const written = new Set();
  for (const key of keys) {
    const l = readLedger(settings.state, key);
    if (!l) continue;
    const own = (l.posted?.pr ?? []).map(String);
    for (const p of l.prs ?? []) {
      if (!p.number || p.merged || p.stage === 'merged') continue;
      const was = before.get(slot(key, p)) ?? { seq: null, rounds: 0, places: new Map() };
      if (was.seq === l.seq) continue;
      const at = { repo: p.repo, number: p.number };
      const say = (text) => warnings.push(`${prId(p)}: ${text}`);

      for (const place of (l.places ?? []).filter((x) => x.repo === p.repo && Number(x.pr) === p.number)) {
        if (!['confirmed', 'deleted'].includes(place.state) || was.places.get(place.id) === place.state || !place.commentId) continue;
        try {
          await clients.forge.resolveThread({ ...at, comment: place.commentId, own });
        } catch (err) {
          say(`the thread of place ${place.id} was not settled: ${gone(err) ? 'its comment is gone' : err.message}`);
        }
      }

      const rounds = p.rounds ?? [];
      const reviewed = (r) => r.review !== null && r.review !== undefined && r.stage !== 'pr';
      const fresh = rounds.slice(was.rounds).filter(reviewed);
      if (fresh.length) {
        // Only what a round superseded after the rounds began: a summary posted before the PR's first round (a PR from
        // before the switch: its numbered lists and open questions) is never removed.
        const began = rounds[0]?.at ?? '';
        const previous = rounds.slice(0, was.rounds).filter(reviewed).at(-1)?.at ?? '';
        const since = previous > began ? previous : began;
        const until = fresh.at(-1).at ?? '';
        const old = (l.summaries ?? []).filter((s) => s.repo === p.repo && Number(s.pr) === p.number && s.id !== undefined && s.id !== null && own.includes(String(s.id)) && String(s.at ?? '') > since && String(s.at ?? '') <= until);
        for (const s of old) {
          try {
            await clients.forge.deleteComment({ ...at, comment: s.id, own });
          } catch (err) {
            say(gone(err) ? `the older summary ${s.id} is already gone` : `the older summary ${s.id} was not removed: ${err.message}`);
          }
        }
      }

      if (written.has(prId(p))) continue;
      written.add(prId(p));
      try {
        const st = await clients.forge.prState({ ...at, withBody: true });
        const sections = renderSections(l, { ...p, url: p.url ?? st.url ?? null }, settings.reviewRounds.labels, { placeFacts: Boolean(settings.checks?.places) });
        const r = rewriteDescription(st.body ?? '', sections);
        // A description with none of the markers (a PR opened before the switch) gets the three sections at its end, at
        // the PR's first round, so its new questions show; later, a person who took them all out is not overruled.
        if (r.missing.length === 3 && was.rounds === 0 && rounds.length) {
          await clients.forge.editPr({ ...at, body: appendSections(st.body ?? '', sections, settings.reviewRounds.labels) });
          continue;
        }
        if (r.changed) await clients.forge.editPr({ ...at, body: r.body });
        if (r.kept.length) say(`the description's ${r.kept.join(', ')} section${r.kept.length > 1 ? 's were' : ' was'} edited by a person since the last round: left as it is`);
        if (r.missing.length && r.missing.length < 3) say(`the description has no markers for ${r.missing.join(', ')}: that section is not kept`);
      } catch (err) {
        say(`the description was not rewritten: ${err.message}`);
      }
    }
  }
  return warnings;
}
