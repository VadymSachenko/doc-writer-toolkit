import { spawn } from 'node:child_process';
import { ForgeError } from '../../lib/errors.mjs';

// The one process module of the GitHub adapter. Every read goes through `get` or `query`, every change through
// `write` (one function, so `--dry-run` can stop them all). Everything is `gh api`: REST paths, or GraphQL with the
// request as JSON on standard input, so no text is ever put on a command line. `gh` brings its own login (its stored
// session, or GH_TOKEN / GITHUB_TOKEN in the environment); this module never reads, prints, logs or writes a token,
// and cleans every message of anything that looks like one.

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TOKEN_VARS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
const TOKEN_SHAPE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

export function makeRedact(env = process.env) {
  const secrets = TOKEN_VARS.map((v) => env[v]).filter((v) => typeof v === 'string' && v.length >= 8);
  return (text) => {
    let out = String(text);
    for (const s of secrets) out = out.split(s).join('***');
    return out.replace(TOKEN_SHAPE, '***');
  };
}

// Runs `gh` with the arguments and the request body on standard input. Resolves { code, stdout, stderr }.
export function spawnGh(args, { input, env = process.env, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('gh', args, { env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: signal ? 1 : code, stdout, stderr: signal ? `${stderr}\ngh was stopped after ${timeoutMs / 1000} s` : stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

export function createGh({
  runner = spawnGh,
  env = process.env,
  sleep = defaultSleep,
  retryDelaysMs = [2000, 4000, 8000],
  dryRun = false,
} = {}) {
  const redact = makeRedact(env);
  const calls = [];
  let fakeIds = 0;

  const statusOf = (stdout, stderr) => {
    const m = /\(HTTP (\d{3})\)/.exec(stderr) ?? /"status"\s*:\s*"?(\d{3})"?/.exec(stdout);
    return m ? Number(m[1]) : null;
  };
  const rateLimited = (status, stdout, stderr) => status === 429 || (status === 403 && /rate limit|abuse/i.test(`${stdout}${stderr}`));

  // Runs `gh api` and returns the parsed JSON. 429 and rate-limit 403 are retried after 2, 4 and 8 s.
  async function api(args, { input, what }) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await runner(['api', ...args], { input, env });
      } catch (e) {
        const why = e && e.code === 'ENOENT' ? 'the gh command is not installed or not on PATH' : e && e.message;
        throw new ForgeError(redact(`${what}: ${why}`), { call: what });
      }
      if (res.code === 0) {
        const text = res.stdout.trim();
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch {
          throw new ForgeError(`${what}: the answer is not JSON`, { call: what });
        }
      }
      const status = statusOf(res.stdout, res.stderr);
      if (rateLimited(status, res.stdout, res.stderr) && attempt < retryDelaysMs.length) {
        await sleep(retryDelaysMs[attempt]);
        continue;
      }
      const detail = redact(`${res.stderr.trim()} ${res.stdout.trim()}`.trim().replace(/\s+/g, ' ')).slice(0, 300);
      throw new ForgeError(`${what}: ${status ? `HTTP ${status}` : 'gh failed'}${detail ? ` ${detail}` : ''}`, { call: what, ...(status ? { status } : {}) });
    }
  }

  return {
    dryRun,
    // What a dry run would have sent.
    get calls() {
      return calls;
    },

    // REST read. `pathname` may carry a query string.
    get(pathname) {
      return api(['-H', 'Accept: application/vnd.github+json', pathname], { what: `GET ${pathname.split('?')[0]}` });
    },

    // GraphQL read: refuses a document that changes anything, so a read can never be a write in disguise.
    async query(name, document, variables = {}) {
      if (/\bmutation\b/i.test(document)) throw new Error('query: a mutation goes through write');
      const out = await api(['graphql', '--input', '-'], { input: JSON.stringify({ query: document, variables }), what: `graphql ${name}` });
      return graphqlData(out, name);
    },

    // The only function that changes anything. `method` and `pathname` for REST; `pathname` `graphql` with a
    // `{ query, variables }` body for a GraphQL mutation. With dryRun it records the call and returns the fake answer.
    async write(method, pathname, body, fake = {}) {
      if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) throw new Error(`write: ${method} is not a write`);
      if (dryRun) {
        calls.push({ method, path: pathname, ...(body ? { body } : {}) });
        return { id: `dry-run-${++fakeIds}`, ...fake };
      }
      if (pathname === 'graphql') {
        const name = /\bmutation\s+(\w+)/.exec(body.query)?.[1] ?? 'mutation';
        const out = await api(['graphql', '--input', '-'], { input: JSON.stringify({ query: body.query, variables: body.variables ?? {} }), what: `graphql ${name}` });
        return graphqlData(out, name);
      }
      return api(['-X', method, '-H', 'Accept: application/vnd.github+json', pathname, '--input', '-'], { input: JSON.stringify(body ?? {}), what: `${method} ${pathname}` });
    },
  };
}

function graphqlData(out, name) {
  if (out?.errors?.length) throw new ForgeError(`graphql ${name}: ${out.errors.map((e) => e.message).join('; ').slice(0, 300)}`, { call: `graphql ${name}` });
  if (!out?.data) throw new ForgeError(`graphql ${name}: no data in the answer`, { call: `graphql ${name}` });
  return out.data;
}
