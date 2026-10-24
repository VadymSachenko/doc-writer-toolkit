import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseSwitch } from '../lib/config.mjs';

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'screenshot-locales.mjs');

async function cli(cwd, ...args) {
  try {
    const { stdout } = await run('node', [CLI, ...args], { cwd });
    return { code: 0, out: JSON.parse(stdout) };
  } catch (e) {
    return { code: e.code, out: e.stdout?.trim().startsWith('{') ? JSON.parse(e.stdout) : e.stdout };
  }
}

// ------------------------------------------------------------------ a synthetic two-locale host

const PORTAL_EN = 'i18n/en/docusaurus-plugin-content-docs-portal/current';
const DOCS_EN = 'i18n/en/docusaurus-plugin-content-docs/current';
const PAGE = 'portal/transactions/transactions.md';
const UK_LIVE = 'portal/transactions/.assets/filters-pane.png';
const EN_LIVE = `${PORTAL_EN}/transactions/.assets/filters-pane.png`;
const STAGE = '.doc-toolkit/screenshot-staging/portal/transactions/filters-pane';
const MANIFEST = 'portal/transactions/.sources/screenshot-manifest.json';

function claudeMd(extra = []) {
  return [
    '# Host',
    '',
    '## Documentation toolkit configuration',
    '',
    '- **Content language:** `uk`',
    '- **UA content root:** `portal/`',
    `- **EN i18n root:** \`${PORTAL_EN}/\``,
    '- **UA URL prefix:** `/portal/`',
    '- **API reference UA content root:** `docs/`',
    `- **API reference EN i18n root:** \`${DOCS_EN}/\``,
    ...extra,
    '',
  ].join('\n');
}

const MULTI = ['- **Screenshot locales:** `uk, en`', '- **Locale switch:** `url-prefix uk=/, en=/en/`'];

async function host({ extra = MULTI, locales = ['uk', 'en'] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'screenshot-locales-'));
  const write = async (rel, text) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  };
  await write('CLAUDE.md', claudeMd(extra));
  await write('docusaurus.config.ts', `export default {\n  i18n: { defaultLocale: 'uk', locales: ${JSON.stringify(locales)} },\n};\n`);
  await write(PAGE, '---\ntitle: Транзакції\n---\n\n# Транзакції\n');
  await write('docs/webhooks/webhooks.md', '# Вебхуки\n');
  return { root, write, read: (rel) => fs.readFile(path.join(root, rel), 'utf8') };
}

const shot = (over = {}) => ({ shotId: 'filters-pane', page: PAGE, file: 'filters-pane.png', route: '/transactions', uiState: 'filters-open', ...over });
const manifest = (shots = [shot()]) => `${JSON.stringify({ section: 'portal/transactions', scenarios: [{ scenarioId: 'one-payment', seededValues: { amount: '1 500,00' }, shots }] }, null, 2)}\n`;
const lexists = (p) => fs.lstat(p).then(() => true, () => false);

// ------------------------------------------------------------------ config

test('parseSwitch reads the mode, the name and one token per locale', () => {
  assert.deepEqual(parseSwitch('url-prefix uk=/, en=/en/'), { mode: 'url-prefix', name: null, tokens: { uk: '/', en: '/en/' }, problems: [] });
  assert.deepEqual(parseSwitch('query lang uk=uk, en=en').name, 'lang');
  assert.deepEqual(parseSwitch('ui uk=Українська, en=English').tokens, { uk: 'Українська', en: 'English' });
  assert.equal(parseSwitch('cookie uk=uk').problems.length, 1);
  assert.match(parseSwitch('header uk=uk').problems[0], /unknown mode 'header'/);
});

test('a host with no Screenshot locales is single-locale: no manifest, nothing written', async () => {
  const h = await host({ extra: [] });
  const r = await cli(h.root, 'config');
  assert.equal(r.code, 0);
  assert.equal(r.out.multilocale, false);
  await h.write(MANIFEST, manifest());
  const before = await h.read(MANIFEST);
  const res = await cli(h.root, 'resolve', MANIFEST);
  assert.equal(res.code, 2);
  assert.equal(res.out.multilocale, false);
  assert.equal(await h.read(MANIFEST), before);
  assert.equal(await lexists(path.join(h.root, '.doc-toolkit')), false);
});

test('config resolves every locale folder of every root pair, and the switch', async () => {
  const h = await host({ extra: [...MULTI, '- **Locale env prefix:** `en=EN_`'] });
  const r = await cli(h.root, 'config');
  assert.equal(r.code, 0, JSON.stringify(r.out));
  assert.deepEqual(r.out.locales, ['uk', 'en']);
  assert.deepEqual(r.out.roots, { primary: { uk: 'portal', en: PORTAL_EN }, 'api-reference': { uk: 'docs', en: DOCS_EN } });
  assert.deepEqual(r.out.switch.tokens, { uk: '/', en: '/en/' });
  assert.deepEqual(r.out.envPrefix, { en: 'EN_' });
  assert.equal(r.out.staging, '.doc-toolkit/screenshot-staging');
});

test('a further locale derives its folder from the EN root', async () => {
  const h = await host({ extra: ['- **Screenshot locales:** `uk, en, de`', '- **Locale switch:** `query lang uk=uk, en=en, de=de`'], locales: ['uk', 'en', 'de'] });
  const r = await cli(h.root, 'config');
  assert.equal(r.code, 0, JSON.stringify(r.out));
  assert.equal(r.out.roots.primary.de, 'i18n/de/docusaurus-plugin-content-docs-portal/current');
});

test('a locale docusaurus.config lacks is never guessed: exit 2, every problem listed, nothing created', async () => {
  const h = await host({ extra: ['- **Screenshot locales:** `uk, en, fr`', '- **Locale switch:** `url-prefix uk=/, en=/en/`'] });
  const r = await cli(h.root, 'config');
  assert.equal(r.code, 2);
  const messages = r.out.problems.map((p) => p.message).join('\n');
  assert.match(messages, /'fr' is not a locale of docusaurus\.config/);
  assert.match(messages, /no token for 'fr'/);
  assert.equal(await lexists(path.join(h.root, 'i18n/fr')), false);
});

test('two locales need a switch; one locale does not', async () => {
  let h = await host({ extra: ['- **Screenshot locales:** `uk, en`'] });
  let r = await cli(h.root, 'config');
  assert.equal(r.code, 2);
  assert.match(r.out.problems[0].message, /No Locale switch/);
  h = await host({ extra: ['- **Screenshot locales:** `uk, en`', '- **Locale switch:** `ui uk=Українська, en=English`'] });
  r = await cli(h.root, 'config');
  assert.equal(r.code, 2);
  assert.match(r.out.problems[0].message, /Locale switch path/);
  h = await host({ extra: ['- **Screenshot locales:** `en`'] });
  r = await cli(h.root, 'config');
  assert.equal(r.code, 0);
  assert.deepEqual(r.out.locales, ['en']);
});

test('an explicitly locale-scoped request must name a declared screenshot locale', async () => {
  const h = await host();
  assert.equal((await cli(h.root, 'config', '--locales', 'en')).out.requested[0], 'en');
  const r = await cli(h.root, 'config', '--locales', 'de');
  assert.equal(r.code, 2);
  assert.match(r.out.problems[0].message, /'de' is not a declared screenshot locale/);
});

// ------------------------------------------------------------------ resolve

test('resolve fans a shot out to every declared locale and creates no locale folder', async () => {
  const h = await host();
  await h.write(MANIFEST, manifest());
  const r = await cli(h.root, 'resolve', MANIFEST);
  assert.equal(r.code, 0, JSON.stringify(r.out));
  const s = JSON.parse(await h.read(MANIFEST)).scenarios[0].shots[0];
  assert.deepEqual(s.requiredLocales, ['uk', 'en']);
  assert.deepEqual(s.outputPathPerLocale, { uk: UK_LIVE, en: EN_LIVE });
  assert.deepEqual(s.stagedPathPerLocale, { uk: `${STAGE}/uk.png`, en: `${STAGE}/en.png` });
  assert.deepEqual(s.status, { uk: 'pending', en: 'pending' });
  assert.equal(s.route, '/transactions', 'fields the script does not own are kept');
  assert.equal(await h.read('.doc-toolkit/screenshot-staging/.gitignore'), '*\n');
  assert.equal(await lexists(path.join(h.root, PORTAL_EN)), false);
  assert.equal(await lexists(path.join(h.root, 'portal/transactions/.assets')), false);
});

test('resolve writes nothing when a shot cannot be placed', async () => {
  const h = await host();
  const bad = [
    shot({ page: 'blog/post.md' }),
    shot({ shotId: 'b', file: 'x/filters.png' }),
    shot({ shotId: 'c', locales: ['de'] }),
    shot({ shotId: 'd' }),
    shot({ shotId: 'e' }),
    shot({ shotId: 'e' }),
  ];
  await h.write(MANIFEST, manifest(bad));
  const before = await h.read(MANIFEST);
  const r = await cli(h.root, 'resolve', MANIFEST);
  assert.equal(r.code, 2);
  const messages = r.out.problems.map((p) => p.message).join('\n');
  assert.match(messages, /under no declared UA content root/);
  assert.match(messages, /image file name with no folder/);
  assert.match(messages, /not a declared screenshot locale/);
  assert.match(messages, /both write/);
  assert.match(messages, /Two shots have the shotId 'e'/);
  assert.equal(await h.read(MANIFEST), before);
});

test('resolve deletes a leftover capture, so an earlier run is never promoted', async () => {
  const h = await host();
  await h.write(MANIFEST, manifest());
  await h.write(`${STAGE}/uk.png`, 'old uk');
  await h.write(`${STAGE}/en.png`, 'old en');
  await cli(h.root, 'resolve', MANIFEST);
  assert.equal(await lexists(path.join(h.root, STAGE, 'uk.png')), false);
  const p = await cli(h.root, 'promote', MANIFEST);
  assert.equal(p.code, 1);
  assert.equal(await lexists(path.join(h.root, UK_LIVE)), false);
});

// ------------------------------------------------------------------ promote

test('a complete set is promoted in every locale; the EN folder is derived and created', async () => {
  const h = await host();
  await h.write(UK_LIVE, 'previous uk');
  await h.write(MANIFEST, manifest());
  await cli(h.root, 'resolve', MANIFEST);
  await h.write(`${STAGE}/uk.png`, 'new uk');
  await h.write(`${STAGE}/en.png`, 'new en');
  const r = await cli(h.root, 'promote', MANIFEST);
  assert.equal(r.code, 0, JSON.stringify(r.out));
  assert.equal(r.out.results[0].promoted, true);
  assert.deepEqual(r.out.results[0].createdFolders, [`${PORTAL_EN}/transactions/.assets`]);
  assert.equal(await h.read(UK_LIVE), 'new uk');
  assert.equal(await h.read(EN_LIVE), 'new en');
  assert.equal(await lexists(path.join(h.root, STAGE)), false);
  const s = JSON.parse(await h.read(MANIFEST)).scenarios[0].shots[0];
  assert.deepEqual(s.status, { uk: 'committed', en: 'committed' });
  const st = await cli(h.root, 'status', MANIFEST);
  assert.equal(st.code, 0);
  assert.equal(st.out.shots[0].state, 'complete');
});

test('one failed locale: nothing is promoted, the previous set stays, and each locale says why', async () => {
  const h = await host();
  await h.write(UK_LIVE, 'previous uk');
  await h.write(EN_LIVE, 'previous en');
  await h.write(MANIFEST, manifest());
  await cli(h.root, 'resolve', MANIFEST);
  await h.write(`${STAGE}/uk.png`, 'new uk');
  const f = await cli(h.root, 'fail', MANIFEST, '--shot', 'filters-pane', '--locale', 'en', '--reason', 'the error state cannot be reproduced in en');
  assert.equal(f.code, 0);
  await h.write(`${STAGE}/en.png`, 'a capture taken anyway');
  const r = await cli(h.root, 'promote', MANIFEST);
  assert.equal(r.code, 1);
  assert.deepEqual(r.out.results[0].failed, ['en']);
  assert.equal(await h.read(UK_LIVE), 'previous uk');
  assert.equal(await h.read(EN_LIVE), 'previous en');
  assert.equal(await lexists(path.join(h.root, STAGE, 'uk.png')), false, 'the staged set is discarded');
  const s = JSON.parse(await h.read(MANIFEST)).scenarios[0].shots[0];
  assert.deepEqual(s.status, { uk: 'failed', en: 'failed' });
  assert.equal(s.failureReason.en, 'the error state cannot be reproduced in en');
  assert.match(s.failureReason.uk, /not promoted: en failed; the previous image stays/);
  const st = await cli(h.root, 'status', MANIFEST);
  assert.equal(st.code, 1);
  assert.equal(st.out.shots[0].state, 'failed');
});

test('a missing capture blocks the set like a recorded failure', async () => {
  const h = await host();
  await h.write(MANIFEST, manifest());
  await cli(h.root, 'resolve', MANIFEST);
  await h.write(`${STAGE}/uk.png`, 'new uk');
  const r = await cli(h.root, 'promote', MANIFEST);
  assert.equal(r.code, 1);
  assert.match(r.out.results[0].reasons.en, /no capture at/);
  assert.equal(await lexists(path.join(h.root, UK_LIVE)), false, 'no uk image without its en twin');
});

test('a locale-scoped shot replaces that locale only', async () => {
  const h = await host();
  await h.write(UK_LIVE, 'previous uk');
  await h.write(EN_LIVE, 'previous en');
  await h.write(MANIFEST, manifest([shot({ locales: ['en'] })]));
  const r = await cli(h.root, 'resolve', MANIFEST);
  assert.deepEqual(r.out.shots[0].requiredLocales, ['en']);
  await h.write(`${STAGE}/en.png`, 'new en');
  assert.equal((await cli(h.root, 'promote', MANIFEST)).code, 0);
  assert.equal(await h.read(UK_LIVE), 'previous uk');
  assert.equal(await h.read(EN_LIVE), 'new en');
  const st = await cli(h.root, 'status', MANIFEST);
  assert.deepEqual(st.out.shots[0].missingLocales, [], 'a scoped shot is not short of locales');
});

test('a symlink to the EN image is replaced, never written through', async () => {
  const h = await host({ extra: ['- **Screenshot locales:** `uk, en, de`', '- **Locale switch:** `url-prefix uk=/, en=/en/, de=/de/`'], locales: ['uk', 'en', 'de'] });
  const DE_LIVE = 'i18n/de/docusaurus-plugin-content-docs-portal/current/transactions/.assets/filters-pane.png';
  await h.write(EN_LIVE, 'previous en');
  await fs.mkdir(path.dirname(path.join(h.root, DE_LIVE)), { recursive: true });
  await fs.symlink(path.relative(path.dirname(path.join(h.root, DE_LIVE)), path.join(h.root, EN_LIVE)), path.join(h.root, DE_LIVE));
  await h.write(MANIFEST, manifest());
  await cli(h.root, 'resolve', MANIFEST);
  for (const l of ['uk', 'en', 'de']) await h.write(`${STAGE}/${l}.png`, `new ${l}`);
  const r = await cli(h.root, 'promote', MANIFEST);
  assert.equal(r.code, 0, JSON.stringify(r.out));
  assert.equal(await h.read(EN_LIVE), 'new en');
  assert.equal((await fs.lstat(path.join(h.root, DE_LIVE))).isSymbolicLink(), false);
  assert.equal(await h.read(DE_LIVE), 'new de');
});

test('a promotion that breaks halfway puts every locale back', async () => {
  const h = await host();
  await h.write(UK_LIVE, 'previous uk');
  await h.write(`${PORTAL_EN}/transactions`, 'a file where the EN page folder should be');
  await h.write(MANIFEST, manifest());
  await cli(h.root, 'resolve', MANIFEST);
  await h.write(`${STAGE}/uk.png`, 'new uk');
  await h.write(`${STAGE}/en.png`, 'new en');
  const r = await cli(h.root, 'promote', MANIFEST);
  assert.equal(r.code, 1);
  assert.equal(await h.read(UK_LIVE), 'previous uk');
  const s = JSON.parse(await h.read(MANIFEST)).scenarios[0].shots[0];
  assert.match(s.failureReason.uk, /promotion failed .*put back/);
});

// ------------------------------------------------------------------ status and re-resolve

test('status finds a mixed set, and a locale declared later', async () => {
  const h = await host();
  await h.write(MANIFEST, manifest());
  await cli(h.root, 'resolve', MANIFEST);
  await h.write(`${STAGE}/uk.png`, 'new uk');
  await h.write(`${STAGE}/en.png`, 'new en');
  await cli(h.root, 'promote', MANIFEST);
  await fs.rm(path.join(h.root, EN_LIVE));
  let st = await cli(h.root, 'status', MANIFEST);
  assert.equal(st.code, 1);
  assert.equal(st.out.shots[0].state, 'mixed');
  await h.write(EN_LIVE, 'en again');
  await h.write('CLAUDE.md', claudeMd(['- **Screenshot locales:** `uk, en, de`', '- **Locale switch:** `url-prefix uk=/, en=/en/, de=/de/`']));
  await h.write('docusaurus.config.ts', "export default { i18n: { defaultLocale: 'uk', locales: ['uk', 'en', 'de'] } };\n");
  st = await cli(h.root, 'status', MANIFEST);
  assert.equal(st.out.shots[0].state, 'complete');
  assert.deepEqual(st.out.shots[0].missingLocales, ['de']);
});

test('resolve leaves a committed shot alone unless --shot names it', async () => {
  const h = await host();
  await h.write(MANIFEST, manifest());
  await cli(h.root, 'resolve', MANIFEST);
  await h.write(`${STAGE}/uk.png`, 'new uk');
  await h.write(`${STAGE}/en.png`, 'new en');
  await cli(h.root, 'promote', MANIFEST);
  let r = await cli(h.root, 'resolve', MANIFEST);
  assert.equal(r.out.shots[0].toCapture, false);
  assert.equal(r.out.shots[0].status.uk, 'committed');
  r = await cli(h.root, 'resolve', MANIFEST, '--shot', 'filters-pane');
  assert.equal(r.out.shots[0].toCapture, true);
  assert.deepEqual(r.out.shots[0].status, { uk: 'pending', en: 'pending' });
  assert.equal(await h.read(UK_LIVE), 'new uk', 'the live set stays until a new one is promoted');
  assert.equal((await cli(h.root, 'resolve', MANIFEST, '--shot', 'nope')).code, 2);
});
