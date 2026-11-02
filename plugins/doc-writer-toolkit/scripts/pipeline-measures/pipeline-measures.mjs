#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CliError } from '../ui-labels/lib/util.mjs';
import { loadSettings } from './lib/config.mjs';
import { makeGh, makeGit } from './lib/runners.mjs';
import { fetchPulls } from './lib/gitdata.mjs';
import { createSources } from './lib/sources.mjs';
import { measurePr, summarize } from './lib/measures.mjs';
import { renderTable } from './lib/report.mjs';

const USAGE = `pipeline-measures --from <YYYY-MM-DD> --to <YYYY-MM-DD> [options]

Measures a docs pipeline on a clone of the docs repo: for each pull request whose branch matches the pipeline's
pattern and that was created in the window, the markers in its draft, when its card entered SME review, the open
questions in its description, the commits after the pipeline's own with their changed lines, the owner's final edit,
the review of developer and API docs, and cost per stage. Read only: it calls git, gh and Trello's API for reading and
writes nothing but the --out file. A measure with no data source yet prints n/a with the reason.

Prints JSON on stdout and a readable table on stderr; --table prints the table on stdout alone.

Run it from the clone (or pass --root). Settings come from the 'Documentation toolkit configuration' block of
<root>/CLAUDE.md; each flag below overrides its field.

Options
  --root <dir>               the clone (default: cwd)
  --from <date>, --to <date> the window, by the day a PR was created, both days included (UTC)
  --repo <owner/name>        the GitHub repository (default: the clone's origin, as gh finds it)
  --fetch                    first fetch the pull requests' commits into the clone (git fetch of refs/pull/*/head)
  --out <file>               also write the JSON to this file
  --table                    print the table on stdout instead of the JSON
  --redact                   leave out branch names and titles from the output
  --branch-pattern <regex>   Pipeline branch pattern (required)
  --commit-pattern <regex>   Pipeline commit pattern, on the first line of the message (required)
  --draft-pattern <regex>    Draft commit pattern: which pipeline commits are the draft
  --ready-pattern <regex>    Ready commit pattern: the commit that marks a PR ready for merge
  --sme-list <name>          SME review list: the tracker list whose entry the card's date comes from
  --questions-heading <text> Open questions heading (default: Open questions)
  --review <sme|places>      Pipeline review policy (default: sme)
  --run-log <file>           Run log: JSON Lines with the cost of each step
  --env <file>               Credentials file with TRELLO_API_KEY and TRELLO_API_TOKEN (default: .env in the root)
  -h, --help                 this text
`;

const OPTIONS = {
  root: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  repo: { type: 'string' },
  fetch: { type: 'boolean' },
  out: { type: 'string' },
  table: { type: 'boolean' },
  redact: { type: 'boolean' },
  'branch-pattern': { type: 'string' },
  'commit-pattern': { type: 'string' },
  'draft-pattern': { type: 'string' },
  'ready-pattern': { type: 'string' },
  'sme-list': { type: 'string' },
  'questions-heading': { type: 'string' },
  review: { type: 'string' },
  'run-log': { type: 'string' },
  env: { type: 'string' },
  'trello-origin': { type: 'string' }, // for tests: a local server instead of Trello
  help: { type: 'boolean', short: 'h' },
};

// `io` carries everything the run touches, so tests can replace it: gh, git, fetchImpl, sleep, env, stdout, stderr,
// and `sources` (entries that replace the default source of a measure).
export async function main(argv, io = {}) {
  const { stdout = process.stdout, stderr = process.stderr, env = process.env } = io;
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  if (values.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (positionals.length) throw new CliError(`unexpected argument '${positionals[0]}'\n\n${USAGE}`);
  const s = await loadSettings(values);
  const git = io.git ?? makeGit(s.root);
  const gh = io.gh ?? makeGh(s.root);
  if (s.fetch) await fetchPulls(git);

  const sources = { ...createSources(s, { gh, git, fetchImpl: io.fetchImpl, sleep: io.sleep, env }), ...(io.sources ?? {}) };
  const prs = [];
  for (const pr of await sources.prs()) prs.push(await measurePr(pr, { s, sources }));

  const result = {
    ok: true,
    range: { from: s.from, to: s.to },
    settings: {
      branchPattern: s.branchPatternSource,
      commitPattern: s.commitPatternSource,
      draftPattern: s.draftPatternSource ?? null,
      readyPattern: s.readyPatternSource ?? null,
      smeList: s.smeList,
      questionsHeading: s.questionsHeading,
      reviewPolicy: s.reviewPolicy,
      runLog: s.runLog,
    },
    summary: summarize(prs),
    prs,
    warnings: [...(sources.warnings ?? []), ...prs.flatMap((p) => (p.warnings ?? []).map((w) => `PR ${p.number}: ${w}`))],
  };
  if (s.redact) {
    for (const p of result.prs) {
      delete p.branch;
      delete p.title;
    }
    delete result.settings.runLog;
    delete result.settings.smeList;
  }
  const json = JSON.stringify(result, null, 2) + '\n';
  if (values.out) fs.writeFileSync(path.resolve(s.root, values.out), json);
  const table = renderTable(result) + '\n';
  if (values.table) stdout.write(table);
  else {
    stdout.write(json);
    stderr.write(table);
  }
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
        console.error(`pipeline-measures: ${e.message}`);
        process.stdout.write(JSON.stringify({ ok: false, error: e.message.split('\n\n')[0], ...(e.data ?? {}) }, null, 2) + '\n');
        process.exitCode = e.exitCode ?? 2;
      } else {
        console.error(e);
        process.exitCode = 1;
      }
    },
  );
}
