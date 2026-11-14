import { execFile } from 'node:child_process';
import { CliError } from '../../ui-labels/lib/util.mjs';

// The only two places the script starts another program. Both refuse anything that is not a read, so a change that
// adds a write fails here, in one spot, and the test that calls these refusals fails with it.

// What each program may be asked. A git command is the first argument; `fetch` only with the one refspec that
// brings the pull requests' commits into the clone (it changes the clone's refs, never a remote).
export const PULL_FETCH = ['fetch', '--quiet', 'origin', '+refs/pull/*/head:refs/remotes/pr/*'];
const GIT_READS = new Set(['show', 'cat-file']);
const GH_READS = new Set(['pr list', 'pr view']);

export function assertGitRead(args) {
  if (GIT_READS.has(args[0])) return;
  if (args.length === PULL_FETCH.length && args.every((a, i) => a === PULL_FETCH[i])) return;
  throw new CliError(`pipeline-measures only reads: refusing 'git ${args.join(' ')}'`, { code: 1 });
}

export function assertGhRead(args) {
  if (GH_READS.has(`${args[0]} ${args[1]}`)) return;
  throw new CliError(`pipeline-measures only reads: refusing 'gh ${args.join(' ')}'`, { code: 1 });
}

function run(bin, args, { cwd, input, env }) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { cwd, env, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        if (error.code === 'ENOENT') return reject(new CliError(`'${bin}' is not installed or not on PATH`, { code: 2 }));
        return reject(new CliError(`${bin} ${args.slice(0, 2).join(' ')} failed: ${(stderr || error.message).trim().split('\n')[0]}`, { code: 1 }));
      }
      resolve(stdout);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

export const makeGit = (cwd) => async (args, { input } = {}) => {
  assertGitRead(args);
  return run('git', args, { cwd, input });
};

export const makeGh = (cwd) => async (args) => {
  assertGhRead(args);
  return run('gh', args, { cwd });
};
