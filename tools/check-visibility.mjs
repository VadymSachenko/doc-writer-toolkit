#!/usr/bin/env node
// Checks that Claude Code loads every skill and command of the plugin with its description. No dependencies.
// Copies the plugin to a scratch folder under a sentinel name and reads `claude --plugin-dir <copy> plugin details
// <sentinel>`. The `Source: <sentinel>@inline` line proves the CLI read the tree under review, not an installed copy.
// A component fails when its always-on estimate is `< 20`, or under half of what its description's length predicts
// (about 4 characters a token): a description that doesn't parse loads as nothing.
// Exits 0 when all load, 1 when any doesn't, 2 when the check can't run (no `claude` CLI, or output it can't read).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PLUGIN = 'plugins/doc-writer-toolkit';
export const SENTINEL = 'visibility-sentinel';
const SKIP = new Set(['node_modules', '__pycache__', '.git']);

// The raw description of a skill or command file, read leniently (no YAML parser), with its quotes removed.
export function descriptionOf(text) {
  text = text.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return '';
  const end = text.indexOf('\n---', 3);
  const line = text.slice(4, end === -1 ? undefined : end).split('\n').find((l) => l.startsWith('description:'));
  if (!line) return '';
  const value = line.slice('description:'.length).trim();
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}

// `~1.6k` -> 1600, `~320` -> 320, `< 20` -> 0.
export function tokens(estimate) {
  if (estimate.startsWith('<')) return 0;
  const m = /^~([\d.,]+)(k?)$/.exec(estimate);
  if (!m) return NaN;
  return Number(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1);
}

// Reads the Source line and the per-component table of `plugin details`.
export function parseDetails(output) {
  const source = /^\s*Source:\s*(\S+)/m.exec(output)?.[1] ?? null;
  const components = new Map();
  const start = output.indexOf('Per-component');
  if (start !== -1) {
    for (const row of output.slice(start).split('\n').slice(2)) {
      const m = /^\s+(\S+)\s+(< 20|~[\d.,]+k?)\s+(< 20|~[\d.,]+k?)\s*$/.exec(row);
      if (!m) break;
      components.set(m[1], { alwaysOn: m[2] });
    }
  }
  return { source, components };
}

// expected: Map(name -> description). Returns findings as strings.
export function verdict({ source, components }, expected, sentinel = SENTINEL) {
  const findings = [];
  if (source !== `${sentinel}@inline`) findings.push(`Source is '${source}', not '${sentinel}@inline': the CLI did not read the copy under review`);
  for (const [name, description] of expected) {
    const row = components.get(name);
    if (!row) { findings.push(`${name}: not in the per-component table`); continue; }
    const got = tokens(row.alwaysOn);
    const predicted = Math.round(description.length / 4);
    if (row.alwaysOn.startsWith('<') || got < predicted / 2) {
      findings.push(`${name}: always-on ${row.alwaysOn} tokens, but its ${description.length}-character description predicts about ${predicted}; it loads without its description`);
    }
  }
  return findings;
}

export function expectedComponents(pluginDir) {
  const expected = new Map();
  for (const name of fs.readdirSync(path.join(pluginDir, 'skills')).sort()) {
    const file = path.join(pluginDir, 'skills', name, 'SKILL.md');
    if (fs.existsSync(file)) expected.set(name, descriptionOf(fs.readFileSync(file, 'utf8')));
  }
  for (const file of fs.readdirSync(path.join(pluginDir, 'commands')).filter((f) => f.endsWith('.md')).sort()) {
    expected.set(file.slice(0, -3), descriptionOf(fs.readFileSync(path.join(pluginDir, 'commands', file), 'utf8')));
  }
  return expected;
}

function copyUnderSentinel(pluginDir, sentinel) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'check-visibility-'));
  const copy = path.join(scratch, sentinel);
  fs.cpSync(pluginDir, copy, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) && !path.basename(src).startsWith('.venv') });
  const manifest = path.join(copy, '.claude-plugin', 'plugin.json');
  const json = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  fs.writeFileSync(manifest, JSON.stringify({ ...json, name: sentinel }, null, 2));
  return { scratch, copy };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pluginDir = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? path.join(root, PLUGIN));
  const claude = process.env.CLAUDE_BIN || 'claude';
  const { scratch, copy } = copyUnderSentinel(pluginDir, SENTINEL);
  try {
    const run = spawnSync(claude, ['--plugin-dir', copy, 'plugin', 'details', SENTINEL], { cwd: scratch, encoding: 'utf8' });
    if (run.error?.code === 'ENOENT') {
      console.error(`check-visibility: not run: '${claude}' not found`);
      process.exitCode = 2;
    } else {
      const details = parseDetails(`${run.stdout}\n${run.stderr}`);
      if (run.status !== 0 || !details.source || !details.components.size) {
        console.log(`${run.stdout}${run.stderr}`);
        console.error(`check-visibility: not run: \`plugin details\` exited ${run.status}, or its output has no Source line or component table`);
        process.exitCode = 2;
      } else {
        const expected = expectedComponents(pluginDir);
        const findings = verdict(details, expected);
        for (const f of findings) console.log(f);
        console.error(findings.length
          ? `check-visibility: ${findings.length} finding(s)`
          : `check-visibility: ok, ${expected.size} components loaded with their descriptions (Source: ${details.source})`);
        process.exitCode = findings.length ? 1 : 0;
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
