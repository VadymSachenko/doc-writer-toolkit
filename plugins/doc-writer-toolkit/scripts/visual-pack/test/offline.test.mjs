// Everything that needs no browser: the page and URL mapping, the findings rules, the untranslated-text rule per locale,
// the sheet writer, the local server, the settings and the command line up to the point where Playwright is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { classifyFile, docRoute, frontMatter, pageUrl, buildPages, changedFiles } from '../lib/pages.mjs';
import { imageProblem, tableTooWide, analyze, summarizeFindings } from '../lib/findings.mjs';
import { checkBlocks, scriptOf, cyrillicShare } from '../lib/untranslated.mjs';
import { renderSheet, escapeHtml } from '../lib/sheet.mjs';
import { summaryText, assemble } from '../lib/report.mjs';
import { startServer, resolveFile } from '../lib/server.mjs';
import { loadPackSettings, normalizeBaseUrl, parseViewport } from '../lib/config.mjs';
import { loadPlaywright } from '../lib/playwright.mjs';
import { buildArgs } from '../lib/build.mjs';
import { makeHost, makeBuild, tmp, write } from './fixture.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CLI = path.join(ROOT, 'visual-pack.mjs');

// ------------------------------------------------------------------ pages and URLs
test('docRoute follows the Docusaurus rules for a docs page', () => {
  assert.equal(docRoute('/', 'guide/intro.md'), '/guide/intro');
  assert.equal(docRoute('/', 'guide/01-payments.mdx'), '/guide/payments');
  assert.equal(docRoute('/', '02_api/10. limits.md'), '/api/limits');
  assert.equal(docRoute('/', 'guide/index.md'), '/guide');
  assert.equal(docRoute('/', 'guide/README.md'), '/guide');
  assert.equal(docRoute('/', 'guide/guide.md'), '/guide', 'a page named like its folder is the folder');
  assert.equal(docRoute('/', 'index.md'), '/');
  assert.equal(docRoute('/portal/', 'guide/intro.md'), '/portal/guide/intro');
  assert.equal(docRoute('/portal', 'guide/intro.md'), '/portal/guide/intro');
  assert.equal(docRoute('/', 'guide/intro.md', { slug: '/start' }), '/start');
  assert.equal(docRoute('/', 'guide/intro.md', { slug: 'first' }), '/guide/first');
  assert.equal(docRoute('/', 'guide/intro.md', { slug: '/' }), '/');
  assert.equal(docRoute('/', 'guide/intro.md', { id: 'welcome' }), '/guide/welcome');
  assert.equal(docRoute('/', '2024-report.md'), '/report', 'a number and a separator are a prefix');
  assert.equal(docRoute('/', '404.md'), '/404', 'a number alone is a name');
});

test('frontMatter reads only id and slug', () => {
  assert.deepEqual(frontMatter('---\ntitle: X\nslug: "/a/b"\nid: c\n---\nbody\nslug: no\n'), { slug: '/a/b', id: 'c' });
  assert.deepEqual(frontMatter('# no front matter\nslug: x\n'), {});
});

test('pageUrl puts the default locale at the base URL and the others under their code', () => {
  assert.equal(pageUrl('/', 'uk', 'uk', '/guide/intro'), '/guide/intro');
  assert.equal(pageUrl('/', 'uk', 'tr', '/guide/intro'), '/tr/guide/intro');
  assert.equal(pageUrl('/docs/', 'uk', 'en', '/guide/intro'), '/docs/en/guide/intro');
  assert.equal(pageUrl('/', 'uk', 'en', '/'), '/en/');
  assert.equal(pageUrl('/', 'uk', 'uk', '/'), '/');
});

const PAIR = { id: 'primary', primary: true, ua: 'docs/', en: 'i18n/en/docusaurus-plugin-content-docs/current/', urlPrefix: '/' };
const SECOND = { id: 'portal', primary: false, ua: 'portal/', en: 'i18n/en/docusaurus-plugin-content-docs-portal/current/', urlPrefix: '/portal/' };

test('classifyFile maps a file of any locale to its page and ignores what is no page', () => {
  const locales = ['uk', 'en', 'tr'];
  const at = (f, pairs = [PAIR]) => classifyFile(f, pairs, locales, 'uk');
  assert.deepEqual(at('docs/guide/a.md'), { pair: PAIR, locale: 'uk', rel: 'guide/a.md' });
  assert.deepEqual(at('i18n/en/docusaurus-plugin-content-docs/current/guide/a.md'), { pair: PAIR, locale: 'en', rel: 'guide/a.md' });
  assert.equal(at('i18n/tr/docusaurus-plugin-content-docs/current/guide/a.mdx').locale, 'tr');
  assert.equal(at('docs/guide/_partial.md'), null, 'a partial is no page');
  assert.equal(at('docs/_shared/a.md'), null);
  assert.equal(at('docs/guide/.assets/a.png'), null);
  assert.equal(at('docs-old/a.md'), null, 'whole path segments only');
  assert.equal(at('src/pages/index.md'), null);
  assert.equal(at('portal/a.md', [PAIR, SECOND]).pair.id, 'portal');
  assert.equal(at('i18n/tr/docusaurus-plugin-content-docs-portal/current/a.md', [PAIR, SECOND]).pair.id, 'portal');
});

test('buildPages makes one row per page from the files a range changed', async () => {
  const { dir, range } = makeHost();
  const files = await changedFiles(dir, range);
  assert.ok(files.includes('docs/.assets/shot.png'));
  const ctx = { pairs: [PAIR], columns: ['uk', 'en', 'ru'], knownLocales: ['uk', 'en', 'ru'], defaultLocale: 'uk', baseUrl: '/' };
  const pages = await buildPages(dir, files, ctx);
  assert.deepEqual(pages.map((p) => p.key), ['primary:guide/01-payments.md', 'primary:guide/intro.md', 'primary:guide/limits.md']);
  const payments = pages[0];
  assert.deepEqual(payments.changedIn.sort(), ['en', 'ru', 'uk']);
  assert.deepEqual(payments.urls, { uk: '/guide/payments', en: '/en/guide/payments', ru: '/ru/guide/payments' });
  const limits = pages[2];
  assert.equal(limits.files.ru, null, 'ru has no file for it');
  assert.equal(limits.urls.ru, '/ru/guide/limits', 'the route still comes from the default locale file');
  assert.deepEqual(limits.changedIn.sort(), ['en', 'uk']);
});

test('a change in one locale only still makes the page, and a bad range is a usage error', async () => {
  const { dir } = makeHost();
  write(dir, 'i18n/en/docusaurus-plugin-content-docs/current/guide/intro.md', '# Intro changed\n');
  const files = await changedFiles(dir, 'HEAD');
  assert.deepEqual(files, ['i18n/en/docusaurus-plugin-content-docs/current/guide/intro.md']);
  const pages = await buildPages(dir, files, { pairs: [PAIR], columns: ['uk', 'en'], knownLocales: ['uk', 'en'], defaultLocale: 'uk', baseUrl: '/' });
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0].changedIn, ['en']);
  await assert.rejects(changedFiles(dir, 'no-such-ref...HEAD'), (e) => e.exitCode === 2);
});

// ------------------------------------------------------------------ settings
test('settings: the range is required, the columns come from docusaurus.config, flags beat the block', async () => {
  const { dir, range } = makeHost();
  await assert.rejects(loadPackSettings({ root: dir }), (e) => e.exitCode === 2 && /--range/.test(e.message));
  await assert.rejects(loadPackSettings({ root: dir, range: '--output=x' }), (e) => e.exitCode === 2);
  const s = await loadPackSettings({ root: dir, range }, {});
  assert.deepEqual(s.columns, ['uk', 'en', 'ru']);
  assert.equal(s.defaultLocale, 'uk');
  assert.equal(s.baseUrl, '/');
  assert.equal(s.outDir, path.join(dir, '.doc-toolkit', 'visual-pack'));
  assert.deepEqual(s.viewport, { width: 1280, height: 800 });
  assert.equal(s.playwrightFrom, dir, 'the host repo, unless told otherwise');

  const o = await loadPackSettings({ root: dir, range, locales: 'en', 'state-root': 'state', viewport: '800x600', 'base-url': 'docs', jobs: '2' }, { VISUAL_PACK_PLAYWRIGHT_FROM: '/somewhere' });
  assert.deepEqual(o.columns, ['uk', 'en'], 'the default locale is always a column');
  assert.equal(o.outDir, path.join(dir, 'state', 'visual-pack'));
  assert.equal(o.baseUrl, '/docs/');
  assert.equal(o.jobs, 2);
  assert.equal(o.playwrightFrom, '/somewhere');
  const f = await loadPackSettings({ root: dir, range, 'playwright-from': dir, out: 'sheet-out' }, { VISUAL_PACK_PLAYWRIGHT_FROM: '/somewhere' });
  assert.equal(f.playwrightFrom, dir, 'a flag beats the environment');
  assert.equal(f.outDir, path.join(dir, 'sheet-out'));
  await assert.rejects(loadPackSettings({ root: dir, range, viewport: 'wide' }), (e) => e.exitCode === 2);
  await assert.rejects(loadPackSettings({ root: dir, range, jobs: '0' }), (e) => e.exitCode === 2);
});

test('settings: the base URL and the state root come from the block; no docusaurus.config needs --locales', async () => {
  const { dir, range } = makeHost();
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8') + '- **Site base URL:** `/handbook`\n- **Toolkit state root:** `.state/`\n');
  const s = await loadPackSettings({ root: dir, range });
  assert.equal(s.baseUrl, '/handbook/');
  assert.equal(s.outDir, path.join(dir, '.state', 'visual-pack'));

  fs.rmSync(path.join(dir, 'docusaurus.config.js'));
  await assert.rejects(loadPackSettings({ root: dir, range }), (e) => e.exitCode === 2 && /docusaurus\.config/.test(e.message));
  const t = await loadPackSettings({ root: dir, range, locales: 'ru,en' });
  assert.equal(t.defaultLocale, 'ru', 'with no config the first locale is the default');
  assert.deepEqual(t.columns, ['ru', 'en']);
});

test('settings: the base URL is read from the config when no flag or field gives it', async () => {
  const { dir, range } = makeHost();
  fs.writeFileSync(path.join(dir, 'docusaurus.config.js'), "export default { baseUrl: '/site/', i18n: { defaultLocale: 'uk', locales: ['uk', 'tr'] } };\n");
  const s = await loadPackSettings({ root: dir, range });
  assert.equal(s.baseUrl, '/site/');
  assert.deepEqual(s.columns, ['uk', 'tr']);
  assert.equal(normalizeBaseUrl(''), '/');
  assert.deepEqual(parseViewport('1024x768'), { width: 1024, height: 768 });
});

test('the build is one run for all columns, with the default locale first', () => {
  assert.deepEqual(buildArgs({ outDir: '/o', locales: ['uk', 'en', 'tr'] }), ['build', '--out-dir', '/o', '--locale', 'uk', '--locale', 'en', '--locale', 'tr']);
});

// ------------------------------------------------------------------ findings
test('imageProblem: a 404, a blocked request and an image that did not decode are broken; a sizeless SVG is not', () => {
  const ok = { src: 'http://h/a.png', ok: true };
  assert.equal(imageProblem(ok, { 'http://h/a.png': 200 }, []), null);
  assert.match(imageProblem({ src: 'http://h/m.png', ok: false }, { 'http://h/m.png': 404 }, []), /404/);
  assert.match(imageProblem({ src: 'http://x/p.png', ok: false }, {}, ['http://x/p.png']), /blocked/);
  assert.match(imageProblem({ src: 'http://h/c.png', ok: false }, { 'http://h/c.png': 200 }, []), /decoded/);
  assert.equal(imageProblem({ src: 'http://h/i.svg?v=2', ok: false }, { 'http://h/i.svg?v=2': 200 }, []), null);
  assert.match(imageProblem({ src: '', ok: false }), /no source/);
  assert.equal(imageProblem({ src: 'http://h/a.png#x', ok: true }, { 'http://h/a.png': 404 }, []) !== null, true, 'the status of the file counts even when the browser drew something');
});

test('tableTooWide: wider than its room, or ending past the window', () => {
  assert.equal(tableTooWide({ width: 800, available: 800, right: 820, viewport: 1280 }), false);
  assert.equal(tableTooWide({ width: 801, available: 800, right: 820, viewport: 1280 }), false, 'a pixel of rounding');
  assert.equal(tableTooWide({ width: 2400, available: 800, right: 820, viewport: 1280 }), true);
  assert.equal(tableTooWide({ width: 800, available: 2000, right: 1500, viewport: 1280 }), true);
});

const PAGE = { key: 'primary:guide/a.md', urls: { uk: '/guide/a', en: '/en/guide/a' } };
const dom = (over = {}) => ({ images: [], tables: [], blocks: [], pageWidth: 1280, viewport: 1280, ...over });
const cap = (over = {}) => ({ status: 200, error: null, responses: {}, blocked: [], dom: dom(over) });

test('analyze: broken images, wide tables and a sideways page', () => {
  const broken = analyze({
    page: PAGE,
    locale: 'uk',
    capture: { ...cap({ images: [{ src: 'http://h/m.png', ok: false }, { src: 'http://h/a.png', ok: true }] }), responses: { 'http://h/m.png': 404 } },
    sourceLocale: 'uk',
  });
  assert.deepEqual(broken.map((f) => f.type), ['broken-image']);
  assert.match(broken[0].detail, /1 of 2/);
  assert.match(broken[0].items[0], /m\.png/);

  const wide = analyze({ page: PAGE, locale: 'uk', capture: cap({ tables: [{ width: 3000, available: 800, right: 820, viewport: 1280, rows: 4, header: 'Code' }], pageWidth: 3000 }), sourceLocale: 'uk' });
  assert.deepEqual(wide.map((f) => f.type), ['table-overflow'], 'one finding for the cause, not a second for the page');
  assert.match(wide[0].items[0], /"Code…" 3000px in 800px/);

  const sideways = analyze({ page: PAGE, locale: 'uk', capture: cap({ pageWidth: 1500 }), sourceLocale: 'uk' });
  assert.deepEqual(sideways.map((f) => [f.type, f.level]), [['page-overflow', 'look']]);
  assert.deepEqual(analyze({ page: PAGE, locale: 'uk', capture: cap(), sourceLocale: 'uk' }), []);
});

test('analyze: a page the site does not have, or could not be captured', () => {
  const a = analyze({ page: PAGE, locale: 'en', capture: { status: 404, dom: dom(), responses: {}, blocked: [] }, sourceLocale: 'uk' });
  assert.deepEqual(a.map((f) => [f.type, f.level]), [['page-missing', 'problem']]);
  assert.match(a[0].detail, /404/);
  const b = analyze({ page: PAGE, locale: 'en', capture: { error: 'Timeout 30000ms exceeded' }, sourceLocale: 'uk' });
  assert.match(b[0].detail, /Timeout/);
});

const block = (text, { plain = text, strong = '' } = {}) => ({ tag: 'p', text, plain, strong });

test('analyze: untranslated text, a locale with no file, and the default locale itself', () => {
  const ukBlock = block('Ця сума повертається клієнту автоматично протягом доби.');
  const source = cap({ blocks: [ukBlock] });
  const same = analyze({ page: PAGE, locale: 'en', capture: cap({ blocks: [ukBlock] }), source, sourceLocale: 'uk' });
  assert.deepEqual(same.map((f) => f.type), ['untranslated']);
  assert.match(same[0].items[0], /same as the source/);
  assert.deepEqual(analyze({ page: PAGE, locale: 'uk', capture: source, source, sourceLocale: 'uk' }), [], 'the source is not compared with itself');
  const nofile = analyze({ page: PAGE, locale: 'en', capture: source, source, sourceLocale: 'uk', noFile: true });
  assert.match(nofile[0].detail, /no file/);
});

test('summarizeFindings counts by type and level', () => {
  const s = summarizeFindings([{ type: 'broken-image', level: 'problem' }, { type: 'broken-image', level: 'problem' }, { type: 'kept-label', level: 'look' }]);
  assert.equal(s.problems, 2);
  assert.equal(s.look, 1);
  assert.equal(s.byType['broken-image'], 2);
  assert.equal(s.byType['table-overflow'], 0);
});

// ------------------------------------------------------------------ the untranslated-text rule, per locale
const SRC = [
  block('Платіж створюється після підтвердження замовлення клієнтом.'),
  block('Ця сума повертається клієнту автоматично протягом доби.'),
  block('Створити платіж', { plain: '', strong: 'Створити платіж' }),
  block('Content-Type: application/json header is required'),
  block('Лише'),
  block('Використайте ключ API_KEY_PRODUCTION', { plain: 'Використайте ключ', strong: '' }),
];
const check = (locale, targetBlocks) => checkBlocks({ sourceBlocks: SRC, targetBlocks, locale, sourceLocale: 'uk' });
const reasons = (r) => r.problems.map((p) => p.reason);

test('scriptOf knows the writing system of each locale and says nothing about an unknown one', () => {
  for (const l of ['en', 'tr', 'uz', 'az', 'es', 'es-AR']) assert.equal(scriptOf(l), 'latin', l);
  for (const l of ['uk', 'ru', 'kk', 'ky', 'tg']) assert.equal(scriptOf(l), 'cyrillic', l);
  assert.equal(scriptOf('ja'), null);
  assert.equal(cyrillicShare('Привіт world'), 6 / 11);
});

test('a block the same as the Ukrainian one is untranslated in every other locale, whatever its script', () => {
  for (const locale of ['en', 'ru', 'tr', 'uz', 'az', 'kk', 'ky', 'tg', 'es', 'ja']) {
    const r = check(locale, [SRC[1]]);
    assert.deepEqual(reasons(r), ['identical'], locale);
  }
});

test('Cyrillic text in a Latin-script locale is untranslated even when it is not the same block', () => {
  for (const locale of ['en', 'tr', 'uz', 'az', 'es']) {
    const r = check(locale, [block('Платіж створюється після підтвердження вашого замовлення.')]);
    assert.deepEqual(reasons(r), ['cyrillic-in-latin'], locale);
  }
  assert.deepEqual(reasons(check('tr', [block('Ödeme, siparişin onayından sonra oluşturulur.')])), []);
  assert.deepEqual(reasons(check('es', [block('El pago se crea después de que el cliente confirma el pedido.')])), []);
});

test('Ukrainian letters mark Ukrainian text in a Cyrillic locale that is not Ukrainian; the shared і does not', () => {
  const withYi = block('Ця сума є їхньою власністю і не повертається клієнту.');
  for (const locale of ['ru', 'kk', 'ky', 'tg']) assert.deepEqual(reasons(check(locale, [withYi])), ['ukrainian-letters'], locale);
  // Kazakh has the letter і: a Kazakh sentence with it is not Ukrainian.
  const kazakh = block('Төлем тапсырыс расталғаннан кейін жасалады, бұл клиент үшін ыңғайлы.');
  assert.deepEqual(reasons(check('kk', [kazakh])), []);
  assert.deepEqual(reasons(check('kk', [block('Клиент өзінің тапсырысын растағаннан кейін төлем жасалады.')])), [], 'і alone is no signal');
  assert.deepEqual(reasons(check('ru', [block('Платёж создаётся после подтверждения заказа клиентом.')])), []);
});

test('short blocks, code, Latin prose in the source and the same language are not flagged', () => {
  for (const locale of ['en', 'ru', 'kk']) {
    assert.deepEqual(reasons(check(locale, [SRC[4]])), [], 'one word');
    assert.deepEqual(reasons(check(locale, [SRC[3]])), [], 'a Latin sentence stays the same everywhere');
  }
  for (const locale of ['ru', 'kk']) assert.deepEqual(reasons(check(locale, [SRC[5]])), [], 'a block that is mostly a name or code');
  assert.deepEqual(reasons(check('uk', [SRC[1]])), [], 'same language');
  assert.deepEqual(reasons(checkBlocks({ sourceBlocks: SRC, targetBlocks: [SRC[1]], locale: 'uk-UA', sourceLocale: 'uk' })), []);
});

test('a bold label kept as the source has it is something to look at, not a problem', () => {
  for (const locale of ['en', 'ru', 'tr', 'kk']) {
    const r = check(locale, [SRC[2]]);
    assert.deepEqual(reasons(r), [], locale);
    assert.deepEqual(r.labels.map((l) => l.reason), ['identical-label'], locale);
  }
  // A Ukrainian bold label inside an English sentence: look at it, the app may show it so.
  const mixed = block('Press Створити платіж', { plain: 'Press', strong: 'Створити платіж' });
  const r = check('en', [mixed]);
  assert.deepEqual(reasons(r), []);
  assert.deepEqual(r.labels.map((l) => l.reason), ['cyrillic-label']);
  // The translated label is neither.
  const done = check('en', [block('Create payment', { plain: '', strong: 'Create payment' })]);
  assert.deepEqual([done.problems.length, done.labels.length], [0, 0]);
});

test('a block repeated on the page is reported once', () => {
  assert.equal(check('ru', [SRC[1], SRC[1], { ...SRC[1], text: `  ${SRC[1].text}  ` }]).problems.length, 1);
});

// ------------------------------------------------------------------ the sheet
function sampleReport() {
  const settings = { range: 'a...b', defaultLocale: 'uk', columns: ['uk', 'en'] };
  const pages = [
    { key: 'primary:guide/<b>x.md', pair: 'primary', rel: 'guide/x.md', changedIn: ['uk'], urls: { uk: '/guide/x', en: '/en/guide/x' }, files: { uk: 'docs/guide/x.md', en: 'i18n/en/x.md' } },
    { key: 'primary:guide/y.md', pair: 'primary', rel: 'guide/y.md', changedIn: ['uk', 'en'], urls: { uk: '/guide/y', en: '/en/guide/y' }, files: { uk: 'docs/guide/y.md', en: 'i18n/en/y.md' } },
  ];
  const wideTable = { width: 3000, available: 800, right: 820, viewport: 1280, rows: 3, header: 'Code' };
  const captures = [
    { page: pages[0].key, locale: 'uk', status: 200, shot: 'shots/uk/p01-x.png', error: null, dom: dom({ images: [{ src: 'http://h/missing.png', ok: false }], tables: [wideTable] }), responses: { 'http://h/missing.png': 404 }, blocked: [] },
    { page: pages[0].key, locale: 'en', status: 200, shot: 'shots/en/p01-x.png', error: null, dom: dom(), responses: {}, blocked: [] },
    { page: pages[1].key, locale: 'uk', status: 200, shot: 'shots/uk/p02-y.png', error: null, dom: dom(), responses: {}, blocked: [] },
    { page: pages[1].key, locale: 'en', status: null, shot: null, error: 'Timeout <30000ms>', dom: null, responses: {}, blocked: [] },
  ];
  return assemble({ settings, pages, captures, network: { requests: 9, local: 8, blocked: 1, blockedHosts: ['x.invalid'], servedByLocalServer: 8 }, timings: { buildSeconds: null, captureSeconds: 1.5, totalSeconds: 2 }, sheet: '.doc-toolkit/visual-pack/sheet.html' });
}

test('the sheet has the findings on top and a cell for every page and locale', () => {
  const report = sampleReport();
  assert.deepEqual([...new Set(report.findings.map((f) => f.type))].sort(), ['broken-image', 'page-missing', 'table-overflow']);
  const html = renderSheet(report);
  const top = html.indexOf('Automatic findings');
  const grid = html.indexOf('class="grid"');
  assert.ok(top > 0 && grid > top, 'findings come before the grid');
  const findingsHtml = html.slice(top, grid);
  assert.match(findingsHtml, /Broken image/);
  assert.match(findingsHtml, /Table wider than the page/);
  assert.match(findingsHtml, /missing\.png/);
  assert.match(findingsHtml, /3000px in 800px/);
  assert.equal((html.match(/<td id="c-/g) ?? []).length, 4, 'two pages × two locales');
  assert.match(html, /<img src="shots\/uk\/p01-x\.png"/);
  assert.match(html, /not captured: Timeout &lt;30000ms&gt;/);
  assert.match(html, /href="#c-0-uk"/, 'a finding links to its cell');
  assert.ok(html.indexOf('<h2>Pages</h2>') < html.indexOf('<tr><th class="page"'));
});

test('the sheet escapes everything that came from a page', () => {
  const html = renderSheet(sampleReport());
  assert.ok(!html.includes('<b>x.md'), 'the page key is escaped');
  assert.match(html, /guide\/&lt;b&gt;x\.md/);
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});

test('a sheet with no findings says so', () => {
  const settings = { range: 'a...b', defaultLocale: 'uk', columns: ['uk'] };
  const pages = [{ key: 'primary:a.md', pair: 'primary', rel: 'a.md', changedIn: ['uk'], urls: { uk: '/a' }, files: { uk: 'docs/a.md' } }];
  const captures = [{ page: pages[0].key, locale: 'uk', status: 200, shot: 'shots/uk/p01-a.png', error: null, dom: dom(), responses: {}, blocked: [] }];
  const report = assemble({ settings, pages, captures, network: { requests: 1, local: 1, blocked: 0, blockedHosts: [] }, timings: { buildSeconds: 3, captureSeconds: 1, totalSeconds: 4 }, sheet: 's.html' });
  assert.match(renderSheet(report), /No automatic findings/);
  assert.match(summaryText(report), /Findings: none/);
});

test('the summary is short: counts, the first findings, the sheet', () => {
  const text = summaryText(sampleReport(), { maxLines: 2 });
  assert.match(text, /^visual-pack: 2 pages × 2 locales \(uk, en\); 3 captured, 1 not\./);
  assert.match(text, /Findings: 3 to fix, 0 to look at\./);
  assert.match(text, /page-missing 1 · broken-image 1 · table-overflow 1/);
  assert.match(text, /… 1 more in the sheet\./);
  assert.match(text, /Network: 8 local requests, 1 blocked/);
  assert.match(text, /Sheet: \.doc-toolkit\/visual-pack\/sheet\.html$/);
  assert.ok(text.split('\n').length <= 10);
});

test('the summary puts a finding that repeats in several locales on one line', () => {
  const settings = { range: 'a...b', defaultLocale: 'uk', columns: ['uk', 'en', 'ru'] };
  const pages = [{ key: 'primary:a.md', pair: 'primary', rel: 'a.md', changedIn: ['uk'], urls: { uk: '/a', en: '/en/a', ru: '/ru/a' }, files: { uk: 'x', en: 'x', ru: 'x' } }];
  const wide = { width: 3000, available: 800, right: 820, viewport: 1280, rows: 3, header: 'Code' };
  const captures = settings.columns.map((locale) => ({ page: 'primary:a.md', locale, origin: 'http://127.0.0.1:1', status: 200, shot: `shots/${locale}/a.png`, error: null, dom: dom({ tables: [wide] }), responses: {}, blocked: [] }));
  const report = assemble({ settings, pages, captures, network: { requests: 3, local: 3, blocked: 0, blockedHosts: [] }, timings: { buildSeconds: 1, captureSeconds: 1, totalSeconds: 2 }, sheet: 's.html' });
  assert.equal(report.findings.length, 3, 'the report keeps one finding per locale');
  const lines = summaryText(report).split('\n').filter((l) => l.startsWith('  !'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /primary:a\.md \[uk, en, ru\]/);
});

test('an image of the site itself is shown by its path, not by the address of the run', () => {
  const origin = 'http://127.0.0.1:5555';
  const f = analyze({
    page: PAGE,
    locale: 'uk',
    capture: { ...cap({ images: [{ src: `${origin}/img/m.png`, ok: false }] }), origin, responses: { [`${origin}/img/m.png`]: 404 } },
    sourceLocale: 'uk',
  });
  assert.equal(f[0].items[0], '/img/m.png: the site answered 404');
});

// ------------------------------------------------------------------ the local server
const get = (port, p) =>
  new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    }).on('error', reject);
  });

test('the server serves a Docusaurus build: folders, files, locales, the 404 page, and nothing outside the folder', async () => {
  const dir = makeBuild();
  write(dir, 'secret.txt', 'outside');
  const inner = path.join(dir, 'site');
  fs.mkdirSync(inner);
  write(inner, 'index.html', '<h1>inner</h1>');
  const server = await startServer(inner, '/');
  try {
    assert.equal((await get(server.port, '/')).body, '<h1>inner</h1>');
    assert.equal((await get(server.port, '/../secret.txt')).status, 404);
    assert.equal((await get(server.port, '/%2e%2e/secret.txt')).status, 404);
  } finally {
    await server.close();
  }
  const site = await startServer(dir, '/');
  try {
    assert.equal((await get(site.port, '/guide/payments')).status, 200);
    assert.equal((await get(site.port, '/guide/payments/')).status, 200);
    assert.match((await get(site.port, '/en/guide/limits')).body, /<html lang="en">/);
    assert.equal((await get(site.port, '/img/ok.png')).type, 'image/png');
    const missing = await get(site.port, '/img/nope.png');
    assert.equal(missing.status, 404);
    assert.match(missing.body, /Page Not Found/);
    assert.equal(site.stats.notFound, 1);
    assert.match(site.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await site.close();
  }
  assert.equal(await resolveFile(dir, '/guide/payments', '/'), path.join(dir, 'guide/payments/index.html'));
  assert.equal(await resolveFile(dir, '/docs/guide/payments', '/docs/'), path.join(dir, 'guide/payments/index.html'));
  assert.equal(await resolveFile(dir, '/index.html', '/docs/'), path.join(dir, 'index.html'), 'a path outside the base URL is looked up as it is');
});

// ------------------------------------------------------------------ Playwright is the host's
test('loadPlaywright finds the launcher in the folder it is given, and says what to do when there is none', () => {
  const none = tmp('visual-pack-nopw');
  assert.throws(() => loadPlaywright(none), (e) => e.exitCode === 2 && /Playwright was not found/.test(e.message) && /--playwright-from/.test(e.message));

  const has = tmp('visual-pack-haspw');
  write(has, 'node_modules/playwright/package.json', '{"name":"playwright","version":"0.0.0","main":"index.js"}');
  write(has, 'node_modules/playwright/index.js', 'module.exports = { chromium: { marker: "stand-in" } };');
  assert.equal(loadPlaywright(has).marker, 'stand-in');

  const testPkg = tmp('visual-pack-testpw');
  write(testPkg, 'node_modules/@playwright/test/package.json', '{"name":"@playwright/test","version":"0.0.0","main":"index.js"}');
  write(testPkg, 'node_modules/@playwright/test/index.js', 'module.exports = { chromium: { marker: "from-test" } };');
  assert.equal(loadPlaywright(testPkg).marker, 'from-test');
});

// ------------------------------------------------------------------ the command line, and no model call
function standIn() {
  const bin = tmp('visual-pack-bin');
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`, { mode: 0o755 });
  return { bin, log };
}

test('a dry run lists the pages and builds and captures nothing; no `claude` is started', async () => {
  const { dir, range } = makeHost();
  const { bin, log } = standIn();
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const { stdout } = await run('node', [CLI, '--root', dir, '--range', range, '--dry-run', '--json'], { env });
  const report = JSON.parse(stdout);
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.columns, ['uk', 'en', 'ru']);
  assert.deepEqual(report.pages.map((p) => p.urls.en), ['/en/guide/payments', '/en/guide/intro', '/en/guide/limits']);
  assert.equal(report.pages.length, 3);
  assert.ok(!fs.existsSync(path.join(dir, '.doc-toolkit')), 'nothing written');
  assert.ok(!fs.existsSync(log), 'the model CLI was never started');

  const text = await run('node', [CLI, '--root', dir, '--range', range, '--dry-run'], { env });
  assert.match(text.stdout, /^visual-pack \(dry run\): 3 pages × 3 locales \(uk, en, ru\)/);
});

test('no changed page in the range is said in one line', async () => {
  const { dir } = makeHost();
  const { stdout } = await run('node', [CLI, '--root', dir, '--range', 'HEAD..HEAD']);
  assert.equal(stdout.trim(), 'visual-pack: no changed docs page in HEAD..HEAD.');
});

test('a host without Playwright gets a clear error, before anything is built', async () => {
  const { dir, range } = makeHost();
  const empty = tmp('visual-pack-empty');
  const env = { ...process.env };
  delete env.VISUAL_PACK_PLAYWRIGHT_FROM;
  await assert.rejects(run('node', [CLI, '--root', dir, '--range', range, '--playwright-from', empty], { env }), (e) => {
    assert.equal(e.code, 2);
    assert.match(e.stderr, /Playwright was not found/);
    assert.equal(JSON.parse(e.stdout).ok, false);
    return true;
  });
  assert.ok(!fs.existsSync(path.join(dir, '.doc-toolkit', 'visual-pack', 'build')), 'no build was started');
  await assert.rejects(run('node', [CLI, '--root', dir], { env }), (e) => e.code === 2 && /--range/.test(e.stderr));
  await assert.rejects(run('node', [CLI, '--nonsense'], { env }), (e) => e.code === 2);
});

test('--help prints the usage and exits 0', async () => {
  const { stdout } = await run('node', [CLI, '--help']);
  assert.match(stdout, /^visual-pack --range/);
});

test('the script cannot start a model: no source mentions one, and only git and the site build are spawned', () => {
  const sources = [CLI, ...fs.readdirSync(path.join(ROOT, 'lib')).map((f) => path.join(ROOT, 'lib', f))];
  const spawners = [];
  for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!/['"`]claude['"`]|anthropic|openai|\bllm\b/i.test(text), `${path.basename(file)} mentions a model`);
    if (/node:child_process/.test(text)) spawners.push(path.basename(file));
  }
  assert.deepEqual(spawners.sort(), ['build.mjs', 'pages.mjs']);
  assert.match(fs.readFileSync(path.join(ROOT, 'lib', 'pages.mjs'), 'utf8'), /run\('git'/);
  const build = fs.readFileSync(path.join(ROOT, 'lib', 'build.mjs'), 'utf8');
  assert.match(build, /spawn\(bin, buildArgs/, 'the only other process is the host docusaurus binary');
});
