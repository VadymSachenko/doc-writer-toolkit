import fs from 'node:fs';
import path from 'node:path';

// The environment every `claude` the ticket flow starts gets. Unattended runs are paid by the plan: an API key or an
// auth token in the environment would win over the plan's sign-in (`claude -p` always uses a key that is present), so
// both are removed. A long-lived sign-in token (`claude setup-token`) can be read from a file the owner keeps; it goes
// into the child's environment only, and is never printed, logged or written anywhere.

export const BILLED_VARIABLES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
export const TOKEN_VARIABLE = 'CLAUDE_CODE_OAUTH_TOKEN';

// A copy of `env` without the variables that would bill an API account instead of the plan.
export function childEnv(env = process.env, extra = {}) {
  const out = { ...env, ...extra };
  for (const k of BILLED_VARIABLES) delete out[k];
  return out;
}

// The names (never the values) of the billed variables `env` holds.
export const billedIn = (env = process.env) => BILLED_VARIABLES.filter((k) => env[k] !== undefined && env[k] !== '');

// The sign-in token from `schedule.tokenFile`: { token } or { refused: why }, or {} with no file set. The file must be
// readable by its owner only (mode 600 or stricter), and hold the token on its first line.
export function readTokenFile(file, root) {
  if (!file) return {};
  const at = path.resolve(root, String(file).replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
  let st;
  try {
    st = fs.statSync(at);
  } catch (e) {
    return { refused: `the token file ${at} can't be read (${e.code ?? 'error'})` };
  }
  if (!st.isFile()) return { refused: `the token file ${at} is not a file` };
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) return { refused: `the token file ${at} is readable by others (mode ${(st.mode & 0o777).toString(8)}): chmod 600 it` };
  const token = fs.readFileSync(at, 'utf8').split('\n')[0].trim();
  if (!token) return { refused: `the token file ${at} is empty` };
  return { token };
}

// Prepares the environment of an unattended run: removes the billed variables from `env` in place, and builds the
// environment of every `claude` the run starts, with the token from `schedule.tokenFile`, so they use the plan. The
// token goes into that copy only: never into `env`, so host scripts, git and gh never see it. Returns the notes naming
// what changed (never a value) and that environment.
export function prepareEnv(settings, env = process.env) {
  const notes = [];
  const billed = billedIn(env);
  for (const k of BILLED_VARIABLES) delete env[k];
  if (billed.length) notes.push(`removed ${billed.join(' and ')} from the environment: the plan pays, not an API account`);
  const t = readTokenFile(settings.schedule?.tokenFile, settings.root);
  if (t.token) notes.push(`${TOKEN_VARIABLE} set from schedule.tokenFile for the claude sessions only`);
  else if (t.refused) notes.push(`the sign-in token was not used: ${t.refused}`);
  return { notes, claudeEnv: childEnv(env, t.token ? { [TOKEN_VARIABLE]: t.token } : {}) };
}

// The environment of a host script: no billed variable and no sign-in token.
export function scriptEnv(env = process.env, extra = {}) {
  const out = childEnv(env, extra);
  delete out[TOKEN_VARIABLE];
  return out;
}
