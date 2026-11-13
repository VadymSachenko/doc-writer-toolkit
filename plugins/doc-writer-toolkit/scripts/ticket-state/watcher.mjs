#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CliError } from './lib/errors.mjs';
import { loadSettings, sharedProblemAt, stateFolderOf, tickSecondsOf } from './lib/settings.mjs';
import { allLocks } from './lib/locks.mjs';
import { runsGoingIn } from './lib/forge-state.mjs';
import { LEARN_LOCK, runLearnPass, watchLockHolder } from './lib/watch.mjs';
import { hubLine, updateHub } from './lib/hub-update.mjs';
import { makeClients } from './lib/world.mjs';
import { prepareEnv } from './lib/env.mjs';
import { runHandOn, runTick } from './lib/forge-watch.mjs';
import { notify, startedOf } from './lib/notify.mjs';

const USAGE = `watcher [options]

One check of the ticket flow's watcher, for launchd to start every few minutes (see launchd.mjs). With no model call
of its own, it reads every event since the last check (the boards' actions, the PRs that changed and the PR events),
maps them to tickets through the ledgers, asks 'ticket-state status' what each changed ticket does next (every open
ticket, at a check that fast-forwarded the hub to a merged change), and hands each group that has a next step to a run
in a process of its own (--hand-on), each once, and doesn't wait for it.
Once a day after schedule.morning it starts the morning run instead. Inside limits.startHours (10-22 by default),
when a slot frees or another start may have become possible, it has the runner triage and decide the starts as a
scheduled run would, once per change, each start handed to a process of its own. It also runs the host jobs that
are due. A triage and a due host job are the only things a check waits for. A check that finds nothing starts nothing.

The LaunchAgent ticks every schedule.forgeSeconds (60 by default). Each tick runs the forge check: the PRs that
changed only, no tracker read, no morning run, no start pass, no job. It hands a ticket with the owner's or a
reviewer's comments to answer on, at once for a submitted review, once single comments have been quiet for
schedule.commentQuietMinutes (2 by default), to a run in a process of its own, and doesn't wait for it. Every
schedule.watchMinutes the tick also starts the full check as a process of its own, unless one still runs.

Options
  --full                    run the full check now, here, whatever the tick would run
  --forge                   run the forge check now, here, whatever the tick would run
  --hand-on <id>            a check's run for the tickets named with --ticket (a check starts this itself)
  --ticket <key>            with --hand-on: a ticket to finish (repeatable)
  --learn                   a learning pass: the rule PRs, the toolkit PRs, the weekly session (a check starts this itself)
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
  'hand-on': { type: 'string' },
  ticket: { type: 'string', multiple: true },
  learn: { type: 'boolean' },
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
  const handed = (r.starts ?? []).filter((s) => s.handedOn);
  if (handed.length) return `start pass (${p.why}): ${triaged}handed on the start of ${handed.map((s) => `${s.keys.join(', ')} (run ${s.handedOn.id})`).join('; ')}`;
  const planned = (r.starts ?? []).filter((s) => s.stage === 'start' && !s.steps);
  if ((r.dryRun || r.observe) && planned.length) return `start pass (${p.why}): ${triaged}would start ${planned.map((s) => s.keys.join(', ')).join('; ')}`;
  const why = r.guard?.[0]?.reason ?? r.starts?.find((s) => s.waits)?.waits ?? r.notStarted?.[0]?.reasons?.join('; ') ?? (r.starts?.length ? 'its start did not get the card into work' : 'no group could start');
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
  if (hubLine(out.hub)) bits.push(hubLine(out.hub));
  if (out.errors?.length) bits.push(`${out.errors.length} part(s) failed: ${out.errors.map((e) => e.part).join(', ')}`);
  for (const f of out.finished ?? []) bits.push(`run ${f.id} of ${f.keys.join(', ')} ended`);
  if (out.run?.handedOn) {
    const handed = out.run.handedOn.filter((x) => x.handedOn);
    if (handed.length) bits.push(`handed on ${handed.map((x) => `${x.keys.join(', ')} (run ${x.handedOn.id})`).join('; ')}`);
    for (const x of out.run.handedOn.filter((y) => !y.handedOn)) bits.push(`${x.keys.join(', ')} not handed on: ${x.waits ?? x.held ?? x.guard ?? x.error}`);
  } else if (out.run) bits.push(`finished ${out.run.named.join(', ')}`);
  for (const w of (out.waiting ?? []).filter((x) => x.new)) bits.push(`${w.key} waits for quiet until ${w.until}`);
  if (out.startPass) bits.push(startPassLine(out.startPass));
  for (const j of out.jobs.filter((x) => x.due)) bits.push(`job ${j.name}: ${j.outcome ?? (j.held ? 'held' : 'planned')}`);
  if (out.notified.length) bits.push(`${out.notified.length} notification(s)`);
  return bits.join('; ');
}

// The forge check's line: what it handed on, what waits for quiet, what failed.
export function forgeLine(out) {
  const bits = [`${out.at} forge check`, `${out.events} changed PR(s)`];
  if (out.full?.started) bits.push(`full check started (pid ${out.full.pid})`);
  if (out.full?.error) bits.push(`the full check could not start: ${out.full.error}`);
  for (const f of out.finished ?? []) bits.push(`run ${f.id} of ${f.keys.join(', ')} ended`);
  if (out.handed.length) bits.push(`comments: ${out.handOn?.pid ? `run ${out.handOn.id} (pid ${out.handOn.pid}) started for` : 'would start a run for'} ${out.handed.join(', ')}`);
  for (const w of out.waiting.filter((x) => x.new)) bits.push(`${w.key} waits for quiet until ${w.until}`);
  if (out.errors.length) bits.push(`${out.errors.length} part(s) failed: ${out.errors.map((e) => e.part).join(', ')}`);
  if (out.notified.length) bits.push(`${out.notified.length} notification(s)`);
  return bits.join('; ');
}

// The settings this process runs with. A process that runs the full check first brings the hub up to its origin
// (lib/hub-update.mjs), so a merged hub PR counts at this check with no person's pull, and reads the settings again when
// it moved; that check then looks at every open ticket (lib/watch.mjs, step 3). Not a tick that only starts the full
// check, a forge check or a hand-on (it reads what the full check left), a dry run or mode off. Settings that don't
// load (a bad file committed by hand, say) stop every process at this read, so then any process but a hand-on or a dry
// run tries the update first: a fix merged on the forge is pulled, and the error stands, with the hub's note, until one
// is. Returns { settings, hub }, `hub` null when no update was tried.
export async function settingsForCheck({ root, values = {}, update = updateHub, now = Date.now }) {
  const load = () => loadSettings({ root, settings: values.settings });
  let settings = null;
  let broken = null;
  try {
    settings = await load();
  } catch (e) {
    if (values['hand-on'] !== undefined || values.learn || values['dry-run']) throw e;
    broken = e;
  }
  if (!broken) {
    const runsFull = Boolean(values.full) || (!values.forge && values['hand-on'] === undefined && !values.learn && tickSecondsOf(settings) >= settings.schedule.watchMinutes * 60);
    if (!runsFull || values['dry-run'] || settings.mode === 'off') return { settings, hub: null };
  }
  const state = settings?.state ?? (await stateFolderOf({ root, settings: values.settings }));
  // The hub as a target of its own names its base; else origin's default branch.
  const base = settings?.targets.find((t) => t.path && path.resolve(root, t.path) === root)?.base ?? null;
  const hub = await update(root, { base, validate: (ref) => sharedProblemAt({ root, settings: values.settings, ref }), busy: () => (state ? busyHub(state, now()) : 'the state folder is not known (the settings file parses neither in the checkout nor at HEAD), so the runs going on can\'t be seen') });
  if (!broken) return { settings: hub?.outcome === 'moved' ? await load() : settings, hub };
  if (hub?.outcome === 'moved') return { settings: await load(), hub };
  throw new CliError(`${broken.message}${hubLine(hub) ? ` (${hubLine(hub)})` : ''}`, { code: broken.exitCode ?? 2 });
}

// What reads the hub's files now, as one phrase, or null: the runs going on (each live group lock, and each run a check
// handed on that holds none yet) and another full check (it may be running a host job).
export function busyHub(state, now = Date.now()) {
  const runs = runsGoingIn(state, { locks: allLocks(state, now), now }).size;
  const check = watchLockHolder(state, { now });
  // A learning pass commits in worktrees of the hub's clones (lib/learn.mjs): the hub never moves under one.
  const learn = watchLockHolder(state, { now, name: LEARN_LOCK });
  const bits = [...(runs ? [`${runs} run(s) going`] : []), ...(check && check.pid !== process.pid ? [`a full check running (pid ${check.pid})`] : []), ...(learn && learn.pid !== process.pid ? [`a learning pass running (pid ${learn.pid})`] : [])];
  return bits.length ? bits.join(' and ') : null;
}

export async function main(argv, io = {}) {
  const { stdout = process.stdout, env = process.env } = io;
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  if (values.help || positionals[0] === 'help') {
    stdout.write(USAGE);
    return 0;
  }
  if (positionals.length) throw new CliError(`unexpected argument '${positionals[0]}'.\n\n${USAGE}`, { code: 2 });
  if ([values.full, values.forge, values['hand-on'] !== undefined, values.learn].filter(Boolean).length > 1) throw new CliError('--full, --forge, --hand-on and --learn exclude each other', { code: 2 });
  if (values['hand-on'] !== undefined && !/^[A-Za-z0-9-]+$/.test(values['hand-on'])) throw new CliError(`'${values['hand-on']}' is not a hand-on id`, { code: 2 });
  if (values['hand-on'] !== undefined && !values.ticket?.length) throw new CliError('--hand-on needs the tickets it finishes (--ticket)', { code: 2 });
  if (values.ticket?.length && values['hand-on'] === undefined) throw new CliError('--ticket goes with --hand-on', { code: 2 });
  if (values.noop) {
    if (!values.quiet) stdout.write(JSON.stringify({ ok: true, command: 'watch', noop: true }) + '\n');
    return 0;
  }
  const root = path.resolve(values.root ?? process.cwd());
  const dryRun = Boolean(values['dry-run']);
  const { settings, hub } = await settingsForCheck({ root, values, update: io.updateHub });
  const { notes, claudeEnv } = prepareEnv(settings, env);
  const clients = makeClients({ settings, env, dryRun, io: { ...io, ...(values.origin ? { trackerOrigin: values.origin } : {}) } });
  if (values['hand-on'] !== undefined) {
    const r = await runHandOn({ settings, clients, io: { ...io, claudeEnv }, options: { id: values['hand-on'], keys: values.ticket, dryRun, claude: values.claude ?? 'claude' } });
    if (values.quiet) stdout.write(`${r.ended} hand-on ${r.id} of ${r.keys.join(', ')}: ${r.error ? `failed: ${r.error}` : 'ended'}\n`);
    else stdout.write(JSON.stringify({ ok: true, command: 'hand-on', ...r, requests: clients.requests(), caught: clients.caught() }, null, 2) + '\n');
    return 0;
  }
  if (values.learn) {
    if (!settings.learning) throw new CliError('--learn needs `learning` in the shared settings', { code: 2 });
    const r = await runLearnPass({ settings, clients, io: { notify, ...io, claudeEnv }, options: { dryRun, claude: values.claude ?? 'claude' } });
    const bits = [r.proposed?.length ? `${r.proposed.length} rule PR(s)` : null, r.replied?.length ? `${r.replied.length} reply(ies)` : null, r.toolkit?.length ? `${r.toolkit.length} toolkit step(s)` : null, r.week?.error ?? r.week?.why ?? null].filter(Boolean);
    if (values.quiet) stdout.write(`learning pass: ${r.skipped ?? (bits.join('; ') || 'nothing to do')}\n`);
    else stdout.write(JSON.stringify({ ok: true, command: 'learn', ...r, requests: clients.requests(), caught: clients.caught() }, null, 2) + '\n');
    return 0;
  }
  const kind = values.full ? 'full' : values.forge ? 'forge' : null;
  const out = await runTick({ settings, clients, io: { notify, ...io, claudeEnv }, options: { dryRun, claude: values.claude ?? 'claude', notes, ...(kind ? { kind } : {}), ...(hub ? { hub } : {}) } });
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
