import { spawn } from 'node:child_process';
import { scriptEnv } from './env.mjs';

// The chain's site build, run by the runner with no model: the host's build command (`build.command`, no shell) in
// the PR's worktree, with the environment of a host script (no API key, no sign-in token) and `CI=1`. It runs in a
// process group of its own, so a timeout ends the whole build (npm's child, Docusaurus, its workers), not only npm,
// which would leave a build of several gigabytes running. Resolves { code, timedOut, tail }: the last lines of its
// output, for the record of a failed build.

export const TAIL_LINES = 30;
const KEEP_CHARS = 200_000;

export function runSiteBuild({ cwd, command, timeoutMs, env = process.env, killGraceMs = 10000 }) {
  return new Promise((resolve) => {
    const [bin, ...args] = command;
    let out = '';
    let timedOut = false;
    const keep = (d) => {
      out += d;
      if (out.length > KEEP_CHARS * 2) out = out.slice(-KEEP_CHARS);
    };
    let child;
    try {
      child = spawn(bin, args, { cwd, env: scriptEnv(env, { CI: '1' }), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      resolve({ code: 127, timedOut: false, tail: [`could not start ${bin}: ${e.message}`] });
      return;
    }
    const group = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      }
    };
    let hard = null;
    const timer = setTimeout(() => {
      timedOut = true;
      group('SIGTERM');
      hard = setTimeout(() => group('SIGKILL'), killGraceMs);
    }, timeoutMs);
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (e) => {
      clearTimeout(timer);
      clearTimeout(hard);
      resolve({ code: 127, timedOut: false, tail: [`could not start ${bin}: ${e.message}`] });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(hard);
      const tail = out.trim().split('\n').slice(-TAIL_LINES);
      resolve({ code: code ?? (signal ? 128 : 1), timedOut, tail });
    });
  });
}
