import path from 'node:path';
import { loadClaudeConfig } from '../../ui-labels/lib/config.mjs';
import { CliError } from '../../ui-labels/lib/util.mjs';

// Each host setting: the field in the 'Documentation toolkit configuration' block, the flag that overrides it.
// A flag wins over the block. `required` fields stop the run with exit 2 when neither is given; every other field
// switches one measure to n/a (or takes its default) when it is absent.
export const FIELDS = [
  { key: 'branchPattern', flag: 'branch-pattern', field: 'pipeline branch pattern', name: 'Pipeline branch pattern', required: true, regex: true },
  { key: 'commitPattern', flag: 'commit-pattern', field: 'pipeline commit pattern', name: 'Pipeline commit pattern', required: true, regex: true },
  { key: 'draftPattern', flag: 'draft-pattern', field: 'draft commit pattern', name: 'Draft commit pattern', regex: true },
  { key: 'readyPattern', flag: 'ready-pattern', field: 'ready commit pattern', name: 'Ready commit pattern', regex: true },
  { key: 'smeList', flag: 'sme-list', field: 'sme review list', name: 'SME review list' },
  { key: 'questionsHeading', flag: 'questions-heading', field: 'open questions heading', name: 'Open questions heading', default: 'Open questions' },
  { key: 'reviewPolicy', flag: 'review', field: 'pipeline review policy', name: 'Pipeline review policy', default: 'sme' },
  { key: 'runLog', flag: 'run-log', field: 'run log', name: 'Run log' },
  { key: 'envFile', flag: 'env', field: 'credentials file', name: 'Credentials file', default: '.env' },
];

// The toolkit's own markers (see the writing skills): a line that adds or removes one is a marker line.
export const MARKER = /NEEDS CONFIRMATION|\{\/\*\s*ToDo/;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function compile(name, source) {
  try {
    return new RegExp(source);
  } catch (e) {
    throw new CliError(`${name} '${source}' is not a valid regular expression: ${e.message}`, { code: 2 });
  }
}

// Flags first, then the block of <root>/CLAUDE.md, read by the reader the other scripts share.
export async function loadSettings(values) {
  const root = path.resolve(values.root ?? process.cwd());
  const claude = await loadClaudeConfig(root);
  const s = { root, claude };
  const missing = [];
  for (const f of FIELDS) {
    const raw = values[f.flag] ?? claude[f.field] ?? f.default ?? null;
    if (raw === null || raw === '') {
      if (f.required) missing.push(f);
      s[f.key] = null;
      continue;
    }
    s[f.key] = f.regex ? compile(f.name, raw) : raw;
    if (f.regex) s[`${f.key}Source`] = raw;
  }
  if (missing.length) {
    throw new CliError(
      `Missing declaration(s): ${missing.map((f) => f.name).join(', ')}. Declare them in the 'Documentation toolkit configuration' block of CLAUDE.md or pass ${missing.map((f) => '--' + f.flag).join(', ')}.`,
      { code: 2, data: { missing: missing.map((f) => f.name) } },
    );
  }
  if (!['sme', 'places'].includes(s.reviewPolicy)) {
    throw new CliError(`Pipeline review policy '${s.reviewPolicy}' must be 'sme' or 'places'.`, { code: 2 });
  }
  for (const flag of ['from', 'to']) {
    if (!values[flag]) throw new CliError(`--${flag} <YYYY-MM-DD> is required.`, { code: 2 });
    if (!DAY.test(values[flag]) || Number.isNaN(Date.parse(values[flag]))) throw new CliError(`--${flag} must be a date as YYYY-MM-DD, got '${values[flag]}'.`, { code: 2 });
  }
  if (values.from > values.to) throw new CliError('--from is after --to.', { code: 2 });
  s.from = values.from;
  s.to = values.to;
  s.repo = values.repo ?? null;
  s.fetch = Boolean(values.fetch);
  s.redact = Boolean(values.redact);
  s.trelloOrigin = values['trello-origin'] ?? 'https://api.trello.com';
  return s;
}

// The window: [from 00:00 UTC, the day after `to` 00:00 UTC), as milliseconds.
export const windowOf = (s) => ({ start: Date.parse(`${s.from}T00:00:00Z`), end: Date.parse(`${s.to}T00:00:00Z`) + 86400000 });
