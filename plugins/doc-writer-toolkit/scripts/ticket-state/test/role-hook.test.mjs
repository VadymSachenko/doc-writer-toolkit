import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseShell, segmentMatches } from '../lib/shell-words.mjs';
import { HOOK_VARIABLE, SCRIPT_COMMANDS, commandsOfRules, hookSettings, refusalOf } from '../lib/role-hook.mjs';
import { ROLE_HOOK, ROLE_SCRIPTS, TOOLS_DENIED, briefFor, commandFor, downloadDirsFor, spawnClaude } from '../lib/runner.mjs';
import { ROLE_SESSION_VARIABLE, DOWNLOAD_DIRS_VARIABLE, TRACKER_TEST_VARIABLE } from '../lib/env.mjs';
import { isBareGit, jobCommand, validateJobs } from '../lib/jobs.mjs';
import { loadSettings, localOnly, sharedAtHead } from '../lib/settings.mjs';
import { setLocal } from '../lib/setlocal.mjs';
import { unhandled } from '../lib/world.mjs';
import { host, rawSettings, tmp } from './fakes.mjs';
import { world } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WT = '/work/.worktrees/guide-docs/ticket-71';
const TREE = { repo: 'guide-docs', branch: 'ticket-71', base: 'main', path: WT, push: `git -C ${WT} push origin HEAD:refs/heads/ticket-71` };
const ROOTS = ['/runner/toolkit', '/home/.claude/plugins/cache/doc-writer-toolkit/doc-writer-toolkit/abc123'];
const R = ROOTS[1];
const script = (s, args = '') => `node ${R}/scripts/${s}${args}`;

const stepOf = (role, w, trees = role === 'triage' ? [] : [TREE], over = {}) => ({ stage: role === 'triage' ? 'triage' : 'write', role, keys: ['502'], group: '502', worktrees: trees, ...over });
const commandOf = (role, w, trees) => commandFor(stepOf(role, w, trees), w.settings, { agentsPath: '/x/agents.json', roots: ROOTS });
const configOf = (role, w, trees) => JSON.parse(commandOf(role, w, trees).env[HOOK_VARIABLE]);
const SHARED = () => {
  const w = world({ extra: { workFolder: 'work/tickets/<key>' } });
  const cfg = Object.fromEntries(['triage', 'writer', 'reviewer', 'translator'].map((r) => [r, configOf(r, w)]));
  return { w, cfg, state: w.settings.state, root: w.settings.root };
};

// ---------------------------------------------------------------- the reading of a command

test('words: quotes, backslashes, line continuations and adjacent parts make one word, as a shell reads them', () => {
  const words = (s) => parseShell(s).commands[0].words.map((w) => w.value);
  assert.deepEqual(words(`git log '--output=/x'`), ['git', 'log', '--output=/x']);
  assert.deepEqual(words(`git log --out''put=/x`), ['git', 'log', '--output=/x']);
  assert.deepEqual(words('git log --out""put=/x'), ['git', 'log', '--output=/x']);
  assert.deepEqual(words('git log --out\\put=/x'), ['git', 'log', '--output=/x']);
  assert.deepEqual(words('git log --out\\\nput=/x'), ['git', 'log', '--output=/x'], 'a line continuation joins');
  assert.deepEqual(words(`g'i't "l"og`), ['git', 'log']);
  assert.deepEqual(words('a\\ b "c d" \'e f\''), ['a b', 'c d', 'e f']);
  assert.deepEqual(words('"a\\"b\\\\c\\d"'), ['a"b\\c\\d'], 'inside double quotes a backslash keeps its meaning only before these');
  assert.deepEqual(words("'a\\b'"), ['a\\b'], 'inside single quotes nothing is special');
  assert.deepEqual(words('echo "cost $ 5" a$'), ['echo', 'cost $ 5', 'a$'], 'a $ with no name after it stands for itself');
  assert.deepEqual(words('git show HEAD@{1}'), ['git', 'show', 'HEAD@{1}'], 'braces with no list stay');
});

test('chains, pipes and redirects split into simple commands; each is read on its own', () => {
  const names = (s) => parseShell(s).commands.map((c) => c.words[0]?.value);
  assert.deepEqual(names('a && b || c; d | e |& f & g\nh'), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  const r = parseShell('ls > a 2>&1 2>/dev/null >>b &>c &>>d >|e >!f <g <>h').commands[0];
  assert.deepEqual(r.words.map((w) => w.value), ['ls']);
  assert.deepEqual(r.redirects.map((x) => [x.fd, x.op, x.target.value]), [[null, '>', 'a'], ['2', '>&', '1'], ['2', '>', '/dev/null'], [null, '>>', 'b'], [null, '&>', 'c'], [null, '&>>', 'd'], [null, '>|', 'e'], [null, '>!', 'f'], [null, '<', 'g'], [null, '<>', 'h']]);
  assert.deepEqual(parseShell('ls 2 >a').commands[0].words.map((w) => w.value), ['ls', '2'], 'digits apart from the > are an argument');
  assert.deepEqual(parseShell('"2">a').commands[0].words.map((w) => w.value), ['2'], 'quoted digits are a word');
});

test('what can\'t be known without running it is an error, in either shell, never a guess', () => {
  for (const s of [
    'echo $(id)', 'echo `id`', 'echo "$(id)"', 'echo "`id`"', 'echo $HOME', 'echo "$HOME"', 'echo ${HOME}', 'echo $?', 'echo $$', 'echo $1', "echo $'\\x2d'", 'echo $"x"', 'echo $=x', 'echo $~x', 'echo $+x',
    '(id)', 'cat <(id)', 'echo >(id)', 'cat =(id)', 'ls *(e:id:)', 'f() { id; }', 'a=(1 2)', 'cat <<EOF\nx\nEOF', 'cat <<<x', 'git log --out{put,}=x', 'echo {1..3}', 'echo a{b,c}d', 'echo {a,b',
    '=cat .env', 'echo ==x', "echo 'x", 'echo "x', 'echo \\', 'ls >', 'ls > | cat', 'case x in y) ;; esac', 'echo \u0000', 'echo \u001b[0m',
  ]) assert.ok(parseShell(s).error, s);
  assert.match(parseShell('a'.repeat(100_001)).error, /over 100000/);
  assert.ok(parseShell(42).error);
});

test('one pass: a command at the size limit, built to backtrack, reads in well under the hook\'s deadline', () => {
  const started = Date.now();
  for (const s of [`'${"'".repeat(99_990)}`, '{'.repeat(99_990), `${'*'.repeat(50_000)}a`, `${'"\\\\"'.repeat(20_000)}`, 'a '.repeat(49_000), `cat ${'*'.repeat(99_000)}`]) parseShell(s);
  refusalOf(`cat ${'*'.repeat(2000)}a`, { roots: [], scripts: [] }, { cwd: '/x' });
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});

test('a glob segment is matched with the leading dot, in the wider reading', () => {
  for (const p of ['.env', '.en?', '.en*', '.e*v', '*', '[.]env', '.[e]nv', '.[a-f]nv', '.[!a]nv', '.\\env']) assert.equal(segmentMatches(p, '.env'), true, p);
  for (const p of ['*.md', '.env?', '.[!e]nv', 'env', '\\*']) assert.equal(segmentMatches(p, '.env'), false, p);
});

// ---------------------------------------------------------------- the forms the probes proved, whatever their spelling

const REFUSED = ({ state, root }) => {
  const ui = `${R}/scripts/ui-labels/ui-labels.mjs`;
  const vp = `${R}/scripts/visual-pack/visual-pack.mjs`;
  const tr = `${R}/scripts/tracker/tracker.mjs`;
  return [
    // A file through git's --output, from the task's probes.
    `git log '--output=${root}/.claude/ticket-flow.local.json'`, `git log --out''put=${root}/.claude/settings.local.json`, `git log --out\\put=/x`, `git log "--output" /x`, `git show HEAD --output=/x`, `git diff --output /x`, `git -C ${WT} log '--output=/x'`, `git -C ${WT} diff --ou''tput=/x`, 'git log --output=/x', 'git log -1 --output /x',
    // Scripts' flags that run code.
    `node ${ui} check --sour''ce 'command id'`, `node ${ui} check '--source=command id'`, `node ${ui} "--source" x`, `node ${ui} check --sou\\rce=x`, `node ${vp} --range a..b '--playwright-from' /tmp/x`, `node ${vp} --range a..b --playwright''-from=/tmp/x`,
    // The check label comes off only by the runner, on a person's forward move.
    `node ${R}/scripts/forge/forge.mjs remove-label --repo guide-docs --number 3 --label x`, `node ${R}/scripts/forge/forge.mjs --repo guide-docs remove-label --number 3 --label x`, `node ${R}/scripts/forge/forge.mjs 'remove-label' --repo guide-docs --number 3 --label x`,
    // A browser lock by hand.
    `mkdir ${state}/.play''wright.lock`, `mkdir "${state}/.playwright.lock"`, `mkdir '${state}/.playwright.lock'`, 'mkdir .playwright.lock', `mkdir -p ${state}/tmp/.playwright.lock/x`, `mkdir ${state}/.PLAYWRIGHT.LOCK`, `mkdir ${state}/.playwright-busy`, `mkdir ${state}/.play*`,
    // Writes through read commands.
    'find . -fprint /x', "find . '-fprint' /x", "find . -fpr''int /x", 'find . -fprint0 /x', 'find . -fprintf /x %p', 'find . -fls /x', 'find . -delete', 'find . -exec touch /x ;', 'find . -execdir id ;', 'find . -ok id ;', 'find . -okdir id ;',
    'sort a -o /x', 'sort -o/x a', 'sort --output=/x a', 'sort --compress-program=/x a', 'uniq a /x',
    // Reads of a .env file.
    'cat .env', 'cat ./.env', `cat ${root}/.env`, "cat '.env'", 'cat ".env"', "cat .e''nv", 'cat .e\\nv', 'cat .en?', 'cat .en*', 'cat .e*', 'cat .*', 'cat [.]env', 'cat .ENV', 'cat .env.local', 'cat .env.production', 'cat .env.staging', 'cat .env.anything',
    'cat docs/*', 'cat *', 'head -1 .env', 'tail -n1 .env', 'wc .env', 'nl .env', 'od .env', 'strings .env', 'cut -c1- .env', 'grep . .env', 'grep -e x .env', 'grep -f .env README.md', 'grep --file=.env README.md', 'cat < .env', '< .env', 'cat <.env', 'diff .env /dev/null', 'cmp .env /dev/null',
    'git show HEAD:.env', 'git show HEAD:./.env', `git -C ${WT} show HEAD:docs/.env`, 'git diff --no-index .env /dev/null', 'git cat-file -p HEAD:.env', 'git log -p -- .env', `git -C ${WT} add .env`, `git -C ${WT} commit -F .env`, `git -C ${WT} commit -F.env`, `git -C ${WT} commit --file=.env`,
    `node ${tr} comment abc --text-file .env`, `node ${tr} comment abc --text-file=.env`, `node ${tr} comment abc --text-file='./.env'`, `node ${tr} set-description abc --desc-file .en''v`,
    'grep -r KEY .', 'grep -rn KEY .', 'grep -R KEY .', 'grep --recursive KEY .', 'grep -d recurse KEY .', 'grep --directories=recurse KEY .', 'diff -r . /x', 'diff --recursive . /x', 'git diff --no-index . /x',
    // Chains, pipes, substitutions and redirects: every part is read.
    'git status; cat .env', 'ls && cat .env', 'ls || cat .env', 'ls | cat .env', 'ls & cat .env', 'ls\ncat .env', 'ls | tee /x', 'ls > /x', 'ls >> /x', 'ls >| /x', 'ls &> /x', 'ls 2> /x', 'ls >/hub/.claude/settings.local.json', 'echo x > .env', "ls > '/x'", 'ls > a*', 'ls <> /x', 'ls >& /x',
    'git status && git log --out\'\'put=/x', 'echo $(cat .env)', 'cat $(echo .env)', 'cat `echo .env`', 'cat "$X"', 'cat $X', 'git log $X', '(cat .env)', '{ cat .env; }', 'if true; then cat .env; fi', 'for f in .env; do cat $f; done', '! cat .env', 'bash -c id',
    // Another command through a wrapper or an environment.
    'env cat .env', 'command cat .env', 'builtin cat', 'exec cat .env', 'eval cat .env', '. /x', 'source /x', 'xargs cat', 'nohup id', 'time id', 'sudo id', 'FOO=1 ls', 'NODE_OPTIONS=--require=/x node a', 'GIT_DIR=/x git log', `DOC_TOOLKIT_ROLE_SESSION= node ${ui} check`, `'DOC_TOOLKIT_ROLE_SESSION='x ls`, 'A=1', 'export A=1', `unset ${ROLE_SESSION_VARIABLE}`, 'printenv', 'set -a',
    '/bin/cat README.md', './git log', '../x', 'c?t a', '*', 'python3 -c 1', "pyth''on3 -c 1", 'perl -e 1', "sh -c 'id'", '\\sh -c id', 'curl https://x', 'cp a b', 'mv a b', 'rm a', 'tee /x', 'touch /x', 'dd if=.env of=/x', 'ln -s a b', 'chmod +x a', 'sed -i s/a/b/ c', 'awk 1 a', 'ffmpeg -i a', 'tar cf /x .', 'gh pr merge 1', 'jq -n env', 'unknowntool x',
    // Git beyond the role's own: options before the subcommand, other subcommands, other pushes and fetches.
    'git -c core.pager=id log', "git '-c' x=y log", 'git --exec-path=/x log', 'git --git-dir=/x log', 'git --work-tree=/x status', 'git --config-env=a=b log', `git -C ${WT} -C /x log`, 'git grep -Oid x', 'git clean -fdx', 'git config a b', 'git checkout main', "git 'checkout' main", 'git switch x', 'git reset --hard', 'git rebase x', 'git merge x', 'git stash', 'git tag x', 'git branch -D x', 'git remote add a b', 'git submodule add a', 'git am', 'git apply x', 'git format-patch -o /x', 'git archive -o /x HEAD', 'git bundle create /x HEAD', 'git clone a b', 'git init', 'git update-ref a b', 'git hash-object -w a', 'git worktree add /x', 'git worktree remove /x', 'git ls-remote --upload-pack=id x',
    'git add -A', 'git commit -m x', 'git push', 'git fetch origin', `git -C /other add -A`, `git -C /other commit -m x`, `git -C ${WT} add -f .`, `git -C ${WT} add -fA`, `git -C ${WT} add --force .`, `git -C ${WT} push`, `git -C ${WT} push origin`, `git -C ${WT} push origin +HEAD:refs/heads/ticket-71`, `git -C ${WT} push origin HEAD:refs/heads/main`, `git -C ${WT} push origin :refs/heads/ticket-71`, `git -C ${WT} push --force origin HEAD:refs/heads/ticket-71`, `git -C ${WT} 'push' origin HEAD:refs/heads/main`, `git -C ${WT} fetch origin +refs/heads/main:refs/heads/x`, `git -C ${WT} fetch origin other`, `git -C ${WT} fetch --all`,
    // Node beyond the role's own scripts.
    'node', 'node -e 1', "node '-e' 1", "node --ev''al 1", 'node --require /x a', 'node /tmp/mine.mjs', `node ${R}/scripts/../scripts/tracker/tracker.mjs x`, `node ${R}/scripts/ticket-state/ticket-state.mjs set roles.writer.allowedTools x`, `node ${R}/scripts/ticket-state/ticket-state.mjs 'set' mode on`, `node ${R}/scripts/ticket-state/ticket-state.mjs handover 1`, `node /elsewhere/scripts/tracker/tracker.mjs x`, `node ${R}/scripts/tracker/*.mjs`,
    // Globs that could expand to a flag, from a file a session wrote: `--output=/x`.
    'git log *', 'git log --outp*', `git -C ${WT} diff ?-output=x`, `node ${tr} comment abc *`,
    // npx and npm beyond the role's own.
    'npx some-package', 'npx -p evil playwright test', 'npx --yes playwright test', 'npm install', 'npm ci', 'npm i x', 'npm exec x', 'npm x y', 'npm config set a b',
  ];
};

test('every form a probe or a review proved, and its spellings, is refused in every role', () => {
  const { cfg, state, root } = SHARED();
  for (const [role, c] of Object.entries(cfg)) {
    for (const cmd of REFUSED({ state, root })) assert.ok(refusalOf(cmd, c, { cwd: root }), `${role}: ${cmd}`);
  }
});

test('npm run, npx docusaurus and npx playwright: only in the role that runs them, with no flag that changes what runs or where it writes', () => {
  const { cfg, root } = SHARED();
  const go = (role, cmd) => refusalOf(cmd, cfg[role], { cwd: root });
  for (const c of ['npm run build', 'npm run build -- --locale uk', 'npm run --silent build', 'npx docusaurus build', 'npx docusaurus build --locale en', 'npx docusaurus write-translations --locale tr', 'npx docusaurus clear']) assert.equal(go('translator', c), null, c);
  for (const c of ['npm run --script-shell=/x build', "npm run '--script-shell=/x' build", 'npm run build --script-shell /x', 'npm run --prefix /x build', 'npm run -C /x build', 'npx docusaurus deploy', 'npx docusaurus swizzle', 'npx docusaurus start', 'npx docusaurus build --config /x.js', "npx docusaurus build '--out-dir=/x'", 'npx playwright test']) assert.ok(go('translator', c), c);
  for (const c of ['npx playwright test screenshot-tests/a.spec.ts', 'npx playwright test screenshot-tests/_plan-502-a.spec.ts --workers=1 --reporter=line --project=chromium']) assert.equal(go('writer', c), null, c);
  for (const c of ['npx playwright test --config=/x.js', "npx playwright test '-c' /x.js", 'npx playwright test --output=/hub/.claude', 'npx playwright codegen', 'npx playwright install', 'npx playwright show-report', 'npm run build', 'npx docusaurus build']) assert.ok(go('writer', c), c);
  for (const role of ['triage', 'reviewer']) for (const c of ['npx playwright test x', 'npm run build', 'npx docusaurus build']) assert.ok(go(role, c), `${role}: ${c}`);
});

// ---------------------------------------------------------------- what stages run

test('each stage\'s own commands pass in their real forms: the brief\'s, the role files\' and the skills\'', () => {
  const { w, cfg, state, root } = SHARED();
  const toolkit = (s) => `node ${R}/scripts/${s}`;
  const shared = [
    `${toolkit('ticket-state/ticket-state.mjs')} record 502 --root ${root} --stage write --status done --result '{"prs":[{"repo":"guide-docs","branch":"ticket-71","commits":["abc"]}]}'`,
    `${toolkit('ticket-state/ticket-state.mjs')} record 502 --root ${root} --settings ${root}/.claude/ticket-flow.json --stage plan --status failed --note 'the page is gone, see #12'`,
    `${toolkit('ticket-state/ticket-state.mjs')} record 502 --root ${root} --stage plan --status done --result-file ${state}/tmp/result.json`,
    `${toolkit('ticket-state/ticket-state.mjs')} status --root ${root} --ticket 502`, `${toolkit('ticket-state/ticket-state.mjs')} config --root ${root}`,
    'ls', 'ls -la docs', 'pwd', 'cd /work/repo', `cat ${state}/tmp/x.json`, 'cat docs/page.md', 'head -20 docs/page.md', 'ls .sources/*', 'ls *.md',
    'find docs -name "*.md"', "find . -name '.env.example'", "find docs -type f -name '*.png'", 'git log -1 --format=%H', 'git log --oneline -5', 'git show HEAD:docs/a.md', 'git show --stat HEAD', 'git ls-tree -r HEAD --name-only', 'git status --short', 'git diff --stat', 'cat .env.example', 'git show HEAD:.env.example',
  ];
  const own = {
    triage: [
      `${toolkit('tracker/tracker.mjs')} read-card abc`, `${toolkit('tracker/tracker.mjs')} find-cards --number 2001 --all-boards`, `${toolkit('tracker/tracker.mjs')} comment abc --text-file ${state}/tmp/c.md --unless-header 'Тріаж: документація'`, `${toolkit('tracker/tracker.mjs')} move abc --to ready`, `${toolkit('tracker/tracker.mjs')} add-label abc --label Guide`,
      `${toolkit('ticket-state/ticket-state.mjs')} record 503 --stage triage --status done --card abc --result-file ${state}/tmp/r.json`, 'git ls-tree -r HEAD docs', 'git -C /work/clone ls-tree -r HEAD docs',
    ],
    writer: [
      `${toolkit('tracker/tracker.mjs')} read-card abc`, `${toolkit('tracker/tracker.mjs')} download-attachment abc --attachment 5f --out ${root}/work/tickets/502/video-1.mp4`, `${toolkit('tracker/tracker.mjs')} move abc --to inProgress`, `${toolkit('forge/forge.mjs')} open-pr --repo guide-docs --body-file ${state}/tmp/b.md`, `${toolkit('forge/forge.mjs')} review-on-lines --repo guide-docs --number 3`, `${toolkit('forge/forge.mjs')} add-label --label 'check needed'`,
      `${toolkit('ticket-state/browser-lock.mjs')} take --root ${root} --ticket 502 --wait 9`, `${toolkit('ticket-state/browser-lock.mjs')} free --root ${root} --ticket 502`, `${toolkit('video-parts/video-parts.mjs')} --root ${root} --work work/tickets/502 --video a.mp4`, `${toolkit('ui-labels/ui-labels.mjs')} check --root ${WT}`, `${toolkit('ui-labels/ui-labels.mjs')} lookup 'Зберегти' 'Статус' --root ${WT}`, `${toolkit('screenshot-locales/screenshot-locales.mjs')} paths --root ${WT} --page docs/a.md`,
      `git -C ${WT} add -A`, `git -C ${WT} add -- docs/a.md docs/.assets/b.png`, `git -C ${WT} status --short`, `git -C ${WT} diff origin/main`, `git -C ${WT} log -3`, `git -C ${WT} show HEAD`, `git -C ${WT} worktree list`, `git -C ${WT} commit -m "Write the page"`, `git -C ${WT} commit -m "Say why git push --force is denied" -m "Second paragraph: --output and .env are only words here"`, `git -C ${WT} commit -m .env`,
      TREE.push, `git -C ${WT} fetch origin`, `git -C ${WT} fetch origin ticket-71`, `git -C ${WT} fetch origin main`, `mkdir -p ${WT}/docs/a/.assets`, `mkdir -p ${state}/tmp/run-1`, `mkdir ${root}/work/tickets/502`, 'npx playwright test screenshot-tests/a.spec.ts',
    ],
    reviewer: [`${toolkit('visual-pack/visual-pack.mjs')} --root ${WT} --range origin/main...HEAD`, `git -C ${WT} diff origin/main...HEAD -- docs/a.md`, `git -C ${WT} add -- docs/a.md`, `git -C ${WT} commit -m "Fix the style"`, TREE.push],
    translator: [
      `${toolkit('locale-sync/locale-sync.mjs')} status --root ${WT}`, `${toolkit('locale-sync/locale-sync.mjs')} record --root ${WT} --locale tr docs/a.md`, `${toolkit('screenshot-locales/screenshot-locales.mjs')} pairs --root ${WT} --base origin/main`, `${toolkit('doc-align/doc-align.mjs')} ${WT}/docs/a.md ${WT}/i18n/en/a.md --names ${WT}/doc-kit/names.md`, `${toolkit('ui-labels/ui-labels.mjs')} check --root ${WT}`, `${toolkit('ui-labels/ui-labels.mjs')} sync --root ${WT}`, 'npm run build', 'npx docusaurus build', `git -C ${WT} add -A`, `git -C ${WT} commit -m "Translate the page"`, TREE.push,
    ],
  };
  for (const [role, cmds] of Object.entries(own)) for (const c of [...shared, ...cmds]) assert.equal(refusalOf(c, cfg[role], { cwd: root }), null, `${role}: ${c}`);

  // The push, fetch and record lines the brief itself gives.
  for (const role of ['writer', 'reviewer', 'translator']) {
    const brief = briefFor(stepOf(role, w), w.settings);
    const lines = [...brief.matchAll(/`((?:git -C \/|node )[^`]+)`/g)].map((m) => m[1]).filter((l) => !l.includes('<'));
    assert.ok(lines.length >= 3, brief);
    // The brief names the runner's own toolkit: the config holds every root the session may run from, this one included.
    const c = { ...cfg[role], roots: [...cfg[role].roots, path.resolve(HERE, '../../../')] };
    for (const l of lines) assert.equal(refusalOf(l, c, { cwd: root }), null, `${role}: ${l}`);
  }

  // The rest of a skill's forms: a redirect a skill's command may carry, a pipe of readers.
  for (const c of ['ls docs 2>/dev/null', 'ls docs >/dev/null 2>&1', 'git status --short 2>&1', 'ls docs | wc -l', 'git log --oneline | head -5', 'cat a.md | grep -n x', 'cat a.md | sort | uniq', 'test -f a.md', '[ -f a.md ]', 'ls .env', 'ls -la .env', 'stat .env', 'test -f .env', "grep -n '.env' docs/a.md", 'grep -n .env docs/a.md', "grep -rl 'x' --include='*.md' docs"]) assert.equal(refusalOf(c, cfg.writer, { cwd: root }), null, c);
});

test('no Bash rule a role has is refused by its own hook, so the hook never undoes an allow of the role\'s', () => {
  const { w, cfg, root } = SHARED();
  for (const [role, c] of Object.entries(cfg)) {
    const cmd = commandOf(role, w);
    const allowed = cmd.args.slice(cmd.args.indexOf('--allowedTools') + 1, cmd.args.indexOf('--disallowedTools'));
    const rules = allowed.filter((r) => r.startsWith('Bash(')).map((r) => r.slice(5, -1).replace(/:\*$/, ''));
    assert.ok(rules.length >= 5, role);
    for (const rule of rules) {
      // A plain add or commit is denied in the first layer too: it would land in the hub. Only `-C <worktree>` runs them.
      if (/^git (add|commit)$/.test(rule)) continue;
      const line = rule === 'mkdir' ? `mkdir ${w.settings.state}/tmp/x` : rule === 'npm run' ? 'npm run build' : rule === 'npx docusaurus' ? 'npx docusaurus build' : rule === 'npx playwright' ? 'npx playwright test a.spec.ts' : rule === 'git worktree list' ? rule : rule;
      assert.equal(refusalOf(line, c, { cwd: root }), null, `${role}: ${line}`);
    }
  }
});

test('a step with no worktree: its folders are the state tmp/, the work folder and the clones\' .sources; the worktree-only commands are refused', () => {
  const w = world({ extra: { workFolder: 'work/tickets/<key>' } });
  const c = configOf('writer', w, []);
  const clone = c.sources[0];
  assert.ok(clone);
  for (const line of [`mkdir -p ${clone}/docs/a/.sources/frames`, `mkdir ${w.settings.state}/tmp/x`, `mkdir ${w.settings.root}/work/tickets/502/x`]) assert.equal(refusalOf(line, c, { cwd: w.settings.root }), null, line);
  for (const line of [`mkdir -p ${clone}/docs/a`, `mkdir ${w.settings.root}/.claude/x`, `mkdir ${w.settings.state}/tickets/x`, `mkdir ${w.settings.root}/.git/hooks`, 'mkdir x', `mkdir ${clone}/node_modules/.sources/x`, `git -C ${WT} add -A`]) assert.ok(refusalOf(line, c, { cwd: w.settings.root }), line);
  // A relative folder is read against the shell's folder, from the hook's input.
  assert.equal(refusalOf('mkdir x', c, { cwd: `${w.settings.state}/tmp` }), null);
  assert.ok(refusalOf('mkdir ../x', c, { cwd: `${w.settings.state}/tmp` }));
  assert.ok(refusalOf('mkdir x', c, {}), 'no folder known, no pass');
});

test('a step with no worktree: a read checkout is read-only to mkdir and to the scripts\' paths, but for its .sources/ folders (the clone\'s)', () => {
  const w = world({ extra: { workFolder: 'work/tickets/<key>' } });
  const settings = { ...w.settings, targets: [...w.settings.targets, { ...w.settings.targets[0], id: 'the-hub', path: '.' }] };
  const rc = path.join(path.resolve(settings.state), 'read', 'guide');
  const clone = path.resolve(settings.root, settings.targets[0].path);
  const clones = [{ repo: 'guide-docs', clone, base: 'main', notes: [], read: { path: rc, ref: 'origin/main', commit: 'a'.repeat(40) } }];
  const c = JSON.parse(commandFor(stepOf('writer', w, [], { stage: 'plan', clones }), settings, { agentsPath: '/x/agents.json', roots: ROOTS }).env[HOOK_VARIABLE]);
  assert.deepEqual(c.read, [rc]);
  assert.ok(c.sources.includes(path.resolve(settings.root)), 'the hub is a target');
  for (const line of [`mkdir -p ${rc}/docs/a`, `mkdir ${rc}/docs/a/.assets`, `mkdir -p ${rc}/screenshot-tests/x`]) assert.match(refusalOf(line, c, { cwd: settings.root }), /mkdir in a read checkout, which is read-only but for its \.sources\/ folders/, line);
  assert.match(refusalOf('mkdir x', c, { cwd: `${rc}/docs` }), /read-only/, 'a relative folder too');
  for (const line of [`mkdir -p ${rc}/docs/a/.sources/frames`, `mkdir -p ${clone}/docs/a/.sources/frames`]) assert.equal(refusalOf(line, c, { cwd: settings.root }), null, line);
  // A script with a path in it, or run from it, is refused; through a `.sources/` folder it is the clone's, and passes.
  const sl = script('screenshot-locales/screenshot-locales.mjs');
  const ul = script('ui-labels/ui-labels.mjs');
  for (const line of [`${sl} status ${rc}/docs/x`, `${sl} status --section=${rc}/docs/x`, `${ul} check --root ${rc}`, `${ul} check --root=${rc}/docs`]) assert.match(refusalOf(line, c, { cwd: settings.root }), /a path in a read checkout, which is read-only but for its \.sources\/ folders/, line);
  assert.match(refusalOf(`${sl} status docs/x`, c, { cwd: rc }), /run from a read checkout/);
  assert.match(refusalOf(`${sl} status x`, c, { cwd: `${rc}/docs` }), /run from a read checkout/);
  for (const line of [`${sl} status ${clone}/docs/x`, `${sl} status --out=${rc}/docs/x/.sources/shots`, `${ul} check --root ${clone}`]) assert.equal(refusalOf(line, c, { cwd: settings.root }), null, line);
  assert.equal(refusalOf(`${sl} status x`, c, { cwd: `${rc}/docs/x/.sources` }), null, 'standing in a .sources/ folder: the clone\'s');
  // The reads the brief names run there.
  for (const line of [`git -C ${rc} show HEAD:docs/x/index.md`, `git -C ${rc} log -1`, `cd ${rc}`, `ls ${rc}/docs`]) assert.equal(refusalOf(line, c, { cwd: settings.root }), null, line);
  assert.ok(refusalOf(`git -C ${rc} commit -m x`, c, { cwd: settings.root }), 'never a commit there');
  // A step with a worktree has no read checkout.
  assert.deepEqual(JSON.parse(commandFor(stepOf('writer', w, [TREE], { clones }), settings, { agentsPath: '/x/agents.json', roots: ROOTS }).env[HOOK_VARIABLE]).read, []);
});

// ---------------------------------------------------------------- per-role scripts

test('per-role scripts: triage gets ticket-state and the tracker only; each role only what it runs, in the rules and in the hook', () => {
  const { w, cfg, root } = SHARED();
  const expected = {
    triage: ['ticket-state/ticket-state.mjs', 'tracker/tracker.mjs'],
    writer: ['ticket-state/ticket-state.mjs', 'ticket-state/browser-lock.mjs', 'tracker/tracker.mjs', 'forge/forge.mjs', 'ui-labels/ui-labels.mjs', 'screenshot-locales/screenshot-locales.mjs', 'video-parts/video-parts.mjs'],
    reviewer: ['ticket-state/ticket-state.mjs', 'visual-pack/visual-pack.mjs', 'forge/forge.mjs'],
    translator: ['ticket-state/ticket-state.mjs', 'locale-sync/locale-sync.mjs', 'ui-labels/ui-labels.mjs', 'doc-align/doc-align.mjs', 'screenshot-locales/screenshot-locales.mjs', 'forge/forge.mjs'],
  };
  const sub = (role, s) => (s === 'ticket-state/ticket-state.mjs' ? ' status' : s === 'ticket-state/browser-lock.mjs' ? ' take' : s === 'forge/forge.mjs' && role !== 'writer' ? ' pr-state' : ' x');
  const everyScript = ['tracker/tracker.mjs', 'forge/forge.mjs', 'locale-sync/locale-sync.mjs', 'ui-labels/ui-labels.mjs', 'doc-align/doc-align.mjs', 'screenshot-locales/screenshot-locales.mjs', 'section-state/section-state.mjs', 'visual-pack/visual-pack.mjs', 'video-parts/video-parts.mjs', 'ticket-state/browser-lock.mjs', 'ticket-state/ticket-state.mjs'];
  for (const [role, names] of Object.entries(expected)) {
    assert.deepEqual([...new Set(ROLE_SCRIPTS[role].map((s) => s.split(' ')[0]))].sort(), [...names].sort(), role);
    const cmd = commandOf(role, w);
    const allowed = cmd.args.slice(cmd.args.indexOf('--allowedTools') + 1, cmd.args.indexOf('--disallowedTools'));
    for (const s of everyScript) {
      const rule = allowed.includes(`Bash(node ${R}/scripts/${s}:*)`) || allowed.includes(`Bash(node ${R}/scripts/${s} status:*)`) || allowed.includes(`Bash(node ${R}/scripts/${s} pr-state:*)`);
      assert.equal(rule, names.includes(s), `${role}: the rule for ${s}`);
      const line = `node ${R}/scripts/${s}${sub(role, s)}`;
      assert.equal(refusalOf(line, cfg[role], { cwd: root }) === null, names.includes(s), `${role}: the hook on ${s}`);
    }
  }
  // The reviewer and the translator read a PR's base with `forge pr-state`, and do nothing else with the forge.
  for (const role of ['reviewer', 'translator']) {
    assert.equal(refusalOf(`node ${R}/scripts/forge/forge.mjs pr-state --repo guide-docs --number 7`, cfg[role], { cwd: root }), null, role);
    for (const c of ['open-pr --repo x', 'comment --repo x', 'add-label --label y', '--repo x pr-state']) assert.ok(refusalOf(`node ${R}/scripts/forge/forge.mjs ${c}`, cfg[role], { cwd: root }), `${role}: ${c}`);
  }
});

test('a host\'s tracked rule opens a command it names in the hook too, unless a role never runs it', () => {
  assert.deepEqual(commandsOfRules(['Bash(jq:*)', 'Bash(git status:*)', 'Bash(python3 -c x)', 'Bash(rm:*)', 'Edit(//x/**)', 'Bash(yq .)']).sort(), ['git', 'jq', 'yq']);
  const w = world({ extra: { roles: { writer: { allowedTools: ['Bash(jq:*)', 'Bash(curl:*)'] } } } });
  const c = configOf('writer', w);
  assert.equal(refusalOf('jq . a.json', c, { cwd: '/x' }), null);
  assert.ok(refusalOf('jq . .env', c, { cwd: '/x' }), 'the shared checks hold');
  assert.ok(refusalOf('jq . > /x', c, { cwd: '/x' }));
  assert.ok(refusalOf('curl https://x', c, { cwd: '/x' }));
});

// ---------------------------------------------------------------- the hook as a process: fail closed

const runHook = (input, env = {}, file = ROLE_HOOK) => spawnSync(process.execPath, [file], { input, encoding: 'utf8', env: { PATH: process.env.PATH, ...env }, timeout: 15000 });
const CONFIG = JSON.stringify({ role: 'writer', trees: [], roots: [R], scripts: ['tracker/tracker.mjs'], write: ['/x'], sources: [] });
const call = (command, cwd = '/x') => JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd });

test('the hook: exit 0 lets a command through, exit 2 refuses it with the reason on standard error', () => {
  const env = { [HOOK_VARIABLE]: CONFIG };
  const ok = runHook(call('ls docs'), env);
  assert.deepEqual([ok.status, ok.stdout, ok.stderr], [0, '', '']);
  const no = runHook(call(`git log --out''put=/x`), env);
  assert.equal(no.status, 2);
  assert.match(no.stderr, /--output/);
  // What a session does next depends on this text: a subagent sees nothing else. It leads to a form that passes, and it
  // keeps the failed record for when none exists.
  assert.match(no.stderr, /Do the same work in a form that passes: one plain command per call, literal paths, or the Read, Grep and Write tools\./);
  assert.match(no.stderr, /Only when no such form exists, record the stage failed with the reason\./);
  assert.doesNotMatch(no.stderr, /another spelling/);
});

test('fail closed: no config, bad input, no command, a stalled input and the deadline all refuse', async () => {
  const env = { [HOOK_VARIABLE]: CONFIG };
  for (const [what, input, e] of [
    ['no config', call('ls'), {}], ['a config that is not JSON', call('ls'), { [HOOK_VARIABLE]: '{nope' }], ['a null config', call('ls'), { [HOOK_VARIABLE]: 'null' }], ['an empty config value', call('ls'), { [HOOK_VARIABLE]: '' }],
    ['empty input', '', env], ['input that is not JSON', 'garbage <<<', env], ['JSON with no tool input', '{}', env], ['JSON null', 'null', env], ['a tool with no command', JSON.stringify({ tool_name: 'Monitor', tool_input: { description: 'x' } }), env], ['a command that is not text', JSON.stringify({ tool_input: { command: ['ls'] } }), env],
  ]) {
    const r = runHook(input, e);
    assert.equal(r.status, 2, what);
    assert.match(r.stderr, /Refused/, what);
  }
  // Input that never ends: the hook's own deadline, well before the CLI's timeout, which would let the command through.
  const child = spawn(process.execPath, [ROLE_HOOK], { env: { PATH: process.env.PATH, ...env, DOC_TOOLKIT_ROLE_HOOK_DEADLINE_MS: '300' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const started = Date.now();
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 2);
  assert.ok(Date.now() - started < 5000);
});

test('the shell line around the hook turns a crash, a missing file or a kill into a refusal, as the probes need', () => {
  const dir = tmp('role-hook-');
  const line = (file) => hookSettings(file).hooks.PreToolUse[0].hooks[0].command;
  const sh = (file) => spawnSync('sh', ['-c', line(file)], { input: call('ls'), encoding: 'utf8', env: { PATH: process.env.PATH, [HOOK_VARIABLE]: CONFIG } });
  assert.equal(sh(ROLE_HOOK).status, 0, 'a clean pass stays a pass');
  const throws = path.join(dir, 'throws.mjs');
  fs.writeFileSync(throws, "throw new Error('boom');\n");
  const syntax = path.join(dir, 'syntax.mjs');
  fs.writeFileSync(syntax, 'not javascript (((\n');
  const kills = path.join(dir, 'kills.mjs');
  fs.writeFileSync(kills, "process.kill(process.pid, 'SIGKILL');\n");
  const one = path.join(dir, 'one.mjs');
  fs.writeFileSync(one, 'process.exit(1);\n');
  for (const f of [throws, syntax, kills, one, path.join(dir, 'missing.mjs'), path.join(dir, "it's here.mjs")]) assert.equal(sh(f).status, 2, f);
  // A missing interpreter too.
  assert.equal(spawnSync('sh', ['-c', hookSettings(ROLE_HOOK, '/no/such/node').hooks.PreToolUse[0].hooks[0].command], { encoding: 'utf8' }).status, 2);
});

// ---------------------------------------------------------------- the runner's wiring

test('a role session carries the hook, its config and the markers; a hub\'s disableAllHooks can\'t switch it off', () => {
  const w = world({ extra: { workFolder: 'work/tickets/<key>' } });
  for (const role of ['triage', 'writer', 'reviewer', 'translator']) {
    const cmd = commandOf(role, w);
    const s = JSON.parse(cmd.args[cmd.args.indexOf('--settings') + 1]);
    assert.equal(s.disableAllHooks, false, role);
    const hook = s.hooks.PreToolUse[0];
    assert.equal(hook.matcher, 'Bash|Monitor', 'Monitor runs a command under the Bash rules');
    assert.ok(hook.hooks[0].command.includes(ROLE_HOOK));
    assert.match(hook.hooks[0].command, /\|\| exit 2$/);
    assert.ok(hook.hooks[0].timeout * 1000 > 20000, 'the CLI\'s timeout is far above the hook\'s own deadline');
    assert.equal(cmd.env[ROLE_SESSION_VARIABLE], role);
    const cfg = JSON.parse(cmd.env[HOOK_VARIABLE]);
    assert.equal(cfg.role, role);
    assert.deepEqual(cfg.roots, ROOTS);
    assert.deepEqual(JSON.parse(cmd.env[DOWNLOAD_DIRS_VARIABLE]), downloadDirsFor(stepOf(role, w), w.settings));
  }
  assert.deepEqual(JSON.parse(commandOf('writer', w).env[DOWNLOAD_DIRS_VARIABLE]), [path.join(w.settings.state, 'tmp'), path.join(w.settings.root, 'work/tickets/502')]);
  assert.deepEqual(JSON.parse(commandOf('triage', w).env[DOWNLOAD_DIRS_VARIABLE]), [path.join(w.settings.state, 'tmp')], 'triage has no work folder');
  const none = world();
  assert.deepEqual(JSON.parse(commandOf('writer', none).env[DOWNLOAD_DIRS_VARIABLE]), [path.join(none.settings.state, 'tmp')], 'no workFolder: only tmp/');
});

test('spawnClaude: the child gets the session\'s markers, and never a billed variable or the tracker\'s test marker', async () => {
  const dir = tmp('role-env-');
  const cmd = { bin: process.execPath, args: ['-e', 'console.log(JSON.stringify(process.env))'], cwd: dir, env: { [ROLE_SESSION_VARIABLE]: 'writer', [HOOK_VARIABLE]: '{}' } };
  const r = await spawnClaude(cmd, { env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'k', [TRACKER_TEST_VARIABLE]: '1', OWN: 'kept' } });
  const seen = JSON.parse(r.stdout);
  assert.equal(seen[ROLE_SESSION_VARIABLE], 'writer');
  assert.equal(seen[HOOK_VARIABLE], '{}');
  assert.equal(seen.OWN, 'kept');
  assert.ok(!('ANTHROPIC_API_KEY' in seen) && !(TRACKER_TEST_VARIABLE in seen));
});

test('a recursive read of .env is refused whatever the flag\'s spelling or a too-wide --include; a file kind passes', () => {
  const { cfg, root } = SHARED();
  const go = (c) => refusalOf(c, cfg.writer, { cwd: root });
  for (const c of [
    "grep -r FAKE . --include='*'", 'grep --directories recurse FAKE .', 'grep --directories=recurse FAKE .', 'grep --dir=rec FAKE .', 'grep --dir recurse FAKE .', 'grep -d recurse FAKE .', 'grep -nd recurse FAKE .', 'grep --recur FAKE .', 'grep --rec FAKE .', 'grep --dereference-rec FAKE .',
    "grep -r FAKE . --include '*'", "grep -r FAKE . --incl='*'", "grep -r FAKE . '--include=.*'", "grep -r FAKE . --include=.env", "grep -r FAKE . --include=.env.md", "grep -r FAKE . '--include=*.foo'", "grep -r FAKE . '--include=*.md' '--include=*'", "grep -r FAKE . '--include=[.]env'", "grep -r FAKE . '--include=?env'", "grep -r FAKE . --include-dir=docs",
    'diff --recur /a /b', 'diff --rec /a /b', 'diff --recursive /a /b', 'diff -ru /a /b', 'diff -r /a /b',
    'sort --out=/x a', 'sort --comp=/x a', 'sort --temporary=/x a',
    `git -C ${WT} add --forc .`, `git -C ${WT} add --fo .`, `git -C ${WT} add --pathspec-from=/x`, `git -C ${WT} add --pathspec-from-file=/x`, `git -C ${WT} add --pathspec=/x`,
  ]) assert.ok(go(c), c);
  for (const c of ["grep -rl 'x' --include='*.md' docs", "grep -r x '--include=*.md' '--include=*.mdx' docs", 'grep -r x --include README.md docs', "grep -R x --include '*.json' docs", "grep --include='*.md' x docs/a.md", 'grep -n x docs/a.md', 'grep --directories=skip x docs/a.md', 'grep -d skip x docs/a.md', 'diff a.md b.md', 'diff -u a.md b.md']) assert.equal(go(c), null, c);
  // An unquoted one is told how to pass, not that it can't.
  assert.match(go('grep -r x --include=*.md docs'), /quote it/);
});

test('ls-remote: the literal form on the worktree, for its branch or base, in the rules and the hook; nothing else', () => {
  const { w, cfg, root } = SHARED();
  for (const role of ['writer', 'reviewer', 'translator']) {
    const cmd = commandOf(role, w);
    const allowed = cmd.args.slice(cmd.args.indexOf('--allowedTools') + 1, cmd.args.indexOf('--disallowedTools'));
    for (const b of ['ticket-71', 'main']) {
      assert.ok(allowed.includes(`Bash(git -C ${WT} ls-remote origin ${b})`), `${role}: ${b}`);
      assert.equal(refusalOf(`git -C ${WT} ls-remote origin ${b}`, cfg[role], { cwd: root }), null, `${role}: ${b}`);
    }
    assert.ok(!allowed.some((r) => /ls-remote.*\*/.test(r)), 'exact rules only');
    for (const c of [`git -C ${WT} ls-remote --upload-pack=id origin main`, `git -C ${WT} ls-remote origin main --upload-pack=id`, `git -C ${WT} '--upload-pack=id' ls-remote`, `git -C ${WT} ls-remote origin other`, `git -C ${WT} ls-remote origin`, `git -C ${WT} ls-remote /elsewhere main`, 'git ls-remote origin main', 'git -C /other ls-remote origin main']) assert.ok(refusalOf(c, cfg[role], { cwd: root }), `${role}: ${c}`);
  }
});

test('reads the first layer lacked: rev-parse in the worktree roles, the role\'s reads on each clone on a step with no worktree, ls in the toolkit roots', () => {
  const w = world({ extra: { workFolder: 'work/tickets/<key>' } });
  const allowedOf = (cmd) => cmd.args.slice(cmd.args.indexOf('--allowedTools') + 1, cmd.args.indexOf('--disallowedTools'));
  for (const role of ['writer', 'reviewer', 'translator']) assert.ok(allowedOf(commandOf(role, w)).includes(`Bash(git -C ${WT} rev-parse:*)`), role);
  const clones = [...new Set(w.settings.targets.map((t) => (t.path ? path.resolve(w.settings.root, t.path) : null)).filter(Boolean))];
  assert.ok(clones.length);
  const reads = { triage: ['log', 'show', 'ls-tree'], writer: ['log', 'show', 'ls-tree', 'status', 'diff'] };
  for (const [role, subs] of Object.entries(reads)) {
    const cmd = commandOf(role, w, []);
    const allowed = allowedOf(cmd);
    for (const clone of clones) {
      for (const s of subs) assert.ok(allowed.includes(`Bash(git -C ${clone} ${s}:*)`), `${role}: ${s} on ${clone}`);
      for (const s of ['add', 'commit', 'push', 'fetch', 'rev-parse', 'worktree list']) assert.ok(!allowed.includes(`Bash(git -C ${clone} ${s}:*)`), `${role}: no ${s} on ${clone}`);
    }
  }
  // On a step with a worktree, a clone has none: the work is in the worktree.
  const withTree = allowedOf(commandOf('writer', w));
  for (const clone of clones) assert.ok(!withTree.some((r) => r.startsWith(`Bash(git -C ${clone} `)), clone);
  // The toolkit roots are reachable and closed to writes.
  for (const role of ['triage', 'writer']) {
    const cmd = commandOf(role, w);
    const added = cmd.args.filter((a, i) => cmd.args[i - 1] === '--add-dir');
    for (const r of ROOTS) {
      assert.ok(added.includes(r), `${role}: ${r}`);
      assert.ok(cmd.args.includes(`Edit(//${r.slice(1)}/**)`), `${role}: writes in ${r} denied`);
      assert.equal(refusalOf(`ls ${r}/scripts`, JSON.parse(cmd.env[HOOK_VARIABLE]), { cwd: w.settings.root }), null);
      assert.ok(refusalOf(`mkdir ${r}/x`, JSON.parse(cmd.env[HOOK_VARIABLE]), { cwd: w.settings.root }), `mkdir in ${r}`);
    }
  }
});

test('no cd into a toolkit root, so the roots being add-dirs opens no write there: same call or its own, plan step or worktree step', () => {
  const w = world({ extra: { workFolder: 'work/tickets/<key>' } });
  const R = ROOTS[0];
  for (const tree of [[], undefined]) {
    const cmd = commandOf('writer', w, tree);
    const cfg = JSON.parse(cmd.env[HOOK_VARIABLE]);
    const at = { cwd: w.settings.root };
    for (const c of [`cd ${R}`, `cd ${R}/scripts/forge`, `cd -P ${R}`, `cd ${R} && mkdir -p .doc-toolkit/x`, `cd ${R} && mkdir -p ${path.relative(w.settings.root, w.settings.state)}/x`, `cd ${R.slice(0, -2)}*`, `cd ${path.dirname(WT)} && cd x`]) assert.ok(refusalOf(c, cfg, at), c);
    assert.ok(refusalOf('cd ../toolkit', cfg, { cwd: path.join(path.dirname(R), 'other') }), 'relative, from the shell\'s folder');
    assert.equal(refusalOf(`ls ${R}/scripts`, cfg, at), null);
    assert.equal(refusalOf(`node ${R}/scripts/ticket-state/ticket-state.mjs status`, cfg, at), null);
    assert.equal(refusalOf(`cd ${WT}`, cfg, at), null);
    assert.equal(refusalOf('cd docs', cfg, at), null);
  }
});

test('a bot\'s comment or review on a PR is not new: it starts no session, whichever way its author is told', () => {
  const pr = { repo: 'guide-docs', number: 7 };
  const at = '2026-11-05T10:00:00Z';
  const activity = {
    comments: [{ id: 1, author: 'netlify', authorBot: true, updatedAt: at }, { id: 2, author: 'netlify[bot]', updatedAt: at }, { id: 3, author: 'someone', updatedAt: at }],
    threads: [{ id: 't', comments: [{ id: 4, author: 'coderabbitai', authorBot: true, updatedAt: at }, { id: 5, author: 'someone', updatedAt: at }, { id: 6, author: 'me', updatedAt: at }] }],
    reviews: [{ id: 7, author: 'github-actions', authorBot: true, state: 'COMMENTED', body: 'a summary', submittedAt: at }, { id: 8, author: 'dependabot[bot]', state: 'COMMENTED', body: 'x', submittedAt: at }, { id: 9, author: 'someone', state: 'COMMENTED', body: 'please fix', submittedAt: at }],
  };
  const out = unhandled({ posted: { pr: [] }, reviewComments: [] }, pr, activity, 'me');
  assert.deepEqual(out.map((c) => [c.id, c.by]), [[5, 'reviewer'], [6, 'owner'], [3, 'reviewer'], [9, 'reviewer']]);
  // A person whose login merely looks close is still a person.
  assert.equal(unhandled({}, pr, { comments: [{ id: 1, author: 'robot', updatedAt: at }, { id: 2, author: 'bot', updatedAt: at }] }, 'me').length, 2);
  // Only bots on the PR: no step.
  assert.deepEqual(unhandled({}, pr, { comments: [{ id: 1, author: 'netlify', authorBot: true, updatedAt: at }] }, 'me'), []);
});

test('whole tools no stage uses are denied in every role; the ones stages use are not, and a host job keeps its own', () => {
  const w = world();
  for (const name of ['Workflow', 'CronCreate', 'CronDelete', 'RemoteTrigger', 'ScheduleWakeup', 'Artifact', 'ArtifactData', 'ArtifactComments', 'SendUserFile', 'PushNotification']) assert.ok(TOOLS_DENIED.includes(name), name);
  for (const role of ['triage', 'writer', 'reviewer', 'translator']) {
    const { args } = commandOf(role, w);
    const after = args.slice(args.indexOf('--disallowedTools') + 1);
    const denied = after.slice(0, after.findIndex((a) => a.startsWith('--')) >>> 0);
    for (const name of TOOLS_DENIED) assert.ok(denied.includes(name), `${role} denies ${name}`);
    for (const name of ['Agent', 'Task', 'Skill', 'Monitor', 'ToolSearch', 'SendMessage', 'TaskStop', 'Read', 'Grep', 'Glob', 'Bash']) assert.ok(!denied.includes(name), `${role} keeps ${name}`);
  }
  const job = jobCommand({ name: 'n', every: 60, run: { skill: 'notes' } }, { settings: w.settings, roots: ROOTS });
  assert.ok(!job.args.includes('Workflow') && !job.args.includes('WebFetch'), 'a job: the toolkit doesn\'t know what it does');
});

// ---------------------------------------------------------------- settings: the rules come from the tracked file

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
function hub({ shared = {}, local = null, commit = true } = {}) {
  const root = host({ shared, local });
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(root, '.gitignore'), '.claude/*.local.json\n');
  if (commit) {
    git(root, 'add', '.gitignore', '.claude/ticket-flow.json');
    git(root, 'commit', '-qm', 'settings');
  }
  return root;
}
const file = (root, name = 'ticket-flow.json') => path.join(root, '.claude', name);

test('a role\'s tool rules come from the tracked file at HEAD: an uncommitted edit counts for nothing, and is named', async () => {
  const root = hub({ shared: { roles: { writer: { allowedTools: ['Bash(jq:*)'] } } } });
  const before = await loadSettings({ root });
  assert.deepEqual(before.roles.writer.allowedTools, ['Bash(jq:*)']);
  assert.deepEqual(before.settingsNotes, []);
  // What a session that got to write the shared file would do.
  fs.writeFileSync(file(root), JSON.stringify(rawSettings({ workFolder: 'anywhere/<key>', state: '.claude/state/', roles: { writer: { allowedTools: ['Bash(curl:*)', 'Edit(//**)'], disallowedTools: [] } }, hostJobs: [{ name: 'x', every: 1, run: { script: 'evil.mjs' } }] })));
  const after = await loadSettings({ root });
  assert.deepEqual(after.roles.writer.allowedTools, ['Bash(jq:*)']);
  assert.equal(after.workFolder, null);
  assert.equal(after.state, before.state);
  assert.deepEqual(after.hostJobs, before.hostJobs);
  assert.match(after.settingsNotes.join(), /uncommitted changes/);
  // Committed, it counts: the owner's own way to change them.
  git(root, 'add', '.claude/ticket-flow.json');
  git(root, 'commit', '-qm', 'more');
  assert.deepEqual((await loadSettings({ root })).roles.writer.allowedTools, ['Bash(curl:*)', 'Edit(//**)']);
});

test('a local file keeps what it legitimately sets; it can\'t widen a session\'s rules, whatever it says', async () => {
  const local = {
    schemaVersion: 1,
    mode: 'on',
    limits: { open: 1, startOrder: 'easiest', dailyPercent: 10 },
    schedule: { morning: '06:30' },
    modelLadder: ['claude-sonnet-5-5'],
    roles: { writer: { model: 'claude-haiku-5-5', effort: 'low', maxTurns: 9, allowedTools: ['Bash(curl:*)'], disallowedTools: [] } },
    workFolder: '.claude/<key>',
    state: '/tmp/elsewhere/',
    targets: [{ id: 'guide', path: '/' }],
    hostJobs: [{ name: 'x', every: 1, run: { script: 'evil.mjs' } }],
    hostRules: { git: '/tmp/planted.md' },
    tracker: { credentials: { envFile: '/tmp/planted.env' } },
  };
  const root = hub({ shared: { roles: { writer: { allowedTools: ['Bash(jq:*)'] } } }, local });
  const s = await loadSettings({ root });
  assert.equal(s.mode, 'on');
  assert.equal(s.limits.open, 1);
  assert.equal(s.limits.startOrder, 'easiest');
  assert.equal(s.limits.dailyPercent, 10);
  assert.equal(s.schedule.morning, '06:30');
  assert.deepEqual(s.modelLadder, ['claude-sonnet-5-5']);
  assert.deepEqual([s.roles.writer.model, s.roles.writer.effort, s.roles.writer.maxTurns], ['claude-haiku-5-5', 'low', 9]);
  assert.deepEqual(s.roles.writer.allowedTools, ['Bash(jq:*)'], 'the tracked rule stays, the local one is gone');
  assert.equal(s.roles.writer.disallowedTools, undefined);
  assert.equal(s.workFolder, null);
  assert.ok(s.state.startsWith(root));
  assert.ok(s.targets.every((t) => t.path !== '/'));
  assert.ok(!s.hostJobs.some((j) => j.name === 'x'));
  assert.ok(!Object.values(s.hostRules).includes('/tmp/planted.md'));
  assert.notEqual(s.tracker.credentials.envFile, '/tmp/planted.env');
  const note = s.settingsNotes.join();
  for (const k of ['workFolder', 'state', 'targets', 'hostJobs', 'hostRules', 'tracker', 'roles.writer.allowedTools', 'roles.writer.disallowedTools']) assert.ok(note.includes(k), k);
  assert.ok(!note.includes('schemaVersion'));
  // The runner's command line, end to end: no injected allow reaches the next session.
  const cmd = commandFor({ stage: 'write', role: 'writer', keys: ['502'], group: '502', worktrees: [TREE] }, s, { agentsPath: '/x', roots: ROOTS });
  const allowed = cmd.args.slice(cmd.args.indexOf('--allowedTools') + 1, cmd.args.indexOf('--disallowedTools'));
  assert.ok(!allowed.includes('Bash(curl:*)'));
  assert.ok(allowed.includes('Bash(jq:*)'));
});

test('a file that is not tracked at HEAD gives the flow its settings but no role tool rules, and says so', async () => {
  const root = hub({ shared: { roles: { writer: { allowedTools: ['Bash(curl:*)'], model: 'claude-haiku-5-5' } } }, commit: false });
  const s = await loadSettings({ root });
  assert.equal(s.roles.writer.allowedTools, undefined);
  assert.equal(s.roles.writer.model, 'claude-haiku-5-5');
  assert.match(s.settingsNotes.join(), /isn't tracked/);
  // No repository at all; a file outside the repository; a file that is broken at HEAD.
  const plain = host({ shared: { roles: { writer: { allowedTools: ['Bash(curl:*)'] } } } });
  assert.equal(sharedAtHead(plain, file(plain)), null);
  assert.equal((await loadSettings({ root: plain })).roles.writer.allowedTools, undefined);
  const repo = hub();
  assert.equal(sharedAtHead(repo, '/elsewhere/x.json'), null);
  fs.writeFileSync(file(repo), 'not json');
  git(repo, 'add', '.claude/ticket-flow.json');
  git(repo, 'commit', '-qm', 'broken');
  assert.equal(sharedAtHead(repo, file(repo)), null);
});

test('localOnly names what it drops, and `set` refuses a role\'s tool rule with the reason', () => {
  assert.deepEqual(localOnly({ mode: 'on', schemaVersion: 1, x: 1, roles: { reviewer: { allowedTools: [], effort: 'low' } } }), { local: { mode: 'on', roles: { reviewer: { effort: 'low' } } }, ignored: ['x', 'roles.reviewer.allowedTools'] });
  assert.deepEqual(localOnly(null), { local: {}, ignored: [] });
  const w = world();
  for (const key of ['roles.writer.allowedTools', 'roles.triage.disallowedTools']) assert.throws(() => setLocal({ settings: w.settings, key, value: '["Bash(node:*)"]' }), (e) => e.exitCode === 2 && /tracked settings file/.test(e.message), key);
});

test('settings validation: a skill job whose allow list opens all of git or all of Bash is refused; a named subcommand and a script job are not', () => {
  const job = (allowedTools, run = { skill: 'notes' }) => [{ name: 'j', every: 60, run: { ...run, allowedTools } }];
  for (const rule of ['Bash(git:*)', 'Bash(git *)', 'Bash(git*)', 'Bash(git)', 'Bash(git -C *)', 'Bash(git -C *:*)', 'Bash( git:* )', 'Bash', 'Bash(*)', 'Bash(*:*)']) {
    assert.equal(isBareGit(rule), true, rule);
    assert.throws(() => validateJobs(job(['Read', rule])), (e) => e.exitCode === 2 && e.message.includes('allowedTools') && e.message.includes(rule), rule);
  }
  for (const rule of ['Bash(git status:*)', 'Bash(git log *)', 'Bash(git -C /x status:*)', 'Bash(github-tool:*)', 'Read', 'Skill', 'Bash(gitleaks detect)']) {
    assert.equal(isBareGit(rule), false, rule);
    assert.doesNotThrow(() => validateJobs(job([rule])), rule);
  }
  assert.doesNotThrow(() => validateJobs(job(['Bash(git:*)'], { script: 'a.mjs' })), 'a script job has no session, and so no rules');
});

test('forge remove-label is refused only as the command, wherever the options put it; a label named so is no command', async () => {
  const { cfg, root } = SHARED();
  const fg = `${R}/scripts/forge/forge.mjs`;
  for (const cmd of [`node ${fg} --dry-run remove-label --repo r --number 3 --label x`, `node ${fg} --repo=r remove-label --number 3 --label x`, `node ${fg} --repo r --number 3 --label x -- remove-label`, `node ${fg} -- remove-label --repo r`]) assert.ok(refusalOf(cmd, cfg.writer, { cwd: root }), cmd);
  for (const cmd of [`node ${fg} add-label --repo r --number 3 --label remove-label`, `node ${fg} --label remove-label add-label --repo r --number 3`]) assert.equal(refusalOf(cmd, cfg.writer, { cwd: root }), null, cmd);
  const { OPTIONS } = await import('../../forge/forge.mjs');
  const booleans = Object.entries(OPTIONS).filter(([, o]) => o.type === 'boolean').flatMap(([k, o]) => [`--${k}`, ...(o.short ? [`-${o.short}`] : [])]);
  assert.deepEqual([...SCRIPT_COMMANDS['forge/forge.mjs'].booleans].sort(), booleans.sort(), "the hook's list of forge's options with no value");
});
