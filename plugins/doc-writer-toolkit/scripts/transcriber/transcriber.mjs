#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CliError } from '../ticket-state/lib/errors.mjs';
import { loadSettings } from '../ticket-state/lib/settings.mjs';
import { createTranscriber } from './lib/index.mjs';
import { SITE, SIGNED_IN, classify, snapshotOf } from './lib/turboscribe.mjs';
import { plainError } from './lib/driver.mjs';

const USAGE = `transcriber <command> [options]

The owner's side of the video gate's automatic transcription (the runner drives the uploads itself, at videoTry). It
opens the browser profile the ticket flow settings name (video.browserProfile), with the adapter video.transcriber
names. It stores no password and prints no session value: the profile keeps the sign-in.

Commands
  sign-in    open the profile in a visible browser at the service's sign-in page. Sign in by hand (with Google), check
             that the dashboard shows, then close the window: the command ends when it closes.
  check      open the dashboard as the automatic try would and print what it found: ok, signIn, captcha, limit or
             unexpected. Uploads nothing.

Options
  --root <dir>              the host repo (default: cwd)
  --settings <file>         the ticket flow settings file (default: as ticket-state finds it)
  -h, --help                this text

Exit codes: 0 done (check: the dashboard is the signed-in one) · 1 check found another page, or the browser failed ·
2 bad usage, no video.transcriber or video.browserProfile, or run in a role session.
`;

const OPTIONS = {
  root: { type: 'string' },
  settings: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

export async function main(argv, io = {}) {
  const { stdout = process.stdout, env = process.env } = io;
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  if (values.help || !positionals.length || positionals[0] === 'help') {
    stdout.write(USAGE);
    return 0;
  }
  const [command, ...rest] = positionals;
  if (!['sign-in', 'check'].includes(command) || rest.length) throw new CliError(`unknown command '${positionals.join(' ')}'.\n\n${USAGE}`, { code: 2 });
  // The profile holds the owner's sign-in: no role session opens it.
  if (env.DOC_TOOLKIT_ROLE_SESSION) throw new CliError('the transcriber is the owner\'s: refused in a role session', { code: 2 });
  const root = path.resolve(values.root ?? process.cwd());
  const settings = await loadSettings({ root, settings: values.settings });
  const v = settings.video;
  if (!v.transcriber || !v.browserProfile) throw new CliError('set video.transcriber and video.browserProfile first (ticket-state set video.transcriber turboscribe; ticket-state set video.browserProfile <folder>)', { code: 2 });
  // Signing in needs a window, whatever `headless` says.
  const transcriber = createTranscriber(v.transcriber, { settings: command === 'sign-in' ? { ...settings, video: { ...v, headless: false } } : settings, ...(io.chromium ? { chromium: io.chromium } : {}), ...(io.origin ? { origin: io.origin } : {}) });
  const session = await transcriber.open();
  const origin = io.origin ?? SITE.origin;
  try {
    if (command === 'sign-in') {
      await session.page.goto(origin + SITE.login, { waitUntil: 'domcontentloaded' }).catch(() => {});
      stdout.write(`Sign in to ${v.transcriber} in the window that opened, check that its dashboard shows, then close the window.\n`);
      // On macOS closing the window may leave the browser running: the page's close ends the command too.
      await new Promise((resolve) => {
        session.page.context().on('close', resolve);
        session.page.on('close', resolve);
      });
      stdout.write(JSON.stringify({ ok: true, command, profile: v.browserProfile }, null, 2) + '\n');
      return 0;
    }
    let kind;
    try {
      await session.page.goto(origin + SITE.dashboard, { waitUntil: 'domcontentloaded', timeout: 60000 });
      kind = classify(await snapshotOf(session.page, SIGNED_IN), { expect: SIGNED_IN }).kind;
    } catch (e) {
      stdout.write(JSON.stringify({ ok: false, command, kind: 'unexpected', error: plainError(e) }, null, 2) + '\n');
      return 1;
    }
    stdout.write(JSON.stringify({ ok: kind === 'ok', command, kind }, null, 2) + '\n');
    return kind === 'ok' ? 0 : 1;
  } finally {
    await session.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      const code = e?.exitCode ?? (e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' ? 2 : 1);
      console.error(`transcriber: ${plainError(e)}`);
      process.stdout.write(JSON.stringify({ ok: false, error: plainError(e) }, null, 2) + '\n');
      process.exitCode = code;
    },
  );
}
