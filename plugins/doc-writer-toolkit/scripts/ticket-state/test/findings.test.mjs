import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BOARD, LISTS, NOW, WATCH, ago, card, pr, rawSettings, settingsFor, tmp } from './fakes.mjs';
import { ledger, read, world } from './helpers.mjs';
import { runRecord } from '../lib/record.mjs';
import { briefFor, commandFor, runDaily } from '../lib/runner.mjs';
import { parseUsage } from '../lib/allowance.mjs';
import { DEFAULT_LABELS, renderSections } from '../lib/pr-description.mjs';
import { SCRIPT_COMMANDS, refusalOf } from '../lib/role-hook.mjs';
import { HOOK_VARIABLE } from '../lib/role-hook.mjs';
import { checkFindings, fingerprint, findingsPath, followFindings, readFindings, renderTemplate } from '../lib/findings.mjs';
import { validateSettings } from '../lib/settings.mjs';

// Findings outside the ticket (TASK-050): a session's side finding becomes a card in the intake list, linked to the
// ticket, never a line of the PR's open questions; a finding an open card holds already is linked, not filed again; a
// note goes to the run report; a question about the ticket stays in the open questions. An invented host and invented
// texts throughout.

const HEADER = '🤖 **[BOT]**';
const HEAD = 'b'.repeat(40);
const PAGE = 'docs/x/a.md';
const TEMPLATE_CARD = {
  name: '<kind>: <title>',
  desc: '## Description\n\n<text>\n\n- **Where:** <where>\n- **Page:** `<repo>` `<page>`\n- **Sources:** <refs>\n- **Found while on:** <ticket>\n- **PR:** <pr>',
  onTicket: 'Outside the ticket: <kind>, a card of its own: <card>',
  onExisting: 'Seen again while on <ticket>: <title>',
  kinds: { page: 'Docs', ui: 'Undocumented UI', appBug: 'App bug' },
};
const withCard = (extra = {}) => ({ commentHeader: HEADER, tracker: { ...rawSettings().tracker, findingCard: TEMPLATE_CARD }, ...extra });
const ROUNDS = (extra = {}) => withCard({ forge: { ...rawSettings().forge, triggerWords: ['helper'], reviewRounds: { labels: { readers: { developer: 'For the developer', writer: 'For the writer' } } } }, ...extra });
const BASE = { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' };
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 4, total_cost_usd: 0.5, duration_ms: 60000, session_id: 'session-1', usage: { input_tokens: 100, output_tokens: 50 }, permission_denials: [] });
const usage = () => parseUsage('Current session: 5% used · resets 2pm (UTC)\nCurrent week (all models): 5% used · resets Nov 14 at 6am (UTC)\n');
const tree = () => ({ repo: 'x', branch: 'y', path: '/nowhere', push: '', linked: [], missing: [], notes: [], stuck: [] });
const at = ago(1);
const comment = (id, author, body, extra = {}) => ({ id, author, body, createdAt: at, updatedAt: at, ...extra });
const BODY = ['## Description', '', 'Two sentences a person wrote.', '', '## Open questions', '', '<!-- ticket-flow:questions -->', '<!-- /ticket-flow:questions -->', '', '## Places', '', '<!-- ticket-flow:places -->', '<!-- /ticket-flow:places -->', '', '<!-- ticket-flow:rounds -->', '<!-- /ticket-flow:rounds -->'].join('\n');

// A side finding on another page, as a session records it.
const OTHER_PAGE = { kind: 'page', title: 'The export page still lists five interface languages', text: 'The page lists five languages; the cabinet offers ten since the last release.', repo: 'guide-docs', page: 'docs/settings/languages.md', where: 'Interface language', refs: ['docs/settings/languages.md#L12'] };
const QUESTION = { text: 'Is the limit 50 for every payment method?', reader: 'developer', why: 'The code has one constant; no test request reached the limit.' };

// A ticket in the owner's queue with one PR in review rounds, whose next step is a round of the owner's comments.
function roundWorld(number, extra = {}) {
  const c = card({ number, status: 'finalReview' });
  const forgePr = pr({ repo: 'guide-docs', number: 81, headCommit: HEAD });
  forgePr.body = BODY;
  const activity = { 'guide-docs#81': { threads: [{ id: 'T7301', resolved: false, comments: [comment(7301, 'owner-login', `${HEADER}\n\nA place to check`, { reviewId: 6100 }), comment(7303, 'owner-login', 'helper: the expert confirmed it.', { reviewId: 6301 })] }], comments: [] } };
  const w = world({ cards: [c, ...(extra.cards ?? [])], prs: [forgePr], activity, extra: ROUNDS(extra.settings) });
  ledger(w, c, {
    stages: BASE,
    prs: [{ repo: 'guide-docs', number: 81, url: 'https://forge.example/acme/guide-docs/pull/81', targets: ['guide'], review: 'sme', stage: 'finalReview', rounds: [{ n: 1, stage: 'pr', at: ago(40), seq: 1, commits: [], review: 501, comments: 1 }] }],
    posted: { pr: [501, 7301], card: [] },
    places: [{ id: 'p1', repo: 'guide-docs', pr: 81, page: PAGE, line: 12, claim: 'The limit is 50 for every method', state: 'open', commentId: 7301 }],
  });
  return { c, forgePr, w };
}

// A ticket with a ledger and nothing pending: a record on it, then the runner's routing after the step.
function plainTicket(w, number, status = 'inProgress') {
  const c = card({ number, status });
  w.tracker.cards.push(c);
  ledger(w, c, { stages: { start: 'done', plan: 'done' } });
  return c;
}
const findingsOf = (w, key, sideFindings, stage = 'write') => runRecord({ settings: w.settings, clients: w.clients(), key, stage, status: 'failed', note: 'stopped after the finding', result: JSON.stringify({ sideFindings }), now: NOW });
const route = (w, keys) => followFindings({ settings: w.settings, clients: w.clients(), keys, now: NOW });
const created = (w) => w.tracker.log.filter((x) => x[0] === 'createCard');
// The comments posted on a card, from the stand-in's log of writes.
const commentsOn = (w, c) => w.tracker.log.filter((x) => x[0] === 'comment' && (x[1] === c.id || x[1] === c.shortLink)).map((x) => x[2]);

// ------------------------------------------------------------------ AC: a side finding is a card, not a PR line

test('AC: a round\'s side finding becomes a card in the intake list, linked both ways, and no line of the PR\'s open questions; its question about the ticket stays there; its note goes to the run report', async () => {
  const { c, forgePr, w } = roundWorld(1301);
  const spawnClaude = async () => {
    await runRecord({ settings: w.settings, clients: w.clients(), key: '1301', stage: 'answerComments', pr: 'guide-docs#81', status: 'done', now: NOW, result: JSON.stringify({
      handled: [{ id: 7303, updatedAt: at }],
      review: { id: 7800, commits: [] },
      places: [{ id: 'p1', state: 'confirmed', replyId: 7304 }],
      questions: [],
      asked: [QUESTION],
      sideFindings: [OTHER_PAGE, { kind: 'note', text: 'The test cabinet shows the old menu until the cache is cleared.' }],
      posted: [7800, 7304],
    }) });
    return { code: 0, stdout: RESULT, stderr: '' };
  };
  const out = await runDaily({ settings: w.settings, clients: w.clients(), io: { readUsage: usage, now: () => NOW, ensureWorktree: tree, spawnClaude }, options: { morning: false, trigger: 'watch', named: ['1301'] } });
  assert.deepEqual(out.ran.map((r) => [r.stage, r.outcome]), [['answerComments', 'done']]);

  // The PR: the question, and nothing of the finding or the note.
  assert.match(forgePr.body, /\*\*\d+\.\*\* Is the limit 50 for every payment method\?/);
  assert.ok(!forgePr.body.includes('five interface languages') && !forgePr.body.includes('languages.md') && !forgePr.body.includes('cache is cleared'), forgePr.body);

  // The tracker: one card in the intake list, its text from the host's template, naming the ticket and the PR.
  const made = created(w);
  assert.equal(made.length, 1);
  const [, placeId, name, desc] = made[0];
  assert.equal(placeId, LISTS.intake.id);
  assert.equal(name, 'Docs: The export page still lists five interface languages');
  assert.equal(desc, ['## Description', '', OTHER_PAGE.text, '', '- **Where:** Interface language', '- **Page:** `guide-docs` `docs/settings/languages.md`', '- **Sources:** docs/settings/languages.md#L12', `- **Found while on:** ${c.url}`, '- **PR:** https://forge.example/acme/guide-docs/pull/81'].join('\n'));
  const filed = w.tracker.cards.at(-1);
  assert.deepEqual(commentsOn(w, c), [`${HEADER}\n\nOutside the ticket: Docs, a card of its own: ${filed.url}`], "the ticket's card links the new card, with the comment header");

  // The registry and the run report.
  const lines = readFindings(w.settings.state);
  assert.deepEqual(lines.map((x) => [x.ticket, x.id, x.outcome, x.card?.url ?? null]), [['1301', 'f1', 'filed', filed.url], ['1301', 'f2', 'noted', null]]);
  assert.ok(out.log.some((e) => e.kind === 'findings' && e.outcome === 'filed'), 'the run log says what was filed');
  const report = fs.readFileSync(path.join(w.settings.root, out.reportFile), 'utf8');
  assert.match(report, /## Findings outside the tickets\n\n- 1301: page «The export page still lists five interface languages», filed: https:\/\/tracker\.example\/c\/\S+\n- 1301: note: The test cabinet shows the old menu until the cache is cleared\./);

  // Routed once: the next step of the ticket files nothing again.
  await route(w, ['1301']);
  assert.equal(created(w).length, 1);
  assert.equal(commentsOn(w, c).length, 1);
});

test('AC: a question about the ticket stays in the open questions, and the pr record keeps the finding apart from them', async () => {
  const c = card({ number: 1302, status: 'finalReview' });
  const w = world({ cards: [c], prs: [pr({ repo: 'guide-docs', number: 82, head: 'ticket-1302', headCommit: HEAD })], extra: ROUNDS() });
  ledger(w, c, { stages: BASE, prs: [{ repo: 'guide-docs', branch: 'ticket-1302', targets: ['guide'], review: 'sme', stage: 'writing' }] });
  await runRecord({ settings: w.settings, clients: w.clients(), key: '1302', stage: 'pr', status: 'done', now: NOW, result: JSON.stringify({
    prs: [{ repo: 'guide-docs', branch: 'ticket-1302', number: 82, expertReview: { recommended: true, why: 'one question only the developer can answer' }, review: { id: 501 }, questions: [QUESTION] }],
    sideFindings: [{ kind: 'appBug', title: 'The bank list accepts a bank that is not on it', text: 'A test request with a bank outside the list returned 200, then the transaction failed.', where: 'PUT /t/:otp/banks' }],
    posted: [501],
  }) });
  const l = read(w, '1302');
  assert.deepEqual(l.prs[0].questions.map((q) => q.text), [QUESTION.text]);
  assert.deepEqual(l.sideFindings.map((f) => [f.id, f.kind, f.stage, f.pr]), [['f1', 'appBug', 'pr', 'guide-docs#82']]);
  const sections = renderSections(l, { ...l.prs[0], url: 'https://forge.example/acme/guide-docs/pull/82' }, DEFAULT_LABELS);
  assert.match(sections.questions, /Is the limit 50/);
  assert.ok(!sections.questions.includes('bank list') && !sections.places.includes('bank list'));
});

// ------------------------------------------------------------------ AC: no duplicates

test('AC: the same finding on a second ticket is linked to the open card, not filed again; out of the docs\' scope it still holds it; done since, a new one is filed', async () => {
  const w = world({ extra: withCard() });
  const a = plainTicket(w, 1311);
  const b = plainTicket(w, 1312);
  const d = plainTicket(w, 1313);
  const e = plainTicket(w, 1314);
  await findingsOf(w, '1311', [OTHER_PAGE]);
  await route(w, ['1311']);
  const first = w.tracker.cards.at(-1);
  assert.equal(created(w).length, 1);

  // Another ticket, other words in the text and the title's case and stops changed: the same fingerprint.
  await findingsOf(w, '1312', [{ ...OTHER_PAGE, title: 'the export page still lists FIVE interface languages!', text: 'Seen again from another ticket.' }]);
  const events = await route(w, ['1312']);
  assert.equal(created(w).length, 1, 'no second card');
  assert.deepEqual(events.map((e) => e.outcome), ['linked']);
  assert.deepEqual(commentsOn(w, b), [`${HEADER}\n\nOutside the ticket: Docs, a card of its own: ${first.url}`]);
  assert.deepEqual(commentsOn(w, first), [`${HEADER}\n\nSeen again while on ${b.url}: the export page still lists FIVE interface languages!`], 'the card names the second ticket');
  assert.deepEqual(readFindings(w.settings.state).map((x) => [x.ticket, x.outcome, x.card.url, x.by]), [['1311', 'filed', first.url, undefined], ['1312', 'linked', first.url, 'fingerprint, as 1311 f1']]);
  assert.equal(commentsOn(w, a).length, 1);
  // The pipeline's own comments on a ticket's card are kept as its own, so no rule reads them as a person's.
  for (const k of ['1311', '1312']) assert.equal(read(w, k).posted.card.length, 1, k);

  // Triaged out of the docs' scope: known and decided, so linked again, not raised again.
  first.placeId = LISTS.outOfScope.id;
  await findingsOf(w, '1313', [OTHER_PAGE]);
  assert.deepEqual((await route(w, ['1313'])).map((x) => x.outcome), ['linked']);
  assert.equal(created(w).length, 1);
  assert.equal(commentsOn(w, d).length, 1);
  // Done now: the same finding again is a new card.
  first.placeId = LISTS.done.id;
  await findingsOf(w, '1314', [OTHER_PAGE]);
  await route(w, ['1314']);
  assert.equal(created(w).length, 2);
  const line = readFindings(w.settings.state).at(-1);
  assert.equal(line.outcome, 'filed');
  assert.match(line.notes[0], /the card filed for 1313 f1 \(https:\/\/tracker\.example\/c\/\S+\) is in done/);
  assert.equal(commentsOn(w, e).length, 1);
});

test('AC: a finding the session matched to an open card (an app bug filed by people on another board) is linked, not filed; a card it named that is archived is filed again', async () => {
  const bug = card({ name: 'Uzbek disputes menu reads "conversations"', board: WATCH, list: { id: '5f00000000000000000a0101' } });
  const old = card({ name: 'An old bug', status: 'ready', closed: true });
  const w = world({ cards: [bug, old], extra: withCard() });
  const t = plainTicket(w, 1321);
  const finding = { kind: 'appBug', title: 'The disputes menu has the wrong Uzbek name', text: 'The app string reads "conversations".', where: 'Operator cabinet, uz, the main menu' };
  await findingsOf(w, '1321', [{ ...finding, card: bug.url }, { ...finding, title: 'Another bug', card: old.url }, { ...finding, title: 'A third bug', card: 'https://tracker.example/c/NoSuchCard' }, { ...finding, title: 'A fourth bug', card: t.url }]);
  const events = await route(w, ['1321']);
  assert.deepEqual(events.map((e) => e.outcome), ['linked', 'filed', 'filed', 'filed']);
  assert.equal(created(w).length, 3, 'the ones whose card is archived, gone, or the ticket itself');
  assert.deepEqual(commentsOn(w, bug), [], 'a card on another board gets no comment: the module writes only on its board');
  assert.deepEqual(commentsOn(w, t).map((x) => x.split('\n\n')[1]).slice(0, 2), [`Outside the ticket: App bug, a card of its own: ${bug.url}`, `Outside the ticket: App bug, a card of its own: ${w.tracker.cards.at(-3).url}`]);
  const lines = readFindings(w.settings.state);
  assert.deepEqual(lines.map((x) => [x.outcome, x.by ?? null]), [['linked', 'session'], ['filed', null], ['filed', null], ['filed', null]]);
  assert.equal(read(w, '1321').posted.card.length, 4, "each link comment on the ticket's card is the pipeline's own");
  assert.match(lines[1].notes[0], /the card the session named \(.+\) is archived/);
  assert.match(lines[2].notes[0], /the card the session named \(.+NoSuchCard\) is gone/);
  assert.match(lines[3].notes[0], /is this ticket's own card/);
});

test('a finding whose open card is another ticket: the comment on that card is kept as the pipeline\'s in that ticket\'s ledger, unless another run holds its lock', async () => {
  const w = world({ extra: withCard() });
  const t = plainTicket(w, 1325);
  const other = plainTicket(w, 1326);
  const busy = plainTicket(w, 1327);
  const f = { kind: 'page', title: 'A stale step', text: 'Step 3 names a removed button.', repo: 'guide-docs', page: 'docs/y/b.md' };
  await findingsOf(w, '1325', [{ ...f, card: other.url }, { ...f, title: 'Another stale step', card: busy.url }]);
  const { takeLock } = await import('../lib/locks.mjs');
  takeLock(w.settings.state, { group: '1327', kind: 'schedule', leaseMinutes: 60, now: NOW });
  assert.deepEqual((await route(w, ['1325'])).map((e) => e.outcome), ['linked', 'linked']);
  assert.match(commentsOn(w, other)[0], /Seen again while on https:\/\/tracker\.example\/c\/\S+: A stale step/);
  assert.equal(read(w, '1326').posted.card.length, 1);
  assert.equal(commentsOn(w, busy).length, 1);
  assert.deepEqual(read(w, '1327').posted.card, [], 'another run holds that ticket: its ledger is left to it');
  assert.equal(read(w, '1325').posted.card.length, 2);
  void t;
});

// ------------------------------------------------------------------ no template: no card, a report line

test('with no card template the runner writes nothing on the tracker: the report lists the finding, and the open card that holds it', async () => {
  const w = world({ extra: { commentHeader: HEADER } });
  assert.equal(w.settings.findingCard, null);
  const t = plainTicket(w, 1331);
  const held = card({ name: 'Already filed', status: 'ready' });
  w.tracker.cards.push(held);
  await findingsOf(w, '1331', [OTHER_PAGE, { kind: 'ui', title: 'The archive has a new filter', text: 'No page lists the «Operator» filter.', where: 'Archive, filters', card: held.url }]);
  const events = await route(w, ['1331']);
  assert.deepEqual(events.map((e) => e.outcome), ['unfiled', 'unfiled']);
  assert.equal(created(w).length, 0);
  assert.deepEqual(commentsOn(w, t), []);
  assert.deepEqual(w.tracker.log, [], 'no write at all');
  const { renderFindings } = await import('../lib/findings.mjs');
  const text = renderFindings(readFindings(w.settings.state), () => true).join('\n');
  assert.match(text, /- 1331: page «The export page still lists five interface languages»: The page lists five languages; the cabinet offers ten since the last release\. No card: the host sets no card template \(`tracker\.findingCard`\)\n/);
  assert.match(text, new RegExp(`- 1331: ui «The archive has a new filter»: .+; an open card holds it already: ${held.url.replace(/[.]/g, '\\.')}`));
});

test('a tracker call that fails leaves the finding unrouted, as a failure in the run log, and the next try routes it once', async () => {
  const w = world({ extra: withCard() });
  plainTicket(w, 1341);
  await findingsOf(w, '1341', [OTHER_PAGE]);
  const real = w.tracker.createCard;
  w.tracker.createCard = async () => {
    throw new Error('HTTP 503');
  };
  const failed = await route(w, ['1341']);
  assert.deepEqual(failed.map((e) => [e.outcome, /HTTP 503/.test(e.note)]), [['failed', true]]);
  assert.deepEqual(readFindings(w.settings.state), []);
  w.tracker.createCard = real;
  assert.deepEqual((await route(w, ['1341'])).map((e) => e.outcome), ['filed']);
  assert.deepEqual((await route(w, ['1341'])).map((e) => e.outcome), []);
});

// ------------------------------------------------------------------ the record

test('record: sideFindings are checked before anything is written; a card\'s words never name the toolkit or the model; the same finding again on a ticket is kept once', async () => {
  const w = world({ extra: withCard() });
  plainTicket(w, 1351);
  const bad = async (f, re) => {
    await assert.rejects(findingsOf(w, '1351', [f]), (e) => e.exitCode === 2 && re.test(e.message), JSON.stringify(f));
  };
  await bad({ ...OTHER_PAGE, kind: 'bug' }, /"kind" is one of page, ui, appBug, note/);
  await bad({ ...OTHER_PAGE, repo: undefined }, /a "page" finding names its "repo" and its "page"/);
  await bad({ kind: 'ui', title: 'x', text: 'y' }, /a "ui" finding says "where"/);
  await bad({ kind: 'appBug', text: 'y', where: 'z' }, /needs its "title"/);
  await bad({ ...OTHER_PAGE, title: 'two\nlines' }, /"title" is one line/);
  await bad({ ...OTHER_PAGE, refs: ['.claude/skills/rules.md'] }, /never names the toolkit, the model or their files/);
  await bad({ ...OTHER_PAGE, text: 'Found by Claude.' }, /never names the toolkit/);
  await bad({ ...OTHER_PAGE, text: 'See doc-writer-toolkit for it.' }, /never names the toolkit/);
  await bad({ kind: 'note', text: 'x', card: 'https://tracker.example/c/abc' }, /a note files no card/);
  await bad({ ...OTHER_PAGE, severity: 'high' }, /sideFindings\[0\]\.severity is not a field/);
  await assert.rejects(findingsOf(w, '1351', { kind: 'note' }), (e) => e.exitCode === 2 && /"sideFindings" is a list/.test(e.message));
  assert.equal(read(w, '1351').sideFindings, undefined, 'nothing written by a refused record');
  // A note is the owner's: it may name anything.
  assert.deepEqual(checkFindings([{ kind: 'note', text: 'The Claude session stopped twice.' }]), [{ kind: 'note', text: 'The Claude session stopped twice.' }]);

  await findingsOf(w, '1351', [OTHER_PAGE]);
  await findingsOf(w, '1351', [{ ...OTHER_PAGE, text: 'Said again at a later stage.' }, { kind: 'note', text: 'A note.' }]);
  assert.deepEqual(read(w, '1351').sideFindings.map((f) => [f.id, f.kind, f.text.slice(0, 9)]), [['f1', 'page', 'The page '], ['f2', 'note', 'A note.']]);
  // A page finding is matched by its page and title; another page, another finding.
  assert.notEqual(fingerprint(OTHER_PAGE), fingerprint({ ...OTHER_PAGE, page: 'docs/settings/other.md' }));
  assert.equal(fingerprint(OTHER_PAGE), fingerprint({ ...OTHER_PAGE, page: './docs/settings/languages.md', title: 'The export page — still lists five interface languages.' }));
});

// ------------------------------------------------------------------ the settings and the template

test('settings: the card template is the host\'s, with no default; each text names what links the card and the ticket', () => {
  const root = tmp();
  const load = (findingCard) => validateSettings(rawSettings({ tracker: { ...rawSettings().tracker, findingCard } }), { root, stateRootDefault: '.flow/' });
  assert.equal(load(undefined).findingCard, null);
  assert.deepEqual(load(TEMPLATE_CARD).findingCard, TEMPLATE_CARD);
  assert.deepEqual(load({ ...TEMPLATE_CARD, kinds: undefined }).findingCard.kinds, {});
  for (const [over, re] of [
    [{ desc: 'No link here.' }, /findingCard\.desc must have <ticket> in it/],
    [{ onTicket: 'No card here.' }, /findingCard\.onTicket must have <card> in it/],
    [{ name: 'A card' }, /findingCard\.name must have <title> in it/],
    [{ onExisting: '' }, /findingCard\.onExisting is a text/],
    [{ colour: 'red' }, /findingCard\.colour is not a key/],
    [{ kinds: { bug: 'Bug' } }, /findingCard\.kinds is \{ page, ui, appBug \}/],
  ]) assert.throws(() => load({ ...TEMPLATE_CARD, ...over }), (e) => re.test(e.message), JSON.stringify(over));
});

test('the template: a line whose placeholder has no value is left out', () => {
  assert.equal(renderTemplate('A <title>\n- **Page:** `<repo>` `<page>`\n- **Where:** <where>\n\n\nEnd <ticket>', { title: 'T', repo: '', page: '', where: 'W', ticket: 'K' }), 'A T\n- **Where:** W\n\nEnd K');
  assert.equal(renderTemplate('<kind>: <title>', { kind: 'Docs', title: 'T' }), 'Docs: T');
});

// ------------------------------------------------------------------ the roles: the brief, and no card made by a session

test('the brief tells the writer, the reviewer and the translator where a finding goes, and lists the cards filed for earlier findings; triage gets none', async () => {
  const w = world({ extra: withCard() });
  plainTicket(w, 1361);
  await findingsOf(w, '1361', [OTHER_PAGE]);
  await route(w, ['1361']);
  const filed = w.tracker.cards.at(-1);
  plainTicket(w, 1362);
  for (const [role, stage] of [['writer', 'pr'], ['writer', 'answerComments'], ['reviewer', 'uaReview'], ['translator', 'locales']]) {
    const brief = briefFor({ stage, role, keys: ['1362'] }, w.settings);
    assert.match(brief, /Give it in the record's `sideFindings`/, `${role} ${stage}`);
    assert.match(brief, /Never create a card yourself/);
    assert.ok(brief.includes(`- ${filed.url} page «The export page still lists five interface languages»`), `${role} ${stage}: the filed card is listed`);
  }
  assert.ok(!briefFor({ stage: 'triage', role: 'triage', keys: ['1362'] }, w.settings).includes('sideFindings'));
  // The ticket's own findings are listed so the session doesn't give them again.
  assert.match(briefFor({ stage: 'pr', role: 'writer', keys: ['1361'] }, w.settings), /Already recorded for this ticket \(don't give them again\): page «The export page still lists five interface languages»\./);
});

test('a role never creates a card: tracker create-card is refused in every spelling, and denied by the session\'s rules; its other commands pass', async () => {
  const w = world({ extra: { workFolder: 'work/tickets/<key>' } });
  const roots = ['/runner/toolkit', '/home/.claude/plugins/cache/doc-writer-toolkit/doc-writer-toolkit/abc123'];
  const tr = `node ${roots[1]}/scripts/tracker/tracker.mjs`;
  const tree = { repo: 'guide-docs', branch: 'ticket-71', base: 'main', path: '/work/.worktrees/guide-docs/ticket-71', push: 'git -C /work/.worktrees/guide-docs/ticket-71 push origin HEAD:refs/heads/ticket-71' };
  const cmd = commandFor({ stage: 'write', role: 'writer', keys: ['502'], group: '502', worktrees: [tree] }, w.settings, { agentsPath: '/x/agents.json', roots });
  const cfg = JSON.parse(cmd.env[HOOK_VARIABLE]);
  const root = w.settings.root;
  for (const c of [`${tr} create-card --status intake --name x`, `${tr} --dry-run create-card --status intake --name x`, `${tr} --root ${root} create-card --status intake --name x`, `${tr} --root=${root} create-card --name x`, `${tr} -- create-card --name x`]) {
    assert.match(refusalOf(c, cfg, { cwd: root }) ?? '', /tracker\/tracker\.mjs create-card \(the runner's alone\)/, c);
  }
  for (const c of [`${tr} comment Card0001 --text-file /x/tmp/c.md --unless-header Plan`, `${tr} list-cards --status intake`, `${tr} read-card Card0001`, `${tr} --all-boards find-cards --number 12`]) assert.equal(refusalOf(c, cfg, { cwd: root }), null, c);
  const denied = cmd.args.slice(cmd.args.indexOf('--disallowedTools') + 1);
  assert.ok(denied.includes(`Bash(${tr} create-card:*)`) && denied.includes(`Bash(${tr} * create-card *)`));
  const { OPTIONS } = await import('../../tracker/tracker.mjs');
  const booleans = Object.entries(OPTIONS).filter(([, o]) => o.type === 'boolean').flatMap(([k, o]) => [`--${k}`, ...(o.short ? [`-${o.short}`] : [])]);
  assert.deepEqual([...SCRIPT_COMMANDS['tracker/tracker.mjs'].booleans].sort(), booleans.sort(), "the hook's list of tracker's options with no value");
});
