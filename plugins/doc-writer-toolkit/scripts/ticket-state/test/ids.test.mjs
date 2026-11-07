import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ago, card, gitRepo, pr } from './fakes.mjs';
import { ledger, world } from './helpers.mjs';
import { makeGit } from '../lib/world.mjs';
import { isIdOnlyChange, slugOf } from '../lib/ids.mjs';

// D-073. A UA change is id-only when its only differences from the approved version are (1) `{/* #id */}` comments
// added to headings that had none, and (2) link fragments rewritten from such a heading's old fragment to its new id.
// Anything else makes it a real change: a changed or removed id, a changed heading text, or any other edit.

const page = (before, after, p = 'docs/pay/refunds.md') => ({ path: p, before, after });
const BEFORE = '# Повернення\n\n## Передумови\n\nДив. [передумови](#передумови) і [кроки](#кроки-повернення).\n\n## Кроки повернення\n\n1. Відкрийте **Архів**.\n';

test('(1) ids added to headings that had none, and (2) links rewritten from the old fragments to the new ids: id-only', () => {
  const after = '# Повернення\n\n## Передумови {/* #prerequisites */}\n\nДив. [передумови](#prerequisites) і [кроки](#refund-steps).\n\n## Кроки повернення {/* #refund-steps */}\n\n1. Відкрийте **Архів**.\n';
  assert.equal(isIdOnlyChange(page(BEFORE, after)), true);
  // Only the ids, the links not yet rewritten: id-only too.
  assert.equal(isIdOnlyChange(page(BEFORE, BEFORE.replace('## Передумови', '## Передумови {/* #prerequisites */}'))), true);
  // The same text: nothing changed.
  assert.equal(isIdOnlyChange(page(BEFORE, BEFORE)), true);
});

test('a changed or removed id, a changed heading text, or any other edit is a real change', () => {
  const withIds = BEFORE.replace('## Передумови', '## Передумови {/* #prerequisites */}');
  assert.equal(isIdOnlyChange(page(withIds, withIds.replace('#prerequisites */}', '#before-you-start */}'))), false, 'a changed id');
  assert.equal(isIdOnlyChange(page(withIds, BEFORE)), false, 'a removed id');
  assert.equal(isIdOnlyChange(page(BEFORE, BEFORE.replace('## Передумови', '## Що потрібно {/* #prerequisites */}'))), false, 'the heading text changed with the id');
  assert.equal(isIdOnlyChange(page(BEFORE, BEFORE.replace('## Передумови', '### Передумови {/* #prerequisites */}'))), false, 'the heading level changed');
  assert.equal(isIdOnlyChange(page(BEFORE, BEFORE.replace('Відкрийте', 'Перейдіть до'))), false, 'a word');
  assert.equal(isIdOnlyChange(page(BEFORE, `${BEFORE}\n`)), false, 'a line added');
  assert.equal(isIdOnlyChange(page(BEFORE, BEFORE.replace('[передумови](#передумови)', '[передумови](#prerequisites)'))), false, 'a link rewritten to an id no heading got');
  assert.equal(isIdOnlyChange(page(BEFORE, BEFORE.replace('## Передумови', '## Передумови {/* #prerequisites */}').replace('(#кроки-повернення)', '(#prerequisites)'))), false, 'a link rewritten from another heading fragment');
  assert.equal(isIdOnlyChange(page(BEFORE, BEFORE.replace('## Передумови', '## Передумови {/* #prerequisites */}').replace('[передумови](#передумови)', '[умови](#prerequisites)'))), false, 'the link text changed');
  assert.equal(isIdOnlyChange(page(null, BEFORE)), false, 'a new page');
  assert.equal(isIdOnlyChange(page(BEFORE, null)), false, 'a removed page');
});

test('links to another page of the same change, by file path or by route, and with an encoded old fragment', () => {
  const limitsBefore = '# Ліміти\n\n## Денний ліміт\n\nТекст.\n';
  const limitsAfter = '# Ліміти\n\n## Денний ліміт {/* #daily-limit */}\n\nТекст.\n';
  const limits = page(limitsBefore, limitsAfter, 'docs/pay/limits.md');
  const encoded = encodeURIComponent('денний-ліміт');
  const before = `Див. [ліміт](./limits.md#денний-ліміт), [ліміт](/pay/limits#${encoded}) і <a href="limits#денний-ліміт">ліміт</a>.\n`;
  const after = 'Див. [ліміт](./limits.md#daily-limit), [ліміт](/pay/limits#daily-limit) і <a href="limits#daily-limit">ліміт</a>.\n';
  const refunds = page(before, after);
  assert.equal(isIdOnlyChange(refunds, [refunds, limits]), true);
  assert.equal(isIdOnlyChange(refunds, [refunds]), false, 'the target page is not in the change: a real change');
  const limitsWithId = page(limitsAfter, limitsAfter, 'docs/pay/limits.md');
  assert.equal(isIdOnlyChange(refunds, [refunds, limitsWithId]), false, 'the heading already had its id before this change');
  assert.equal(isIdOnlyChange(page(before, after.replace('./limits.md#daily-limit', './other.md#daily-limit')), [limits]), false, 'the link path changed');
});

test('the old fragment is the slug Docusaurus made: punctuation dropped, repeats numbered; headings in code fences are not headings', () => {
  assert.equal(slugOf('Крок 2: `POST` /payments, **коротко**'), 'крок-2-post-payments-коротко');
  const before = '## Довідка\n\n## Довідка\n\n[друга](#довідка-1)\n\n```md\n## Не заголовок\n```\n';
  const after = '## Довідка {/* #reference-a */}\n\n## Довідка {/* #reference-b */}\n\n[друга](#reference-b)\n\n```md\n## Не заголовок\n```\n';
  assert.equal(isIdOnlyChange(page(before, after)), true);
  assert.equal(isIdOnlyChange(page(before, after.replace('(#reference-b)', '(#reference-a)'))), false);
  const fenced = before.replace('## Не заголовок\n', '## Не заголовок {/* #not-a-heading */}\n');
  assert.equal(isIdOnlyChange(page(before, fenced)), false, 'a line inside a code fence changed');
});

test('status: an id-only UA change keeps the approval and the chain stages; a word change makes them stale', async () => {
  const c = card({ number: 1001, status: 'translation' });
  const forgePr = pr({ repo: 'guide-docs', number: 71 });
  const w = world({ cards: [c], prs: [forgePr] });
  const repo = gitRepo(path.join(w.root, 'repos/guide-docs'));
  const v1 = repo.commit({ 'docs/pay/refunds.md': BEFORE, 'docs/pay/limits.md': '# Ліміти\n\n## Денний ліміт\n\nТекст.\n' });
  const ids = BEFORE.replace('## Передумови', '## Передумови {/* #prerequisites */}').replace('(#передумови)', '(#prerequisites)').replace('Відкрийте **Архів**.', 'Відкрийте **Архів**, див. [ліміт](./limits.md#daily-limit).');
  const chain = Object.fromEntries(['translate', 'enReview', 'locales', 'align', 'labelSync', 'build', 'visualPack'].map((s) => [s, { status: 'done', head: v1 }]));
  ledger(w, c, {
    stages: { start: 'done', plan: 'done', write: 'done', uaReview: 'done', pr: 'done' },
    prs: [{ repo: 'guide-docs', number: 71, targets: ['guide'], review: 'sme', stage: 'translation', chain, approval: { head: v1, at: ago(5) } }],
  });
  const git = makeGit(w.settings);
  const next = (t) => (t.next ? `${t.next.stage}${t.next.pr ? ` ${t.next.pr}` : ''}` : null);

  // Ids added on both pages, the links rewritten to them.
  forgePr.headCommit = repo.commit({
    'docs/pay/refunds.md': BEFORE.replace('## Передумови', '## Передумови {/* #prerequisites */}').replace('(#передумови)', '(#prerequisites)'),
    'docs/pay/limits.md': '# Ліміти\n\n## Денний ліміт {/* #daily-limit */}\n\nТекст.\n',
  });
  const kept = await w.one('1001', { git });
  assert.equal(kept.prs[0].approvalStale, 0, 'the approval stands');
  assert.deepEqual(kept.mismatch, []);
  assert.equal(next(kept), 'readyForMerge guide-docs#71', 'no chain stage went stale');

  // A word change (a new link sentence) after the ids.
  forgePr.headCommit = repo.commit({ 'docs/pay/refunds.md': ids });
  const stale = await w.one('1001', { git });
  assert.equal(stale.prs[0].approvalStale, 1);
  assert.match(stale.mismatch[0], /1 UA page\(s\) changed after the approval/);
  assert.equal(next(stale), 'translate guide-docs#71');
  assert.equal(stale.next.stale, 1);
});
