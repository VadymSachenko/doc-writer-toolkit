#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CliError, exists, log, writeFileAtomic, writeJson } from '../ui-labels/lib/util.mjs';
import { loadPackSettings } from './lib/config.mjs';
import { changedFiles, buildPages } from './lib/pages.mjs';
import { buildSite, checkBuildDir } from './lib/build.mjs';
import { startServer } from './lib/server.mjs';
import { loadPlaywright, launchBrowser } from './lib/playwright.mjs';
import { captureAll, newNetworkStats, networkView } from './lib/capture.mjs';
import { assemble, summaryText } from './lib/report.mjs';
import { renderSheet } from './lib/sheet.mjs';

const USAGE = `visual-pack --range <git range> [options]

Builds one HTML sheet of the docs pages a git range changed: a row per page, a column per locale, a screenshot in each
cell, and the automatic findings on top (broken images, tables wider than the page, text left untranslated). Makes no
model call. Needs the host's Playwright and Chromium.

Exit codes: 0 sheet written, nothing to fix · 10 sheet written, with findings to fix · 1 the build failed · 2 a missing
declaration, Playwright or Chromium, or bad usage · 3 unexpected error

Options (default: the 'Documentation toolkit configuration' block of <root>/CLAUDE.md)
  --root <dir>             docs repo root (default: cwd)
  --range <git range>      required: the commits to show, such as origin/main...HEAD (the working tree is the end of it)
  --build-dir <dir>        use this build instead of running 'docusaurus build' (the folder it wrote)
  --locales <list>         the columns (default: every locale in docusaurus.config); the default locale is always one
  --out <dir>              where the sheet goes (default <state root>/visual-pack)
  --state-root <dir>       default .doc-toolkit
  --base-url <path>        the site's baseUrl (default: 'Site base URL:', else the docusaurus config, else /)
  --docusaurus-config <f>  path to the Docusaurus config
  --ua-root <dir> --en-root <dir> --url-prefix <path>   the primary root pair  --pair <ids>  only these root pairs
  --viewport <WxH>         default 1280x800     --max-height <px>  longest screenshot, default 8000
  --jobs <n>               pages captured at once, default 4     --timeout <ms>  per page, default 30000
  --playwright-from <dir>  a folder whose node_modules holds Playwright (default: the root; env VISUAL_PACK_PLAYWRIGHT_FROM)
  --dry-run                list the pages and their URLs; build and capture nothing
  --json                   print the report as JSON on stdout instead of the short summary
`;

const OPTIONS = {
  root: { type: 'string' },
  range: { type: 'string' },
  'build-dir': { type: 'string' },
  locales: { type: 'string' },
  out: { type: 'string' },
  'state-root': { type: 'string' },
  'base-url': { type: 'string' },
  'docusaurus-config': { type: 'string' },
  'ua-root': { type: 'string' },
  'en-root': { type: 'string' },
  'url-prefix': { type: 'string' },
  pair: { type: 'string' },
  viewport: { type: 'string' },
  'max-height': { type: 'string' },
  jobs: { type: 'string' },
  timeout: { type: 'string' },
  'playwright-from': { type: 'string' },
  'dry-run': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const seconds = (from) => Math.round((Date.now() - from) / 100) / 10;

// -> { report, exitCode }. Writes <out>/sheet.html, <out>/report.json and <out>/shots/ unless it is a dry run.
export async function run(values, env = process.env) {
  const settings = await loadPackSettings(values, env);
  const files = await changedFiles(settings.root, settings.range);
  const pages = await buildPages(settings.root, files, settings);
  const base = { range: settings.range, defaultLocale: settings.defaultLocale, columns: settings.columns, baseUrl: settings.baseUrl };

  const emptyView = (extra) => ({
    ok: true,
    ...base,
    pages: pages.map((p) => ({ key: p.key, pair: p.pair, rel: p.rel, changedIn: p.changedIn, urls: p.urls, captures: {} })),
    findings: [],
    summary: { pages: pages.length, locales: settings.columns.length, captured: 0, notCaptured: 0, findings: { total: 0, problems: 0, look: 0, byType: {} } },
    ...extra,
  });
  if (!pages.length) return { report: emptyView({ empty: true }), exitCode: 0, text: `visual-pack: no changed docs page in ${settings.range}.` };
  if (settings.dryRun) {
    const report = emptyView({ dryRun: true });
    return { report, exitCode: 0, text: summaryText(report) };
  }

  const started = Date.now();
  const chromium = loadPlaywright(settings.playwrightFrom); // before the build: a host without Playwright fails fast
  const sheetFile = path.join(settings.outDir, 'sheet.html');
  const shotsDir = path.join(settings.outDir, 'shots');
  await fs.mkdir(settings.outDir, { recursive: true });

  // The browser starts before the build: a host without Chromium fails now, not after minutes of building.
  const browser = await launchBrowser(chromium);
  let captures;
  let buildSeconds = null;
  let captureStarted;
  const net = newNetworkStats();
  let server;
  try {
    let buildDir = settings.buildDir;
    if (buildDir) {
      await checkBuildDir(buildDir);
    } else {
      buildDir = path.join(settings.outDir, 'build');
      log(`visual-pack: building the site for ${settings.columns.join(', ')} …`);
      const t = Date.now();
      await buildSite({ root: settings.root, outDir: buildDir, locales: settings.columns, logFile: path.join(settings.outDir, 'build.log') });
      buildSeconds = seconds(t);
      await checkBuildDir(buildDir);
    }
    await fs.rm(shotsDir, { recursive: true, force: true });
    server = await startServer(buildDir, settings.baseUrl);
    captureStarted = Date.now();
    log(`visual-pack: capturing ${pages.length * settings.columns.length} page views …`);
    captures = await captureAll({ browser, server, net, settings, pages, columns: settings.columns, shotsDir, outDir: settings.outDir });
  } finally {
    await browser.close().catch(() => {});
    await server?.close();
  }

  const timings = { buildSeconds, captureSeconds: seconds(captureStarted), totalSeconds: seconds(started) };
  const sheetPath = path.relative(settings.root, sheetFile) || sheetFile;
  const report = assemble({ settings, pages, captures, network: networkView(net, server), timings, sheet: sheetPath.startsWith('..') ? sheetFile : sheetPath });
  await writeFileAtomic(sheetFile, renderSheet(report));
  await writeJson(path.join(settings.outDir, 'report.json'), report);
  // The output shows the host's own pages: keep it out of a commit that takes everything.
  const ignore = path.join(settings.outDir, '.gitignore');
  if (!(await exists(ignore))) await fs.writeFile(ignore, '*\n');
  return { report, exitCode: report.summary.findings.problems ? 10 : 0, text: summaryText(report) };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const { report, exitCode, text } = await run(values, env);
  process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : `${text}\n`);
  return exitCode;
}

// Set the exit code instead of calling process.exit(): exiting right after a large write to a pipe truncates the output.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      if (e instanceof CliError) {
        log(`visual-pack: ${e.message}`);
        process.stdout.write(`${JSON.stringify({ ok: false, error: e.message, ...e.data }, null, 2)}\n`);
        process.exitCode = e.exitCode;
      } else if (e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
        log(`visual-pack: ${e.message}\n\n${USAGE}`);
        process.exitCode = 2;
      } else {
        log(e);
        process.exitCode = 3;
      }
    },
  );
}
