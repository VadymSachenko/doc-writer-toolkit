import fs from 'node:fs/promises';
import path from 'node:path';
import { CliError } from '../../ui-labels/lib/util.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs `fn` while holding `<file>.lock`. One state file is shared by every locale of a page, and the translation
// workers of different locales record in parallel: without the lock, two read-modify-write cycles can lose a locale.
export async function withLock(file, fn, { timeoutMs = 20000, staleMs = 60000 } = {}) {
  const lock = `${file}.lock`;
  await fs.mkdir(path.dirname(lock), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      await (await fs.open(lock, 'wx')).close();
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const st = await fs.stat(lock).catch(() => null);
      if (st && Date.now() - st.mtimeMs > staleMs) {
        await fs.rm(lock, { force: true });
        continue;
      }
      if (Date.now() - start > timeoutMs) throw new CliError(`${lock} is held by another run. Delete it if no locale-sync command is running.`);
      await sleep(20 + Math.random() * 60);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { force: true });
  }
}
