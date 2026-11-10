import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { COMMANDS, OPTIONS, main } from '../forge.mjs';
import { FEED_EVENTS, OPERATIONS, createForge, suggestionBlock } from '../lib/forge.mjs';
import { READS, WRITES, assertAdapter } from '../lib/adapter-contract.mjs';
import { deepMerge, loadSettings, validateForge } from '../lib/settings.mjs';
import { CliError, ForgeError, Refusal } from '../lib/errors.mjs';
import { createAdapter, kinds } from '../adapters/index.mjs';
import { createGh, makeRedact } from '../adapters/github/gh.mjs';
import { createGithubAdapter, normalizePr, patchLines } from '../adapters/github/index.mjs';
import { fixture, ghFail, replayer, seq } from './fake-gh.mjs';
import { memoryAdapter } from './memory-adapter.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CLI = path.join(ROOT, 'forge.mjs');
const ZWNJ = '‌';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'forge-'));

// ------------------------------------------------------------------ the invented host
// Owner `acme-docs`; the guide repo holds one target, the API repo two (one PR per review kind). `ship it` is the
// owner's own label: it is in the repository and in no target.
const OWNER = 'acme-docs';
const HEAD7 = '7d1c0de5a1b2c3d4e5f60718293a4b5c6d7e8f90';
const guideLabels = { inProgress: 'in progress', review: 'in SME review', finalReview: 'In final review' };
const settingsJson = (over = {}) => ({
  schemaVersion: 1,
  forge: { kind: 'github', owner: OWNER, self: 'pat', assignee: 'pat', checkLabel: 'Check me' },
  targets: [
    { id: 'guide', repo: 'guide-docs', review: 'sme', reviewers: ['rev-one'], labels: guideLabels },
    { id: 'api-ui', repo: 'api-docs', review: 'sme', reviewers: ['rev-two'], labels: { inProgress: 'In progress', review: 'In SME review', finalReview: 'In final review' } },
    { id: 'api', repo: 'api-docs', review: 'places', reviewers: ['rev-two'], labels: { inProgress: 'In progress', review: 'In tech review', finalReview: 'In final review' } },
  ],
  ...over,
});
const forgeSettings = (over, header = null) => {
  const s = settingsJson(over);
  return validateForge(s.forge, s.targets, header);
};
const OWN_HEADER = '**[bot]**';
const LABEL_IDS = Object.fromEntries(fixture('gql-label-targets').data.repository.labels.nodes.map((l) => [l.id, l.name]));

// Routes every test starts from; a test adds or replaces what it needs.
const baseRoutes = () => ({
  'graphql PrByNumber': fixture('gql-pr-7'),
  'graphql LabelTargets': fixture('gql-label-targets'),
  'graphql ChangeLabels': fixture('gql-label-mutation'),
});

// A forge over the GitHub adapter over a stand-in gh. `calls` lists every gh call; `sleeps` the back-off waits.
function setup({ routes = {}, dryRun = false, settings, pageSize, env = {} } = {}) {
  const calls = [];
  const sleeps = [];
  const runner = replayer({ ...baseRoutes(), ...routes }, { onCall: (c) => calls.push(c) });
  const gh = createGh({ runner, env, dryRun, sleep: async (ms) => void sleeps.push(ms) });
  const adapter = createGithubAdapter(gh, { owner: OWNER, ...(pageSize ? { pageSize } : {}) });
  const forge = createForge({ adapter, forge: settings ?? forgeSettings(), dryRun });
  return { forge, calls, sleeps, gh, adapter };
}
const writes = (calls) => calls.filter((c) => c.write || c.mutation);
const rejects = (promise, refused) =>
  assert.rejects(promise, (e) => {
    assert.ok(e instanceof CliError, `expected a CliError, got ${e}`);
    if (refused) assert.equal(e.refused, refused, e.message);
    return true;
  });
// The label names a ChangeLabels mutation adds and removes.
const labelChange = (call) => ({
  add: (call.variables.add ?? []).map((id) => LABEL_IDS[id]),
  remove: (call.variables.remove ?? []).map((id) => LABEL_IDS[id]),
});

// ------------------------------------------------------------------ settings

test('settings: the forge object and the targets give the sets of repos, logins and labels the module may touch', () => {
  const f = forgeSettings();
  assert.deepEqual(f.repos, ['guide-docs', 'api-docs']);
  assert.deepEqual([...f.addable.keys()].sort(), ['check me', 'in final review', 'in progress', 'in sme review', 'in tech review']);
  assert.equal(f.addable.get('in progress'), 'in progress');
  assert.ok(f.addable.has('check me'));
  assert.ok(!f.addable.has('ship it'));
  // the check label is added by the pipeline, and removed when a person's forward move says the owner's check is done
  assert.ok(f.removable.has('check me'));
  assert.ok(f.removable.has('in sme review'));
  assert.deepEqual([...f.logins].sort(), ['pat', 'rev-one', 'rev-two']);
});

test('settings: validation names what is wrong', () => {
  const ok = settingsJson();
  const bad = (patch, re) => {
    const s = settingsJson(patch);
    assert.throws(() => validateForge(s.forge, s.targets), (e) => e instanceof CliError && e.exitCode === 2 && re.test(e.message));
  };
  bad({ forge: undefined }, /'forge' object/);
  bad({ forge: { ...ok.forge, owner: undefined } }, /forge\.owner/);
  bad({ targets: [] }, /'targets'/);
  bad({ targets: [{ id: 'a', repo: 'other/guide-docs' }] }, /not in forge\.owner/);
  bad({ targets: [{ id: 'a', repo: 'r', labels: { shipIt: 'ship it' } }] }, /not a stage/);
  bad({ targets: [{ id: 'a', repo: 'r' }, { id: 'a', repo: 'r2' }] }, /unique/);
  bad({ targets: [{ id: 'a', repo: 'r', reviewers: [1] }] }, /reviewers/);
  assert.equal(validateForge({ kind: 'github', owner: OWNER }, [{ id: 'a', repo: `${OWNER}/r` }]).checkLabel, null);
  assert.equal(validateForge({ kind: 'github', owner: OWNER }, [{ id: 'a', repo: `${OWNER}/r` }]).expertLabel, null);
});

test('settings: the expert label may be added and is never removed', () => {
  const f = validateForge({ kind: 'github', owner: OWNER, expertLabel: 'Expert advised' }, [{ id: 'a', repo: `${OWNER}/r`, labels: { inProgress: 'in progress' } }]);
  assert.equal(f.expertLabel, 'Expert advised');
  assert.equal(f.addable.get('expert advised'), 'Expert advised');
  assert.ok(!f.removable.has('expert advised'));
});

test('settings: found by flag, by the CLAUDE.md field, or at the default place; the local file merges over the shared one', async () => {
  const root = tmp();
  const write = (rel, value) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof value === 'string' ? value : JSON.stringify(value));
  };
  await assert.rejects(loadSettings({ root }), /no settings file/);
  write('.claude/ticket-flow.json', settingsJson());
  assert.equal((await loadSettings({ root })).forge.owner, OWNER);
  write('.claude/ticket-flow.local.json', { forge: { owner: 'local-owner' }, targets: settingsJson().targets.map((t) => ({ ...t, repo: `local-owner/${t.repo}` })) });
  const local = await loadSettings({ root });
  assert.equal(local.forge.owner, 'local-owner');
  assert.equal(local.local, true);
  write('flow/custom.json', settingsJson({ forge: { kind: 'github', owner: 'custom-owner' }, targets: [{ id: 'x', repo: 'r' }] }));
  write('CLAUDE.md', '## Documentation toolkit configuration\n\n- **Ticket flow settings:** `flow/custom.json`\n');
  assert.equal((await loadSettings({ root })).forge.owner, 'custom-owner');
  assert.equal((await loadSettings({ root, settings: '.claude/ticket-flow.json' })).forge.owner, 'local-owner');
  write('flow/custom.json', '{ not json');
  await assert.rejects(loadSettings({ root }), /not valid JSON/);
  assert.deepEqual(deepMerge({ a: { b: 1, c: [1] } }, { a: { c: [2] } }), { a: { b: 1, c: [2] } });
});

// ------------------------------------------------------------------ the gh module

test('gh: a REST read, a GraphQL read and a change are `gh api` calls with the body on standard input', async () => {
  const { forge, calls } = setup({
    routes: { 'POST repos/acme-docs/guide-docs/issues/7/comments': fixture('rest-issue-comment-created') },
  });
  await forge.prState({ repo: 'guide-docs', number: 7 });
  await forge.comment({ repo: 'guide-docs', number: 7, body: 'Text with "quotes", `ticks` and $vars\nand a second line' });
  assert.equal(calls[0].kind, 'graphql');
  assert.deepEqual(calls[0].variables, { owner: OWNER, name: 'guide-docs', number: 7 });
  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.path, 'repos/acme-docs/guide-docs/issues/7/comments');
  assert.equal(post.body.body, 'Text with "quotes", `ticks` and $vars\nand a second line');
});

test('gh: a GraphQL read refuses a document that changes anything; an error in the answer is reported with its message', async () => {
  const gh = createGh({ runner: replayer({ 'graphql Oops': { errors: [{ message: 'Field x does not exist' }] }, 'graphql Fine': { data: { ok: 1 } } }) });
  await assert.rejects(gh.query('M', 'mutation M { x }'), /goes through write/);
  await assert.rejects(gh.query('Oops', 'query Oops { x }'), (e) => e instanceof ForgeError && e.exitCode === 1 && /Field x does not exist/.test(e.message));
  assert.deepEqual(await gh.query('Fine', 'query Fine { ok }'), { ok: 1 });
  await assert.rejects(gh.write('GET', 'x'), /not a write/);
});

test('gh: an HTTP error names the call and the status; 429 and a rate-limit 403 are retried after 2, 4 and 8 s, then reported', async () => {
  const { forge, sleeps } = setup({ routes: { 'GET repos/acme-docs/guide-docs/pulls/comments/601': seq(ghFail(429, 'rate limited'), ghFail(403, 'You have exceeded a secondary rate limit'), fixture('rest-pull-comment-601')) } });
  const got = await forge.reply({ repo: 'guide-docs', number: 7, comment: 601, body: 'x' }).catch((e) => e);
  assert.deepEqual(sleeps, [2000, 4000]);
  assert.ok(got instanceof Error); // the next route (the thread read) isn't recorded; the retry itself worked
  const again = setup({ routes: { 'GET repos/acme-docs/guide-docs/pulls/comments/601': ghFail(429, 'rate limited') } });
  await assert.rejects(again.forge.reply({ repo: 'guide-docs', number: 7, comment: 601, body: 'x' }), (e) => e instanceof ForgeError && e.data.status === 429 && /HTTP 429/.test(e.message));
  assert.deepEqual(again.sleeps, [2000, 4000, 8000]);
  const missing = setup({ routes: { 'graphql PrByNumber': ghFail(404, 'Not Found') } });
  await assert.rejects(missing.forge.prState({ repo: 'guide-docs', number: 7 }), (e) => e.exitCode === 1 && e.data.status === 404);
});

test('gh: gh missing from PATH is reported; a token in any message is cleaned', async () => {
  const noGh = createGh({
    runner: async () => {
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    },
  });
  await assert.rejects(noGh.get('repos/x/y'), /not installed or not on PATH/);
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const env = { GH_TOKEN: 'a-token-from-the-environment' };
  const leaking = createGh({
    env,
    runner: async () => ({ code: 1, stdout: '', stderr: `gh: Bad credentials (HTTP 401) Authorization: token ${secret} and ${env.GH_TOKEN}` }),
  });
  await assert.rejects(leaking.get('repos/x/y'), (e) => !e.message.includes(secret) && !e.message.includes(env.GH_TOKEN) && /\*\*\*/.test(e.message) && e.data.status === 401);
  assert.equal(makeRedact({ GITHUB_TOKEN: 'abcdefghij' })('x abcdefghij y'), 'x *** y');
});

// ------------------------------------------------------------------ reads

test('prState: state, head and merge commits, review decision, requests and labels, by number', async () => {
  const { forge } = setup();
  const s = await forge.prState({ repo: 'guide-docs', number: 7 });
  assert.equal(s.state, 'open');
  assert.equal(s.headCommit, HEAD7);
  assert.equal(s.mergeCommit, null);
  assert.equal(s.head, 'docs/export-screen');
  assert.deepEqual(s.labels, ['in SME review']);
  assert.deepEqual(s.reviewRequests, [{ login: 'rev-one' }, { team: 'tech-writers' }]);
  assert.equal(s.mergeState, 'CLEAN');
  assert.equal(s.nodeId, undefined);
});

test('prState: the description only when asked for', async () => {
  const { forge } = setup();
  assert.equal('body' in (await forge.prState({ repo: 'guide-docs', number: 7 })), false);
  assert.equal(typeof (await forge.prState({ repo: 'guide-docs', number: 7, withBody: true })).body, 'string');
});

test('prState: a merged PR has its merge commit and time; by head, the open PR of the repo wins and a fork is ignored', async () => {
  const merged = setup({ routes: { 'graphql PrByNumber': fixture('gql-pr-9-merged') } });
  const m = await merged.forge.prState({ repo: 'guide-docs', number: 9 });
  assert.equal(m.state, 'merged');
  assert.equal(m.mergeCommit, 'bb22cc33dd44ee55ff6677889900aabbccddeeff');
  assert.equal(m.mergedAt, '2026-11-04T10:00:00Z');
  assert.equal(m.reviewDecision, 'APPROVED');
  const byHead = setup({ routes: { 'graphql PrsByHead': fixture('gql-prs-by-head-closed-and-fork') } });
  const h = await byHead.forge.prState({ repo: 'guide-docs', head: 'docs/export-screen' });
  assert.equal(h.number, 5);
  assert.equal(h.state, 'closed');
  const none = setup({ routes: { 'graphql PrsByHead': fixture('gql-prs-by-head-none') } });
  await rejects(none.forge.prState({ repo: 'guide-docs', head: 'nope' }), 'unknown');
  await assert.rejects(none.forge.prState({ repo: 'guide-docs' }), /exactly one/);
  await assert.rejects(none.forge.prState({ repo: 'guide-docs', number: 7, head: 'x' }), /exactly one/);
  await assert.rejects(none.forge.prState({ repo: 'guide-docs', number: 'seven' }), /not a PR number/);
});

test('changedPrsSince: all states, newest update first, read page by page until one is older than the time', async () => {
  const { forge, calls } = setup({ routes: { 'graphql ChangedPrs': seq(fixture('gql-changed-page1'), fixture('gql-changed-page2')) } });
  const r = await forge.changedPrsSince({ repo: 'guide-docs', since: '2026-11-03T00:00:00Z' });
  assert.deepEqual(r.numbers, [11, 7, 9]);
  assert.deepEqual(r.prs.map((p) => p.state), ['open', 'open', 'merged']);
  assert.equal(r.prs[2].mergeCommit, 'bb22cc33dd44ee55ff6677889900aabbccddeeff');
  assert.equal(r.prs[0].headCommit, HEAD7);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].variables.after, 'cursor-1');
  await assert.rejects(forge.changedPrsSince({ repo: 'guide-docs' }), /needs a time/);
  await assert.rejects(forge.changedPrsSince({ repo: 'guide-docs', since: 'yesterday' }), /not a time/);
  // a window that reaches the third page reads it
  const last = fixture('gql-changed-page2');
  last.data.repository.pullRequests.pageInfo.hasNextPage = false;
  last.data.repository.pullRequests.nodes = last.data.repository.pullRequests.nodes.map((n, i) => ({ ...n, number: 21 + i }));
  const wide = setup({ routes: { 'graphql ChangedPrs': seq(fixture('gql-changed-page1'), fixture('gql-changed-page2'), last) } });
  const all = await wide.forge.changedPrsSince({ repo: 'guide-docs', since: '2026-10-01T00:00:00Z' });
  assert.deepEqual(all.numbers, [11, 7, 9, 3, 21, 22]);
});

test('prActivity: reviews, threads with their comments, conversation comments and review requests; ids are the forge numbers', async () => {
  const { forge } = setup({ routes: { 'graphql PrReviews': fixture('gql-reviews'), 'graphql PrThreads': fixture('gql-threads'), 'graphql PrComments': fixture('gql-comments') } });
  const a = await forge.prActivity({ repo: 'guide-docs', number: 7 });
  // a pending review is a draft nobody sees: left out
  assert.deepEqual(a.reviews.map((r) => [r.id, r.state]), [[501, 'COMMENTED'], [502, 'APPROVED'], [400, 'COMMENTED']]);
  assert.equal(a.threads.length, 2);
  const t = a.threads[0];
  assert.deepEqual([t.path, t.line, t.resolved, t.outdated], ['docs/export.md', 12, false, false]);
  assert.deepEqual(t.comments.map((c) => [c.id, c.author, c.inReplyTo, c.reviewId]), [[601, 'rev-one', null, 501], [602, 'docs-writer', 601, 501]]);
  assert.equal(t.comments[1].edited, true);
  assert.equal(a.threads[1].truncated, true);
  assert.deepEqual(a.comments.map((c) => c.id), [701, 700, 699]);
  assert.equal(a.comments[2].author, null);
  assert.deepEqual(a.reviewRequests, [{ login: 'rev-one' }, { team: 'tech-writers' }]);
  assert.equal(a.pr.headCommit, HEAD7);
});

test('prActivity: a bot author is marked, whichever way the forge tells it; the queries ask for the type', async () => {
  // GraphQL gives a bot's login without `[bot]`, so the type is what catches it; a login with the suffix counts too.
  const person = (id, login, typename) => ({ id: `IC_${id}`, databaseId: id, author: { __typename: typename, login }, body: 'a preview is ready', createdAt: '2026-11-04T09:40:00Z', updatedAt: '2026-11-04T09:40:00Z' });
  const comments = fixture('gql-comments');
  comments.data.repository.pullRequest.comments.nodes = [person(801, 'netlify', 'Bot'), person(802, 'dependabot[bot]', 'User'), person(803, 'pat', 'User')];
  const reviews = fixture('gql-reviews');
  reviews.data.repository.pullRequest.reviews.nodes[0].author = { __typename: 'Bot', login: 'github-actions' };
  const threads = fixture('gql-threads');
  threads.data.repository.pullRequest.reviewThreads.nodes[0].comments.nodes[0].author = { __typename: 'Bot', login: 'coderabbitai' };
  const { forge, calls } = setup({ routes: { 'graphql PrReviews': reviews, 'graphql PrThreads': threads, 'graphql PrComments': comments } });
  const a = await forge.prActivity({ repo: 'guide-docs', number: 7 });
  assert.deepEqual(a.comments.map((c) => [c.author, c.authorBot === true]), [['netlify', true], ['dependabot[bot]', true], ['pat', false]]);
  assert.equal(a.reviews.find((r) => r.author === 'github-actions').authorBot, true);
  assert.equal(a.reviews.filter((r) => r.authorBot).length, 1);
  assert.equal(a.threads[0].comments[0].authorBot, true);
  assert.equal(a.threads[0].comments[1].authorBot, undefined);
  const asked = calls.filter((c) => c.kind === 'graphql' && /query Pr(Reviews|Threads|Comments)/.test(c.query));
  assert.equal(asked.length, 3);
  for (const c of asked) assert.match(c.query, /author \{ __typename login \}/);
});

test('prActivity: with a time, only what was posted or edited since, and which comments are new', async () => {
  const { forge } = setup({ routes: { 'graphql PrReviews': fixture('gql-reviews'), 'graphql PrThreads': fixture('gql-threads'), 'graphql PrComments': fixture('gql-comments') } });
  const a = await forge.prActivity({ repo: 'guide-docs', number: 7, since: '2026-11-04T09:11:00Z' });
  assert.deepEqual(a.reviews.map((r) => r.id), [502]);
  // the thread stays whole (the reply needs its parent), with the new comment marked
  assert.deepEqual(a.threads.map((t) => t.id), ['PRRT_1']);
  assert.deepEqual(a.threads[0].comments.map((c) => [c.id, c.new]), [[601, false], [602, true]]);
  // a comment edited since is back in the feed (REST and GraphQL filter by update time)
  assert.deepEqual(a.comments.map((c) => [c.id, c.new, c.edited]), [[701, true, false], [700, true, true]]);
  assert.deepEqual(a.counts, { reviews: 1, threads: 1, comments: 2 });
  const none = await forge.prActivity({ repo: 'guide-docs', number: 7, since: '2026-11-05T00:00:00Z' });
  assert.deepEqual(none.counts, { reviews: 0, threads: 0, comments: 0 });
});

test('prActivity: the comments of a review not yet submitted are left out, and a thread it opened with them; once submitted they are read', async () => {
  // GitHub gives a draft review's line comments to their author, and the forge acts from the owner's own login.
  const draft = (state) => {
    const threads = fixture('gql-threads');
    const nodes = threads.data.repository.pullRequest.reviewThreads.nodes;
    const reply = { ...nodes[0].comments.nodes[1], id: 'PRRC_620', databaseId: 620, author: { __typename: 'User', login: 'pat' }, body: 'Say it as the app does.', replyTo: { databaseId: 601 }, pullRequestReview: { databaseId: 530, state } };
    nodes[0].comments.nodes.push(reply);
    nodes.push({
      id: 'PRRT_3', isResolved: false, isOutdated: false, path: 'docs/export.md', line: 20,
      comments: { pageInfo: { hasNextPage: false }, nodes: [{ ...reply, id: 'PRRC_621', databaseId: 621, line: 20, body: 'Name the button.', replyTo: null }] },
    });
    for (const c of nodes[0].comments.nodes.slice(0, 2)) c.pullRequestReview.state = 'COMMENTED';
    return threads;
  };
  const read = async (state) => {
    const { forge, calls } = setup({ routes: { 'graphql PrReviews': fixture('gql-reviews'), 'graphql PrThreads': draft(state), 'graphql PrComments': fixture('gql-comments') } });
    const a = await forge.prActivity({ repo: 'guide-docs', number: 7 });
    assert.match(calls.find((c) => c.kind === 'graphql' && /query PrThreads/.test(c.query)).query, /pullRequestReview \{ databaseId state \}/);
    return a;
  };
  const pending = await read('PENDING');
  assert.deepEqual(pending.threads.map((t) => [t.id, t.comments.map((c) => c.id)]), [['PRRT_1', [601, 602]], ['PRRT_2', [610]]], 'the draft reply and the thread the draft opened are not there');
  assert.equal(pending.counts.threads, 2);
  const sent = await read('COMMENTED');
  assert.deepEqual(sent.threads.map((t) => [t.id, t.comments.map((c) => c.id)]), [['PRRT_1', [601, 602, 620]], ['PRRT_2', [610]], ['PRRT_3', [621]]]);
  assert.deepEqual(sent.threads[2].comments.map((c) => [c.author, c.reviewId]), [['pat', 530]]);
  assert.equal(sent.counts.threads, 3);
});

test('prActivity: a comment stamped a second after it was created (a new review\'s) is not reported as edited', async () => {
  const threads = fixture('gql-threads');
  threads.data.repository.pullRequest.reviewThreads.nodes[0].comments.nodes[0].updatedAt = '2026-11-04T09:00:01Z';
  const { forge } = setup({ routes: { 'graphql PrReviews': fixture('gql-reviews'), 'graphql PrThreads': threads, 'graphql PrComments': fixture('gql-comments') } });
  const a = await forge.prActivity({ repo: 'guide-docs', number: 7 });
  assert.equal(a.threads[0].comments[0].edited, false);
  assert.equal(a.threads[0].comments[1].edited, true);
});

test('eventsSince: pages newest first until one is older than the time; only PRs, only the feed events', async () => {
  const E = 'GET repos/acme-docs/guide-docs/issues/events';
  const routes = {
    [`${E}?per_page=3&page=1`]: fixture('rest-events-page1'),
    [`${E}?per_page=3&page=2`]: fixture('rest-events-page2'),
    [`${E}?per_page=3&page=3`]: fixture('rest-events-page3'),
  };
  const { forge, calls } = setup({ routes, pageSize: 3 });
  const r = await forge.eventsSince({ repo: 'guide-docs', since: '2026-11-04T08:30:00Z' });
  // page 2 ends at 2026-11-03, older than the time: page 3 is not read
  assert.equal(calls.filter((c) => c.path?.startsWith('repos/acme-docs/guide-docs/issues/events')).length, 2);
  assert.deepEqual(r.types, FEED_EVENTS);
  assert.deepEqual(r.events.map((e) => [e.id, e.event]), [[1005, 'labeled'], [1004, 'review_requested'], [1002, 'merged']]);
  assert.deepEqual(r.events[0], { id: 1005, event: 'labeled', createdAt: '2026-11-04T10:05:00Z', actor: 'pat', number: 7, label: 'In final review' });
  assert.equal(r.events[1].reviewer, 'rev-one');
  assert.equal(r.events[1].requester, 'pat');
  assert.equal(r.events[2].commit, 'bb22cc33dd44ee55ff6677889900aabbccddeeff');
  assert.equal(r.events[2].number, 9);
  assert.equal(r.truncated, false);
  // an issue's label event (no pull_request on the issue) is not a PR event
  assert.ok(!r.events.some((e) => e.id === 1001));
  const wide = await forge.eventsSince({ repo: 'guide-docs', since: '2026-10-01T00:00:00Z', types: ['review_request_removed', 'closed', 'commented'] });
  assert.deepEqual(wide.events.map((e) => e.event), ['commented', 'review_request_removed', 'closed']);
  assert.equal(wide.events[1].team, 'tech-writers');
});

// ------------------------------------------------------------------ open and edit

test('openPr: creates a PR with the assignee, reviewers and labels; returns the ids it posted', async () => {
  const { forge, calls } = setup({
    routes: {
      'graphql PrsByHead': fixture('gql-prs-by-head-none'),
      'POST repos/acme-docs/guide-docs/pulls': fixture('rest-create-pull'),
      'POST repos/acme-docs/guide-docs/issues/8/assignees': {},
      'POST repos/acme-docs/guide-docs/pulls/8/requested_reviewers': {},
    },
  });
  const r = await forge.openPr({ repo: 'guide-docs', head: 'docs/new-page', base: 'main', title: 'Describe the new page', body: 'Body text\n\n- one', reviewers: ['rev-one'], labels: ['IN SME REVIEW'], draft: true });
  assert.equal(r.created, true);
  assert.equal(r.number, 8);
  assert.equal(r.url, 'https://github.com/acme-docs/guide-docs/pull/8');
  assert.deepEqual(r.posted, [{ kind: 'pr', id: 9900007, number: 8 }]);
  assert.deepEqual(r.assignees, ['pat']);
  assert.deepEqual(r.labels, ['in SME review']);
  const [create] = writes(calls).filter((c) => c.path === 'repos/acme-docs/guide-docs/pulls');
  assert.deepEqual(create.body, { title: 'Describe the new page', head: 'docs/new-page', base: 'main', body: 'Body text\n\n- one', draft: true });
  assert.deepEqual(calls.find((c) => c.path?.endsWith('/assignees')).body, { assignees: ['pat'] });
  assert.deepEqual(calls.find((c) => c.path?.endsWith('/requested_reviewers')).body, { reviewers: ['rev-one'] });
  assert.deepEqual(labelChange(calls.find((c) => c.op === 'ChangeLabels')), { add: ['in SME review'], remove: [] });
});

test('openPr: an open PR for the same head is returned, not a second one; a second head in the same repo is a second PR', async () => {
  const same = setup({ routes: { 'graphql PrsByHead': fixture('gql-prs-by-head-open') } });
  const r = await same.forge.openPr({ repo: 'guide-docs', head: 'docs/export-screen', base: 'main', title: 'Again' });
  assert.equal(r.created, false);
  assert.equal(r.number, 7);
  assert.deepEqual(r.posted, []);
  assert.equal(writes(same.calls).length, 0);
  // the open PR of a fork with the same branch name, and a closed PR of the head, are not "the same head"
  const other = setup({ routes: { 'graphql PrsByHead': fixture('gql-prs-by-head-closed-and-fork'), 'POST repos/acme-docs/guide-docs/pulls': fixture('rest-create-pull'), 'POST repos/acme-docs/guide-docs/issues/8/assignees': {} } });
  const second = await other.forge.openPr({ repo: 'guide-docs', head: 'acme-docs:docs/export-screen', base: 'main', title: 'Second' });
  assert.equal(second.created, true);
  assert.equal(second.number, 8);
  assert.equal(other.calls.find((c) => c.op === 'PrsByHead').variables.head, 'docs/export-screen');
  // two heads in one repo: each is looked up alone
  const two = setup({ routes: { 'graphql PrsByHead': (call) => (call.variables.head === 'docs/a' ? fixture('gql-prs-by-head-open') : fixture('gql-prs-by-head-none')), 'POST repos/acme-docs/guide-docs/pulls': fixture('rest-create-pull'), 'POST repos/acme-docs/guide-docs/issues/8/assignees': {} } });
  assert.equal((await two.forge.openPr({ repo: 'guide-docs', head: 'docs/a', base: 'main', title: 'A' })).created, false);
  assert.equal((await two.forge.openPr({ repo: 'guide-docs', head: 'docs/b', base: 'main', title: 'B' })).created, true);
});

test('openPr: refuses, before any call, a repo, login or label the settings do not name, and an empty title', async () => {
  const { forge, calls } = setup();
  const open = (over) => forge.openPr({ repo: 'guide-docs', head: 'docs/x', base: 'main', title: 'T', ...over });
  await rejects(open({ repo: 'someone-elses-repo' }), 'notAllowed');
  await rejects(open({ repo: 'other-owner/guide-docs' }), 'notAllowed');
  await rejects(open({ reviewers: ['stranger'] }), 'notAllowed');
  await rejects(open({ assignee: 'stranger' }), 'notAllowed');
  await rejects(open({ labels: ['ship it'] }), 'notNamed');
  await rejects(open({ title: ' ' + ZWNJ }), 'empty');
  await assert.rejects(open({ head: 'a:b' }), /branch of the same repository/);
  await assert.rejects(open({ base: '' }), /--base/);
  assert.equal(calls.length, 0);
});

test('openPr: the check and ready labels are refused, before any call: the runner sets them on their own', async () => {
  const { forge, calls } = setup({ settings: readySettings() });
  for (const label of ['Check me', 'CHECK ME', READY]) await rejects(forge.openPr({ repo: 'guide-docs', head: 'docs/x', base: 'main', title: 'T', labels: ['in progress', label] }), 'notNamed');
  assert.equal(calls.length, 0);
});

test('openPr: when a step after the PR was made fails, the error says which PR exists', async () => {
  const { forge } = setup({
    routes: { 'graphql PrsByHead': fixture('gql-prs-by-head-none'), 'POST repos/acme-docs/guide-docs/pulls': fixture('rest-create-pull'), 'POST repos/acme-docs/guide-docs/issues/8/assignees': ghFail(422, 'Validation Failed') },
  });
  await assert.rejects(forge.openPr({ repo: 'guide-docs', head: 'docs/x', base: 'main', title: 'T' }), (e) => /#8 https:\/\/github.com\/acme-docs\/guide-docs\/pull\/8/.test(e.message) && e.data.pr.number === 8 && e.data.status === 422);
});

test('editPr: sends only the fields that changed; the same text is a no-op; an empty one is refused', async () => {
  const { forge, calls } = setup({ routes: { 'PATCH repos/acme-docs/guide-docs/pulls/7': fixture('rest-edit-pull') } });
  const same = await forge.editPr({ repo: 'guide-docs', number: 7, title: 'Describe the export screen', body: 'Adds the export page.' });
  assert.deepEqual([same.changed, writes(calls).length], [false, 0]);
  const r = await forge.editPr({ repo: 'guide-docs', number: 7, title: 'Describe the export screen', body: 'Новий текст\n\n## Список\n- a' });
  assert.deepEqual([r.changed, r.fields], [true, ['body']]);
  assert.deepEqual(writes(calls)[0].body, { body: 'Новий текст\n\n## Список\n- a' });
  await rejects(forge.editPr({ repo: 'guide-docs', number: 7, body: '  ' }), 'empty');
  await rejects(forge.editPr({ repo: 'guide-docs', number: 7, title: '' }), 'empty');
  await assert.rejects(forge.editPr({ repo: 'guide-docs', number: 7 }), /--title or --body/);
});

test('requestReviewers: asks the named logins not asked yet; the PR author and those already asked are left out', async () => {
  const { forge, calls } = setup({ routes: { 'POST repos/acme-docs/guide-docs/pulls/7/requested_reviewers': {} } });
  const r = await forge.requestReviewers({ repo: 'guide-docs', number: 7, logins: ['rev-one', 'rev-two'] });
  assert.deepEqual(r.requested, ['rev-two']);
  assert.deepEqual(r.skipped, [{ login: 'rev-one', reason: 'already asked' }]);
  assert.deepEqual(writes(calls)[0].body, { reviewers: ['rev-two'] });
  const nothing = await forge.requestReviewers({ repo: 'guide-docs', number: 7, logins: ['rev-one'] });
  assert.equal(nothing.changed, false);
  assert.equal(writes(calls).length, 1);
  await rejects(forge.requestReviewers({ repo: 'guide-docs', number: 7, logins: ['stranger'] }), 'notAllowed');
  await assert.rejects(forge.requestReviewers({ repo: 'guide-docs', number: 7, logins: [] }), /at least one login/);
});

// ------------------------------------------------------------------ review on lines, replies, suggestions

const FILES = 'GET repos/acme-docs/guide-docs/pulls/7/files';
const KNOWN = 'GET repos/acme-docs/guide-docs/pulls/7/comments';
// The PR's comment list is read before the review is posted and again after it, when the new comments are in it.
const reviewRoutes = () => ({
  [`${FILES}?per_page=100&page=1`]: fixture('rest-pull-files'),
  [`${KNOWN}?per_page=100&page=1`]: seq(fixture('rest-pull-comments'), [...fixture('rest-pull-comments'), ...fixture('rest-review-comments')]),
  'POST repos/acme-docs/guide-docs/pulls/7/reviews': fixture('rest-review-created'),
});

test('patchLines: the new-side lines of a unified diff, context and added lines', () => {
  assert.deepEqual(patchLines(fixture('rest-pull-files')[0].patch).sort((a, b) => a - b), [10, 11, 12, 13, 14, 42, 43, 44]);
  assert.deepEqual(patchLines(fixture('rest-pull-files')[1].patch), []);
  assert.deepEqual(patchLines('@@ -1,2 +1,2 @@\n a\n-b\n+c\n\\ No newline at end of file').sort(), [1, 2]);
});

test('reviewOnLines: one review with event COMMENT and a line comment per place; the comment ids come back', async () => {
  const { forge, calls } = setup({ routes: reviewRoutes() });
  const r = await forge.reviewOnLines({
    repo: 'guide-docs', number: 7, commit: HEAD7,
    comments: [{ path: 'docs/export.md', line: 12, body: 'Why is this limit 50?' }, { path: 'docs/export.md', line: 43, body: 'Source: the export service config.' }],
    body: 'Places to check',
  });
  const [post] = writes(calls);
  assert.equal(post.path, 'repos/acme-docs/guide-docs/pulls/7/reviews');
  assert.deepEqual(post.body, {
    commit_id: HEAD7, event: 'COMMENT', body: 'Places to check',
    comments: [{ path: 'docs/export.md', line: 12, side: 'RIGHT', body: 'Why is this limit 50?' }, { path: 'docs/export.md', line: 43, side: 'RIGHT', body: 'Source: the export service config.' }],
  });
  assert.equal(r.reviewId, 880);
  // each id is matched to its comment by path, line and text, never by position
  assert.deepEqual(r.comments.map((c) => [c.id, c.path, c.line]), [[8801, 'docs/export.md', 12], [8802, 'docs/export.md', 43]]);
  assert.deepEqual(r.commentIds, [8801, 8802]);
  assert.deepEqual(r.posted, [{ kind: 'review', id: 880 }, { kind: 'review-comment', id: 8801 }, { kind: 'review-comment', id: 8802 }]);
});

test('reviewOnLines: a line outside the diff is refused before anything is sent, and listed; --drop-outside posts the rest', async () => {
  const { forge, calls } = setup({ routes: reviewRoutes() });
  const comments = [
    { path: 'docs/export.md', line: 12, body: 'in the diff (an added line)' },
    { path: 'docs/export.md', line: 30, body: 'a line the diff does not show' },
    { path: 'docs/other.md', line: 1, body: 'a file that is not in the PR' },
    { path: 'docs/moved.md', line: 1, body: 'a removed file has no new side' },
  ];
  await assert.rejects(forge.reviewOnLines({ repo: 'guide-docs', number: 7, commit: HEAD7, comments }), (e) => {
    assert.equal(e.refused, 'outsideDiff');
    assert.deepEqual(e.data.outside.map((o) => [o.path, o.line, o.reason]), [
      ['docs/export.md', 30, 'the line is not in the diff'],
      ['docs/other.md', 1, 'the file is not in the diff'],
      ['docs/moved.md', 1, 'the line is not in the diff'],
    ]);
    return true;
  });
  assert.equal(writes(calls).length, 0);
  const r = await forge.reviewOnLines({ repo: 'guide-docs', number: 7, commit: HEAD7, comments, dropOutside: true });
  assert.equal(r.outside.length, 3);
  assert.equal(r.comments.length, 1);
  assert.equal(writes(calls)[0].body.comments.length, 1);
  assert.equal(writes(calls)[0].body.body, undefined);
});

test('reviewOnLines: a file with no diff text (an image) is left to the forge; a stale commit is refused', async () => {
  const { forge, calls } = setup({ routes: reviewRoutes() });
  await forge.reviewOnLines({ repo: 'guide-docs', number: 7, commit: HEAD7, comments: [{ path: 'static/img/export.png', line: 1, body: 'x' }] });
  assert.equal(writes(calls).length, 1);
  await rejects(forge.reviewOnLines({ repo: 'guide-docs', number: 7, commit: 'deadbeef', comments: [{ path: 'docs/export.md', line: 12, body: 'x' }] }), 'stale');
  await rejects(forge.reviewOnLines({ repo: 'guide-docs', number: 7, commit: HEAD7, comments: [] }), 'empty');
  await rejects(forge.reviewOnLines({ repo: 'guide-docs', number: 7, commit: HEAD7, comments: [{ path: 'a.md', line: 0, body: 'x' }] }), 'empty');
  await rejects(forge.reviewOnLines({ repo: 'guide-docs', number: 7, commit: HEAD7, comments: [{ path: 'a.md', line: 2, body: ' ' }] }), 'empty');
  await assert.rejects(forge.reviewOnLines({ repo: 'guide-docs', number: 7, comments: [{ path: 'a.md', line: 2, body: 'x' }] }), /--commit/);
});

test('reviewOnLines: --skip-diff-check hands the lines to the forge, whose answer is reported', async () => {
  const routes = { ...reviewRoutes(), 'POST repos/acme-docs/guide-docs/pulls/7/reviews': ghFail(422, 'Unprocessable Entity', fixture('rest-422-line')) };
  const { forge, calls } = setup({ routes });
  await assert.rejects(
    forge.reviewOnLines({ repo: 'guide-docs', number: 7, commit: 'older-commit', skipDiffCheck: true, comments: [{ path: 'docs/export.md', line: 30, body: 'x' }] }),
    (e) => e instanceof ForgeError && e.data.status === 422 && /must be part of the diff/.test(e.message),
  );
  assert.equal(calls.some((c) => c.path?.includes('/files')), false);
});

test('reviewOnLines: a comment already on the PR (same path, line and text) is not posted again', async () => {
  const { forge, calls } = setup({ routes: reviewRoutes() });
  const r = await forge.reviewOnLines({ repo: 'guide-docs', number: 7, commit: HEAD7, comments: [{ path: 'docs/export.md', line: 12, body: 'Existing note.' }] });
  assert.equal(r.reviewId, null);
  assert.deepEqual(r.skipped.map((s) => s.existing), [610]);
  assert.deepEqual(r.posted, []);
  assert.equal(writes(calls).length, 0);
});

test('reply: goes to the first comment of the thread, even when given a reply; carries the id it posted', async () => {
  const routes = {
    'GET repos/acme-docs/guide-docs/pulls/comments/603': fixture('rest-pull-comment-603'),
    [`${KNOWN}?per_page=100&page=1`]: fixture('rest-pull-comments'),
    'POST repos/acme-docs/guide-docs/pulls/7/comments/601/replies': fixture('rest-reply-created'),
  };
  const { forge, calls } = setup({ routes });
  const r = await forge.reply({ repo: 'guide-docs', number: 7, comment: 603, body: 'Fixed in the next commit.' });
  assert.deepEqual([r.replied, r.id, r.thread], [true, 9100, 601]);
  assert.deepEqual(r.posted, [{ kind: 'review-comment', id: 9100 }]);
  assert.deepEqual(writes(calls)[0].body, { body: 'Fixed in the next commit.' });
});

test('reply: the same reply is not posted twice; a comment of another PR is refused; an empty text is refused', async () => {
  const routes = {
    'GET repos/acme-docs/guide-docs/pulls/comments/601': fixture('rest-pull-comment-601'),
    'GET repos/acme-docs/guide-docs/pulls/comments/777': fixture('rest-pull-comment-other-pr'),
    [`${KNOWN}?per_page=100&page=1`]: fixture('rest-pull-comments'),
  };
  const { forge, calls } = setup({ routes });
  const dup = await forge.reply({ repo: 'guide-docs', number: 7, comment: 601, body: 'Checked, it is right.' });
  assert.deepEqual([dup.replied, dup.existing, dup.posted], [false, 602, []]);
  assert.equal(writes(calls).length, 0);
  await rejects(forge.reply({ repo: 'guide-docs', number: 7, comment: 777, body: 'x' }), 'unknown');
  await rejects(forge.reply({ repo: 'guide-docs', number: 7, comment: 601, body: '' }), 'empty');
  await assert.rejects(forge.reply({ repo: 'guide-docs', number: 7, comment: 'abc', body: 'x' }), /not a review comment id/);
});

// ------------------------------------------------------------------ the pipeline's own threads and comments

// A thread the pipeline opened (701, from `pat` with the header, a person's reply under it), a person's thread (601,
// with the pipeline's reply 603), a thread of the owner's own (801, no header), and conversation comments: the
// pipeline's (9300), a person's who copied the header (9301), the owner's own (9302), one on another PR (9303) and one
// already gone (9304).
const gqlComment = (databaseId, login, body, replyTo = null) => ({ id: `PRRC_${databaseId}`, databaseId, author: { login }, body, createdAt: '2026-11-04T09:00:00Z', updatedAt: '2026-11-04T09:00:00Z', path: 'docs/export.md', line: 12, replyTo: replyTo ? { databaseId: replyTo } : null, pullRequestReview: { databaseId: 880, state: 'COMMENTED' } });
const thread = (id, resolved, line, nodes) => ({ id, isResolved: resolved, isOutdated: false, path: 'docs/export.md', line, comments: { pageInfo: { hasNextPage: false }, nodes } });
const ownThreads = (resolved = false) => ({
  data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
    thread('PRRT_9', resolved, 12, [gqlComment(701, 'pat', `${OWN_HEADER}\n\nA place to check.`), gqlComment(702, 'rev-one', 'Confirmed.', 701)]),
    thread('PRRT_1', false, 30, [gqlComment(601, 'rev-one', 'Is this right?'), gqlComment(603, 'pat', `${OWN_HEADER}\n\nYes.`, 601)]),
    thread('PRRT_3', false, 40, [gqlComment(801, 'pat', 'A note of my own, no header.')]),
  ] } } } },
});
const restIssueComment = (id, login, body, number = 7) => ({ id, node_id: `IC_${id}`, user: { login }, body, created_at: '2026-11-04T09:00:00Z', updated_at: '2026-11-04T09:00:00Z', issue_url: `https://api.example/repos/acme-docs/guide-docs/issues/${number}` });
const ownRoutes = ({ resolved = false } = {}) => ({
  'graphql PrThreads': ownThreads(resolved),
  'graphql ResolveThread': { data: { resolveReviewThread: { thread: { id: 'PRRT_9', isResolved: true } } } },
  'GET repos/acme-docs/guide-docs/issues/comments/9300': restIssueComment(9300, 'pat', `${OWN_HEADER}\n\nAn older summary.`),
  'GET repos/acme-docs/guide-docs/issues/comments/9301': restIssueComment(9301, 'rev-one', `${OWN_HEADER}\n\nA person who copied the header.`),
  'GET repos/acme-docs/guide-docs/issues/comments/9302': restIssueComment(9302, 'pat', "The owner's own note."),
  'GET repos/acme-docs/guide-docs/issues/comments/9303': restIssueComment(9303, 'pat', `${OWN_HEADER}\n\nOn another PR.`, 8),
  'GET repos/acme-docs/guide-docs/issues/comments/9304': ghFail(404, 'Not Found'),
  'DELETE repos/acme-docs/guide-docs/issues/comments/9300': {},
});

test('resolveThread: settles the thread its own comment opened, once; the mutation names that thread only', async () => {
  const { forge, calls } = setup({ settings: forgeSettings(undefined, OWN_HEADER), routes: ownRoutes() });
  const r = await forge.resolveThread({ repo: 'guide-docs', number: 7, comment: 701, own: '701, 702' });
  assert.deepEqual([r.resolved, r.thread, r.posted], [true, 'PRRT_9', []]);
  const [m] = writes(calls);
  assert.equal(m.op, 'ResolveThread');
  assert.deepEqual(m.variables, { thread: 'PRRT_9' });
  const again = setup({ settings: forgeSettings(undefined, OWN_HEADER), routes: ownRoutes({ resolved: true }) });
  const r2 = await again.forge.resolveThread({ repo: 'guide-docs', number: 7, comment: 701, own: [701] });
  assert.deepEqual([r2.resolved, r2.reason], [false, 'the thread is already resolved']);
  assert.equal(writes(again.calls).length, 0);
});

test("resolveThread: a person's thread, a reply of the pipeline's in it, an id not among its own and a comment with no header are refused before any change", async () => {
  const { forge, calls } = setup({ settings: forgeSettings(undefined, OWN_HEADER), routes: ownRoutes() });
  const at = { repo: 'guide-docs', number: 7 };
  await rejects(forge.resolveThread({ ...at, comment: 601, own: [601, 603] }), 'notOwn');
  await rejects(forge.resolveThread({ ...at, comment: 603, own: [603] }), 'notOwn');
  await rejects(forge.resolveThread({ ...at, comment: 701, own: [702] }), 'notOwn');
  await rejects(forge.resolveThread({ ...at, comment: 801, own: [801] }), 'notOwn');
  await rejects(forge.resolveThread({ ...at, comment: 999, own: [999] }), 'unknown');
  await rejects(forge.resolveThread({ ...at, comment: 701 }), 'notOwn');
  assert.equal(writes(calls).length, 0);
  // With no header in the settings, the pipeline's thread can't be told from the owner's: refused, as deleteComment.
  const plainSettings = setup({ routes: ownRoutes() });
  await rejects(plainSettings.forge.resolveThread({ ...at, comment: 701, own: [701] }), 'notOwn');
  assert.equal(writes(plainSettings.calls).length, 0);
});

test("deleteComment: removes the pipeline's own conversation comment; a person's, one with no header, one on another PR or not among its own is refused; a comment gone is the forge's 404", async () => {
  const { forge, calls } = setup({ settings: forgeSettings(undefined, OWN_HEADER), routes: ownRoutes() });
  const at = { repo: 'guide-docs', number: 7 };
  const r = await forge.deleteComment({ ...at, comment: 9300, own: [9300] });
  assert.deepEqual([r.deleted, r.posted], [true, []]);
  assert.deepEqual(writes(calls).map((c) => [c.method, c.path]), [['DELETE', 'repos/acme-docs/guide-docs/issues/comments/9300']]);
  await rejects(forge.deleteComment({ ...at, comment: 9301, own: [9301] }), 'notOwn');
  await rejects(forge.deleteComment({ ...at, comment: 9302, own: [9302] }), 'notOwn');
  await rejects(forge.deleteComment({ ...at, comment: 9303, own: [9303] }), 'unknown');
  await rejects(forge.deleteComment({ ...at, comment: 9300, own: [1] }), 'notOwn');
  await assert.rejects(forge.deleteComment({ ...at, comment: 9304, own: [9304] }), (e) => e instanceof ForgeError && e.data.status === 404);
  assert.equal(writes(calls).length, 1);
  // With no header in the settings, the pipeline's comment can't be told from the owner's: refused.
  const plainSettings = setup({ routes: ownRoutes() });
  await rejects(plainSettings.forge.deleteComment({ ...at, comment: 9300, own: [9300] }), 'notOwn');
  assert.equal(writes(plainSettings.calls).length, 0);
});

test('resolveThread and deleteComment under --dry-run: read, checked, recorded and not sent', async () => {
  const { forge, calls, gh } = setup({ dryRun: true, settings: forgeSettings(undefined, OWN_HEADER), routes: ownRoutes() });
  await forge.resolveThread({ repo: 'guide-docs', number: 7, comment: 701, own: [701] });
  await forge.deleteComment({ repo: 'guide-docs', number: 7, comment: 9300, own: [9300] });
  assert.equal(writes(calls).length, 0);
  assert.deepEqual(gh.calls.map((c) => [c.method, c.path]), [['POST', 'graphql'], ['DELETE', 'repos/acme-docs/guide-docs/issues/comments/9300']]);
  await rejects(forge.deleteComment({ repo: 'guide-docs', number: 7, comment: 9301, own: [9301] }), 'notOwn');
});

test("reviewOnLines: --outside-in-body keeps the text of a comment outside the diff in the review's own text; a review with a text and no line comment is posted once", async () => {
  const { forge, calls } = setup({ routes: { ...reviewRoutes(), 'graphql PrReviews': fixture('gql-reviews') } });
  const comments = [
    { path: 'docs/export.md', line: 12, body: 'in the diff' },
    { path: 'docs/export.md', line: 30, body: 'Deleted section «Old export» (40 lines): not in the ticket.' },
  ];
  const r = await forge.reviewOnLines({ repo: 'guide-docs', number: 7, commit: HEAD7, comments, body: 'Round 2: two commits.', outsideInBody: true });
  const [post] = writes(calls);
  assert.equal(post.body.comments.length, 1);
  assert.equal(post.body.body, 'Round 2: two commits.\n\n`docs/export.md:30`\nDeleted section «Old export» (40 lines): not in the ticket.');
  assert.deepEqual(r.inBody, [{ path: 'docs/export.md', line: 30 }]);
  assert.deepEqual(r.outside.map((o) => o.line), [30]);
  await assert.rejects(forge.reviewOnLines({ repo: 'guide-docs', number: 7, commit: HEAD7, comments, dropOutside: true, outsideInBody: true }), /not both/);
  // A text alone: a review with no line comment.
  const only = setup({ routes: { ...reviewRoutes(), 'graphql PrReviews': fixture('gql-reviews') } });
  const b = await only.forge.reviewOnLines({ repo: 'guide-docs', number: 7, commit: HEAD7, comments: [], body: 'Round 3: nothing to decide.' });
  assert.equal(writes(only.calls).length, 1);
  assert.deepEqual(writes(only.calls)[0].body.comments, []);
  assert.equal(b.posted[0].kind, 'review');
  await rejects(only.forge.reviewOnLines({ repo: 'guide-docs', number: 7, commit: HEAD7, comments: [] }), 'empty');
});

test("reviewOnLines: a review whose text is already a review of the pipeline's login is not posted again", async () => {
  const reviews = fixture('gql-reviews');
  const node = reviews.data.repository.pullRequest.reviews.nodes[0];
  const conn = { ...reviews.data.repository.pullRequest.reviews, nodes: [{ ...node, author: { login: 'pat' }, body: 'Round 3: nothing to decide.' }] };
  const { forge, calls } = setup({ routes: { ...reviewRoutes(), 'graphql PrReviews': { data: { repository: { pullRequest: { reviews: conn } } } } } });
  const r = await forge.reviewOnLines({ repo: 'guide-docs', number: 7, commit: HEAD7, comments: [], body: 'Round 3: nothing to decide.' });
  assert.equal(r.reviewId, null);
  assert.equal(r.existing, node.databaseId);
  assert.equal(writes(calls).length, 0);
});

test('suggestionBlock: a fence longer than any run of backticks in the replacement', () => {
  assert.equal(suggestionBlock('new line'), '```suggestion\nnew line\n```');
  assert.equal(suggestionBlock('a\nb\n'), '```suggestion\na\nb\n```');
  assert.equal(suggestionBlock('use ```js``` here'), '````suggestion\nuse ```js``` here\n````');
});

test('suggest: a reply in the thread whose text is the optional note and a suggestion block', async () => {
  const routes = {
    'GET repos/acme-docs/guide-docs/pulls/comments/601': fixture('rest-pull-comment-601'),
    [`${KNOWN}?per_page=100&page=1`]: fixture('rest-pull-comments'),
    'POST repos/acme-docs/guide-docs/pulls/7/comments/601/replies': fixture('rest-reply-created'),
  };
  const { forge, calls } = setup({ routes });
  const r = await forge.suggest({ repo: 'guide-docs', number: 7, comment: 601, replacement: 'The limit is 100 rows.', body: 'Suggested wording:' });
  assert.equal(r.id, 9100);
  assert.equal(writes(calls)[0].path, 'repos/acme-docs/guide-docs/pulls/7/comments/601/replies');
  assert.equal(writes(calls)[0].body.body, 'Suggested wording:\n\n```suggestion\nThe limit is 100 rows.\n```');
  await rejects(forge.suggest({ repo: 'guide-docs', number: 7, comment: 601, replacement: '  ' }), 'empty');
});

test('comment: posts the text exactly (U+200C kept, no footer, no tool name); with a header it is posted once', async () => {
  const { forge, calls } = setup({ routes: { 'POST repos/acme-docs/guide-docs/issues/7/comments': fixture('rest-issue-comment-created'), 'graphql PrComments': fixture('gql-comments') } });
  const text = `Run summary${ZWNJ}\n\n${ZWNJ}\n- fixed 2\n- suggested 1`;
  const r = await forge.comment({ repo: 'guide-docs', number: 7, body: text });
  assert.deepEqual([r.commented, r.id, r.posted], [true, 9200, [{ kind: 'comment', id: 9200 }]]);
  assert.equal(writes(calls)[0].body.body, text);
  assert.deepEqual(Object.keys(writes(calls)[0].body), ['body']);
  const skip = await forge.comment({ repo: 'guide-docs', number: 7, body: 'Summary of this run: again', unlessHeader: 'Summary of this run' });
  assert.deepEqual([skip.commented, skip.existing], [false, 701]);
  // a header comment older than the window does not count
  const fresh = await forge.comment({ repo: 'guide-docs', number: 7, body: 'Summary of this run: new', unlessHeader: 'Summary of this run', since: '2026-11-04T10:00:00Z' });
  assert.equal(fresh.commented, true);
  await rejects(forge.comment({ repo: 'guide-docs', number: 7, body: ZWNJ }), 'empty');
});

// ------------------------------------------------------------------ labels

test('addLabel: a label a target names is added by one request; a label the PR has is a no-op', async () => {
  const { forge, calls } = setup();
  const r = await forge.addLabel({ repo: 'guide-docs', number: 7, label: 'check me' });
  assert.deepEqual([r.label, r.changed], ['Check me', true]);
  assert.deepEqual(labelChange(calls.find((c) => c.op === 'ChangeLabels')), { add: ['Check me'], remove: [] });
  const had = await forge.addLabel({ repo: 'guide-docs', number: 7, label: 'in SME review' });
  assert.deepEqual([had.changed, had.reason], [false, 'the PR already has the label']);
  assert.equal(calls.filter((c) => c.op === 'ChangeLabels').length, 1);
});

test('addLabel and removeLabel: a label the settings do not name is refused before any call', async () => {
  const { forge, calls } = setup();
  await rejects(forge.addLabel({ repo: 'guide-docs', number: 7, label: 'ship it' }), 'notNamed');
  await rejects(forge.addLabel({ repo: 'guide-docs', number: 7, label: 'SHIP IT' }), 'notNamed');
  await rejects(forge.removeLabel({ repo: 'guide-docs', number: 7, label: 'ship it' }), 'notNamed');
  assert.equal(calls.length, 0);
});

test('removeLabel: the check label may be removed, the expert label never', async () => {
  const { forge } = setup();
  const r = await forge.removeLabel({ repo: 'guide-docs', number: 7, label: 'check me' });
  assert.equal(r.label, 'Check me', 'not refused: the settings spelling is reported');
  const f = validateForge({ kind: 'github', owner: OWNER, checkLabel: 'Check me', expertLabel: 'Expert advised' }, [{ id: 'a', repo: `${OWNER}/r` }]);
  assert.ok(f.removable.has('check me'));
  assert.ok(!f.removable.has('expert advised'));
});

test('removeLabel: removes a stage label; one the PR does not have is a no-op', async () => {
  const { forge, calls } = setup();
  const r = await forge.removeLabel({ repo: 'guide-docs', number: 7, label: 'in sme review' });
  assert.deepEqual([r.label, r.changed], ['in SME review', true]);
  assert.deepEqual(labelChange(calls.find((c) => c.op === 'ChangeLabels')), { add: [], remove: ['in SME review'] });
  const none = await forge.removeLabel({ repo: 'guide-docs', number: 7, label: 'in progress' });
  assert.equal(none.changed, false);
});

test('labels: a label the repository does not have is reported, never created', async () => {
  const { forge, calls } = setup({ routes: { 'graphql LabelTargets': fixture('gql-label-targets-no-final') } });
  await rejects(forge.addLabel({ repo: 'guide-docs', number: 7, label: 'In final review' }), 'unknown');
  assert.equal(calls.filter((c) => c.mutation).length, 0);
});

// ------------------------------------------------------------------ the ready label

const READY = 'Merge advised';
const readySettings = () => forgeSettings({ forge: { ...settingsJson().forge, readyLabel: READY } });
const withLabel = (name) => {
  const f = structuredClone(fixture('gql-label-targets'));
  f.data.repository.labels.nodes.push({ id: 'LA_9', name });
  return f;
};

test('settings: the ready label may be added and removed, and must be a label of its own', () => {
  const f = readySettings();
  assert.equal(f.readyLabel, READY);
  assert.equal(f.addable.get('merge advised'), READY);
  assert.equal(f.removable.get('merge advised'), READY);
  assert.equal(forgeSettings().readyLabel, null);
  for (const taken of ['Check me', 'in progress', 'IN FINAL REVIEW']) {
    const s = settingsJson({ forge: { ...settingsJson().forge, readyLabel: taken } });
    assert.throws(() => validateForge(s.forge, s.targets), /forge\.readyLabel .* needs a label of its own/, taken);
  }
});

test('addLabel: the ready label is created on a repository that lacks it, then added; any other missing label is still refused', async () => {
  const created = { 'POST repos/acme-docs/guide-docs/labels': { id: 1, name: READY } };
  const { forge, calls } = setup({ settings: readySettings(), routes: { 'graphql LabelTargets': seq(fixture('gql-label-targets'), withLabel(READY)), ...created } });
  const r = await forge.addLabel({ repo: 'guide-docs', number: 7, label: READY });
  assert.deepEqual([r.label, r.changed, r.created], [READY, true, true]);
  const create = writes(calls).find((c) => c.path === 'repos/acme-docs/guide-docs/labels');
  assert.deepEqual(create.body, { name: READY, color: 'ededed' });
  assert.deepEqual(calls.find((c) => c.op === 'ChangeLabels').variables.add, ['LA_9']);
  // one already made meanwhile (GitHub answers 422) is no error
  const raced = setup({ settings: readySettings(), routes: { 'graphql LabelTargets': seq(fixture('gql-label-targets'), withLabel(READY)), 'POST repos/acme-docs/guide-docs/labels': ghFail(422, 'Validation Failed') } });
  assert.equal((await raced.forge.addLabel({ repo: 'guide-docs', number: 7, label: READY })).changed, true);
  // the stage labels are never created
  const other = setup({ settings: readySettings(), routes: { 'graphql LabelTargets': fixture('gql-label-targets-no-final'), ...created } });
  await rejects(other.forge.addLabel({ repo: 'guide-docs', number: 7, label: 'In final review' }), 'unknown');
  assert.equal(writes(other.calls).length, 0);
  // a dry run records the label it would create and the add
  const dry = setup({ settings: readySettings(), dryRun: true, routes: { 'graphql LabelTargets': fixture('gql-label-targets') } });
  const would = await dry.forge.addLabel({ repo: 'guide-docs', number: 7, label: READY });
  assert.deepEqual([would.changed, would.created], [true, true]);
  assert.deepEqual(dry.gh.calls.map((c) => c.path), ['repos/acme-docs/guide-docs/labels']);
});

// ------------------------------------------------------------------ the translated label

const TRANSLATED = 'Translations match';
const translatedSettings = () => forgeSettings({ forge: { ...settingsJson().forge, readyLabel: READY, translatedLabel: TRANSLATED } });

test('settings: the translated label may be added and removed, must be a label of its own, and is refused at a PR\'s opening', async () => {
  const f = translatedSettings();
  assert.equal(f.translatedLabel, TRANSLATED);
  assert.equal(f.addable.get('translations match'), TRANSLATED);
  assert.equal(f.removable.get('translations match'), TRANSLATED);
  assert.equal(forgeSettings().translatedLabel, null);
  for (const taken of ['Check me', 'in progress', READY.toUpperCase()]) {
    const s = settingsJson({ forge: { ...settingsJson().forge, readyLabel: READY, translatedLabel: taken } });
    assert.throws(() => validateForge(s.forge, s.targets), /forge\.translatedLabel .* needs a label of its own/, taken);
  }
  const { forge, calls } = setup({ settings: translatedSettings() });
  await rejects(forge.openPr({ repo: 'guide-docs', head: 'docs/x', base: 'main', title: 'T', labels: ['in progress', TRANSLATED] }), 'notNamed');
  assert.equal(calls.length, 0);
});

test('addLabel: the translated label is created on a repository that lacks it, then added', async () => {
  const created = { 'POST repos/acme-docs/guide-docs/labels': { id: 1, name: TRANSLATED } };
  const { forge, calls } = setup({ settings: translatedSettings(), routes: { 'graphql LabelTargets': seq(fixture('gql-label-targets'), withLabel(TRANSLATED)), ...created } });
  const r = await forge.addLabel({ repo: 'guide-docs', number: 7, label: TRANSLATED });
  assert.deepEqual([r.label, r.changed, r.created], [TRANSLATED, true, true]);
  assert.deepEqual(writes(calls).find((c) => c.path === 'repos/acme-docs/guide-docs/labels').body, { name: TRANSLATED, color: 'ededed' });
});

// ------------------------------------------------------------------ the comment header

const HEADER = '🤖 **[BOT]**';
// The in-memory forge with the comments it was given and the ones it posted, so a check that reads them sees both.
function talkingAdapter({ issue = [], review = [] } = {}) {
  const adapter = memoryAdapter();
  const issueComments = [...issue];
  const reviewComments = [...review];
  adapter.issueComments = async () => issueComments;
  adapter.reviewComments = async () => reviewComments;
  adapter.reviewComment = async ({ id }) => ({ ...reviewComments.find((c) => c.id === Number(id)), number: 1 });
  adapter.comment = async (a) => (adapter.log.push(['comment', a.body]), issueComments.push({ id: 91, body: a.body, createdAt: '2026-11-05T00:00:00Z' }), { id: 91 });
  adapter.reply = async (a) => (adapter.log.push(['reply', a.comment, a.body]), reviewComments.push({ id: 92, body: a.body, inReplyTo: a.comment, author: 'pat' }), { id: 92 });
  const makeReview = adapter.createReview;
  adapter.createReview = async (a) => (adapter.log.push(['review', a.body ?? null, a.comments.map((c) => c.body)]), makeReview(a));
  return adapter;
}
const withHeaderSettings = () => {
  const s = settingsJson();
  return validateForge(s.forge, s.targets, HEADER);
};

test('the comment header: a comment, a reply, a suggestion and each line comment start with it; a PR description does not', async () => {
  const adapter = talkingAdapter({ review: [{ id: 50, body: 'Why 50?', path: 'docs/a.md', line: 2, inReplyTo: null, author: 'rev-one' }] });
  const forge = createForge({ adapter, forge: withHeaderSettings() });
  await forge.comment({ repo: 'guide-docs', number: 1, body: 'Edits\n\n**1.** `docs/a.md`' });
  assert.deepEqual(adapter.log.at(-1), ['comment', `${HEADER}\n\nEdits\n\n**1.** \`docs/a.md\``]);
  await forge.reply({ repo: 'guide-docs', number: 1, comment: 50, body: 'Fixed.' });
  assert.deepEqual(adapter.log.at(-1), ['reply', 50, `${HEADER}\n\nFixed.`]);
  await forge.suggest({ repo: 'guide-docs', number: 1, comment: 50, replacement: 'The limit is 100.' });
  assert.equal(adapter.log.at(-1)[2], `${HEADER}\n\n\`\`\`suggestion\nThe limit is 100.\n\`\`\``);
  const r = await forge.reviewOnLines({ repo: 'guide-docs', number: 1, commit: 'c0ffee0', body: 'Places', comments: [{ path: 'docs/a.md', line: 2, body: 'Place to check' }, { path: 'docs/a.md', line: 3, body: `${HEADER}\n\nAnother` }] });
  assert.deepEqual(adapter.log.find((x) => x[0] === 'review'), ['review', `${HEADER}\n\nPlaces`, [`${HEADER}\n\nPlace to check`, `${HEADER}\n\nAnother`]]);
  // each id still comes back: the module matches the comment it sent, header and all
  assert.deepEqual(r.commentIds, [780, 781]);
  await forge.openPr({ repo: 'guide-docs', head: 'topic-c', base: 'main', title: 'T', body: 'Description' });
  await forge.editPr({ repo: 'guide-docs', number: 1, body: 'New description' });
  assert.deepEqual(adapter.log.at(-1), ['updatePr', 1, undefined, 'New description']);
  // none set: the text as given
  const plain = talkingAdapter();
  await createForge({ adapter: plain, forge: forgeSettings() }).comment({ repo: 'guide-docs', number: 1, body: 'Edits' });
  assert.deepEqual(plain.log.at(-1), ['comment', 'Edits']);
  assert.equal(forgeSettings().commentHeader, null);
  await rejects(forge.comment({ repo: 'guide-docs', number: 1, body: `${HEADER}\n\n` }), 'empty');
});

test('the comment header: --unless-header, a duplicate line comment and a duplicate reply are found with the header and without it', async () => {
  for (const mark of ['', `${HEADER}\n\n`]) {
    const adapter = talkingAdapter({
      issue: [{ id: 70, body: `${mark}Ready for merge`, createdAt: '2026-11-04T00:00:00Z' }],
      review: [{ id: 50, body: 'Why 50?', path: 'docs/a.md', line: 2, inReplyTo: null, author: 'rev-one' }, { id: 51, body: `${mark}Fixed.`, path: 'docs/a.md', line: 2, inReplyTo: 50, author: 'pat' }, { id: 52, body: `${mark}Place to check`, path: 'docs/a.md', line: 3, inReplyTo: null, author: 'pat' }],
    });
    const forge = createForge({ adapter, forge: withHeaderSettings() });
    for (const unlessHeader of ['Ready for merge', `${HEADER}\n\nReady for merge`]) {
      const c = await forge.comment({ repo: 'guide-docs', number: 1, body: 'Ready for merge', unlessHeader });
      assert.deepEqual([c.commented, c.existing], [false, 70], JSON.stringify([mark, unlessHeader]));
    }
    await rejects(forge.comment({ repo: 'guide-docs', number: 1, body: 'x', unlessHeader: HEADER }), 'empty');
    assert.equal((await forge.reply({ repo: 'guide-docs', number: 1, comment: 50, body: 'Fixed.' })).replied, false);
    const r = await forge.reviewOnLines({ repo: 'guide-docs', number: 1, commit: 'c0ffee0', comments: [{ path: 'docs/a.md', line: 3, body: 'Place to check' }] });
    assert.deepEqual(r.skipped.map((x) => x.existing), [52]);
    assert.equal(adapter.log.filter((x) => ['comment', 'reply', 'review'].includes(x[0])).length, 0, JSON.stringify(mark));
  }
});

test('settings: the comment header is read from the top of the shared file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-'));
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'ticket-flow.json'), JSON.stringify(settingsJson({ commentHeader: HEADER })));
  assert.equal((await loadSettings({ root })).forge.commentHeader, HEADER);
  assert.throws(() => validateForge(settingsJson().forge, settingsJson().targets, 'two\nlines'), /commentHeader must be one line/);
});

test('setStageLabel: adds the new stage label and removes the previous one in one request, leaving the owner\'s labels alone', async () => {
  const { forge, calls } = setup({ routes: { 'graphql PrByNumber': fixture('gql-pr-7-finalreview') } });
  const r = await forge.setStageLabel({ target: 'guide', number: 7, stage: 'finalReview' });
  assert.deepEqual([r.repo, r.label, r.added, r.removed, r.changed], ['guide-docs', 'In final review', ['In final review'], ['in SME review'], true]);
  const mutations = calls.filter((c) => c.mutation);
  assert.equal(mutations.length, 1);
  assert.deepEqual(labelChange(mutations[0]), { add: ['In final review'], remove: ['in SME review'] });
  // `ship it` and `Check me` stood on the PR and are not in the change
  assert.match(mutations[0].query, /addLabelsToLabelable[\s\S]*removeLabelsFromLabelable/);
});

test('setStageLabel: works whoever moved the card — it reads the labels as they are and needs no record of who set them', async () => {
  // the owner moved the card and swapped nothing; two stage labels are on the PR, one of them from a person
  const both = fixture('gql-pr-7');
  both.data.repository.pullRequest.labels.nodes = [{ name: 'in progress' }, { name: 'in SME review' }, { name: 'ship it' }];
  const { forge, calls } = setup({ routes: { 'graphql PrByNumber': both } });
  const r = await forge.setStageLabel({ target: 'guide', number: 7, stage: 'finalReview' });
  assert.deepEqual(r.removed.sort(), ['in SME review', 'in progress']);
  assert.deepEqual(labelChange(calls.find((c) => c.mutation)).remove.sort(), ['in SME review', 'in progress']);
  // a PR with no stage label just gets the new one
  const bare = setup({ routes: { 'graphql PrByNumber': fixture('gql-pr-7-no-labels') } });
  const b = await bare.forge.setStageLabel({ target: 'guide', number: 7, stage: 'inProgress' });
  assert.deepEqual([b.added, b.removed], [['in progress'], []]);
  assert.deepEqual(labelChange(bare.calls.find((c) => c.mutation)), { add: ['in progress'], remove: [] });
});

test('setStageLabel: a PR already at the stage changes nothing; a stage the target does not name, another repo\'s target and an unknown stage are refused', async () => {
  const at = setup({ routes: { 'graphql PrByNumber': fixture('gql-pr-7-has-stage-final') } });
  const r = await at.forge.setStageLabel({ target: 'guide', number: 7, stage: 'finalReview' });
  assert.deepEqual([r.changed, r.added, r.removed], [false, [], []]);
  assert.equal(at.calls.length, 1);
  const { forge, calls } = setup();
  await rejects(forge.setStageLabel({ repo: 'api-docs', target: 'guide', number: 7, stage: 'review' }), 'notAllowed');
  await rejects(forge.setStageLabel({ target: 'guide', number: 7, stage: 'merged' }), 'unknown');
  await rejects(forge.setStageLabel({ target: 'nobody', number: 7, stage: 'review' }), 'unknown');
  const partial = validateForge(settingsJson().forge, [{ id: 'half', repo: 'guide-docs', labels: { review: 'in SME review' } }]);
  const half = setup({ settings: partial });
  await rejects(half.forge.setStageLabel({ target: 'half', number: 7, stage: 'finalReview' }), 'notNamed');
  assert.equal(calls.length, 0);
});

test('setStageLabel: the optional translation stage takes the final review label off and gives it back; a target without it refuses the stage', async () => {
  const s = settingsJson();
  const withTranslation = validateForge(s.forge, s.targets.map((t) => (t.id === 'guide' ? { ...t, labels: { ...guideLabels, translation: 'in translation' } } : t)));
  assert.ok(withTranslation.addable.has('in translation') && withTranslation.removable.has('in translation'));
  const adapter = memoryAdapter();
  const forge = createForge({ adapter, forge: withTranslation });
  await forge.setStageLabel({ target: 'guide', number: 1, stage: 'finalReview' });
  const into = await forge.setStageLabel({ target: 'guide', number: 1, stage: 'translation' });
  assert.deepEqual([into.label, into.added, into.removed], ['in translation', ['in translation'], ['In final review']]);
  assert.deepEqual(adapter.log.at(-1), ['changeLabels', ['in translation'], ['In final review']], 'one request');
  const back = await forge.setStageLabel({ target: 'guide', number: 1, stage: 'finalReview' });
  assert.deepEqual([back.added, back.removed], [['In final review'], ['in translation']]);
  assert.deepEqual((await forge.prState({ repo: 'guide-docs', number: 1 })).labels, ['In final review']);
  // A target that names no translation label: the stage is refused before any request.
  const before = adapter.log.length;
  await rejects(forge.setStageLabel({ target: 'api', number: 1, stage: 'translation' }), 'notNamed');
  const plain = createForge({ adapter, forge: forgeSettings() });
  await rejects(plain.setStageLabel({ target: 'guide', number: 1, stage: 'translation' }), 'notNamed');
  assert.equal(adapter.log.length, before);
});

test('setStageLabel: two targets of one repo keep their own review labels; a label shared by two stages is never removed', async () => {
  const api = fixture('gql-pr-7');
  api.data.repository.pullRequest.labels.nodes = [{ name: 'In tech review' }, { name: 'In SME review' }];
  const { forge } = setup({ routes: { 'graphql PrByNumber': api, 'graphql LabelTargets': { data: { repository: { pullRequest: { id: 'P' }, labels: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'a', name: 'In progress' }, { id: 'b', name: 'In tech review' }, { id: 'c', name: 'In final review' }, { id: 'd', name: 'In SME review' }] } } } } } });
  // the `api` target's chain: its review label goes, the other target's review label is not its to remove
  const r = await forge.setStageLabel({ target: 'api', number: 7, stage: 'finalReview' });
  assert.deepEqual([r.added, r.removed], [['In final review'], ['In tech review']]);
  const same = validateForge(settingsJson().forge, [{ id: 'same', repo: 'guide-docs', labels: { inProgress: 'wip', review: 'WIP', finalReview: 'done' } }]);
  const repoLabels = { data: { repository: { pullRequest: { id: 'P' }, labels: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'LA_1', name: 'wip' }, { id: 'LA_9', name: 'done' }] } } } };
  const onPr = fixture('gql-pr-7');
  onPr.data.repository.pullRequest.labels.nodes = [{ name: 'wip' }];
  const s = setup({ settings: same, routes: { 'graphql PrByNumber': onPr, 'graphql LabelTargets': repoLabels } });
  const swapped = await s.forge.setStageLabel({ target: 'same', number: 7, stage: 'review' });
  // `WIP` is `wip` to GitHub: the label the PR has is the new stage's own and stays
  assert.deepEqual([swapped.added, swapped.removed, swapped.changed], [[], [], false]);
});

test('no call adds a label the settings do not name — the owner\'s label cannot be set by any operation', async () => {
  const named = new Set([...forgeSettings().addable.values()].map((n) => n.toLowerCase()));
  const everything = {
    ...reviewRoutes(),
    'graphql PrsByHead': fixture('gql-prs-by-head-none'),
    'POST repos/acme-docs/guide-docs/pulls': fixture('rest-create-pull'),
    'POST repos/acme-docs/guide-docs/issues/8/assignees': {},
    'POST repos/acme-docs/guide-docs/pulls/8/requested_reviewers': {},
  };
  const { forge, calls } = setup({ routes: everything });
  const attempts = [];
  for (const label of ['ship it', 'Ship It', ' ship it ', 'Check me', 'in progress']) {
    attempts.push(forge.addLabel({ repo: 'guide-docs', number: 7, label }));
    attempts.push(forge.openPr({ repo: 'guide-docs', head: 'docs/z', base: 'main', title: 'T', labels: [label] }));
  }
  for (const target of ['guide', 'api', 'api-ui']) for (const stage of ['inProgress', 'review', 'finalReview', 'ship it', '']) attempts.push(forge.setStageLabel({ target, repo: undefined, number: 7, stage }));
  await Promise.allSettled(attempts);
  const added = calls.filter((c) => c.mutation).flatMap((c) => labelChange(c).add);
  assert.ok(added.length > 0, 'the run changed some labels');
  for (const name of added) assert.ok(named.has(name.toLowerCase()), `'${name}' was added but no setting names it`);
  assert.ok(!added.some((n) => n.toLowerCase() === 'ship it'));
  // and nothing else in a request carries a label: no REST label path is ever used
  assert.ok(!calls.some((c) => /\/labels/.test(c.path ?? '')));
});

// ------------------------------------------------------------------ the rules about what the module cannot do

test('the module has these operations and no others (AC-3)', () => {
  const { forge } = setup();
  const methods = Object.keys(forge).filter((k) => typeof forge[k] === 'function').sort();
  assert.deepEqual(methods, [...OPERATIONS, 'settings'].sort());
  assert.deepEqual(forge.settings().operations, OPERATIONS);
  const { adapter } = setup();
  assert.deepEqual(Object.keys(adapter).filter((k) => typeof adapter[k] === 'function').sort(), [...READS, ...WRITES].sort());
});

// `resolveReviewThread` is in the source once, behind the module's check that the thread is the pipeline's own (its own
// test below); undoing a settle is never there.
const FORBIDDEN = [
  /unresolveReviewThread/i, /dismiss/i, /approve/i, /request_?changes/i, /\bAPPROVE\b/,
  /mergePullRequest/i, /\/merge\b/, /enablePullRequestAutoMerge/i, /closePullRequest/i, /deleteRef/i, /git\/refs/i,
  /pulls\/\d+\/reviews\/\d+\/(?:events|dismissals)/, /\bgh\s+pr\s+(?:merge|close|review)\b/,
];
const sourceFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'test' || e.name === 'node_modules' ? [] : sourceFiles(p);
    return e.name.endsWith('.mjs') ? [p] : [];
  });

test('the source has no call that dismisses a review, gives a verdict, merges, closes or deletes a branch (AC-3, grep); one settle and one removal, of the pipeline\'s own only', () => {
  const files = sourceFiles(ROOT);
  assert.ok(files.length >= 8);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const re of FORBIDDEN) assert.ok(!re.test(text), `${path.relative(ROOT, file)} matches ${re}`);
  }
  // the one review event the source names is COMMENT
  const events = files.flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/\bevent:\s*'([A-Z_]+)'/g)].map((m) => m[1]));
  assert.deepEqual(events, ['COMMENT']);
  // the only DELETE the source sends removes one conversation comment; the only settle is one thread
  const methods = files.flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/gh\.write\('([A-Z]+)'/g)].map((m) => m[1]));
  assert.ok(methods.length > 0 && !methods.includes('PUT'));
  assert.equal(methods.filter((m) => m === 'DELETE').length, 1);
  const deletes = files.flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/gh\.write\('DELETE', `([^`]+)`/g)].map((m) => m[1]));
  assert.deepEqual(deletes, ['${repoPath(repo)}/issues/comments/${id}']);
  const settles = files.flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/resolveReviewThread/g)].map(() => path.relative(ROOT, f)));
  assert.deepEqual(settles, [path.join('adapters', 'github', 'index.mjs')]);
});

test('every operation, run in full, sends no request that withdraws, approves, merges, closes or deletes a branch (AC-3, recorded calls); the one settle and the one removal are the pipeline\'s own', async () => {
  const { forge, calls } = setup({
    settings: forgeSettings(undefined, OWN_HEADER),
    routes: {
      ...reviewRoutes(),
      'graphql PrsByHead': fixture('gql-prs-by-head-none'),
      'graphql PrReviews': fixture('gql-reviews'),
      'graphql PrThreads': fixture('gql-threads'),
      'graphql PrComments': fixture('gql-comments'),
      'graphql ChangedPrs': fixture('gql-changed-page1'),
      'POST repos/acme-docs/guide-docs/pulls': fixture('rest-create-pull'),
      'POST repos/acme-docs/guide-docs/issues/8/assignees': {},
      'POST repos/acme-docs/guide-docs/pulls/8/requested_reviewers': {},
      'POST repos/acme-docs/guide-docs/pulls/7/requested_reviewers': {},
      'PATCH repos/acme-docs/guide-docs/pulls/7': fixture('rest-edit-pull'),
      'GET repos/acme-docs/guide-docs/pulls/comments/601': fixture('rest-pull-comment-601'),
      'POST repos/acme-docs/guide-docs/pulls/7/comments/601/replies': fixture('rest-reply-created'),
      'POST repos/acme-docs/guide-docs/issues/7/comments': fixture('rest-issue-comment-created'),
      'GET repos/acme-docs/guide-docs/issues/events': [],
      ...ownRoutes(),
    },
  });
  const ok = { repo: 'guide-docs', number: 7 };
  await forge.openPr({ repo: 'guide-docs', head: 'docs/n', base: 'main', title: 'T', reviewers: ['rev-one'], labels: ['in progress'] });
  await forge.editPr({ ...ok, title: 'New title' });
  await forge.prState(ok);
  await forge.changedPrsSince({ repo: 'guide-docs', since: '2026-11-04T10:00:00Z' });
  await forge.prActivity(ok);
  await forge.eventsSince({ repo: 'guide-docs', since: '2026-11-04T10:00:00Z' });
  await forge.requestReviewers({ ...ok, logins: ['rev-two'] });
  await forge.reviewOnLines({ ...ok, commit: HEAD7, comments: [{ path: 'docs/export.md', line: 12, body: 'q' }] });
  await forge.reply({ ...ok, comment: 601, body: 'a' });
  await forge.suggest({ ...ok, comment: 601, replacement: 'r' });
  await forge.comment({ ...ok, body: 'c' });
  await forge.addLabel({ ...ok, label: 'Check me' });
  await forge.removeLabel({ ...ok, label: 'in SME review' });
  await forge.setStageLabel({ target: 'guide', ...ok, stage: 'finalReview' });
  await forge.resolveThread({ ...ok, comment: 701, own: [701] });
  await forge.deleteComment({ ...ok, comment: 9300, own: [9300] });
  const sent = writes(calls);
  assert.ok(sent.length >= 12);
  assert.ok(sent.every((c) => ['POST', 'PATCH'].includes(c.method ?? 'POST') || (c.method === 'DELETE' && /\/issues\/comments\/9300$/.test(c.path))), 'only POST and PATCH, and the one DELETE of the pipeline\'s own comment');
  const allowedPaths = [
    /\/pulls$/, /\/pulls\/\d+$/, /\/issues\/\d+\/assignees$/, /\/pulls\/\d+\/requested_reviewers$/, /\/pulls\/\d+\/reviews$/,
    /\/pulls\/\d+\/comments\/\d+\/replies$/, /\/issues\/\d+\/comments$/, /\/issues\/comments\/9300$/,
  ];
  for (const c of sent) {
    if (c.kind === 'graphql') assert.ok(['ChangeLabels', 'ResolveThread'].includes(c.op), c.op);
    else assert.ok(allowedPaths.some((re) => re.test(c.path)), `unexpected write to ${c.path}`);
    for (const re of FORBIDDEN) assert.ok(!re.test(`${c.path ?? ''} ${c.query ?? ''} ${JSON.stringify(c.body ?? c.variables)}`), `${c.key} matches ${re}`);
  }
  assert.equal(sent.find((c) => c.path?.endsWith('/reviews')).body.event, 'COMMENT');
});

test('the CLI has no command to approve, dismiss, unresolve, merge, close or delete a branch or a review', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'ticket-flow.json'), JSON.stringify(settingsJson()));
  const out = { write() {} };
  for (const word of ['approve', 'dismiss-review', 'unresolve-thread', 'resolve', 'merge', 'close', 'delete-branch', 'delete-review', 'request-changes']) {
    assert.ok(!COMMANDS.includes(word), word);
    await assert.rejects(main([word, '--repo', 'guide-docs', '--number', '7', '--root', root], { stdout: out }), /unknown command/);
  }
  // an option for a verdict does not exist either
  await assert.rejects(main(['comment', '--repo', 'guide-docs', '--number', '7', '--body', 'x', '--event', 'APPROVE', '--root', root], { stdout: out }));
  assert.ok(!Object.keys(OPTIONS).some((o) => /event|verdict|approve|merge/.test(o)));
});

// ------------------------------------------------------------------ dry run and the interface

test('--dry-run: reads still run, every change is recorded and not sent, and the fake ids say so', async () => {
  const { forge, calls, gh } = setup({
    dryRun: true,
    routes: { ...reviewRoutes(), 'graphql PrsByHead': fixture('gql-prs-by-head-none') },
  });
  const opened = await forge.openPr({ repo: 'guide-docs', head: 'docs/dry', base: 'main', title: 'T', body: 'B', reviewers: ['rev-one'], labels: ['in progress'] });
  assert.equal(opened.created, true);
  assert.equal(opened.number, 0);
  assert.match(String(opened.posted[0].id), /^dry-run-/);
  const rev = await forge.reviewOnLines({ repo: 'guide-docs', number: 7, commit: HEAD7, comments: [{ path: 'docs/export.md', line: 12, body: 'q' }] });
  assert.match(String(rev.reviewId), /^dry-run-/);
  assert.deepEqual(rev.commentIds.map(String), ['dry-run-comment-1']);
  await forge.setStageLabel({ target: 'guide', number: 7, stage: 'finalReview' });
  assert.equal(writes(calls).length, 0, 'nothing reached gh');
  assert.deepEqual(gh.calls.map((c) => c.path), [
    'repos/acme-docs/guide-docs/pulls', 'repos/acme-docs/guide-docs/issues/0/assignees', 'repos/acme-docs/guide-docs/pulls/0/requested_reviewers', 'graphql',
    'repos/acme-docs/guide-docs/pulls/7/reviews', 'graphql',
  ]);
  assert.equal(gh.calls[4].body.event, 'COMMENT');
});

test('the module runs over any adapter with the contract: an in-memory one stands for another forge', async () => {
  const adapter = memoryAdapter();
  assertAdapter(adapter);
  assert.throws(() => assertAdapter({ kind: 'half', pr() {} }), /lacks: .*changeLabels/);
  const forge = createForge({ adapter, forge: forgeSettings() });
  const s = await forge.prState({ repo: 'guide-docs', number: 1 });
  assert.equal(s.headCommit, 'c0ffee0');
  const opened = await forge.openPr({ repo: 'guide-docs', head: 'topic-b', base: 'main', title: 'Second', labels: ['in progress'] });
  assert.equal(opened.created, true);
  assert.equal((await forge.openPr({ repo: 'guide-docs', head: 'topic-a', base: 'main', title: 'Again' })).created, false);
  await forge.setStageLabel({ target: 'guide', number: 1, stage: 'review' });
  assert.deepEqual(adapter.log.at(-1), ['changeLabels', ['in SME review'], ['in progress']]);
  const r = await forge.reviewOnLines({ repo: 'guide-docs', number: 1, commit: 'c0ffee0', comments: [{ path: 'docs/a.md', line: 2, body: 'q' }] });
  assert.deepEqual(r.posted, [{ kind: 'review', id: 77 }, { kind: 'review-comment', id: 780 }]);
  await rejects(forge.reviewOnLines({ repo: 'guide-docs', number: 1, commit: 'c0ffee0', comments: [{ path: 'docs/a.md', line: 9, body: 'q' }] }), 'outsideDiff');
});

test('the adapter registry: github is there; an unknown kind is refused', () => {
  assert.deepEqual(kinds(), ['github']);
  assert.throws(() => createAdapter({ kind: 'gitlab', owner: OWNER }, {}), (e) => e instanceof CliError && e.exitCode === 2 && /no adapter for forge kind 'gitlab'/.test(e.message));
  const made = createAdapter(forgeSettings(), { runner: async () => ({ code: 0, stdout: '{}', stderr: '' }) });
  assertAdapter(made.adapter);
});

test('normalizePr: a PR in GraphQL\'s shape to the module\'s', () => {
  const p = normalizePr(fixture('gql-pr-9-merged').data.repository.pullRequest);
  assert.equal(p.state, 'merged');
  assert.equal(p.mergeCommit, 'bb22cc33dd44ee55ff6677889900aabbccddeeff');
  assert.equal(normalizePr(null), null);
});

// ------------------------------------------------------------------ the CLI, through a stand-in `gh` on PATH

async function cli(args, { routes = {}, env = {}, files = {} } = {}) {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'ticket-flow.json'), JSON.stringify(settingsJson()));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(HERE, 'gh-stand-in.mjs')}" "$@"\n`, { mode: 0o755 });
  const routesFile = path.join(root, 'routes.json');
  const log = path.join(root, 'calls.log');
  fs.writeFileSync(routesFile, JSON.stringify({ ...baseRoutes(), ...routes }));
  fs.writeFileSync(log, '');
  let res;
  try {
    res = await run(process.execPath, [CLI, ...args, '--root', root], { cwd: root, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GH_ROUTES: routesFile, FAKE_GH_LOG: log, ...env } });
  } catch (e) {
    res = e;
  }
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { code: res.code ?? 0, stdout: res.stdout, stderr: res.stderr, json: res.stdout ? JSON.parse(res.stdout) : null, calls };
}

test('CLI: a read prints JSON on stdout and exits 0', async () => {
  const r = await cli(['pr-state', '--repo', 'guide-docs', '--number', '7']);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.command, 'pr-state');
  assert.equal(r.json.headCommit, HEAD7);
  assert.ok(r.calls.every((c) => c.args[0] === 'api'), 'only `gh api` was run');
});

test('CLI: a refusal exits 2 with `refused` in the JSON, and nothing was sent', async () => {
  const r = await cli(['add-label', '--repo', 'guide-docs', '--number', '7', '--label', 'ship it']);
  assert.equal(r.code, 2);
  assert.deepEqual([r.json.ok, r.json.refused], [false, 'notNamed']);
  assert.equal(r.calls.length, 0);
  const other = await cli(['pr-state', '--repo', 'not-a-target', '--number', '7']);
  assert.deepEqual([other.code, other.json.refused], [2, 'notAllowed']);
  const usage = await cli(['pr-state', '--repo', 'guide-docs']);
  assert.equal(usage.code, 2);
  const unknown = await cli(['frobnicate']);
  assert.equal(unknown.code, 2);
});

test('CLI: a failed gh call exits 1; a token in the failure never reaches stdout or stderr', async () => {
  const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
  const r = await cli(['pr-state', '--repo', 'guide-docs', '--number', '7'], {
    routes: { 'graphql PrByNumber': ghFail(401, 'Bad credentials') },
    env: { GH_TOKEN: secret, FAKE_GH_LEAK: `token ${secret}` },
  });
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false);
  assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret));
  assert.match(r.stderr, /HTTP 401/);
});

test('CLI: --dry-run prints each change in calls[] and runs no change; --body-file and --comments-file are read exactly', async () => {
  const text = `First line${ZWNJ}\n\n   indented  \n`;
  const r = await cli(['comment', '--repo', 'guide-docs', '--number', '7', '--body-file', 'body.txt', '--dry-run'], { files: { 'body.txt': text } });
  assert.equal(r.code, 0);
  assert.equal(r.json.dryRun, true);
  assert.deepEqual(r.json.calls, [{ method: 'POST', path: 'repos/acme-docs/guide-docs/issues/7/comments', body: { body: text } }]);
  assert.equal(r.calls.length, 0);
  const rev = await cli(['review-on-lines', '--repo', 'guide-docs', '--number', '7', '--commit', HEAD7, '--comments-file', 'c.json', '--dry-run'], {
    files: { 'c.json': JSON.stringify([{ path: 'docs/export.md', line: 12, body: 'q' }]) },
    routes: reviewRoutes(),
  });
  assert.equal(rev.code, 0);
  assert.equal(rev.json.calls[0].body.event, 'COMMENT');
  assert.ok(rev.calls.every((c) => !c.write && !c.mutation));
  const both = await cli(['comment', '--repo', 'guide-docs', '--number', '7', '--body', 'a', '--body-file', 'b.txt'], { files: { 'b.txt': 'b' } });
  assert.equal(both.code, 2);
  const badJson = await cli(['review-on-lines', '--repo', 'guide-docs', '--number', '7', '--commit', HEAD7, '--comments-file', 'c.json'], { files: { 'c.json': '{ nope' } });
  assert.equal(badJson.code, 2);
});

test('CLI: the settings command shows what the module may touch', async () => {
  const r = await cli(['settings']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.repos, ['guide-docs', 'api-docs']);
  assert.ok(r.json.addableLabels.includes('Check me'));
  assert.ok(!r.json.addableLabels.includes('ship it'));
  assert.ok(r.json.removableLabels.includes('Check me'));
  assert.equal(r.calls.length, 0);
});

test('README: documents every command, every flag and every exit code', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  for (const c of COMMANDS) assert.ok(readme.includes(`\`${c}`), `command ${c}`);
  for (const o of Object.keys(OPTIONS)) assert.ok(readme.includes(`--${o}`), `flag --${o}`);
  for (const op of OPERATIONS) assert.ok(readme.includes(op), `operation ${op}`);
  assert.match(readme, /`0` ok/);
  assert.match(readme, /`2` bad usage/);
  assert.match(readme, /`1` a call to the forge failed/);
});
