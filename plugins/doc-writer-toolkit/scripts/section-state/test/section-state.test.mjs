import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { blobHash, withoutDates } from '../lib/ledger.mjs';

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'section-state.mjs');
const git = (cwd, ...args) => run('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim());

async function cli(cwd, ...args) {
  try {
    const { stdout, stderr } = await run('node', [CLI, ...args], { cwd });
    return { code: 0, out: stdout.trim().startsWith('{') ? JSON.parse(stdout) : stdout, stderr };
  } catch (e) {
    return { code: e.code, out: e.stdout?.trim().startsWith('{') ? JSON.parse(e.stdout) : e.stdout, stderr: e.stderr };
  }
}

// ------------------------------------------------------------------ fixture host

const SECTION = 'portal/reports';
const S = (rel) => `${SECTION}/${rel}`;
const EN = 'i18n/en/portal/current';
const ROOTS = ['--ua-root', 'portal/', '--en-root', `${EN}/`];

const page = (title, body, date = '9/8/2026') => `---\ntitle: ${title}\nlast_update:\n  date: ${date}\n---\n\n# ${title}\n\n${body}\n`;

async function host() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'section-state-'));
  const files = {
    [S('overview/overview.md')]: page('Звіти', '{/* ToDo: опис розділу */}'),
    [S('export/export.md')]: page('Експорт звіту', 'Щоб експортувати звіт, натисніть **Експорт**.'),
    [S('cards/cards.md')]: page('Картки', '{/* ToDo: картки */}'),
    [S('old/old.md')]: page('Старе', 'Сторінка, якої вже немає в застосунку.'),
    [`${EN}/reports/export/export.md`]: page('Export a report', 'To export a report, select **Export**.'),
  };
  for (const [rel, text] of Object.entries(files)) await write(dir, rel, text);
  await git(dir, 'init', '-q', '-b', 'main');
  await commit(dir, 'Host');
  return dir;
}

async function write(dir, rel, text) {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), text);
}

const read = (dir, rel) => fs.readFile(path.join(dir, rel), 'utf8');

async function commit(dir, message) {
  await git(dir, 'add', '-A');
  await git(dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message);
}

const readiness = {
  section: SECTION,
  verdict: 'needs-revision',
  pages: [
    { path: S('cards/cards.md'), state: 'stub' },
    { path: S('export/export.md'), state: 'complete' },
    { path: S('old/old.md'), state: 'complete' },
    { path: S('overview/overview.md'), state: 'stub' },
  ],
};

const planJson = {
  schemaVersion: 1,
  section: SECTION,
  status: 'awaiting-approval',
  pages: [
    { order: 1, action: 'keep', path: S('overview/overview.md'), docType: 'concept', title: 'Reports' },
    { order: 2, action: 'keep', path: S('export/export.md'), docType: 'user-guide', title: 'Export a report' },
    { order: 3, action: 'merge', path: S('manage-cards/manage-cards.md'), docType: 'user-guide', title: 'Manage cards', mergesFrom: [S('cards/cards.md')] },
    { order: 4, action: 'delete', path: S('old/old.md') },
  ],
};

const record = (dir, stage, status, ...more) => cli(dir, 'record', SECTION, '--stage', stage, '--status', status, ...more);
const status = (dir) => cli(dir, 'status', SECTION).then((r) => r.out);

// Readiness, explore skipped, the plan, and its approval.
async function approved(dir) {
  assert.equal((await record(dir, 'readiness', 'running', ...ROOTS)).code, 0);
  await write(dir, S('.sources/section-readiness.json'), JSON.stringify(readiness));
  assert.equal((await record(dir, 'readiness', 'done')).code, 0);
  assert.equal((await record(dir, 'explore', 'skipped', '--note', 'no live UI declared')).code, 0);
  await write(dir, S('.sources/section-plan.md'), '# Section plan — reports\n');
  await write(dir, S('.sources/section-plan.json'), JSON.stringify(planJson));
  assert.equal((await record(dir, 'plan', 'done')).code, 0);
  const r = await record(dir, 'planApproval', 'done');
  assert.equal(r.code, 0, JSON.stringify(r.out));
  return r.out;
}

const OVERVIEW = 'reports/overview/overview';
const CARDS = 'reports/manage-cards/manage-cards';

// Writes both pages, resolves, fixes and reviews them.
async function reviewed(dir) {
  await approved(dir);
  await write(dir, S('overview/overview.md'), page('Звіти', 'У розділі **Звіти** ви бачите всі звіти акаунта.'));
  await write(dir, S('manage-cards/manage-cards.md'), page('Керування картками', 'Щоб додати картку, натисніть **Додати**.'));
  for (const id of [OVERVIEW, CARDS]) assert.equal((await record(dir, 'write', 'done', '--page', id)).code, 0);
  assert.equal((await record(dir, 'resolve', 'done')).code, 0);
  await write(dir, S('overview/overview.md'), page('Звіти', 'У розділі **Звіти** видно всі звіти акаунта.'));
  for (const id of [OVERVIEW, CARDS]) assert.equal((await record(dir, 'fix', 'done', '--page', id, '--result', '{"applied":1,"left":0}')).code, 0);
  for (const id of [OVERVIEW, CARDS]) assert.equal((await record(dir, 'review', 'done', '--page', id, '--result', '{"errors":0,"deviations":0,"suggestions":1,"round":1}')).code, 0);
}

// ------------------------------------------------------------------ tests

test('withoutDates blanks frontmatter dates only', () => {
  const a = page('A', 'Body date: 1/1/2020', '9/8/2026');
  const b = page('A', 'Body date: 1/1/2020', '10/24/2026');
  assert.equal(withoutDates(a), withoutDates(b));
  assert.notEqual(withoutDates(a), withoutDates(page('A', 'Body date: 2/2/2020')));
  assert.equal(withoutDates('---\nlast_update: { date: 9/8/2026, author: x }\n---\nA\n'), withoutDates('---\nlast_update: { date: 10/24/2026, author: x }\n---\nA\n'));
  assert.equal(blobHash(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('no ledger: status says a fresh run; the first record needs the root pair and creates it', async () => {
  const dir = await host();
  const st = await status(dir);
  assert.equal(st.ledger, 'absent');
  assert.deepEqual(st.next, { stage: 'readiness', pages: [] });
  assert.match((await cli(dir, 'status', SECTION, '--md')).out, /a fresh run/);

  const bare = await record(dir, 'readiness', 'running');
  assert.equal(bare.code, 2);
  assert.match(bare.out.error, /--ua-root and --en-root/);
  assert.equal(await fs.stat(path.join(dir, S('.sources/section-state.json'))).catch(() => null), null);

  const outside = await cli(dir, 'record', 'blog', '--stage', 'readiness', '--status', 'running', ...ROOTS);
  assert.equal(outside.code, 2);
  assert.match(outside.out.error, /not a folder inside the UA content root/);

  const r = await record(dir, 'readiness', 'running', ...ROOTS, '--pair', 'primary');
  assert.equal(r.code, 0, r.stderr);
  const ledger = JSON.parse(await read(dir, S('.sources/section-state.json')));
  assert.equal(ledger.baseCommit, await git(dir, 'rev-parse', 'HEAD'));
  assert.deepEqual(ledger.roots, { ua: 'portal/', en: `${EN}/` });
  assert.equal(ledger.pair, 'primary');
  assert.equal(ledger.stages.readiness.status, 'running');
  assert.equal((await status(dir)).stages.readiness.state, 'running');
});

test('section stages: done needs its file; a changed page set before approval makes readiness and plan stale', async () => {
  const dir = await host();
  await record(dir, 'readiness', 'running', ...ROOTS);
  const missing = await record(dir, 'readiness', 'done');
  assert.equal(missing.code, 1);
  assert.match(missing.out.error, /nothing recorded: .*section-readiness\.json does not exist/);

  await write(dir, S('.sources/section-readiness.json'), '{ "verdict": ');
  const broken = await record(dir, 'readiness', 'done');
  assert.equal(broken.code, 1);
  assert.match(broken.out.error, /nothing recorded: cannot parse/);
  await write(dir, S('.sources/section-readiness.json'), JSON.stringify(readiness));
  await record(dir, 'readiness', 'done');
  assert.equal((await record(dir, 'explore', 'skipped')).code, 2, 'a skip needs a note');
  await record(dir, 'explore', 'skipped', '--note', 'no live UI declared');
  await write(dir, S('.sources/section-plan.md'), '# Plan\n');
  await write(dir, S('.sources/section-plan.json'), JSON.stringify({ pages: [{ action: 'rename', path: 'x.md' }] }));
  const bad = await record(dir, 'plan', 'done');
  assert.equal(bad.code, 1);
  assert.match(bad.out.error, /action 'rename'/);
  assert.match(bad.out.error, /outside the section/);
  await write(dir, S('.sources/section-plan.json'), JSON.stringify(planJson));
  await record(dir, 'plan', 'done');

  let st = await status(dir);
  assert.equal(st.next.stage, 'planApproval');
  assert.deepEqual(st.gate, { name: 'plan', pages: [] });

  await write(dir, S('new/new.md'), page('Нова', 'Текст.'));
  st = await status(dir);
  assert.equal(st.stages.readiness.state, 'stale');
  assert.match(st.stages.readiness.note, /page set changed/);
  assert.equal(st.stages.plan.state, 'stale');
  assert.equal(st.next.stage, 'readiness');
  assert.equal(st.gate, null);
  const early = await record(dir, 'planApproval', 'done');
  assert.equal(early.code, 1);
  assert.match(early.out.error, /the plan is stale/);

  // Readiness runs again: the plan must run again after it.
  await record(dir, 'readiness', 'done');
  st = await status(dir);
  assert.equal(st.stages.readiness.state, 'done');
  assert.equal(st.stages.plan.state, 'stale');
  assert.equal(st.next.stage, 'plan');
});

test('plan approval: pages from the plan; deletes, merged-away and complete keep pages are listed', async () => {
  const dir = await host();
  const out = await approved(dir);
  assert.deepEqual(out.pages, [OVERVIEW, CARDS]);
  assert.deepEqual(out.listed, [
    { path: S('export/export.md'), reason: 'keep-complete' },
    { path: S('cards/cards.md'), reason: 'merged-away', into: S('manage-cards/manage-cards.md') },
    { path: S('old/old.md'), reason: 'delete' },
  ]);
  const st = await status(dir);
  const [overview, cards] = st.pages;
  assert.equal(overview.enPath, `${EN}/reports/overview/overview.md`);
  assert.equal(overview.exists, true);
  assert.equal(overview.unknownDraft, false, 'a stub the plan keeps is not a draft');
  assert.deepEqual(cards.from, [S('cards/cards.md')]);
  assert.equal(cards.exists, false);
  assert.deepEqual(st.next, { stage: 'write', pages: [OVERVIEW, CARDS] });
  assert.equal(st.gate, null);
  assert.deepEqual(st.outside, []);
});

test('after approval: a changed plan brings gate G1 back; changed readiness or app notes only warn', async () => {
  const dir = await host();
  await approved(dir);
  await write(dir, S('.sources/section-readiness.json'), JSON.stringify({ ...readiness, verdict: 'skeleton' }));
  await write(dir, S('extra/extra.md'), page('Додаткова', 'Текст.'));
  let st = await status(dir);
  assert.equal(st.stages.readiness.state, 'done');
  assert.ok(st.warnings.some((w) => /after the plan was approved/.test(w)));
  assert.deepEqual(st.outside, [S('extra/extra.md')]);
  assert.equal(st.next.stage, 'write');

  await write(dir, S('.sources/section-plan.json'), JSON.stringify({ ...planJson, pages: planJson.pages.filter((p) => p.order !== 3) }));
  st = await status(dir);
  assert.equal(st.stages.planApproval.state, 'stale');
  assert.match(st.stages.planApproval.note, /changed after it was approved/);
  assert.deepEqual(st.gate, { name: 'plan', pages: [] });
  const w = await record(dir, 'write', 'done', '--page', OVERVIEW);
  assert.equal(w.code, 1);
  assert.match(w.out.error, /plan approval is stale/);

  const again = await record(dir, 'planApproval', 'done');
  assert.equal(again.code, 0);
  assert.deepEqual(again.out.dropped, [CARDS]);
  assert.deepEqual((await status(dir)).pages.map((p) => p.id), [OVERVIEW]);
});

test('the page chain: write, resolve, fix, review, approval, commit, translate with the date bump, align', async () => {
  const dir = await host();
  await approved(dir);
  const early = await record(dir, 'fix', 'done', '--page', OVERVIEW);
  assert.equal(early.code, 1);
  assert.match(early.out.error, /write is pending/);
  await write(dir, S('overview/overview.md'), page('Звіти', 'У розділі **Звіти** ви бачите всі звіти.'));
  await record(dir, 'write', 'done', '--page', OVERVIEW, '--result', '{"skill":"concept-doc-writer","interview":"asked 3"}');
  let st = await status(dir);
  assert.deepEqual(st.next, { stage: 'write', pages: [CARDS] });
  await write(dir, S('manage-cards/manage-cards.md'), page('Керування картками', 'Текст.'));
  await record(dir, 'write', 'done', '--page', CARDS);
  assert.equal((await status(dir)).next.stage, 'resolve');
  await record(dir, 'resolve', 'done');
  assert.deepEqual((await status(dir)).next, { stage: 'fix', pages: [OVERVIEW, CARDS] });

  // The fixer's edit is a pipeline write: not a hand edit.
  await write(dir, S('overview/overview.md'), page('Звіти', 'У розділі **Звіти** видно всі звіти.'));
  await record(dir, 'fix', 'done', '--page', OVERVIEW, '--page', CARDS, '--result', '{"applied":2,"left":0}');
  st = await status(dir);
  assert.equal(st.pages[0].handEdited, false);
  assert.deepEqual(st.next, { stage: 'review', pages: [OVERVIEW, CARDS] });
  await record(dir, 'review', 'done', '--page', OVERVIEW, '--page', CARDS, '--result', '{"errors":0,"deviations":0,"suggestions":0,"round":1}');
  st = await status(dir);
  assert.deepEqual(st.gate, { name: 'uaApproval', pages: [OVERVIEW, CARDS] });
  await record(dir, 'uaApproval', 'done', '--page', OVERVIEW, '--page', CARDS);

  st = await status(dir);
  assert.equal(st.next.stage, 'translate');
  assert.deepEqual(st.next.uncommitted, [OVERVIEW, CARDS]);
  assert.deepEqual(st.gate, { name: 'commit', pages: [OVERVIEW, CARDS] });
  await commit(dir, 'Approved pages');
  st = await status(dir);
  assert.deepEqual(st.next.uncommitted, []);
  assert.equal(st.gate, null);

  // The translator writes EN and sets today's date in both files.
  const ua = await read(dir, S('overview/overview.md'));
  await write(dir, S('overview/overview.md'), ua.replace('9/8/2026', '10/24/2026'));
  const noEn = await record(dir, 'translate', 'done', '--page', OVERVIEW);
  assert.equal(noEn.code, 1);
  assert.match(noEn.out.error, /does not exist/);
  await write(dir, `${EN}/reports/overview/overview.md`, page('Reports', 'The **Reports** section shows every report.', '10/24/2026'));
  const tr = await record(dir, 'translate', 'done', '--page', OVERVIEW);
  assert.equal(tr.code, 0, JSON.stringify(tr.out));
  st = await status(dir);
  const ov = st.pages[0];
  assert.equal(ov.handEdited, false);
  assert.deepEqual(Object.values(ov.stages).slice(0, 5), ['done', 'done', 'done', 'done', 'done']);
  assert.equal(ov.stages.align, 'pending');
  const ledger = JSON.parse(await read(dir, S('.sources/section-state.json')));
  assert.ok(ledger.runLog.some((l) => l.outcome === 'date-bump' && l.page === OVERVIEW));

  await record(dir, 'align', 'done', '--page', OVERVIEW, '--result', '{"bugs":0,"warnings":1}');
  await write(dir, `${EN}/reports/manage-cards/manage-cards.md`, page('Manage cards', 'Text.'));
  await record(dir, 'translate', 'done', '--page', CARDS);
  await record(dir, 'align', 'done', '--page', CARDS);
  st = await status(dir);
  assert.deepEqual(st.next, { stage: null, pages: [] });
  assert.equal(st.gate, null);
  assert.match((await cli(dir, 'status', SECTION, '--md')).out, /nothing: the chain is complete/);
});

test('a UA edit after review makes fix, review and approval stale, and approval is refused', async () => {
  const dir = await host();
  await reviewed(dir);
  await write(dir, S('overview/overview.md'), page('Звіти', 'Інший текст, змінений вручну.'));
  const st = await status(dir);
  const ov = st.pages[0];
  assert.equal(ov.handEdited, true);
  assert.equal(ov.stages.write, 'done');
  assert.equal(ov.stages.fix, 'stale');
  assert.equal(ov.stages.review, 'stale');
  assert.ok(st.warnings.some((w) => w.startsWith(`${OVERVIEW}: the UA page changed outside the pipeline`)));
  assert.deepEqual(st.next, { stage: 'fix', pages: [OVERVIEW] });
  const r = await record(dir, 'uaApproval', 'done', '--page', OVERVIEW, '--page', CARDS);
  assert.equal(r.code, 1);
  assert.match(r.out.error, /review is stale \(the UA page changed after it\)/);
  const ledger = JSON.parse(await read(dir, S('.sources/section-state.json')));
  assert.equal(ledger.pages[1].stages.uaApproval, undefined, 'all or nothing: the other page was not recorded either');
});

test('translate is refused when the approved version is not committed, or UA changed beyond the date', async () => {
  const dir = await host();
  await reviewed(dir);
  await record(dir, 'uaApproval', 'done', '--page', OVERVIEW);
  await write(dir, `${EN}/reports/overview/overview.md`, page('Reports', 'Text.'));
  const ua = await read(dir, S('overview/overview.md'));
  await write(dir, S('overview/overview.md'), ua.replace('9/8/2026', '10/24/2026'));
  const r = await record(dir, 'translate', 'done', '--page', OVERVIEW);
  assert.equal(r.code, 1);
  assert.match(r.out.error, /approved version is not committed/);

  await write(dir, S('overview/overview.md'), ua);
  await commit(dir, 'Approved');
  await write(dir, S('overview/overview.md'), ua.replace('9/8/2026', '10/24/2026').replace('видно', 'показано'));
  const edited = await record(dir, 'translate', 'done', '--page', OVERVIEW);
  assert.equal(edited.code, 1);
  assert.match(edited.out.error, /uaApproval is stale/);
});

test('an EN hand edit makes only the alignment stale', async () => {
  const dir = await host();
  await reviewed(dir);
  await record(dir, 'uaApproval', 'done', '--page', OVERVIEW, '--page', CARDS);
  await commit(dir, 'Approved');
  for (const [id, rel] of [[OVERVIEW, 'overview/overview.md'], [CARDS, 'manage-cards/manage-cards.md']]) {
    await write(dir, `${EN}/reports/${rel}`, page('Page', 'Text.'));
    await record(dir, 'translate', 'done', '--page', id);
    await record(dir, 'align', 'done', '--page', id);
  }
  await write(dir, `${EN}/reports/overview/overview.md`, page('Page', 'Text edited by hand.'));
  const st = await status(dir);
  const ov = st.pages[0];
  assert.equal(ov.enHandEdited, true);
  assert.equal(ov.stages.translate, 'done');
  assert.equal(ov.stages.align, 'stale');
  assert.deepEqual(st.next, { stage: 'align', pages: [OVERVIEW] });
  assert.ok(st.warnings.some((w) => /EN page changed outside the pipeline; only its alignment runs again/.test(w)));
});

test('a failed page is blocked and does not hold the others back; running it again clears the block', async () => {
  const dir = await host();
  await approved(dir);
  assert.equal((await record(dir, 'write', 'failed', '--page', CARDS)).code, 2, 'a failure needs a note');
  await record(dir, 'write', 'failed', '--page', CARDS, '--note', 'no inputs for the merged page');
  await write(dir, S('overview/overview.md'), page('Звіти', 'Текст.'));
  await record(dir, 'write', 'done', '--page', OVERVIEW);
  let st = await status(dir);
  assert.deepEqual(st.blocked, [{ id: CARDS, stage: 'write', reason: 'no inputs for the merged page' }]);
  assert.equal(st.next.stage, 'resolve');
  await record(dir, 'resolve', 'done');
  assert.deepEqual((await status(dir)).next, { stage: 'fix', pages: [OVERVIEW] });

  await record(dir, 'write', 'running', '--page', CARDS);
  st = await status(dir);
  assert.deepEqual(st.blocked, []);
  assert.deepEqual(st.next, { stage: 'write', pages: [CARDS] });

  // Written after resolve ran: resolve runs again.
  await write(dir, S('manage-cards/manage-cards.md'), page('Керування картками', 'Текст.'));
  await record(dir, 'write', 'done', '--page', CARDS);
  st = await status(dir);
  assert.equal(st.stages.resolve.state, 'stale');
  assert.match(st.stages.resolve.note, /written after it ran/);
  assert.equal(st.next.stage, 'resolve');
});

test('an interrupted write leaves a draft the ledger does not know: gate unknownDraft', async () => {
  const dir = await host();
  await approved(dir);
  await record(dir, 'write', 'running', '--page', CARDS);
  await write(dir, S('manage-cards/manage-cards.md'), page('Керування картками', 'Чернетка.'));
  await write(dir, S('overview/overview.md'), page('Звіти', 'Чернетка.'));
  const st = await status(dir);
  assert.equal(st.pages[1].stages.write, 'running');
  assert.equal(st.pages[1].unknownDraft, true);
  assert.equal(st.pages[0].unknownDraft, true, 'the stub changed too');
  assert.deepEqual(st.gate, { name: 'unknownDraft', pages: [OVERVIEW, CARDS] });
});

test('--saved-as: the ledger follows the path the writer saved', async () => {
  const dir = await host();
  await approved(dir);
  await write(dir, S('cards-management/cards-management.md'), page('Керування картками', 'Текст.'));
  const r = await record(dir, 'write', 'done', '--page', CARDS, '--saved-as', S('cards-management/cards-management.md'));
  assert.equal(r.code, 0, JSON.stringify(r.out));
  const st = await status(dir);
  assert.equal(st.pages[1].id, 'reports/cards-management/cards-management');
  assert.equal(st.pages[1].enPath, `${EN}/reports/cards-management/cards-management.md`);
  assert.equal(st.pages[1].stages.write, 'done');
  assert.equal((await record(dir, 'write', 'done', '--page', OVERVIEW, '--page', CARDS, '--saved-as', 'x.md')).code, 2);
});

test('usage errors exit 2 with a JSON error', async () => {
  const dir = await host();
  await approved(dir);
  for (const [args, message] of [
    [['frobnicate', SECTION], /unknown command/],
    [['status'], /needs the section folder/],
    [['record', SECTION, '--stage', 'publish', '--status', 'done'], /--stage must be one of/],
    [['record', SECTION, '--stage', 'write', '--status', 'finished', '--page', OVERVIEW], /--status must be one of/],
    [['record', SECTION, '--stage', 'write', '--status', 'done'], /name the page\(s\) with --page/],
    [['record', SECTION, '--stage', 'resolve', '--status', 'done', '--page', OVERVIEW], /takes no --page/],
    [['record', SECTION, '--stage', 'review', '--status', 'skipped', '--page', OVERVIEW, '--note', 'x'], /only explore and resolve/],
    [['record', SECTION, '--stage', 'write', '--status', 'done', '--page', 'reports/nope'], /not a page of this run/],
    [['record', SECTION, '--stage', 'resolve', '--status', 'done', '--result', '[1]'], /must be a JSON object/],
    [['status', '../elsewhere'], /outside the repo root/],
    [['status', SECTION, '--verbose'], /Unknown option/],
  ]) {
    const r = await cli(dir, ...args);
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(r.out.ok, false);
    assert.match(r.out.error, message);
    assert.match(r.stderr, /^section-state: /);
  }
  const help = await cli(dir, '--help');
  assert.equal(help.code, 0);
  assert.match(help.out, /section-state <command> <section>/);
});

test('status --md: one row per stage and per page, the next stage and the gate', async () => {
  const dir = await host();
  await reviewed(dir);
  const md = (await cli(dir, 'status', SECTION, '--md')).out;
  assert.match(md, /\| readiness \| done \|/);
  assert.match(md, /\| explore \| skipped \| no live UI declared \|/);
  assert.match(md, new RegExp(`\\| 1 \\| \`${OVERVIEW}\` \\| keep \\| concept \\| done \\| done \\| done \\| · \\| · \\| · \\|`));
  assert.match(md, /\*\*Listed, not processed:\*\* .*old\/old\.md` \(delete\)/);
  assert.match(md, /\*\*Next:\*\* uaApproval/);
  assert.match(md, /\*\*Gate:\*\* uaApproval/);
});
