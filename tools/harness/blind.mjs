#!/usr/bin/env node
// Builds a blind side-by-side packet for a human read: for each case, run 1 of each label as X or Y, by a seeded
// coin flip. Each side holds output.md (the final answer) and diff.patch, with sentinel names and paths masked.
// The key goes to <packet>.key.json, beside the packet, so the packet alone doesn't say which side is which.
//   node tools/harness/blind.mjs <out dir> <label A> <label B> [--packet <dir>] [--seed <n>] [--run <n>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// mulberry32: a small seeded generator, so a packet can be rebuilt with the same assignment.
export function coin(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 < 0.5;
  };
}

// Hides what would give a side away: its sentinel, its label and its run folder.
export function mask(text, labels) {
  let t = text;
  for (const l of labels) t = t.replaceAll(`harness-${l}`, 'PLUGIN').replaceAll(`/${l}/`, '/LABEL/');
  return t.replace(/\/[^\s'"`]*\/run-\d+\/host\//g, '');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
  const [out, a, b] = args.filter((x, i) => !x.startsWith('--') && !args[i - 1]?.startsWith('--'));
  if (!b) {
    console.error('usage: node tools/harness/blind.mjs <out dir> <label A> <label B> [--packet <dir>] [--seed <n>] [--run <n>]');
    process.exit(2);
  }
  const packet = path.resolve(opt('--packet', path.join(out, `blind-${a}-${b}`)));
  const seed = Number(opt('--seed', String(Date.now() % 2 ** 31)));
  const run = `run-${opt('--run', '1')}`;
  const flip = coin(seed);
  fs.rmSync(packet, { recursive: true, force: true });
  const key = { seed, run, cases: {} };
  const cases = fs.readdirSync(path.join(out, a)).filter((c) => fs.existsSync(path.join(out, a, c, run)) && fs.existsSync(path.join(out, b, c, run)));
  for (const c of cases) {
    const [x, y] = flip() ? [a, b] : [b, a];
    key.cases[c] = { X: x, Y: y };
    for (const [side, l] of [['X', x], ['Y', y]]) {
      const src = path.join(out, l, c, run);
      const dst = path.join(packet, c, side);
      fs.mkdirSync(dst, { recursive: true });
      const result = JSON.parse(fs.readFileSync(path.join(src, 'result.json'), 'utf8'));
      fs.writeFileSync(path.join(dst, 'output.md'), `${mask(result.output, [a, b])}\n`);
      fs.writeFileSync(path.join(dst, 'diff.patch'), mask(fs.readFileSync(path.join(src, 'diff.patch'), 'utf8'), [a, b]));
    }
  }
  fs.writeFileSync(`${packet}.key.json`, `${JSON.stringify(key, null, 2)}\n`);
  console.log(`${packet}: ${cases.length} case(s); key in ${packet}.key.json`);
}
