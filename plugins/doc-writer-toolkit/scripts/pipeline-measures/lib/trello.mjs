import fs from 'node:fs';
import path from 'node:path';
import { CliError } from '../../ui-labels/lib/util.mjs';

// Trello, read only. `request` has no method argument: it sends GET and nothing else, with the credentials in an
// Authorization header, never in the URL. Nothing here prints or returns a credential.

/** KEY=value lines, as in a .env file. Nothing is evaluated. */
export function parseEnvFile(text) {
  const vars = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const quoted = /^(['"])(.*)\1$/.exec(m[2]);
    vars[m[1]] = quoted ? quoted[2] : m[2].replace(/\s+#.*$/, '');
  }
  return vars;
}

// The environment first, then the credentials file. Returns null when either value is missing.
export function loadCredentials({ root, envFile, env = process.env }) {
  let fileVars = {};
  try {
    fileVars = parseEnvFile(fs.readFileSync(path.resolve(root, envFile), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new CliError(`cannot read the credentials file: ${e.code ?? 'error'}`, { code: 2 });
  }
  // A variable set in the environment wins over the file; an empty one does not count as set.
  const vars = { ...fileVars, ...Object.fromEntries(Object.entries(env).filter(([, v]) => v)) };
  const key = vars.TRELLO_API_KEY;
  const token = vars.TRELLO_API_TOKEN || vars.TRELLO_TOKEN;
  return key && token ? { key, token } : null;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createTrelloClient({ key, token, origin = 'https://api.trello.com', fetchImpl = globalThis.fetch, sleep = defaultSleep, retryDelaysMs = [2000, 4000, 8000], timeoutMs = 30000 }) {
  const base = new URL(origin);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
  if (base.protocol !== 'https:' && !local) throw new CliError(`the Trello origin must use https: ${base.origin}`, { code: 2 });
  const redact = (text) => String(text).split(key).join('***').split(token).join('***');

  return {
    async request(pathname, query = {}) {
      const url = new URL(pathname, base);
      for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
      const headers = { Accept: 'application/json', Authorization: `OAuth oauth_consumer_key="${key}", oauth_token="${token}"` };
      for (let attempt = 0; ; attempt++) {
        let res;
        try {
          res = await fetchImpl(url.toString(), { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
        } catch (err) {
          throw new Error(redact(`GET ${pathname}: ${err && err.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000} s` : err && err.message}`));
        }
        const text = await res.text();
        if (res.status === 429 && attempt < retryDelaysMs.length) {
          await sleep(retryDelaysMs[attempt]);
          continue;
        }
        if (!res.ok) throw new Error(redact(`GET ${pathname}: HTTP ${res.status}`));
        try {
          return JSON.parse(text);
        } catch {
          throw new Error(`GET ${pathname}: the answer is not JSON`);
        }
      }
    },
  };
}

// The cards a pull request links, as short links, in the order they appear.
export function cardLinks(body) {
  return [...new Set([...String(body).matchAll(/trello\.com\/c\/([A-Za-z0-9]{8})\b/g)].map((m) => m[1]))];
}

const norm = (s) => String(s).trim().toLowerCase();

// The times a card moved into the named list, oldest first.
export async function listEntries(client, shortLink, listName) {
  const actions = await client.request(`/1/cards/${shortLink}/actions`, { filter: 'updateCard:idList', limit: 1000 });
  if (!Array.isArray(actions)) throw new Error(`card ${shortLink}: unexpected answer`);
  return actions
    .filter((a) => a.data?.listAfter?.name && norm(a.data.listAfter.name) === norm(listName))
    .map((a) => a.date)
    .sort();
}
