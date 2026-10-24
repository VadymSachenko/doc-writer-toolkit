#!/usr/bin/env node
// Lints what the plugin ships, so Claude Code loads it the way the repo intends. No dependencies, Node >= 18.3.
//   a. Skill and command frontmatter is single-line `key: value` YAML that a strict parser accepts.
//      An unquoted `: ` inside a description makes Claude Code load the skill without one.
//   b. Every `${CLAUDE_PLUGIN_ROOT}/…` path named in the plugin's Markdown exists.
//   c. Every style-guide rule file is reachable from a row of its corpus's ROUTING.md (consumers load nothing else).
//      Gaps that exist today are listed in KNOWN_GAPS, each with the reason it's open.
//   d. No tracked text file has CRLF line endings.
// Prints `path:line: message` per finding and exits 1 when there is any. Known gaps print as `known (<reason>)`
// and don't fail the run; a listed gap that no longer occurs does, so the list can only shrink.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PLUGIN = 'plugins/doc-writer-toolkit';

// Index, meta and maintenance files that no routing row needs to name.
export const CORPORA = [
  {
    dir: `${PLUGIN}/context/microsoft-style-guide`,
    allow: [
      'AUTHORITY-AND-PRECEDENCE.md', 'COVERAGE.md', 'README.md', 'ROUTING.md', 'RULE-INDEX.md', 'SOURCE-MAP.md',
      'maintenance/', 'shared/INDEX.md', 'en-us/INDEX.md', 'uk-ua/INDEX.md',
      'en-us/terminology/INDEX.md', 'en-us/terminology/index/', 'en-us/terminology/a-z/',
    ],
  },
  {
    dir: `${PLUGIN}/context/google-developer-style-guide`,
    allow: ['AUTHORITY-AND-PRECEDENCE.md', 'README.md', 'ROUTING.md', 'RULE-INDEX.md', 'maintenance/', 'terminology/INDEX.md', 'terminology/a-z/'],
  },
];

// The repo is LF (.gitattributes); `--eol` is kept so older callers still work.
export const EOL_CHECK = true;

// Findings that exist on main today, with the reason each is open. Matched on file and message prefix. None are open.
export const KNOWN_GAPS = [];

const KEY_LINE =/^([A-Za-z][\w-]*): (\S.*)$/;
const SINGLE_QUOTED = /^'(?:[^']|'')*'$/;
const DOUBLE_QUOTED = /^"(?:[^"\\]|\\(?:[0abtnvfre "/\\N_LP]|x[\da-fA-F]{2}|u[\da-fA-F]{4}|U[\da-fA-F]{8}))*"$/;
const BAD_PLAIN_START = /^(?:[[\]{}>|*&!%@`#,]|[-?:](?:\s|$))/;
const BAD_PLAIN_INSIDE = /: |:$|\s#/;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_DESCRIPTION = 1024;

// Why a frontmatter value would not parse as the string we mean, or null when it is fine.
export function scalarProblem(value) {
  if (value.startsWith("'")) return SINGLE_QUOTED.test(value) ? null : "single-quoted value is not closed, or has an apostrophe not written as ''";
  if (value.startsWith('"')) return DOUBLE_QUOTED.test(value) ? null : 'double-quoted value is not closed, or has an invalid escape';
  if (BAD_PLAIN_START.test(value)) return `an unquoted value can't start with '${value.slice(0, 2).trim()}'; wrap it in single quotes`;
  if (BAD_PLAIN_INSIDE.test(value)) return "an unquoted value can't contain ': ' or ' #'; wrap it in single quotes and write an apostrophe as ''";
  return null;
}

export function decodeScalar(value) {
  if (value.startsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (value.startsWith('"')) return value.slice(1, -1).replace(/\\(.)/g, '$1');
  return value;
}

// Returns { fields: Map(key -> { value, line }), findings: [{ line, message }] }. Lines are 1-based file lines.
// CRLF files parse the same as LF ones: line endings are the EOL check's business, not this one's.
export function parseFrontmatter(text) {
  text = text.replace(/\r\n/g, '\n');
  const fields = new Map();
  const findings = [];
  if (!text.startsWith('---\n')) return { fields, findings: [{ line: 1, message: 'no frontmatter block (the file must start with ---)' }] };
  const end = text.indexOf('\n---', 3);
  if (end === -1 || !['\n', undefined].includes(text[end + 4])) return { fields, findings: [{ line: 1, message: 'frontmatter block is not closed with ---' }] };
  text.slice(4, end).split('\n').forEach((raw, i) => {
    const line = i + 2;
    if (!raw.trim()) return;
    const m = KEY_LINE.exec(raw);
    if (!m) return findings.push({ line, message: 'frontmatter lines must be single-line `key: value`' });
    const [, key, value] = m;
    if (fields.has(key)) findings.push({ line, message: `duplicate key '${key}'` });
    const problem = scalarProblem(value);
    if (problem) findings.push({ line, message: `${key}: ${problem}` });
    fields.set(key, { value, line });
  });
  return { fields, findings };
}

// kind: 'skill' (name must equal its folder) or 'command'.
export function checkFrontmatter(text, { kind, folder }) {
  const { fields, findings } = parseFrontmatter(text);
  if (findings.some((f) => f.line === 1)) return findings;
  if (kind === 'skill') {
    const name = fields.get('name');
    if (!name) findings.push({ line: 1, message: "missing 'name'" });
    else {
      const value = decodeScalar(name.value);
      if (!KEBAB.test(value)) findings.push({ line: name.line, message: `name '${value}' is not kebab-case` });
      else if (value !== folder) findings.push({ line: name.line, message: `name '${value}' differs from its folder '${folder}'` });
    }
  }
  const description = fields.get('description');
  if (!description) findings.push({ line: 1, message: "missing 'description'" });
  else {
    const length = decodeScalar(description.value).length;
    if (!length) findings.push({ line: description.line, message: 'description is empty' });
    if (length > MAX_DESCRIPTION) findings.push({ line: description.line, message: `description is ${length} characters, over ${MAX_DESCRIPTION}` });
  }
  return findings;
}

// `${CLAUDE_PLUGIN_ROOT}/…` paths in a Markdown text, without placeholders such as <slug>, {name} or *.md.
export function rootRefs(text) {
  const refs = [];
  for (const m of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}(\/[^\s`"'(),;|\]]*)/g)) {
    const ref = m[1].replace(/[.:]+$/, '');
    if (/[<>*{}$]|\.\.\.|…/.test(ref)) continue;
    refs.push({ ref, line: text.slice(0, m.index).split('\n').length });
  }
  return refs;
}

// Paths in backticks in the Load column of a ROUTING.md table, with their line numbers.
export function routedPaths(text) {
  const named = [];
  let previous = '';
  text.split('\n').forEach((row, i) => {
    const isRow = row.startsWith('|');
    const isHeader = isRow && !previous.startsWith('|');
    previous = row;
    if (!isRow || isHeader || /^\|[\s:|-]+$/.test(row)) return;
    const load = row.split('|')[2] ?? '';
    for (const m of load.matchAll(/`([^`]+)`/g)) named.push({ path: m[1], line: i + 1 });
  });
  return named;
}

const covers = (entry, file) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry);

export function isRouted(file, named, allow) {
  return named.some((n) => covers(n.path, file)) || allow.some((a) => covers(a, file));
}

function exists(abs, { dir }) {
  try {
    const stat = fs.statSync(abs);
    return dir ? stat.isDirectory() : true;
  } catch {
    return false;
  }
}

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// Splits findings into those that fail the run and those on the known list. A known gap with no finding fails.
export function applyKnownGaps(findings, known = KNOWN_GAPS) {
  const matches = (gap, f) => f.file === gap.file && f.message.startsWith(gap.message);
  const failing = findings.filter((f) => !known.some((gap) => matches(gap, f)));
  const listed = findings.filter((f) => known.some((gap) => matches(gap, f)))
    .map((f) => ({ ...f, reason: known.find((gap) => matches(gap, f)).reason }));
  for (const gap of known.filter((gap) => !findings.some((f) => matches(gap, f)))) {
    failing.push({ file: gap.file, line: 1, message: `known gap no longer occurs ('${gap.message}'); remove it from KNOWN_GAPS in tools/lint-plugin.mjs` });
  }
  return { failing: failing.sort(byPlace), known: listed };
}

const byPlace = (x, y) => x.file.localeCompare(y.file) || x.line - y.line;

export function lint(root, { eol = EOL_CHECK } = {}) {
  const findings = [];
  const add = (file, line, message) => findings.push({ file, line, message });
  const tracked = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

  // a. Frontmatter.
  for (const file of tracked) {
    const skill = file.match(new RegExp(`^${PLUGIN}/skills/([^/]+)/SKILL\\.md$`));
    const command = file.match(new RegExp(`^${PLUGIN}/commands/([^/]+)\\.md$`));
    if (!skill && !command) continue;
    const kind = skill ? 'skill' : 'command';
    for (const f of checkFrontmatter(read(file), { kind, folder: skill?.[1] })) add(file, f.line, f.message);
  }

  // b. Plugin-root paths.
  for (const file of tracked.filter((f) => f.startsWith(`${PLUGIN}/`) && f.endsWith('.md'))) {
    for (const { ref, line } of rootRefs(read(file))) {
      if (!exists(path.join(root, PLUGIN, ref), { dir: ref.endsWith('/') })) add(file, line, `\${CLAUDE_PLUGIN_ROOT}${ref} does not exist`);
    }
  }

  // c. Routing coverage.
  for (const corpus of CORPORA) {
    const routing = `${corpus.dir}/ROUTING.md`;
    const named = routedPaths(read(routing));
    for (const n of named) {
      if (!exists(path.join(root, corpus.dir, n.path), { dir: n.path.endsWith('/') })) add(routing, n.line, `names '${n.path}', which does not exist`);
    }
    for (const file of tracked.filter((f) => f.startsWith(`${corpus.dir}/`) && f.endsWith('.md'))) {
      const rel = file.slice(corpus.dir.length + 1);
      if (!isRouted(rel, named, corpus.allow)) add(file, 1, 'no ROUTING.md row reaches this rule file; add a row (or, for an index or meta file, an allowlist entry in tools/lint-plugin.mjs)');
    }
  }

  // d. Line endings, as stored in the index.
  if (eol) {
    for (const entry of git(root, ['ls-files', '--eol', '-z']).split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      if (/^i\/(crlf|mixed)\b/.test(entry.slice(0, tab))) add(entry.slice(tab + 1), 1, 'CRLF line endings; .gitattributes expects LF');
    }
  }

  return findings.sort(byPlace);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { failing, known } = applyKnownGaps(lint(root, { eol: EOL_CHECK || process.argv.includes('--eol') }));
  for (const f of known) console.log(`${f.file}:${f.line}: known (${f.reason}): ${f.message}`);
  for (const f of failing) console.log(`${f.file}:${f.line}: ${f.message}`);
  const tail = known.length ? `, ${known.length} known` : '';
  console.error(failing.length ? `lint-plugin: ${failing.length} finding(s)${tail}` : `lint-plugin: ok${tail}`);
  process.exitCode = failing.length ? 1 : 0;
}
