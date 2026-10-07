import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { diffSnapshots } from '../lib/diff.mjs';
import { resolveLocaleFiles, ticketsFromBranch, parseSource, deriveLocaleRoot } from '../lib/config.mjs';
import { replaceBold } from '../lib/sync.mjs';
import { gitBlobHash } from '../lib/util.mjs';

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui-labels.mjs');

async function cli(cwd, ...args) {
  try {
    const { stdout, stderr } = await run('node', [CLI, ...args], { cwd });
    return { code: 0, out: stdout.trim().startsWith('{') ? JSON.parse(stdout) : stdout, stderr };
  } catch (e) {
    return { code: e.code, out: e.stdout?.trim().startsWith('{') ? JSON.parse(e.stdout) : e.stdout, stderr: e.stderr };
  }
}
const git = (cwd, ...args) => run('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim());

test('diff: added / removed / changed / rekeyed', () => {
  const before = {
    uk: { 'a.save': 'Зберегти', 'a.old': 'Старе', 'b.name': 'Назва', 'b.dup1': 'Однакове', 'b.dup2': 'Однакове' },
    tr: { 'a.save': 'Kaydet', 'a.old': 'Eski', 'b.name': 'Ad', 'b.dup1': 'Aynı', 'b.dup2': 'Aynı' },
  };
  const after = {
    uk: { 'a.save': 'Підтвердити', 'a.new': 'Нове', 'b.title': 'Назва', 'b.dup1': 'Однакове', 'b.dup2': 'Однакове', 'b.dup3': 'Однакове' },
    tr: { 'a.save': 'Onayla', 'a.new': 'Yeni', 'b.title': 'Başlık', 'b.dup1': 'Aynı', 'b.dup2': 'Aynı', 'b.dup3': 'Aynı' },
  };
  const d = diffSnapshots(before, after);
  assert.deepEqual(d.changed.map((c) => c.key), ['a.save']);
  assert.deepEqual(d.changed[0].locales, { uk: { old: 'Зберегти', new: 'Підтвердити' }, tr: { old: 'Kaydet', new: 'Onayla' } });
  assert.deepEqual(d.rekeyed.map((r) => [r.from, r.to]), [['b.name', 'b.title']]);
  assert.deepEqual(d.rekeyed[0].locales, { tr: { old: 'Ad', new: 'Başlık' } });
  // a.old removed; a.new and b.dup3 added; b.name/b.title paired
  assert.deepEqual(d.removed.map((r) => r.key), ['a.old']);
  assert.deepEqual(d.added.map((r) => r.key), ['a.new', 'b.dup3']);
});

test('large JSON output is not truncated when stdout is a pipe', async () => {
  // process.exit() right after a big write to a pipe cuts the output off (the pipe buffer is 64 KB).
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-labels-big-'));
  const snapshot = async (name, suffix) => {
    const d = path.join(dir, name);
    await fs.mkdir(d);
    const uk = {};
    for (let i = 0; i < 4000; i++) uk[`section.key${i}`] = `Значення ${i}${suffix}`;
    await fs.writeFile(path.join(d, 'meta.json'), JSON.stringify({ commit: name, locales: ['uk'] }));
    await fs.writeFile(path.join(d, 'uk.json'), JSON.stringify(uk));
    return d;
  };
  const from = await snapshot('from', '');
  const to = await snapshot('to', ' (нове)');
  const r = await cli(dir, 'diff', from, to);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(typeof r.out === 'object', 'stdout is complete, parseable JSON');
  assert.equal(r.out.changed.length, 4000);
  assert.ok(JSON.stringify(r.out).length > 200_000);
});

test('locale files match by language; overrides and ambiguity are explicit', () => {
  const files = ['ar.json', 'ua.json', 'tr.json', 'en.json', 'ru.json'];
  assert.throws(() => resolveLocaleFiles(['uk', 'es', 'tr'], files, {}), (e) => e.exitCode === 2 && e.data.unresolved.map((u) => u.locale).join() === 'uk,es');
  const { map } = resolveLocaleFiles(['uk', 'es', 'tr'], files, { uk: 'ua', es: 'ar' });
  assert.deepEqual(map, { uk: 'ua.json', es: 'ar.json', tr: 'tr.json' });
  assert.equal(resolveLocaleFiles(['es'], ['es-AR.json', 'ar.json'], {}).map.es, 'es-AR.json');
  assert.throws(() => resolveLocaleFiles(['es'], ['es-AR.json', 'es-ES.json'], {}), (e) => e.data.unresolved[0].reason.includes('several'));
  assert.deepEqual(resolveLocaleFiles(['es', 'tr'], ['tr.json'], {}, { tolerant: true }).map, { tr: 'tr.json' });
});

test('config helpers', () => {
  assert.deepEqual(ticketsFromBranch('1139-messenger-doc'), ['1139']);
  assert.deepEqual(ticketsFromBranch('90-94-locales-and-translation-doc'), ['90', '94']);
  assert.deepEqual(ticketsFromBranch('main'), []);
  assert.equal(deriveLocaleRoot('i18n/en/docusaurus-plugin-content-docs/current/', 'tr'), 'i18n/tr/docusaurus-plugin-content-docs/current/');
  assert.equal(parseSource('github Org/Repo@feat/x src/locales/*.json').branch, 'feat/x');
  assert.throws(() => parseSource('command cat labels.json'), (e) => e.exitCode === 2);
});

test('replaceBold skips code fences and reports lines', () => {
  const text = 'Натисніть **Зберегти**.\n\n```md\n**Зберегти**\n```\n\n- **Зберегти** і **Зберегти**';
  const r = replaceBold(text, 'Зберегти', 'Підтвердити');
  assert.deepEqual(r.hits.map((h) => h.line), [1, 7]);
  assert.ok(r.text.includes('```md\n**Зберегти**\n```'));
});

async function fixtureRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-labels-test-'));
  const write = async (rel, content) => {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  };
  const en = 'i18n/en/docusaurus-plugin-content-docs/current';
  await write(
    'CLAUDE.md',
    `# Project\n\n## Documentation toolkit configuration\n\n- **UI label source:** \`command cat labels/{locale}.json\`\n- **UA content root:** \`docs/\`\n- **EN i18n root:** \`${en}/\`\n\n## Other\n`,
  );
  await write('docusaurus.config.ts', `export default { i18n: { defaultLocale: 'uk', locales: ['uk', 'en', 'tr'], localeConfigs: { tr: { label: 'Türkçe' } } } };\n`);
  const labels = {
    uk: { 'button.save': 'Зберегти', 'dialog.save': 'Зберегти', 'col.status': 'Статус', 'old.key': 'Видалене', 'x.title': 'Назва' },
    en: { 'button.save': 'Save', 'dialog.save': 'Save', 'col.status': 'Status', 'old.key': 'Removed', 'x.title': 'Title' },
    tr: { 'button.save': 'Kaydet', 'dialog.save': 'Kaydet', 'col.status': 'Durum', 'old.key': 'Silindi', 'x.title': 'Başlık' },
  };
  for (const [l, m] of Object.entries(labels)) await write(`labels/${l}.json`, m);
  const ua = '# Фільтри\n\nНатисніть кнопку **Зберегти**, потім оберіть **Статус**.\n\n**Увага:** не закривайте вікно.\n';
  await write('docs/filters/filters.md', ua);
  await write(`${en}/filters/filters.md`, '# Filters\n\nClick **Save**, then choose **Status**.\n\n**Warning:** do not close the window.\n');
  await write('i18n/tr/docusaurus-plugin-content-docs/current/filters/filters.md', '# Filtreler\n\n**Kaydet** düğmesine tıklayın, ardından **Durum** seçin.\n\n**Dikkat:** pencereyi kapatmayın.\n');
  await write('.doc-toolkit/pages/filters/filters.json', {
    spans: { Зберегти: 'label:button.save', Статус: 'label:col.status', Увага: 'emphasis', Видалене: 'label:old.key' },
    locales: { tr: { sourceBlob: gitBlobHash(ua), labelSnapshot: 'old', translatedAt: '2026-10-01', unverified: [], assetFallbacks: [] } },
  });
  // A second page whose tr translation is already stale against its UA source.
  await write('docs/stale/stale.md', 'Натисніть **Зберегти**. Нове речення.\n');
  await write('i18n/tr/docusaurus-plugin-content-docs/current/stale/stale.md', '**Kaydet** düğmesine tıklayın.\n');
  await write('.doc-toolkit/pages/stale/stale.json', {
    spans: { Зберегти: 'label:button.save' },
    locales: { tr: { sourceBlob: gitBlobHash('Натисніть **Зберегти**.\n'), labelSnapshot: 'old' } },
  });
  // A page bound to a sibling key (dialog.save has the same strings as button.save).
  await write('docs/dialog/dialog.md', 'У вікні натисніть **Зберегти**.\n');
  await write(`${en}/dialog/dialog.md`, 'In the dialog, click **Save**.\n');
  await write('i18n/tr/docusaurus-plugin-content-docs/current/dialog/dialog.md', 'İletişim kutusunda **Kaydet** düğmesine tıklayın.\n');
  await write('.doc-toolkit/pages/dialog/dialog.json', { spans: { Зберегти: 'label:dialog.save' }, locales: {} });
  await git(dir, 'init', '-q');
  await git(dir, 'config', 'user.email', 't@t');
  await git(dir, 'config', 'user.name', 't');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-qm', 'init');
  return { dir, write };
}

test('import → change → check → import → sync (fixture repo, command adapter)', async () => {
  const { dir, write } = await fixtureRepo();

  const first = await cli(dir, 'import');
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.out.firstImport, true);
  assert.deepEqual(first.out.locales, ['uk', 'en', 'tr']);
  assert.equal((await cli(dir, 'check')).code, 0);
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-qm', 'labels');

  // Lookup
  const lookup = await cli(dir, 'lookup', 'Зберегти', 'Статус:', 'Невідоме', '--json');
  assert.equal(lookup.out.results[0].status, 'identical-targets');
  assert.deepEqual([lookup.out.results[0].key, ...lookup.out.results[0].alsoKeys].sort(), ['button.save', 'dialog.save']);
  assert.equal(lookup.out.results[1].match, 'normalized');
  assert.equal(lookup.out.results[2].status, 'no-match');
  assert.equal(lookup.out.results[0].values.tr, 'Kaydet');

  // App release: rename button.save, add a button, remove old.key
  await write('labels/uk.json', { 'button.save': 'Підтвердити', 'dialog.save': 'Зберегти', 'button.new': 'Додати', 'col.status': 'Статус', 'x.title': 'Назва' });
  await write('labels/en.json', { 'button.save': 'Confirm', 'dialog.save': 'Save', 'button.new': 'Add', 'col.status': 'Status', 'x.title': 'Title' });
  await write('labels/tr.json', { 'button.save': 'Onayla', 'dialog.save': 'Kaydet', 'button.new': 'Ekle', 'col.status': 'Durum', 'x.title': 'Başlık' });

  const check = await cli(dir, 'check');
  assert.equal(check.code, 10);
  const second = await cli(dir, 'import');
  assert.deepEqual(second.out.diff, { added: 1, removed: 1, changed: 1, rekeyed: 0 });
  const blocked = await cli(dir, 'import');
  assert.equal(blocked.code, 3);
  assert.equal((await cli(dir, 'check')).out.pendingSync, true);

  // A page with uncommitted edits is skipped, and the diff stays pending.
  const uaFile = path.join(dir, 'docs/filters/filters.md');
  await fs.appendFile(uaFile, '\nДоповнення.\n');
  const skipped = await cli(dir, 'sync', '--commit');
  assert.equal(skipped.out.skipped.length, 1);
  assert.equal(skipped.out.pendingRemains, true);
  assert.equal(await fs.readFile(uaFile, 'utf8').then((t) => t.includes('**Зберегти**')), true);
  await git(dir, 'add', 'docs');
  await git(dir, 'commit', '-qm', 'ua edit');
  // Simulate the translator having recorded the tr page against the edited UA page.
  const stateFile = path.join(dir, '.doc-toolkit/pages/filters/filters.json');
  const recorded = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  recorded.locales.tr.sourceBlob = gitBlobHash(await fs.readFile(uaFile, 'utf8'));
  await fs.writeFile(stateFile, JSON.stringify(recorded, null, 2) + '\n');
  await git(dir, 'add', '.doc-toolkit');
  await git(dir, 'commit', '-qm', 'record');

  const synced = await cli(dir, 'sync', '--commit');
  assert.equal(synced.code, 0, synced.stderr);
  assert.deepEqual(synced.out.patched.filter((p) => p.page === 'filters/filters').map((p) => [p.locale, p.old, p.new]), [
    ['uk', 'Зберегти', 'Підтвердити'],
    ['en', 'Save', 'Confirm'],
    ['tr', 'Kaydet', 'Onayla'],
  ]);
  // Req 3, criterion 2a: the page bound to the sibling key still shows the old strings and is reported, not patched.
  assert.deepEqual(
    synced.out.checkBinding.map((c) => [c.page, c.locale, c.boundKey, c.changedKey, c.old, c.new]).sort(),
    [
      ['dialog/dialog', 'en', 'dialog.save', 'button.save', 'Save', 'Confirm'],
      ['dialog/dialog', 'tr', 'dialog.save', 'button.save', 'Kaydet', 'Onayla'],
      ['dialog/dialog', 'uk', 'dialog.save', 'button.save', 'Зберегти', 'Підтвердити'],
    ].sort(),
  );
  assert.ok(synced.out.patched.every((p) => p.page !== 'dialog/dialog'));
  assert.ok((await fs.readFile(path.join(dir, 'docs/dialog/dialog.md'), 'utf8')).includes('**Зберегти**'));
  assert.deepEqual(synced.out.broken.map((b) => [b.key, b.pages]), [['old.key', ['filters/filters']]]);
  assert.deepEqual(synced.out.undocumented.map((u) => u.key), ['button.new']);
  assert.ok(synced.out.commit);
  assert.match(await git(dir, 'log', '-1', '--format=%s'), /^Sync UI labels to command@/);
  assert.equal(await git(dir, 'status', '--porcelain', '--', 'docs', 'i18n', '.doc-toolkit'), '');

  const ua = await fs.readFile(uaFile, 'utf8');
  assert.ok(ua.includes('**Підтвердити**') && ua.includes('**Статус**') && ua.includes('**Увага:**'));
  assert.ok((await fs.readFile(path.join(dir, 'i18n/en/docusaurus-plugin-content-docs/current/filters/filters.md'), 'utf8')).includes('**Confirm**'));
  assert.ok((await fs.readFile(path.join(dir, 'i18n/tr/docusaurus-plugin-content-docs/current/filters/filters.md'), 'utf8')).includes('**Onayla**'));

  // State: span renamed, locale marked up to date with the patched UA blob.
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.equal(state.spans['Підтвердити'], 'label:button.save');
  assert.equal(state.spans['Зберегти'], undefined);
  assert.equal(state.locales.tr.sourceBlob, gitBlobHash(ua));
  assert.equal(state.locales.tr.labelSnapshot, second.out.commit);

  // A translation that was already stale keeps its old blob, so the pending UA change still triggers re-translation.
  const stale = JSON.parse(await fs.readFile(path.join(dir, '.doc-toolkit/pages/stale/stale.json'), 'utf8'));
  assert.equal(stale.locales.tr.sourceBlob, gitBlobHash('Натисніть **Зберегти**.\n'));
  assert.equal(stale.locales.tr.labelSnapshot, 'old');
  assert.ok((await fs.readFile(path.join(dir, 'docs/stale/stale.md'), 'utf8')).includes('**Підтвердити**'));

  assert.equal((await cli(dir, 'sync')).out.status, 'nothing-to-sync');
  assert.equal((await cli(dir, 'check')).code, 0);
});

test('diff command compares two snapshot directories', async () => {
  const { dir, write } = await fixtureRepo();
  await cli(dir, 'import');
  await fs.cp(path.join(dir, '.doc-toolkit/ui-labels'), path.join(dir, 'snap-a'), { recursive: true });
  await write('labels/uk.json', { 'button.save': 'Підтвердити', 'dialog.save': 'Зберегти', 'col.status': 'Статус', 'old.key': 'Видалене', 'x.title': 'Назва' });
  await cli(dir, 'import', '--discard-pending');
  const d = await cli(dir, 'diff', 'snap-a', '.doc-toolkit/ui-labels');
  assert.equal(d.out.summary.changed, 1);
});

test('sync patches sidebar category labels: UA _category_.json, each locale\'s current.json, and the category state', async () => {
  const { dir, write } = await fixtureRepo();
  const read = (rel) => fs.readFile(path.join(dir, rel), 'utf8');
  const json = async (rel) => JSON.parse(await read(rel));
  const TR = 'i18n/tr/docusaurus-plugin-content-docs/current.json';
  const EN = 'i18n/en/docusaurus-plugin-content-docs/current.json';
  const entry = (message, label) => ({ message, description: `The label for category '${label}' in sidebar 'tutorialSidebar'` });

  // One more app string, used by a category whose file is laid out compactly.
  for (const [l, v] of [['uk', 'Документи'], ['en', 'Documents'], ['tr', 'Belgeler']]) await write(`labels/${l}.json`, { ...(await json(`labels/${l}.json`)), 'menu.docs': v });

  // A: no `key`, with a generated index. B: explicit `key`. C: compact JSON. D: no `key`, bound to the same string as A's sibling.
  const A = { label: 'Назва', position: 2, link: { type: 'generated-index', description: 'Опис розділу.' } };
  const B = { label: 'Статус', position: 3, key: 'status-section' };
  await write('docs/section/_category_.json', A);
  await write('docs/status-section/_category_.json', B);
  await write('docs/loose/_category_.json', '{"label":"Документи","position":4}\n');
  const state = (spans, ua) => ({ spans, locales: { tr: { sourceBlob: gitBlobHash(ua), labelSnapshot: 'old', translatedAt: '2026-10-01', unverified: [], assetFallbacks: [] } } });
  const uaText = (o) => JSON.stringify(o, null, 2) + '\n';
  await write('.doc-toolkit/pages/section/_category_.json', state({ Назва: 'label:x.title' }, uaText(A)));
  await write('.doc-toolkit/pages/status-section/_category_.json', state({ Статус: 'label:col.status' }, uaText(B)));
  await write('.doc-toolkit/pages/loose/_category_.json', state({ Документи: 'label:menu.docs' }, '{"label":"Документи","position":4}\n'));
  const sid = 'sidebar.tutorialSidebar.category';
  await write(TR, {
    'version.label': { message: 'Sonraki', description: 'The label for version current' },
    [`${sid}.Назва`]: entry('Başlık', 'Назва'),
    [`${sid}.Назва.link.generated-index.description`]: entry('Bölüm açıklaması.', 'Назва'),
    [`${sid}.status-section`]: entry('Durum', 'Статус'),
    [`${sid}.Документи`]: entry('Belgeler', 'Документи'),
  });
  await write(EN, {
    'version.label': { message: 'Next', description: 'The label for version current' },
    [`${sid}.Назва`]: entry('Title', 'Назва'),
    [`${sid}.Назва.link.generated-index.description`]: entry('Опис розділу.', 'Назва'), // never translated: still the UA text
    [`${sid}.status-section`]: entry('Статус', 'Статус'), // never translated
    [`${sid}.Документи`]: entry('Documents', 'Документи'),
  });
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-qm', 'categories');
  assert.equal((await cli(dir, 'import')).code, 0);
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-qm', 'labels');

  // The release renames three strings in every language.
  const release = { uk: { 'x.title': 'Заголовок', 'col.status': 'Стан', 'menu.docs': 'Матеріали' }, en: { 'x.title': 'Heading', 'col.status': 'State', 'menu.docs': 'Materials' }, tr: { 'x.title': 'Başlıklar', 'col.status': 'Durumu', 'menu.docs': 'Malzemeler' } };
  for (const [l, v] of Object.entries(release)) await write(`labels/${l}.json`, { ...(await json(`labels/${l}.json`)), ...v });
  assert.equal((await cli(dir, 'import')).code, 0);

  const r = await cli(dir, 'sync', '--commit');
  assert.equal(r.code, 0, r.stderr + JSON.stringify(r.out));
  const mine = (list) => list.filter((p) => /_category_$/.test(p.page));

  // Patched: the UA label and the message in each locale; an untranslated entry follows the UA text.
  assert.deepEqual(
    mine(r.out.patched).map((p) => [p.page, p.locale, p.old, p.new, p.untranslated ?? false, p.file]).sort(),
    [
      ['section/_category_', 'uk', 'Назва', 'Заголовок', false, 'docs/section/_category_.json'],
      ['section/_category_', 'en', 'Title', 'Heading', false, EN],
      ['section/_category_', 'tr', 'Başlık', 'Başlıklar', false, TR],
      ['status-section/_category_', 'uk', 'Статус', 'Стан', false, 'docs/status-section/_category_.json'],
      ['status-section/_category_', 'en', 'Статус', 'Стан', true, EN],
      ['status-section/_category_', 'tr', 'Durum', 'Durumu', false, TR],
      ['loose/_category_', 'en', 'Documents', 'Materials', false, EN],
      ['loose/_category_', 'tr', 'Belgeler', 'Malzemeler', false, TR],
    ].sort(),
  );
  for (const p of mine(r.out.patched)) assert.ok(p.line > 0 && p.text.includes(p.new), `line of the patched value: ${JSON.stringify(p)}`);

  // UA files: only the label changed, layout untouched; the compact file was not reformatted.
  assert.equal(await read('docs/section/_category_.json'), uaText({ ...A, label: 'Заголовок' }));
  assert.equal(await read('docs/status-section/_category_.json'), uaText({ ...B, label: 'Стан' }));
  assert.equal(await read('docs/loose/_category_.json'), '{"label":"Документи","position":4}\n');
  assert.deepEqual(mine(r.out.unpatched).map((p) => [p.page, p.locale]), [['loose/_category_', 'uk']]);
  assert.match(mine(r.out.unpatched)[0].reason, /cannot be patched without reformatting/);

  // current.json: messages patched, other entries and descriptions kept, in the same order. Without a `key` the entry keys
  // follow the UA label (label and generated-index description), so Docusaurus still finds the translation.
  const tr = await json(TR);
  assert.deepEqual(Object.keys(tr), ['version.label', `${sid}.Заголовок`, `${sid}.Заголовок.link.generated-index.description`, `${sid}.status-section`, `${sid}.Документи`]);
  assert.deepEqual([tr[`${sid}.Заголовок`].message, tr[`${sid}.Заголовок.link.generated-index.description`].message, tr[`${sid}.status-section`].message], ['Başlıklar', 'Bölüm açıklaması.', 'Durumu']);
  assert.equal(tr[`${sid}.Заголовок`].description, "The label for category 'Назва' in sidebar 'tutorialSidebar'");
  assert.equal(tr['version.label'].message, 'Sonraki');
  const en = await json(EN);
  // The never-translated entry follows the new UA text (it stays "untranslated", so locale-sync still translates it later).
  assert.deepEqual([en[`${sid}.Заголовок`].message, en[`${sid}.Заголовок.link.generated-index.description`].message, en[`${sid}.status-section`].message], ['Heading', 'Опис розділу.', 'Стан']);
  // C's UA label could not be patched, so its entry keys were NOT renamed (the messages were).
  assert.deepEqual([tr[`${sid}.Документи`].message, en[`${sid}.Документи`].message], ['Malzemeler', 'Materials']);
  assert.deepEqual(r.out.renamedEntries.map((x) => [x.page, x.locale, x.from.replace(`${sid}.`, ''), x.to.replace(`${sid}.`, '')]).sort(), [
    ['section/_category_', 'en', 'Назва', 'Заголовок'],
    ['section/_category_', 'en', 'Назва.link.generated-index.description', 'Заголовок.link.generated-index.description'],
    ['section/_category_', 'tr', 'Назва', 'Заголовок'],
    ['section/_category_', 'tr', 'Назва.link.generated-index.description', 'Заголовок.link.generated-index.description'],
  ].sort());

  // State: the span follows the UA label, and tr is marked up to date with the patched UA file.
  const s = await json('.doc-toolkit/pages/section/_category_.json');
  assert.deepEqual([s.spans, s.locales.tr.sourceBlob, s.locales.tr.labelSnapshot], [{ Заголовок: 'label:x.title' }, gitBlobHash(uaText({ ...A, label: 'Заголовок' })), (await json('.doc-toolkit/ui-labels/meta.json')).commit]);
  assert.equal((await json('.doc-toolkit/pages/status-section/_category_.json')).locales.tr.sourceBlob, gitBlobHash(uaText({ ...B, label: 'Стан' })));
  // The compact file: its UA label could not be patched, so the span and tr's source blob stay as they were; tr's own message was patched.
  const loose = await json('.doc-toolkit/pages/loose/_category_.json');
  assert.deepEqual([loose.spans, loose.locales.tr.sourceBlob, loose.locales.tr.labelSnapshot !== 'old'], [{ Документи: 'label:menu.docs' }, gitBlobHash('{"label":"Документи","position":4}\n'), true]);

  // The shared current.json did not block the second and third category, and everything went into one commit.
  assert.equal(r.out.skipped.length, 0);
  assert.deepEqual(r.out.skipped, []);
  assert.ok(r.out.commit);
  assert.equal(await git(dir, 'status', '--porcelain', '--', 'docs', 'i18n', '.doc-toolkit'), '');
  assert.equal((await cli(dir, 'sync')).out.status, 'nothing-to-sync', 'the diff is no longer pending, so the next import can run');
});
