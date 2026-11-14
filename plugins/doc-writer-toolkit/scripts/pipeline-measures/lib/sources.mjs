import { listPrs, prCommits } from './github.mjs';
import { commitStats } from './gitdata.mjs';
import { cardLinks, createTrelloClient, listEntries, loadCredentials } from './trello.mjs';
import { readRunLog } from './runlog.mjs';

export const na = (reason) => ({ na: reason });
export const isNa = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && 'na' in v;

// Where each measure gets its data. The measures (measures.mjs) call only these functions, so a measure with a better
// source (a ledger the pipeline keeps, say) changes one entry here, or one entry of `io.sources` in a test, and
// nothing else:
//
//   prs()                 the pull requests of the window: { number, branch, state, createdAt, mergedAt, body, … }
//   commits(pr)           the pull request's commits in branch order: { oid, subject, date }
//   stats(oids)           Map oid -> { parents, added, removed, markersAdded, markersRemoved, files }
//   classify(pr, commit)  { role: 'pipeline' | 'owner', draft, ready } for a non-merge commit. Patterns today.
//   smeEntry(pr)          { at, cards, cardsWithEntry, entries } | { na }: when the card entered SME review
//   places(pr)            { listed, passedToReviewer, corrected } | { na }
//   runs(pr)              { total, byStage } | { na }: cost and usage per stage
//
// `warnings` collects what went wrong without stopping the run.
export function createSources(s, io) {
  const { gh, git, fetchImpl, sleep, env } = io;
  const warnings = [];
  const runLog = readRunLog(s.root, s.runLog);
  let trello; // undefined: not yet looked up; null: no credentials
  const cards = new Map();

  function client() {
    if (trello === undefined) {
      const creds = loadCredentials({ root: s.root, envFile: s.envFile, env });
      trello = creds ? createTrelloClient({ ...creds, origin: s.trelloOrigin, fetchImpl, sleep }) : null;
    }
    return trello;
  }

  async function entriesOf(link) {
    if (!cards.has(link)) cards.set(link, listEntries(client(), link, s.smeList).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })));
    return cards.get(link);
  }

  return {
    warnings,
    prs: () => listPrs(gh, s),
    commits: (pr) => prCommits(gh, s, pr.number),
    stats: (oids) => commitStats(git, oids),

    classify(pr, commit) {
      const ready = Boolean(s.readyPattern?.test(commit.subject));
      const pipeline = s.commitPattern.test(commit.subject) || ready;
      return { role: pipeline ? 'pipeline' : 'owner', draft: Boolean(s.draftPattern?.test(commit.subject)), ready };
    },

    async smeEntry(pr) {
      if (!s.smeList) return na('no SME review list declared (SME review list:)');
      if (!client()) return na('no Trello credentials: set TRELLO_API_KEY and TRELLO_API_TOKEN in the environment or the credentials file');
      const links = cardLinks(pr.body);
      if (!links.length) return na('the PR description links no card');
      const entries = [];
      let failed = 0;
      let withEntry = 0;
      for (const link of links) {
        const r = await entriesOf(link);
        if (!r.ok) {
          failed++;
          warnings.push(`PR ${pr.number}: a linked card could not be read (${r.e.message})`);
          continue;
        }
        if (r.v.length) withEntry++;
        entries.push(...r.v);
      }
      if (failed === links.length) return na('no linked card could be read from Trello');
      if (!entries.length) return na(`no linked card has entered '${s.smeList}'${failed ? ` (${failed} could not be read)` : ''}`);
      entries.sort();
      return { at: entries[0], cards: links.length, cardsWithEntry: withEntry, entries: entries.length };
    },

    async places() {
      if (s.reviewPolicy === 'sme') return na('the review policy is sme: the host reviews by SME, not by places');
      return na('no record of places yet: nothing the pipeline writes says which claims it could not confirm');
    },

    async runs(pr) {
      if (!s.runLog) return na('no run log declared (Run log:)');
      if (!runLog) return na('the run log file does not exist');
      const r = runLog.byPr.get(pr.number);
      if (!r) return na('the run log has no record for this PR');
      return { total: { cost: r.cost, inputTokens: r.inputTokens, outputTokens: r.outputTokens, steps: r.steps }, byStage: r.stages };
    },
  };
}
