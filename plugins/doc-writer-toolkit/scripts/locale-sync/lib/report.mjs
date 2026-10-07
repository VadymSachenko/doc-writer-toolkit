import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { exists } from '../../ui-labels/lib/util.mjs';
import { loadStore } from '../../ui-labels/lib/store.mjs';
import { abs, listUaPages, localePagePath, readState } from './pages.mjs';
import { localeRoot, resolveTargets, selectPages } from './settings.mjs';
import { checkTranslation } from './checks.mjs';
import { cachedBlob } from './plan.mjs';
import { parseFrontmatter } from './parse.mjs';

const posix = path.posix;

async function readBaseUrl(s) {
  const names = s.docusaurusConfig ? [s.docusaurusConfig] : ['docusaurus.config.ts', 'docusaurus.config.js', 'docusaurus.config.mjs', 'docusaurus.config.cjs'];
  for (const n of names) {
    try {
      const m = (await fs.readFile(path.resolve(s.root, n), 'utf8')).match(/\bbaseUrl\s*:\s*['"]([^'"]*)['"]/);
      if (m) return m[1];
    } catch {
      /* next */
    }
  }
  return '/';
}

// The route Docusaurus gives a doc: number prefixes stripped, `folder/folder.md` and `index.md` collapse to the folder,
// a frontmatter `slug` overrides. Returned without locale prefix and baseUrl.
export function docRoute(s, page, uaText) {
  const strip = (seg) => seg.replace(/^\d+\s*[-_.]\s*(?=\S)/, '');
  const segs = page.id.split('/').map(strip);
  const dir = segs.slice(0, -1);
  const fm = parseFrontmatter(uaText.split('\n'));
  const slug = fm?.entries.find((e) => e.key === 'slug')?.scalar;
  let parts;
  if (slug) parts = slug.startsWith('/') ? slug.split('/').filter(Boolean) : [...dir, ...slug.split('/').filter(Boolean)];
  else {
    const last = segs.at(-1);
    parts = last === 'index' || last === 'README' || last.toLowerCase() === 'readme' || last === dir.at(-1) ? dir : segs;
  }
  const prefix = s.urlPrefix.split('/').filter(Boolean);
  const all = [...prefix, ...parts];
  return '/' + all.join('/') + (all.length ? '/' : '');
}

function runBuild(s, locale, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('npm', ['run', 'build', '--', '--locale', locale], { cwd: s.root, env: { ...process.env, CI: '1' } });
    let out = '';
    const keep = (d) => {
      out += d;
      if (out.length > 4_000_000) out = out.slice(-2_000_000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => resolve({ ok: false, seconds: 0, errors: [{ message: `could not start npm: ${e.message}` }], tail: [] }));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, exitCode: code, seconds: Math.round((Date.now() - started) / 1000), errors: parseBuildErrors(s, locale, out), tail: out.trim().split('\n').slice(-25) });
    });
  });
}

// Pulls page-level problems out of a Docusaurus build log: unresolved images/modules and broken links.
export function parseBuildErrors(s, locale, log) {
  const errors = [];
  const root = abs(s, localeRoot(s, locale));
  for (const m of log.matchAll(/Can't resolve '([^']+)' in '([^']+)'/g)) {
    const rel = path.relative(root, m[2]).split(path.sep).join('/');
    errors.push({ kind: 'unresolved', ref: m[1], folder: rel.startsWith('..') ? m[2] : rel, message: `Can't resolve '${m[1]}'` });
  }
  for (const m of log.matchAll(/On source page path = (\S+?):\s*\n((?:\s+-> linking to [^\n]*\n?)+)/g)) {
    for (const l of m[2].split('\n').filter((x) => x.trim())) errors.push({ kind: 'broken-link', route: m[1], message: l.trim() });
  }
  return errors.slice(0, 60);
}

const mark = (ok) => (ok ? '✓' : '✗');

// Requirement 13: per page and locale, does the page exist, do its images resolve, did the checks pass — plus the local URLs of
// the pages that changed, and (with --build) a build of each locale.
export async function runReport(s, { changed = [], build = false, origin = 'http://localhost:3000', buildTimeoutMin = 30 } = {}) {
  const { targets } = await resolveTargets(s);
  const { inScope } = await listUaPages(s);
  const changedPages = new Set((changed.length ? selectPages(s, inScope, changed) : inScope).map((p) => p.id));
  const baseUrl = (await readBaseUrl(s)).replace(/\/+$/, '');
  const store = await loadStore(s.labelsDir);

  const rows = [];
  for (const page of inScope) {
    const uaText = await cachedBlob(s.root, page.blob);
    const state = await readState(s, page.id);
    const row = { page: page.id, changed: changedPages.has(page.id), cells: {} };
    for (const locale of targets) {
      const file = localePagePath(s, locale, page);
      const exist = await exists(abs(s, file));
      const cell = { exists: exist, imagesResolve: false, checksPassed: false, failures: [] };
      if (exist) {
        const c = await checkTranslation(s, page, locale, { store });
        cell.imagesResolve = !c.checks.includes('assets');
        cell.checksPassed = c.ok;
        cell.failures = c.checks;
        const entry = state.locales[locale];
        cell.unverified = entry?.unverified?.length ?? 0;
        cell.assetFallbacks = entry?.assetFallbacks?.length ?? 0;
        cell.recorded = Boolean(entry?.sourceBlob);
        cell.upToDate = entry?.sourceBlob === page.blob;
      }
      cell.url = `${origin}${baseUrl}/${locale}${docRoute(s, page, uaText)}`;
      row.cells[locale] = cell;
    }
    rows.push(row);
  }

  const buildResults = {};
  if (build) {
    const toBuild = targets.filter((l) => rows.some((r) => r.changed && r.cells[l].exists));
    for (const locale of toBuild) {
      const r = await runBuild(s, locale, buildTimeoutMin * 60_000);
      const pages = new Set();
      for (const e of r.errors) {
        if (e.folder) for (const p of inScope) if (posix.dirname(p.rel) === e.folder) pages.add(p.id);
      }
      buildResults[locale] = { ...r, pages: [...pages] };
    }
  }

  const totals = { pages: rows.length, locales: targets.length };
  const fails = rows.flatMap((r) => targets.filter((l) => !(r.cells[l].exists && r.cells[l].imagesResolve && r.cells[l].checksPassed)).map((l) => ({ page: r.page, locale: l })));
  return { locales: targets, totals, allGood: fails.length === 0 && Object.values(buildResults).every((b) => b.ok), failing: fails.length, pages: rows, build: build ? buildResults : undefined };
}

export function renderMarkdown(report) {
  const { locales, pages } = report;
  const head = (title) => [`| ${title} | ${locales.join(' | ')} |`, `|---|${locales.map(() => ':-:').join('|')}|`];
  const grid = (title, pick) => [`### ${title}`, '', ...head('Page'), ...pages.map((r) => `| ${r.page} | ${locales.map((l) => mark(pick(r.cells[l]))).join(' | ')} |`), ''];
  const out = [
    `# Locale translation report`,
    '',
    `${report.totals.pages} pages × ${report.totals.locales} locales. ${report.failing ? `**${report.failing} page/locale pairs need attention.**` : 'Every page exists, its images resolve and its checks pass.'}`,
    '',
    ...grid('Page exists', (c) => c.exists),
    ...grid('All images resolve', (c) => c.exists && c.imagesResolve),
    ...grid('Checks passed', (c) => c.exists && c.checksPassed),
  ];
  const problems = pages.flatMap((r) => locales.filter((l) => r.cells[l].exists && r.cells[l].failures.length).map((l) => `- ${r.page} [${l}]: ${r.cells[l].failures.join(', ')}`));
  if (problems.length) out.push('### Failing checks', '', ...problems, '');
  if (report.build) {
    out.push('### Build', '', '| Locale | Result | Seconds |', '|---|:-:|--:|');
    for (const [l, b] of Object.entries(report.build)) out.push(`| ${l} | ${mark(b.ok)} | ${b.seconds} |`);
    out.push('');
    for (const [l, b] of Object.entries(report.build)) {
      if (b.ok) continue;
      out.push(`**${l}**`, '', ...(b.errors.length ? b.errors.map((e) => `- ${e.kind ?? 'error'}: ${e.message}${e.folder ? ` (in ${e.folder})` : ''}${e.route ? ` (page ${e.route})` : ''}`) : b.tail.map((t) => `    ${t}`)), '');
    }
  }
  out.push('### Changed pages: local URLs (`npm run serve`)', '');
  for (const l of locales) {
    const urls = pages.filter((r) => r.changed && r.cells[l].exists).map((r) => `- ${r.cells[l].url}`);
    out.push(`**${l}**`, '', ...(urls.length ? urls : ['- (none)']), '');
  }
  return out.join('\n');
}
