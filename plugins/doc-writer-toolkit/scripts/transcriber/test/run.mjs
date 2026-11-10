#!/usr/bin/env node
// `npm test`: the offline tests always, then the browser test when Playwright and Chromium are there.
//
// Exit 0: both ran and passed. Exit 1: a test failed. Exit 2: the offline tests passed but the browser test did not run,
// because Playwright or Chromium is missing. That is `not run`, never a pass: the regression set shows it as such.
//
// Where Playwright is: a folder whose node_modules has it, in TRANSCRIBER_PLAYWRIGHT_FROM, else in
// VISUAL_PACK_PLAYWRIGHT_FROM (the same folder serves both; CONTRIBUTING.md says how to set it up).
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../lib/playwright.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const node = (file) => spawnSync(process.execPath, ['--test', path.join(HERE, file)], { stdio: 'inherit' }).status;

if (node('offline.test.mjs') !== 0) process.exit(1);

const from = process.env.TRANSCRIBER_PLAYWRIGHT_FROM ?? process.env.VISUAL_PACK_PLAYWRIGHT_FROM;
let reason = null;
if (!from) {
  reason = 'neither TRANSCRIBER_PLAYWRIGHT_FROM nor VISUAL_PACK_PLAYWRIGHT_FROM is set';
} else {
  try {
    const chromium = loadPlaywright(path.resolve(from));
    if (!chromium) throw new Error(`Playwright was not found from ${from}`);
    const browser = await chromium.launch();
    await browser.close();
  } catch (e) {
    reason = e.message.split('\n')[0];
  }
}
if (reason) {
  console.error(
    `transcriber browser test not run: ${reason}.\n` +
      'Set TRANSCRIBER_PLAYWRIGHT_FROM (or VISUAL_PACK_PLAYWRIGHT_FROM) to a folder whose node_modules has playwright, with Chromium installed (npx playwright install chromium).\n' +
      'The offline tests above passed. See CONTRIBUTING.md, "Running the browser test".',
  );
  process.exit(2);
}
process.exit(node('browser.test.mjs') === 0 ? 0 : 1);
