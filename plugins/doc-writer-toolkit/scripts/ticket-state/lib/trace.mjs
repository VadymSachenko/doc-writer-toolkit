import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError } from './errors.mjs';
import { readLedger } from './ledger.mjs';
import { PR_STAGES, TICKET_STAGES } from './stages.mjs';

// `trace <key>`: what the sessions of one ticket did, stage by stage, read from the ledger's runs and the transcripts
// the CLI keeps (`<config dir>/projects/<slug>/<session>.jsonl`, and a session's subagents beside it). For a person
// reviewing a PR, to tell a session that went to the app from one that copied the ticket. No model, no network, nothing
// written. It prints actions and the texts a session wrote, never a tool's result or a Write's content: the private
// reasoning of the model is not in a transcript, and a result can hold any file or command output.

const CUT = { command: 200, reason: 160, text: 400, list: 400 };
const STAGES = new Set([...TICKET_STAGES, ...PR_STAGES]);
const WROTE = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);

// The folder name the CLI gives a session's start folder: every `/` and `.` is a `-`. The CLI may turn other
// characters into `-` as well, so that spelling is tried too, and the real path of the root beside the given one.
export const slugOf = (dir) => dir.replace(/[/.]/g, '-');
const slugsOf = (root) => {
  const dirs = [root];
  try {
    dirs.push(fs.realpathSync(root));
  } catch {
    /* the root is not on disk: its spelling alone */
  }
  return [...new Set(dirs.flatMap((d) => [slugOf(d), d.replace(/[^A-Za-z0-9]/g, '-')]))];
};

// The folders a transcript may be in, most likely first. `transcripts` stands for the project folder itself (tests).
export function transcriptDirs({ root, transcripts = null, env = process.env, home = os.homedir() }) {
  if (transcripts) return [path.resolve(transcripts)];
  const projects = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects');
  return slugsOf(root).map((s) => path.join(projects, s));
}

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : typeof c?.text === 'string' ? c.text : '')).join('\n');
  return '';
};

// One transcript: its tool calls in file order, each with the first line of its result when that came back `is_error`
// (`error` is null otherwise), and the last text block. A line that does not parse, a line of any other type and a
// block of an unknown shape are skipped.
export function readTranscript(file) {
  const actions = [];
  const byId = new Map();
  let lastText = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const blocks = Array.isArray(o?.message?.content) ? o.message.content : [];
    if (o?.type === 'assistant') {
      for (const b of blocks) {
        if (b?.type === 'tool_use' && typeof b.name === 'string') {
          if (b.id && byId.has(b.id)) continue;
          const a = { ts: o.timestamp ?? null, name: b.name, input: b.input && typeof b.input === 'object' ? b.input : {}, error: null };
          actions.push(a);
          if (b.id) byId.set(b.id, a);
        } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) lastText = b.text;
      }
    } else if (o?.type === 'user') {
      for (const b of blocks) {
        if (b?.type === 'tool_result' && b.is_error === true && byId.has(b.tool_use_id)) {
          byId.get(b.tool_use_id).error = textOf(b.content).replace(/^\s*<tool_use_error>\s*/, '').split('\n')[0].replace(/\s*<\/tool_use_error>\s*$/, '');
        }
      }
    }
  }
  return { actions, lastText };
}

// The kind of an action and what to say of it. Only the call's own arguments, never a result and never written content.
export function kindOf({ name, input }) {
  const s = (v) => (typeof v === 'string' ? v : '');
  if (name === 'Read') return { kind: 'read', what: s(input.file_path) };
  if (name === 'Grep' || name === 'Glob') return { kind: 'search', what: [s(input.pattern), s(input.path) && `in ${s(input.path)}`].filter(Boolean).join(' ') };
  if (name === 'Bash') return { kind: /playwright/i.test(s(input.command)) ? 'app' : 'ran', what: s(input.command) };
  if (name === 'Monitor') return { kind: 'ran', what: s(input.command) };
  if (WROTE.has(name)) return { kind: 'wrote', what: s(input.file_path) || s(input.notebook_path) || s(input.path) };
  if (name === 'Skill') return { kind: 'skill', what: s(input.skill) };
  if (name === 'Agent' || name === 'Task') return { kind: 'agent', what: s(input.description) };
  return { kind: 'other', what: name };
}

// A permission or hook refusal, from the first line of the result. Narrow on purpose, and anchored at the start: the
// operating system's own "Permission denied" and the output of a command that failed are plain failures.
const REFUSED = [
  /^Permission (?:to use|for this)\b.*\b(?:denied|refused)\b/i,
  /^File is in a directory that is denied by your permission settings/i,
  /^(?:PreToolUse|PermissionRequest)(?::[\w*.-]+)? hook\b/i,
  /^Hook (?:PreToolUse|PermissionRequest)\b/i,
  /^(?:Blocked|Denied) by (?:a |the |your )?(?:\w+ )?hook\b/i,
];
export const isRefusal = (line) => REFUSED.some((re) => re.test(line));

const SECRET = '[\\w.-]*(?:token|key|secret|password)[\\w.-]*';
const MASKS = [
  [new RegExp(`(\\b${SECRET})=("[^"]*"|'[^']*'|[^\\s"']+)`, 'gi'), '$1=***'],
  [new RegExp(`(--${SECRET})\\s+("[^"]*"|'[^']*'|(?!-)[^\\s"']+)`, 'gi'), '$1 ***'],
  [/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer ***'],
];
const OWN_FLAGS = /\s--(?:root|settings)(?:=\S+|\s+(?:"[^"]*"|'[^']*'|\S+))/g;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The one filter every printed string goes through: our own --root and --settings dropped, secrets masked (before the
// cut, so a cut never leaves half of one), the host root as `.` and each target's clone as its folder's name (the
// longer path first), spaces collapsed, then cut.
export function cleaner(settings) {
  const pairs = new Map();
  for (const t of settings.targets ?? []) if (t.path) pairs.set(path.resolve(settings.root, t.path), path.basename(path.resolve(settings.root, t.path)));
  pairs.set(settings.root, '.');
  const rules = [...pairs].sort((a, b) => b[0].length - a[0].length).map(([abs, name]) => [new RegExp(`${escape(abs)}(?![\\w-])`, 'g'), name]);
  return (text, limit) => {
    let t = String(text ?? '').replace(OWN_FLAGS, '');
    for (const [re, to] of MASKS) t = t.replace(re, to);
    for (const [re, to] of rules) t = t.replace(re, to);
    t = t.replace(/\s+/g, ' ').trim();
    return t.length > limit ? `${t.slice(0, limit)}…` : t;
  };
}

const two = (n) => String(n).padStart(2, '0');
const when = (v) => {
  const d = new Date(v ?? NaN);
  return Number.isNaN(d.getTime()) ? null : d;
};
const hms = (v) => {
  const d = when(v);
  return d ? `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}` : '--:--:--';
};
const stamp = (v) => {
  const d = when(v);
  return d ? `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${hms(d)}` : String(v ?? 'unknown');
};
const span = (ms) => {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${two(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${two(Math.floor((s % 3600) / 60))}m`;
};
const usd = (n) => `$${n.toFixed(2)}`;

// What the ledger plan holds, read defensively: pages are strings or { repo, path }, the live-check decision is a
// word, a flag or an object.
const pageName = (p) => (typeof p === 'string' ? p : p && typeof p.path === 'string' ? [p.repo, p.path].filter(Boolean).join(' ') : JSON.stringify(p));
const shown = (v) => (typeof v === 'boolean' ? (v ? 'yes' : 'no') : typeof v === 'string' ? v : JSON.stringify(v));

function listFiles(dir, limit = 40) {
  const out = [];
  const walk = (d, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length > limit) return;
      if (e.isDirectory()) walk(path.join(d, e.name), `${prefix}${e.name}/`);
      else out.push(`${prefix}${e.name}`);
    }
  };
  walk(dir, '');
  return out.length > limit ? [...out.slice(0, limit), '…'] : out;
}

// The lines of one transcript's actions, and its count line.
function describe(t, clean) {
  const n = { read: 0, search: 0, ran: 0, app: 0, wrote: 0, skill: 0, agent: 0, other: 0, refused: 0, failed: 0 };
  const lines = [];
  for (const a of t.actions) {
    const { kind, what } = kindOf(a);
    n[kind === 'app' ? 'ran' : kind] += 1;
    if (kind === 'app') n.app += 1;
    lines.push(`${hms(a.ts)} ${kind} ${clean(what, CUT.command)}`.trimEnd());
    if (a.error !== null) {
      if (isRefusal(a.error)) {
        n.refused += 1;
        lines.push(`${' '.repeat(9)}refused: ${clean(a.error, CUT.reason)}`);
      } else {
        n.failed += 1;
        lines.push(`${' '.repeat(9)}failed`);
      }
    }
  }
  return { n, lines };
}

export const countLine = (n) => [`read ${n.read}`, `searched ${n.search}`, `ran ${n.ran} (app ${n.app})`, `wrote ${n.wrote}`, `refused ${n.refused}`, `failed ${n.failed}`, ...['skill', 'agent', 'other'].filter((k) => n[k]).map((k) => `${k === 'skill' ? 'skills' : k === 'agent' ? 'agents' : 'other'} ${n[k]}`)].join(', ');

// The text of `trace`. `transcripts` replaces the project folder (tests); else the config dir is CLAUDE_CONFIG_DIR or
// ~/.claude.
export function renderTrace({ settings, key, stage = null, transcripts = null, env = process.env, home = os.homedir() }) {
  const ledger = readLedger(settings.state, key);
  if (!ledger) throw new CliError(`ticket ${key} has no ledger`, { code: 2 });
  const runs = (ledger.runs ?? []).map((r, i) => ({ r, i })).sort((a, b) => (a.r.seq ?? 0) - (b.r.seq ?? 0) || a.i - b.i).map((x) => x.r);
  if (stage !== null && !STAGES.has(stage) && !runs.some((r) => r.stage === stage)) throw new CliError(`unknown stage '${stage}'. Stages: ${[...STAGES].join(', ')}`, { code: 2 });
  const picked = stage === null ? runs : runs.filter((r) => r.stage === stage);
  const clean = cleaner(settings);
  const dirs = transcriptDirs({ root: settings.root, transcripts, env, home });

  const time = runs.reduce((s, r) => s + (typeof r.durationMs === 'number' ? r.durationMs : 0), 0);
  const cost = runs.reduce((s, r) => s + (typeof r.costUsd === 'number' ? r.costUsd * (typeof r.share === 'number' ? r.share : 1) : 0), 0);
  const out = [`Ticket ${key}`];
  if (ledger.card?.url) out.push(`Card: ${ledger.card.url}`);
  out.push(`Sessions: ${runs.length}${stage === null ? '' : `, ${picked.length} of stage ${stage} shown`}; total time ${span(time) ?? '0s'}; cost ${usd(cost)} (a shared session counts this ticket's share)`);
  const pages = ledger.plan?.pages;
  if (Array.isArray(pages) && pages.length) out.push(`Plan pages: ${clean(pages.map(pageName).join(', '), CUT.list)}`);
  if (ledger.plan && ledger.plan.liveCheck !== undefined && ledger.plan.liveCheck !== null) out.push(`Live check: ${clean(shown(ledger.plan.liveCheck), CUT.list)}`);
  if (settings.workFolder) {
    const rel = settings.workFolder.replaceAll('<key>', key);
    const files = listFiles(path.resolve(settings.root, rel));
    out.push(`Work folder ${clean(rel, CUT.command)}: ${files.length ? clean(files.join(', '), CUT.list) : 'no files'}`);
  }
  out.push("A transcript holds the actions and the texts a session wrote, not the model's private reasoning, so this shows those and nothing more.");

  if (stage !== null && !picked.length) out.push('', `No session of stage ${stage} in this ledger.`);
  for (const r of picked) {
    out.push('', `Run ${r.seq ?? '?'}: ${[r.stage, r.role, r.model, r.effort && `effort ${r.effort}`, r.trigger && `trigger ${r.trigger}`].filter(Boolean).join(', ')}`);
    const facts = [r.start && `start ${stamp(r.start)}`, span(r.durationMs), typeof r.turns === 'number' && `${r.turns} turns`, typeof r.costUsd === 'number' && `cost ${usd(r.costUsd)}`, r.outcome && `outcome ${r.outcome}`, r.pr && `PR ${r.pr}`, r.retryOf && `retry of ${r.retryOf}`, r.denials && `${r.denials} denied (the CLI's count)`].filter(Boolean);
    out.push(`  ${facts.join(', ')}`);
    const session = typeof r.session === 'string' && /^[\w.-]+$/.test(r.session) ? r.session : null;
    const base = session && dirs.find((d) => fs.existsSync(path.join(d, `${session}.jsonl`)));
    if (!base) {
      out.push(`  transcript not found${session ? '' : ' (no session recorded)'}`);
      continue;
    }
    out.push(`  session ${session}`);
    if (typeof r.share === 'number' && r.share > 0 && r.share < 1) out.push(`  shared by about ${Math.round(1 / r.share)} tickets: every action of the session is shown, not only this ticket's`);
    const main = readTranscript(path.join(base, `${session}.jsonl`));
    const subDir = path.join(base, session, 'subagents');
    let subFiles = [];
    try {
      subFiles = fs.readdirSync(subDir).filter((f) => f.endsWith('.jsonl')).sort();
    } catch {
      /* no subagents */
    }
    const subs = subFiles.map((f) => {
      const t = readTranscript(path.join(subDir, f));
      return { name: f.slice(0, -'.jsonl'.length), t, ...describe(t, clean) };
    });
    const mine = describe(main, clean);
    const total = { ...mine.n };
    for (const s of subs) for (const k of Object.keys(total)) total[k] += s.n[k];
    out.push(`  ${countLine(total)}${subs.length ? ` (the session and its ${subs.length} subagent(s) together)` : ''}`);
    for (const l of mine.lines) out.push(`  ${l}`);
    for (const s of subs) {
      out.push(`  subagent ${s.name}: ${countLine(s.n)}`);
      for (const l of s.lines) out.push(`    ${l}`);
      if (s.t.lastText) out.push(`    last text (subagent): ${clean(s.t.lastText, CUT.text)}`);
    }
    if (main.lastText) out.push(`  last text: ${clean(main.lastText, CUT.text)}`);
  }
  return out.join('\n') + '\n';
}
