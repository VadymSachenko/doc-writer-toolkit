import * as turboscribe from './turboscribe.mjs';
import { createDriver } from './driver.mjs';

// The transcribers `video.transcriber` may name. One more service is a page module like lib/turboscribe.mjs and one
// line here; the runner and the driver don't change.
const SITES = { turboscribe };

export const TRANSCRIBERS = Object.keys(SITES);

export function createTranscriber(name, { settings, chromium = null, origin } = {}) {
  const site = SITES[name];
  if (!site) throw new Error(`no transcriber named ${name} (one of ${TRANSCRIBERS.join(', ')})`);
  return createDriver({ site, settings, chromium, ...(origin ? { origin } : {}) });
}
