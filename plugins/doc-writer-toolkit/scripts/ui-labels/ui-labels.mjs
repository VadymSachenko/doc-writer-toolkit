#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CliError, log, printJson } from './lib/util.mjs';
import { loadSettings } from './lib/config.mjs';
import { runCheck } from './lib/check.mjs';
import { runImport } from './lib/importer.mjs';
import { diffSnapshots, diffSummary } from './lib/diff.mjs';
import { loadStore } from './lib/store.mjs';
import { renderLookupTable, runLookup } from './lib/lookup.mjs';
import { runSync } from './lib/sync.mjs';

const USAGE = `ui-labels <command> [options]

Commands
  check                  Did the app's locale files change since the last import? Exit 10 if something needs doing.
  import                 Import the locale files into <state root>/ui-labels/ (+ ticket overlay, + library strings).
  diff <from> <to>       Compare two ui-labels snapshot directories.
  lookup <span>...       Look up UA strings in the store. --search <text> searches instead.
  sync                   Patch docs pages for the diff left by the last import. --commit commits the result.
  hardcoded              Phase 2, not implemented.

Project options (default: the 'Documentation toolkit configuration' block of <root>/CLAUDE.md)
  --root <dir>              docs repo root (default: cwd)
  --source <spec>           'github owner/repo@branch dir/*.json' | 'command <cmd with {locale}>'
  --locale-files <map>      'uk=ua, es=ar'
  --locales <list>          target locales (default: docusaurus.config.ts i18n.locales minus default and en)
  --docusaurus-config <f>   path to the Docusaurus config
  --state-root <dir>        default .doc-toolkit
  --ua-root <dir>  --en-root <dir>   page roots (sync)
  --ticket <n[,n]>          ticket number(s) for the overlay (default: leading numbers of the git branch)

import:  --dry-run  --no-libs  --discard-pending
sync:    --commit  --dry-run  --diff <file>
lookup:  --file <path|->  --search <text>  --limit <n>  --json
`;

const OPTIONS = {
  root: { type: 'string' },
  source: { type: 'string' },
  'locale-files': { type: 'string' },
  locales: { type: 'string' },
  'docusaurus-config': { type: 'string' },
  'state-root': { type: 'string' },
  'ua-root': { type: 'string' },
  'en-root': { type: 'string' },
  ticket: { type: 'string' },
  'dry-run': { type: 'boolean' },
  'no-libs': { type: 'boolean' },
  'discard-pending': { type: 'boolean' },
  commit: { type: 'boolean' },
  diff: { type: 'string' },
  file: { type: 'string' },
  search: { type: 'string' },
  limit: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

async function main() {
  const { values, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true });
  const [command, ...rest] = positionals;
  if (!command || values.help || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command === 'hardcoded') {
    printJson({ status: 'not-implemented', note: 'Phase 2: lists hardcoded Cyrillic strings in the frontend code.' });
    return 3;
  }

  if (command === 'diff') {
    if (rest.length !== 2) throw new CliError('Usage: ui-labels diff <from-dir> <to-dir>', { code: 2 });
    const [from, to] = await Promise.all(rest.map((d) => loadStore(path.resolve(d))));
    if (!from || !to) throw new CliError('Both directories must contain a ui-labels snapshot (meta.json).', { code: 2 });
    const diff = diffSnapshots(from.labels, to.labels);
    printJson({ from: from.meta.commit, to: to.meta.commit, summary: diffSummary(diff), ...diff });
    return 0;
  }

  const settings = await loadSettings(values);

  switch (command) {
    case 'check': {
      const result = await runCheck(settings);
      printJson(result);
      return result.changed ? 10 : 0;
    }
    case 'import':
      printJson(await runImport(settings, { dryRun: values['dry-run'], noLibs: values['no-libs'], discardPending: values['discard-pending'] }));
      return 0;
    case 'lookup': {
      const spans = [...rest];
      if (values.file) {
        const text = values.file === '-' ? await readStdin() : await fs.readFile(values.file, 'utf8');
        spans.push(...text.split('\n').map((s) => s.trim()).filter(Boolean));
      }
      if (!spans.length && !values.search) throw new CliError('Give at least one span, --file, or --search.', { code: 2 });
      const out = await runLookup(settings, {
        spans,
        search: values.search,
        locales: values.locales?.split(',').map((l) => l.trim()),
        limit: values.limit ? Number(values.limit) : undefined,
      });
      if (values.json) printJson(out);
      else process.stdout.write(renderLookupTable(out) + '\n');
      return 0;
    }
    case 'sync':
      printJson(await runSync(settings, { commit: values.commit, dryRun: values['dry-run'], diffFile: values.diff }));
      return 0;
    default:
      throw new CliError(`Unknown command '${command}'.\n\n${USAGE}`, { code: 2 });
  }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// Set the exit code instead of calling process.exit(): exiting right after a large write to a pipe truncates the output.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    if (e instanceof CliError) {
      log(`ui-labels: ${e.message}`);
      printJson({ error: e.message, ...e.data });
      process.exitCode = e.exitCode;
    } else if (e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      log(`ui-labels: ${e.message}\n\n${USAGE}`);
      process.exitCode = 2;
    } else {
      log(e);
      process.exitCode = 1;
    }
  },
);
