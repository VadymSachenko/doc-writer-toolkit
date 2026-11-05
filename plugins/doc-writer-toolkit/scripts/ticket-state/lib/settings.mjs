import path from 'node:path';
import { loadClaudeConfig } from '../../ui-labels/lib/config.mjs';
import { deepMerge, localSettingsPath, readJsonFile, settingsFile, validateTracker } from '../../tracker/lib/settings.mjs';
import { validateForge } from '../../forge/lib/settings.mjs';
import { CliError } from './errors.mjs';
import { DEFAULT_KEEP } from './cleanup.mjs';
import { validateJobs } from './jobs.mjs';

// The ticket flow settings: the shared file the host commits (`.claude/ticket-flow.json`, or the `Ticket flow
// settings:` field of CLAUDE.md, or --settings) and the owner's local file next to it (`<name>.local.json`), merged key
// by key at any depth (a local key wins). The tracker and forge scripts read the same files the same way.
//
// The shared file holds `state`, `tracker`, `forge`, `targets`, `noReviewLabel`, `appRepos`, `hostRules`, `hostJobs`.
// The local file holds `mode`, `limits`, `schedule`, `roles`, `modelLadder`, `video` and `cleanup`. Defaults below.

export const MODES = ['off', 'observe', 'on'];
export const ROLES = ['triage', 'writer', 'reviewer', 'translator'];
export const SIZES = ['edit', 'newPage', 'newSection'];

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
  },
  // `tokenFile`: a file (mode 600) with the long-lived sign-in token the watcher's runs use; none: the CLI's own sign-in.
  schedule: { morning: '07:00', watchMinutes: 5, tokenFile: null },
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
};

// The statuses the ticket flow reads by name. Each must be a status of tracker.statuses.
export const REQUIRED_STATUSES = ['intake', 'ready', 'inProgress', 'blocked', 'finalReview', 'done'];
export const FLOW_STATUSES = ['intake', 'ready', 'inProgress', 'blocked', 'smeReview', 'finalReview', 'done', 'outOfScope'];

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const fail = (msg) => {
  throw new CliError(`ticket flow settings: ${msg}`, { code: 2 });
};
const num = (v, where, { min = 0 } = {}) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) fail(`${where} must be a number ≥ ${min}`);
  return v;
};

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
  const tracker = validateTracker(merged.tracker);
  for (const s of REQUIRED_STATUSES) if (!(s in tracker.statuses)) fail(`tracker.statuses has no '${s}': the ticket flow reads it`);
  const forge = validateForge(merged.forge, merged.targets);
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

  const mode = merged.mode ?? LOCAL_DEFAULTS.mode;
  if (!MODES.includes(mode)) fail(`mode must be one of ${MODES.join(', ')}`);
  const limits = deepMerge(LOCAL_DEFAULTS.limits, merged.limits ?? {});
  for (const k of ['inProgress', 'waiting', 'parallel', 'lockLeaseMinutes', 'triageBatch', 'stepsPerTicket', 'sessionsPerStageDay']) num(limits[k], `limits.${k}`, { min: 1 });
  num(limits.sessionPercent, 'limits.sessionPercent');
  num(limits.dailyPercent, 'limits.dailyPercent');
  if (limits.maxWeekPercent !== null) num(limits.maxWeekPercent, 'limits.maxWeekPercent');
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
  if (schedule.tokenFile !== null && (typeof schedule.tokenFile !== 'string' || !schedule.tokenFile.trim())) fail('schedule.tokenFile must be a file path');
  const video = deepMerge(LOCAL_DEFAULTS.video, merged.video ?? {});
  num(video.partsPerDay, 'video.partsPerDay', { min: 1 });
  num(video.partMinutes, 'video.partMinutes', { min: 1 });

  const cleanup = { ...LOCAL_DEFAULTS.cleanup, ...(merged.cleanup ?? {}) };
  if (!['trash', 'delete'].includes(cleanup.mode)) fail('cleanup.mode must be "trash" or "delete"');
  if (!Array.isArray(cleanup.keep) || cleanup.keep.some((g) => typeof g !== 'string' || !g.trim())) fail('cleanup.keep must be a list of globs');
  if (cleanup.trashDir !== null && (typeof cleanup.trashDir !== 'string' || !cleanup.trashDir.trim())) fail('cleanup.trashDir must be a folder');

  const stateRel = typeof merged.state === 'string' && merged.state.trim() ? merged.state : stateRootDefault;
  return {
    root,
    state: path.resolve(root, stateRel),
    stateRel,
    mode,
    tracker,
    intake,
    forge,
    targets,
    noReviewLabel: merged.noReviewLabel ?? null,
    appRepos: merged.appRepos ?? [],
    hostRules: merged.hostRules ?? {},
    hostJobs: validateJobs(merged.hostJobs ?? [], root),
    limits,
    schedule,
    roles,
    modelLadder,
    video,
    cleanup: { ...cleanup, trashDir: cleanup.trashDir ? path.resolve(root, cleanup.trashDir.replace(/^~(?=\/|$)/, process.env.HOME ?? '~')) : null },
  };
}

export async function loadSettings({ root, settings: flag }) {
  const file = await settingsFile(root, flag);
  const shared = readJsonFile(file, 'settings file');
  if (!shared) throw new CliError(`no settings file at ${file}. Declare 'Ticket flow settings:' in CLAUDE.md or pass --settings.`, { code: 2 });
  const localFile = localSettingsPath(file);
  const local = readJsonFile(localFile, 'local settings file');
  const claude = await loadClaudeConfig(root);
  const stateRootDefault = path.join(claude['toolkit state root'] || '.doc-toolkit/', 'ticket-flow/');
  const settings = validateSettings(deepMerge(shared, local ?? {}), { root, stateRootDefault });
  return { ...settings, file, localFile: local ? localFile : null };
}

// What `config` prints: the merged values a skill reads, with the paths resolved. No credential value: only the names
// of the variables that hold them.
export function printable(s) {
  const { forge, tracker, ...rest } = s;
  return {
    ...rest,
    tracker: { ...tracker, credentials: { ...tracker.credentials } },
    forge: { kind: forge.kind, owner: forge.owner, self: forge.self, assignee: forge.assignee, checkLabel: forge.checkLabel, repos: forge.repos },
  };
}
