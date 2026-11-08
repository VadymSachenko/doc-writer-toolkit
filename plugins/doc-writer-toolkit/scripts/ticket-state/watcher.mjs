#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CliError } from './lib/errors.mjs';
import { loadSettings } from './lib/settings.mjs';
import { makeClients } from './lib/world.mjs';
import { prepareEnv } from './lib/env.mjs';
import { runTick } from './lib/watch.mjs';
import { notify, startedOf } from './lib/notify.mjs';

const USAGE = `watcher [options]

One check of the ticket flow's watcher, for launchd to start every few minutes (see launchd.mjs). With no model call
of its own, it reads every event since the last check (the boards' actions, the PRs that changed and the PR events),
maps them to tickets through the ledgers, asks 'ticket-state status' what each changed ticket does next, and has the
runner finish those that have a next step, each once. Once a day after schedule.morning it starts the morning run
instead. Inside limits.startHours (10-22 by default), when a slot frees or another start may have become possible,
it has the runner triage and start as a scheduled run would, once per change. It also starts the host jobs that are
due. A check that finds nothing starts nothing.

Between these full checks (every schedule.watchMinutes), the LaunchAgent's tick (every schedule.forgeSeconds, 60 by
default) runs the forge check: the PRs that changed only, no tracker read, no morning run, no start pass, no job. It
hands a ticket with the owner's or a reviewer's comments to answer on: at once for a submitted review, once single
comments have been quiet for schedule.commentQuietMinutes (2 by default). One check at a time.

Options
  --full                    run the full check now, whatever the tick would run
  --forge                   run the forge check now, whatever the tick would run
  --dry-run                 read and plan only: no runner step, no job, no cursor, no notification is written
  --quiet                   print nothing for a quiet check, one line otherwise (for launchd's log)
  --noop                    do nothing at all and exit 0 (for an install test of the LaunchAgent)
  --claude <bin>            the claude command (default: claude)
  --root <dir>              the host repo (default: cwd)
  --settings <file>         the ticket flow settings file
  --origin <url>            the tracker's API origin (tests)
  -h, --help                this text
`;

const OPTIONS = {
  'dry-run': { type: 'boolean' },
  full: { type: 'boolean' },
  forge: { type: 'boolean' },
  quiet: { type: 'boolean' },
  noop: { type: 'boolean' },
  claude: { type: 'string' },
  root: { type: 'string' },
  settings: { type: 'string' },
  origin: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

// The start pass in one phrase: why it ran, and what it started, would start (a dry run, observe) or why nothing.
export function startPassLine(p) {
  if (!p.ran) return `start pass not run (${p.why}): ${p.skipped ?? p.error ?? 'failed'}`;
  const r = p.run ?? {};
  const triaged = r.triage?.outcome === 'done' && r.triage.keys?.length ?`triaged ${r.triage.keys.join(', ')}; ` : '';
  const started = startedOf(r);
  if (started.length) return `start pass (${p.why}): ${triaged}started ${started.map((s) => s.keys.join(', ')).join('; ')}`;
  const planned = (r.starts ?? []).filter((s) => s.stage === 'start' && !s.steps);
  if ((r.dryRun || r.observe) && planned.length) return `start pass (${p.why}): ${triaged}would start ${planned.map((s) => s.keys.join(', ')).join('; ')}`;
  const why = r.guard?.[0]?.reason ?? r.notStarted?.[0]?.reasons?.join('; ') ?? (r.starts?.length ? 'its start did not get the card into work' : 'no group could start');
  return `start pass (${p.why}): ${triaged}started nothing (${why})`;
}

// One line for launchd's log: what the check found and did.
export function oneLine(out) {
  if (out.stopped || out.skipped) return `${out.at ?? ''} ${out.stopped ?? out.skipped}`.trim();
  if (out.kind === 'forge') return forgeLine(out);
  const bits = [`${out.at} mode ${out.mode}`, `${out.events} new event(s)`];
  const failed = out.sources.filter((s) => s.outcome === 'failed' || s.outcome === 'gap');
  if (failed.length) bits.push(`${failed.length} source(s) failing`);
  if (out.morning) bits.push('morning run');
  if (out.errors?.length) bits.push(`${out.errors.length} part(s) failed: ${out.errors.map((e) => e.part).join(', ')}`);
  if (out.run) bits.push(`finished ${out.run.named.join(', ')}`);
  for (const w of (out.waiting ?? []).filter((x) => x.new)) bits.push(`${w.key} waits for quiet until ${w.until}`);
  if (out.startPass) bits.push(startPassLine(out.startPass));
  for (const j of out.jobs.filter((x) => x.due)) bits.push(`job ${j.name}: ${j.outcome ?? (j.held ? 'held' : 'planned')}`);
  if (out.notified.length) bits.push(`${out.notified.length} notification(s)`);
  return bits.join('; ');
}

// The forge check's line: what it handed on, what waits for quiet, what failed.
export function forgeLine(out) {
  const bits = [`${out.at} forge check`, `${out.events} changed PR(s)`];
  if (out.handed.length) bits.push(`comments: finished ${out.handed.join(', ')}`);
  for (const w of out.waiting.filter((x) => x.new)) bits.push(`${w.key} waits for quiet until ${w.until}`);
  if (out.errors.length) bits.push(`${out.errors.length} part(s) failed: ${out.errors.map((e) => e.part).join(', ')}`);
  if (out.notified.length) bits.push(`${out.notified.length} notification(s)`);
  return bits.join('; ');
}

export async function main(argv, io = {}) {
  const { stdout = process.stdout, env = process.env } = io;
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  if (values.help || positionals[0] === 'help') {
    stdout.write(USAGE);
    return 0;
  }
  if (positionals.length) throw new CliError(`unexpected argument '${positionals[0]}'.\n\n${USAGE}`, { code: 2 });
  if (values.full && values.forge) throw new CliError('--full and --forge exclude each other', { code: 2 });
  if (values.noop) {
    if (!values.quiet) stdout.write(JSON.stringify({ ok: true, command: 'watch', noop: true }) + '\n');
    return 0;
  }
  const root = path.resolve(values.root ?? process.cwd());
  const settings = await loadSettings({ root, settings: values.settings });
  const { notes, claudeEnv } = prepareEnv(settings, env);
  const dryRun = Boolean(values['dry-run']);
  const clients = makeClients({ settings, env, dryRun, io: { ...io, ...(values.origin ? { trackerOrigin: values.origin } : {}) } });
  const kind = values.full ? 'full' : values.forge ? 'forge' : null;
  const out = await runTick({ settings, clients, io: { notify, ...io, claudeEnv }, options: { dryRun, claude: values.claude ?? 'claude', notes, ...(kind ? { kind } : {}) } });
  if (values.quiet) {
    if (!out.quiet) stdout.write(oneLine(out) + '\n');
  } else stdout.write(JSON.stringify({ ok: true, command: 'watch', ...out, requests: clients.requests(), caught: clients.caught() }, null, 2) + '\n');
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
        console.error(`watcher: ${e.message}`);
        process.stdout.write(JSON.stringify({ ok: false, error: e.message.split('\n\n')[0], ...(e.data ?? {}) }, null, 2) + '\n');
        process.exitCode = e.exitCode ?? 2;
      } else {
        console.error(e);
        process.exitCode = 1;
      }
    },
  );
}
