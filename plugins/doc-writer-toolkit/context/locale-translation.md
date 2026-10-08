---
name: locale-translation
description: Shared rules for translating approved UA pages into the target locales other than EN. Covers 1:1 block structure, what stays byte-identical, UI labels and the generic-noun rule, term memory, the per-locale register table, per-language calque traps and the worker's self-review checklist. Used by locale-translator. Referenced, never copied.
---

# Locale translation

These rules apply to every target locale except `en`. `doc-translator` owns UA → EN and has its own rules, which don't apply here. The source is always the UA page. Never read the EN page or use it as a reference: it is restructured for EN readers.

This file holds no product terms (they come from the label store and term memory), no orthography of the target languages, and no procedure (which script runs when belongs to `locale-translator`). Rule IDs (`P1`, `L2`…) are for the checklist and the run report. Each rule is stated here only.

## 1. Principle

- **P1. UA is a source of facts, not a sentence template.** Inside a block, split, merge and reorder sentences so the text reads as if it was written in the target language. This is the principle of `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/native-ukrainian.md` turned around: there English is the source and Ukrainian the target; here Ukrainian is the source.
- **P2. Facts don't move.** Keep every fact, condition, number, the direction "who does what to what", and modality (can / must / must not). Naturalness never changes meaning.
- **P3. Verbs over noun chains.** Use a verb where a literal rendering would stack deverbal nouns.
- **P4. Plain, not bureaucratic.** Don't replace a calque with officialese.
- **P5. Clear reference beats avoiding repetition.** Repeat the noun when a pronoun could point to two things.
- **P6. Translate what UA says.** Don't correct, update or complete facts, and don't add text UA doesn't have. Report suspected errors in the source; don't fix them.
- **P7. Task titles use one form per locale.** A task title (the page `title` and a task heading) stays an action, and a concept title stays a noun phrase. Every task title of a locale uses the form in the table below, on every page, so a page's title and the links that name it read the same everywhere. The noun in a title keeps the number of the UA noun («архів транзакцій» → tg `архиви амалиётҳо`, never `архиви амалиёт` on another page) and its term-memory translation. Never use an imperative (tr `Kayıtları filtreleyin`) or a Spanish gerund (`Filtrando registros`) as a title.

  | Locale | Task title form | ✅ | ⛔ |
  |---|---|---|---|
  | `ru` | infinitive, with the aspect of the UA verb | `Обработать выплаты`, `Просматривать баланс счетов` | `Добавление карты…` (a noun among infinitives) |
  | `tr` | verbal noun `-me`/`-ma` | `İşlem arşivini filtreleme` | `İşlem arşivini filtreleyin` |
  | `az` | infinitive `-mək`/`-maq` | `Hesabı tənzimləmək` | `Əməliyyat arxivini ixrac etmə`, `Kartların idarə edilməsi` |
  | `uz` | verbal noun `-ish`/`-sh` | `Tranzaksiyalar arxivini filtrlash` | an imperative |
  | `kk` | verbal noun `-у`/`-ю` | `Транзакциялар мұрағатын сүзу` | an imperative |
  | `ky` | verbal noun `-уу`/`-үү`/`-оо`/`-өө` | `Транзакциялар архивин экспорттоо` | an imperative |
  | `tg` | verbal noun in izofat with its object (a masdar `… кардани`, or the verb's action noun) | `Идора кардани кортҳо`, `Коркарди баҳсҳо` | an imperative; singular and plural of one noun on different pages |
  | `es` | infinitive | `Filtrar registros` | `Filtrando registros`, `Filtre registros` |

  A locale without a row uses the form its documentation uses for task titles, and the run reports the missing row.
- **P8. A UA dash for a missing "is" is Slavic punctuation.** `ru` keeps it. `tr` and `es` use their copula: tr `-dır`, es `es`. The other locales follow their own punctuation rules, not the UA dash.
- **P9. A link that names a page uses that page's title.** When the UA link text is the target page's title (in any grammatical form), the translated link text is the target page's title in this locale, from the `links` row of `locale-sync blocks`, inflected as the sentence needs (a case suffix, tg `-ро`, a possessive). Don't paraphrase it or pick another word for the page. When the row has no title (the target isn't translated yet), translate the UA title in the locale's title form (P7). `locale-sync check` warns about a link text that names its page differently.

## 2. Structure: blocks mirror UA 1:1

- **S1. One block for one block, in the same place.** This covers headings (same level and order), paragraphs, list items and steps (same count and nesting), table rows and columns, admonitions (same type), MDX components, code blocks and comments. Never split or merge blocks, and never move a sentence into another block. `locale-sync check` fails a page that doesn't mirror UA, and later incremental runs map blocks by position.
- **S2. No EN restructuring.** Don't remove procedure intro sentences, expand isolated steps, or add standard Prerequisites wording. Those are `doc-translator` rules for EN.
- **S3. Keep every `{/* #anchor */}` heading comment verbatim.** Anchors generated from translated heading text would break `#anchor` links.
- **S4. Formatting mirrors UA.** A span that is bold, italic or in code font in UA has the same formatting in the translation, whatever its class (§4).
- **S5. Write only the blocks you were given.** In an incremental run, replace each changed block's `target.text` exactly, and insert added blocks where `locale-sync blocks` says. Every other byte of the target file stays identical. An `unmapped` change is reported with its UA text and never written into a guessed place.

## 3. What stays byte-identical, what is translated

| Stays byte-identical | Is translated |
|---|---|
| Fenced code blocks, comments inside them included (mermaid: see the last row) | Prose: paragraphs, list items, table cells, admonition bodies and titles, link text |
| Inline code without Cyrillic, including placeholders in italic code font | Inline code that contains Cyrillic. It is UI text in code style, so it goes through the label lookup like a bold span (§4) and keeps its backticks. |
| URLs, link targets, `#anchor` links, image and asset paths | Heading text. The anchor comment stays (S3). |
| MDX and HTML component and attribute names, `import` lines, `{…}` expressions, admonition keywords (`:::note`) | The prose attribute values `title`, `alt`, `label`, `description`, `caption`, `placeholder`, `aria-label` and `summary` |
| Every other attribute value | |
| Frontmatter keys, and the values of every key not listed on the right | The frontmatter values of `title`, `description`, `sidebar_label`, `pagination_label`, `tags` and `keywords`. `title` and `description` must end up different from UA. |
| `last_update`: `locale-sync record` sets it, never the worker | |
| `{/* #anchor */}` and every `{/* … */}` comment that isn't a marker | Marker text. `{/* ToDo: … */}` and `{/* NEEDS CONFIRMATION: … */}` keep their keyword, and the text after the colon is translated. The number of markers doesn't change. |
| Mermaid ids, keywords, arrows and the number of lines | Mermaid node and edge labels, participant aliases and messages |

The UA page is never modified.

## 4. Bold spans and UI labels

The binding pass classifies every bold span (and every Cyrillic inline-code span) once per page and records the decision in the page state's `spans`: `label:<key>`, `unverified`, `term` or `emphasis`. When one span text is a different app string in another part of the page (a tab and a switch that both read «Отримання»), a decision scoped to a heading overrides the page-level one there, and the span's label rows say which applies where. The worker follows the recorded decision and never reclassifies a span.

- **L1. A bound label is the store string, verbatim.** Write the target-locale string from the span's label row in bold. The ticket overlay wins over the base. Don't translate, inflect or recase it, and don't add quotes, even when the app's wording looks odd or uses another register. The reader sees that string on screen. One exception mirrors UA: when the UA span drops trailing decorative punctuation that the UA store string has (store `Статус:`, page `**Статус**`), drop it from the target string too.
- **L2. Grammar goes on a generic noun, never on the label.** When the sentence would inflect the label or attach something to it (a case ending, a suffix, an apostrophe, a contracted article), add the generic noun for the element (button, field, tab, menu, window, column, checkbox…) and inflect that noun. Nothing touches the closing `**`: the next character is a space or sentence punctuation.

  | ⛔ | ✅ |
  |---|---|
  | tr `**Kaydet**'e tıklayın` | tr `**Kaydet** düğmesine tıklayın` |
  | kk `**Сақтау**ды басыңыз` | kk `**Сақтау** түймесін басыңыз` |
  | ru `в **Сумме** укажите…` | ru `в поле **Сумма** укажите…` |

  - Add no generic noun when the target language doesn't need one: es `Haz clic en **Guardar**.`
  - Generic nouns are terms (§5), so each locale uses one word per element type, on every page.
  - **Tajik:** the noun comes first (izofat: `тугмаи **…**`), so the object marker `-ро` would follow the label. Prefer a phrasing that needs no `-ро` after the label. Where none reads naturally, write `-ро` with a hyphen after the closing `**` (`тугмаи **…**-ро`). This is the only attachment these rules allow.
- **L3. `term` and `emphasis` spans are prose.** Translate them like the text around them, and keep the bold (S4). A `term` follows term memory (§5). An `emphasis` span is reported as a hint for the style fixer. The worker doesn't rewrite it. A span that repeats a heading or title of the same page (`**2. Додайте запис**`) takes that heading's translation, word for word.
- **L4. Unverified spans.** Two kinds of span are unverified:
  - a span recorded as `unverified`: UI context but no dictionary match (UA paraphrases the UI, or quotes server or hardcoded text), reason `no-match`
  - a bound key that the store lacks in this locale (the label row says `missing`), reason `missing-in-locale`

  Translate both as prose, keep the bold, and go through term memory (§5) so they read the same on every page. List them in the run's `unverified` file with their reason. If the project declares `UI label fallback: en`, a `missing-in-locale` span is the EN store string verbatim instead, because that is what the screen shows. It is still listed as unverified. A guessed string is never presented as a confirmed label.
- **L5. UI text with markup inside the bold is written part by part.** A link, `&nbsp;`, quotes or an `A > B` menu path inside the bold (`**[Налаштування](/settings/)**`, `**Файл&nbsp;>&nbsp;Експорт**`) is recorded as a `term`. Keep the markup exactly as UA has it, and write each part that the span's label row lists in `parts` as that store string, verbatim. Translate any other part as prose.

## 5. Terms

A term is a domain noun phrase that must read the same on every page: an entity, a status, a role, a generic UI noun (L2), an unverified label (L4). Ordinary vocabulary isn't a term.

- **T1. The UI wins.** A term that equals a UI string in the label store takes that locale's store string. Unlike a label (L1), a term in prose is inflected as the sentence needs, and written in lowercase mid-sentence where the language writes that noun in lowercase (the store's `Makbuz` is `makbuz` in a tr sentence).
- **T2. Term memory comes next.** A term with an entry in `<state root>/terms/<locale>.tsv` takes the recorded translation, inflected as needed. Never translate a recorded term differently. If a recorded translation looks wrong, use it anyway and report it.
- **T3. A new term is recorded once.** The terminology pass translates the new terms of the run per locale, and the run appends them. A worker that meets a term with no entry translates it and returns it as a new entry. Later pages and runs reuse it.
- **T4. Only the terms in the blocks.** Term lookup returns the entries whose UA term occurs in the blocks being translated, matched by stem or prefix to cover UA inflection. The whole file is never loaded.
- **T5. Never reuse the app's word for another concept.** Before you record a translation, check it against the UI strings and term rows you have. When the app writes «транзакція» as tr `işlem`, «дії» is `eylemler`, not `işlemler`, which a reader takes as "transactions".

**Format of `terms/<locale>.tsv`:**

- UTF-8, one entry per line: `<UA term><TAB><translation>`. No header, no comments.
- Both sides are in dictionary form: nominative singular, or plural for a plural-only term.
- Lines are sorted by the UA term in byte order (`LC_ALL=C sort`), one line per UA term.
- `.gitattributes` holds `<state root>/terms/*.tsv merge=union`, so the new lines of two branches both survive a merge. If a UA term then appears on two lines with different translations, report the conflict and use the first line until a writer deletes one.

## 6. Register

This table holds the default register per locale. A host overrides a row with `Locale register:` (see `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`). Adding a locale means adding one row here.

| Locale | Script | Address | Imperative | Not |
|---|---|---|---|---|
| `ru` | Cyrillic | formal *вы*, lowercase | *нажмите*, *выберите* | *нажми*; *Вы* |
| `tr` | Latin | formal *siz* | *tıklayın*, *seçin* | *tıkla*; over-formal *tıklayınız* |
| `az` | Latin | formal *siz* | *klikləyin*, *seçin* | *kliklə*, *seç* |
| `uz` | Latin | formal *siz* | *bosing*, *tanlang* | *bos*, *tanla* |
| `kk` | Cyrillic | formal *сіз* | *басыңыз*, *таңдаңыз* | *бас*, *таңда* |
| `ky` | Cyrillic | formal *сиз* | *басыңыз*, *тандаңыз* | *бас*, *танда* |
| `tg` | Cyrillic | formal *шумо* | *пахш кунед*, *интихоб кунед* | *пахш кун* |
| `es` | Latin | informal *tú* | *haz clic*, *selecciona* | *haga clic* (usted), *hacé clic* (vos) |

- **R1. One register on every page.** Every form that addresses the reader (imperatives, verb endings, pronouns, possessives) uses the row's form. Never mix forms.
- **R2. The app's register doesn't count.** Labels stay verbatim (L1) even when their form differs from the row. Prose follows the table.
- **R3. A locale with no row and no declaration uses its formal "you".** The run reports the missing row.

## 7. Calque traps per language

Each trap is what goes wrong when a UA construction is copied, with the fix. The examples are illustrative, not the only correct output.

### Verb-final locales: `tr`, `az`, `uz`, `kk`, `ky`, `tg`

- **V1. The verb comes last.** Purpose, condition and time clauses go before the main verb. UA «Натисніть **Зберегти**, щоб застосувати зміни» → tr `Değişiklikleri uygulamak için **Kaydet** düğmesine tıklayın.`, not `**Kaydet** düğmesine tıklayın, değişiklikleri uygulamak için.`
- **V2. No agent passive.** UA «створений адміністратором» → make the agent the subject: tr `yöneticinin oluşturduğu kayıt`. Don't build an agent phrase with tr `tarafından`, az `tərəfindən`, uz `tomonidan`, kk `тарапынан`, ky `тарабынан` or tg `аз ҷониби`/`аз тарафи`. A passive without an agent is fine where the language uses it: tr `Liste görüntülenir.`
- **V3. Drop the pronoun.** The verb ending already carries the person: tr `seçebilirsiniz`, not `siz seçebilirsiniz`. In Turkic, "your" is a possessive suffix: tr `hesabınız`, not `sizin hesabınız`.
- **V4. Use the singular after a number.** tr `3 kayıt`, kk `3 жазба`, tg `се сабт`. Don't copy the UA plural (tr `3 kayıtlar`).
- **V5. Use the language's own letters.**
  - kk `ә ғ қ ң ө ұ ү һ і`, ky `ң ө ү`, tg `ғ ӣ қ ӯ ҳ ҷ`: never a Russian look-alike (`к` for `қ`, `х` for `ҳ`).
  - tr and az: capitalize `i` as `İ` and `ı` as `I`.
  - uz: write `oʻ`, `gʻ` and the apostrophe with the same characters the `uz` label store uses, and only those on a page.

### Turkic only: `tr`, `az`, `uz`, `kk`, `ky`

- **K1. Modifiers go before the noun.** A UA «який» clause becomes a participle in front of the noun: tr `onay bekleyen kayıtlar`, kk `растауды күтетін жазбалар`. Never use a tr `ki` clause (`kayıtlar ki onay bekliyor`).
- **K2. The condition goes on the verb.** UA «Якщо…» becomes the conditional suffix: tr and uz `-sa`, az `-sa/-sə`, kk and ky `-са/-се`. Don't open every condition with tr `eğer`, az `əgər`, uz `agar`, kk `егер` or ky `эгер`.
- **K3. Keep possessive chains short.** Don't turn a UA genitive chain («налаштування фільтрів сторінки звітів») into three or more possessive nouns in a row. Reorder the phrase or split it.

### Tajik: `tg`

- **G1. Modifiers follow the noun (izofat).** A UA adjective + noun becomes noun + `-и` + adjective. Don't keep the UA order.
- **G2. `-ро` and labels:** see L2.
- **G3. A definite direct object takes `-ро`.** An object the reader can identify (a named page, a section, the records on screen, anything with «цей», «ці», «потрібні») takes `-ро` before the verb, link text included: `[баҳсҳоро](/disputes/)` before the verb, not `[баҳсҳо](/disputes/)`; `[филтрҳои лозимиро](…) интихоб кунед`. An indefinite object («додайте картку») takes none. A label is the exception: see L2.

### Russian: `ru`

- **U1. False friends.** UA «час» → «время» (ru «час» means "hour"), «лист» → «письмо», «питання» → «вопрос», «наразі» → «сейчас», «тиждень» → «неделя», «неділя» → «воскресенье».
- **U2. Government differs.** «згідно з» → «согласно» + dative (no «с»), «відповідно до» → «в соответствии с», «у разі» → «в случае», «протягом» → «в течение».
- **U3. No officialese.** No «данный» for «цей» (use «этот»). No «является» where a dash or a verb works. No «осуществлять» or «производить» + noun where the verb itself works («проверить», not «осуществить проверку»).

### Spanish: `es`

- **E1. Drop the subject pronoun.** The verb carries the person: `Selecciona el filtro`, not `Tú seleccionas el filtro`.
- **E2. Use the `se` passive.** «Відображається список» → `Se muestra la lista`, not `La lista es mostrada`.
- **E3. Follow Spanish typography.** Headings in sentence case. Days, months and language names in lowercase. Opening `¿` and `¡`.

## 8. Self-review checklist

The worker runs one pass over the blocks it translated, not over the unchanged rest, before `locale-sync check`. The scripts check structure, code, links, markers, label presence and leftover Ukrainian letters. This pass covers what they can't. Fix every failure before handing the page to `check`.

- [ ] Every fact, condition, number, direction of action and modality of each UA block is there, and nothing is added (P2, P6).
- [ ] No sentence copies UA word order or a UA construction the target language doesn't use (P1, and §7 for this locale).
- [ ] No noun chain where a verb works, and no officialese (P3, P4).
- [ ] Task titles and headings use the locale's title form from the P7 table, with the UA noun's number (P7). A UA dash for a missing "is" follows the target's punctuation (P8).
- [ ] Every link whose UA text names a page uses that page's title from its `links` row, inflected only (P9).
- [ ] Blocks still mirror UA one to one, and anchors, markers, code, links and formatting are untouched (S1–S5, §3).
- [ ] Each bound label is the store string, verbatim, in bold (L1). Each listed part of a markup span is its store string, with the markup kept (L5).
- [ ] Nothing touches a label's closing `**` (L2): no letter, digit, apostrophe or hyphen right after it, except tg `-ро`.
- [ ] Every term matches its store string or term-memory entry, and each generic UI noun has one translation (T1, T2, L2).
- [ ] Every unverified span is listed with its reason (L4).
- [ ] Every form that addresses the reader matches the register row (R1).
- [ ] This locale's traps: `tr` `az` `uz` `kk` `ky` → V1–V5, K1–K3 · `tg` → V1–V5, G1–G3 · `ru` → U1–U3 · `es` → E1–E3.
