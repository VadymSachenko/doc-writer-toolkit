import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CliError, exists } from '../../ui-labels/lib/util.mjs';

// The arguments of the build: every column in one run, so the default locale lands at the base URL and each other
// locale under `<locale>/`. (A build of a single locale puts that locale at the base URL.)
export function buildArgs({ outDir, locales }) {
  return ['build', '--out-dir', outDir, ...locales.flatMap((l) => ['--locale', l])];
}

// Runs the host's own `docusaurus build` into <outDir>. The build writes the host's `.docusaurus/` and caches, as any
// build of the site does. Its output goes to <logFile>; the last lines come back on failure.
export async function buildSite({ root, outDir, locales, logFile }) {
  const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'docusaurus.cmd' : 'docusaurus');
  if (!(await exists(bin))) {
    throw new CliError(`No Docusaurus found in ${root}/node_modules. Install the host's packages, or pass --build-dir <an existing build>.`, { code: 2, data: { missing: ['docusaurus'] } });
  }
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  const log = await fs.open(logFile, 'w');
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(bin, buildArgs({ outDir, locales }), { cwd: root, stdio: ['ignore', log.fd, log.fd] });
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (code !== 0) {
      const tail = (await fs.readFile(logFile, 'utf8')).trim().split('\n').slice(-12).join('\n');
      throw new CliError(`The site build failed (exit ${code}). Log: ${logFile}\n${tail}`, { code: 1 });
    }
  } finally {
    await log.close();
  }
}

// An existing build must hold a site: at least one index.html at its top.
export async function checkBuildDir(dir) {
  if (!(await exists(path.join(dir, 'index.html')))) {
    throw new CliError(`${dir} is not a Docusaurus build: it has no index.html. Pass the folder 'docusaurus build' wrote.`, { code: 2 });
  }
}
