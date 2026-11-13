#!/usr/bin/env node
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { compare } from './lib/compare.mjs';
import { detectUa } from './lib/headings.mjs';
import { parse } from './lib/parse.mjs';
import { mergeRows, parseNamesTable } from './lib/names.mjs';
import { proposeIds } from './lib/ids.mjs';
import { parseExamplePairs } from './lib/examples.mjs';

const USAGE = `doc-align <main-file> <secondary-file> [--ua main|secondary] [--names <glossary-file>]... [--examples <example-values-file>]
doc-align <main-file> <secondary-file> --propose-ids [--ua main|secondary] [--root <dir>[=<url prefix>]]... [--write]

Compares the structure of two Markdown/MDX pages, a main (source of truth) and a secondary that must conform
to it, and prints one JSON report: { main, secondary, ua, bugs, warnings, passed }.

Options
  --ua main|secondary   which file is the UA page, for the heading-id checks (default: the one with more
                        Cyrillic letters in its headings, else in its whole text)
  --names <file>        a product kit glossary with a names table ('## Names' or '## Назви'); checks the
                        names of organizations against it (Check 12). May be given more than once
  --examples <file>     a product kit's example values file; Check 6 counts each of its existing pairs ('## Existing
                        pairs' or '## Наявні пари') as the same value: a quoted UA value may be its EN value in EN
  --propose-ids        instead of comparing: propose an id for every UA heading without one, from the EN
                        heading at the same position, and list the links that use the old fragments. Prints
                        { ua, en, proposals, links, unresolved, skipped }
  --root <dir>[=<url prefix>]
                        with --propose-ids: a content root (UA, or EN) to search for links (prefix default '/'). May be
                        given more than once
  --write               with --propose-ids: add the ids to the UA page and rewrite the listed links in place
  -h, --help            this text
`;

const OPTIONS = {
  ua: { type: 'string' },
  names: { type: 'string', multiple: true },
  examples: { type: 'string' },
  'propose-ids': { type: 'boolean' },
  root: { type: 'string', multiple: true },
  write: { type: 'boolean' },
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
  if (!values['propose-ids'] && (values.root || values.write)) throw new CliError('--root and --write go with --propose-ids.');
  if (values['propose-ids']) {
    if (values.names) throw new CliError('--names does not go with --propose-ids.');
    if (values.examples) throw new CliError('--examples does not go with --propose-ids.');
    const ua = values.ua ?? detectUa(mainText, secondaryText, parse(mainText), parse(secondaryText));
    if (!ua) throw new CliError('cannot tell which page is UA (no Cyrillic text in either, or the same amount): pass --ua main|secondary.');
    const [uaPath, enPath, uaText, enText] = ua === 'main' ? [mainPath, secondaryPath, mainText, secondaryText] : [secondaryPath, mainPath, secondaryText, mainText];
    const roots = [];
    for (const r of values.root ?? []) {
      const [dir, prefix = '/'] = r.split('=');
      const stat = await fs.stat(dir).catch(() => null);
      if (!stat?.isDirectory()) throw new CliError(`--root: not a folder: ${dir}`);
      roots.push({ dir, prefix });
    }
    const report = await proposeIds(uaText, enText, { uaPath, enPath, roots, write: values.write });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return 0;
  }
  let names;
  if (values.names) {
    const tables = [];
    for (const file of values.names) tables.push({ file, ...parseNamesTable(await read(file)) });
    names = { tables: tables.map(({ file, found }) => ({ file, found })), rows: mergeRows(tables) };
  }
  const examples = values.examples ? { file: values.examples, ...parseExamplePairs(await read(values.examples)) } : undefined;
  const report = compare(mainText, secondaryText, { mainPath, secondaryPath, ua: values.ua, names, examples });
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
