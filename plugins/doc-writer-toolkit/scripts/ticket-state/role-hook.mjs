#!/usr/bin/env node
import fs from 'node:fs';
import { HOOK_VARIABLE, refusalOf } from './lib/role-hook.mjs';

// The PreToolUse hook of a role session (lib/role-hook.mjs decides; lib/runner.mjs passes it with --settings). It reads the
// tool call from standard input and exits 0 to let it through or 2 to refuse it, with the reason on standard error.
// Everything that isn't a clean pass is a refusal: no config, bad input, an error, its own deadline. The shell line around
// it (`|| exit 2`) covers what this file can't: a crash on load, a kill, a missing file.

const DEADLINE_MS = Number(process.env.DOC_TOOLKIT_ROLE_HOOK_DEADLINE_MS) || 20000;

function refuse(why) {
  try {
    fs.writeSync(2, `Refused by the role session's check: ${why}. Do the same work in a form that passes: one plain command per call, literal paths, or the Read, Grep and Write tools. Only when no such form exists, record the stage failed with the reason.\n`);
  } finally {
    process.exit(2);
  }
}

process.on('uncaughtException', (e) => refuse(`the check failed (${e.message})`));
process.on('unhandledRejection', (e) => refuse(`the check failed (${e?.message ?? e})`));
setTimeout(() => refuse('the check ran out of time'), DEADLINE_MS);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  input += d;
  if (input.length > 2_000_000) refuse('the tool call is too long');
});
process.stdin.on('error', (e) => refuse(`the tool call can't be read (${e.message})`));
process.stdin.on('end', () => {
  const call = JSON.parse(input);
  const config = JSON.parse(process.env[HOOK_VARIABLE] ?? 'null');
  if (!config || typeof config !== 'object') refuse('the runner gave no config');
  const command = call?.tool_input?.command;
  if (typeof command !== 'string') refuse(`the call to ${call?.tool_name ?? 'a tool'} has no command`);
  const why = refusalOf(command, config, { cwd: call.cwd });
  if (why) refuse(why);
  process.exit(0);
});
