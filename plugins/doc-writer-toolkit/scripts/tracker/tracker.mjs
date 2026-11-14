#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CliError } from './lib/errors.mjs';
import { loadCredentials, loadSettings } from './lib/settings.mjs';
import { createAdapter } from './adapters/index.mjs';
import { createTracker } from './lib/tracker.mjs';

const USAGE = `tracker <command> [<card>] [options]

The tracker of a docs pipeline, in statuses and transitions. The statuses, the lists they map to, the transitions
and the credentials' variable names come from the host's ticket flow settings; a Trello adapter does the calls.
Prints JSON on stdout. Reads change nothing. Every change (comment, move, label, member, description, create) is one call;
with --dry-run it is printed (credentials removed) and not sent.

Commands
  statuses                       The settings' statuses resolved to the board's lists, the lists no status owns.
  list-cards --status <s>        The open cards of a status, each with its last activity time and priority. Refuses a neverRead status.
  list-cards --board <id> --list <name>   The open cards of a list on a watched board.
  read-card <card>               One card with its comments, attachments, checklists, moves and links to other cards.
  find-cards --number <n>        Cards whose name starts with #<n> (archived too), on --board (repeatable) or the board.
  find-cards --link <url>        The card behind a link or short link (archived too).
  actions-since --since <time>   The board's actions since an ISO time, oldest first, with the status of each move.
  download-attachment <card> --attachment <id|name> --out <file>
  comment <card> --text <t>      Add a comment. --unless-header <h> [--since <time>] skips it when one already starts with h.
  move <card> --to <status>      Move a card; refused unless (from, to) is a transition in the settings.
  add-label <card> --label <name>, remove-label <card> --label <name>
  add-member <card> --member <name>   Add a person the settings name (tracker.owner, a target's cardMembers; owner
                                 stands for tracker.owner); one already on the card is no change. No command removes anyone.
  set-description <card> --text <t>   Refuses an empty text.
  create-card --status intake --name <n> [--desc <t>] [--label <name>]...   Only in the intake status.

<card> is the card's id, its short link or its URL.

Options
  --root <dir>            the host repo (default: cwd); settings and the credentials file are read from it
  --settings <file>       the ticket flow settings file (default: the 'Ticket flow settings:' field of CLAUDE.md, else
                          .claude/ticket-flow.json); <name>.local.json next to it overrides it key by key
  --dry-run               print each change instead of sending it
  --status <s>, --to <s>  a status of the settings
  --number <n>, --link <url>, --board <id> (repeatable; the board or a watched board), --all-boards (the board and the watched ones)
  --list <name>           list-cards on a watched board: the list's name ('*' allowed)
  --since <time>, --types <a,b>   actions-since: the start, and Trello's action filter
  --attachment <id|name>, --out <file>, --overwrite
  --text <t>, --text-file <file|->   the text (a file, or - for stdin; stored exactly, U+200C kept)
  --desc <t>, --desc-file <file|->, --name <n>, --label <name> (repeatable), --unless-header <h>
  --member <name>         add-member: a username the settings name, or owner
  --origin <url>          the tracker's API origin: only under DOC_TOOLKIT_TRACKER_TEST (the tests' local server)
  -h, --help              this text
`;

export const OPTIONS = {
  root: { type: 'string' },
  settings: { type: 'string' },
  'dry-run': { type: 'boolean' },
  status: { type: 'string' },
  to: { type: 'string' },
  number: { type: 'string' },
  link: { type: 'string' },
  board: { type: 'string', multiple: true },
  list: { type: 'string' },
  'all-boards': { type: 'boolean' },
  since: { type: 'string' },
  types: { type: 'string' },
  attachment: { type: 'string' },
  out: { type: 'string' },
  overwrite: { type: 'boolean' },
  text: { type: 'string' },
  'text-file': { type: 'string' },
  desc: { type: 'string' },
  'desc-file': { type: 'string' },
  name: { type: 'string' },
  label: { type: 'string', multiple: true },
  member: { type: 'string' },
  'unless-header': { type: 'string' },
  origin: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

const COMMANDS = ['statuses', 'list-cards', 'read-card', 'find-cards', 'actions-since', 'download-attachment', 'comment', 'move', 'add-label', 'remove-label', 'add-member', 'set-description', 'create-card'];
const TAKES_CARD = ['read-card', 'download-attachment', 'comment', 'move', 'add-label', 'remove-label', 'add-member', 'set-description'];

function textOf(values, flag, io) {
  if (values[flag] !== undefined && values[`${flag}-file`] !== undefined) throw new CliError(`give --${flag} or --${flag}-file, not both`, { code: 2 });
  const file = values[`${flag}-file`];
  if (file === undefined) return values[flag];
  try {
    return file === '-' ? fs.readFileSync(io.stdinFd ?? 0, 'utf8') : fs.readFileSync(path.resolve(file), 'utf8');
  } catch (e) {
    throw new CliError(`cannot read --${flag}-file: ${e.code ?? 'error'}`, { code: 2 });
  }
}

// In a role session (the runner sets the marker, and the folders) a download goes only into the ticket's work folder or
// the flow's `tmp/`, whatever the links on the way: both sides are compared as real paths. Elsewhere, `--out` is free.
function checkDownload(out, env) {
  if (!env.DOC_TOOLKIT_ROLE_SESSION || out === undefined) return;
  let dirs = [];
  try {
    dirs = JSON.parse(env.DOC_TOOLKIT_DOWNLOAD_DIRS).filter((d) => typeof d === 'string');
  } catch {
    /* no list: nothing is open */
  }
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  };
  const dest = path.resolve(out);
  const parent = real(path.dirname(dest));
  const open = parent && dirs.map(real).filter(Boolean).some((d) => parent === d || parent.startsWith(`${d}${path.sep}`));
  if (!open) throw new CliError(`in a role session --out goes only in: ${dirs.join(', ') || 'no folder'} (the folder must exist); ${dest} isn't there`, { code: 2 });
  if (fs.lstatSync(dest, { throwIfNoEntry: false })?.isSymbolicLink()) throw new CliError(`${dest} is a link: a download doesn't write through one`, { code: 2 });
}

// `io` carries everything the run touches, so tests can replace it: stdout, stderr, env, fetchImpl, sleep, adapter.
export async function main(argv, io = {}) {
  const { stdout = process.stdout, env = process.env } = io;
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const [command, card, ...rest] = positionals;
  if (values.help || !command || command === 'help') {
    stdout.write(USAGE);
    return 0;
  }
  // Bad usage exits 2, as every other input the caller must fix (the forge and section-state scripts do the same).
  if (!COMMANDS.includes(command)) throw new CliError(`unknown command '${command}'.\n\n${USAGE}`, { code: 2 });
  if (TAKES_CARD.includes(command) ? !card : card) {
    throw new CliError(TAKES_CARD.includes(command) ? `${command} needs the card.\n\n${USAGE}` : `unexpected argument '${card}'`, { code: 2 });
  }
  if (rest.length) throw new CliError(`unexpected argument '${rest[0]}'`, { code: 2 });

  // `--origin` sends the tracker's key and token to that origin: the tests' fake server, and nothing else.
  if (values.origin !== undefined && !env.DOC_TOOLKIT_TRACKER_TEST) throw new CliError('--origin sends the tracker\'s key and token to that origin, so it works only under the tests\' marker', { code: 2 });
  if (command === 'download-attachment') checkDownload(values.out, env);

  const root = path.resolve(values.root ?? process.cwd());
  const settings = await loadSettings({ root, settings: values.settings });
  const t = settings.tracker;
  let tracker;
  let client = null;
  if (io.adapter) {
    tracker = createTracker({ adapter: io.adapter, tracker: t, dryRun: Boolean(values['dry-run']) });
  } else {
    const { key, token } = loadCredentials({ root, credentials: t.credentials, env });
    const made = createAdapter(t.kind, {
      key,
      token,
      dryRun: Boolean(values['dry-run']),
      ...(values.origin ? { origin: values.origin } : {}),
      ...(io.fetchImpl ? { fetchImpl: io.fetchImpl } : {}),
      ...(io.sleep ? { sleep: io.sleep } : {}),
    });
    client = made.client;
    tracker = createTracker({ adapter: made.adapter, tracker: t, dryRun: Boolean(values['dry-run']) });
  }

  const boards = values['all-boards'] ? [t.board, ...t.watchBoards] : values.board;
  let result;
  switch (command) {
    case 'statuses':
      result = await tracker.statuses();
      break;
    case 'list-cards':
      if (values.list !== undefined) {
        if (values.status || values.board?.length !== 1) throw new CliError('list-cards --list needs one --board (a watched board) and no --status', { code: 2 });
        result = await tracker.listCardsOn({ board: values.board[0], list: values.list });
        break;
      }
      if (!values.status) throw new CliError('list-cards needs --status', { code: 2 });
      result = await tracker.listCards({ status: values.status });
      break;
    case 'read-card':
      result = await tracker.readCard({ card });
      break;
    case 'find-cards':
      result = await tracker.findCards({ number: values.number, link: values.link, boards });
      break;
    case 'actions-since':
      result = await tracker.actionsSince({ since: values.since, board: values.board?.[0], types: values.types ? values.types.split(',').map((s) => s.trim()).filter(Boolean) : undefined });
      break;
    case 'download-attachment':
      result = await tracker.downloadAttachment({ card, attachment: values.attachment, out: values.out, overwrite: values.overwrite });
      break;
    case 'comment':
      result = await tracker.comment({ card, text: textOf(values, 'text', io), unlessHeader: values['unless-header'], since: values.since });
      break;
    case 'move':
      if (!values.to) throw new CliError('move needs --to', { code: 2 });
      result = await tracker.move({ card, to: values.to });
      break;
    case 'add-label':
    case 'remove-label':
      if (values.label?.length !== 1) throw new CliError(`${command} needs exactly one --label`, { code: 2 });
      result = await tracker[command === 'add-label' ? 'addLabel' : 'removeLabel']({ card, label: values.label[0] });
      break;
    case 'add-member':
      if (!values.member) throw new CliError('add-member needs --member', { code: 2 });
      result = await tracker.addMember({ card, member: values.member });
      break;
    case 'set-description':
      result = await tracker.setDescription({ card, text: textOf(values, 'text', io) });
      break;
    case 'create-card':
      result = await tracker.createCard({ status: values.status, name: values.name, desc: textOf(values, 'desc', io), labels: values.label ?? [] });
      break;
  }
  const out = { ok: true, command, ...result };
  if (values['dry-run']) {
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
        console.error(`tracker: ${e.message}`);
        process.stdout.write(JSON.stringify({ ok: false, error: e.message.split('\n\n')[0], ...(e.data ?? {}) }, null, 2) + '\n');
        process.exitCode = e.exitCode ?? 2;
      } else {
        console.error(e);
        process.exitCode = 1;
      }
    },
  );
}
