import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadClaudeConfig } from '../../ui-labels/lib/config.mjs';
import { deepMerge, localSettingsPath, readJsonFile, settingsFile, validateTracker } from '../../tracker/lib/settings.mjs';
import { validateForge } from '../../forge/lib/settings.mjs';
import { CliError } from './errors.mjs';
import { DEFAULT_KEEP } from './cleanup.mjs';
import { validateJobs } from './jobs.mjs';
import { DEFAULT_LABELS } from './pr-description.mjs';
import { TRANSCRIBERS } from '../../transcriber/lib/index.mjs';
import { CHECKS } from './gates.mjs';
import { DEFAULT_EXCLUDE, DEFAULT_TICKET_FILES } from './doc-evidence.mjs';
import { validateLearning } from './learn-settings.mjs';
import { validateCompanyRepos } from './company-repos.mjs';
import { validateFindingCard } from './findings.mjs';

// The ticket flow settings: the shared file the host commits (`.claude/ticket-flow.json`, or the `Ticket flow
// settings:` field of CLAUDE.md, or --settings), read at HEAD (`trustedShared`), and the owner's local file next to it
// (`<name>.local.json`), merged key by key at any depth (a local key wins), for the local file's keys only (`localOnly`).
// The tracker and forge scripts read the same files, as they stand and with no such limit.
//
// The shared file holds `state`, `workFolder`, `commentHeader`, `tracker`, `forge`, `targets`, `noReviewLabel`, `appRepos`, `relatedRepos`, `companyRepos`, `ticketCommits`, `docRepos`, `docEvidence`, `hostRules`, `hostJobs`,
// `build`, `checks`, `learning`, and each role's tool rules (`roles.<role>.allowedTools`, `disallowedTools`).
// The local file holds `mode`, `limits`, `schedule`, `roles` (no tool rules), `modelLadder`, `video`, `cleanup` and `progress`. Defaults below.

export const MODES = ['off', 'observe', 'on'];
export const ROLES = ['triage', 'writer', 'reviewer', 'translator', 'learner'];
export const SIZES = ['edit', 'newPage', 'newSection'];
export const START_ORDERS = ['priority', 'easiest'];

// The questions-first gates (lib/gates.mjs), each `true` to refuse a record that fails it. Off by default: records made
// before them (a question with no sources, a place with no page) would be refused. Read only from the shared file, so a
// session can't switch its own gate off.
export const CHECK_DEFAULTS = Object.fromEntries(CHECKS.map((k) => [k, false]));

// The comment on a PR entering the expert's review has no default: it is written to the team, in its language, so a host
// that sets none gets no comment and no text to send.
export const DEFAULT_REVIEW_COMMENT = null;

// The runner's line comments after a person's edit of an EN heading on a translated PR (`forge.idComments`, with the
// translated label only), which no model writes: `renamed`, a heading new in the PR whose UA id took the EN anchor;
// `kept`, a published heading whose id the EN heading keeps explicitly, with how to ask for the rename; `rename`, the
// reply in that thread that asks for it; `blocked`, a page whose ids the runner left as they are because a rename on it
// can't be made; `notRenamed`, the reply when a rename the owner asked for changes nothing. `<old>`, `<new>`, `<links>`,
// `<why>` and `<rename>` (the reply as the owner writes it, after the trigger word when the host has one) are filled in.
// A host writes them in the team's language.
export const DEFAULT_ID_COMMENTS = {
  renamed: 'This heading is new in this PR, so its id follows the EN heading: `#<old>` is now `#<new>` on the UA page and on every locale page, and <links> link(s) to it now use it.',
  kept: 'This heading is published with the id `#<old>`, so its links keep working: the EN heading keeps that id explicitly (`\\{#<old>}`). To rename it to `#<new>` instead, with every link to it rewritten, reply `<rename>`.',
  rename: 'rename id',
  blocked: 'The heading ids on this page are not changed: `#<old>` can\'t become `#<new>` (<why>). Change the EN heading so its anchor is free, or give it `\\{#<old>}`.',
  notRenamed: 'The id `#<old>` is not renamed: <why>.',
};

export const LOCAL_DEFAULTS = {
  mode: 'observe',
  limits: {
    inProgress: 3,
    waiting: 5,
    parallel: 3,
    dailyPercent: 10,
    maxWeekPercent: null,
    lockLeaseMinutes: 120,
    sessionPercent: 80,
    triageBatch: 10,
    stepsPerTicket: 12,
    sessionsPerStageDay: 3,
    estimates: {},
    // `open`: the most open tickets a scheduled run started, from planning to the final review, ready for merge included
    // (none: no limit).
    open: null,
    // `startOrder`: which ready group a scheduled run starts first: `priority` (then the oldest) or `easiest` (the
    // triage size, then fewer repos, then fewer pages, then priority).
    startOrder: 'priority',
    // `startHours`: the local hours in which the watcher may triage and start between morning runs, when a slot frees
    // (`HH-HH` or `HH:MM-HH:MM`, the end not included). Outside them it triages nothing and starts nothing.
    startHours: '10-22',
    // `usageGuard`: whether the runner reads `claude -p /usage` and holds scheduled model steps to the day's allowance.
    // Off (`false`): no reading at all, and no step waits for one; the allowance counts as unlimited.
    usageGuard: true,
  },
  // `tokenFile`: a file (mode 600) with the long-lived sign-in token the watcher's runs use; none: the CLI's own sign-in.
  // `forgeSeconds`: how often the forge check looks for comments on the pipeline's PRs between full checks (none: only
  // the full check, every `watchMinutes`). `commentQuietMinutes`: how long single comments on a PR stay quiet before
  // their session starts (a submitted review starts at once; lib/quiet.mjs). `expertQuietDays`: the working days (Monday
  // to Friday) a PR in the expert's review may go with no activity from the expert before the report lists it.
  schedule: { morning: '07:00', watchMinutes: 5, forgeSeconds: 60, commentQuietMinutes: 2, expertQuietDays: 2, tokenFile: null },
  roles: {
    triage: { model: 'claude-sonnet-5-5', effort: 'medium', maxTurns: 40 },
    writer: { model: 'claude-opus-5-5', effort: 'high', maxTurns: 200 },
    reviewer: { model: 'claude-sonnet-5-5', effort: 'high', maxTurns: 120 },
    translator: { model: 'claude-sonnet-5-5', effort: 'high', maxTurns: 120 },
    learner: { model: 'claude-opus-5-5', effort: 'high', maxTurns: 60 },
  },
  // The order a step that failed its gate climbs: one retry with the next model up, never down.
  modelLadder: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
  // `transcriber`: the transcription adapter (`turboscribe`; none by default) and `browserProfile`, the folder of its
  // persistent browser profile, outside every repo: the automatic try needs both, and with either unset the gate goes
  // straight to the person. `headless`: the browser with no window (a visible one by default: a sign-in and a bot check
  // pass more often there). `channel`: an installed browser instead of Playwright's Chromium (`chrome`). `fetchMinutes`:
  // how often an uploaded part's transcript is looked for; `transcriptHours`: how long after its upload it may take.
  // `extractMinutes`: the longest one command of the frame sweep may run (`videoExtract`: three per video).
  video: { transcriber: null, fallback: 'person', partMinutes: 30, partsPerDay: 3, browserProfile: null, transcriptHours: 2, headless: false, channel: null, fetchMinutes: 15, extractMinutes: 120 },
  // What the close step does with a merged ticket's recorded work files (D-074).
  cleanup: { mode: 'trash', keep: DEFAULT_KEEP, trashDir: null },
  // `stepsFile`: a file of the owner's own planned steps, shown as is at the end of the progress file (none: no block).
  progress: { stepsFile: null },
};

// The LaunchAgent's interval (s): `schedule.forgeSeconds` when it is shorter than the full check's `watchMinutes`, else
// `watchMinutes`, and every tick is a full check.
export function tickSecondsOf(settings) {
  const full = Math.round(settings.schedule.watchMinutes * 60);
  const forge = settings.schedule.forgeSeconds;
  return typeof forge === 'number' && forge < full ? Math.round(forge) : full;
}

// The statuses the ticket flow reads by name. Each must be a status of tracker.statuses.
export const REQUIRED_STATUSES = ['intake', 'ready', 'inProgress', 'blocked', 'finalReview', 'translation', 'done'];
export const FLOW_STATUSES = ['intake', 'ready', 'inProgress', 'blocked', 'smeReview', 'finalReview', 'translation', 'done', 'outOfScope'];

// `limits.startHours` as minutes of the local day, { from, to } (`to` not included; 24 is the day's end), or null when
// it isn't such a range.
export function parseStartHours(text) {
  const m = /^\s*([01]?\d|2[0-4])(?::([0-5]\d))?\s*-\s*([01]?\d|2[0-4])(?::([0-5]\d))?\s*$/.exec(typeof text === 'string' ? text : '');
  if (!m) return null;
  const from = Number(m[1]) * 60 + Number(m[2] ?? 0);
  const to = Number(m[3]) * 60 + Number(m[4] ?? 0);
  return from < to && to <= 24 * 60 ? { from, to } : null;
}

// The chain's site build, which the runner runs itself (no model) in the PR's worktree: the command (a list of words,
// or a text split on spaces; no shell), the folder it writes the site to (the visual pack reuses it), how long it may run
// and how long the runner waits for the build lock. A command the runner runs with its own rights, so it is read only
// from the shared file at HEAD, as the host jobs are: a local `build` is ignored.
export const BUILD_DEFAULTS = { command: ['npm', 'run', 'build'], outDir: 'build', timeoutMinutes: 60, waitMinutes: 90 };

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const fail = (msg) => {
  throw new CliError(`ticket flow settings: ${msg}`, { code: 2 });
};
const num = (v, where, { min = 0 } = {}) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) fail(`${where} must be a number ≥ ${min}`);
  return v;
};

// The video gate's settings. A part's start is the offset of its transcript, which the import reads in whole seconds
// only (`--transcript <file>@<seconds>`), so a part is a whole number of seconds long. The browser profile holds the
// owner's sign-in: an absolute folder outside the host repo, the state folder and every clone, so no session's rules
// reach it and no close step's cleanup removes it.
function validateVideo(video, { root, state, targets, appRepos }) {
  num(video.partsPerDay, 'video.partsPerDay', { min: 1 });
  num(video.partMinutes, 'video.partMinutes', { min: 1 });
  if (!Number.isInteger(Math.round(video.partMinutes * 60 * 1000) / 1000)) fail('video.partMinutes must make a whole number of seconds (30, or 0.5 of a minute)');
  num(video.transcriptHours, 'video.transcriptHours');
  num(video.fetchMinutes, 'video.fetchMinutes', { min: 1 });
  num(video.extractMinutes, 'video.extractMinutes', { min: 1 });
  if (video.transcriber !== null && !TRANSCRIBERS.includes(video.transcriber)) fail(`video.transcriber must be one of ${TRANSCRIBERS.join(', ')}, or null`);
  if (typeof video.headless !== 'boolean') fail('video.headless must be true or false');
  if (video.channel !== null && !['chrome', 'chrome-beta', 'msedge'].includes(video.channel)) fail('video.channel must be chrome, chrome-beta, msedge or null');
  if (video.browserProfile !== null) {
    if (typeof video.browserProfile !== 'string' || !video.browserProfile.trim()) fail('video.browserProfile must be a folder');
    const profile = path.resolve(video.browserProfile.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
    if (!path.isAbsolute(video.browserProfile.replace(/^~(?=\/|$)/, '/'))) fail('video.browserProfile must be an absolute folder (or start with ~/)');
    const inside = (dir) => dir && (profile === dir || profile.startsWith(dir + path.sep) || dir.startsWith(profile + path.sep));
    const clones = [...targets, ...appRepos].map((t) => (typeof t?.path === 'string' ? path.resolve(root, t.path) : null));
    if ([root, state, ...clones].some(inside)) fail('video.browserProfile must be outside the host repo, the state folder and every clone: it holds the sign-in');
    video.browserProfile = profile;
  }
  return video;
}

// The code repos a session may read as evidence: { repo, url (its https address), base, path (the owner's clone, from
// the host root, optional: denied to every session) }. The runner clones each from `url` into the state folder once,
// fetches it before a writer's or a reviewer's session, and gives the session a read-only checkout at the fetched commit
// (`ensureCodeTree`, lib/worktree.mjs). The owner's clone is never touched. `relatedRepos` has the same shape and gets
// the same checkouts: the org's other repos a ticket may read for evidence (frontends, widgets, proxies), where the
// caller or the implementation of what a claim names may be.
function validateAppRepos(raw, key = 'appRepos') {
  if (!Array.isArray(raw)) fail(`${key} must be a list of { repo, url, base, path }`);
  return raw.map((r, i) => {
    if (!isObject(r)) fail(`${key}[${i}] must be { repo, url, base, path }`);
    if (typeof r.repo !== 'string' || !/^[^/\\\s]+$/.test(r.repo) || r.repo === '.' || r.repo === '..') fail(`${key}[${i}].repo must be the repo's plain name`);
    if (r.path !== undefined && (typeof r.path !== 'string' || !r.path.trim())) fail(`${key}[${i}].path must be the owner's clone, from the host root`);
    if (typeof r.url !== 'string' || !/^https:\/\//.test(r.url)) fail(`${key}[${i}].url is required: the repo's https address, which the runner clones it from`);
    return { repo: r.repo, path: r.path ?? null, base: typeof r.base === 'string' && r.base.trim() ? r.base : 'main', url: r.url.replace(/\/+$/, '') };
  });
}

// The code repos and the related repos share the runner's clones by name (`<state>/code/<repo>.git`), so a name is in
// one list only, once.
function validateCodeRepos(merged) {
  const appRepos = validateAppRepos(merged.appRepos ?? []);
  const relatedRepos = validateAppRepos(merged.relatedRepos ?? [], 'relatedRepos');
  const seen = new Set();
  for (const r of [...appRepos, ...relatedRepos]) {
    if (seen.has(r.repo)) fail(`'${r.repo}' is named twice in appRepos and relatedRepos: a repo is in one list, once (the runner keeps one clone of it)`);
    seen.add(r.repo);
  }
  return { appRepos, relatedRepos };
}

// The ticket's commits (`ticketCommits`, lib/ticket-commits.mjs): the commits whose message names the ticket key, in
// each code repo's and related repo's history at the commit fetched for the session. `pattern` is a regular expression
// with `<key>` in it (the key goes in escaped), matched against the whole message, any case; none (the default) is the
// key as a whole word, which `feat-<key>`, `fix-<key>` and `#<key>` match too. `limit` is how many a repo gives, newest
// first.
export const TICKET_COMMITS_DEFAULTS = { pattern: null, limit: 20 };
function validateTicketCommits(raw) {
  if (raw === undefined || raw === null) return { ...TICKET_COMMITS_DEFAULTS };
  if (!isObject(raw)) fail('ticketCommits must be { "pattern", "limit" }');
  const t = { ...TICKET_COMMITS_DEFAULTS, ...raw };
  if (t.pattern !== null) {
    if (typeof t.pattern !== 'string' || !t.pattern.includes('<key>')) fail('ticketCommits.pattern must be a regular expression with <key> in it, such as "\\\\b(feat|fix)-<key>\\\\b"');
    try {
      new RegExp(t.pattern.split('<key>').join('1'), 'i');
    } catch (e) {
      fail(`ticketCommits.pattern is not a regular expression: ${e.message}`);
    }
  }
  if (!Number.isInteger(t.limit) || t.limit < 1 || t.limit > 100) fail('ticketCommits.limit must be a whole number from 1 to 100');
  return { pattern: t.pattern, limit: t.limit };
}

// The sibling doc repos whose published pages are searched as evidence (`docRepos`, lib/doc-evidence.mjs), besides the
// hub's own: { repo, path (the owner's clone, from the host root: read with `git grep` at `origin/<base>`, else HEAD,
// never its working tree, never written; the runner adds no folder or rule for it to a session, and the brief never
// names its path), base, roots (its root pairs from the repo's top:
// `{ "ua", "en" }`, `en` optional, or a root alone as a string; none: its CLAUDE.md's) }. None: the hub's pages and
// tickets only. A key the entry has no business having is refused, so a misspelt one isn't silently left out.
const relPath = (p) => typeof p === 'string' && p.trim() !== '' && !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..');
const DOC_REPO_KEYS = ['repo', 'path', 'base', 'roots'];
const cleanRel = (x) => x.replace(/^\.\/+/, '').replace(/\/+$/, '');
function validateDocRepos(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail('docRepos must be a list of { repo, path, base, roots }');
  const seen = new Set();
  return raw.map((r, i) => {
    if (!isObject(r)) fail(`docRepos[${i}] must be { repo, path, base, roots }`);
    const unknown = Object.keys(r).filter((k) => !DOC_REPO_KEYS.includes(k));
    if (unknown.length) fail(`docRepos[${i}].${unknown[0]} is not a setting (${DOC_REPO_KEYS.join(', ')})`);
    if (typeof r.repo !== 'string' || !/^[^/\\\s]+$/.test(r.repo) || r.repo === '.' || r.repo === '..') fail(`docRepos[${i}].repo must be the repo's plain name`);
    if (seen.has(r.repo)) fail(`docRepos names '${r.repo}' twice`);
    seen.add(r.repo);
    if (typeof r.path !== 'string' || !r.path.trim()) fail(`docRepos[${i}].path is required: the repo's clone, from the host root`);
    if (r.base !== undefined && (typeof r.base !== 'string' || !r.base.trim())) fail(`docRepos[${i}].base must be a branch name`);
    const rootBad = (x) => (typeof x === 'string' ? !relPath(x) : !isObject(x) || Object.keys(x).some((k) => k !== 'ua' && k !== 'en') || !relPath(x.ua) || (x.en !== undefined && x.en !== null && !relPath(x.en)));
    if (r.roots !== undefined && (!Array.isArray(r.roots) || !r.roots.length || r.roots.some(rootBad))) fail(`docRepos[${i}].roots must be a list of root pairs from the repo's top, such as { "ua": "docs/", "en": "i18n/en/docusaurus-plugin-content-docs/current/" }, or roots alone, such as "docs/"`);
    const roots = r.roots ? r.roots.map((x) => (typeof x === 'string' ? cleanRel(x) : { ua: cleanRel(x.ua), en: x.en ? cleanRel(x.en) : null })) : null;
    return { repo: r.repo, path: r.path, base: r.base ?? 'main', roots };
  });
}

// What the docs lookup leaves out and reads (`docEvidence`, lib/doc-evidence.mjs): `exclude`, what is never searched,
// added to the default (the release notes), never put in its place: a folder's name, or a path under a content root,
// left out under every content root of every doc repo (`excludeSpecs`); `ticketFiles`, the files of an earlier
// ticket's work folder that are searched (a name ending in `/` is a folder, read with what is under it).
export const DOC_EVIDENCE_DEFAULTS = { exclude: DEFAULT_EXCLUDE, ticketFiles: DEFAULT_TICKET_FILES };
function validateDocEvidence(raw) {
  if (raw === undefined || raw === null) return { exclude: [...DEFAULT_EXCLUDE], ticketFiles: [...DEFAULT_TICKET_FILES] };
  if (!isObject(raw)) fail('docEvidence must be { "exclude", "ticketFiles" }');
  const unknown = Object.keys(raw).filter((k) => !(k in DOC_EVIDENCE_DEFAULTS));
  if (unknown.length) fail(`docEvidence.${unknown[0]} is not a setting (exclude, ticketFiles)`);
  const list = (v, key, what) => {
    if (v === undefined) return [...DOC_EVIDENCE_DEFAULTS[key]];
    if (!Array.isArray(v) || v.some((x) => !relPath(x))) fail(`docEvidence.${key} must be a list of ${what}`);
    return v.map((x) => x.replace(/^\.\/+/, ''));
  };
  const exclude = [...new Set([...DEFAULT_EXCLUDE, ...list(raw.exclude, 'exclude', 'folder names or paths under a content root, such as "drafts/"')])];
  return { exclude, ticketFiles: list(raw.ticketFiles, 'ticketFiles', 'file names in a work folder, such as "app-notes.md" or "api/"') };
}

// The words an owner's PR comment starts with when it is for the pipeline (`forge.triggerWords`, D-142): `word:` at the
// start, any case. None (the default): every comment of the owner's is for the pipeline, as before.
function validateTriggerWords(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((w) => typeof w !== 'string' || !w.trim() || /[\s:]/.test(w.trim()))) fail('forge.triggerWords must be a list of words, each with no space or colon (a comment for the pipeline starts with "<word>:")');
  return raw.map((w) => w.trim());
}

// The review rounds (`forge.reviewRounds`, D-142): a round is two commits and one review with line comments, and the
// runner keeps the PR description's open questions, places and rounds from the ledger, settles the pipeline's own place
// threads and removes its own superseded summaries. `labels` are the words of the description's sections, in the team's
// language (lib/pr-description.mjs, `DEFAULT_LABELS`). Absent or false: the summary comments as before.
function validateReviewRounds(raw) {
  if (raw === undefined || raw === null || raw === false) return null;
  if (raw === true) raw = {};
  if (!isObject(raw)) fail('forge.reviewRounds must be { "labels": { … } } (or true for the default words)');
  const given = raw.labels ?? {};
  if (!isObject(given)) fail('forge.reviewRounds.labels must be an object of texts');
  const labels = deepMerge(DEFAULT_LABELS, given);
  for (const [k, v] of Object.entries(labels)) {
    if (k === 'readers' || k === 'stages') {
      if (!isObject(v) || Object.values(v).some((x) => typeof x !== 'string' || !x.trim())) fail(`forge.reviewRounds.labels.${k} must be { <key>: <text> }`);
    } else if (typeof v !== 'string' || !v.trim()) fail(`forge.reviewRounds.labels.${k} must be a text`);
  }
  return { labels };
}

// Keeping each pipeline PR up to date with its base (`forge.keepFresh`, D-113, D-127): from ready for merge on, the
// runner merges the base into the branch whenever the base moved, CI runs again, and a conflict goes back to a session.
// Absent or false: the branch is never touched for its base, as before.
function validateKeepFresh(raw) {
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== 'boolean') fail('forge.keepFresh must be true or false');
  return raw;
}

// The status marks on the comments a step takes (`forge.reactions`, `tracker.reactions`, TASK-095): the runner's own
// reactions around the session (lib/reactions.mjs). Absent or false: none, as before. On the forge the comments come
// from `take`, which only the trigger words give, and the pipeline's own reactions are `forge.self`'s: without either,
// `forge.reactions` would mark nothing, so it is refused. The tracker's own are its credentials' person's.
function validateReactions(merged, { triggerWords, self }) {
  const flag = (v, where) => {
    if (v === undefined || v === null) return false;
    if (typeof v !== 'boolean') fail(`${where} must be true or false`);
    return v;
  };
  const forge = flag(merged.forge?.reactions, 'forge.reactions');
  if (forge && !triggerWords.length) fail('forge.reactions needs forge.triggerWords: the marked comments are the ones a step takes, and only the trigger words give those');
  if (forge && !self) fail("forge.reactions needs forge.self: the pipeline's own reactions are that login's");
  return { forge, tracker: flag(merged.tracker?.reactions, 'tracker.reactions') };
}

function validateBuild(raw) {
  if (raw === undefined || raw === null) return { ...BUILD_DEFAULTS, command: [...BUILD_DEFAULTS.command] };
  if (!isObject(raw)) fail('build must be { command, outDir, timeoutMinutes, waitMinutes }');
  const b = { ...BUILD_DEFAULTS, ...raw };
  const command = typeof b.command === 'string' ? b.command.trim().split(/\s+/).filter(Boolean) : b.command;
  if (!Array.isArray(command) || !command.length || command.some((w) => typeof w !== 'string' || !w)) fail('build.command must be the build command, as a list of words ("npm", "run", "build") or a text of words with no quotes');
  if (typeof b.outDir !== 'string' || !b.outDir.trim() || path.isAbsolute(b.outDir) || b.outDir.split(/[\\/]/).includes('..')) fail('build.outDir must be the folder the build writes, from the repo top (such as "build")');
  num(b.timeoutMinutes, 'build.timeoutMinutes', { min: 1 });
  num(b.waitMinutes, 'build.waitMinutes');
  return { command, outDir: b.outDir.replace(/^\.\/+/, '').replace(/\/+$/, ''), timeoutMinutes: b.timeoutMinutes, waitMinutes: b.waitMinutes };
}

function validateTargets(raw, forge) {
  return forge.targets.map((t) => {
    const r = raw.find((x) => x.id === t.id) ?? {};
    if (!['places', 'sme'].includes(r.review)) fail(`targets '${t.id}'.review must be "places" or "sme"`);
    if (typeof r.uaRoot !== 'string' || !r.uaRoot.trim()) fail(`targets '${t.id}'.uaRoot is required (the UA content root in its repo)`);
    // The clone's untracked files the runner links into a ticket worktree (lib/worktree.mjs): names at the repo's top.
    const links = r.links ?? ['node_modules'];
    if (!Array.isArray(links) || links.some((n) => typeof n !== 'string' || !/^[^/\\]+$/.test(n) || n === '.' || n === '..' || n === '.git')) fail(`targets '${t.id}'.links must be a list of names at the repo's top, such as "node_modules" or ".env"`);
    return {
      id: t.id,
      repo: t.repo,
      review: r.review,
      reviewers: t.reviewers,
      // The people on the tracker added to the card when a person calls this target's expert review (lib/experts.mjs);
      // checked in validateTracker, and against the board's members with the lists.
      cardMembers: (r.cardMembers ?? []).map((n) => String(n).replace(/^@/, '').trim()),
      labels: t.labels,
      appLabel: typeof r.appLabel === 'string' && r.appLabel.trim() ? r.appLabel : null,
      path: typeof r.path === 'string' && r.path.trim() ? r.path : null,
      uaRoot: r.uaRoot.replace(/^\.\/+/, '').replace(/\/*$/, '/'),
      base: typeof r.base === 'string' && r.base.trim() ? r.base : 'main',
      links,
    };
  });
}

// Checks the merged settings and returns them with every default filled in. Nothing here reads the tracker or the forge.
export function validateSettings(merged, { root, stateRootDefault }) {
  if (!isObject(merged)) fail('the file is not a JSON object');
  // `commentHeader`: the line every comment the pipeline posts starts with, on the tracker and the forge alike (the two
  // modules put it in front; none: no header).
  const tracker = validateTracker(merged.tracker, merged.targets, merged.commentHeader);
  for (const s of REQUIRED_STATUSES) if (!(s in tracker.statuses)) fail(`tracker.statuses has no '${s}': the ticket flow reads it`);
  const forge = validateForge(merged.forge, merged.targets, merged.commentHeader);
  const targets = validateTargets(merged.targets ?? [], forge);
  if (targets.some((t) => t.review === 'sme') && !('smeReview' in tracker.statuses)) fail("a target has review 'sme', so tracker.statuses needs 'smeReview'");
  const rawTracker = merged.tracker;
  const docLabels = rawTracker.docLabels ?? [];
  if (!Array.isArray(docLabels) || docLabels.some((l) => typeof l !== 'string')) fail('tracker.docLabels must be a list of label names');
  const intake = {
    docLabels,
    quietHours: rawTracker.quietHours === undefined ? 2 : num(rawTracker.quietHours, 'tracker.quietHours'),
    triageMarker: typeof rawTracker.triageMarker === 'string' && rawTracker.triageMarker.trim() ? rawTracker.triageMarker : null,
    needsInfoLabel: tracker.labels.needsInfo ?? null,
  };
  // The card the runner files for a finding outside a ticket, and the comments that link it (lib/findings.mjs): a team
  // text, in the team's language, so it has no default: with none the runner files no card and the report lists it.
  const findingCard = validateFindingCard(rawTracker.findingCard, fail);
  // The comment on the card when the chain is done and it goes back to the final review status.
  const readyComment = typeof rawTracker.readyComment === 'string' && rawTracker.readyComment.trim() ? rawTracker.readyComment : 'Ready for merge';
  // The comment a PR gets each time it enters the expert's review (and the text the report gives to send a quiet
  // expert): `<files>` is the PR's Files changed link.
  const rawReview = merged.forge?.reviewComment;
  if (rawReview !== undefined && rawReview !== null && (typeof rawReview !== 'string' || !rawReview.includes('<files>'))) fail('forge.reviewComment must be a text with <files> in it (the PR\'s Files changed link)');
  const reviewComment = rawReview ?? DEFAULT_REVIEW_COMMENT;
  const triggerWords = validateTriggerWords(merged.forge?.triggerWords);
  const rawIds = merged.forge?.idComments;
  if (rawIds !== undefined && rawIds !== null && (!isObject(rawIds) || Object.entries(rawIds).some(([k, v]) => !(k in DEFAULT_ID_COMMENTS) || typeof v !== 'string' || !v.trim()))) fail(`forge.idComments must be { ${Object.keys(DEFAULT_ID_COMMENTS).join(', ')} }, each a text`);
  const idComments = { ...DEFAULT_ID_COMMENTS, ...(rawIds ?? {}) };
  const reviewRounds = validateReviewRounds(merged.forge?.reviewRounds);
  const keepFresh = validateKeepFresh(merged.forge?.keepFresh);
  const reactions = validateReactions(merged, { triggerWords, self: forge.self });

  const mode = merged.mode ?? LOCAL_DEFAULTS.mode;
  if (!MODES.includes(mode)) fail(`mode must be one of ${MODES.join(', ')}`);
  const limits = deepMerge(LOCAL_DEFAULTS.limits, merged.limits ?? {});
  for (const k of ['inProgress', 'waiting', 'parallel', 'lockLeaseMinutes', 'triageBatch', 'stepsPerTicket', 'sessionsPerStageDay']) num(limits[k], `limits.${k}`, { min: 1 });
  num(limits.sessionPercent, 'limits.sessionPercent');
  num(limits.dailyPercent, 'limits.dailyPercent');
  if (limits.maxWeekPercent !== null) num(limits.maxWeekPercent, 'limits.maxWeekPercent');
  if (limits.open !== null) num(limits.open, 'limits.open', { min: 1 });
  if (typeof limits.usageGuard !== 'boolean') fail('limits.usageGuard must be true or false');
  if (!parseStartHours(limits.startHours)) fail('limits.startHours must be local hours such as 10-22 or 09:30-21:00, the start before the end');
  if (!START_ORDERS.includes(limits.startOrder)) fail(`limits.startOrder must be one of ${START_ORDERS.join(', ')}`);
  if (!isObject(limits.estimates)) fail('limits.estimates must be { size: percent of the week }');
  for (const [size, v] of Object.entries(limits.estimates)) {
    if (!SIZES.includes(size)) fail(`limits.estimates.${size} is not a size (${SIZES.join(', ')})`);
    num(v, `limits.estimates.${size}`);
  }
  const roles = deepMerge(LOCAL_DEFAULTS.roles, merged.roles ?? {});
  for (const r of ROLES) {
    const role = roles[r];
    if (!isObject(role) || typeof role.model !== 'string' || !role.model) fail(`roles.${r}.model is required`);
    if (role.effort !== undefined && typeof role.effort !== 'string') fail(`roles.${r}.effort must be a string`);
    if (role.maxTurns !== undefined) num(role.maxTurns, `roles.${r}.maxTurns`, { min: 1 });
    if (role.maxBudgetUsd !== undefined) num(role.maxBudgetUsd, `roles.${r}.maxBudgetUsd`);
    for (const k of ['allowedTools', 'disallowedTools']) {
      if (role[k] !== undefined && (!Array.isArray(role[k]) || role[k].some((x) => typeof x !== 'string'))) fail(`roles.${r}.${k} must be a list of rules`);
    }
  }
  const modelLadder = merged.modelLadder ?? LOCAL_DEFAULTS.modelLadder;
  if (!Array.isArray(modelLadder) || modelLadder.some((m) => typeof m !== 'string')) fail('modelLadder must be a list of model names, cheapest first');
  const schedule = deepMerge(LOCAL_DEFAULTS.schedule, merged.schedule ?? {});
  if (typeof schedule.morning !== 'string' || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(schedule.morning)) fail('schedule.morning must be a time such as 07:00');
  num(schedule.watchMinutes, 'schedule.watchMinutes', { min: 1 });
  if (schedule.forgeSeconds !== null) num(schedule.forgeSeconds, 'schedule.forgeSeconds', { min: 30 });
  num(schedule.commentQuietMinutes, 'schedule.commentQuietMinutes');
  num(schedule.expertQuietDays, 'schedule.expertQuietDays', { min: 1 });
  if (schedule.tokenFile !== null && (typeof schedule.tokenFile !== 'string' || !schedule.tokenFile.trim())) fail('schedule.tokenFile must be a file path');
  const video = validateVideo(deepMerge(LOCAL_DEFAULTS.video, merged.video ?? {}), { root, state: path.resolve(root, typeof merged.state === 'string' && merged.state.trim() ? merged.state : stateRootDefault), targets: merged.targets ?? [], appRepos: [merged.appRepos, merged.relatedRepos].flatMap((l) => (Array.isArray(l) ? l : [])) });

  const cleanup = { ...LOCAL_DEFAULTS.cleanup, ...(merged.cleanup ?? {}) };
  if (!['trash', 'delete'].includes(cleanup.mode)) fail('cleanup.mode must be "trash" or "delete"');
  if (!Array.isArray(cleanup.keep) || cleanup.keep.some((g) => typeof g !== 'string' || !g.trim())) fail('cleanup.keep must be a list of globs');
  if (cleanup.trashDir !== null && (typeof cleanup.trashDir !== 'string' || !cleanup.trashDir.trim())) fail('cleanup.trashDir must be a folder');

  const progress = { ...LOCAL_DEFAULTS.progress, ...(merged.progress ?? {}) };
  if (progress.stepsFile !== null && (typeof progress.stepsFile !== 'string' || !progress.stepsFile.trim())) fail('progress.stepsFile must be a file path');

  // A ticket's work folder, from the host root: a role session may write there (lib/runner.mjs, `writableFor`).
  const workFolder = merged.workFolder ?? null;
  if (workFolder !== null && (typeof workFolder !== 'string' || !workFolder.includes('<key>') || path.isAbsolute(workFolder) || workFolder.split(/[\\/]/).includes('..'))) fail('workFolder must be a path from the host root with <key> in it, such as "work/tickets/<key>"');

  // The style check of hand commits (D-081, D-082) reads no commit made before `styleCheck.since` (an ISO date-time):
  // it is built for the PRs to come, not for what is already there (D-080). Absent: no cutoff.
  const styleCheck = { since: merged.styleCheck?.since ?? null };
  if (styleCheck.since !== null && (typeof styleCheck.since !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(styleCheck.since) || Number.isNaN(Date.parse(styleCheck.since)))) fail('styleCheck.since must be an ISO date-time with its zone, such as 2026-11-08T12:00:00Z');

  const build = validateBuild(merged.build);

  const rawChecks = merged.checks ?? {};
  if (!isObject(rawChecks)) fail(`checks must be { ${CHECKS.map((k) => `"${k}": true|false`).join(', ')} }`);
  for (const [k, v] of Object.entries(rawChecks)) {
    if (!CHECKS.includes(k)) fail(`checks.${k} is not a check (${CHECKS.join(', ')})`);
    if (typeof v !== 'boolean') fail(`checks.${k} must be true or false`);
  }
  const checks = { ...CHECK_DEFAULTS, ...rawChecks };

  const stateRel = typeof merged.state === 'string' && merged.state.trim() ? merged.state : stateRootDefault;
  return {
    root,
    state: path.resolve(root, stateRel),
    stateRel,
    workFolder,
    commentHeader: tracker.commentHeader,
    mode,
    tracker,
    intake,
    forge,
    targets,
    noReviewLabel: merged.noReviewLabel ?? null,
    ...validateCodeRepos(merged),
    // Every company repo the answer pass reads (lib/company-repos.mjs): unset, no answer pass, the flow as before.
    companyRepos: validateCompanyRepos(merged.companyRepos),
    ticketCommits: validateTicketCommits(merged.ticketCommits),
    docRepos: validateDocRepos(merged.docRepos),
    docEvidence: validateDocEvidence(merged.docEvidence),
    readyComment,
    findingCard,
    reviewComment,
    idComments,
    triggerWords,
    reviewRounds,
    keepFresh,
    reactions,
    hostRules: merged.hostRules ?? {},
    hostJobs: validateJobs(merged.hostJobs ?? [], root),
    styleCheck,
    // Learning from the owner's edits (TASK-054, lib/learn.mjs): shared file only, as it names a clone the runner pushes from.
    learning: validateLearning(merged.learning),
    build,
    checks,
    limits,
    schedule,
    roles,
    modelLadder,
    video,
    progress: { stepsFile: progress.stepsFile ? path.resolve(root, progress.stepsFile.replace(/^~(?=\/|$)/, process.env.HOME ?? '~')) : null },
    cleanup: { ...cleanup, trashDir: cleanup.trashDir ? path.resolve(root, cleanup.trashDir.replace(/^~(?=\/|$)/, process.env.HOME ?? '~')) : null },
  };
}

// The shared file as the host's repo has it at HEAD, or null when it isn't tracked there (no repo, a file outside it, a
// file never committed). A session can't move HEAD in the hub: its commits land only in a worktree, on a ticket branch.
export function sharedAtHead(root, file) {
  const text = textAt(root, file, 'HEAD');
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// A file's text at a commit of the host's repo, or null when it isn't tracked there.
function textAt(root, file, ref) {
  const rel = path.relative(root, path.resolve(root, file));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const run = spawnSync('git', ['-C', root, 'show', `${ref}:./${rel.split(path.sep).join('/')}`], { encoding: 'utf8', maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
  return run.status === 0 ? run.stdout : null;
}

// Whether the shared file at a commit (the hub's origin, before the watcher moves the hub to it: lib/hub-update.mjs)
// gives settings that hold, merged with the local file as `loadSettings` merges them. Null when they do (or when the
// file is tracked at neither HEAD nor that commit: the working file stays as it is), else why not.
export async function sharedProblemAt({ root, settings: flag, ref }) {
  try {
    const file = await settingsFile(root, flag);
    const rel = path.relative(root, file);
    const text = textAt(root, file, ref);
    if (text === null) return textAt(root, file, 'HEAD') === null ? null : `${rel} is not in it`;
    let shared;
    try {
      shared = JSON.parse(text);
    } catch (e) {
      return `${rel} is not JSON: ${e.message}`;
    }
    const { local: kept } = localOnly(readJsonFile(localSettingsPath(file), 'local settings file'));
    const claude = await loadClaudeConfig(root);
    validateSettings(deepMerge(shared, kept), { root, stateRootDefault: path.join(claude['toolkit state root'] || '.doc-toolkit/', 'ticket-flow/') });
    return null;
  } catch (e) {
    return String(e.message ?? e).split('\n')[0];
  }
}

// The state folder as the shared file names it, read without validating the rest: what the watcher looks at for the runs
// going on when the settings don't load (lib/hub-update.mjs `busy`). The working file, else the file at HEAD; the
// default when the one that parses names none. Null when neither parses: the folder can't be known, and a hand-on's
// locks may be elsewhere.
export async function stateFolderOf({ root, settings: flag }) {
  const claude = await loadClaudeConfig(root);
  const fallback = path.join(claude['toolkit state root'] || '.doc-toolkit/', 'ticket-flow/');
  const file = await settingsFile(root, flag);
  const parsed = (text) => {
    try {
      const raw = JSON.parse(text);
      return raw && typeof raw === 'object' ? raw : null;
    } catch {
      return null;
    }
  };
  let working = null;
  try {
    working = fs.readFileSync(file, 'utf8');
  } catch {
    /* no working file */
  }
  const raw = (working !== null ? parsed(working) : null) ?? (() => {
    const head = textAt(root, file, 'HEAD');
    return head !== null ? parsed(head) : null;
  })();
  if (!raw) return working === null && textAt(root, file, 'HEAD') === null ? path.resolve(root, fallback) : null;
  return path.resolve(root, typeof raw.state === 'string' && raw.state.trim() ? raw.state : fallback);
}

// What the local file may set: only its own keys, and of a role only what shapes the session's cost. A local file is
// git-ignored, so a session that got to write one would otherwise widen the next session's rules (`roles.*.allowedTools`,
// `workFolder`, `targets`, `state`, `hostJobs`).
export const LOCAL_KEYS = ['mode', 'limits', 'schedule', 'roles', 'modelLadder', 'video', 'cleanup', 'progress'];
const ROLE_RULE_KEYS = ['allowedTools', 'disallowedTools'];
export function localOnly(local) {
  const ignored = Object.keys(local ?? {}).filter((k) => k !== 'schemaVersion' && !LOCAL_KEYS.includes(k));
  const out = Object.fromEntries(Object.entries(local ?? {}).filter(([k]) => LOCAL_KEYS.includes(k)));
  if (isObject(out.roles)) out.roles = withoutRoleRules(out.roles, (r, k) => ignored.push(`roles.${r}.${k}`));
  return { local: out, ignored };
}
function withoutRoleRules(roles, onDrop = () => {}) {
  return Object.fromEntries(Object.entries(roles).map(([r, v]) => {
    if (!isObject(v)) return [r, v];
    for (const k of ROLE_RULE_KEYS) if (v[k] !== undefined) onDrop(r, k);
    return [r, Object.fromEntries(Object.entries(v).filter(([k]) => !ROLE_RULE_KEYS.includes(k)))];
  }));
}

// `shared`, the tracked file at HEAD where there is one, so an uncommitted edit counts for nothing, a session's above all.
// With none, the working file still gives the flow its settings, but no role's tool rules: nothing vouches for them.
export function trustedShared(root, file, working) {
  const head = sharedAtHead(root, file);
  if (head) return { shared: head, notes: JSON.stringify(head) === JSON.stringify(working) ? [] : [`${path.relative(root, file)} has uncommitted changes: they count once committed`] };
  const roles = isObject(working.roles) ? withoutRoleRules(working.roles) : undefined;
  return { shared: { ...working, ...(roles ? { roles } : {}) }, notes: [`${path.relative(root, file)} isn't tracked at HEAD: no role tool rules are read from it`] };
}

export async function loadSettings({ root, settings: flag }) {
  const file = await settingsFile(root, flag);
  const working = readJsonFile(file, 'settings file');
  if (!working) throw new CliError(`no settings file at ${file}. Declare 'Ticket flow settings:' in CLAUDE.md or pass --settings.`, { code: 2 });
  const { shared, notes } = trustedShared(root, file, working);
  const localFile = localSettingsPath(file);
  const local = readJsonFile(localFile, 'local settings file');
  const { local: kept, ignored } = localOnly(local);
  const claude = await loadClaudeConfig(root);
  const stateRootDefault = path.join(claude['toolkit state root'] || '.doc-toolkit/', 'ticket-flow/');
  const settings = validateSettings(deepMerge(shared, kept), { root, stateRootDefault });
  return { ...settings, file, localFile: local ? localFile : null, settingsNotes: [...notes, ...(ignored.length ? [`${path.relative(root, localFile)} sets ${ignored.join(', ')}: ignored, these are read only from the tracked file`] : [])] };
}

// What `config` prints: the merged values a skill reads, with the paths resolved. No credential value: only the names
// of the variables that hold them.
export function printable(s) {
  const { forge, tracker, ...rest } = s;
  return {
    ...rest,
    tracker: { ...tracker, credentials: { ...tracker.credentials } },
    forge: { kind: forge.kind, owner: forge.owner, self: forge.self, assignee: forge.assignee, checkLabel: forge.checkLabel, expertLabel: forge.expertLabel ?? null, readyLabel: forge.readyLabel ?? null, translatedLabel: forge.translatedLabel ?? null, wontMergeLabel: forge.wontMergeLabel ?? null, repos: forge.repos, triggerWords: s.triggerWords ?? [], reviewRounds: s.reviewRounds ? true : false, keepFresh: Boolean(s.keepFresh) },
  };
}
