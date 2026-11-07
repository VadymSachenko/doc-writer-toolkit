#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CliError } from './lib/errors.mjs';
import { loadSettings } from './lib/settings.mjs';
import { makeClients } from './lib/world.mjs';
import { runDaily } from './lib/runner.mjs';
import { usageOf } from './ticket-state.mjs';

const USAGE = `runner [options]

The daily run of a docs pipeline: finish first (merged, ready for merge, final review, review comments, answers in,
writing), then, with --morning, triage the intake cards that have been quiet for their hours, then start ready groups
while the WIP limits and the day's allowance allow. The order comes from 'ticket-state status'; each step that needs
a model is one 'claude -p' session in its role (model and effort from the settings' roles). Writes the morning report.

Options
  --dry-run                 print the plan: each step, its calls or its claude command line; start nothing, write
                            nothing (no ledger, no lock, no report file, no tracker or forge change)
  --morning                 also triage the intake cards that are due
  --manual                  a manual run: its tickets stay out of the limits for their whole life; it starts only the
                            ready tickets named with --ticket, ignoring the limits
  --watcher                 the watcher's run: finish only the tickets named with --ticket (guarded and counted like
                            a scheduled run); no triage, no start of a ready group
  --ticket <key>            only these tickets (repeatable)
  --usage-file <file|->     the text of 'claude -p /usage' (default: the runner reads it)
  --claude <bin>            the claude command (default: claude)
  --root <dir>              the host repo (default: cwd)
  --settings <file>         the ticket flow settings file
  --origin <url>            the tracker's API origin (tests)
  -h, --help                this text
`;

const OPTIONS = {
  'dry-run': { type: 'boolean' },
  morning: { type: 'boolean' },
  manual: { type: 'boolean' },
  watcher: { type: 'boolean' },
  ticket: { type: 'string', multiple: true },
  'usage-file': { type: 'string' },
  claude: { type: 'string' },
  root: { type: 'string' },
  settings: { type: 'string' },
  origin: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

export async function main(argv, io = {}) {
  const { stdout = process.stdout, env = process.env } = io;
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  if (values.help || positionals[0] === 'help') {
    stdout.write(USAGE);
    return 0;
  }
  if (positionals.length) throw new CliError(`unexpected argument '${positionals[0]}'.\n\n${USAGE}`, { code: 2 });
  if (values.manual && values.watcher) throw new CliError('--manual and --watcher are two kinds of run: give one', { code: 2 });
  if (values.ticket?.length && !values.manual && !values.watcher) throw new CliError('--ticket goes with --manual or --watcher: a scheduled run takes every ticket', { code: 2 });
  if (values.watcher && !values.ticket?.length) throw new CliError('--watcher needs the tickets it finishes (--ticket)', { code: 2 });
  if (values.watcher && values.morning) throw new CliError('--watcher runs no morning triage', { code: 2 });
  const root = path.resolve(values.root ?? process.cwd());
  const settings = await loadSettings({ root, settings: values.settings });
  const dryRun = Boolean(values['dry-run']);
  const clients = makeClients({ settings, env, dryRun, io: { ...io, ...(values.origin ? { trackerOrigin: values.origin } : {}) } });
  const fixed = values['usage-file'] !== undefined ? await usageOf(values, io) : undefined;
  const result = await runDaily({
    settings,
    clients,
    io: { ...io, ...(fixed !== undefined ? { readUsage: () => fixed } : {}) },
    options: { dryRun, morning: Boolean(values.morning), trigger: values.manual ? 'manual' : values.watcher ? 'watcher' : 'schedule', named: values.ticket ?? [], claude: values.claude ?? 'claude' },
  });
  const out = { ok: true, command: 'run', ...result, requests: clients.requests(), caught: clients.caught() };
  stdout.write(JSON.stringify(out, null, 2) + '\n');
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      if (e?.exitCode !== undefined || e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
        console.error(`runner: ${e.message}`);
        process.stdout.write(JSON.stringify({ ok: false, error: e.message.split('\n\n')[0], ...(e.data ?? {}) }, null, 2) + '\n');
        process.exitCode = e.exitCode ?? 2;
      } else {
        console.error(e);
        process.exitCode = 1;
      }
    },
  );
}
