#!/usr/bin/env node
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { compare } from './lib/compare.mjs';

const USAGE = `doc-align <main-file> <secondary-file> [--ua main|secondary]

Compares the structure of two Markdown/MDX pages, a main (source of truth) and a secondary that must conform
to it, and prints one JSON report: { main, secondary, ua, bugs, warnings, passed }.

Options
  --ua main|secondary   which file is the UA page, for the heading-id checks (default: the one with more
                        Cyrillic letters in its headings, else in its whole text)
  -h, --help            this text
`;

const OPTIONS = {
  ua: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

// Exit codes: 0 the comparison ran (with findings or not), 1 unexpected failure, 2 bad usage or an unreadable file.
class CliError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.exitCode = code;
  }
}

async function read(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (e) {
    throw new CliError(e.code === 'ENOENT' ? `file not found: ${file}` : e.code === 'EISDIR' ? `not a file: ${file}` : `cannot read ${file}: ${e.message}`);
  }
}

async function main() {
  const { values, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (positionals.length !== 2) throw new CliError(`expected two files, got ${positionals.length}.\n\n${USAGE}`);
  if (values.ua !== undefined && !['main', 'secondary'].includes(values.ua)) throw new CliError(`--ua takes 'main' or 'secondary', not '${values.ua}'.`);
  const [mainPath, secondaryPath] = positionals;
  const [mainText, secondaryText] = [await read(mainPath), await read(secondaryPath)];
  const report = compare(mainText, secondaryText, { mainPath, secondaryPath, ua: values.ua });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return 0;
}

// Set the exit code instead of calling process.exit(): exiting right after a large write to a pipe truncates the output.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    if (e instanceof CliError || e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      console.error(`doc-align: ${e.message}`);
      process.stdout.write(JSON.stringify({ error: e.message.split('\n')[0] }, null, 2) + '\n');
      process.exitCode = e.exitCode ?? 2;
    } else {
      console.error(e);
      process.exitCode = 1;
    }
  },
);
