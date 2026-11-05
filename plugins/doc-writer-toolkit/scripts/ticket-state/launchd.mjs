#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CliError } from './lib/errors.mjs';
import { loadSettings } from './lib/settings.mjs';
import { agentFor, agentState, install, labelOf, agentsDirOf, uninstall } from './lib/launchd.mjs';

const USAGE = `launchd <command> [options]

The LaunchAgent that starts the ticket flow's watcher on macOS, every schedule.watchMinutes (one per host repo).

Commands
  print       the plist it would install, and where (installs nothing)
  install     writes ~/Library/LaunchAgents/<label>.plist and loads it (an existing one is replaced)
  uninstall   unloads it and removes the plist; 'left' says whether anything of it remains
  status      whether the plist exists and the job is loaded

Options
  --noop                    a test agent under its own label: it runs 'watcher.mjs --noop', which reads nothing and
                            exits (for an install and uninstall check)
  --root <dir>              the host repo (default: cwd)
  --settings <file>         the ticket flow settings file
  -h, --help                this text
`;

const OPTIONS = { noop: { type: 'boolean' }, root: { type: 'string' }, settings: { type: 'string' }, help: { type: 'boolean', short: 'h' } };

export async function main(argv, io = {}) {
  const { stdout = process.stdout } = io;
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const [command, extra] = positionals;
  if (values.help || !command || command === 'help') {
    stdout.write(USAGE);
    return 0;
  }
  if (extra) throw new CliError(`unexpected argument '${extra}'`, { code: 2 });
  if (!['print', 'install', 'uninstall', 'status'].includes(command)) throw new CliError(`unknown command '${command}'.\n\n${USAGE}`, { code: 2 });
  if (process.platform !== 'darwin' && !io.launchctl && command !== 'print') throw new CliError('launchd is macOS only', { code: 2 });
  const root = path.resolve(values.root ?? process.cwd());
  const noop = Boolean(values.noop);
  let result;
  // `uninstall` and `status` need the path only: they work for a host that moved or whose settings don't load.
  if (command === 'uninstall') result = uninstall(root, { noop, io });
  else if (command === 'status') {
    const label = labelOf(root, { noop });
    result = agentState(label, path.join(agentsDirOf(io), `${label}.plist`), io);
  } else {
    const settings = await loadSettings({ root, settings: values.settings });
    if (command === 'print') {
      const a = agentFor(settings, { noop, io });
      result = { label: a.label, file: a.file, missing: a.missing, plist: a.text };
    } else result = install(settings, { noop, io });
  }
  stdout.write(JSON.stringify({ ok: true, command, ...result }, null, 2) + '\n');
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
        console.error(`launchd: ${e.message}`);
        process.stdout.write(JSON.stringify({ ok: false, error: e.message.split('\n\n')[0], ...(e.data ?? {}) }, null, 2) + '\n');
        process.exitCode = e.exitCode ?? 2;
      } else {
        console.error(e);
        process.exitCode = 1;
      }
    },
  );
}
