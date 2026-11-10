import fs from 'node:fs';
import path from 'node:path';
import { loadPlaywright } from './playwright.mjs';

// The transcriber adapter the ticket flow's runner calls at the video gate (`videoTry`, scripts/ticket-state/lib/
// runner.mjs). No model: a script in a browser with a persistent profile (`video.browserProfile`, outside every repo),
// where the owner signed in once by hand. It stores no password and prints no session value: the profile holds the
// session, and nothing here reads its cookies or storage. A site's pages are its own module (lib/turboscribe.mjs).
//
// The contract: `open()` resolves a session, or throws `Busy` when the profile is in use (another run's browser: the
// part waits, it is no failure). A session's `upload({ file, name })` resolves { outcome: 'uploaded', ref } or
// { outcome: 'failed', reason }; `fetch({ ref, dest })` resolves { outcome: 'done' } (the export saved as `dest`),
// { outcome: 'waiting' } or { outcome: 'failed', reason }; `close()` ends it. Each call is one try: nothing here
// tries again. A reason is one of the fixed texts below, never a page's address or content.

export const REASONS = {
  signIn: "a sign-in wall: the browser profile needs the owner's sign-in (transcriber.mjs sign-in)",
  captcha: 'a captcha or a bot check',
  limit: "the day's limit of the transcription service",
  unexpected: 'an unexpected page',
};

export class Busy extends Error {
  constructor(message) {
    super(message);
    this.busy = true;
  }
}

// The kind a page check returned, as the reason the record keeps.
export const reasonOf = (r) => (r.kind === 'unexpected' ? `${REASONS.unexpected} (no ${r.what})` : REASONS[r.kind] ?? REASONS.unexpected);

// An error's first line, cut, with no query or fragment on an address (a sign-in redirect carries its parameters there).
export const plainError = (e) => String(e?.message ?? e).split('\n')[0].replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1').slice(0, 200);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

// One run's browser on the profile at a time: a folder next to it, with the holder's pid; a holder that is gone frees it.
export function takeProfileLock(profile, { pid = process.pid, isAlive = alive } = {}) {
  const dir = `${profile}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid }) + '\n');
      return { taken: true, free: () => fs.rmSync(dir, { recursive: true, force: true }) };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = null;
      try {
        holder = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'));
      } catch {
        // a lock being written, or broken: held
      }
      if (holder?.pid && !isAlive(holder.pid)) {
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      return { taken: false, holder };
    }
  }
  return { taken: false, holder: null };
}

const inUse = (e) => /ProcessSingleton|SingletonLock|profile (?:directory )?is already in use|user data directory is already in use/i.test(String(e?.message ?? e));

// `site`: a page module (lib/turboscribe.mjs). `chromium`: Playwright's launcher (tests), else loaded from the host root.
export function createDriver({ site, settings, chromium = null, origin = site.SITE.origin }) {
  const v = settings.video;
  return {
    name: site.SITE.name,
    async open() {
      const profile = v.browserProfile;
      if (!profile) throw new Error('no browser profile is set (video.browserProfile)');
      const launcher = chromium ?? loadPlaywright(settings.root);
      if (!launcher) throw new Error(`Playwright was not found from ${settings.root}: the hub needs it (npm install --save-dev @playwright/test)`);
      // The owner's only: it holds the sign-in.
      fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
      fs.chmodSync(profile, 0o700);
      const lock = takeProfileLock(profile);
      if (!lock.taken) throw new Busy(`the browser profile is in use by another run${lock.holder?.pid ? ` (pid ${lock.holder.pid})` : ''}`);
      let context;
      try {
        context = await launcher.launchPersistentContext(profile, { headless: Boolean(v.headless), acceptDownloads: true, ...(v.channel ? { channel: v.channel } : {}) });
      } catch (e) {
        lock.free();
        if (inUse(e)) throw new Busy('the browser profile is in use by another browser');
        throw new Error(`the browser did not start: ${plainError(e)}`);
      }
      const page = context.pages()[0] ?? (await context.newPage());
      const failed = (r) => ({ outcome: 'failed', reason: reasonOf(r) });
      return {
        async upload({ file, name }) {
          try {
            const r = await site.uploadFile(page, { file: fs.readFileSync(file), name, origin });
            return r ? failed(r) : { outcome: 'uploaded', ref: { name } };
          } catch (e) {
            return { outcome: 'failed', reason: `${REASONS.unexpected} (${plainError(e)})` };
          }
        },
        async fetch({ ref, dest }) {
          const tmp = `${dest}.download`;
          try {
            const r = await site.exportText(page, { name: ref?.name, origin, saveAs: (d) => d.saveAs(tmp) });
            if (r.kind) return failed(r);
            if (r.outcome !== 'done') return { outcome: 'waiting' };
            const text = fs.readFileSync(tmp, 'utf8');
            if (!site.TIMESTAMP.test(text)) return failed({ kind: 'unexpected', what: 'timestamps in the plain-text export' });
            fs.renameSync(tmp, dest);
            return { outcome: 'done' };
          } catch (e) {
            return { outcome: 'failed', reason: `${REASONS.unexpected} (${plainError(e)})` };
          } finally {
            fs.rmSync(tmp, { force: true });
          }
        },
        async close() {
          try {
            await context.close();
          } catch {
            // already closed (the window shut by hand)
          }
          lock.free();
        },
        page,
      };
    },
  };
}
