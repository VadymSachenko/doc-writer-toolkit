// Test fixtures: a throwaway docs repo with a changed range, and a small static site in the layout `docusaurus build`
// writes (the default locale at the top, the others under <locale>/, a folder with an index.html per page).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const sh = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim();
export const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
export const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));

export const CLAUDE_MD = `# Docs

## Documentation toolkit configuration

- **UA content root:** \`docs/\`
- **EN i18n root:** \`i18n/en/docusaurus-plugin-content-docs/current/\`
- **UA URL prefix:** \`/\`
`;

export const DOCUSAURUS_CONFIG = `export default {
  baseUrl: '/',
  i18n: { defaultLocale: 'uk', locales: ['uk', 'en', 'ru'] },
};
`;

const EN_ROOT = 'i18n/en/docusaurus-plugin-content-docs/current';
const RU_ROOT = 'i18n/ru/docusaurus-plugin-content-docs/current';

// A repo whose last commit adds three pages: guide/01-payments, guide/limits, guide/intro.
// ru has no file for `limits`, so the site shows the Ukrainian text there.
export function makeHost() {
  const dir = tmp('visual-pack-host');
  sh(dir, 'init', '-q', '-b', 'main');
  write(dir, 'CLAUDE.md', CLAUDE_MD);
  write(dir, 'docusaurus.config.js', DOCUSAURUS_CONFIG);
  write(dir, 'README.md', 'docs\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'Initial');
  const page = (title) => `---\ntitle: ${title}\n---\n\n# ${title}\n`;
  write(dir, 'docs/guide/01-payments.md', page('Платежі'));
  write(dir, 'docs/guide/limits.md', page('Ліміти'));
  write(dir, 'docs/guide/intro.md', page('Вступ'));
  write(dir, 'docs/guide/_partial.md', page('Частина'));
  write(dir, `${EN_ROOT}/guide/01-payments.md`, page('Payments'));
  write(dir, `${EN_ROOT}/guide/limits.md`, page('Limits'));
  write(dir, `${EN_ROOT}/guide/intro.md`, page('Intro'));
  write(dir, `${RU_ROOT}/guide/01-payments.md`, page('Платежи'));
  write(dir, `${RU_ROOT}/guide/intro.md`, page('Введение'));
  write(dir, 'docs/.assets/shot.png', 'not a page');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'Add the guide');
  return { dir, range: 'HEAD~1..HEAD' };
}

// 1x1 transparent PNG
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');

const UK = {
  payments: ['Платежі', 'Платіж створюється після підтвердження замовлення клієнтом.', 'Ця сума повертається клієнту автоматично протягом доби.'],
  limits: ['Ліміти', 'Ліміт на одну операцію задає адміністратор для кожного клієнта окремо.', null],
  intro: ['Вступ', 'Цей розділ пояснює, як працюють платежі та ліміти для клієнта.', null],
};
const EN = {
  payments: ['Payments', 'A payment is created after the customer confirms the order.', 'This amount is returned to the customer automatically within a day.'],
  limits: ['Limits', 'The limit for one operation is set by an administrator for each customer separately.', null],
  intro: ['Introduction', 'This section explains how payments and limits work for the customer.', null],
};
const RU = {
  payments: ['Платежи', 'Платёж создаётся после подтверждения заказа клиентом.', 'Ця сума повертається клієнту автоматично протягом доби.'], // the second paragraph was left in Ukrainian
  limits: UK.limits, // no ru file: the site falls back to the Ukrainian page
  intro: ['Введение', 'Этот раздел объясняет, как работают платежи и лимиты для клиента.', null],
};
const TEXT = { uk: UK, en: EN, ru: RU };

const CSS = 'body{margin:0;font:16px sans-serif}main{max-width:900px;margin:0 auto;padding:0 16px}table{display:block;overflow:auto;border-collapse:collapse}td,th{border:1px solid #888;padding:4px}';

function pageHtml(locale, name, { tripPort }) {
  const [title, p1, p2] = TEXT[locale][name];
  const parts = [`<h1>${title}</h1>`, `<p>${p1}</p>`];
  if (p2) parts.push(`<p>${p2}</p>`);
  let head = '';
  if (name === 'payments') {
    parts.push('<p><img src="/img/ok.png" alt="fine" width="40" height="40"></p>');
    parts.push('<p><img src="/img/missing.png" alt="missing" width="40" height="40"></p>');
    parts.push('<p><img src="http://external.example.invalid/pixel.png" alt="external"></p>');
    if (tripPort) parts.push(`<p><img src="http://127.0.0.1:${tripPort}/pixel.png" alt="other port"></p>`);
    head = '<link rel="stylesheet" href="http://external.example.invalid/site.css">';
  }
  if (name === 'limits') {
    const cols = Array.from({ length: 30 }, (_, i) => `<th style="white-space:nowrap;min-width:120px">Column ${i + 1}</th>`).join('');
    const cells = Array.from({ length: 30 }, (_, i) => `<td>${i + 1}</td>`).join('');
    parts.push(`<table><thead><tr>${cols}</tr></thead><tbody><tr>${cells}</tr></tbody></table>`);
    parts.push('<ul><li><strong>Create payment</strong></li></ul>');
  }
  if (name === 'intro') {
    parts.push('<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr></tbody></table>');
    parts.push('<p><img src="/img/ok.png" alt="fine" width="40" height="40"></p>');
  }
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><title>${title}</title><style>${CSS}</style>${head}</head><body><main><article><div class="theme-doc-markdown markdown">${parts.join('')}</div></article></main></body></html>`;
}

// The built site for the host above. `tripPort` is a second local port that the payments page also asks for.
export function makeBuild({ tripPort } = {}) {
  const dir = tmp('visual-pack-build');
  write(dir, 'index.html', '<!doctype html><title>Home</title><main><article><h1>Home</h1></article></main>');
  write(dir, '404.html', '<!doctype html><title>Not found</title><main><article><h1>Page Not Found</h1></article></main>');
  fs.mkdirSync(path.join(dir, 'img'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'img', 'ok.png'), PNG);
  for (const locale of ['uk', 'en', 'ru']) {
    const lead = locale === 'uk' ? '' : `${locale}/`;
    for (const name of ['payments', 'limits', 'intro']) write(dir, `${lead}guide/${name}/index.html`, pageHtml(locale, name, { tripPort }));
  }
  return dir;
}

// A second host for the slow screenshot: its last commit adds one page, guide/slow, in uk, en and ru.
export function makeSlowHost() {
  const dir = tmp('visual-pack-slow-host');
  sh(dir, 'init', '-q', '-b', 'main');
  write(dir, 'CLAUDE.md', CLAUDE_MD);
  write(dir, 'docusaurus.config.js', DOCUSAURUS_CONFIG);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'Initial');
  const page = (title) => `---\ntitle: ${title}\n---\n\n# ${title}\n`;
  write(dir, 'docs/guide/slow.md', page('Довга сторінка'));
  write(dir, `${EN_ROOT}/guide/slow.md`, page('Long page'));
  write(dir, `${RU_ROOT}/guide/slow.md`, page('Длинная страница'));
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'Add the slow page');
  return { dir, range: 'HEAD~1..HEAD' };
}

const SLOW = {
  uk: ['Довга сторінка', 'Ця сторінка довго готується до знімка екрана, як найдовші сторінки довідника.'],
  en: ['Long page', 'This page takes a long time to get ready for its screenshot, like the longest reference pages.'],
  ru: ['Длинная страница', 'Эта страница долго готовится к снимку экрана, как самые длинные страницы справочника.'],
};

// A page whose screenshot waits `stallMs` and nothing else does. The capture reads the DOM first (measureDom clones
// every block, and a clone of <shot-stall> is constructed detached, after the load); right after that read, the page
// takes its body away for `stallMs`. The screenshot waits for a body, so it waits that long. The read itself is over,
// and no CPU is spent while the page waits.
function slowPageHtml(locale, stallMs) {
  const [title, p1] = SLOW[locale];
  const stall = stallMs
    ? `<p>${p1} <shot-stall></shot-stall></p><script>
(() => {
  let armed = false;
  customElements.define('shot-stall', class extends HTMLElement {
    constructor() {
      super();
      if (armed || this.isConnected || document.readyState !== 'complete') return;
      armed = true;
      queueMicrotask(() => {
        const body = document.body;
        body.remove();
        setTimeout(() => document.documentElement.append(body), ${Number(stallMs)});
      });
    }
  });
})();
</script>`
    : `<p>${p1}</p>`;
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><title>${title}</title><style>${CSS}</style></head><body><main><article><div class="theme-doc-markdown markdown"><h1>${title}</h1>${stall}</div></article></main></body></html>`;
}

// The built site for the slow host. `stallMs` maps a locale to how long its screenshot waits (none: no wait);
// `locales` are the locales the build has, so a locale left out answers 404.
export function makeSlowBuild({ stallMs = {}, locales = ['uk', 'en', 'ru'] } = {}) {
  const dir = tmp('visual-pack-slow-build');
  write(dir, 'index.html', '<!doctype html><title>Home</title><main><article><h1>Home</h1></article></main>');
  write(dir, '404.html', '<!doctype html><title>Not found</title><main><article><h1>Page Not Found</h1></article></main>');
  for (const locale of locales) write(dir, `${locale === 'uk' ? '' : `${locale}/`}guide/slow/index.html`, slowPageHtml(locale, stallMs[locale] ?? 0));
  return dir;
}
