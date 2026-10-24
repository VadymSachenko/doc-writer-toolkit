// Mechanical assertions on one run's host repo and final output. No model judges anything here.
// Each check returns { pass, detail }. The types are listed in tools/harness/README.md.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const read = (host, rel) => fs.readFileSync(path.join(host, rel), 'utf8');
const has = (host, rel) => fs.existsSync(path.join(host, rel));

// `git status --porcelain` paths, renames reduced to their new path.
export function changedPaths(status) {
  return status.split('\n').filter(Boolean).map((l) => l.slice(3).split(' -> ').pop().replace(/^"|"$/g, ''));
}

// `key: value` frontmatter with the lint's scalar rules (tools/lint-plugin.mjs, copied in short), plus the nested
// maps and lists that page frontmatter uses, such as `last_update:` with an indented `date:`.
export function frontmatterProblem(text) {
  text = text.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return 'no frontmatter block';
  const end = text.indexOf('\n---', 3);
  if (end === -1) return 'frontmatter block is not closed';
  let parent = false;
  for (const raw of text.slice(4, end).split('\n')) {
    if (!raw.trim()) continue;
    const indented = /^\s/.test(raw);
    if (indented && !parent) return `indented line with no parent key: '${raw}'`;
    if (/^\s*(?:- )?[A-Za-z][\w-]*:$/.test(raw)) { parent = true; continue; }
    if (!indented) parent = false;
    const m = /^\s*(?:- )?([A-Za-z][\w-]*): (\S.*)$/.exec(raw) ?? (indented ? /^\s*- ()(\S.*)$/.exec(raw) : null);
    if (!m) return `not a key: value line: '${raw}'`;
    const value = m[2];
    if (value.startsWith("'") ? !/^'(?:[^']|'')*'$/.test(value) : value.startsWith('"') ? !/^"(?:[^"\\]|\\.)*"$/.test(value) : /: |\s#/.test(value)) {
      return `${m[1]}: value would not parse as a plain string`;
    }
  }
  return null;
}

// Markdown links to pages (not images, anchors, external URLs or asset files).
export function pageLinks(text) {
  const links = [];
  for (const m of text.matchAll(/(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[2];
    if (m[1] || /^(https?:|mailto:|#)/.test(target) || /\.(png|jpe?g|gif|svg|webp|pdf)(#.*)?$/i.test(target)) continue;
    links.push(target);
  }
  return links;
}

// The heading-id contract (context/doc-rules/project-rules/heading-anchors.md): every heading from `##` down
// ends with a unique `{/* #id */}`, and every `](#id)` link names one. `except` lists heading texts left as they were.
export function headingIdProblems(text, except = []) {
  const body = text.replace(/^```[\s\S]*?^```/gm, '');
  const ids = [];
  const problems = [];
  for (const [, heading] of body.matchAll(/^#{2,6} (.+)$/gm)) {
    const m = / \{\/\* #([a-z0-9]+(?:-[a-z0-9]+)*) \*\/\}$/.exec(heading);
    if (m) ids.push(m[1]);
    else if (!except.includes(heading.trim())) problems.push(`no id: '${heading}'`);
  }
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) problems.push(`repeated id: ${id}`);
  for (const [, id] of body.matchAll(/\]\(#([^)\s]+)\)/g)) if (!ids.includes(id)) problems.push(`link to a missing id: #${id}`);
  return problems;
}

const pages = (dir) => fs.readdirSync(dir, { recursive: true }).filter((f) => /\.mdx?$/.test(f)).map((f) => path.join(dir, f));

export function linkProblem(target, form) {
  if (form !== 'root-relative') return `unknown link form '${form}'`;
  const bare = target.split('#')[0];
  if (!bare.startsWith('/')) return 'not root-relative';
  if (/\.mdx?$/.test(bare)) return 'has a file extension';
  if (/(^|\/)\.\.?\//.test(bare)) return 'has ./ or ../';
  return null;
}

// a: the assertion; ctx: { host, output, status, skills } (skills: the run's Skill calls).
export function check(a, ctx) {
  const { host, output, status, skills = [] } = ctx;
  const text = () => (a.path === 'output' ? output : read(host, a.path));
  switch (a.type) {
    case 'exists': return { pass: has(host, a.path), detail: a.path };
    case 'absent': return { pass: !has(host, a.path), detail: a.path };
    case 'match':
    case 'no-match': {
      if (a.path !== 'output' && !has(host, a.path)) return { pass: false, detail: `${a.path} does not exist` };
      const found = new RegExp(a.pattern, a.flags ?? '').test(text());
      return { pass: a.type === 'match' ? found : !found, detail: `${a.path} ${found ? 'matches' : 'does not match'} /${a.pattern}/` };
    }
    case 'frontmatter': {
      if (!has(host, a.path)) return { pass: false, detail: `${a.path} does not exist` };
      const problem = frontmatterProblem(text());
      return { pass: !problem, detail: problem ?? 'parses' };
    }
    case 'links': {
      if (!has(host, a.path)) return { pass: false, detail: `${a.path} does not exist` };
      const bad = pageLinks(text()).map((t) => [t, linkProblem(t, a.form)]).filter(([, p]) => p);
      return { pass: !bad.length, detail: bad.length ? bad.map(([t, p]) => `${t}: ${p}`).join('; ') : `all ${a.form}` };
    }
    case 'diff-lines': {
      // Every line the run removed from the file comes back among the added lines (list numbers aside), or matches `allow`.
      const diff = spawnSync('git', ['diff', '-U0', '--', a.path], { cwd: host, encoding: 'utf8' }).stdout ?? '';
      const lines = diff.split('\n').filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+) /.test(l));
      const strip = (l) => l.slice(1).replace(/^(\s*)\d+\. /, '$1');
      const added = new Set(lines.filter((l) => l.startsWith('+')).map(strip));
      const allow = a.allow ? new RegExp(a.allow, a.flags ?? '') : null;
      const bad = lines.filter((l) => l.startsWith('-')).map(strip).filter((l) => !added.has(l) && !allow?.test(l));
      return { pass: !bad.length, detail: bad.length ? `changed outside what the brief names: ${bad.slice(0, 5).join(' | ')}` : 'every changed line is one the brief names' };
    }
    case 'skill-called':
    case 'skill-not-called': {
      // Matched on the skill's own name, whatever plugin prefix the call carried.
      const called = skills.some((s) => s.split(':').pop() === a.skill);
      return { pass: a.type === 'skill-called' ? called : !called, detail: `skills called: ${skills.join(', ') || 'none'}` };
    }
    case 'heading-ids': {
      if (!has(host, a.path)) return { pass: false, detail: `${a.path} does not exist` };
      const full = path.join(host, a.path);
      const files = fs.statSync(full).isDirectory() ? pages(full) : [full];
      if (!files.length) return { pass: false, detail: `no page under ${a.path}` };
      const bad = files.flatMap((f) => headingIdProblems(fs.readFileSync(f, 'utf8'), a.except).map((p) => `${path.relative(host, f)}: ${p}`));
      return { pass: !bad.length, detail: bad.length ? bad.join('; ') : `${files.length} page(s), every heading has its id` };
    }
    case 'unchanged': {
      const changed = changedPaths(status).filter((p) => !(a.ignore ?? []).some((i) => p.startsWith(i)));
      return { pass: !changed.length, detail: changed.length ? `changed: ${changed.join(', ')}` : 'no changes' };
    }
    case 'changed-only': {
      const outside = changedPaths(status).filter((p) => !a.paths.some((i) => p.startsWith(i)));
      return { pass: !outside.length, detail: outside.length ? `outside the allowed paths: ${outside.join(', ')}` : 'within the allowed paths' };
    }
    case 'command': {
      const run = spawnSync('sh', ['-c', a.run], { cwd: host, encoding: 'utf8', timeout: (a.timeoutSeconds ?? 600) * 1000 });
      const tail = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim().split('\n').slice(-3).join(' | ');
      return { pass: run.status === 0, detail: `exit ${run.status}${tail ? `: ${tail}` : ''}` };
    }
    default: return { pass: false, detail: `unknown assertion type '${a.type}'` };
  }
}

export const label = (a) => a.name ?? `${a.type}${a.path ? ` ${a.path}` : ''}${a.pattern ? ` /${a.pattern}/` : ''}`;
