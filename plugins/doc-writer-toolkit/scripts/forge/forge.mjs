#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CliError } from './lib/errors.mjs';
import { loadSettings } from './lib/settings.mjs';
import { createAdapter } from './adapters/index.mjs';
import { createForge } from './lib/forge.mjs';

const USAGE = `forge <command> [options]

The forge of a docs pipeline: the pull requests of the repositories the host's ticket flow settings name, over the
gh CLI (GitHub). Prints JSON on stdout. Reads change nothing. Every change is one call; with --dry-run it is printed
and not sent. Every change says which ids it posted. The only review it posts is a comment; it has no command that
gives a verdict, settles a conversation, joins a branch, closes a PR or deletes anything.

Commands
  settings                       What the settings let the module touch: repos, targets, logins, labels it may add and remove.
  open-pr --repo <r> --head <branch> --base <branch> --title <t> [--body <t>] [--assignee <login>] [--reviewer <login>]...
          [--label <name>]... [--draft]   Opens a PR, or returns the open one of the same head.
  edit-pr --repo <r> --number <n> [--title <t>] [--body <t>]   An empty title or description is refused.
  pr-state --repo <r> (--number <n> | --head <branch>)         State, head and merge commits, review decision, requests, labels.
  changed-prs-since --repo <r> --since <time>                  PRs updated since a time, every state.
  pr-activity --repo <r> --number <n> [--since <time>]         Reviews, review threads with comments, comments, review requests.
  events-since --repo <r> --since <time> [--types a,b]         The PR events of the repository since a time.
  request-reviewers --repo <r> --number <n> --reviewer <login>...
  review-on-lines --repo <r> --number <n> --commit <sha> --comments-file <file|-> [--body <t>] [--drop-outside] [--skip-diff-check]
                                 One review with event COMMENT; the file is a JSON list of { path, line, body }.
  reply --repo <r> --number <n> --comment <id> --body <t>      A reply in a review thread.
  suggest --repo <r> --number <n> --comment <id> --replacement <t> [--body <t>]   A reply with a suggestion block.
  comment --repo <r> --number <n> --body <t> [--unless-header <h> [--since <time>]]   A comment in the conversation.
  add-label --repo <r> --number <n> --label <name>, remove-label --repo <r> --number <n> --label <name>
  set-stage-label --target <id> --number <n> --stage inProgress|review|finalReview [--repo <r>]

Options
  --root <dir>            the host repo (default: cwd); the settings file is read from it
  --settings <file>       the ticket flow settings file (default: the 'Ticket flow settings:' field of CLAUDE.md, else
                          .claude/ticket-flow.json); <name>.local.json next to it overrides it key by key
  --dry-run               print each change instead of sending it
  --repo <r>              a repository named by a target (its name, or owner/name)
  --number <n>, --head <branch>, --base <branch>, --commit <sha>, --comment <id>
  --title <t>, --body <t>, --body-file <file|->, --replacement <t>, --replacement-file <file|->   texts (a file, or - for stdin; sent exactly)
  --assignee <login>, --reviewer <login> (repeatable), --label <name> (repeatable for open-pr), --draft
  --since <time>, --types <a,b>
  --comments-file <file|->, --drop-outside, --skip-diff-check
  --unless-header <h>
  --target <id>, --stage <stage>
  -h, --help              this text
`;

export const OPTIONS = {
  root: { type: 'string' },
  settings: { type: 'string' },
  'dry-run': { type: 'boolean' },
  repo: { type: 'string' },
  number: { type: 'string' },
  head: { type: 'string' },
  base: { type: 'string' },
  commit: { type: 'string' },
  comment: { type: 'string' },
  title: { type: 'string' },
  body: { type: 'string' },
  'body-file': { type: 'string' },
  replacement: { type: 'string' },
  'replacement-file': { type: 'string' },
  assignee: { type: 'string' },
  reviewer: { type: 'string', multiple: true },
  label: { type: 'string', multiple: true },
  draft: { type: 'boolean' },
  since: { type: 'string' },
  types: { type: 'string' },
  'comments-file': { type: 'string' },
  'drop-outside': { type: 'boolean' },
  'skip-diff-check': { type: 'boolean' },
  'unless-header': { type: 'string' },
  target: { type: 'string' },
  stage: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

export const COMMANDS = [
  'settings', 'open-pr', 'edit-pr', 'pr-state', 'changed-prs-since', 'pr-activity', 'events-since', 'request-reviewers',
  'review-on-lines', 'reply', 'suggest', 'comment', 'add-label', 'remove-label', 'set-stage-label',
];

function readText(file, flag, io) {
  try {
    return file === '-' ? fs.readFileSync(io.stdinFd ?? 0, 'utf8') : fs.readFileSync(path.resolve(file), 'utf8');
  } catch (e) {
    throw new CliError(`cannot read --${flag}: ${e.code ?? 'error'}`, { code: 2 });
  }
}
function textOf(values, flag, io) {
  if (values[flag] !== undefined && values[`${flag}-file`] !== undefined) throw new CliError(`give --${flag} or --${flag}-file, not both`, { code: 2 });
  const file = values[`${flag}-file`];
  return file === undefined ? values[flag] : readText(file, `${flag}-file`, io);
}
function commentsOf(values, io) {
  if (values['comments-file'] === undefined) throw new CliError('review-on-lines needs --comments-file (a JSON list of { path, line, body })', { code: 2 });
  try {
    return JSON.parse(readText(values['comments-file'], 'comments-file', io));
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(`--comments-file is not valid JSON: ${e.message}`, { code: 2 });
  }
}

// `io` carries everything the run touches, so tests can replace it: stdout, env, runner (the gh process), sleep, adapter.
export async function main(argv, io = {}) {
  const { stdout = process.stdout, env = process.env } = io;
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const [command, ...rest] = positionals;
  if (values.help || !command || command === 'help') {
    stdout.write(USAGE);
    return 0;
  }
  if (!COMMANDS.includes(command)) throw new CliError(`unknown command '${command}'.\n\n${USAGE}`, { code: 2 });
  if (rest.length) throw new CliError(`unexpected argument '${rest[0]}'`, { code: 2 });

  const root = path.resolve(values.root ?? process.cwd());
  const settings = await loadSettings({ root, settings: values.settings });
  const dryRun = Boolean(values['dry-run']);
  let client = null;
  let forge;
  if (io.adapter) {
    forge = createForge({ adapter: io.adapter, forge: settings.forge, dryRun });
  } else {
    const made = createAdapter(settings.forge, {
      dryRun,
      env,
      ...(io.runner ? { runner: io.runner } : {}),
      ...(io.sleep ? { sleep: io.sleep } : {}),
    });
    client = made.client;
    forge = createForge({ adapter: made.adapter, forge: settings.forge, dryRun });
  }

  const repo = values.repo;
  const number = values.number;
  const labels = values.label ?? [];
  const oneLabel = () => {
    if (labels.length !== 1) throw new CliError(`${command} needs exactly one --label`, { code: 2 });
    return labels[0];
  };
  let result;
  switch (command) {
    case 'settings':
      result = forge.settings();
      break;
    case 'open-pr':
      result = await forge.openPr({ repo, head: values.head, base: values.base, title: values.title, body: textOf(values, 'body', io), assignee: values.assignee, reviewers: values.reviewer ?? [], labels, draft: values.draft });
      break;
    case 'edit-pr':
      result = await forge.editPr({ repo, number, title: values.title, body: textOf(values, 'body', io) });
      break;
    case 'pr-state':
      result = await forge.prState({ repo, number, head: values.head });
      break;
    case 'changed-prs-since':
      result = await forge.changedPrsSince({ repo, since: values.since });
      break;
    case 'pr-activity':
      result = await forge.prActivity({ repo, number, since: values.since });
      break;
    case 'events-since':
      result = await forge.eventsSince({ repo, since: values.since, types: values.types ? values.types.split(',').map((s) => s.trim()).filter(Boolean) : undefined });
      break;
    case 'request-reviewers':
      result = await forge.requestReviewers({ repo, number, logins: values.reviewer ?? [] });
      break;
    case 'review-on-lines':
      result = await forge.reviewOnLines({ repo, number, commit: values.commit, comments: commentsOf(values, io), body: textOf(values, 'body', io), dropOutside: values['drop-outside'], skipDiffCheck: values['skip-diff-check'] });
      break;
    case 'reply':
      result = await forge.reply({ repo, number, comment: values.comment, body: textOf(values, 'body', io) });
      break;
    case 'suggest':
      result = await forge.suggest({ repo, number, comment: values.comment, replacement: textOf(values, 'replacement', io), body: textOf(values, 'body', io) });
      break;
    case 'comment':
      result = await forge.comment({ repo, number, body: textOf(values, 'body', io), unlessHeader: values['unless-header'], since: values.since });
      break;
    case 'add-label':
      result = await forge.addLabel({ repo, number, label: oneLabel() });
      break;
    case 'remove-label':
      result = await forge.removeLabel({ repo, number, label: oneLabel() });
      break;
    case 'set-stage-label':
      result = await forge.setStageLabel({ repo, number, target: values.target, stage: values.stage });
      break;
  }
  const out = { ok: true, command, ...result };
  if (dryRun) {
    out.dryRun = true;
    out.calls = client ? client.calls : [];
  }
  stdout.write(JSON.stringify(out, null, 2) + '\n');
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
      if (e instanceof CliError || e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
        console.error(`forge: ${e.message}`);
        process.stdout.write(JSON.stringify({ ok: false, error: e.message.split('\n\n')[0], ...(e.data ?? {}) }, null, 2) + '\n');
        process.exitCode = e.exitCode ?? 2;
      } else {
        console.error(e);
        process.exitCode = 1;
      }
    },
  );
}
