#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CliError, inside, norm, readLedger } from './lib/ledger.mjs';
import { computeStatus, renderMarkdown } from './lib/status.mjs';
import { runRecord } from './lib/record.mjs';

const USAGE = `section-state <command> <section> [options]

Keeps the ledger of a /document-section run, <section>/.sources/section-state.json, and checks it against the files.

Commands
  status <section>   Each stage's state (done, stale, pending, …) from the ledger and the current file hashes, the
                     pages, the next stage and the open gate. Writes nothing.
  record <section>   Records one stage result. A 'done' is checked against the files first; on any problem
                     nothing is written (exit 1). The first record creates the ledger.

<section> is the section folder, relative to the repo root (docs/reports).

Options
  --root <dir>              docs repo root (default: cwd)
  --md                      status: a Markdown status block instead of JSON
  --stage <name>            record: readiness, explore, plan, planApproval, resolve (section stages) or
                            write, fix, review, uaApproval, translate, align (page stages)
  --status <status>         record: running, done, skipped (explore, resolve), failed
  --page <id|path>          record: a page of the run, for a page stage; repeat it for several pages
  --note <text>             record: the reason, required for skipped and failed
  --result <json>           record: the stage's counts, stored as given ({"errors":0,"round":1})
  --options <json>          record: the run's options, merged into the ledger ({"interview":"skip"})
  --ua-root <dir>           record: the section's UA content root; with --en-root, creates the ledger
  --en-root <dir>           record: the EN i18n root of the same root pair
  --pair <id>               record: the root pair's id, when the host declares more than one
  --saved-as <path>         record --stage write --status done: where the writer saved the page, when the plan
                            said another path
  -h, --help                this text
`;

const OPTIONS = {
  root: { type: 'string' },
  md: { type: 'boolean' },
  stage: { type: 'string' },
  status: { type: 'string' },
  page: { type: 'string', multiple: true },
  note: { type: 'string' },
  result: { type: 'string' },
  options: { type: 'string' },
  'ua-root': { type: 'string' },
  'en-root': { type: 'string' },
  pair: { type: 'string' },
  'saved-as': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

const print = (value) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

async function main() {
  const { values, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true });
  const [command, section, ...rest] = positionals;
  if (values.help || !command || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!['status', 'record'].includes(command)) throw new CliError(`unknown command '${command}'.\n\n${USAGE}`);
  if (!section) throw new CliError(`${command} needs the section folder.\n\n${USAGE}`);
  if (rest.length) throw new CliError(`unexpected argument '${rest[0]}'`);
  const root = path.resolve(values.root ?? '.');
  const rel = norm(path.isAbsolute(section) ? path.relative(root, section) : section);
  if (!rel || rel.startsWith('..') || !inside(rel, '')) throw new CliError(`the section ${section} is outside the repo root ${root}`);

  if (command === 'status') {
    const st = await computeStatus(root, rel, await readLedger(root, rel));
    if (values.md) process.stdout.write(renderMarkdown(st) + '\n');
    else print(st);
    return 0;
  }
  if (!values.stage || !values.status) throw new CliError('record needs --stage and --status');
  print(await runRecord(root, rel, {
    stage: values.stage,
    status: values.status,
    pages: values.page ?? [],
    note: values.note,
    result: values.result,
    options: values.options,
    uaRoot: values['ua-root'],
    enRoot: values['en-root'],
    pair: values.pair,
    savedAs: values['saved-as'],
  }));
  return 0;
}

// Set the exit code instead of calling process.exit(): exiting right after a large write to a pipe truncates the output.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    if (e instanceof CliError || e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      console.error(`section-state: ${e.message}`);
      print({ ok: false, error: e.message.split('\n\n')[0] });
      process.exitCode = e.exitCode ?? 2;
    } else {
      console.error(e);
      process.exitCode = 1;
    }
  },
);
