import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CliError, exists, unique } from './util.mjs';

const CONFIG_HEADING = /^(#{1,6})\s+Documentation toolkit configuration\b/i;

// Reads the "Documentation toolkit configuration" bullets of <root>/CLAUDE.md as { 'field name (lowercase)': value }.
export async function loadClaudeConfig(root) {
  let text;
  try {
    text = await fs.readFile(path.join(root, 'CLAUDE.md'), 'utf8');
  } catch {
    return {};
  }
  const fields = {};
  let level = 0;
  for (const line of text.split('\n')) {
    const heading = line.match(/^(#{1,6})\s/);
    if (!level) {
      const m = line.match(CONFIG_HEADING);
      if (m) level = m[1].length;
      continue;
    }
    if (heading && heading[1].length <= level) break;
    const m = line.match(/^\s*[-*]\s+\*\*(.+?):\*\*\s*(.*)$/);
    if (!m) continue;
    const ticks = m[2].match(/`([^`]*)`/);
    fields[m[1].trim().toLowerCase()] = (ticks ? ticks[1] : m[2]).trim();
  }
  return fields;
}

// 'github owner/repo@branch dir/*.json'  |  'command <shell command containing {locale}>'
export function parseSource(spec) {
  const gh = spec.match(/^github\s+([^\s@/]+\/[^\s@]+)@(\S+)\s+(\S+)$/);
  if (gh) {
    const [, repo, branch, glob] = gh;
    const slash = glob.lastIndexOf('/');
    const dir = slash === -1 ? '' : glob.slice(0, slash);
    const filePattern = glob.slice(slash + 1);
    if (!dir || dir.includes('*')) {
      throw new CliError(`UI label source path must be <directory>/<file glob>, got '${glob}'`, { code: 2 });
    }
    const re = new RegExp('^' + filePattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
    return { type: 'github-json', repo, branch, dir, glob, fileRe: re };
  }
  const cmd = spec.match(/^command\s+(.+)$/);
  if (cmd) {
    if (!cmd[1].includes('{locale}')) {
      throw new CliError("A `command` UI label source must contain the placeholder {locale}", { code: 2 });
    }
    return { type: 'command', command: cmd[1] };
  }
  throw new CliError(
    `Cannot parse UI label source '${spec}'. Expected 'github <owner/repo>@<branch> <dir>/*.json' or 'command <shell command with {locale}>'.`,
    { code: 2 },
  );
}

export function parseLocaleFiles(spec) {
  const map = {};
  for (const part of (spec ?? '').split(/[,;]/)) {
    const m = part.trim().match(/^([\w-]+)\s*=\s*(.+)$/);
    if (m) map[m[1]] = m[2].trim();
  }
  return map;
}

function currentBranch(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// Ticket numbers = the leading numeric segments of the docs branch name ('1139-x-doc' -> 1139, '90-94-x' -> 90, 94).
export function ticketsFromBranch(branch) {
  const name = branch.split('/').pop();
  const m = name.match(/^((?:\d+-)*\d+)(?:-|$)/);
  return m ? m[1].split('-') : [];
}

export async function loadSettings(values) {
  const root = path.resolve(values.root ?? process.cwd());
  const claude = await loadClaudeConfig(root);
  const pick = (flag, field) => values[flag] ?? claude[field];

  const tickets = values.ticket ? values.ticket.split(',').map((t) => t.trim()).filter(Boolean) : ticketsFromBranch(currentBranch(root));
  const stateRoot = path.resolve(root, pick('state-root', 'toolkit state root') ?? '.doc-toolkit');

  return {
    root,
    claude,
    stateRoot,
    labelsDir: path.join(stateRoot, 'ui-labels'),
    sourceSpec: pick('source', 'ui label source'),
    localeFileOverrides: parseLocaleFiles(pick('locale-files', 'locale files')),
    explicitLocales: values.locales ? values.locales.split(',').map((l) => l.trim()).filter(Boolean) : null,
    docusaurusConfig: values['docusaurus-config'],
    uaRoot: pick('ua-root', 'ua content root'),
    enRoot: pick('en-root', 'en i18n root'),
    tickets,
  };
}

export function requireSource(settings) {
  if (!settings.sourceSpec) {
    throw new CliError(
      "No UI label source declared. Add `- **UI label source:** `github <owner/repo>@<branch> <dir>/*.json`` to the project's 'Documentation toolkit configuration' block, or pass --source.",
      { code: 2, data: { missing: ['UI label source'] } },
    );
  }
  return parseSource(settings.sourceSpec);
}

export function requireRoots(settings) {
  const missing = [];
  if (!settings.uaRoot) missing.push('UA content root');
  if (!settings.enRoot) missing.push('EN i18n root');
  if (missing.length) {
    throw new CliError(`Missing declaration(s): ${missing.join(', ')}. Declare them in CLAUDE.md or pass --ua-root / --en-root.`, {
      code: 2,
      data: { missing },
    });
  }
  return { ua: settings.uaRoot, en: settings.enRoot };
}

// i18n/en/docusaurus-plugin-content-docs/current/ -> i18n/tr/docusaurus-plugin-content-docs/current/
export function deriveLocaleRoot(enRoot, locale) {
  const parts = enRoot.split('/');
  const i = parts.indexOf('en');
  if (i === -1) {
    throw new CliError(`EN i18n root '${enRoot}' has no 'en' path segment to replace with '${locale}'.`, { code: 2 });
  }
  parts[i] = locale;
  return parts.join('/');
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

function braceBlock(text, from) {
  const open = text.indexOf('{', from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  return null;
}

async function readDocusaurusI18n(settings) {
  const candidates = settings.docusaurusConfig
    ? [path.resolve(settings.root, settings.docusaurusConfig)]
    : ['docusaurus.config.ts', 'docusaurus.config.js', 'docusaurus.config.mjs', 'docusaurus.config.cjs'].map((f) => path.join(settings.root, f));
  for (const file of candidates) {
    if (!(await exists(file))) continue;
    const text = stripComments(await fs.readFile(file, 'utf8'));
    const at = text.search(/\bi18n\s*:/);
    const block = at === -1 ? null : braceBlock(text, at);
    if (!block) throw new CliError(`No i18n block found in ${file}`, { code: 2 });
    const def = block.match(/defaultLocale\s*:\s*['"]([\w-]+)['"]/);
    const list = block.match(/\blocales\s*:\s*\[([^\]]*)\]/);
    if (!def || !list) throw new CliError(`Cannot read defaultLocale/locales from the i18n block in ${file}`, { code: 2 });
    return { defaultLocale: def[1], locales: [...list[1].matchAll(/['"]([\w-]+)['"]/g)].map((m) => m[1]) };
  }
  throw new CliError(`No docusaurus.config.{ts,js,mjs,cjs} found in ${settings.root}. Pass --locales or --docusaurus-config.`, { code: 2 });
}

// Target locales = configured i18n.locales minus the default locale and 'en'. Always returns the import set too.
export async function resolveLocales(settings) {
  let defaultLocale = 'uk';
  let targets;
  if (settings.explicitLocales) {
    targets = settings.explicitLocales;
  } else {
    const cfg = await readDocusaurusI18n(settings);
    defaultLocale = cfg.defaultLocale;
    targets = cfg.locales;
  }
  targets = unique(targets).filter((l) => l !== defaultLocale && l !== 'en');
  if (!targets.length) {
    throw new CliError('No target locales are configured yet: docusaurus.config.ts lists only the default locale and en.', { code: 2, data: { missing: ['target locales'] } });
  }
  return { defaultLocale, targets, all: unique([defaultLocale, 'en', ...targets]) };
}

const fileLang = (name) => name.replace(/\.json$/i, '').split(/[-_]/)[0].toLowerCase();

// Maps each docs locale to a locale file by language (es -> es-AR.json), or through the `Locale files:` overrides.
// A file named after another language's code (ar.json) is never matched to a different locale. Never guesses.
export function resolveLocaleFiles(locales, fileNames, overrides = {}, { tolerant = false } = {}) {
  const map = {};
  const unresolved = [];
  for (const locale of locales) {
    if (overrides[locale]) {
      const wanted = overrides[locale];
      const hit = fileNames.find((f) => f === wanted || f === `${wanted}.json`);
      if (hit) map[locale] = hit;
      else unresolved.push({ locale, reason: `'Locale files' maps it to '${wanted}', which does not exist`, candidates: fileNames });
      continue;
    }
    const lang = locale.split(/[-_]/)[0].toLowerCase();
    let hits = fileNames.filter((f) => fileLang(f) === lang);
    if (hits.length > 1) {
      const exact = hits.filter((f) => f.replace(/\.json$/i, '').toLowerCase() === locale.toLowerCase());
      if (exact.length === 1) hits = exact;
    }
    if (hits.length === 1) map[locale] = hits[0];
    else unresolved.push({ locale, reason: hits.length ? 'several files match this language' : 'no file has this language code', candidates: hits.length ? hits : fileNames });
  }
  const used = Object.entries(map);
  for (const [locale, file] of used) {
    const clash = used.find(([l, f]) => l !== locale && f === file);
    if (clash) throw new CliError(`Locale files: '${file}' is mapped to both '${locale}' and '${clash[0]}'.`, { code: 2 });
  }
  if (unresolved.length && !tolerant) {
    throw new CliError(
      `Cannot match locale file(s) for: ${unresolved.map((u) => u.locale).join(', ')}. Declare the mapping in 'Locale files:' (for example \`uk=ua\`, where \`ua\` is the file name without .json).`,
      { code: 2, data: { unresolved } },
    );
  }
  return { map, unresolved };
}

export function matchesTicket(branch, tickets) {
  return tickets.some((t) => new RegExp(`(^|/)${t}-`).test(branch));
}
