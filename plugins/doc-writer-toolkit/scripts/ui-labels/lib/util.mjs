import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Exit codes: 1 failure, 2 configuration/input problem (ask the user), 3 pending diff not synced,
// 10 `check` found something to do.
export class CliError extends Error {
  constructor(message, { code = 1, data = {} } = {}) {
    super(message);
    this.exitCode = code;
    this.data = data;
  }
}

export const log = (...args) => console.error(...args);

export function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

// Flattens nested objects/arrays to dotted keys. Non-string leaves are skipped.
export function flatten(value, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(value)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') {
      if (key in out) throw new Error(`duplicate key after flattening: ${key}`);
      out[key] = v;
    } else if (v && typeof v === 'object') {
      flatten(v, key, out);
    }
  }
  return out;
}

export function sortKeys(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(p) {
  let text;
  try {
    text = await fs.readFile(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CliError(`cannot parse ${p}: ${e.message}`);
  }
}

export async function writeFileAtomic(p, text) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, p);
}

export const writeJson = (p, data) => writeFileAtomic(p, JSON.stringify(data, null, 2) + '\n');

export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// Same hash `git hash-object` / `git ls-tree` report for a file with this content.
export function gitBlobHash(text) {
  const body = Buffer.from(text, 'utf8');
  return crypto
    .createHash('sha1')
    .update(`blob ${body.length}\0`)
    .update(body)
    .digest('hex');
}

export const unique = (list) => [...new Set(list)];

export function padTable(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => [...String(r[i] ?? '')].length)));
  return rows
    .map((r) =>
      r
        .map((c, i) => String(c ?? '') + ' '.repeat(widths[i] - [...String(c ?? '')].length))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}
