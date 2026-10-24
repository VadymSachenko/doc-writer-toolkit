#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CliError, log, printJson } from '../ui-labels/lib/util.mjs';
import { resolveConfig, configView } from './lib/config.mjs';
import { resolveManifest, failShot, promoteManifest, manifestStatus } from './lib/manifest.mjs';

const USAGE = `screenshot-locales <command> [<manifest>] [options]

Exit codes: 0 ok · 1 a set was not promoted, or a shot is not complete · 2 configuration or input problem (ask the
user) · 3 unexpected error (stop and report it)

Commands
  config                 The screenshot locales, how the app switches between them, and each locale's folder per
                         root pair. multilocale: false when no 'Screenshot locales:' is declared. Exit 2 lists every
                         problem (a locale docusaurus.config doesn't have, a missing switch token).
  resolve <manifest>     Fills each shot's required locales, staged paths and output paths; sets the shots to capture
                         to pending and deletes their leftover staged files. Without --shot, only shots never resolved.
                         Writes nothing if anything is unresolved or unsafe (an output folder through a symlink).
  fail <manifest>        Records that one locale of a shot could not be captured: --shot <id> --locale <l> --reason <t>.
  promote <manifest>     Moves each complete staged set into place, all locales of the round or none. A shot with a
                         failed or missing locale keeps its previous images; its staged files are discarded. Exit 1 if any.
  status <manifest>      Per shot: complete, pending, failed, mixed (some locales have their image, some don't) or
                         interrupted (an earlier image left in staging). Exit 1 unless every shot is complete.

Options (default: the 'Documentation toolkit configuration' block of <root>/CLAUDE.md)
  --root <dir>             docs repo root (default: cwd)
  --state-root <dir>       default .doc-toolkit (staging goes to <state root>/screenshot-staging/)
  --docusaurus-config <f>  path to the Docusaurus config
  --ua-root <dir> --en-root <dir>   the primary root pair's content roots
config:   --locales <list>   an explicitly locale-scoped request: each must be a declared screenshot locale
resolve:  --shot <ids>       the shots to (re)capture (default: only the shots never resolved)  --dry-run
          --locales <list>   with --shot: a one-off locale-scoped request (the other locales must be committed)
promote:  --shot <ids>  --dry-run
`;

const OPTIONS = {
  root: { type: 'string' },
  'state-root': { type: 'string' },
  'docusaurus-config': { type: 'string' },
  'ua-root': { type: 'string' },
  'en-root': { type: 'string' },
  locales: { type: 'string' },
  shot: { type: 'string' },
  locale: { type: 'string' },
  reason: { type: 'string' },
  'dry-run': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

async function main() {
  const { values, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true });
  const [command, manifestArg] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 2;
  }
  const cfg = await resolveConfig(values);
  if (command === 'config') {
    if (cfg.problems.length) {
      throw new CliError(`The screenshot locales can't be resolved: ${cfg.problems.map((p) => p.message).join(' ')}`, { code: 2, data: { problems: cfg.problems } });
    }
    printJson(configView(cfg));
    return 0;
  }
  if (!manifestArg) throw new CliError(`${command} needs the manifest path.\n\n${USAGE}`, { code: 2 });
  const manifest = path.resolve(cfg.root, manifestArg);
  switch (command) {
    case 'resolve':
      printJson(await resolveManifest(cfg, manifest, { shot: values.shot, dryRun: values['dry-run'] }));
      return 0;
    case 'fail':
      printJson(await failShot(manifest, { shot: values.shot, locale: values.locale, reason: values.reason }));
      return 0;
    case 'promote': {
      const out = await promoteManifest(cfg, manifest, { shot: values.shot, dryRun: values['dry-run'] });
      printJson(out);
      return out.ok ? 0 : 1;
    }
    case 'status': {
      const out = await manifestStatus(cfg, manifest);
      printJson(out);
      return out.ok ? 0 : 1;
    }
    default:
      throw new CliError(`Unknown command '${command}'.\n\n${USAGE}`, { code: 2 });
  }
}

// Set the exit code instead of calling process.exit(): exiting right after a large write to a pipe truncates the output.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    if (e instanceof CliError) {
      log(`screenshot-locales: ${e.message}`);
      printJson({ error: e.message, ...e.data });
      process.exitCode = e.exitCode;
    } else if (e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      log(`screenshot-locales: ${e.message}\n\n${USAGE}`);
      process.exitCode = 2;
    } else {
      log(e);
      process.exitCode = 3;
    }
  },
);
