import path from 'node:path';
import { parseShell, segmentMatches } from './shell-words.mjs';

// What the role sessions' PreToolUse hook (`role-hook.mjs`) refuses. The CLI's rules match a command as typed, so a quote
// inside a flag gets past a deny (`--out''put=x`). Here the command is read as a shell reads it, and then an allow list
// decides, per simple command of the line: the command's name, and for those that can write or run something, their
// flags and forms. A form that can't be read without running it is refused. No config, no pass.
//
// The config comes from the runner, in the session's environment (`HOOK_VARIABLE`): a session can't set a variable for
// the hook, whose environment is the CLI's own.
export const HOOK_VARIABLE = 'DOC_TOOLKIT_ROLE_HOOK';

// A name a role never runs, even if a tracked `roles.<role>.allowedTools` names it.
const NEVER = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'python', 'python2', 'python3', 'perl', 'ruby', 'php', 'lua', 'osascript', 'deno', 'bun', 'tsx', 'ts-node',
  'env', 'printenv', 'eval', 'exec', 'source', '.', 'command', 'builtin', 'nohup', 'nice', 'time', 'timeout', 'gtimeout', 'xargs', 'parallel', 'sudo', 'doas', 'su', 'script', 'watch',
  'export', 'unset', 'set', 'declare', 'typeset', 'local', 'readonly', 'alias', 'unalias', 'trap', 'setopt', 'unsetopt', 'shopt', 'zmodload', 'autoload', 'emulate',
  'rm', 'rmdir', 'mv', 'cp', 'ln', 'install', 'touch', 'truncate', 'dd', 'tee', 'chmod', 'chown', 'chflags', 'xattr', 'mkfifo', 'unlink', 'ditto', 'rsync', 'scp', 'ssh', 'sftp', 'curl', 'wget', 'nc',
  'gh', 'ffmpeg', 'ffprobe', 'open', 'launchctl', 'crontab', 'at', 'defaults', 'tar', 'zip', 'unzip', 'sed', 'awk', 'gawk', 'nawk', 'vi', 'vim', 'nano', 'emacs', 'ed', 'ex',
]);
// What any role may run with no rule of its own here but the shared checks (a redirect, a `.env` file). Each reads and
// prints; none writes a file or runs another command. A Bash rule of the role's still has to allow it.
const READERS = new Set(['pwd', 'ls', 'cd', 'cat', 'head', 'tail', 'wc', 'nl', 'od', 'hexdump', 'strings', 'cut', 'tr', 'comm', 'cmp', 'echo', 'printf', 'date', 'stat', 'which', 'basename', 'dirname', 'realpath', 'readlink', 'test', '[', 'true', 'false', 'sleep']);
// Names whose arguments say nothing about a file's content.
const NO_CONTENT = new Set(['cd', 'ls', 'pwd', 'echo', 'printf', 'stat', 'test', '[', 'basename', 'dirname', 'find', 'which', 'realpath', 'readlink', 'mkdir']);

const GIT_GLOBAL = new Set(['--no-pager', '-P', '--no-optional-locks', '--no-replace-objects', '--literal-pathspecs', '--no-lazy-fetch', '--no-advice']);
const GIT_READS = new Set(['status', 'diff', 'log', 'show', 'ls-tree', 'ls-files', 'rev-parse', 'rev-list', 'merge-base', 'blame', 'cat-file', 'shortlog', 'describe', 'name-rev', 'for-each-ref', 'show-ref', 'diff-tree', 'diff-index', 'diff-files', 'check-ignore', 'check-attr', 'count-objects', 'version']);
// A flag of a git read that writes a file, runs a program or reads past the repository, in any place.
const GIT_READ_FLAGS = ['--output', '--no-index', '--ext-diff', '--exec', '--open-files-in-pager', '--upload-pack', '--receive-pack'];
const FIND_WRITES = new Set(['-fprint', '-fprint0', '-fprintf', '-fls', '-exec', '-execdir', '-ok', '-okdir', '-delete']);
const SCRIPT_FLAGS = { 'ui-labels/ui-labels.mjs': ['--source'], 'visual-pack/visual-pack.mjs': ['--playwright-from'] };
// Script commands that are the runner's alone: the check label comes off only on a person's forward move (D-128).
const SCRIPT_COMMANDS = { 'forge/forge.mjs': ['remove-label'] };
const PLAYWRIGHT_FLAGS = ['--config', '-c', '--output', '-o', '--ui', '--ui-host', '--ui-port'];
const DOCUSAURUS_RUNS = new Set(['build', 'write-translations', 'write-heading-ids', 'clear']);
const DOCUSAURUS_FLAGS = ['--config', '--out-dir', '-o', '--bundle-analyzer'];
const NPM_RUN_FLAGS = new Set(['--silent', '-s', '--if-present']);
const OUTPUT_OK = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);
const PROTECTED = new Set(['.git', '.claude', '.github', 'node_modules']);

const LOCK = /\.playwright(\.lock|-busy)/i;
const ENV_FILE = /^\.env(\..+)?$/i;
const isEnvName = (name) => ENV_FILE.test(name) && name.toLowerCase() !== '.env.example';
const ENV_NAMES = ['.env', '.env.local', '.env.development', '.env.production', '.env.test', '.env.staging', '.env.dev', '.env.prod'];
const SEGMENT = /[/:=,@]/;

// Whether a word names a `.env` file: as a path, in `HEAD:.env`, `--file=.env` and `-F.env`, or as a glob that could expand
// to one (`.en*`, `.e?v`, `[.]env`). A glob segment that starts with `.e`, `.?`, `.[` or `.*` counts whatever it matches.
function namesEnvFile(word) {
  const values = [word.glob ? word.pattern : word.value];
  if (/^-[A-Za-z]./.test(values[0])) values.push(values[0].slice(2));
  for (const v of values) {
    for (const seg of v.split(SEGMENT)) {
      if (!word.glob) {
        if (isEnvName(seg)) return true;
      } else if (/^\.[eE?[*]/.test(seg) || /^\[/.test(seg) || ENV_NAMES.some((n) => segmentMatches(seg, n))) return true;
    }
  }
  return false;
}

const flagIs = (value, flag) => value === flag || value.startsWith(`${flag}=`);
// A long flag under any abbreviation GNU and git accept (`--recur`, `--forc`, `--pathspec-from=x`). A prefix two flags
// share is ambiguous to the program, and refused here all the same.
const abbreviates = (value, flag) => {
  const name = value.split('=')[0];
  return name.length >= 3 && name.startsWith('--') && flag.startsWith(name);
};
// A short-flag cluster holding a letter: `-ril` holds `r`; `--recursive` holds nothing here.
const cluster = (value, letter) => /^-[A-Za-z]+$/.test(value) && value.includes(letter);

function checkGit(words, cfg, cwd) {
  let i = 1;
  let dir = null;
  while (i < words.length && words[i].value.startsWith('-')) {
    const v = words[i].value;
    if (v === '-C') {
      if (dir !== null) return 'git with two -C';
      dir = words[i + 1]?.value;
      if (dir === undefined || words[i + 1].glob) return 'git -C needs a plain folder';
      i += 2;
    } else if (GIT_GLOBAL.has(v)) i += 1;
    else return `git ${v} (a git option before the subcommand can change what runs)`;
  }
  const sub = words[i]?.value;
  if (sub === undefined) return null;
  const rest = words.slice(i + 1);
  const values = rest.map((w) => w.value);
  const tree = dir === null ? null : (cfg.trees ?? []).find((t) => t.path === path.resolve(cwd ?? '/', dir));
  if (GIT_READS.has(sub) || (sub === 'worktree' && values[0] === 'list')) {
    const bad = values.find((v) => GIT_READ_FLAGS.some((f) => abbreviates(v, f)));
    return bad ? `git ${sub} ${bad.split('=')[0]} (it writes a file, runs a program or reads past the repository)` : null;
  }
  if (!['add', 'commit', 'push', 'fetch', 'ls-remote'].includes(sub)) return `git ${sub} (no stage runs it)`;
  if (!tree) return `git ${sub} outside \`git -C <the worktree in your brief>\``;
  if (sub === 'add') {
    const bad = values.find((v) => abbreviates(v, '--force') || cluster(v, 'f') || abbreviates(v, '--pathspec-from-file'));
    return bad ? `git add ${bad}` : null;
  }
  // Literal only: `--upload-pack=<cmd>` runs a command.
  if (sub === 'ls-remote') return values.length === 2 && values[0] === 'origin' && [tree.branch, tree.base].filter(Boolean).includes(values[1]) ? null : 'an ls-remote other than `ls-remote origin <branch or base>`';
  if (sub === 'push') return values.length === 2 && values[0] === 'origin' && values[1] === `HEAD:refs/heads/${tree.branch}` ? null : 'a push other than the one in your brief';
  if (sub === 'fetch') {
    const names = [tree.branch, tree.base].filter(Boolean);
    return values[0] === 'origin' && (values.length === 1 || (values.length === 2 && names.includes(values[1]))) ? null : 'a fetch other than `fetch origin` or `fetch origin <branch or base>`';
  }
  return null;
}

function checkNode(words, cfg) {
  const script = words[1]?.value;
  if (script === undefined || words[1].glob) return 'node with no script by name';
  if (script.startsWith('-')) return `node ${script} (roles run scripts by name, no node option)`;
  for (const root of cfg.roots ?? []) {
    for (const entry of cfg.scripts ?? []) {
      const [rel, ...subs] = entry.split(' ');
      if (script !== path.join(root, 'scripts', rel)) continue;
      if (subs.length && words[2]?.value !== subs[0]) continue;
      const own = words.slice(2).find((w) => (SCRIPT_COMMANDS[rel] ?? []).includes(w.value));
      if (own) return `${rel} ${own.value} (the runner's alone)`;
      const flags = SCRIPT_FLAGS[rel] ?? [];
      const bad = words.slice(2).find((w) => flags.some((f) => flagIs(w.value, f)));
      return bad ? `${rel} ${bad.value.split('=')[0]} (it runs code)` : null;
    }
  }
  return `${script}${words[2] ? ` ${words[2].value}` : ''} (not one of this role's scripts)`;
}

function checkNpx(words, cfg) {
  const tool = words[1]?.value;
  const args = words.slice(2).map((w) => w.value);
  if (tool === 'playwright' && cfg.playwright) {
    if (args[0] !== 'test') return `npx playwright ${args[0] ?? ''} (only \`npx playwright test\`)`;
    const bad = args.find((v) => PLAYWRIGHT_FLAGS.some((f) => flagIs(v, f)));
    return bad ? `npx playwright test ${bad.split('=')[0]}` : null;
  }
  if (tool === 'docusaurus' && cfg.docusaurus) {
    if (!DOCUSAURUS_RUNS.has(args[0])) return `npx docusaurus ${args[0] ?? ''} (only ${[...DOCUSAURUS_RUNS].join(', ')})`;
    const bad = args.find((v) => DOCUSAURUS_FLAGS.some((f) => flagIs(v, f)));
    return bad ? `npx docusaurus ${args[0]} ${bad.split('=')[0]}` : null;
  }
  return `npx ${tool ?? ''} (not a tool this role runs)`;
}

function checkNpm(words, cfg) {
  const values = words.slice(1).map((w) => w.value);
  if (!cfg.npmRun || !['run', 'run-script'].includes(values[0])) return `npm ${values[0] ?? ''} (only \`npm run <script>\`, in a role that runs builds)`;
  const end = values.indexOf('--');
  const own = end < 0 ? values.slice(1) : values.slice(1, end);
  const bad = own.find((v) => v.startsWith('-') && !NPM_RUN_FLAGS.has(v));
  return bad ? `npm run ${bad.split('=')[0]} (an npm option can change what runs)` : null;
}

function inside(file, dir) {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// A folder only where a session may write: not a lock, not a protected folder, and inside the step's own folders.
function checkMkdir(words, cfg, cwd) {
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w.value === '-m') {
      i += 1;
      continue;
    }
    if (w.value.startsWith('-')) continue;
    if (w.glob) return `mkdir with a glob: ${w.value}`;
    const file = path.resolve(cwd ?? '/', w.value.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
    const segments = file.split('/');
    if (segments.some((s) => LOCK.test(s))) return 'a browser lock made by hand (browser-lock.mjs takes and frees it)';
    if (segments.some((s) => PROTECTED.has(s.toLowerCase()))) return `a folder under ${segments.find((s) => PROTECTED.has(s.toLowerCase()))}`;
    const open = (cfg.write ?? []).some((d) => inside(file, d)) || (cfg.sources ?? []).some((c) => inside(file, c) && path.relative(c, file).split('/').includes('.sources'));
    if (!open) return `mkdir outside the folders in your brief: ${file}`;
  }
  return null;
}

// Grep takes a value in the next word or after `=`, for a long flag under any abbreviation.
function longValues(values, flag) {
  const out = [];
  values.forEach((v, i) => {
    if (!abbreviates(v, flag)) return;
    out.push(v.includes('=') ? v.slice(v.indexOf('=') + 1) : (values[i + 1] ?? ''));
  });
  return out;
}

// What a `--include` may name: a file by extension, of the kinds a stage searches. Any other glob could match a `.env`
// file (`*`, `.*`, `*.foo` matches `.env.foo`), and a name can't be told safe by what it doesn't match.
const SAFE_INCLUDE = /^\*?[\w-]*(\.[\w-]+)*\.(md|mdx|markdown|txt|json|ya?ml|js|jsx|mjs|cjs|ts|tsx|css|scss|html|svg|sh|py|go)$/i;

function checkGrep(words) {
  const values = words.slice(1).map((w) => w.value);
  const recursive = values.some((v) => abbreviates(v, '--recursive') || abbreviates(v, '--dereference-recursive') || cluster(v, 'r') || cluster(v, 'R'))
    || longValues(values, '--directories').some((v) => v !== '' && 'recurse'.startsWith(v))
    || values.some((v, i) => /^-[A-Za-z]*d$/.test(v) && 'recurse'.startsWith(values[i + 1] ?? 'x'));
  if (!recursive) return null;
  const includes = longValues(values, '--include');
  if (!includes.length) return 'a recursive grep with no --include (it reads every file under the folder, .env too; the Grep tool searches)';
  const open = includes.find((v) => !SAFE_INCLUDE.test(v) || ENV_FILE.test(v));
  return open !== undefined ? `a recursive grep with --include=${open}, which could match a .env file (name a file kind, such as '--include=*.md', or use the Grep tool)` : null;
}

// The words to look for a `.env` file in: all, less what is text rather than a file (a commit's message, grep's pattern).
function fileWords(name, words) {
  const args = words.slice(1);
  if (name === 'git') {
    const at = words.findIndex((w) => w.value === 'commit');
    if (at > 0) {
      const out = [];
      for (let i = 1; i < words.length; i++) {
        const v = words[i].value;
        if (i > at && (v === '-m' || v === '--message')) i += 1;
        else if (i > at && (v.startsWith('-m') || v.startsWith('--message='))) continue;
        else out.push(words[i]);
      }
      return out;
    }
  }
  if (name === 'grep' || name === 'egrep' || name === 'fgrep') {
    const given = args.some((w) => flagIs(w.value, '--regexp') || flagIs(w.value, '--file') || cluster(w.value, 'e') || cluster(w.value, 'f') || /^-[ef]/.test(w.value));
    if (!given) {
      const first = args.findIndex((w) => !w.value.startsWith('-'));
      return args.filter((_, i) => i !== first);
    }
  }
  return args;
}

// The toolkit roots are add-dirs so that `ls` works in them, which would also let a `cd` in: from there a relative path
// the hook reads against the starting folder would land in the root. No work needs a shell standing there.
function checkCd(words, cfg, cwd) {
  for (const w of words.slice(1)) {
    if (w.value.startsWith('-')) continue;
    if (w.glob) return `cd with a glob: ${w.value}`;
    const dir = path.resolve(cwd ?? '/', w.value.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
    if ((cfg.roots ?? []).some((r) => inside(dir, r))) return `a cd into the toolkit (${dir}): run its scripts by their literal path, and read it with ls, Read or Glob`;
  }
  return null;
}

function checkSimple(words, cfg, cwd) {
  const first = words[0];
  if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(first.value)) return `an environment assignment (${first.value.split('=')[0]}=…)`;
  if (first.glob && first.value !== '[') return `a glob as the command: ${first.value}`;
  const name = first.value;
  if (name.includes('/')) return `a command by path: ${name}`;
  if (NEVER.has(name)) return `${name} (no stage runs it)`;
  // A word that starts with a glob could expand to a flag, from a file named `--output=x`: fine only where no flag does harm.
  if (!READERS.has(name)) {
    const risky = words.slice(1).find((w) => w.glob && /^[*?[-]/.test(w.pattern));
    if (risky) return `${name} ${risky.value} (an unquoted glob at the start of a word can expand to a flag; quote it, as in '--include=*.md')`;
  }
  if (!NO_CONTENT.has(name)) {
    const env = fileWords(name, words).find(namesEnvFile);
    if (env) return `a read of a .env file (${env.value}); a process that needs its values reads it itself, and \`.env.example\` is fine`;
  }
  switch (name) {
    case 'git':
      return checkGit(words, cfg, cwd);
    case 'node':
      return checkNode(words, cfg);
    case 'npx':
      return checkNpx(words, cfg);
    case 'npm':
      return checkNpm(words, cfg);
    case 'mkdir':
      return checkMkdir(words, cfg, cwd);
    case 'cd':
      return checkCd(words, cfg, cwd);
    case 'find': {
      const bad = words.slice(1).find((w) => FIND_WRITES.has(w.value));
      return bad ? `find ${bad.value} (it writes a file, removes one or runs a command)` : null;
    }
    case 'grep':
    case 'egrep':
    case 'fgrep':
      return checkGrep(words);
    case 'sort': {
      const bad = words.slice(1).find((w) => abbreviates(w.value, '--output') || abbreviates(w.value, '--compress-program') || abbreviates(w.value, '--temporary-directory') || /^-[A-Za-z]*[oT]/.test(w.value));
      return bad ? `sort ${bad.value.split('=')[0]} (it writes a file or runs a program)` : null;
    }
    case 'uniq':
      return words.slice(1).filter((w) => !w.value.startsWith('-')).length > 1 ? 'uniq with an output file' : null;
    case 'diff':
      return words.slice(1).some((w) => abbreviates(w.value, '--recursive') || cluster(w.value, 'r')) ? 'a recursive diff (it reads every file under the folder, .env too)' : null;
    default:
      return READERS.has(name) || (cfg.commands ?? []).includes(name) ? null : `${name} (no stage runs it)`;
  }
}

function checkRedirect(r) {
  const t = r.target;
  if (!t) return 'a redirect with no target';
  if ((r.op === '>&' || r.op === '<&') && /^(\d+-?|-)$/.test(t.value)) return null;
  if (r.op === '<') {
    if (t.glob || namesEnvFile(t)) return `a read of ${t.value}`;
    return null;
  }
  return OUTPUT_OK.has(t.value) && !t.glob ? null : `a redirect into ${t.value} (files go through the Write tool)`;
}

// The reason a command line is refused, or null. `cfg`: { role, trees: [{ path, branch, base }], roots, scripts, write,
// sources, playwright, docusaurus, npmRun, commands }. `cwd`: the shell's folder, from the hook's input.
export function refusalOf(command, cfg, { cwd } = {}) {
  const parsed = parseShell(command);
  if (parsed.error) return `${parsed.error}: a command this hook can't read without running it. One plain command per call`;
  if (!parsed.commands.length) return 'an empty command';
  // A second `cd` starts from the first one's folder, which the hook doesn't follow.
  if (parsed.commands.filter((c) => c.words[0]?.value === 'cd').length > 1) return 'two cd in one call. One plain command per call';
  for (const c of parsed.commands) {
    for (const r of c.redirects) {
      const why = checkRedirect(r);
      if (why) return why;
    }
    if (!c.words.length) continue;
    const why = checkSimple(c.words, cfg, cwd);
    if (why) return why;
  }
  return null;
}

// What a stage's Bash rules add to the names above: the first word of each rule of the role's, unless it is one a role
// never runs. Only from the role's tracked rules (lib/settings.mjs).
export function commandsOfRules(rules = []) {
  const out = new Set();
  for (const r of rules) {
    const m = /^Bash\(([A-Za-z0-9._-]+)(?::\*| |\))/.exec(r);
    if (m && !NEVER.has(m[1])) out.add(m[1]);
  }
  return [...out];
}

export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The `--settings` value of a role session: the hook, and `disableAllHooks: false`, since a true in the hub's project or
// local layer would otherwise switch it off (probed: the flag layer wins). The CLI lets a command through when its hook
// exits 1, crashes, is killed or prints something else, and only exit 2 or a deny stops it (probed), so `|| exit 2` turns
// every failure into a refusal. A hook the CLI times out is let through, and the shell line dies with it (probed), so
// `timeout` is far above the hook's own deadline (`role-hook.mjs`). Monitor runs a shell command under the Bash rules, and
// a hook on Bash alone doesn't see it (probed).
export const HOOK_TIMEOUT_SECONDS = 120;
export const HOOK_MATCHER = 'Bash|Monitor';
export const hookSettings = (hookFile, node = process.execPath) => ({
  disableAllHooks: false,
  hooks: { PreToolUse: [{ matcher: HOOK_MATCHER, hooks: [{ type: 'command', command: `${shellQuote(node)} ${shellQuote(hookFile)} || exit 2`, timeout: HOOK_TIMEOUT_SECONDS }] }] },
});
