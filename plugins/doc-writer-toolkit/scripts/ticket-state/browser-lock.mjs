#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CliError } from './lib/errors.mjs';
import { loadSettings } from './lib/settings.mjs';
import { STALE_MINUTES, browserLockDir, browserLockState, freeBrowserLock, noteBusy, takeBrowserLock } from './lib/browser-lock.mjs';

const USAGE = `browser-lock take|free|status --ticket <key> [--wait <minutes>] [--root <dir>] [--settings <file>]

The host's browser lock, <state>/.playwright.lock, for a pipeline session's Playwright run: take it before, free it
after. A hand run keeps the host's own procedure on the same folder (mkdir, then move it away), so the two never run
at once.

  take    takes it for the ticket; waits up to --wait minutes (default 10; a session passes 9 and gives
          the call its tool's longest timeout, 10 minutes) while someone else holds it. A lock older than ${STALE_MINUTES} minutes is taken over. Exit 3
          when it is still held after the wait: noted for the runner, which counts the session as waiting, not failed.
  free    frees it when this ticket holds it. A lock someone else holds stays (exit 3). The runner also frees a lock a
          session's ticket still holds when the session ends.
  status  who holds it, since when, and whether it is stale.

Exit codes: 0 done · 1 an unexpected error · 2 bad usage · 3 held by someone else, or the lock is not a folder.
`;

const OPTIONS = { root: { type: 'string' }, settings: { type: 'string' }, ticket: { type: 'string' }, wait: { type: 'string' }, help: { type: 'boolean', short: 'h' } };

// `io.now` and `io.sleep` replace the clock and the wait in tests.
export async function main(argv, io = {}) {
  const { stdout = process.stdout, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = io;
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const print = (o) => stdout.write(JSON.stringify(o, null, 2) + '\n');
  if (values.help) {
    stdout.write(USAGE);
    return 0;
  }
  const [command, ...extra] = positionals;
  if (!['take', 'free', 'status'].includes(command) || extra.length) throw new CliError(`take, free or status, and no other argument.\n\n${USAGE}`);
  const settings = await loadSettings({ root: path.resolve(values.root ?? process.cwd()), settings: values.settings });
  const lock = browserLockDir(settings.state);
  if (command === 'status') {
    print({ ok: true, lock, ...browserLockState(settings.state, now()) });
    return 0;
  }
  const wait = values.wait === undefined ? 10 : Number(values.wait);
  if (!(Number.isFinite(wait) && wait >= 0 && wait <= 60)) throw new CliError(`--wait takes minutes from 0 to 60: ${values.wait}`);
  try {
    if (command === 'free') {
      const r = freeBrowserLock(settings.state, { tickets: [checked(values.ticket)] });
      print({ ok: !r.holder && !r.broken, lock, ...r });
      return r.holder || r.broken ? 3 : 0;
    }
    const until = now() + wait * 60000;
    for (;;) {
      const r = takeBrowserLock(settings.state, { ticket: values.ticket, now: now() });
      if (r.taken || r.broken || now() >= until) {
        // Held by someone else for the whole wait: noted, so the runner counts the session as waiting, not failed.
        if (!r.taken && !r.broken) noteBusy(settings.state, { ticket: values.ticket, holder: r.holder, now: now() });
        print({ ok: Boolean(r.taken), lock, ...r });
        return r.taken ? 0 : 3;
      }
      await sleep(Math.min(15000, Math.max(0, until - now())));
    }
  } catch (e) {
    if (e.exitCode) throw new CliError(e.message, { code: e.exitCode });
    throw e;
  }
}

function checked(ticket) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(ticket ?? ''))) throw new CliError(`--ticket <key> is required: the ticket the lock is taken for (${ticket ?? 'none'})`);
  return ticket;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`browser-lock: ${e.message}`);
      process.stdout.write(JSON.stringify({ ok: false, error: String(e.message).split('\n\n')[0] }, null, 2) + '\n');
      process.exitCode = e?.exitCode ?? (String(e?.code).startsWith('ERR_PARSE_ARGS') ? 2 : 1);
    },
  );
}
