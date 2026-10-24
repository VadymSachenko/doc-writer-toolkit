import {
  CliError, PAGE_STAGES, SCHEMA_VERSION, SECTION_STAGES, STATUSES, dateOnlyChange, dirOf, enPathOf, fileHash, headCommit,
  inside, isDir, listPages, norm, pageId, readJsonFile, readLedger, refuse, sectionFile, writeLedger,
} from './ledger.mjs';
import { readPlan, syncPages } from './plan.mjs';
import { computeStatus, reviewRound } from './status.mjs';

const ok = (state) => state === 'done' || state === 'skipped';
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

// The files a section stage's `done` points at, relative to the section.
const EVIDENCE = {
  readiness: ['readiness'],
  explore: ['appNotes'],
  plan: ['planMd', 'planJson'],
  planApproval: ['planMd', 'planJson'],
};

function parseObject(text, flag) {
  if (text === undefined) return undefined;
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new CliError(`${flag} is not JSON: ${e.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError(`${flag} must be a JSON object`);
  return value;
}

async function createLedger(root, section, { uaRoot, enRoot, pair }) {
  if (!uaRoot || !enRoot) throw new CliError(`no ledger at ${sectionFile(section, 'ledger')} yet: pass --ua-root and --en-root (the section's root pair) to create it`);
  if (!inside(section, uaRoot) || norm(section) === norm(uaRoot)) throw new CliError(`the section ${section} is not a folder inside the UA content root ${uaRoot}`);
  if (!(await isDir(root, section))) throw new CliError(`the section folder ${section} does not exist`);
  const at = now();
  return {
    schemaVersion: SCHEMA_VERSION,
    section: norm(section),
    pair: pair ?? null,
    roots: { ua: dirOf(uaRoot), en: dirOf(enRoot) },
    baseCommit: await headCommit(root),
    createdAt: at,
    updatedAt: at,
    seq: 0,
    options: {},
    stages: {},
    pages: [],
    listed: [],
    runLog: [],
  };
}

function findPages(ledger, refs) {
  const missing = [];
  const pages = refs.map((ref) => {
    const r = norm(ref).replace(/^[\w-]+:/, '');
    const p = ledger.pages.find((x) => x.id === r || x.path === r);
    if (!p) missing.push(ref);
    return p;
  });
  if (missing.length) throw new CliError(`not a page of this run: ${missing.join(', ')}. Pages: ${ledger.pages.map((p) => p.id).join(', ') || 'none (the plan is not approved yet)'}`);
  return pages;
}

// Records one stage result. A `done` is checked against the files first; on any problem nothing is written.
export async function runRecord(root, section, opts) {
  const { stage, status, pages: refs = [], note, savedAs } = opts;
  const result = parseObject(opts.result, '--result');
  const options = parseObject(opts.options, '--options');
  const isPage = PAGE_STAGES.includes(stage);
  if (!SECTION_STAGES.includes(stage) && !isPage) throw new CliError(`--stage must be one of ${[...SECTION_STAGES, ...PAGE_STAGES].join(', ')}`);
  if (!STATUSES.includes(status)) throw new CliError(`--status must be one of ${STATUSES.join(', ')}`);
  if (isPage && !refs.length) throw new CliError(`--stage ${stage} is a page stage: name the page(s) with --page`);
  if (!isPage && refs.length) throw new CliError(`--stage ${stage} is a section stage: it takes no --page`);
  if (status === 'skipped' && !['explore', 'resolve'].includes(stage)) throw new CliError('only explore and resolve can be skipped');
  if ((status === 'skipped' || status === 'failed') && !note) throw new CliError(`--status ${status} needs a --note with the reason`);
  if (savedAs && !(stage === 'write' && status === 'done' && refs.length === 1)) throw new CliError('--saved-as goes with --stage write --status done and one --page');

  const ledger = (await readLedger(root, section)) ?? (await createLedger(root, section, opts));
  const at = now();
  const seq = (ledger.seq ?? 0) + 1;
  const base = { status, seq, at, ...(note ? { note } : {}), ...(result ? { result } : {}) };
  const log = [];
  const out = { recorded: [] };

  if (!isPage) {
    const rec = { ...base };
    if (status === 'done') {
      const st = await computeStatus(root, section, ledger);
      if (stage === 'planApproval' && st.stages.plan.state !== 'done') throw refuse(`the plan is ${st.stages.plan.state}; record plan done first`);
      if (stage === 'resolve' && st.stages.planApproval.state !== 'done') throw refuse(`the plan approval is ${st.stages.planApproval.state}`);
      if (EVIDENCE[stage]) {
        rec.evidence = [];
        for (const key of EVIDENCE[stage]) {
          const rel = sectionFile(ledger, key);
          const hash = await fileHash(root, rel);
          if (hash === null) throw refuse(`${rel} does not exist`);
          if (rel.endsWith('.json')) await readJsonFile(root, rel).catch((e) => { throw refuse(e.message); });
          rec.evidence.push({ path: rel, hash });
        }
      }
      if (stage === 'readiness') rec.pages = await listPages(root, ledger.section);
      if (stage === 'plan') await readPlan(root, ledger);
      if (stage === 'planApproval') {
        const { pages, listed, dropped } = await syncPages(root, ledger, await readPlan(root, ledger));
        ledger.pages = pages;
        ledger.listed = listed;
        out.pages = pages.map((p) => p.id);
        out.listed = listed;
        out.dropped = dropped;
        for (const id of dropped) log.push({ at, seq, stage, page: id, outcome: 'dropped', note: 'no longer in the approved plan' });
      }
      // Resolve edits pages: their new hashes are pipeline writes, not hand edits.
      if (stage === 'resolve') for (const p of ledger.pages) p.uaHash = (await fileHash(root, p.path)) ?? p.uaHash;
    }
    ledger.stages[stage] = rec;
    log.unshift({ at, seq, stage, outcome: status, ...(note ? { note } : {}) });
    out.recorded.push({ stage, status });
  } else {
    if (status === 'done') {
      const approval = (await computeStatus(root, section, ledger)).stages.planApproval.state;
      if (approval !== 'done') throw refuse(`the plan approval is ${approval}`);
    }
    const pages = findPages(ledger, refs);
    if (savedAs) await moveSaved(root, ledger, pages[0], savedAs, log, { at, seq });
    if (stage === 'translate' && status === 'done') for (const p of pages) await carryDateBump(root, p, log, { at, seq });
    const st = await computeStatus(root, section, ledger);
    const prev = PAGE_STAGES[PAGE_STAGES.indexOf(stage) - 1];
    const head = stage === 'translate' && status === 'done' ? await headCommit(root) : null;
    for (const p of pages) {
      const cur = await fileHash(root, p.path);
      const rec = { ...base };
      if (status === 'done') {
        const row = st.pages.find((x) => x.id === p.id);
        if (prev && !ok(row.stages[prev])) throw refuse(`${p.id}: ${prev} is ${row.stages[prev]}${row.handEdited ? ' (the UA page changed after it)' : ''}`);
        if (stage === 'uaApproval' && row.reviewAgain) throw refuse(`${p.id}: review round ${row.reviewRound} left errors or deviations; fix and review it again first`);
        if (cur === null) throw refuse(`${p.path} does not exist`);
        rec.uaHash = cur;
        if (stage === 'write' || stage === 'fix') p.uaHash = cur;
        if (stage === 'translate' || stage === 'align') {
          const en = await fileHash(root, p.enPath);
          if (en === null) throw refuse(`${p.enPath} does not exist`);
          rec.enHash = en;
          p.enHash = en;
        }
        // The next `doc-translator --sync` diffs from the commit this translation was made at.
        if (head) {
          rec.head = head;
          p.syncBase = head;
        }
        // The script counts the review rounds; a round given in --result is replaced.
        if (stage === 'review') {
          const round = reviewRound(p, cur);
          rec.result = { ...(rec.result ?? {}), round };
          p.review = { round, hash: cur, seq };
        }
      }
      // Where the fixer started: a fix that starts on the reviewed version makes the next review the next round.
      if (stage === 'fix' && status === 'running') p.fixFrom = { hash: cur, seq };
      if (status === 'failed') p.blocked = { stage, reason: note };
      else if (p.blocked?.stage === stage) p.blocked = null;
      p.stages = { ...p.stages, [stage]: rec };
      log.push({ at, seq, stage, page: p.id, outcome: status, ...(note ? { note } : {}) });
      out.recorded.push({ stage, page: p.id, status });
    }
  }

  if (options) ledger.options = { ...ledger.options, ...options };
  ledger.seq = seq;
  ledger.updatedAt = at;
  ledger.runLog = [...(ledger.runLog ?? []), ...log];
  await writeLedger(root, ledger);
  const after = await computeStatus(root, section, ledger);
  return { ok: true, file: after.file, ...out, next: after.next, gate: after.gate, warnings: after.warnings };
}

// The writer saved the page somewhere else than the plan said: the ledger follows the file. Nothing is renamed.
async function moveSaved(root, ledger, page, savedAs, log, { at, seq }) {
  const to = norm(savedAs);
  if (!inside(to, ledger.section)) throw refuse(`--saved-as ${to} is outside the section ${ledger.section}`);
  if (ledger.pages.some((p) => p !== page && p.path === to)) throw new CliError(`--saved-as ${to} is another page of this run`);
  log.push({ at, seq, stage: 'write', page: page.id, outcome: 'moved', note: `saved at ${to}; the plan says ${page.path}` });
  Object.assign(page, { path: to, id: pageId(ledger, to), enPath: enPathOf(ledger, to) });
}

// The translator sets `last_update.date` in the UA page too. When that is the only difference from the approved
// version (which is in a commit reachable from HEAD), the records made on the approved version carry over to the new hash.
async function carryDateBump(root, page, log, { at, seq }) {
  const approved = page.stages?.uaApproval?.uaHash;
  const cur = await fileHash(root, page.path);
  if (!approved || cur === null || cur === approved) return;
  const { committed, dateOnly } = await dateOnlyChange(root, page.path, approved);
  if (!committed) throw refuse(`${page.id}: the approved version is not committed, so a date change can't be told from an edit; commit the approved page, then translate`);
  if (!dateOnly) return;
  for (const rec of Object.values(page.stages)) if (rec.uaHash === approved) rec.uaHash = cur;
  if (page.uaHash === approved) page.uaHash = cur;
  if (page.review?.hash === approved) page.review = { ...page.review, hash: cur };
  log.push({ at, seq, stage: 'translate', page: page.id, outcome: 'date-bump', note: 'the UA last_update date changed; the earlier records carry over' });
}
