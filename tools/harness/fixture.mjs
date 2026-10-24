#!/usr/bin/env node
// Writes a fresh, neutral fixture host: a git repo with Ukrainian pages, their English translations and a
// "Documentation toolkit configuration" block in CLAUDE.md. No dependencies.
//   single  one root pair: `portal/` (UA) and its EN i18n tree.
//   multi   two pairs: `portal/` and an API reference pair `docs/`, whose EN page has one section missing.
// Options: --locales de,pl adds further locales to docusaurus.config.ts; --docusaurus adds what `docusaurus build`
// needs (package.json, sidebars). Usage: node tools/harness/fixture.mjs <dest> single|multi [--locales …] [--docusaurus]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORTAL_EN = 'i18n/en/docusaurus-plugin-content-docs-portal/current';
const DOCS_EN = 'i18n/en/docusaurus-plugin-content-docs/current';

const page = (title, body) => `---\ntitle: ${title}\nsidebar_label: ${title}\n---\n\n# ${title}\n\n${body.trim()}\n`;

const portalTransactionsUk = page('Транзакції', `
На сторінці **Транзакції** видно всі платежі вашого акаунта за вибраний період.

## Перегляд транзакцій

1. У меню виберіть **Транзакції**.
2. Задайте період у полі **Дата**.

Список оновлюється автоматично.

## Фільтрування транзакцій

Щоб звузити список, натисніть **Фільтри** і виберіть статус платежу. Валюту за замовчуванням задають у [налаштуваннях](/portal/settings/settings).

## Повідомлення про платежі

Про кожну зміну статусу система може надсилати повідомлення на ваш сервер. Докладніше: [Вебхуки](/webhooks/webhooks).
`);

const portalTransactionsEn = page('Transactions', `
The **Транзакції** page shows every payment in your account for the period you choose.

## View transactions

1. In the menu, select **Транзакції**.
2. Set the period in the **Дата** field.

The list updates automatically.

## Filter transactions

To narrow the list, select **Фільтри** and choose a payment status. You set the default currency in [settings](/portal/settings/settings).

## Payment notifications

The system can notify your server about every status change. For details, see [Webhooks](/webhooks/webhooks).
`);

const portalSettingsUk = page('Налаштування', `
На сторінці **Налаштування** ви керуєте даними акаунта.

## Валюта за замовчуванням

{/* NEEDS CONFIRMATION: default currency */}
Валюту за замовчуванням вибирають у полі **Валюта**.
`);

const portalSettingsEn = page('Settings', `
On the **Налаштування** page, you manage your account details.

## Default currency

{/* NEEDS CONFIRMATION: default currency */}
You choose the default currency in the **Валюта** field.
`);

const docsSections = [
  ['Об’єкт транзакції', 'Транзакція описує один платіж: суму, валюту і статус.'],
  ['Статуси', 'Транзакція має статус `created`, `pending`, `succeeded` або `failed`.'],
  ['Створення транзакції', 'Щоб створити транзакцію, надішліть запит `POST /transactions`.'],
  ['Отримання транзакції', 'Щоб отримати транзакцію, надішліть запит `GET /transactions/{id}`.'],
  ['Помилки', 'Якщо запит неправильний, API повертає код `400` і опис помилки.'],
];
const docsSectionsEn = [
  ['Transaction object', 'A transaction describes one payment: its amount, currency and status.'],
  ['Statuses', 'A transaction has the status `created`, `pending`, `succeeded` or `failed`.'],
  ['Create a transaction', 'To create a transaction, send a `POST /transactions` request.'],
  ['Get a transaction', 'To get a transaction, send a `GET /transactions/{id}` request.'],
  ['Errors', 'If a request is invalid, the API returns code `400` and a description of the error.'],
];
const docsLinks = `
Пов’язані сторінки:

- [Вебхуки](/webhooks/webhooks)
- [Налаштування кабінету](/portal/settings/settings)
- [Вебхуки, шлях до файлу](/docs/webhooks/webhooks)
- [Вебхуки, відносне посилання](../webhooks/webhooks.md)
- [Вебхуки, з розширенням](/webhooks/webhooks.md)
`;
const sections = (list) => list.map(([h, p]) => `## ${h}\n\n${p}\n`).join('\n');

const docsTransactionsUk = page('Транзакції API', `Цей розділ описує транзакції в API.\n\n${sections(docsSections)}${docsLinks}`);
// One section missing: an alignment bug that only the right pair shows.
const docsTransactionsEn = page('Transactions API', `This section describes transactions in the API.\n\n${sections(docsSectionsEn.filter((_, i) => i !== 3))}
Related pages:

- [Webhooks](/webhooks/webhooks)
- [Portal settings](/portal/settings/settings)
`);

const docsWebhooksUk = page('Вебхуки', `
Вебхук — це запит, який система надсилає на ваш сервер, коли змінюється статус транзакції.

## Налаштування вебхука

Адресу для вебхуків задають у кабінеті. {/* ToDo: link to the settings page */}

## Повторні спроби

Якщо ваш сервер не відповів кодом \`200\`, система повторює запит до п’яти разів.
`);

const files = {
  common: (shape, locales) => ({
    'CLAUDE.md': `# Fixture host\n\nA neutral test host for the documentation toolkit.\n\n## Documentation toolkit configuration\n\n${[
      '- **Style guide:** `gdsg`',
      '- **Content language:** `uk`',
      '- **UA content root:** `portal/`',
      `- **EN i18n root:** \`${PORTAL_EN}/\``,
      '- **UA URL prefix:** `/portal/`',
      ...(shape === 'multi' ? [
        '- **API reference UA content root:** `docs/`',
        `- **API reference EN i18n root:** \`${DOCS_EN}/\``,
        '- **API reference UA URL prefix:** `/`',
      ] : []),
      '- **App:** `web-app`',
      '- **UI label source:** `command cat labels/{locale}.json`',
    ].join('\n')}\n`,
    'docusaurus.config.ts': docusaurusConfig(shape, locales),
    '.gitignore': 'node_modules\nbuild/\n.docusaurus/\n',
    'labels/uk.json': `${JSON.stringify({ 'menu.transactions': 'Транзакції', 'menu.settings': 'Налаштування', 'filters.open': 'Фільтри', 'field.date': 'Дата', 'field.currency': 'Валюта' }, null, 2)}\n`,
    'labels/en.json': `${JSON.stringify({ 'menu.transactions': 'Transactions', 'menu.settings': 'Settings', 'filters.open': 'Filters', 'field.date': 'Date', 'field.currency': 'Currency' }, null, 2)}\n`,
    'portal/transactions/transactions.md': portalTransactionsUk,
    'portal/settings/settings.md': portalSettingsUk,
    [`${PORTAL_EN}/transactions/transactions.md`]: portalTransactionsEn,
    [`${PORTAL_EN}/settings/settings.md`]: portalSettingsEn,
    'blog/post.md': '# Release notes\n\nA page outside every root.\n',
    'notes/en-note.md': '# Team note\n\nThis note is written in English and sits outside every root.\n',
  }),
  multi: () => ({
    'docs/transactions/transactions.md': docsTransactionsUk,
    'docs/webhooks/webhooks.md': docsWebhooksUk,
    'docs/webhooks/.sources/notes.md': 'Нотатки з розмови: повторів п’ять, інтервал росте, підпис у заголовку X-Signature.\n',
    'docs/api-reference/create-payment/create-payment.md': page('Створення платежу', 'Запит `POST /payments` створює платіж.\n\n## Параметри запиту\n\n| Параметр | Тип | Опис |\n|---|---|---|\n| `amount` | integer | Сума в мінімальних одиницях |\n'),
    'docs/.sources/change-brief-webhooks.md': '# Change brief\n\n- **Page:** `docs/webhooks/webhooks.md`\n- **Change:** retries go up to seven times, not five.\n',
    [`${DOCS_EN}/transactions/transactions.md`]: docsTransactionsEn,
    'docs-archive/old.md': '# Old page\n\nNot a content root, but its folder shares the `docs` stem.\n',
  }),
  docusaurus: () => ({
    'package.json': `${JSON.stringify({
      name: 'fixture-host', private: true,
      scripts: { build: 'docusaurus build' },
      dependencies: { '@docusaurus/core': '3.10.2', '@docusaurus/preset-classic': '3.10.2', react: '19.2.0', 'react-dom': '19.2.0' },
    }, null, 2)}\n`,
    'sidebars.js': "export default { main: [{ type: 'autogenerated', dirName: '.' }] };\n",
  }),
};

function docusaurusConfig(shape, locales) {
  const all = ['uk', 'en', ...locales];
  const portal = "['@docusaurus/plugin-content-docs', { id: 'portal', path: 'portal', routeBasePath: 'portal', sidebarPath: './sidebars.js' }]";
  return `export default {
  title: 'Fixture host',
  url: 'https://example.com',
  baseUrl: '/',
  onBrokenLinks: 'warn',
  i18n: { defaultLocale: 'uk', locales: ${JSON.stringify(all).replace(/"/g, "'")} },
  presets: [['classic', { docs: ${shape === 'multi' ? "{ path: 'docs', routeBasePath: '/', sidebarPath: './sidebars.js' }" : 'false'}, blog: false, pages: false, theme: {} }]],
  plugins: [${portal}],
};
`;
}

export function makeFixture(dest, shape, { locales = [], docusaurus = false } = {}) {
  if (!['single', 'multi'].includes(shape)) throw new Error(`unknown fixture shape '${shape}' (single or multi)`);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new Error(`${dest} is not empty`);
  const tree = { ...files.common(shape, locales), ...(shape === 'multi' ? files.multi() : {}), ...(docusaurus ? files.docusaurus() : {}) };
  for (const [rel, text] of Object.entries(tree)) {
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.writeFileSync(path.join(dest, rel), text);
  }
  const git = (...args) => execFileSync('git', args, { cwd: dest, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-q', '-m', `Fixture host (${shape})`);
  return Object.keys(tree).sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dest, shape] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--locales');
  const i = process.argv.indexOf('--locales');
  const locales = i === -1 ? [] : process.argv[i + 1].split(',').filter(Boolean);
  if (!dest || !shape) {
    console.error('usage: node tools/harness/fixture.mjs <dest> single|multi [--locales de,pl] [--docusaurus]');
    process.exit(2);
  }
  const written = makeFixture(path.resolve(dest), shape, { locales, docusaurus: process.argv.includes('--docusaurus') });
  console.log(`${dest}: ${shape}, ${written.length} files, 1 commit`);
}
