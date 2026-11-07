import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CliError, TrackerError } from '../../lib/errors.mjs';

// The one network module of the tracker. Every read goes through `get`, every write through `write` (one function,
// so `--dry-run` can stop them all), every attachment through `download`. Nothing here prints or returns a credential:
// the key and token go in an Authorization header (and, on POST and PUT, in the form body, as Trello's own examples
// show), and every message is cleaned of them before it leaves.

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createTrelloClient({
  key,
  token,
  origin = 'https://api.trello.com',
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  retryDelaysMs = [2000, 4000, 8000],
  timeoutMs = 30000,
  dryRun = false,
}) {
  const base = new URL(origin);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
  if (base.protocol !== 'https:' && !local) throw new CliError(`the Trello origin must use https: ${base.origin}`, { code: 2 });
  const redact = (text) => String(text).split(key).join('***').split(token).join('***');
  const auth = `OAuth oauth_consumer_key="${key}", oauth_token="${token}"`;
  const calls = [];
  let fakeIds = 0;

  // 429 is retried after 2, 4 and 8 s, as the hub does; anything else that is not a success is reported.
  async function send(method, url, { headers, body, what, raw = false }) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(url.toString(), { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        const why = err && err.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000} s` : err && err.message;
        throw new TrackerError(redact(`${what}: ${why}`), { call: what });
      }
      if (res.status === 429 && attempt < retryDelaysMs.length) {
        await res.arrayBuffer().catch(() => {});
        await sleep(retryDelaysMs[attempt]);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new TrackerError(redact(`${what}: HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ''}`), { call: what, status: res.status });
      }
      if (raw) return res;
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new TrackerError(`${what}: the answer is not JSON`, { call: what, status: res.status });
      }
    }
  }

  const urlOf = (pathname, query = {}) => {
    const url = new URL(pathname, base);
    for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
    return url;
  };

  return {
    dryRun,
    // What a dry run would have sent, secrets removed.
    get calls() {
      return calls;
    },

    get(pathname, query) {
      return send('GET', urlOf(pathname, query), { headers: { Accept: 'application/json', Authorization: auth }, what: `GET ${pathname}` });
    },

    // The only function that changes anything. With dryRun it records the call and returns a fake answer.
    async write(method, pathname, form = {}, fake = {}) {
      if (!['POST', 'PUT', 'DELETE'].includes(method)) throw new Error(`write: ${method} is not a write`);
      if (dryRun) {
        const id = `dry-run-${++fakeIds}`;
        calls.push({ method, path: pathname, ...(Object.keys(form).length ? { form } : {}) });
        return { id, date: new Date().toISOString(), ...fake };
      }
      const headers = { Accept: 'application/json', Authorization: auth };
      let body;
      if (method !== 'DELETE') {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams({ ...form, key, token }).toString();
      }
      return send(method, urlOf(pathname), { headers, body, what: `${method} ${pathname}` });
    },

    // An attachment's bytes into `dest`, through a temp file. The credentials go only to Trello's own hosts (or the
    // origin the client was made for), never to the host a link attachment points at.
    async download(attachmentUrl, dest) {
      let url;
      try {
        url = new URL(attachmentUrl);
      } catch {
        throw new TrackerError('the attachment has no usable URL');
      }
      const trusted = url.hostname === base.hostname || url.hostname === 'trello.com' || url.hostname.endsWith('.trello.com');
      if (!trusted || (url.protocol !== 'https:' && !local)) {
        throw new TrackerError(`the attachment is on ${url.hostname}, not a Trello host: not downloaded`);
      }
      const res = await send('GET', url, { headers: { Authorization: auth }, what: `GET ${url.pathname.split('/').slice(0, 5).join('/')}…`, raw: true });
      const part = `${dest}.part`;
      try {
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part, { flags: 'w' }));
        fs.renameSync(part, dest);
      } catch (e) {
        fs.rmSync(part, { force: true });
        throw new TrackerError(redact(`download: ${e.message}`));
      }
      return { bytes: fs.statSync(dest).size };
    },
  };
}
