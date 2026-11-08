import { deepMerge, localSettingsPath, readJsonFile, settingsFile } from '../../tracker/lib/settings.mjs';
import { CliError } from './errors.mjs';

// The forge reads the same ticket flow settings file as the tracker, found the same way (`--settings`, the
// 'Ticket flow settings:' field of CLAUDE.md, `.claude/ticket-flow.json`), with `<name>.local.json` merged over it.
// It takes the `forge` object and the `targets` list (repo, review kind, reviewers, stage labels).
export { deepMerge, localSettingsPath, settingsFile };

// `translation` is optional: a target with no label for it keeps the final review label through the chain.
export const STAGES = ['inProgress', 'review', 'finalReview', 'translation'];

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const fail = (msg) => {
  throw new CliError(`ticket flow settings: ${msg}`, { code: 2 });
};
const str = (v, where, { optional = false } = {}) => {
  if (optional && (v === undefined || v === null)) return null;
  if (typeof v !== 'string' || !v.trim()) fail(`${where} must be a non-empty string`);
  return v.trim();
};

// A label name as GitHub compares it: without case and outer spacing.
export const labelKey = (name) => String(name ?? '').trim().toLowerCase();

// Checks the `forge` object and the `targets` of the settings and returns them in a fixed shape. Nothing here talks to
// the forge. The sets that follow from them are what the module is allowed to touch:
//   repos          the repositories named by a target; a call on any other is refused;
//   addable        the labels the module may add: every target's stage labels, `checkLabel` and `expertLabel`;
//   removable      the labels it may remove: the stage labels and `checkLabel` (a person's forward move of the card
//                  means the owner's check is done); `expertLabel` is never removed;
//   logins         the users it may assign or ask for a review: `self`, `assignee`, every target's reviewers.
export function validateForge(forge, targets) {
  if (!isObject(forge)) fail("the file has no 'forge' object");
  const kind = str(forge.kind, 'forge.kind (for example "github")');
  const owner = str(forge.owner, 'forge.owner');
  const self = str(forge.self, 'forge.self', { optional: true });
  const assignee = str(forge.assignee, 'forge.assignee', { optional: true });
  const checkLabel = str(forge.checkLabel, 'forge.checkLabel', { optional: true });
  // The label on a PR whose writer recommends an expert review (the ticket flow's `pr` record).
  const expertLabel = str(forge.expertLabel, 'forge.expertLabel', { optional: true });
  if (!Array.isArray(targets) || !targets.length) fail("the file has no 'targets' list (the forge works only on the repos the targets name)");
  const list = targets.map((t, i) => {
    if (!isObject(t)) fail(`targets[${i}] must be an object`);
    const id = str(t.id, `targets[${i}].id`);
    const repoRaw = str(t.repo, `targets[${i}].repo`);
    const [repoOwner, repo] = repoRaw.includes('/') ? repoRaw.split('/') : [owner, repoRaw];
    if (repoOwner !== owner || !repo) fail(`targets[${i}].repo '${repoRaw}' is not in forge.owner '${owner}'`);
    const labels = {};
    if (t.labels !== undefined) {
      if (!isObject(t.labels)) fail(`targets[${i}].labels must be { inProgress, review, finalReview, translation? }`);
      for (const [k, v] of Object.entries(t.labels)) {
        if (!STAGES.includes(k)) fail(`targets[${i}].labels.${k} is not a stage (${STAGES.join(', ')})`);
        labels[k] = str(v, `targets[${i}].labels.${k}`);
      }
    }
    const reviewers = t.reviewers ?? [];
    if (!Array.isArray(reviewers) || reviewers.some((r) => typeof r !== 'string' || !r.trim())) fail(`targets[${i}].reviewers must be a list of logins`);
    return { id, repo, review: t.review ?? null, reviewers: reviewers.map((r) => r.trim()), labels };
  });
  const ids = list.map((t) => t.id);
  if (new Set(ids).size !== ids.length) fail('targets[].id must be unique');
  const addable = new Map();
  const removable = new Map();
  for (const t of list) {
    // GitHub compares label names without case; the first spelling a target gives is the one reported.
    for (const name of Object.values(t.labels)) {
      if (!addable.has(labelKey(name))) addable.set(labelKey(name), name);
      if (!removable.has(labelKey(name))) removable.set(labelKey(name), name);
    }
  }
  for (const extra of [checkLabel, expertLabel]) if (extra && !addable.has(labelKey(extra))) addable.set(labelKey(extra), extra);
  if (checkLabel && !removable.has(labelKey(checkLabel))) removable.set(labelKey(checkLabel), checkLabel);
  const logins = new Set([self, assignee, ...list.flatMap((t) => t.reviewers)].filter(Boolean));
  return { kind, owner, self, assignee, checkLabel, expertLabel, targets: list, repos: [...new Set(list.map((t) => t.repo))], addable, removable, logins };
}

export async function loadSettings({ root, settings: flag }) {
  const file = await settingsFile(root, flag);
  const shared = readJsonFile(file, 'settings file');
  if (!shared) throw new CliError(`no settings file at ${file}. Declare 'Ticket flow settings:' in CLAUDE.md or pass --settings.`, { code: 2 });
  const local = readJsonFile(localSettingsPath(file), 'local settings file');
  const merged = deepMerge(shared, local ?? {});
  return { root, file, local: Boolean(local), forge: validateForge(merged.forge, merged.targets) };
}
