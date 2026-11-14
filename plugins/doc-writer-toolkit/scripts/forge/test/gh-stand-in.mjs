#!/usr/bin/env node
// The `gh` of the CLI tests: a file named `gh` on PATH runs this. It replays the routes in the JSON file named by
// FAKE_GH_ROUTES (see fake-gh.mjs) and appends every call it gets to the file named by FAKE_GH_LOG, one JSON per line.
// With FAKE_GH_LEAK set, a failing call prints that text on stderr, to show the module cleans it.
import fs from 'node:fs';
import { replayer } from './fake-gh.mjs';

const routes = JSON.parse(fs.readFileSync(process.env.FAKE_GH_ROUTES, 'utf8'));
const input = fs.readFileSync(0, 'utf8');
const run = replayer(routes, {
  onCall: (call) => fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args: process.argv.slice(2), ...call }) + '\n'),
});
const res = await run(process.argv.slice(2), { input });
process.stdout.write(res.stdout);
process.stderr.write(res.stderr + (res.code && process.env.FAKE_GH_LEAK ? ` ${process.env.FAKE_GH_LEAK}` : ''));
process.exitCode = res.code;
