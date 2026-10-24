import { CliError, enPathOf, fileHash, inside, norm, pageId, readJsonFile, sectionFile } from './ledger.mjs';

const ACTIONS = ['keep', 'merge', 'split', 'add', 'delete'];
const DOC_TYPES = ['concept', 'user-guide', 'api'];

// Reads and checks `.sources/section-plan.json`: every entry has an action, a page path inside the section and,
// unless it is a delete, a doc type. Returns the entries in plan order.
export async function readPlan(root, ledger) {
  const rel = sectionFile(ledger, 'planJson');
  const plan = await readJsonFile(root, rel).catch((e) => {
    throw new CliError(e.message, 1);
  });
  if (plan === null) throw new CliError(`${rel} not found`, 1);
  if (!Array.isArray(plan.pages)) throw new CliError(`${rel}: no "pages" array`, 1);
  const problems = [];
  const entries = plan.pages.map((e, i) => {
    const where = `${rel}: pages[${i}]`;
    const p = { ...e, path: e.path ? norm(e.path) : e.path, order: Number.isInteger(e.order) ? e.order : i + 1 };
    if (!ACTIONS.includes(p.action)) problems.push(`${where}: action '${p.action}' is not one of ${ACTIONS.join(', ')}`);
    if (typeof p.path !== 'string' || !/\.mdx?$/.test(p.path)) problems.push(`${where}: "path" must be a page path from the repo root`);
    else if (!inside(p.path, ledger.section)) problems.push(`${where}: ${p.path} is outside the section ${ledger.section}`);
    else if (!inside(p.path, ledger.roots.ua)) problems.push(`${where}: ${p.path} is outside the UA content root ${ledger.roots.ua}`);
    if (p.action !== 'delete' && !DOC_TYPES.includes(p.docType)) problems.push(`${where}: docType '${p.docType}' is not one of ${DOC_TYPES.join(', ')}`);
    if (p.action === 'merge' && (!Array.isArray(p.mergesFrom) || !p.mergesFrom.length)) problems.push(`${where}: a merge needs "mergesFrom"`);
    if (p.action === 'split' && typeof p.splitsFrom !== 'string') problems.push(`${where}: a split needs "splitsFrom"`);
    return p;
  });
  if (problems.length) throw new CliError(problems.join('\n'), 1);
  return entries.sort((a, b) => a.order - b.order);
}

// The ledger's pages from the approved plan. A page already in the ledger keeps its records; a page the plan
// no longer has is dropped and returned. Deletes, merged-away and split pages and complete `keep` pages are listed.
export async function syncPages(root, ledger, entries) {
  const readiness = (await readJsonFile(root, sectionFile(ledger, 'readiness'))) ?? {};
  const stateOf = new Map((readiness.pages ?? []).map((p) => [norm(p.path), p.state]));
  const old = new Map((ledger.pages ?? []).map((p) => [p.path, p]));
  const pages = [];
  const listed = [];
  const list = (path, reason, into) => {
    if (!listed.some((l) => l.path === path)) listed.push(into ? { path, reason, into } : { path, reason });
  };
  const written = new Set(entries.filter((e) => e.action !== 'delete' && !(e.action === 'keep' && stateOf.get(e.path) === 'complete')).map((e) => e.path));

  for (const e of entries) {
    if (e.action === 'delete') {
      list(e.path, 'delete');
      continue;
    }
    if (e.action === 'keep' && stateOf.get(e.path) === 'complete') {
      list(e.path, 'keep-complete');
      continue;
    }
    const from = e.action === 'merge' ? e.mergesFrom.map(norm).filter((m) => m !== e.path) : e.action === 'split' ? [norm(e.splitsFrom)].filter((m) => m !== e.path) : [];
    for (const m of from) {
      if (written.has(m)) continue;
      if (e.action === 'merge') list(m, 'merged-away', e.path);
      else {
        const into = entries.filter((x) => x.action === 'split' && norm(x.splitsFrom) === m).map((x) => x.path);
        list(m, 'split', into);
      }
    }
    const prev = old.get(e.path);
    pages.push({
      id: pageId(ledger, e.path),
      path: e.path,
      enPath: enPathOf(ledger, e.path),
      action: e.action,
      docType: e.docType,
      title: e.title ?? null,
      from,
      order: e.order,
      uaHash: prev ? prev.uaHash : await fileHash(root, e.path),
      enHash: prev ? prev.enHash : null,
      stages: prev?.stages ?? {},
      blocked: prev?.blocked ?? null,
    });
  }
  const dropped = (ledger.pages ?? []).filter((p) => !pages.some((x) => x.path === p.path)).map((p) => p.id);
  return { pages, listed, dropped };
}
