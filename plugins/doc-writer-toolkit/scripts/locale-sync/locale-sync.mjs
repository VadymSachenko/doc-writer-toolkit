#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CliError, log, readJson, printJson } from '../ui-labels/lib/util.mjs';
import { loadSyncSettings, resolveTargets, selectPages } from './lib/settings.mjs';
import { listUaPages } from './lib/pages.mjs';
import { runStatus } from './lib/status.mjs';
import { runBlocks } from './lib/blocks.mjs';
import { linkAssets } from './lib/assets.mjs';
import { checkTranslation } from './lib/checks.mjs';
import { runRecord } from './lib/record.mjs';
import { renderMarkdown, runReport } from './lib/report.mjs';
import { runBind, runDecisions } from './lib/bind.mjs';
import { runApply } from './lib/apply.mjs';
import { addTerms, dropTerms, lookupTerms } from './lib/terms.mjs';
import { termUsage } from './lib/usage.mjs';

const USAGE = `locale-sync <command> [<page|folder>…] [options]

Commands
  status [<page|folder>…]   Which UA pages are stale per locale (git blob hashes against the per-page state files).
  blocks <page>…            The UA blocks to translate, with the matching translated text (blob A -> B, changed-blocks.md),
                            the label strings and the term-memory rows for those blocks.
  apply <page>              Writes a candidate file from the translations of the blocks: { "c1": "…" } or { "full": "…" }.
  bind [<page|folder>…]     Binding pass: records the span decisions the script can make; lists the rest for the model.
  bind --decisions <file>   Records the model's decisions { "<page>": { "<span>": "label:<key>|unverified|term|emphasis" } }.
                            A key "<span>@<heading>" (heading title or #anchor) scopes a decision to that heading.
  terms <UA term>…          Term memory and UI strings per locale for these terms; which ones still need a translation.
  terms --add <file>        Appends entries (TSV or JSON) to one locale's term memory (--locales <locale>).
                            --replace: a different translation replaces the recorded one (a correction).
  terms --drop <UA term>…   Removes these terms' entries from one locale's term memory.
  terms --usage <old>…      Where one locale's pages still use an old translation: page, line, block, and the --redo
                            value that re-translates those blocks. Narrow the pages with --scope.
  link-assets <page>…       Relative per-file symlinks to the EN screenshots in each locale; real files are overrides.
  check <page>…             Every Requirement 8 check on the translated page. Exit 1 if any fails.
  record <page>…            Runs the checks, then advances the page's state. Nothing is recorded if a check fails.
  report [<page>…]          Requirement 13 tables: exists / images resolve / checks passed, local URLs, optional build.

A <page> is a page id (disputes/manage-disputes), a path, or a folder, relative to the repo root or the UA content root.

Project options (default: the 'Documentation toolkit configuration' block of <root>/CLAUDE.md)
  --root <dir>             docs repo root (default: cwd)
  --locales <list>         narrow the run to these target locales (default: all from docusaurus.config.ts)
  --scope <list>           folders or pages in scope (default: 'Translation scope:' or the whole UA content root)
  --ua-root <dir> --en-root <dir>   content roots; locale roots derive from the EN root
  --state-root <dir>       default .doc-toolkit
  --docusaurus-config <f>  path to the Docusaurus config

status / blocks / bind:  --overwrite (translate pages that have a locale file but no state)  --threshold <n> (default 10)
bind / terms --add / terms --drop:  --dry-run
apply:                   --translations <file.json>  --out <candidate file>  (one page, one locale)
blocks / apply:   --redo <lines|all>  re-translate blocks of a current page: target line numbers ("12,14-16") pick
                  the blocks they fall in; "all" the whole page (a category is always whole)
blocks:           --with-old (include the previous UA text of each changed block)
link-assets:      --dry-run
check / record:   --candidate <file> (check/install this file instead of the translation on disk; one page, one locale)
                  --unverified-file <json>  UA spans recorded as unverified in this run
record:           --dry-run  --date <YYYY-MM-DD>
report:           --md  --build  --origin <url> (default http://localhost:3000)  --url-prefix <prefix>
`;

const OPTIONS = {
  root: { type: 'string' },
  locales: { type: 'string' },
  scope: { type: 'string' },
  'ua-root': { type: 'string' },
  'en-root': { type: 'string' },
  'state-root': { type: 'string' },
  'docusaurus-config': { type: 'string' },
  'url-prefix': { type: 'string' },
  overwrite: { type: 'boolean' },
  threshold: { type: 'string' },
  'with-old': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  candidate: { type: 'string' },
  'unverified-file': { type: 'string' },
  date: { type: 'string' },
  decisions: { type: 'string' },
  translations: { type: 'string' },
  out: { type: 'string' },
  add: { type: 'string' },
  replace: { type: 'boolean' },
  drop: { type: 'boolean' },
  usage: { type: 'boolean' },
  redo: { type: 'string' },
  md: { type: 'boolean' },
  build: { type: 'boolean' },
  origin: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

async function main() {
  const { values, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true });
  const [command, ...selectors] = positionals;
  if (!command || values.help || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  const s = await loadSyncSettings(values);

  switch (command) {
    case 'status': {
      const threshold = values.threshold ? Number(values.threshold) : undefined;
      const status = await runStatus(s, { selectors, overwrite: values.overwrite, threshold });
      for (const w of status.warnings) log(`locale-sync: ${w}`);
      printJson(status);
      return 0;
    }
    case 'blocks': {
      const out = await runBlocks(s, { selectors, overwrite: values.overwrite, withOld: values['with-old'], redo: values.redo });
      for (const w of out.warnings) log(`locale-sync: ${w}`);
      printJson(out);
      return 0;
    }
    case 'apply': {
      if (selectors.length !== 1) throw new CliError('Usage: locale-sync apply <page> --locales <locale> --translations <file.json> --out <candidate file>', { code: 2 });
      printJson(await runApply(s, selectors[0], { translations: values.translations, out: values.out, redo: values.redo }));
      return 0;
    }
    case 'bind': {
      if (values.decisions) {
        const out = await runDecisions(s, values.decisions, { dryRun: values['dry-run'] });
        printJson(out);
        return out.rejected.length ? 1 : 0;
      }
      const out = await runBind(s, { selectors, overwrite: values.overwrite, dryRun: values['dry-run'] });
      for (const w of out.warnings) log(`locale-sync: ${w}`);
      printJson(out);
      return 0;
    }
    case 'terms': {
      const { targets } = await resolveTargets(s);
      const one = (flag) => {
        if (targets.length !== 1) throw new CliError(`terms ${flag} needs exactly one locale (--locales <locale>).`, { code: 2 });
        return targets[0];
      };
      if (values.add) {
        const out = await addTerms(s, one('--add'), values.add, { dryRun: values['dry-run'], replace: values.replace });
        printJson(out);
        return out.rejected.length ? 1 : 0;
      }
      if (values.drop || values.usage) {
        const flag = values.drop ? '--drop' : '--usage';
        if (!selectors.length) throw new CliError(`Usage: locale-sync terms ${flag} <${values.drop ? 'UA term' : 'old translation'}>… --locales <locale>`, { code: 2 });
        const locale = one(flag);
        if (values.drop) {
          printJson(await dropTerms(s, locale, selectors, { dryRun: values['dry-run'] }));
          return 0;
        }
        printJson(await termUsage(s, locale, selectors));
        return 0;
      }
      if (!selectors.length) throw new CliError('Usage: locale-sync terms <UA term>… [--locales tr,kk]  |  terms --add <file> --locales <locale>', { code: 2 });
      const out = await lookupTerms(s, selectors, targets);
      for (const w of out.warnings) log(`locale-sync: ${w}`);
      printJson(out);
      return 0;
    }
    case 'link-assets': {
      if (!selectors.length) throw new CliError('Usage: locale-sync link-assets <page|folder>… [--locales tr,kk] [--dry-run]', { code: 2 });
      const { targets } = await resolveTargets(s);
      const { all, inScope } = await listUaPages(s);
      const results = [];
      for (const page of selectPages(s, inScope, selectors)) for (const locale of targets) results.push(await linkAssets(s, page, locale, all, { dryRun: values['dry-run'] }));
      const problems = results.flatMap((r) => r.links.filter((l) => ['missing', 'foreign-dangling', 'skipped'].includes(l.status)).map((l) => ({ page: r.page, locale: r.locale, ...l })));
      printJson({ dryRun: Boolean(values['dry-run']), results, problems });
      return problems.length ? 1 : 0;
    }
    case 'check': {
      if (!selectors.length) throw new CliError('Usage: locale-sync check <page|folder>… [--locales tr,kk] [--candidate <file>]', { code: 2 });
      const { targets } = await resolveTargets(s);
      const { inScope, categoriesInScope } = await listUaPages(s);
      const pages = selectPages(s, [...inScope, ...categoriesInScope], selectors);
      if (values.candidate && (pages.length !== 1 || targets.length !== 1)) throw new CliError('--candidate needs exactly one page and one locale (--locales <locale>).', { code: 2 });
      const unverified = values['unverified-file'] ? await readJson(path.resolve(values['unverified-file'])) : [];
      const results = [];
      for (const page of pages) {
        for (const locale of targets) {
          const { ok, failures, warnings, checks, file } = await checkTranslation(s, page, locale, { candidate: values.candidate, unverified });
          results.push({ page: page.id, locale, file, ok, checks, failures, warnings });
        }
      }
      const ok = results.every((r) => r.ok);
      printJson({ ok, results });
      return ok ? 0 : 1;
    }
    case 'record': {
      const out = await runRecord(s, { selectors, candidate: values.candidate, unverifiedFile: values['unverified-file'], date: values.date, dryRun: values['dry-run'] });
      const ok = out.results.every((r) => r.recorded);
      printJson({ ok, ...out });
      return ok ? 0 : 1;
    }
    case 'report': {
      const report = await runReport(s, { changed: selectors, build: values.build, origin: values.origin });
      if (values.md) process.stdout.write(renderMarkdown(report) + '\n');
      else printJson(report);
      return report.allGood ? 0 : 1;
    }
    default:
      throw new CliError(`Unknown command '${command}'.\n\n${USAGE}`, { code: 2 });
  }
}

// Set the exit code instead of calling process.exit(): exiting right after a large write to a pipe truncates the output.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    if (e instanceof CliError) {
      log(`locale-sync: ${e.message}`);
      printJson({ error: e.message, ...e.data });
      process.exitCode = e.exitCode;
    } else if (e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      log(`locale-sync: ${e.message}\n\n${USAGE}`);
      process.exitCode = 2;
    } else {
      log(e);
      process.exitCode = 1;
    }
  },
);
