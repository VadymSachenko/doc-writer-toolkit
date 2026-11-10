#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CliError } from './lib/errors.mjs';
import { loadSettings, printable } from './lib/settings.mjs';
import { makeClients, makeGit } from './lib/world.mjs';
import { computeStatus } from './lib/status.mjs';
import { runRecord } from './lib/record.mjs';
import { groupOfKey, runHandover, runLock, runUnlock } from './lib/handover.mjs';
import { readAllLedgers } from './lib/ledger.mjs';
import { parseUsage } from './lib/allowance.mjs';
import { localDate, readRunLog, renderReport, writeReport } from './lib/report.mjs';
import { readUsageFromClaude } from './lib/runner.mjs';
import { setLocal } from './lib/setlocal.mjs';
import { runImport } from './lib/import.mjs';
import { renderTrace } from './lib/trace.mjs';
import { ROLE_SESSION_VARIABLE } from './lib/env.mjs';

const USAGE = `ticket-state <command> [<key>] [options]

The ticket ledger of a docs pipeline and the next-step rule: what state each ticket is in, what runs next, which gate
is open, the WIP counts and the ready groups a scheduled run may start. No AI: the tracker and forge scripts' modules
read the board and the PRs, git reads the branches, and the ledgers (<state>/tickets/<key>.json) hold only what those
can't show. The world wins over the ledger.

Commands
  status                    Each ticket's state, next step, gate and mismatches; the intake; wip; startable. Writes nothing.
  record <key>              One stage result (--stage, --status), written only when the tracker, the forge and the
                            files support it; else nothing is written (exit 1). --run <json> alone adds a session's cost.
  handover <key>            Hands a ticket to the pipeline (mode hand -> pipeline; a missing ledger is rebuilt first),
                            or back with --to hand.
  lock <key> | --group <g>  Takes the group's lock (--kind schedule|manual). Refused while another run holds it.
  unlock <key> | --group <g>  Releases it; --stale moves a stale lock aside and records its running stages failed.
  config                    The merged settings (shared file + local file + defaults), as the skills read them.
  intake                    The intake cards: due for triage (quiet for the quiet hours) and still waiting.
  report                    Writes the morning report <state>/reports/<date>.md (--print: to stdout instead).
  set <key> <value>         Sets one key of the owner's local settings file (mode, limits.*, schedule.*, roles.*,
                            modelLadder, video.*, cleanup.*), checked before it is written; --unset drops it.
                            'set retry <key|all>' gives a held or waiting step one more try (no setting does);
                            'set retry job <name>' re-arms a host job the watcher disarmed.
  trace <key>               What the sessions of one ticket did, stage by stage, as plain text for a person: the ledger's runs
                            and, for each, the actions in its transcript (read, searched, ran, app, wrote, skill, agent, other),
                            with a refused or failed marker, the session's last text and its subagents' actions. Tool results and
                            written content are never printed, secrets are masked. A transcript holds actions and written texts,
                            not the model's private reasoning. For people only: refused when DOC_TOOLKIT_ROLE_SESSION is set.
                            Reads the ledger and the transcripts; writes nothing, no tracker, no forge.
  import                    The Markdown ledgers from before the JSON ones (<from>/<key>.md, default the state
                            folder), each into a JSON ledger holding every line; closed tickets' Markdown removed
                            once checked (to the Trash, or deleted with cleanup.mode delete); open ones kept.

Options
  --root <dir>              the host repo (default: cwd)
  --settings <file>         the ticket flow settings file (default: the 'Ticket flow settings:' field of CLAUDE.md,
                            else .claude/ticket-flow.json); <name>.local.json next to it overrides it at any depth
  --ticket <key>            status: only these tickets in the output (repeatable); the counts still cover all
  --usage-file <file|->     status, report: the text of 'claude -p /usage', for the day's allowance
  --read-usage              status, report: run 'claude -p /usage' for it
  --stage <s>               trace: only that stage's runs (an unknown stage name is refused, exit 2)
  --transcripts <dir>       trace: the folder of <session>.jsonl files, instead of <claude config dir>/projects/<slug>/
                            (the config dir is CLAUDE_CONFIG_DIR or ~/.claude; the slug is the host root with / and . as -)
  --stage <s>, --status <running|done|failed>, --pr <repo>#<n>, --to <status|stage>, --head <sha>,
  --result <json>, --result-file <file|->, --run <json>, --note <text>, --card <ref>,
  --started-by <schedule|manual>                              record
  --group <g>, --kind <schedule|manual>, --stale              lock, unlock
  --date <yyyy-mm-dd>, --print                                report
  --unset                                                     set
  --from <dir>, --size <word>=<edit|newPage|newSection> (repeatable), --dry-run   import
  --origin <url>            the tracker's API origin (tests)
  -h, --help                this text
`;

const OPTIONS = {
  root: { type: 'string' },
  settings: { type: 'string' },
  ticket: { type: 'string', multiple: true },
  'usage-file': { type: 'string' },
  'read-usage': { type: 'boolean' },
  stage: { type: 'string' },
  transcripts: { type: 'string' },
  status: { type: 'string' },
  pr: { type: 'string' },
  to: { type: 'string' },
  head: { type: 'string' },
  result: { type: 'string' },
  'result-file': { type: 'string' },
  run: { type: 'string' },
  note: { type: 'string' },
  card: { type: 'string' },
  'started-by': { type: 'string' },
  group: { type: 'string' },
  kind: { type: 'string' },
  stale: { type: 'boolean' },
  date: { type: 'string' },
  print: { type: 'boolean' },
  unset: { type: 'boolean' },
  from: { type: 'string' },
  size: { type: 'string', multiple: true },
  'dry-run': { type: 'boolean' },
  origin: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

const COMMANDS = ['status', 'record', 'handover', 'lock', 'unlock', 'config', 'intake', 'report', 'set', 'import', 'trace'];
const TAKES_KEY = ['record', 'handover', 'trace'];
// Options of one command only: refused on any other (exit 2), so `set mode off --dry-run` writes nothing.
const ONLY = { from: ['import'], size: ['import'], 'dry-run': ['import'], transcripts: ['trace'] };

export function usageOf(values, io = {}) {
  if (values['usage-file'] !== undefined) {
    const f = values['usage-file'];
    let text;
    try {
      text = f === '-' ? fs.readFileSync(io.stdinFd ?? 0, 'utf8') : fs.readFileSync(path.resolve(f), 'utf8');
    } catch (e) {
      throw new CliError(`cannot read --usage-file: ${e.code ?? 'error'}`, { code: 2 });
    }
    try {
      const j = JSON.parse(text);
      if (j && (j.week || j.session)) return j;
    } catch {
      /* the text of /usage */
    }
    return parseUsage(text);
  }
  if (values['read-usage']) return (io.readUsage ?? readUsageFromClaude)();
  return null;
}

function resultOf(values, io) {
  if (values.result !== undefined && values['result-file'] !== undefined) throw new CliError('give --result or --result-file, not both', { code: 2 });
  const f = values['result-file'];
  if (f === undefined) return values.result;
  try {
    return f === '-' ? fs.readFileSync(io.stdinFd ?? 0, 'utf8') : fs.readFileSync(path.resolve(f), 'utf8');
  } catch (e) {
    throw new CliError(`cannot read --result-file: ${e.code ?? 'error'}`, { code: 2 });
  }
}

// `io` carries what the run touches, so tests can replace it: stdout, env, trackerAdapter, forgeAdapter, now, readUsage.
export async function main(argv, io = {}) {
  const { stdout = process.stdout, env = process.env } = io;
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const [command, key, ...rest] = positionals;
  if (values.help || !command || command === 'help') {
    stdout.write(USAGE);
    return 0;
  }
  if (!COMMANDS.includes(command)) throw new CliError(`unknown command '${command}'.\n\n${USAGE}`, { code: 2 });
  // A role session runs `record` here, so `trace` refuses: it reads other sessions' transcripts, which a role has no reason to.
  if (command === 'trace' && env[ROLE_SESSION_VARIABLE] !== undefined) throw new CliError(`trace is for people: it is refused in a role session (${ROLE_SESSION_VARIABLE} is set)`, { code: 2 });
  // And the records of the runner's own scripted steps that keep commits apart or take the translated label off.
  if (command === 'record' && env[ROLE_SESSION_VARIABLE] !== undefined && ['idSync', 'untranslated'].includes(values.stage)) throw new CliError(`record --stage ${values.stage} is the runner's alone: it is refused in a role session (${ROLE_SESSION_VARIABLE} is set)`, { code: 2 });
  for (const [option, commands] of Object.entries(ONLY)) {
    if (values[option] !== undefined && !commands.includes(command)) throw new CliError(`--${option} is an option of ${commands.join(', ')} only, not of ${command}`, { code: 2 });
  }
  if (TAKES_KEY.includes(command) && !key) throw new CliError(`${command} needs the ticket key.\n\n${USAGE}`, { code: 2 });
  if (command === 'set') {
    if (!key) throw new CliError(`set needs the key.\n\n${USAGE}`, { code: 2 });
    // `set retry job <name>` is the one form with a third word.
    const extra = key === 'retry' && rest[0] === 'job' ? 2 : 1;
    if (rest.length > extra) throw new CliError(`unexpected argument '${rest[extra]}'`, { code: 2 });
    const root = path.resolve(values.root ?? process.cwd());
    const settings = await loadSettings({ root, settings: values.settings });
    stdout.write(JSON.stringify({ ok: true, command, ...setLocal({ settings, key, value: rest[0], name: rest[1], unset: Boolean(values.unset) }) }, null, 2) + '\n');
    return 0;
  }
  if (!TAKES_KEY.includes(command) && !['lock', 'unlock'].includes(command) && key) throw new CliError(`unexpected argument '${key}'`, { code: 2 });
  if (rest.length) throw new CliError(`unexpected argument '${rest[0]}'`, { code: 2 });

  const root = path.resolve(values.root ?? process.cwd());
  const settings = await loadSettings({ root, settings: values.settings });
  // Plain text, and not the live world: no tracker, no forge, nothing written.
  if (command === 'trace') {
    stdout.write(renderTrace({ settings, key, stage: values.stage ?? null, transcripts: values.transcripts ?? null, env, home: io.home ?? os.homedir() }));
    return 0;
  }
  const now = io.now ? io.now() : Date.now();
  const clients = makeClients({ settings, env, io: { ...io, ...(values.origin ? { trackerOrigin: values.origin } : {}) } });
  let result;
  switch (command) {
    case 'config':
      result = { file: path.relative(root, settings.file), localFile: settings.localFile ? path.relative(root, settings.localFile) : null, settings: printable(settings) };
      break;
    case 'status': {
      const st = await computeStatus({ settings, clients, now, only: values.ticket ?? null, usage: settings.limits.usageGuard === false ? null : await usageOf(values, io), git: io.git ?? makeGit(settings) });
      result = { ...st, requests: clients.requests() };
      break;
    }
    case 'intake': {
      const st = await computeStatus({ settings, clients, now, git: io.git ?? makeGit(settings) });
      result = { intake: st.intake, requests: clients.requests() };
      break;
    }
    case 'record':
      if (values.stage === undefined && values.status === undefined && values.run === undefined) throw new CliError('record needs --stage and --status, or --run alone', { code: 2 });
      if ((values.stage === undefined) !== (values.status === undefined)) throw new CliError('record needs both --stage and --status', { code: 2 });
      result = await runRecord({
        settings,
        clients,
        key,
        stage: values.stage,
        status: values.status,
        pr: values.pr,
        to: values.to,
        head: values.head,
        result: resultOf(values, io),
        run: values.run,
        note: values.note,
        card: values.card,
        startedBy: values['started-by'],
        now,
      });
      break;
    case 'import': {
      const sizes = {};
      for (const pair of values.size ?? []) {
        const at = pair.lastIndexOf('=');
        if (at < 1) throw new CliError(`--size '${pair}': give <word>=<size>`, { code: 2 });
        sizes[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
      }
      result = await runImport({ settings, clients, from: values.from ?? null, sizes, dryRun: Boolean(values['dry-run']), now, ...(io.trashDir ? { trashDir: io.trashDir } : {}) });
      break;
    }
    case 'handover':
      result = await runHandover({ settings, clients, key, to: values.to ?? 'pipeline', now });
      break;
    case 'lock':
    case 'unlock': {
      if (Boolean(key) === Boolean(values.group)) throw new CliError(`${command} needs a ticket key or --group, one of them`, { code: 2 });
      const group = values.group ?? groupOfKey(settings, key);
      if (command === 'lock') {
        if (!values.kind) throw new CliError('lock needs --kind schedule or manual', { code: 2 });
        result = runLock({ settings, group, kind: values.kind, stage: values.stage ?? null, now });
      } else result = runUnlock({ settings, group, stale: Boolean(values.stale), now });
      break;
    }
    case 'report': {
      const date = values.date ?? localDate(now);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new CliError('--date must be yyyy-mm-dd', { code: 2 });
      const st = await computeStatus({ settings, clients, now, usage: settings.limits.usageGuard === false ? null : await usageOf(values, io), git: io.git ?? makeGit(settings) });
      const text = renderReport({ settings, st, date, runLog: readRunLog(settings.state, date), ledgers: readAllLedgers(settings.state) });
      if (values.print) {
        stdout.write(text + '\n');
        return 0;
      }
      result = { date, file: path.relative(root, writeReport(settings.state, date, text)) };
      break;
    }
  }
  stdout.write(JSON.stringify({ ok: true, command, ...result }, null, 2) + '\n');
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // Set the exit code instead of calling process.exit(): exiting right after a large write to a pipe truncates the output.
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      if (e?.exitCode !== undefined || e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
        console.error(`ticket-state: ${e.message}`);
        process.stdout.write(JSON.stringify({ ok: false, error: e.message.split('\n\n')[0], ...(e.data ?? {}) }, null, 2) + '\n');
        process.exitCode = e.exitCode ?? 2;
      } else {
        console.error(e);
        process.exitCode = 1;
      }
    },
  );
}
