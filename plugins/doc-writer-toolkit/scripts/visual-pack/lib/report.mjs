import { TYPES, analyze, sortFindings, summarizeFindings } from './findings.mjs';

// Joins the pages, the captures and the findings into the report that the sheet and the JSON output are made from.
// `captures` are the results of captureAll (with their DOM data); the report keeps counts, not the DOM.
export function assemble({ settings, pages, captures, network, timings, sheet }) {
  const byCell = new Map(captures.map((c) => [`${c.page}\0${c.locale}`, c]));
  const findings = [];
  const rows = pages.map((page) => {
    const source = byCell.get(`${page.key}\0${settings.defaultLocale}`);
    const cells = {};
    for (const locale of settings.columns) {
      const capture = byCell.get(`${page.key}\0${locale}`);
      cells[locale] = {
        status: capture?.status ?? null,
        shot: capture?.shot ?? null,
        cropped: capture?.cropped ?? false,
        error: capture?.error ?? null,
        retried: capture?.retried ?? false,
        firstError: capture?.firstError ?? null,
        title: capture?.dom?.heading || capture?.dom?.title || null,
        images: capture?.dom?.images.length ?? null,
        tables: capture?.dom?.tables.length ?? null,
      };
      findings.push(...analyze({ page, locale, capture, source, sourceLocale: settings.defaultLocale, noFile: locale !== settings.defaultLocale && page.files[locale] === null }));
    }
    return { key: page.key, pair: page.pair, rel: page.rel, changedIn: page.changedIn, urls: page.urls, captures: cells };
  });
  const sorted = sortFindings(findings, settings.columns);
  const cellsAll = rows.flatMap((r) => Object.values(r.captures));
  return {
    ok: true,
    range: settings.range,
    generatedAt: new Date().toISOString(),
    defaultLocale: settings.defaultLocale,
    columns: settings.columns,
    baseUrl: settings.baseUrl,
    pages: rows,
    findings: sorted,
    summary: {
      pages: rows.length,
      locales: settings.columns.length,
      captured: cellsAll.filter((c) => c.shot).length,
      notCaptured: cellsAll.filter((c) => !c.shot).length,
      retried: cellsAll.filter((c) => c.retried).length,
      capturedOnRetry: cellsAll.filter((c) => c.retried && c.shot).length,
      notRetried: captures.filter((c) => c.retrySkipped).length,
      findings: summarizeFindings(sorted),
    },
    network,
    timings,
    sheet,
  };
}

// The short text a person or a model reads instead of the sheet: counts, then the findings, then where the sheet is.
export function summaryText(report, { maxLines = 15 } = {}) {
  const { summary } = report;
  const lines = [];
  if (report.dryRun) {
    lines.push(`visual-pack (dry run): ${summary.pages} page${summary.pages === 1 ? '' : 's'} × ${summary.locales} locale${summary.locales === 1 ? '' : 's'} (${report.columns.join(', ')}); nothing built or captured.`);
    for (const p of report.pages) lines.push(`  ${p.key}  changed in ${p.changedIn.join(', ')}  ${p.urls[report.defaultLocale]}`);
    return lines.join('\n');
  }
  lines.push(`visual-pack: ${summary.pages} page${summary.pages === 1 ? '' : 's'} × ${summary.locales} locale${summary.locales === 1 ? '' : 's'} (${report.columns.join(', ')}); ${summary.captured} captured, ${summary.notCaptured} not.`);
  // Only when a view failed to capture: the pack already tried it again with more time, so running it again is not needed.
  const views = (n) => `${n} page view${n === 1 ? '' : 's'} that failed to capture ${n === 1 ? 'was' : 'were'}`;
  const retry = [];
  if (summary.retried) retry.push(`${views(summary.retried)} captured once more, with more time: ${summary.capturedOnRetry} captured, ${summary.retried - summary.capturedOnRetry} not.`);
  if (summary.notRetried) retry.push(`${views(summary.notRetried)} not tried again: the retry's time ran out.`);
  if (retry.length) lines.push(`Retry: ${retry.join(' ')}`);
  const f = summary.findings;
  if (!f.total) {
    lines.push('Findings: none.');
  } else {
    lines.push(`Findings: ${f.problems} to fix, ${f.look} to look at.`);
    lines.push(`  ${Object.entries(f.byType).filter(([, n]) => n).map(([t, n]) => `${t} ${n}`).join(' · ')}`);
    // One line per finding that repeats in several locales of a page, so ten locales do not make ten lines.
    const groups = new Map();
    for (const x of report.findings) {
      const key = [x.type, x.page, x.detail, x.items[0] ?? ''].join('\0');
      const g = groups.get(key) ?? { ...x, locales: [] };
      g.locales.push(x.locale);
      groups.set(key, g);
    }
    const list = [...groups.values()].map((g) => ({ ...g, locales: g.locales.sort((a, b) => report.columns.indexOf(a) - report.columns.indexOf(b)) }));
    for (const x of list.slice(0, maxLines)) {
      lines.push(`  ${x.level === 'problem' ? '!' : '?'} ${TYPES[x.type].title}: ${x.page} [${x.locales.join(', ')}] ${x.detail}${x.items[0] ? ` (${x.items[0]})` : ''}`);
    }
    if (list.length > maxLines) lines.push(`  … ${list.length - maxLines} more in the sheet.`);
  }
  lines.push(`Network: ${report.network.local} local request${report.network.local === 1 ? '' : 's'}, ${report.network.blocked} blocked (not local).`);
  const built = report.timings.buildSeconds === null ? 'skipped (existing build)' : `${report.timings.buildSeconds} s`;
  lines.push(`Time: build ${built}, capture ${report.timings.captureSeconds} s${report.timings.retrySeconds != null ? ` (the retry ${report.timings.retrySeconds} s of it)` : ''}.`);
  lines.push(`Sheet: ${report.sheet}`);
  return lines.join('\n');
}
