import { createRequire } from 'node:module';
import path from 'node:path';

const PACKAGES = ['playwright', 'playwright-core', '@playwright/test'];

// Chromium's launcher from the host's own node_modules: this script has no dependency of its own. `from` is a folder
// whose node_modules holds Playwright (the host repo). Null when none is there.
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
  return null;
}
