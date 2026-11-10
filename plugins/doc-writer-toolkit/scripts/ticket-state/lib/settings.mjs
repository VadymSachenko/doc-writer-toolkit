import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadClaudeConfig } from '../../ui-labels/lib/config.mjs';
import { deepMerge, localSettingsPath, readJsonFile, settingsFile, validateTracker } from '../../tracker/lib/settings.mjs';
import { validateForge } from '../../forge/lib/settings.mjs';
import { CliError } from './errors.mjs';
import { DEFAULT_KEEP } from './cleanup.mjs';
import { validateJobs } from './jobs.mjs';
import { DEFAULT_LABELS } from './pr-description.mjs';

// The ticket flow settings: the shared file the host commits (`.claude/ticket-flow.json`, or the `Ticket flow
// settings:` field of CLAUDE.md, or --settings), read at HEAD (`trustedShared`), and the owner's local file next to it
// (`<name>.local.json`), merged key by key at any depth (a local key wins), for the local file's keys only (`localOnly`).
// The tracker and forge scripts read the same files, as they stand and with no such limit.
//
// The shared file holds `state`, `workFolder`, `commentHeader`, `tracker`, `forge`, `targets`, `noReviewLabel`, `appRepos`, `hostRules`, `hostJobs`,
// `build`, and each role's tool rules (`roles.<role>.allowedTools`, `disallowedTools`).
// The local file holds `mode`, `limits`, `schedule`, `roles` (no tool rules), `modelLadder`, `video`, `cleanup` and `progress`. Defaults below.

export const MODES = ['off', 'observe', 'on'];
export const ROLES = ['triage', 'writer', 'reviewer', 'translator'];
export const SIZES = ['edit', 'newPage', 'newSection'];
export const START_ORDERS = ['priority', 'easiest'];

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
  },
  // The order a step that failed its gate climbs: one retry with the next model up, never down.
  modelLadder: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
  // `transcriber`: the name of the host's transcription adapter (none by default). The automatic try needs `browserProfile`.
  video: { transcriber: null, fallback: 'person', partMinutes: 30, partsPerDay: 3, browserProfile: null, transcriptHours: 2 },
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

// The code repos a session may read as evidence: { repo, url (its https address), base, path (the owner's clone, from
// the host root, optional: denied to every session) }. The runner clones each from `url` into the state folder once,
// fetches it before a writer's or a reviewer's session, and gives the session a read-only checkout at the fetched commit
// (`ensureCodeTree`, lib/worktree.mjs). The owner's clone is never touched.
function validateAppRepos(raw) {
  if (!Array.isArray(raw)) fail('appRepos must be a list of { repo, url, base, path }');
  return raw.map((r, i) => {
    if (!isObject(r)) fail(`appRepos[${i}] must be { repo, url, base, path }`);
    if (typeof r.repo !== 'string' || !/^[^/\\\s]+$/.test(r.repo) || r.repo === '.' || r.repo === '..') fail(`appRepos[${i}].repo must be the repo's plain name`);
    if (r.path !== undefined && (typeof r.path !== 'string' || !r.path.trim())) fail(`appRepos[${i}].path must be the owner's clone, from the host root`);
    if (typeof r.url !== 'string' || !/^https:\/\//.test(r.url)) fail(`appRepos[${i}].url is required: the repo's https address, which the runner clones it from`);
    return { repo: r.repo, path: r.path ?? null, base: typeof r.base === 'string' && r.base.trim() ? r.base : 'main', url: r.url.replace(/\/+$/, '') };
  });
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

  const mode = merged.mode ?? LOCAL_DEFAULTS.mode;
  if (!MODES.includes(mode)) fail(`mode must be one of ${MODES.join(', ')}`);
  const limits = deepMerge(LOCAL_DEFAULTS.limits, merged.limits ?? {});
  for (const k of ['inProgress', 'waiting', 'parallel', 'lockLeaseMinutes', 'triageBatch', 'stepsPerTicket', 'sessionsPerStageDay']) num(limits[k], `limits.${k}`, { min: 1 });
  num(limits.sessionPercent, 'limits.sessionPercent');
  num(limits.dailyPercent, 'limits.dailyPercent');
  if (limits.maxWeekPercent !== null) num(limits.maxWeekPercent, 'limits.maxWeekPercent');
  if (limits.open !== null) num(limits.open, 'limits.open', { min: 1 });
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
  const video = deepMerge(LOCAL_DEFAULTS.video, merged.video ?? {});
  num(video.partsPerDay, 'video.partsPerDay', { min: 1 });
  num(video.partMinutes, 'video.partMinutes', { min: 1 });

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
    appRepos: validateAppRepos(merged.appRepos ?? []),
    readyComment,
    reviewComment,
    idComments,
    triggerWords,
    reviewRounds,
    hostRules: merged.hostRules ?? {},
    hostJobs: validateJobs(merged.hostJobs ?? [], root),
    styleCheck,
    build,
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
  const rel = path.relative(root, path.resolve(root, file));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const run = spawnSync('git', ['-C', root, 'show', `HEAD:./${rel.split(path.sep).join('/')}`], { encoding: 'utf8', maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
  if (run.status !== 0) return null;
  try {
    return JSON.parse(run.stdout);
  } catch {
    return null;
  }
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
    forge: { kind: forge.kind, owner: forge.owner, self: forge.self, assignee: forge.assignee, checkLabel: forge.checkLabel, expertLabel: forge.expertLabel ?? null, readyLabel: forge.readyLabel ?? null, translatedLabel: forge.translatedLabel ?? null, repos: forge.repos, triggerWords: s.triggerWords ?? [], reviewRounds: s.reviewRounds ? true : false },
  };
}
