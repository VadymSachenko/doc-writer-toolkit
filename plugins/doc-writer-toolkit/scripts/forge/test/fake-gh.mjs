import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A stand-in for the `gh` command that replays recorded (invented) answers. It understands the three shapes of call
// the module makes, all `gh api`:
//   gh api -H 'Accept: …' <path>                          a REST read           route key  "GET <path>"
//   gh api -X <METHOD> -H '…' <path> --input -            a REST change         route key  "<METHOD> <path>"
//   gh api graphql --input -                              GraphQL (a query or a mutation)   "graphql <OperationName>"
// A GET route is looked up with its query string first, then without it. A route's value is the JSON `gh` printed, or
//   { __seq: [v1, v2, …] }   the answers in turn (the last one repeats),
//   { __fail: { status, message, body? } }   gh exits 1 with "gh: <message> (HTTP <status>)",
//   a function (request) => value (in-process use only).
// A call with no recorded answer fails the way gh would, so a test sees every call the module makes that it did not expect.

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const fixture = (name) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', `${name}.json`), 'utf8'));
export const ghFail = (status, message, body) => ({ __fail: { status, message, ...(body !== undefined ? { body } : {}) } });
export const seq = (...answers) => ({ __seq: answers });

export function parseCall(args, input) {
  if (args[0] !== 'api') return { kind: 'other', args };
  const rest = args.slice(1);
  if (rest[0] === 'graphql') {
    const body = JSON.parse(input);
    const m = /\b(query|mutation)\s+(\w+)/.exec(body.query);
    return { kind: 'graphql', op: m ? m[2] : 'anonymous', mutation: m?.[1] === 'mutation', query: body.query, variables: body.variables ?? {}, key: `graphql ${m ? m[2] : 'anonymous'}` };
  }
  let method = 'GET';
  let pathname = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '-X') method = rest[++i];
    else if (rest[i] === '-H') i++;
    else if (rest[i] === '--input') i++;
    else pathname = rest[i];
  }
  return { kind: 'rest', method, path: pathname, body: input ? JSON.parse(input) : null, key: `${method} ${pathname}`, write: method !== 'GET' };
}

export function replayer(routes, { onCall } = {}) {
  const used = new Map();
  const answerOf = (key, call) => {
    const alt = call.path?.includes('?') ? `${call.method} ${call.path.split('?')[0]}` : null;
    const hit = key in routes ? key : alt && alt in routes ? alt : null;
    if (!hit) return { missing: true };
    let value = routes[hit];
    if (typeof value === 'function') value = value(call);
    if (value && typeof value === 'object' && '__seq' in value) {
      const n = used.get(hit) ?? 0;
      used.set(hit, n + 1);
      value = value.__seq[Math.min(n, value.__seq.length - 1)];
    }
    return { value };
  };
  return async (args, { input } = {}) => {
    const call = parseCall(args, input);
    onCall?.(call);
    if (call.kind === 'other') return { code: 1, stdout: '', stderr: `fake gh: unsupported command ${args.join(' ')}` };
    const { value, missing } = answerOf(call.key, call);
    if (missing) return { code: 1, stdout: '', stderr: `fake gh: no recorded answer for ${call.key}` };
    if (value && typeof value === 'object' && '__fail' in value) {
      const f = value.__fail;
      return { code: 1, stdout: f.body === undefined ? '' : JSON.stringify(f.body), stderr: `gh: ${f.message} (HTTP ${f.status})` };
    }
    return { code: 0, stdout: JSON.stringify(value), stderr: '' };
  };
}
