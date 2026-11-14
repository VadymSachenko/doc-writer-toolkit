import { createRequire } from 'node:module';
import path from 'node:path';
import { CliError } from '../../ui-labels/lib/util.mjs';

const PACKAGES = ['playwright', 'playwright-core', '@playwright/test'];

// Loads Chromium's launcher from the host's own node_modules: this script has no dependency of its own.
// `from` is a folder whose node_modules holds Playwright (the host repo, or --playwright-from).
export function loadPlaywright(from) {
  const require = createRequire(path.join(from, 'package.json'));
  for (const name of PACKAGES) {
    let resolved;
    try {
      resolved = require.resolve(name);
    } catch {
      continue;
    }
    const lib = require(resolved);
    if (lib.chromium) return lib.chromium;
  }
  throw new CliError(
    `Playwright was not found from ${from}. Install it in the docs repo (npm install --save-dev @playwright/test, then npx playwright install chromium), or pass --playwright-from <folder whose node_modules has it> (or set VISUAL_PACK_PLAYWRIGHT_FROM).`,
    { code: 2, data: { missing: ['playwright'] } },
  );
}

// Chromium that cannot resolve any name but a local one: a request to another host fails even if it got past the route.
export async function launchBrowser(chromium) {
  try {
    return await chromium.launch({ args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  } catch (e) {
    throw new CliError(`Chromium could not start: ${String(e.message).split('\n')[0]}. Install it with: npx playwright install chromium`, { code: 2, data: { missing: ['chromium'] } });
  }
}
