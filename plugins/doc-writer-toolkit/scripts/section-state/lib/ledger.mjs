import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const SCHEMA_VERSION = 1;
export const SECTION_STAGES = ['readiness', 'explore', 'plan', 'planApproval', 'resolve'];
export const PAGE_STAGES = ['write', 'fix', 'review', 'uaApproval', 'translate', 'align'];
export const STATUSES = ['running', 'done', 'skipped', 'failed'];

// Files of the section, relative to the section folder.
export const FILES = {
  ledger: '.sources/section-state.json',
  readiness: '.sources/section-readiness.json',
  appNotes: '.sources/app-notes.md',
  planMd: '.sources/section-plan.md',
  planJson: '.sources/section-plan.json',
};

// Exit codes: 1 a record was refused (nothing written) or an unexpected failure, 2 bad usage or configuration.
export class CliError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.exitCode = code;
  }
}

export const refuse = (message) => new CliError(`nothing recorded: ${message}`, 1);

const run = promisify(execFile);
export const git = (root, args) => run('git', ['-C', root, ...args], { maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout);

// Posix path from the repo root, without ./ and a trailing slash.
export function norm(p) {
  return String(p).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
}

export const dirOf = (p) => (norm(p) ? `${norm(p)}/` : '');
export const inside = (file, dir) => !dir || norm(file).startsWith(dirOf(dir));

// The hash `git hash-object` reports for a file with these bytes.
export function blobHash(buf) {
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

export async function fileHash(root, rel) {
  try {
    return blobHash(await fs.readFile(path.join(root, rel)));
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return null;
    throw e;
  }
}

export async function readText(root, rel) {
  try {
    return await fs.readFile(path.join(root, rel), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function readJsonFile(root, rel) {
  const text = await readText(root, rel);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CliError(`cannot parse ${rel}: ${e.message}`);
  }
}

export async function isDir(root, rel) {
  try {
    return (await fs.stat(path.join(root, rel))).isDirectory();
  } catch {
    return false;
  }
}

export async function headCommit(root) {
  try {
    return (await git(root, ['rev-parse', 'HEAD'])).trim();
  } catch {
    throw new CliError(`${root} is not a git repository with at least one commit.`);
  }
}

// The text of a blob, or null when the repository doesn't have it (an uncommitted version).
export async function blobText(root, hash) {
  try {
    return await git(root, ['cat-file', 'blob', hash]);
  } catch {
    return null;
  }
}

// Which of these files differ from HEAD (modified, staged or untracked).
export async function uncommitted(root, files) {
  if (!files.length) return new Set();
  const out = await git(root, ['status', '--porcelain', '-z', '-uall', '--', ...files]);
  const changed = new Set();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    if (p[0] === 'R' || p[0] === 'C') i++;
    changed.add(p.slice(3));
  }
  return new Set(files.filter((f) => changed.has(f)));
}

// Every .md/.mdx page under the section folder, skipping folders and files whose name starts with a dot.
export async function listPages(root, section) {
  const found = [];
  async function walk(rel) {
    let entries;
    try {
      entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(child);
      else if (/\.mdx?$/.test(e.name)) found.push(child);
    }
  }
  await walk(norm(section));
  return found.sort();
}

export const sectionFile = (ledgerOrSection, key) => `${norm(typeof ledgerOrSection === 'string' ? ledgerOrSection : ledgerOrSection.section)}/${FILES[key]}`;

export async function readLedger(root, section) {
  const ledger = await readJsonFile(root, sectionFile(section, 'ledger'));
  if (ledger === null) return null;
  if (ledger.schemaVersion !== SCHEMA_VERSION) throw new CliError(`${sectionFile(section, 'ledger')}: schemaVersion ${ledger.schemaVersion}, this script reads ${SCHEMA_VERSION}.`);
  return ledger;
}

export async function writeLedger(root, ledger) {
  const file = path.join(root, sectionFile(ledger, 'ledger'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(ledger, null, 2) + '\n');
  await fs.rename(tmp, file);
}

// Page id: the path relative to the pair's UA content root, without the extension.
export function pageId(ledger, file) {
  return norm(file).slice(dirOf(ledger.roots.ua).length).replace(/\.mdx?$/, '');
}

export function enPathOf(ledger, file) {
  return `${dirOf(ledger.roots.en)}${norm(file).slice(dirOf(ledger.roots.ua).length)}`;
}

// The text with every frontmatter `date:` value blanked: the translator's `last_update.date` bump is not an edit.
export function withoutDates(text) {
  const t = text.replace(/\r\n/g, '\n');
  if (!t.startsWith('---\n')) return t;
  const end = t.indexOf('\n---', 3);
  if (end === -1) return t;
  const fm = t.slice(0, end).replace(/^([ \t]*date[ \t]*:).*$/gm, '$1').replace(/(\bdate[ \t]*:)[ \t]*[^,}\n]+/g, '$1');
  return fm + t.slice(end);
}
