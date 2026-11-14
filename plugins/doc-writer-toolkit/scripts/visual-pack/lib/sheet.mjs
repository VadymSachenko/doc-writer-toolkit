import { TYPES, TYPE_ORDER, sortFindings } from './findings.mjs';

export const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const cellId = (pageIndex, locale) => `c-${pageIndex}-${locale.replace(/[^A-Za-z0-9_-]/g, '_')}`;
// A relative path from the sheet to a screenshot, with each segment encoded.
const hrefOf = (rel) => rel.split('/').map(encodeURIComponent).join('/');

const CSS = `
:root { color-scheme: light dark; --bg:#fff; --fg:#1b1f23; --muted:#59636e; --line:#d0d7de; --problem:#b42318; --problem-bg:#fef3f2; --look:#8a5a00; --look-bg:#fff8e6; --ok:#067647; }
@media (prefers-color-scheme: dark) { :root { --bg:#14181d; --fg:#e6edf3; --muted:#9aa4af; --line:#30363d; --problem:#ff8a80; --problem-bg:#3a1c1a; --look:#f0c060; --look-bg:#35290f; --ok:#5ed39a; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; }
h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 24px 0 8px; }
.muted { color: var(--muted); } code { font: 12px ui-monospace, monospace; }
table { border-collapse: collapse; } th, td { border: 1px solid var(--line); padding: 6px 8px; vertical-align: top; text-align: left; }
.findings td.problem { color: var(--problem); font-weight: 600; } .findings td.look { color: var(--look); font-weight: 600; }
.findings tr.problem { background: var(--problem-bg); } .findings tr.look { background: var(--look-bg); }
.findings ul { margin: 4px 0 0; padding-left: 18px; }
.grid { display: block; overflow: auto; max-width: 100%; }
.grid th.page { position: sticky; left: 0; background: var(--bg); min-width: 180px; max-width: 260px; }
.grid td { width: 240px; min-width: 240px; }
.grid img { display: block; width: 100%; height: auto; max-height: 360px; object-fit: cover; object-position: top; border: 1px solid var(--line); }
.badge { display: inline-block; margin: 4px 4px 0 0; padding: 0 6px; border-radius: 8px; font-size: 12px; }
.badge.problem { background: var(--problem-bg); color: var(--problem); } .badge.look { background: var(--look-bg); color: var(--look); }
.clean { color: var(--ok); }
`;

function findingsSection(report, pageIndex) {
  const sorted = sortFindings(report.findings, report.columns);
  if (!sorted.length) return '<p class="clean">No automatic findings.</p>';
  const rows = sorted
    .map((f) => {
      const items = f.items.length ? `<ul>${f.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : '';
      const target = `#${cellId(pageIndex.get(f.page), f.locale)}`;
      return `<tr class="${f.level}"><td class="${f.level}">${escapeHtml(TYPES[f.type].title)}</td><td><code>${escapeHtml(f.page)}</code></td><td><a href="${target}">${escapeHtml(f.locale)}</a></td><td>${escapeHtml(f.detail)}${items}</td></tr>`;
    })
    .join('\n');
  return `<table class="findings"><thead><tr><th>Finding</th><th>Page</th><th>Locale</th><th>Detail</th></tr></thead><tbody>\n${rows}\n</tbody></table>`;
}

function cell(report, page, pageIdx, locale) {
  const capture = page.captures[locale];
  const mine = report.findings.filter((f) => f.page === page.key && f.locale === locale);
  const badges = mine.map((f) => `<span class="badge ${f.level}">${escapeHtml(TYPES[f.type].title)}</span>`).join('');
  let body;
  if (capture?.shot) {
    body = `<a href="${hrefOf(capture.shot)}"><img src="${hrefOf(capture.shot)}" alt="${escapeHtml(`${page.key} in ${locale}`)}" loading="lazy"></a>${capture.cropped ? '<div class="muted">cropped at the height limit</div>' : ''}${capture.retried ? `<div class="muted">captured on the second try (the first: ${escapeHtml(capture.firstError)})</div>` : ''}`;
  } else {
    body = `<div class="muted">not captured${capture?.retried ? ', twice' : ''}${capture?.retrySkipped ? " (not tried again: the retry's time ran out)" : ''}${capture?.error ? `: ${escapeHtml(capture.error)}` : ''}</div>`;
  }
  return `<td id="${cellId(pageIdx, locale)}">${body}${badges ? `<div>${badges}</div>` : ''}</td>`;
}

// The whole sheet as one HTML string. Everything that came from a page or a finding is escaped.
export function renderSheet(report) {
  const pageIndex = new Map(report.pages.map((p, i) => [p.key, i]));
  const { summary } = report;
  const counts = TYPE_ORDER.filter((t) => summary.findings.byType[t]).map((t) => `${escapeHtml(TYPES[t].title)}: ${summary.findings.byType[t]}`);
  const head = report.columns.map((l) => `<th>${escapeHtml(l)}${l === report.defaultLocale ? ' <span class="muted">(source)</span>' : ''}</th>`).join('');
  const rows = report.pages
    .map((page, i) => {
      const label = `<th class="page" scope="row"><code>${escapeHtml(page.key)}</code><div class="muted">changed in ${escapeHtml(page.changedIn.join(', '))}</div></th>`;
      return `<tr>${label}${report.columns.map((l) => cell(report, page, i, l)).join('')}</tr>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Visual review pack</title>
<style>${CSS}</style>
</head>
<body>
<h1>Visual review pack</h1>
<p class="muted">Range <code>${escapeHtml(report.range)}</code> · ${report.pages.length} page${report.pages.length === 1 ? '' : 's'} × ${report.columns.length} locale${report.columns.length === 1 ? '' : 's'} · ${escapeHtml(report.generatedAt)}</p>
<h2>Automatic findings</h2>
<p>${summary.findings.problems} to fix, ${summary.findings.look} to look at${counts.length ? ` (${counts.join(' · ')})` : ''}.</p>
${findingsSection(report, pageIndex)}
<h2>Pages</h2>
<table class="grid"><thead><tr><th class="page">Page</th>${head}</tr></thead>
<tbody>
${rows}
</tbody></table>
</body>
</html>
`;
}
