import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { computeStatus } from './status.mjs';
import { readAllLedgers, readLedger, findPr, prId } from './ledger.mjs';
import { allLocks, takeLock, releaseLock, renewLock } from './locks.mjs';
import { runRecord, cardStatusFor } from './record.mjs';
import { runUnlock } from './handover.mjs';
import { allowanceOf, parseUsage } from './allowance.mjs';
import { LABEL_OF, PR_STAGE_OF_STATUS, PRIORITY_RANK, finishRank, followsMove } from './stages.mjs';
import { appendRunLog, localDate, readRunLog, renderReport, writeReport } from './report.mjs';
import { ROLES } from './settings.mjs';
import { cleanupTicket } from './cleanup.mjs';
import { removeClosedMarkdown } from './import.mjs';
import { DOWNLOAD_DIRS_VARIABLE, ROLE_SESSION_VARIABLE, childEnv, sessionChildEnv } from './env.mjs';
import { clonePath, codeTreePath, codeTreesRoot, ensureCodeTree, ensureWorktree, prsForStep, worktreePath } from './worktree.mjs';
import { BUSY_NAME, LOCK_NAME, busyEnded, freeBrowserLock } from './browser-lock.mjs';
import { HOOK_VARIABLE, commandsOfRules, hookSettings } from './role-hook.mjs';
import { parseClaudeConfig } from '../../ui-labels/lib/config.mjs';

// The daily run (design §7): finish first, then triage the quiet intake cards (mornings), then start ready groups while
// the limits and the day's allowance allow. A script decides; each step that needs a model is one `claude -p` session
// in one role, with that role's model and effort from the settings. A dry run prints the plan and the command lines
// and changes nothing.

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(HERE, '../../..');
const SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'ticket-state', 'ticket-state.mjs');
export const ROLE_HOOK = path.join(PLUGIN_ROOT, 'scripts', 'ticket-state', 'role-hook.mjs');
export const ROLE_DIR = path.join(PLUGIN_ROOT, 'context', 'ticket-roles');
// A git allow rule in the `git -C <worktree>` spelling, for each worktree the runner made for the step: the literal
// path, as a prefix rule (`Bash(git -C /x/wt status:*)`). Never a wildcard path: `Bash(git -C * status *)` would also
// match `git -C <any folder> clean -fdx -e status`, any subcommand with an allowed word later in the command. A step
// with no worktree gets no twin. An exact rule (`Bash(git fetch origin)`) gets an exact twin.
export function gitCFor(rule, dirs) {
  const m = /^Bash\(git (?!-C )(.+):\*\)$/.exec(rule);
  if (m) return dirs.map((d) => `Bash(git -C ${d} ${m[1]}:*)`);
  const exact = /^Bash\(git (?!-C )([^*:]+)\)$/.exec(rule);
  return exact ? dirs.map((d) => `Bash(git -C ${d} ${exact[1]})`) : [];
}
export const withGitC = (rules, dirs = []) => [...new Set(rules.flatMap((r) => [r, ...gitCFor(r, dirs)]))];

// The only push a session may run: its worktree's HEAD to its ticket branch, exactly as the brief writes it, in the
// `git -C <worktree>` spelling only. A plain push would push whatever checkout the session's folder holds (the hub's
// HEAD, say), and the hub's own settings allow `git push:*`, so every plain push is denied (`ROLE_DENIED`). No other
// `-C` push is allowed, so a `+` refspec, a force flag, a deletion (`--delete`, `-d`, `:<ref>`) or another branch never is.
export const pushRulesFor = (trees = []) => [...new Set(trees.map((t) => `Bash(git -C ${t.path} push origin HEAD:refs/heads/${t.branch})`))];

// A fetch with a refspec of its own (`+refs/heads/main:refs/heads/other`) would move the owner's local branches, which a
// worktree shares. A role fetches only as `git -C <worktree> fetch origin`, or `… fetch origin <branch>` for the
// worktree's branch and base (the default refspec updates only `origin/*`); every plain fetch is denied (`ROLE_DENIED`).
export const fetchRulesFor = (trees = []) => [...new Set(trees.flatMap((t) => [`Bash(git -C ${t.path} fetch origin)`, ...[t.branch, t.base].filter(Boolean).map((b) => `Bash(git -C ${t.path} fetch origin ${b})`)]))];
// `ls-remote` the same way, literal and exact, since `--upload-pack=<cmd>` runs a command: what the branch or base is on origin now.
export const lsRemoteRulesFor = (trees = []) => [...new Set(trees.flatMap((t) => [t.branch, t.base].filter(Boolean).map((b) => `Bash(git -C ${t.path} ls-remote origin ${b})`)))];

// A step with no worktree (triage, the plan) reads the target clones and the hub in the `git -C <folder>` spelling too: the
// role's own read rules, for these reads only, never `add` or `commit`.
const CLONE_READS = /^Bash\(git (log|show|ls-tree|status|diff)(:\*)?\)$/;
export const cloneReadRules = (rules, dirs = []) => rules.filter((r) => CLONE_READS.test(r)).flatMap((r) => gitCFor(r, dirs));

// Denied in every role, whatever its file says: a push that could drop someone else's commits (the owner pushes to the
// same branches by hand), skip the hooks, or delete a branch, in both spellings: plain, and `git -C <worktree>` for each
// worktree of the step (`deniedFor`), never `git -C *`, whose `*` would span a commit message and deny
// `git -C <wt> commit -m "… branch -D …"`. Host jobs, which have no worktree, keep `git -C *` (`PUSH_DENIED`). A deny
// rule may hold a `*` in the middle (a wider deny only denies more): the flag right after `push`, or anywhere after it,
// and a `+` refspec (a forced update). A `:*` after a middle `*` never matches, so each is written as the command alone
// and with arguments; a `:<ref>` deletion can't be written as a deny rule at all, and is kept out by allowing only the
// brief's exact push (`pushRulesFor`).
const FORCE_FLAGS = ['--force', '-f', '--force-with-lease', '--force-if-includes', '--no-verify', '--mirror', '--delete', '-d'];
// A flag of `git <sub>` denied wherever it stands, in both spellings: first, last, or between other words.
const flagDenied = (sub, flags, git) => flags.flatMap((f) => [`Bash(${git} ${sub} ${f})`, `Bash(${git} ${sub} ${f} *)`, `Bash(${git} ${sub} * ${f})`, `Bash(${git} ${sub} * ${f} *)`]);
const pushDenied = (git) => [...flagDenied('push', FORCE_FLAGS, git), `Bash(${git} push +*)`, `Bash(${git} push * +*)`];
export const PUSH_DENIED_PLAIN = [...new Set([...FORCE_FLAGS.map((f) => `Bash(git push ${f}:*)`), ...pushDenied('git')])];
export const PUSH_DENIED = [...new Set([...PUSH_DENIED_PLAIN, ...pushDenied('git -C *')])];
// A worktree shares the clone's refs, so a `git branch` that deletes, renames, copies, moves or re-points a branch
// would change the owner's own branches. No role allows `git branch`; these flags are denied on top, plain and per
// worktree (`--set-upstream-to=<x>` as one word too). They don't cover abbreviations (`--del`) or combined flags (`-rD`):
// a host that allows `git branch` reopens those.
const BRANCH_FLAGS = ['-D', '-d', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force', '-u', '--set-upstream-to'];
const branchDenied = (git) => [...flagDenied('branch', BRANCH_FLAGS, git), `Bash(${git} branch --set-upstream-to=*)`, `Bash(${git} branch * --set-upstream-to=*)`];
export const BRANCH_DENIED = [...new Set([...BRANCH_FLAGS.map((f) => `Bash(git branch ${f}:*)`), ...branchDenied('git')])];
// The push and branch denials in the `git -C <worktree>` spelling, for the literal path of each worktree: the word after
// the path is always the subcommand.
export const deniedFor = (dirs = []) => [...new Set(dirs.flatMap((d) => [...pushDenied(`git -C ${d}`), ...branchDenied(`git -C ${d}`)]))];
// Denied in every role too: the runner prepares the worktree (lib/worktree.mjs), so no session installs packages or
// links files into it.
export const SETUP_DENIED = ['Bash(npm ci:*)', 'Bash(npm install:*)', 'Bash(npm i:*)', 'Bash(ln:*)'];
// Host jobs have no worktree, and a job's own allow list may hold `Bash(git:*)`: no push, no branch change and no fetch,
// in any folder. A `:<branch>` push deletes a remote branch and can't be told from another push by a rule that works, nor
// can a fetch refspec from a plain fetch, so both go whole (`git -C * push *` spans a commit message too: a job commits
// nothing it could push). A skill job also carries the roles' code, git and file denials (`jobDenied`).
export const JOB_DENIED = [...new Set([...PUSH_DENIED, ...BRANCH_DENIED, ...branchDenied('git -C *'), 'Bash(git push:*)', 'Bash(git -C * push)', 'Bash(git -C * push *)', 'Bash(git fetch:*)', 'Bash(git -C * fetch)', 'Bash(git -C * fetch *)'])];

// ------------------------------------------------------------------ what a role session may run

// A role session loads the hub's project and local files and the runner's flags, never the owner's user layer
// (`ROLE_SETTING_SOURCES`); a deny in any layer wins over an allow in any other. The hub's layers allow far more than a
// role needs (`git push:*`, `git fetch:*`, `git branch:*`, `git stash:*`, `git mv *`, `git cherry-pick *`,
// `python3 -c ' *`, `gh pr *`), so the runner denies, in every role, what no stage runs, and these denials guard against
// a mistake in a host's layer too. Mutating git commands in the plain spelling (a plain command runs in
// whatever checkout the session's folder holds, the hub's own after a denied `cd`): the role's own changes go through
// `git -C <worktree>` only. `git grep` runs a command (`-O<cmd>`, `--open-files-in-pager`), and so does `git ls-remote` (`--upload-pack=<cmd>`); the Grep tool searches.
// `--output=<file>` (log, diff, show) writes a file past the Edit denials; git takes no shorter abbreviation of it.
const GIT_PLAIN_DENIED = ['add', 'commit', 'grep', 'push', 'branch', 'fetch', 'stash', 'cherry-pick', 'mv', 'rm', 'clean', 'tag', 'remote', 'config', 'update-ref', 'reflog', 'gc', 'replace', 'notes', 'submodule', 'filter-branch', 'worktree add', 'worktree remove', 'worktree move', 'worktree prune', 'worktree lock', 'worktree unlock', 'ls-remote', 'checkout', 'switch', 'pull', 'reset', 'rebase', 'merge', 'restore', 'revert'].map((c) => `Bash(git ${c}:*)`);
const GIT_OUTPUT_DENIED = ['Bash(git * --output=*)', 'Bash(git * --output *)'];
// Code from a string, standard input or a file the session wrote: roles run only the toolkit's scripts by name
// (`scriptRulesFor`). The interpreters a layer allows (`python3 -c ' *`, `python3 <a relative file>`), the shells, and
// the forms that run another command (`find -exec`, `xargs`, `env`, an env prefix a layer allows).
const CODE_DENIED = [
  ...['-e', '-p', '--eval', '--print', '-r', '--require', '--import', '--loader', '--experimental-loader', '-i', '--interactive', '--input-type', '-'].map((f) => `Bash(node ${f}:*)`),
  'Bash(node)', 'Bash(NODE_OPTIONS=*)', 'Bash(CORPUS=*)', 'Bash(node_modules/.bin/playwright:*)',
  ...['python3', 'python', 'perl', 'ruby', 'php', 'sh', 'bash', 'zsh', 'osascript', 'eval', 'exec', 'source', 'xargs', 'env', 'nohup', 'deno', 'bun', 'tsx', 'ts-node'].map((c) => `Bash(${c}:*)`),
  ...['-exec', '-execdir', '-ok', '-okdir', '-delete'].flatMap((f) => [`Bash(find * ${f})`, `Bash(find * ${f} *)`]),
];
// The tracker's and the browser's MCP tools: a role reaches the tracker only through `ticket-state record` and the
// tracker script, and no stage drives a browser through MCP.
const MCP_DENIED = ['mcp__claude_ai_Trello', 'mcp__trello', 'mcp__playwright'];
// `ffmpeg` and `ffprobe` by hand, which a layer may allow (an owner's has allowed single calls): a role cuts a video only
// with `video-parts`, which runs them with fixed arguments on paths inside the ticket's work folder.
const MEDIA_DENIED = ['Bash(ffmpeg:*)', 'Bash(ffprobe:*)'];
// Moving or removing folders, which a broad host allow would reopen, and a browser lock made by hand (no holder, so
// nothing frees it): a role takes and frees the lock only with browser-lock.mjs.
const FOLDER_DENIED = ['Bash(mv:*)', 'Bash(rmdir:*)', 'Bash(mkdir *.playwright.lock*)', 'Bash(mkdir .playwright.lock*)'];
// Whole tools no stage needs that run or schedule work, or send something outside the session; the hook doesn't read them.
// `ScheduleWakeup` a session has used (a pilot's `locales` orchestrator, 4 times), but it doesn't need it: a session with a
// background worker that got no wakeup finished when the worker reported.
// A name this CLI doesn't have is ignored (probed), so the list survives CLI updates. `Agent`/`Task` (the translator's
// workers), `SendMessage`, `TaskStop`, `ListAgents`, `Monitor`, `Skill` and `ToolSearch` stay: stages or their skills use them.
export const TOOLS_DENIED = ['Workflow', 'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger', 'ScheduleWakeup', 'PushNotification', 'DesignSync', 'EnterWorktree', 'ExitWorktree', 'WebFetch', 'WebSearch', 'Artifact', 'ArtifactData', 'ArtifactComments', 'SendUserFile'];
export const ROLE_DENIED = [...new Set([...GIT_PLAIN_DENIED, ...GIT_OUTPUT_DENIED, ...CODE_DENIED, ...MEDIA_DENIED, ...FOLDER_DENIED, ...MCP_DENIED, ...TOOLS_DENIED])];
// A skill job's session: the roles' git and code denials, and the file denials (`jobDenied`). Not the MCP denials: the
// toolkit knows nothing about what a job does, and a host's job may well work on its tracker through MCP.
export const jobDenied = (settings, roots = scriptRoots(settings)) => [...new Set([...JOB_DENIED, ...GIT_PLAIN_DENIED, ...GIT_OUTPUT_DENIED, ...CODE_DENIED, ...writeDeniedFor(settings, roots)])];

// The scripts a stage runs, by name: `node <root>/scripts/<script>` (`ticket-state` for `record`, `status` and `config`
// only: its other commands are the owner's, and `set` would widen the next session's rules), from the toolkit the runner runs (the brief's
// "scripts folder") and from the installed plugin the session's skills name (`${CLAUDE_PLUGIN_ROOT}`). A literal path
// as a prefix rule: never a wildcard, which `../` would walk out of.
export const NODE_SCRIPTS = ['ticket-state/ticket-state.mjs record', 'ticket-state/ticket-state.mjs status', 'ticket-state/ticket-state.mjs config', 'tracker/tracker.mjs', 'forge/forge.mjs', 'locale-sync/locale-sync.mjs', 'ui-labels/ui-labels.mjs', 'doc-align/doc-align.mjs', 'screenshot-locales/screenshot-locales.mjs', 'section-state/section-state.mjs', 'visual-pack/visual-pack.mjs', 'video-parts/video-parts.mjs', 'ticket-state/browser-lock.mjs'];
// Each role's own, from what its stages and the skills it runs call. Triage reads and answers cards and writes nothing else;
// the writer's skills run the UI label check and the screenshot paths; the translator's run the locale pipeline and the
// alignment check; the reviewer builds the visual pack, and adds what the EN review left open to the PR's description
// (`forge edit-pr`). The last two read a PR's base with `forge pr-state`, which neither `status` nor the brief gives. A role's list narrows only: a script not in it has no rule, and
// the role's hook refuses it however it is spelled.
const STATE_SCRIPTS = ['ticket-state/ticket-state.mjs record', 'ticket-state/ticket-state.mjs status', 'ticket-state/ticket-state.mjs config'];
export const ROLE_SCRIPTS = {
  triage: [...STATE_SCRIPTS, 'tracker/tracker.mjs'],
  writer: [...STATE_SCRIPTS, 'ticket-state/browser-lock.mjs', 'tracker/tracker.mjs', 'forge/forge.mjs', 'ui-labels/ui-labels.mjs', 'screenshot-locales/screenshot-locales.mjs', 'video-parts/video-parts.mjs'],
  reviewer: [...STATE_SCRIPTS, 'visual-pack/visual-pack.mjs', 'forge/forge.mjs pr-state', 'forge/forge.mjs edit-pr'],
  translator: [...STATE_SCRIPTS, 'locale-sync/locale-sync.mjs', 'ui-labels/ui-labels.mjs', 'doc-align/doc-align.mjs', 'screenshot-locales/screenshot-locales.mjs', 'forge/forge.mjs pr-state'],
};
export const scriptRulesFor = (roots = [], role = null) => [...new Set(roots.flatMap((r) => (role ? ROLE_SCRIPTS[role] : NODE_SCRIPTS).map((s) => `Bash(node ${path.join(r, 'scripts', s)}:*)`)))];
// Script flags that run code: ui-labels' `--source 'command <cmd>'` (a shell) and visual-pack's `--playwright-from
// <dir>` (JavaScript from that folder), denied first, last or between other words, as `--x v` and `--x=v`.
const SCRIPT_FLAGS = { 'ui-labels/ui-labels.mjs': ['--source'], 'visual-pack/visual-pack.mjs': ['--playwright-from'] };
export const scriptFlagsDenied = (roots = []) => [...new Set(roots.flatMap((r) => Object.entries(SCRIPT_FLAGS).flatMap(([s, flags]) => {
  const cmd = `node ${path.join(r, 'scripts', s)}`;
  return flags.flatMap((f) => [`Bash(${cmd} ${f})`, `Bash(${cmd} ${f} *)`, `Bash(${cmd} * ${f})`, `Bash(${cmd} * ${f} *)`, `Bash(${cmd} ${f}=*)`, `Bash(${cmd} * ${f}=*)`]);
})))];

// The toolkit roots a session may run scripts from: the runner's own, and every install of the plugin the hub's
// sessions load (the owner's, or the hub's project install), from Claude Code's list of installed plugins.
export function scriptRoots(settings, { home = os.homedir(), env = process.env } = {}) {
  const roots = [PLUGIN_ROOT];
  try {
    const file = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'plugins', 'installed_plugins.json');
    const list = JSON.parse(fs.readFileSync(file, 'utf8')).plugins ?? {};
    for (const [name, installs] of Object.entries(list)) {
      if (!name.startsWith('doc-writer-toolkit@')) continue;
      for (const i of installs ?? []) if (i.installPath && (i.scope === 'user' || (i.projectPath && path.resolve(i.projectPath) === path.resolve(settings.root)))) roots.push(i.installPath);
    }
  } catch {
    /* no list: the runner's own root */
  }
  return [...new Set(roots.map((r) => path.resolve(r)))];
}

// Files a session may not write, whatever a layer allows (a hub's `Edit(**)`) or `writeAllowedFor` opens: what widens its own
// rules or runs code on the next git command or session (the settings layers, `.git/` hooks and config), the toolkit's
// scripts it may run, the ticket flow's own state (only `record` writes it; a session's files go in `<state>/tmp/`), and
// the hub's protected build files, in any folder. Also what runs code later: a host's `CLAUDE*.md` (a `UI label source:
// command …` line runs a shell), `.github/` (the host jobs' scripts, and workflows GitHub runs with the repo's secrets),
// `node_modules/`, `.npmrc`, the owner's git config, shell startup files and `~/.ssh/`; and the ticket flow's settings
// files wherever the host keeps them; and the LaunchAgents folder, which starts what it names at the next login. An
// `Edit(...)` deny covers Write too. A `.env` file is not read (a mistake guard: the scripts and Playwright's specs read
// it as processes); `.env.example`, which holds no values, is. A deny can't except one name, so the denied ones are named.
const ENV_FILES = ['.env', '.env.local', '.env.*.local', '.env.development', '.env.production', '.env.test', '.env.staging', '.env.dev', '.env.prod'];
const abs = (p) => `//${String(p).replace(/^\/+/, '')}`;
export function writeDeniedFor(settings, roots = []) {
  const state = path.resolve(settings.state);
  const own = [settings.file, settings.localFile, settings.file ? settings.file.replace(/(\.json)?$/, '.local.json') : null].filter(Boolean).map((f) => path.resolve(settings.root, f));
  return [
    'Edit(~/.claude/**)', 'Edit(~/.claude.json)', 'Edit(//**/.claude/**)', 'Edit(//**/.git/**)', 'Edit(//**/.git)',
    ...['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'docusaurus.config.*', 'sidebars.*', 'playwright.config.*', 'CLAUDE*.md', '.npmrc'].map((f) => `Edit(//**/${f})`),
    'Edit(//**/.github/**)', 'Edit(//**/node_modules/**)',
    'Edit(~/.gitconfig)', 'Edit(~/.config/git/**)', 'Edit(~/.ssh/**)', 'Edit(~/Library/LaunchAgents/**)',
    ...['.zshrc', '.zshenv', '.zprofile', '.zlogin', '.bashrc', '.bash_profile', '.profile'].map((f) => `Edit(~/${f})`),
    ...[...new Set(own)].map((f) => `Edit(${abs(f)})`),
    ...ENV_FILES.map((f) => `Read(//**/${f})`),
    ...roots.map((r) => `Edit(${abs(r)}/**)`),
    ...['tickets', 'locks', 'roles', 'watch', 'jobs', 'runs', 'reports', LOCK_NAME, BUSY_NAME].map((d) => `Edit(${abs(path.join(state, d))}/**)`),
    // The browser lock and the busy notes go only through browser-lock.mjs: no holder-less lock, no forged holder.
    ...[LOCK_NAME, BUSY_NAME].map((d) => `Edit(${abs(path.join(state, d))})`),
    ...['rearmed.json', 'roles-proposal.json'].map((f) => `Edit(${abs(path.join(state, f))})`),
    // The Markdown ledgers from before the JSON ones: `import` reads them, and a state folder may sit under a `.sources/`.
    `Edit(${abs(state)}/*.md)`,
  ];
}

// The content roots of an owner's checkout: each declared UA content root (`docs/` when none is declared), each EN
// i18n root, and `i18n/`, where every further locale's root is. Read from the checkout's own CLAUDE.md.
export function contentRootsOf(dir) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  } catch {
    /* no CLAUDE.md: the defaults */
  }
  const c = parseClaudeConfig(text);
  const clean = (p) => path.posix.normalize(String(p).replace(/\\/g, '/')).replace(/^\.\//, '').replace(/\/+$/, '') || '.';
  const ua = Object.keys(c).filter((k) => /(^|\s)ua content root$/.test(k)).map((k) => clean(c[k]));
  const en = Object.keys(c).filter((k) => /(^|\s)en i18n root$/.test(k)).map((k) => clean(c[k]));
  return { ua: ua.length ? [...new Set(ua)] : ['docs'], en: [...new Set(['i18n', ...en])] };
}

// On a step with worktrees, the pages go into the worktrees, never into an owner's checkout: the target clones' content
// roots are not writable (a relative path resolves against the hub, which may be a target too). A UA root keeps its
// top-level dot folders writable, since a hub keeps its tickets' files and the flow's state in `<root>/.sources/`:
// the CLI's rules have no working negated character class (`[!.]` and `[^.]` both match a dot), so the rule names the
// first character a page or folder starts with, `[a-zA-Z0-9_-]`. A top-level name that starts with another character
// is not covered, and neither is a root that holds the flow's state folder under such a name (the session writes its
// files in `<state>/tmp/`); `record write` refuses a write the worktree doesn't hold either way.
const FIRST_CHAR = '[a-zA-Z0-9_-]';
export function checkoutDeniedFor(settings) {
  const clones = [...new Set(settings.targets.map((t) => clonePath(settings, t)).filter(Boolean))];
  const state = path.resolve(settings.state);
  const inside = (root) => {
    const rel = path.relative(root, state);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  // Under a UA root, only a state folder under a name the rule covers (not a dot folder) is in the way.
  const holdsState = (root) => inside(root) && !path.relative(root, state).startsWith('.');
  return [...new Set(clones.flatMap((clone) => {
    const { ua, en } = contentRootsOf(clone);
    const uaRoots = ua.map((r) => path.resolve(clone, r)).filter((r) => !holdsState(r));
    return [...uaRoots.flatMap((r) => [`Edit(${abs(r)}/${FIRST_CHAR}*)`, `Edit(${abs(r)}/${FIRST_CHAR}*/**)`]), ...en.map((r) => path.resolve(clone, r)).filter((r) => !inside(r)).map((r) => `Edit(${abs(r)}/**)`)];
  }))];
}

// Which settings layers a role session loads: the hub's (its CLAUDE.md, skills, plugin, hooks and rules), not the
// owner's. The owner's layer allows Edit and Write with no scope and adds folders of its own, and no deny list can hold
// those in. `--setting-sources` also decides CLAUDE.md and `.claude/skills/`: with `project` gone they go too.
export const ROLE_SETTING_SOURCES = 'project,local';

// A file-writing tool with no scope, in a role file or in `roles.<role>.allowedTools`: dropped, so that a session's
// writes are only `writeAllowedFor`'s. A scoped rule an owner adds stays.
const UNSCOPED_WRITE = /^(Edit|Write|MultiEdit|NotebookEdit)(\((\/{0,2}|~\/|\.\/)\*{1,2}\))?$/;

// A key goes into a path and a rule only as a plain name.
const plainKeys = (step) => step.keys.filter((k) => /^[\w-][\w.-]*$/.test(k));
// The folders a session may write in with Write and Edit: the step's worktrees and the flow's `<state>/tmp/`; and, for
// every role but triage, the work folder of each of the step's tickets (`workFolder` in the settings). `Edit(...)`
// covers Write too.
export function writableFor(step, settings) {
  const keys = step.role === 'triage' || !settings.workFolder ? [] : plainKeys(step);
  return [...new Set([...(step.worktrees ?? []).map((t) => t.path), path.join(path.resolve(settings.state), 'tmp'), ...keys.map((k) => path.resolve(settings.root, settings.workFolder.replace('<key>', k)))])];
}
// Where `tracker download-attachment --out` may save in a role session: the ticket's work folder and the state `tmp/`.
export function downloadDirsFor(step, settings) {
  const keys = step.role === 'triage' || !settings.workFolder ? [] : plainKeys(step);
  return [path.join(path.resolve(settings.state), 'tmp'), ...keys.map((k) => path.resolve(settings.root, settings.workFolder.replace('<key>', k)))];
}
// A step with no worktree (the plan, a video's import) writes its evidence and its section plan in the `.sources/`
// folders of the target clones (section-readiness, app-explorer, section-planner, convert-sme-input). Never the pages.
// Its live check needs a Playwright spec, the only way a role drives a browser, in a clone's `screenshot-tests/`. That
// folder holds an owner's hand-written specs, git-ignored and so past recovery: a session creates only its own,
// `_plan-<key>-<what>.spec.ts`, one rule per key of the step.
export function writeAllowedFor(step, settings) {
  const clones = step.role === 'triage' || step.worktrees?.length ? [] : [...new Set(settings.targets.map((t) => clonePath(settings, t)).filter(Boolean))];
  return [...writableFor(step, settings).map((d) => `Edit(${abs(d)}/**)`), ...clones.flatMap((c) => [`Edit(${abs(c)}/**/.sources/**)`, ...plainKeys(step).map((k) => `Edit(${abs(c)}/screenshot-tests/_plan-${k}-*)`)])];
}

// ------------------------------------------------------------------ roles

// A role file: frontmatter (`name`, `description`, `allowedTools`, `disallowedTools` as YAML lists) and the role's
// instructions. The runner hands them to `claude -p` as a session agent (`--agents <file> --agent ticket-<role>`).
export function readRole(role, dir = ROLE_DIR) {
  const text = fs.readFileSync(path.join(dir, `${role}.md`), 'utf8').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${role}.md has no frontmatter`);
  const meta = {};
  let listKey = null;
  for (const line of m[1].split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      meta[listKey].push(item[1].trim().replace(/^(['"])(.*)\1$/, '$2'));
      continue;
    }
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[2] === '') {
      listKey = kv[1];
      meta[listKey] = [];
    } else {
      listKey = null;
      meta[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2').replace(/''/g, "'");
    }
  }
  return { role, name: meta.name, description: meta.description, allowedTools: meta.allowedTools ?? [], disallowedTools: meta.disallowedTools ?? [], prompt: m[2].trim() };
}

export const agentName = (role) => `ticket-${role}`;

// Every role, as the `--agents` file: its instructions, then the rules of working unattended that every role shares.
export function agentsFile(dir = ROLE_DIR) {
  const shared = fs.readFileSync(path.join(dir, 'unattended.md'), 'utf8').trim();
  return Object.fromEntries(ROLES.map((r) => {
    const role = readRole(r, dir);
    return [agentName(r), { description: role.description, prompt: `${role.prompt}\n\n${shared}` }];
  }));
}

export const nextModelUp = (model, ladder) => {
  const i = ladder.indexOf(model);
  return i >= 0 && i < ladder.length - 1 ? ladder[i + 1] : null;
};

// Who started a start step: the step names it (`schedule` for a ready group a scheduled run starts, `manual` for a
// manual run's start and a card a person moved into work, the ledger's own for a start that goes on; lib/rule.mjs).
// A step that names none is a person's: `manual`, outside every limit.
export const startOrigin = (step) => (step.startedBy === 'schedule' ? 'schedule' : 'manual');

// ------------------------------------------------------------------ one step's session

// What a session is told: the ticket, the stage, where the settings and the ticket's status are, and how to record.
export function briefFor(step, settings) {
  const root = settings.root;
  const ts = `node ${SCRIPT}`;
  // The settings file the runner read, so a session of a run started with --settings finds the same one.
  const at = `--root ${root}${settings.file ? ` --settings ${settings.file}` : ''}`;
  const keys = step.keys.join(', ');
  const rules = Object.entries(settings.hostRules ?? {}).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  const cardOf = (key) => step.cards?.find((c) => c.key === key);
  const noWorktree = !step.worktrees?.length && step.role !== 'triage';
  // A start's origin, as the runner recorded it before the session (`startOrigin`): the session records the same.
  const recordLine = (key) =>
    `${ts} record ${key} ${at} --stage ${step.stage}${step.pr ? ` --pr ${step.pr}` : ''} --status done${step.stage === 'start' || step.stage === 'triage' ? ` --card ${cardOf(key)?.shortLink ?? '<card>'}` : ''}${step.stage === 'start' ? ` --started-by ${startOrigin(step)}` : ''} --result ${step.stage === 'start' && step.group ? `'{"group":"${step.group}"}'` : '<json>'}`;
  return [
    `Stage \`${step.stage}\` of ticket${step.keys.length > 1 ? 's' : ''} ${keys}${step.group ? ` (group ${step.group})` : ''}${step.pr ? `, PR ${step.pr}` : ''}.`,
    step.interrupted ? 'The last run of this stage was interrupted: read what it left and finish it.' : null,
    step.withoutVideo ? 'The owner moved the card back before every video part had its transcript: go on without the video, and say so in the plan comment.' : null,
    step.changed ? 'The section plan file changed after its gate: post the new plan and move the card back to Blocked (a new gate).' : null,
    step.stale ? `The UA pages changed after this stage last ran (${step.stale} file(s)): run it again on the current head.` : null,
    step.cards ? `Cards, highest priority first:\n${step.cards.map((c) => `- ${c.key}: ${c.url ?? c.shortLink} (${c.priority})`).join('\n')}` : null,
    step.worktrees?.length ? worktreeLines(step.worktrees) : null,
    step.codeTrees?.length ? codeLines(step.codeTrees) : null,
    '',
    `Host repo: ${root}`,
    `The toolkit's scripts folder: ${path.join(PLUGIN_ROOT, 'scripts')}`,
    `Write your files with Write and Edit only in: ${writableFor(step, settings).join(', ')}${noWorktree ? ', and the `.sources/` folders of the target repos' : ''}.`,
    noWorktree && plainKeys(step).length ? `A Playwright spec on this step goes in the target repo's \`screenshot-tests/\`, named ${plainKeys(step).map((k) => `\`_plan-${k}-<what>.spec.ts\``).join(' or ')}. Use that name, import shared helpers from that folder rather than editing them, and run it from that repo (\`cd\` there as a call of its own, then \`npx playwright test screenshot-tests/<file>\`).` : null,
    `Settings (merged): \`${ts} config ${at}\``,
    `The ticket now: \`${ts} status ${at} --ticket ${step.keys[0]}\``,
    rules ? `Host rules:\n${rules}` : null,
    '',
    'When the stage ends, record it, one command per call, for each ticket:',
    ...step.keys.map((k) => `  ${recordLine(k)}`),
    `or \`--status failed --note <the reason>\`. A record the tracker, the forge or the files don't support is refused: fix the cause, never the record.`,
  ]
    .filter((x) => x !== null)
    .join('\n');
}

// What the brief says about the worktrees the runner made for the session.
function worktreeLines(trees) {
  return [
    'Worktrees (the runner made them; work only there, and never create, move or remove a worktree, or link a file into one). Run git there as `git -C <the path exactly as below, unquoted> <command>`. A read (status, diff, log, show) may also run as plain `git <command>` after a `cd` to it as a separate call; an add, a commit, a push and a fetch run only as `git -C` (this session starts in the hub, whose checkout a plain one would change). Other spellings are denied, a quoted path and `cd <path> && git …` among them.',
    ...trees.map((t) => `- ${t.repo} ${t.branch}: ${t.path}${t.linked?.length ? ` (linked from the clone: ${t.linked.join(', ')})` : ''}. It is detached at origin/${t.branch} as the runner fetched it; push with \`${t.push}\`, fetch with \`git -C ${t.path} fetch origin\`.${t.notes?.length ? ` Note: ${t.notes.join('; ')}.` : ''}`),
  ].join('\n');
}

// What the brief says about the code the session may read: the checkout at the commit the runner just fetched.
function codeLines(trees) {
  return [
    'Code repos, each a read-only checkout at the commit the runner fetched for this session. Read code only here, with Read and Grep, never in a clone, whose files may be weeks old (Read and Grep are denied there). A fact from the code carries its reference when you read it: repo, path, lines and the commit below.',
    ...trees.map((t) => (t.error ? `- ${t.repo}: not available (${t.error}). A fact only this code could answer stays a marker.` : `- ${t.repo}: ${t.path}, commit ${t.commit}${t.url ? `; a link to lines: ${t.url}/blob/${t.commit}/<path>#L<from>-L<to>` : ''}.${t.notes?.length ? ` Note: ${t.notes.join('; ')}.` : ''}`)),
  ].join('\n');
}

// The roles that read code as evidence.
const CODE_ROLES = new Set(['writer', 'reviewer']);
// Every role is denied the clones' own files, and writing in the checkouts: a clone's working tree may be weeks old.
const codeDenied = (settings) => [...new Set((settings.appRepos ?? []).flatMap((a) => [`Read(${abs(path.resolve(settings.root, a.path))}/**)`, `Edit(${abs(path.resolve(settings.root, a.path))}/**)`, `Edit(${abs(codeTreesRoot(settings, a))}/**)`]))];

export function commandFor(step, settings, { model, agentsPath, claude = 'claude', roleDir = ROLE_DIR, roots = scriptRoots(settings) }) {
  const role = settings.roles[step.role];
  const def = readRole(step.role, roleDir);
  // Every git rule in both spellings, plain and `git -C <worktree>` for each worktree of the step (lib/worktree.mjs); the
  // toolkit's scripts by name; writes only in the step's own folders (`writeAllowedFor`); and the denials every role
  // carries (`ROLE_DENIED`, `writeDeniedFor`), which guard against a mistake inside those folders and in a host's layer.
  const roleRules = [...def.allowedTools, ...(role.allowedTools ?? [])].filter((r) => !UNSCOPED_WRITE.test(r));
  const trees = step.worktrees ?? [];
  const dirsOf = trees.map((t) => t.path);
  const codeDirs = (step.codeTrees ?? []).filter((t) => !t.error).map((t) => t.path);
  const readDirs = [...(trees.length ? [] : [...new Set(settings.targets.map((t) => clonePath(settings, t)).filter(Boolean))]), ...codeDirs];
  const allowed = [...new Set([...withGitC(roleRules, dirsOf), ...cloneReadRules(roleRules, readDirs), ...writeAllowedFor(step, settings), ...scriptRulesFor(roots, step.role), ...pushRulesFor(trees), ...fetchRulesFor(trees), ...lsRemoteRulesFor(trees)])];
  // A role that doesn't run Playwright doesn't get it from the hub's `npx playwright:*`.
  const noPlaywright = roleRules.some((r) => r.startsWith('Bash(npx playwright')) ? [] : ['Bash(npx playwright:*)'];
  const disallowed = [...new Set([...def.disallowedTools, ...(role.disallowedTools ?? []), ...PUSH_DENIED_PLAIN, ...BRANCH_DENIED, ...deniedFor(dirsOf), ...dirsOf.flatMap((d) => [`Bash(git -C ${d} branch:*)`, `Bash(git -C ${d} grep:*)`]), ...ROLE_DENIED, ...noPlaywright, ...scriptFlagsDenied(roots), ...writeDeniedFor(settings, roots), ...(trees.length ? checkoutDeniedFor(settings) : []), ...SETUP_DENIED, ...codeDenied(settings)])];
  // The folders a session may reach (`--add-dir`, and so `cd`): the step's worktrees; a step with none (triage, the plan)
  // reads the target clones instead.
  // The toolkit roots too, so `ls` works where a session reads its scripts: probed, this loads no further skill or plugin,
  // and `writeDeniedFor` keeps them closed to Write and the hook to `mkdir`.
  const dirs = [...new Set([...(trees.length ? dirsOf : settings.targets.map((t) => (t.path ? path.resolve(settings.root, t.path) : null))), ...codeDirs, ...roots].filter((d) => d && d !== settings.root))];
  const args = [
    '-p',
    briefFor(step, settings),
    '--agents', agentsPath,
    '--agent', agentName(step.role),
    '--model', model ?? role.model,
    ...(role.effort ? ['--effort', role.effort] : []),
    '--max-turns', String(role.maxTurns ?? 100),
    ...(role.maxBudgetUsd !== undefined ? ['--max-budget-usd', String(role.maxBudgetUsd)] : []),
    '--setting-sources', ROLE_SETTING_SOURCES,
    // The hook that reads each Bash command as a shell would (lib/role-hook.mjs), on top of the rules below.
    '--settings', JSON.stringify(hookSettings(ROLE_HOOK)),
    '--permission-prompts', 'none',
    '--output-format', 'json',
    ...(allowed.length ? ['--allowedTools', ...allowed] : []),
    ...(disallowed.length ? ['--disallowedTools', ...disallowed] : []),
    ...dirs.flatMap((d) => ['--add-dir', d]),
  ];
  return { bin: claude, args, cwd: settings.root, role: step.role, model: model ?? role.model, effort: role.effort ?? null, env: sessionEnv(step, settings, { roots, roleRules, trees }) };
}

// The environment a role session gets from the runner, which it can't change: a session has no way to set a variable for
// its own commands (the hook refuses an assignment, and `env`, `export` and `unset`). The hook's config, and the markers the
// scripts read to refuse their dangerous flags on their own (`ui-labels --source`, `visual-pack --playwright-from`, and
// the tracker's `download-attachment --out` outside these folders).
export function sessionEnv(step, settings, { roots, roleRules, trees }) {
  const has = (prefix) => roleRules.some((r) => r.startsWith(prefix));
  const config = {
    role: step.role,
    trees: trees.map((t) => ({ path: path.resolve(t.path), branch: t.branch, base: t.base ?? null })),
    roots,
    scripts: ROLE_SCRIPTS[step.role] ?? [],
    write: writableFor(step, settings),
    sources: step.role === 'triage' || trees.length ? [] : [...new Set(settings.targets.map((t) => clonePath(settings, t)).filter(Boolean))],
    playwright: has('Bash(npx playwright'),
    docusaurus: has('Bash(npx docusaurus'),
    npmRun: has('Bash(npm run'),
    commands: commandsOfRules(roleRules),
  };
  return { [ROLE_SESSION_VARIABLE]: step.role, [DOWNLOAD_DIRS_VARIABLE]: JSON.stringify(downloadDirsFor(step, settings)), [HOOK_VARIABLE]: JSON.stringify(config) };
}

// Runs one session; resolves { code, stdout, stderr }.
// The child gets no API key or auth token (`lib/env.mjs`), so the plan pays.
export function spawnClaude({ bin, args, cwd, env: session = {} }, { timeoutMs = 4 * 3600 * 1000, env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env: sessionChildEnv(env, session), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

// The result event of `--output-format json`: turns, the CLI's cost estimate, tokens, the session id.
export function parseResult(stdout) {
  const line = String(stdout ?? '').trim().split('\n').reverse().find((x) => x.trim().startsWith('{'));
  if (!line) return null;
  try {
    const r = JSON.parse(line);
    return {
      isError: Boolean(r.is_error) || r.subtype !== 'success',
      turns: r.num_turns ?? null,
      costUsd: r.total_cost_usd ?? null,
      tokens: r.usage ? { in: r.usage.input_tokens ?? 0, out: r.usage.output_tokens ?? 0, cacheRead: r.usage.cache_read_input_tokens ?? 0, cacheWrite: r.usage.cache_creation_input_tokens ?? 0 } : null,
      session: r.session_id ?? null,
      denials: (r.permission_denials ?? []).length,
      durationMs: r.duration_ms ?? null,
    };
  } catch {
    return null;
  }
}

export function readUsageFromClaude(claude = 'claude', env = process.env) {
  const run = spawnSync(claude, ['-p', '/usage'], { cwd: os.tmpdir(), env: childEnv(env), encoding: 'utf8', timeout: 60 * 1000 });
  const usage = parseUsage(`${run.stdout ?? ''}${run.stderr ?? ''}`);
  return usage.week || usage.session ? usage : null;
}

// ------------------------------------------------------------------ the order of the run

// The runnable steps of a status, one per group: tickets of a group with the same next stage run as one session.
// Finishing first (merged, ready for merge, final review, review comments, answers in, writing), and within a kind the
// higher priority, then the older card. A step whose last session failed, with no person's action since, waits for
// the morning run or a manual one (`retryWaiting`). A start runs here only for a card already in work: one a person
// moved (`byHand`), or one whose recorded start goes on (`again`); a ready group's start is `startable`'s.
export function collectSteps(st, { named = [], includeStart = false, retryWaiting = false } = {}) {
  const groups = new Map();
  for (const t of st.tickets) {
    if (!t.next || t.locked || t.hand) continue;
    if (t.next.waits && !retryWaiting) continue;
    if (named.length && !named.includes(t.key)) continue;
    if (t.next.stage === 'start' && !includeStart && !t.next.byHand && !t.next.again) continue;
    const g = t.group ?? t.key;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  const out = [];
  for (const [group, tickets] of groups) {
    const first = tickets[0];
    const same = tickets.filter((t) => t.next.stage === first.next.stage && (t.next.pr ?? null) === (first.next.pr ?? null) && (t.next.startedBy ?? null) === (first.next.startedBy ?? null));
    out.push({
      ...first.next,
      group,
      keys: same.map((t) => t.key),
      priority: tickets.map((t) => t.priority).sort((a, b) => PRIORITY_RANK[a] - PRIORITY_RANK[b])[0],
      createdAt: tickets.map((t) => t.createdAt).filter(Boolean).sort()[0] ?? null,
      card: first.card,
    });
  }
  return out.sort((a, b) => finishRank(a) - finishRank(b) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || String(a.createdAt ?? '9').localeCompare(String(b.createdAt ?? '9')));
}

// ------------------------------------------------------------------ the steps that need no model

// What a scripted step does, as the tracker and forge operations it calls (for the plan of a dry run).
export function scriptedCalls(step, ledger, settings) {
  const card = ledger?.card?.shortLink ?? ledger?.card?.id ?? step.card?.shortLink;
  const target = (pr) => settings.targets.find((t) => t.id === pr.targets?.[0]) ?? settings.targets.find((t) => t.repo === pr.repo);
  const label = (pr, stage) => (LABEL_OF[stage] && target(pr) ? [`forge set-stage-label --target ${target(pr).id} --number ${pr.number} --stage ${LABEL_OF[stage]}`] : []);
  switch (step.stage) {
    case 'move': {
      if (step.pr) {
        const pr = findPr(ledger, step.pr);
        const after = structuredClone(ledger);
        findPr(after, step.pr).stage = step.to;
        const expected = cardStatusFor(after);
        return [...label(pr, step.to), ...(expected && expected !== step.card?.status ? [`tracker move ${card} --to ${expected}`] : [])];
      }
      return [...ledger.prs.filter((p) => p.number && !p.merged).flatMap((p) => label(p, p.stage)), ...(step.ready ? [`tracker comment ${card} --text <the ready comment>`] : []), `tracker move ${card} --to ${step.to}`];
    }
    case 'follow':
      return [
        ...ledger.prs.filter((p) => p.number && followsMove(p.stage, ledger.left?.status, step.to)).flatMap((p) => label(p, PR_STAGE_OF_STATUS[step.to])),
        ...cardsMovedWith(step, ledger, settings).map((o) => `tracker move ${o.card?.shortLink ?? o.card?.id} --to ${step.to}`),
      ];
    case 'close':
      return step.card?.status === 'done' ? [] : [`tracker move ${card} --to done`];
    case 'videoBlock':
      return [...(ledger.video?.gateComment ? [`tracker comment ${card} --text-file <the gate comment> --unless-header <its first line>`] : []), `tracker move ${card} --to blocked`];
    case 'videoTry':
      return [`the transcriber adapter: ${step.parts?.length ?? 0} part(s)`];
    default:
      return [];
  }
}

// A PR with two cards: a person's move of either card into In translation, or back out of it, is a move for the other
// too, so one chain never runs for one card and not the other. The other tickets of the group that share a PR with this
// one and stand where this card stood, in the pipeline's hands. Only those moves: other moves keep each card on its own.
function cardsMovedWith(step, ledger, settings) {
  const from = ledger.left?.status;
  if (step.to !== 'translation' && from !== 'translation') return [];
  const shared = new Set((ledger.prs ?? []).filter((p) => p.number).map(prId));
  return readAllLedgers(settings.state).filter((o) => o.key !== ledger.key && !step.keys.includes(o.key) && o.group === ledger.group && o.mode === 'pipeline' && o.left?.status === from && o.stages?.close?.status !== 'done' && (o.prs ?? []).some((p) => p.number && shared.has(prId(p)) && followsMove(p.stage, from, step.to)));
}

async function runScripted(step, ctx) {
  const { settings, clients, io } = ctx;
  const key = step.keys[0];
  const ledger = readLedger(settings.state, key);
  const card = ledger.card.shortLink ?? ledger.card.id;
  const target = (pr) => settings.targets.find((t) => t.id === pr.targets?.[0]) ?? settings.targets.find((t) => t.repo === pr.repo);
  const setLabel = async (pr, stage) => {
    const t = target(pr);
    if (LABEL_OF[stage] && t?.labels?.[LABEL_OF[stage]]) await clients.forge.setStageLabel({ target: t.id, number: pr.number, stage: LABEL_OF[stage] });
  };
  const rec = (k, extra = {}) => runRecord({ settings, clients, key: k, stage: step.stage, status: 'done', pr: step.pr, now: (io.now ?? Date.now)(), ...extra });
  switch (step.stage) {
    case 'move': {
      // Each ticket of the step moves its own card: a PR with two cards has two.
      if (step.pr) {
        await setLabel(findPr(ledger, step.pr), step.to);
        for (const k of step.keys) {
          const after = structuredClone(readLedger(settings.state, k));
          findPr(after, step.pr).stage = step.to;
          const expected = cardStatusFor(after);
          if (expected) await clients.tracker.move({ card: after.card.shortLink ?? after.card.id, to: expected });
          await rec(k, { to: step.to });
        }
        return;
      }
      for (const p of ledger.prs.filter((x) => x.number && !x.merged)) await setLabel(p, p.stage);
      for (const k of step.keys) {
        const l = readLedger(settings.state, k);
        const own = l.card.shortLink ?? l.card.id;
        // The chain is done: said on the card once per ready head, and kept apart from what a person writes.
        let result;
        if (step.ready) {
          const since = l.prs.flatMap((p) => p.readyForMerge ?? []).map((r) => r.at).filter(Boolean).sort().at(-1);
          const c = await clients.tracker.comment({ card: own, text: settings.readyComment, unlessHeader: settings.readyComment, ...(since ? { since } : {}) });
          const id = c.id ?? c.existing ?? null;
          if (id) result = JSON.stringify({ posted: { card: [id] } });
        }
        await clients.tracker.move({ card: own, to: step.to });
        await rec(k, { to: step.to, ...(result ? { result } : {}) });
      }
      return;
    }
    case 'follow': {
      for (const p of ledger.prs.filter((x) => x.number && followsMove(x.stage, ledger.left?.status, step.to))) await setLabel(p, PR_STAGE_OF_STATUS[step.to]);
      // The other card first: a stop here leaves this ticket's move still to follow, and the run starts it again.
      for (const o of cardsMovedWith(step, ledger, settings)) {
        await clients.tracker.move({ card: o.card.shortLink ?? o.card.id, to: step.to });
        await runRecord({ settings, clients, key: o.key, stage: 'follow', status: 'done', to: step.to, now: (io.now ?? Date.now)() });
      }
      for (const k of step.keys) await rec(k, { to: step.to });
      return;
    }
    case 'close': {
      // The PRs first: the cleanup removes nothing unless every one is merged.
      const states = new Map();
      for (const p of ledger.prs.filter((x) => x.number)) states.set(prId(p), (await clients.forge.prState({ repo: p.repo, number: p.number })).state);
      const now = await clients.tracker.findCards({ link: card });
      if (now.cards[0]?.status !== 'done') await clients.tracker.move({ card, to: 'done' });
      for (const k of step.keys) {
        const l = readLedger(settings.state, k);
        const cleanup = cleanupTicket({ settings, ledger: l, prState: (p) => states.get(prId(p)) ?? null, trashDir: trashOf(settings, io) });
        await rec(k, { result: JSON.stringify({ cleanup }) });
      }
      return;
    }
    case 'readyForMerge':
      // Its record checks the UA → EN image pairs in the PR's worktree: made or brought up to date first.
      for (const p of prsForStep({ ...step, stage: 'align' }, [ledger])) (io.ensureWorktree ?? ensureWorktree)(settings, p);
      for (const k of step.keys) await rec(k, { head: step.head });
      return;
    case 'planApproval':
      for (const k of step.keys) await rec(k);
      return;
    case 'videoTry': {
      // The transcriber is the host's adapter (the video gate's own task builds it). Without one, every try fails
      // at once, which is the fallback to the person.
      const parts = [];
      for (const file of step.parts ?? []) {
        const r = io.transcriber ? await io.transcriber.tryPart({ ledger, file, settings }) : { outcome: 'failed', reason: 'no transcriber adapter is installed' };
        parts.push({ file, ...r });
      }
      await rec(key, { result: JSON.stringify({ parts }) });
      return;
    }
    case 'videoBlock': {
      const gate = ledger.video?.gateComment;
      let commentId = null;
      if (gate) {
        const c = await clients.tracker.comment({ card, text: gate, unlessHeader: gate.split('\n')[0], since: ledger.video.at });
        commentId = c.id ?? c.existing ?? null;
      }
      await clients.tracker.move({ card, to: 'blocked' });
      const asked = (ledger.video?.videos ?? []).flatMap((v) => v.parts).filter((p) => !p.transcript).slice(0, settings.video.partsPerDay).map((p) => p.file);
      await rec(key, { result: JSON.stringify({ commentId, asked, posted: { card: commentId ? [commentId] : [] } }) });
      return;
    }
    default:
      throw new Error(`no scripted handler for ${step.stage}`);
  }
}

export const trashOf = (settings, io = {}) => io.trashDir ?? settings.cleanup.trashDir ?? path.join(os.homedir(), '.Trash');

// ------------------------------------------------------------------ the weekly roles proposal

// From the last 7 days of runs: a role whose steps often needed the retry with the next model up gets that model
// proposed; a role with many steps, no failure and no retry at high effort gets a lower effort proposed. For a yes or
// no in the report; nothing changes on its own.
export function proposeRoles(ledgers, settings, now = Date.now()) {
  const since = new Date(now - 7 * 86400000).toISOString();
  const proposals = [];
  for (const role of ROLES) {
    // A session that ended on a busy browser lock says nothing about the model: left out.
    const runs = ledgers.flatMap((l) => l.runs ?? []).filter((r) => r.role === role && r.outcome !== 'busy' && String(r.start ?? '') >= since);
    if (!runs.length) continue;
    const steps = runs.filter((r) => !r.retryOf).length;
    const retried = runs.filter((r) => r.retryOf).length;
    const failed = runs.filter((r) => r.outcome && r.outcome !== 'done').length;
    const current = settings.roles[role];
    const up = nextModelUp(current.model, settings.modelLadder);
    if (steps >= 5 && retried / steps >= 0.3 && up) proposals.push({ role, change: `model ${current.model} → ${up}`, why: `${retried} of ${steps} steps needed the retry with ${up}` });
    else if (steps >= 10 && !failed && !retried && current.effort === 'high') proposals.push({ role, change: 'effort high → medium', why: `${steps} steps, none failed or needed a retry` });
  }
  return { at: new Date(now).toISOString(), since, proposals };
}

// ------------------------------------------------------------------ the run

export async function runDaily({ settings, clients, io = {}, options = {} }) {
  // `progress.begun` turns true once the run starts its first step: a caller can tell a run that failed before doing
  // anything (safe to start again) from one that failed part way.
  const { dryRun = false, morning = false, trigger = 'schedule', named = [], claude = 'claude', progress = {} } = options;
  const clock = io.now ?? Date.now;
  const manual = trigger === 'manual';
  // A failed step that waits for a person runs again once at the next morning run, or when the owner runs it by hand.
  const retryWaiting = manual || morning;
  const observe = settings.mode === 'observe' && !dryRun;
  const planOnly = dryRun || observe;
  const date = localDate(clock());
  const out = { mode: settings.mode, dryRun, observe, trigger, morning, named, planned: [], ran: [], triage: null, starts: [], guard: [], notes: [...(settings.settingsNotes ?? [])] };
  const log = [];
  const say = (e) => log.push({ at: new Date(clock()).toISOString(), ...e });
  if (settings.mode === 'off') {
    out.stopped = 'mode off: nothing runs';
    return out;
  }

  const readUsage = io.readUsage ?? (() => readUsageFromClaude(claude, io.claudeEnv));
  let usage = await readUsage();
  out.usage = usage;
  // Why a scheduled model step may not start now, or null.
  const guardReason = () => {
    if (manual) return null;
    const a = allowanceOf(usage, settings.limits, new Date(clock()));
    if (!a) return 'no usage reading: no scheduled start';
    if (a.remaining <= 0) return `the week is at ${a.used}%, the allowance by now is ${a.cap}%`;
    return null;
  };
  const guard = (what, group = null) => {
    const reason = guardReason();
    if (reason) say({ kind: 'guard', reason, what, ...(group ? { group } : {}) });
    return !reason;
  };
  const sessionNear = () => (usage?.session?.percent ?? 0) >= (settings.limits.sessionPercent ?? 80);

  // Stale locks: moved aside, their running stages recorded failed.
  if (!planOnly) {
    for (const lock of allLocks(settings.state, clock())) {
      if (lock.live) continue;
      const r = runUnlock({ settings, group: lock.group, stale: true, now: clock() });
      say({ kind: 'lock', group: lock.group, outcome: 'released', note: `stale lock moved aside; ${r.failed.length} stage(s) recorded failed` });
    }
  }

  const own = new Set();
  // The tickets this run already started or tried to: a start that failed holds no slot in the run's later
  // calculations, so the run tries the next group; the failed one waits as any failed step does.
  const tried = new Set();
  const status = () => computeStatus({ settings, clients, usage, now: clock(), ignoreLocks: own, tried, retryWaiting });
  let st = await status();
  out.before = summary(st);

  // Plan a dry run: describe, start nothing.
  const describe = (step) => {
    const l = readLedger(settings.state, step.keys[0]);
    if (!step.role) {
      const d = { ...pick(step), runs: 'no model', calls: l ? scriptedCalls(step, l, settings) : [] };
      if (step.stage === 'close' && l) {
        // What the close step would remove after the merge: listed, nothing removed.
        const views = st.tickets.find((t) => t.key === l.key)?.prs ?? [];
        const c = cleanupTicket({ settings, ledger: l, prState: (p) => views.find((v) => v.id === prId(p))?.state ?? (p.merged ? 'merged' : null), dryRun: true, trashDir: trashOf(settings, io) });
        d.cleanup = { mode: c.mode, wouldRemove: c.removed, keeps: c.kept, freesBytes: c.freedBytes, blocked: c.blocked, worktrees: c.worktrees.map((t) => t.path) };
      }
      return d;
    }
    // The worktrees a live run would make or bring up to date: named, nothing made.
    const trees = prsForStep(step, step.keys.map((k) => readLedger(settings.state, k))).map((p) => ({ repo: p.repo, branch: p.branch, path: worktreePath(settings, p), push: `git -C ${worktreePath(settings, p)} push origin HEAD:refs/heads/${p.branch}` }));
    const codeTrees = CODE_ROLES.has(step.role) ? (settings.appRepos ?? []).map((a) => ({ repo: a.repo, path: codeTreePath(settings, a, '<commit>'), commit: '<fetched at the run>', url: a.url })) : [];
    const cmd = commandFor({ ...step, worktrees: trees, codeTrees }, settings, { model: settings.roles[step.role].model, agentsPath: path.join(settings.state, 'roles', 'agents.json'), claude });
    const held = guardReason();
    return { ...pick(step), runs: `claude -p as ${agentName(step.role)}`, model: cmd.model, effort: cmd.effort, ...(trees.length ? { worktrees: trees.map((t) => t.path) } : {}), ...(held ? { guard: `a live run would not start it: ${held}` } : {}), command: [cmd.bin, ...cmd.args] };
  };

  const finishing = collectSteps(st, { named, includeStart: manual && named.length > 0, retryWaiting });
  if (planOnly) {
    out.planned.push(...finishing.map(describe));
  } else {
    await pool(finishing, sessionNear() ? 1 : settings.limits.parallel, (step) => advance(step));
  }

  // Mornings: triage every intake card quiet for its hours, high priority first, in one session. A manual run that
  // names tickets triages only those.
  if (morning) {
    const due = st.intake.due.filter((c) => !manual || !named.length || named.includes(c.key)).slice(0, settings.limits.triageBatch);
    if (due.length) {
      const step = { stage: 'triage', role: 'triage', keys: due.map((c) => c.key), group: null, cards: due.map((c) => ({ key: c.key, url: c.card.url, shortLink: c.card.shortLink, priority: c.priority })) };
      if (planOnly) out.triage = describe(step);
      else if (guard('triage')) {
        progress.begun = true;
        out.triage = await runModelStep(step, { lockGroups: step.keys });
        st = await status();
      }
    } else out.triage = { note: 'no intake card is due' };
  }

  // Start ready groups while the limits and the allowance allow, in `limits.startOrder`. A group whose earlier start
  // failed carries its failed sessions so far (`prior`): a second failure holds it for the owner.
  const cardsOf = (keys) => keys.map((k) => st.tickets.find((t) => t.key === k)).filter(Boolean).map((t) => ({ key: t.key, url: t.card?.url, shortLink: t.card?.shortLink, priority: t.priority }));
  const startOf = (g, startedBy) => ({ stage: 'start', role: 'writer', group: g.group, keys: g.keys, priority: g.priority, startedBy, cards: cardsOf(g.keys), ...(g.prior ? { prior: g.prior } : {}) });
  // The watcher's run finishes the tickets it names; it starts no ready group (the morning run does).
  if (trigger === 'schedule') {
    if (planOnly) {
      out.starts = st.startable.map((g) => describe(startOf(g, 'schedule')));
    } else {
      while (st.startable.length && guard('start')) {
        const g = st.startable.find((x) => !x.keys.some((k) => tried.has(k)));
        if (!g) break;
        for (const k of g.keys) tried.add(k);
        const r = await advance(startOf(g, 'schedule'));
        out.starts.push(r);
        st = await status();
      }
    }
  } else if (manual && named.length) {
    for (const g of st.groups.filter((x) => x.keys.some((k) => named.includes(k)))) {
      // A start held for the owner after failing twice: as for any held step, a manual run does nothing with it.
      if (g.failedStart?.held?.length) {
        out.notes.push(`group ${g.group}: its start is held for the owner (${g.failedStart.held.map((h) => h.key).join(', ')}); \`ticket-state set retry <key>\` gives it one more try`);
        continue;
      }
      const step = startOf({ ...g, prior: g.failedStart?.sessions ?? 0 }, 'manual');
      out.starts.push(planOnly ? describe(step) : await advance(step));
    }
  }

  // Mornings: the Markdown ledgers from before the JSON ones (`ticket-state import`) whose ticket closed since are
  // removed, each once the check shows its JSON holds every line. No model; a dry run or observe lists them.
  if (morning) {
    try {
      const r = await removeClosedMarkdown({ settings, clients, dryRun: planOnly, trashDir: trashOf(settings, io), now: clock() });
      out.legacyMarkdown = { removed: r.removed, kept: r.kept, failed: r.failed };
      if (!planOnly) for (const x of r.removed) say({ kind: 'legacyMarkdown', key: x.key, file: x.file, outcome: 'removed', to: x.to });
      // A closed ticket's Markdown that fails the check stays; the report's failures say so each morning until it is imported again.
      for (const x of r.kept.filter((k) => k.why.startsWith('closed, but'))) say({ kind: 'legacyMarkdown', key: x.key, file: x.file, outcome: 'failed', note: `${x.file} kept: ${x.why}` });
      // A file whose ticket could not be looked up (the tracker or the forge failing, a ledger that doesn't read) stays,
      // and so does nothing else: the others went on. Each one is in the report's failures.
      for (const x of r.failed) say({ kind: 'legacyMarkdown', key: x.key, file: x.file, outcome: 'failed', note: `${x.file} kept: ${x.error}` });
    } catch (e) {
      say({ kind: 'legacyMarkdown', what: "the Markdown ledgers' removal", outcome: 'failed', note: String(e.message ?? e).split('\n')[0] });
    }
  }

  // A plan whose model steps the guard would hold back says so, in the output and the report.
  if (planOnly && guardReason() && [...out.planned, out.triage, ...out.starts].some((d) => d?.role)) {
    say({ kind: 'guard', reason: `${guardReason()}: a live run would start no model step`, what: 'the plan' });
  }

  // After a live run, the state as the next run finds it: a start that failed in this run waits (for a person or the
  // next morning run), and the report says so.
  st = planOnly ? st : await computeStatus({ settings, clients, usage, now: clock(), ignoreLocks: own });
  out.after = summary(st);
  out.notStarted = st.notStarted;
  out.guard = log.filter((e) => e.kind === 'guard');

  // The report and the run log. A dry run writes neither and prints the report.
  const ledgers = readAllLedgers(settings.state);
  const watched = [];
  for (const job of settings.hostJobs ?? []) {
    if (!job.watch?.board || !job.watch?.list) continue;
    try {
      const r = await clients.tracker.listCardsOn({ board: job.watch.board, list: job.watch.list });
      watched.push({ list: job.watch.list, cards: r.cards });
    } catch (e) {
      out.notes.push(`${job.name}: ${e.message}`);
    }
  }
  const proposal = weeklyProposal(settings, ledgers, clock(), !planOnly);
  const report = renderReport({ settings, st, date, runLog: [...(dryRun ? [] : readRunLog(settings.state, date)), ...log], watched, proposal, ledgers });
  if (dryRun) out.report = report;
  else {
    appendRunLog(settings.state, date, log);
    out.reportFile = path.relative(settings.root, writeReport(settings.state, date, report));
  }
  out.log = log;
  return out;

  // ---------------------------------------------------------------- advancing one group

  // Runs a group's steps one after another, as far as it goes: a scripted step, or one session per step.
  async function advance(first) {
    progress.begun = true;
    const kind = manual ? 'manual' : 'schedule';
    const group = first.group ?? first.keys[0];
    const taken = takeLock(settings.state, { group, kind, stage: first.stage, leaseMinutes: settings.limits.lockLeaseMinutes, now: clock() });
    if (!taken.taken) {
      const h = taken.held;
      if (manual && h?.kind === 'schedule' && h.live) out.notes.push(`group ${group} is held by a scheduled run at ${h.stage}: the manual run stops there`);
      say({ kind: 'lock', group, outcome: 'skipped', note: `locked by a ${h?.kind ?? 'run'} run at ${h?.stage ?? '?'}` });
      return { group, skipped: 'locked' };
    }
    own.add(group);
    const done = [];
    try {
      let step = first;
      for (let i = 0; step && i < settings.limits.stepsPerTicket; i++) {
        if (step.role && !guard(step.stage, step.group)) break;
        const r = step.role ? await runModelStep(step) : await runScriptedStep(step);
        done.push(r);
        ran(r);
        if (r.outcome !== 'done') break;
        const now = await computeStatus({ settings, clients, usage, now: clock(), only: step.keys, ignoreLocks: own });
        const next = collectSteps(now, { named: step.keys, includeStart: false, retryWaiting })[0] ?? null;
        step = next ? { ...next, keys: next.keys.filter((k) => step.keys.includes(k)) } : null;
      }
    } finally {
      own.delete(group);
      releaseLock(settings.state, group);
    }
    return { group, steps: done };
  }

  function ran(r) {
    out.ran.push(r);
  }

  async function runScriptedStep(step) {
    try {
      await runScripted(step, { settings, clients, io });
      say({ kind: 'step', group: step.group, keys: step.keys, stage: step.stage, pr: step.pr ?? null, outcome: 'done' });
      return { ...pick(step), outcome: 'done' };
    } catch (e) {
      const note = `${e.message}`.slice(0, 300);
      for (const k of step.keys) await runRecord({ settings, clients, key: k, stage: step.stage, status: 'failed', pr: step.pr, note, now: clock() }).catch(() => {});
      say({ kind: 'step', group: step.group, keys: step.keys, stage: step.stage, pr: step.pr ?? null, outcome: 'failed', note });
      return { ...pick(step), outcome: 'failed', note };
    }
  }

  async function runModelStep(step, { lockGroups = [] } = {}) {
    // Triage has no group yet: each card's key is its lock.
    const held = [];
    for (const g of lockGroups) {
      const t = takeLock(settings.state, { group: g, kind: manual ? 'manual' : 'schedule', stage: step.stage, leaseMinutes: settings.limits.lockLeaseMinutes, now: clock() });
      if (t.taken) held.push(g);
    }
    try {
      // A start is recorded before its session, with its origin (`running`, `--started-by`): a session that dies after
      // moving the card still counts as the start it was, and one that dies before it leaves a ledger whose failed start
      // the failed-step rules hold (a ready card with no ledger gets one here). No record, no session.
      if (step.stage === 'start') {
        try {
          await recordStart(step);
        } catch (e) {
          const note = `the start was not recorded before its session, so none ran: ${String(e.message ?? e).split('\n')[0]}`.slice(0, 300);
          say({ kind: 'step', group: step.group, keys: step.keys, stage: step.stage, pr: null, role: step.role, outcome: 'failed', note });
          return { ...pick(step), outcome: 'failed', note };
        }
      }
      // The worktrees of the step's PRs, made or brought up to date before the session. If one can't be made, or is
      // stuck (work the runner won't move past, lib/worktree.mjs), no session starts: the stage is recorded failed with
      // the reason, and the failed-step rules apply (see the README, "A stuck worktree").
      try {
        const trees = prsForStep(step, step.keys.map((k) => readLedger(settings.state, k))).map((p) => (io.ensureWorktree ?? ensureWorktree)(settings, p));
        const stuck = trees.flatMap((t) => (t.stuck ?? []).map((n) => `${t.path}: ${n}`));
        if (stuck.length) throw new Error(stuck.join('; '));
        // The code as fetched now. One that can't be fetched or checked out is said in the brief, and stops no session.
        const codeTrees = CODE_ROLES.has(step.role) ? (settings.appRepos ?? []).map((a) => (io.ensureCodeTree ?? ensureCodeTree)(settings, a)) : [];
        step = { ...step, worktrees: trees, codeTrees };
      } catch (e) {
        const note = `the worktree: ${String(e.message).slice(0, 400)}`;
        for (const k of step.keys) if (readLedger(settings.state, k)) await runRecord({ settings, clients, key: k, stage: step.stage, status: 'failed', pr: step.pr, note, now: clock() }).catch(() => {});
        // A failed step like a failed session, so the failed-step rules apply (it waits for a person, then holds), with
        // no `start`: no session ran, so it counts toward no cap, cost or report of sessions.
        const marks = await marksOf(step);
        const failures = (step.prior ?? 0) + 1;
        for (const k of step.keys) if (readLedger(settings.state, k)) await runRecord({ settings, clients, key: k, run: JSON.stringify({ stage: step.stage, role: step.role, outcome: 'failed', session: null, note, failures, ...(marks[k] ? { after: marks[k] } : {}) }), pr: step.pr, now: clock() }).catch(() => {});
        say({ kind: 'step', group: step.group, keys: step.keys, stage: step.stage, pr: step.pr ?? null, role: step.role, outcome: 'failed', note });
        return { ...pick(step), outcome: 'failed', note };
      }
      const agentsPath = path.join(settings.state, 'roles', 'agents.json');
      fs.mkdirSync(path.dirname(agentsPath), { recursive: true });
      fs.writeFileSync(agentsPath, JSON.stringify(agentsFile(io.roleDir), null, 2) + '\n');
      let model = settings.roles[step.role].model;
      // Failed sessions of this step in a row with no person's action between them: two hold the ticket for the owner.
      let failures = step.prior ?? 0;
      const ledgered = step.keys.some((k) => readLedger(settings.state, k));
      for (let attempt = 0; attempt < 2; attempt++) {
        const seqBefore = new Map(step.keys.map((k) => [k, readLedger(settings.state, k)?.seq ?? 0]));
        const before = usage?.week?.percent ?? null;
        const cmd = commandFor(step, settings, { model, agentsPath, claude });
        const start = new Date(clock()).toISOString();
        const renew = setInterval(() => {
          for (const g of [step.group, ...held].filter(Boolean)) renewLock(settings.state, g, { leaseMinutes: settings.limits.lockLeaseMinutes, now: clock() });
        }, 5 * 60000);
        let res;
        try {
          res = await (io.spawnClaude ?? spawnClaude)(cmd, io.claudeEnv ? { env: io.claudeEnv } : {});
        } finally {
          clearInterval(renew);
          // The browser lock a session took (`browser-lock.mjs`) and didn't free, crashed or not: freed now, so the next
          // Playwright run doesn't wait for it. A lock another ticket or a hand run holds stays.
          try {
            if (freeBrowserLock(settings.state, { tickets: step.keys }).freed) say({ kind: 'browserLock', group: step.group, stage: step.stage, outcome: 'freed', note: 'the session ended holding the browser lock' });
          } catch {
            // a lock that isn't a folder is left alone
          }
        }
        usage = (await readUsage()) ?? usage;
        const r = parseResult(res.stdout) ?? {};
        const after = usage?.week?.percent ?? null;
        // A session whose `browser-lock.mjs take` gave up on a lock someone else held: waiting, not failed.
        const busy = busyEnded(settings.state, { tickets: step.keys, since: Date.parse(start) }).length > 0;
        const outcome = await gateOf(step, seqBefore, { busy });
        if (outcome === 'failed') failures += 1;
        // What the ticket looks like now the session is over, so its own unrecorded writes never count as a person's.
        const marks = outcome !== 'failed' || !ledgered ? {} : await marksOf(step);
        const run = { stage: step.stage, role: step.role, model, effort: cmd.effort, trigger: manual ? 'manual' : trigger, start, durationMs: r.durationMs, turns: r.turns, costUsd: r.costUsd, tokens: r.tokens, weekPercent: { before, after }, session: r.session, outcome, share: Number((1 / step.keys.length).toFixed(4)), ...(attempt ? { retryOf: settings.roles[step.role].model } : {}), ...(r.denials ? { denials: r.denials } : {}), ...(outcome === 'failed' ? { failures } : {}) };
        for (const k of step.keys) if (readLedger(settings.state, k)) await runRecord({ settings, clients, key: k, run: JSON.stringify({ ...run, ...(marks[k] ? { after: marks[k] } : {}) }), pr: step.pr, now: clock() }).catch(() => {});
        const entry = { kind: 'step', group: step.group, keys: step.keys, stage: step.stage, pr: step.pr ?? null, role: step.role, model, exit: res.code, ...(r.denials ? { denials: r.denials } : {}) };
        if (outcome === 'done') {
          say({ ...entry, outcome });
          return { ...pick(step), model, outcome };
        }
        // No failure counted, no bigger model, no hold: the step runs again at a later check.
        if (outcome === 'busy') {
          say({ ...entry, outcome, note: 'the browser lock was held by someone else: runs again at a later check' });
          return { ...pick(step), model, outcome };
        }
        const up = nextModelUp(model, settings.modelLadder);
        if (failures < 2 && attempt === 0 && up && guard(`${step.stage} retry`, step.group)) {
          say({ kind: 'retry', group: step.group, stage: step.stage, from: model, to: up });
          model = up;
          continue;
        }
        // One line a pair in the report's failures: a first failure only waits (for a person, or the next morning run).
        const twice = failures >= 2;
        const why = twice ? 'failed twice' : !up ? 'failed; no model above to retry with' : 'failed; the guard held the retry';
        const waits = ledgered && !twice;
        say({ ...entry, outcome: waits ? 'waits' : 'failed', note: twice && ledgered ? 'failed twice: held for the owner until a person acts on the ticket or `ticket-state set retry` re-arms it' : waits ? `${why}: runs again after a person acts on the ticket, or once at the next morning run` : why });
        return { ...pick(step), model, outcome: 'failed', note: why };
      }
      return { ...pick(step), outcome: 'failed' };
    } finally {
      for (const g of held) releaseLock(settings.state, g);
    }
  }

  // The runner's own record of a start, before its session: each ticket's start `running`, its origin, and the group it
  // runs with (so the group's lock covers the ticket at once). A ready card with no ledger gets one, with the triage
  // `status` read for it.
  async function recordStart(step) {
    for (const k of step.keys) {
      const view = st.tickets.find((t) => t.key === k);
      const card = step.cards?.find((c) => c.key === k) ?? view?.card;
      const result = { group: step.group ?? k, ...(view?.ledger === 'absent' && view.triage ? { triage: view.triage } : {}) };
      await runRecord({ settings, clients, key: k, stage: 'start', status: 'running', startedBy: startOrigin(step), card: card?.shortLink ?? card?.id, result, now: clock() });
    }
  }

  // The mark of each ticket of a step right after its session failed (`markOf` in lib/rule.mjs). If the world can't be
  // read now, a bare mark: then only `ticket-state set retry` or the morning run gives the step another try.
  async function marksOf(step) {
    try {
      const now = await computeStatus({ settings, clients, usage, now: clock(), only: step.keys, ignoreLocks: own, marks: step.keys });
      return Object.fromEntries(now.tickets.filter((t) => t.mark).map((t) => [t.key, t.mark]));
    } catch {
      return Object.fromEntries(step.keys.map((k) => [k, { at: new Date(clock()).toISOString(), list: null, comments: null, prs: {} }]));
    }
  }

  // Whether the session passed its gate: every ticket recorded the stage done after the session began. A stage left
  // `running` is recorded failed for it, unless the session ended on a busy browser lock (`busy`), which only waits.
  async function gateOf(step, seqBefore, { busy = false } = {}) {
    let ok = true;
    for (const k of step.keys) {
      const l = readLedger(settings.state, k);
      const rec = !l ? null : step.pr ? (() => {
        try {
          const p = findPr(l, step.pr);
          return p.chain?.[step.stage] ?? p.steps?.[step.stage];
        } catch {
          return null;
        }
      })() : l.stages?.[step.stage];
      if (rec?.status === 'running') {
        if (!busy) await runRecord({ settings, clients, key: k, stage: step.stage, status: 'failed', pr: step.pr, note: 'the session ended without recording the stage', now: clock() }).catch(() => {});
        ok = false;
      } else if (!rec || rec.status !== 'done' || rec.seq <= (seqBefore.get(k) ?? 0)) {
        // A plan or a write may end by asking: the `questions` record is then the session's whole result, not a failure.
        // A session that also recorded the stage, even as failed, ended on that record.
        const before = seqBefore.get(k) ?? 0;
        const asked = !step.pr && ['plan', 'write'].includes(step.stage) && (!rec || rec.seq <= before) ? l?.stages?.questions : null;
        if (asked?.status !== 'done' || asked.seq <= before) ok = false;
      }
    }
    return ok ? 'done' : busy ? 'busy' : 'failed';
  }
}

function weeklyProposal(settings, ledgers, now, write) {
  const file = path.join(settings.state, 'roles-proposal.json');
  let last = null;
  try {
    last = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* none yet */
  }
  if (last && now - Date.parse(last.at) < 7 * 86400000) return null;
  const p = proposeRoles(ledgers, settings, now);
  if (write) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(p, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }
  return p;
}

const pick = (s) => ({ stage: s.stage, role: s.role ?? null, group: s.group ?? null, keys: s.keys, ...(s.pr ? { pr: s.pr } : {}), ...(s.to ? { to: s.to } : {}), priority: s.priority ?? null });

function summary(st) {
  return { wip: st.wip, allowance: st.allowance, tickets: st.tickets.length, startable: st.startable.map((g) => g.group), intakeDue: st.intake.due.map((c) => c.key) };
}

async function pool(items, size, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(size, queue.length)) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}
