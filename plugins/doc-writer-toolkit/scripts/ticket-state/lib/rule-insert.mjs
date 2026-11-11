import fs from 'node:fs';
import path from 'node:path';
import { CliError } from './errors.mjs';

// A general rule from the owner's edits, added to an existing rule file of the toolkit in that file's own form
// (TASK-054, point 5, AC-3). No AI: the weekly session gives the rule's words; this module reads the file's form from the
// rules already in it and refuses words that don't fit it, so a rule never lands in a form the file doesn't use.
//
// Two forms are read:
// - `heading`: each rule is a heading of one level with a prefix and a number and a separator (`### Ж8 — Назва (English
//   name)`). The new rule takes the next free number, the same level, prefix and separator, and an English name in
//   brackets when the file's rules carry one. It goes after the last rule's section. When most rules hold a bold lead
//   line («**Джерела корпусу:**», «**Проєктне рішення…**»), the new one must hold it too. A checklist section after the
//   rules (a heading with «чекліст» or «checklist») takes the rule's check line; the first table above the rules (the
//   table of what lives where) takes `loadRow` when one is given.
// - `list`: the rules are the items of a numbered list whose items start with a bold name (`4. **Data stays.** …`).
//   The new rule is the next item, its later lines indented under it.
// Both: the rule's words are in the file's language (by script: Cyrillic or Latin prose), every cross-reference with
// the file's prefix (`(Ж1)`) names a rule the file has, and every `${CLAUDE_PLUGIN_ROOT}/…` path exists. A file with
// neither form is refused: the session picks another file by subject.

const H = /^(#{2,6}) (\p{L}{1,4})(\d+)([a-z]?) (—|–|-) (.+?)\s*$/u;
const LIST = /^(\d+)\. \*\*(.+?)\*\*/;

const fail = (m) => {
  throw new CliError(`rule-insert: ${m}`, { code: 1 });
};

// The prose of a text, code and quoted names left out, and its script: `uk` when most letters are Cyrillic.
export function scriptOf(text) {
  const prose = String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/«[^»\n]*»/g, ' ')
    .replace(/"[^"\n]*"/g, ' ')
    .replace(/\([A-Za-z][^()]*\)/g, ' ');
  const cyr = (prose.match(/\p{Script=Cyrillic}/gu) ?? []).length;
  const lat = (prose.match(/\p{Script=Latin}/gu) ?? []).length;
  if (cyr + lat < 20) return null;
  return cyr > lat ? 'uk' : 'en';
}

const headingLevel = (line) => /^(#{1,6})\s/.exec(line)?.[1].length ?? null;

// The end (exclusive line index) of the section a heading at `i` opens.
function sectionEnd(lines, i) {
  const level = headingLevel(lines[i]);
  let fence = false;
  for (let j = i + 1; j < lines.length; j++) {
    if (/^\s*(```|~~~)/.test(lines[j])) fence = !fence;
    if (fence) continue;
    const l = headingLevel(lines[j]);
    if (l !== null && l <= level) return j;
  }
  return lines.length;
}

// The file's rule form, or null.
export function formOf(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let fence = false;
  const heads = [];
  const items = [];
  // A list counts only under a heading that names the rules («The rules», «Правила»).
  let underRules = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) return;
    if (headingLevel(line) !== null) underRules = /\brules?\b|правил/i.test(line);
    const h = H.exec(line);
    if (h) heads.push({ i, level: h[1].length, prefix: h[2], n: Number(h[3]), sub: h[4], sep: h[5], title: h[6] });
    const m = LIST.exec(line);
    if (m && underRules) items.push({ i, n: Number(m[1]), name: m[2] });
  });
  const groups = new Map();
  for (const h of heads) {
    const k = `${h.level}|${h.prefix}|${h.sep}`;
    groups.set(k, [...(groups.get(k) ?? []), h]);
  }
  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0];
  if (best && best.length >= 2) {
    const english = best.filter((h) => /\([^()]*[A-Za-z][^()]*\)$/.test(h.title)).length * 2 >= best.length;
    return { form: 'heading', lines, rules: best, level: best[0].level, prefix: best[0].prefix, sep: best[0].sep, english };
  }
  // A run of list items numbered 1, 2, … with a bold name, the longest one.
  const runs = [];
  for (const it of items) {
    const run = runs.at(-1);
    if (run && it.n === run.at(-1).n + 1) run.push(it);
    else if (it.n === 1) runs.push([it]);
  }
  const list = runs.sort((a, b) => b.length - a.length)[0];
  if (list && list.length >= 2) return { form: 'list', lines, rules: list, dotted: list.filter((x) => /[.:]$/.test(x.name)).length * 2 >= list.length };
  return null;
}

// The bold lead lines most of the rules hold (their first two words, lower case): the parts each rule has.
function partsOf(f) {
  const count = new Map();
  for (const r of f.rules) {
    const seen = new Set();
    for (const line of f.lines.slice(r.i + 1, sectionEnd(f.lines, r.i))) {
      const m = /^\*\*([^*]+?)\*\*/.exec(line);
      if (m) seen.add(m[1].toLowerCase().replace(/[:.]+$/, '').split(/\s+/).slice(0, 2).join(' '));
    }
    for (const k of seen) count.set(k, (count.get(k) ?? 0) + 1);
  }
  return [...count].filter(([, n]) => n * 2 > f.rules.length).map(([k]) => k);
}

function checkWords(f, rule, { language, pluginRoot }) {
  const words = [rule.name, rule.body, rule.check ?? ''].join('\n');
  const want = language ?? scriptOf(f.lines.join('\n'));
  const got = scriptOf([rule.name, rule.body].join('\n'));
  if (want && got && want !== got) fail(`the rule is written in ${got === 'uk' ? 'Ukrainian' : 'English'}, the file in ${want === 'uk' ? 'Ukrainian' : 'English'}`);
  if (f.form === 'heading') {
    const have = new Set(f.rules.map((r) => `${r.n}${r.sub}`));
    const next = `${Math.max(...f.rules.map((r) => r.n)) + 1}`;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${f.prefix}(\\d+[a-z]?)(?![\\p{L}\\p{N}])`, 'gu');
    for (const m of words.matchAll(re)) if (!have.has(m[1]) && m[1] !== next) fail(`the rule refers to ${f.prefix}${m[1]}, which the file has no rule for`);
  }
  for (const m of words.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s`)»"',;]+)/g)) {
    const rel = m[1].replace(/[.:]+$/, '');
    if (pluginRoot && !fs.existsSync(path.join(pluginRoot, rel))) fail(`the rule names \${CLAUDE_PLUGIN_ROOT}/${rel}, which doesn't exist`);
  }
}

// The file's text with the rule added: { text, number, heading }. `rule`: { name, english?, body, check?, loadRow? }.
// `marker`: an HTML comment (`<!-- learned:<id> -->`) on the line after the heading (at the end of a list item's first
// line), by which the runner later finds the rule whatever its heading reads.
export function insertRule(text, rule, { language = null, pluginRoot = null, marker = null } = {}) {
  const f = formOf(text);
  if (!f) fail('the file has no numbered rules this tool can extend (headings like `### Ж1 — …`, or a list like `1. **…** …`): pick another file by subject');
  if (typeof rule?.name !== 'string' || !rule.name.trim() || typeof rule.body !== 'string' || !rule.body.trim()) fail('the rule needs "name" and "body"');
  checkWords(f, rule, { language, pluginRoot });
  const lines = [...f.lines];
  const number = Math.max(...f.rules.map((r) => r.n)) + 1;
  if (f.form === 'list') {
    const last = f.rules.at(-1);
    let end = last.i + 1;
    while (end < lines.length && (lines[end].trim() === '' || /^\s{2,}/.test(lines[end]))) end++;
    while (end > last.i + 1 && lines[end - 1].trim() === '') end--;
    const name = f.dotted && !/[.:]$/.test(rule.name.trim()) ? `${rule.name.trim()}.` : rule.name.trim();
    const [first, ...rest] = rule.body.trim().split('\n');
    const item = [`${number}. **${name}** ${first}${marker ? ` ${marker}` : ''}`, ...rest.map((l) => (l.trim() ? `   ${l}` : ''))];
    lines.splice(end, 0, ...item);
    return { text: lines.join('\n'), number, heading: `${number}. **${name}**`, form: 'list' };
  }
  if (f.english && !(typeof rule.english === 'string' && rule.english.trim())) fail("the file's rules carry an English name in brackets: give \"english\"");
  const heading = `${'#'.repeat(f.level)} ${f.prefix}${number} ${f.sep} ${rule.name.trim()}${f.english ? ` (${rule.english.trim()})` : ''}`;
  const missing = partsOf(f).filter((k) => !new RegExp(`^\\*\\*${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')}`, 'imu').test(rule.body));
  if (missing.length) fail(`most of the file's rules hold ${missing.map((k) => `«**${k}…**»`).join(' and ')}: the rule's body needs ${missing.length > 1 ? 'them' : 'it'} too`);
  const at = sectionEnd(lines, f.rules.at(-1).i);
  // The checklist after the rules, within their parent section, takes the rule's check line.
  const parentEnd = (() => {
    for (let j = at; j < lines.length; j++) {
      const l = headingLevel(lines[j]);
      if (l !== null && l < f.level) return j;
    }
    return lines.length;
  })();
  const checklist = lines.slice(at, parentEnd).findIndex((l) => headingLevel(l) === f.level && /чекліст|checklist/i.test(l));
  if (checklist >= 0 && !(typeof rule.check === 'string' && rule.check.trim())) fail('the file has a checklist after its rules: give "check", the rule\'s line in it');
  const block = [heading, ...(marker ? [marker] : []), '', ...rule.body.trim().split('\n'), ''];
  // The load table: the first table above the rules.
  let tableAt = null;
  if (rule.loadRow) {
    if (!Array.isArray(rule.loadRow) || rule.loadRow.some((c) => typeof c !== 'string' || !c.trim() || c.includes('|'))) fail('"loadRow" is a list of cell texts, none with a "|"');
    const first = f.rules[0].i;
    const start = lines.slice(0, first).findIndex((l) => /^\|/.test(l));
    if (start < 0) fail('the file has no table above its rules for "loadRow"');
    let end = start;
    while (end + 1 < first && /^\|/.test(lines[end + 1])) end++;
    const cols = lines[start].split('|').length - 2;
    if (cols !== rule.loadRow.length) fail(`the table above the rules has ${cols} columns, "loadRow" ${rule.loadRow.length}`);
    tableAt = end + 1;
  }
  if (checklist >= 0) {
    const cs = at + checklist;
    let last = -1;
    for (let j = cs + 1; j < sectionEnd(lines, cs); j++) if (/^- \[ \]/.test(lines[j])) last = j;
    if (last < 0) fail('the checklist after the rules has no `- [ ]` line to follow');
    // The line names its rule as the line before it does: «… (Ж3)?» before it gives «… (Ж11)?».
    let check = rule.check.trim();
    const ref = new RegExp(`\\((?:${f.prefix}\\d+[a-z]?(?:,\\s*)?)+\\)\\??$`, 'u');
    const own = new RegExp(`(?<![\\p{L}\\p{N}])${f.prefix}${number}(?![\\p{L}\\p{N}])`, 'u');
    if (ref.test(lines[last]) && !own.test(check)) {
      const q = check.endsWith('?') || lines[last].endsWith('?') ? '?' : '';
      check = `${check.replace(/\?$/u, '')} (${f.prefix}${number})${q}`;
    }
    lines.splice(last + 1, 0, `- [ ] ${check}`);
  }
  lines.splice(at, 0, ...block);
  if (tableAt !== null) lines.splice(tableAt, 0, `| ${rule.loadRow.map((c) => c.trim()).join(' | ')} |`);
  return { text: lines.join('\n'), number, heading, form: 'heading' };
}

// The rule files a general rule may go into: the toolkit's own rule files, never a distilled corpus (no taste rule goes
// there, point 6) and never a new file. Paths from the plugin root.
export const CORPORA = ['context/google-developer-style-guide/', 'context/microsoft-style-guide/', 'context/doc-rules/ua-grammar/'];
export function ruleFiles(pluginRoot) {
  const dir = path.join(pluginRoot, 'context', 'doc-rules', 'project-rules');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {
    /* none */
  }
  return names.sort().flatMap((n) => {
    const rel = `context/doc-rules/project-rules/${n}`;
    const text = fs.readFileSync(path.join(pluginRoot, rel), 'utf8');
    const f = formOf(text);
    return f ? [{ file: rel, language: scriptOf(text), form: f.form, rules: f.rules.length, next: Math.max(...f.rules.map((r) => r.n)) + 1 }] : [];
  });
}
