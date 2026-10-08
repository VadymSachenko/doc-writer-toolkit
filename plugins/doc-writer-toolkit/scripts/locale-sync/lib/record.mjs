import path from 'node:path';
import { CliError, readJson, writeFileAtomic, writeJson } from '../../ui-labels/lib/util.mjs';
import { currentFallbacks } from './assets.mjs';
import { checkTranslation } from './checks.mjs';
import { abs, listUaPages, readState, statePath } from './pages.mjs';
import { withLock } from './lock.mjs';
import { resolveTargets, selectPages } from './settings.mjs';
import { boldSpans, parseFrontmatter, splitCode } from './parse.mjs';
import { applyCategoryMessages } from './categories.mjs';

const spanOf = (u) => (typeof u === 'string' ? u : u.span);

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// UA pages write `last_update.date` as M/D/YYYY (9/8/2026); keep whatever format the UA page uses.
function formatLike(uaText, iso) {
  const fm = parseFrontmatter(uaText.split('\n'));
  const entry = fm?.entries.find((e) => e.key === 'last_update');
  const m = entry?.raw.match(/\bdate\s*:\s*['"]?(\S+?)['"]?\s*[,}]?\s*$/m);
  const [y, mo, d] = iso.split('-').map(Number);
  return m && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(m[1]) ? `${mo}/${d}/${y}` : iso;
}

// Sets `last_update.date` in the translation's frontmatter. The UA page is never touched.
export function setLastUpdate(text, formatted) {
  const lines = text.split('\n');
  const fm = parseFrontmatter(lines);
  if (!fm) return text;
  const e = fm.entries.find((x) => x.key === 'last_update');
  if (!e) {
    lines.splice(fm.end, 0, 'last_update:', `  date: ${formatted}`);
  } else if (e.first.startsWith('{')) {
    lines[e.start] = lines[e.start].replace(/\bdate\s*:\s*[^,}]+/, `date: ${formatted}`);
  } else {
    const at = lines.findIndex((l, i) => i > e.start && i <= e.end && /^\s+date\s*:/.test(l));
    if (at >= 0) lines[at] = lines[at].replace(/(date\s*:\s*).*$/, `$1${formatted}`);
    else lines.splice(e.start + 1, 0, `  date: ${formatted}`);
  }
  return lines.join('\n');
}

// Runs the checks; only if they all pass does it (optionally install the candidate and) advance the page's state.
export async function runRecord(s, { selectors = [], candidate = null, unverifiedFile = null, date = null, dryRun = false } = {}) {
  if (!selectors.length) throw new CliError('Usage: locale-sync record <page> --locales <locale> [--candidate <file>] [--unverified-file <json>]', { code: 2 });
  const { targets } = await resolveTargets(s);
  const { inScope, categoriesInScope } = await listUaPages(s);
  const pages = selectPages(s, [...inScope, ...categoriesInScope], selectors);
  if (candidate && (pages.length !== 1 || targets.length !== 1)) {
    throw new CliError('--candidate needs exactly one page and one locale (--locales <locale>).', { code: 2 });
  }
  const given = unverifiedFile ? await readJson(path.resolve(unverifiedFile)) : [];
  if (!Array.isArray(given)) throw new CliError(`${unverifiedFile} must contain a JSON array of UA spans (or { span, reason } objects).`, { code: 2 });
  const iso = date ?? today();

  const results = [];
  for (const page of pages) {
    for (const locale of targets) {
      const c = await checkTranslation(s, page, locale, { candidate, unverified: given });
      if (!c.ok) {
        results.push({ page: page.id, locale, recorded: false, failures: c.failures, note: 'The state was not advanced and no file was written.' });
        continue;
      }

      // The recorded `unverified` list: this run's entries plus earlier ones, minus spans that left the page or now verify.
      const expectedFor = (span) => {
        const decision = c.state.spans[span];
        return decision?.startsWith('label:') ? c.labels?.[locale]?.[decision.slice(6)] : undefined;
      };
      let present;
      let verified;
      let assetFallbacks = [];
      if (page.kind === 'category') {
        // The category's messages go into the locale's current.json; nothing else in that file is touched.
        if (!dryRun && candidate) await applyCategoryMessages(s, c.category);
        present = new Set(c.category.parsed.fields.map((f) => f.ua));
        verified = (span) => c.category.target.entries.some((e) => e.field === 'label' && e.ua === span && expectedFor(span) !== undefined && c.category.messages.get(e.entryKey) === expectedFor(span));
      } else {
        // Finalize the file: last_update.date goes into the translation only.
        const finalText = setLastUpdate(c.targetText, formatLike(c.uaText, iso));
        if (!dryRun && (candidate || finalText !== c.targetText)) await writeFileAtomic(abs(s, c.file), finalText);
        present = new Set(boldSpans(splitCode(c.uaText).prose));
        const prose = splitCode(finalText).prose.join('\n');
        verified = (span) => expectedFor(span) !== undefined && prose.includes(`**${expectedFor(span)}**`);
        assetFallbacks = await currentFallbacks(s, page, locale, c.uaText);
      }
      const merged = new Map();
      for (const u of [...(c.state.locales[locale]?.unverified ?? []), ...given]) merged.set(spanOf(u), u);
      for (const [span] of merged) if (!present.has(span) || verified(span)) merged.delete(span);

      const entry = {
        sourceBlob: page.blob,
        labelSnapshot: c.store?.meta.commit ?? null,
        translatedAt: iso,
        unverified: [...merged.values()],
        assetFallbacks,
      };
      // Re-read under the lock: the workers of other locales record this page's state file in parallel.
      if (!dryRun) {
        const file = statePath(s, page.id);
        await withLock(file, async () => {
          const fresh = await readState(s, page.id);
          await writeJson(file, { ...fresh, locales: { ...fresh.locales, [locale]: entry } });
        });
      }
      results.push({ page: page.id, locale, recorded: true, dryRun, file: c.file, state: path.relative(s.root, statePath(s, page.id)), entry, warnings: c.warnings });
    }
  }
  return { results };
}
