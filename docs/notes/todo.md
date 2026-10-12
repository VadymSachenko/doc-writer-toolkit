

## Task 1: Add one shared native-Ukrainian quality pass

Create or extend one authoritative Ukrainian-language rule source that prevents literal English syntax, ambiguous references, mechanical repetition, and unnatural document self-reference.

The rule must be available to every runtime workflow that creates or rewrites final Ukrainian prose. Ukrainian style review must be able to report violations, and the corresponding fixing workflow must be able to correct them.

Keep doc-alignment-checker structurally focused. It must not become a prose editor. doc-translator currently translates UA to EN and is not an EN-to-UA authoring workflow.

### Core principles

- Treat English as a source of facts and semantic coverage, not as a sentence template.
- Allow Ukrainian sentences to be split, combined, or reordered.
- Prefer verbs and direct constructions over unnecessary nominalizations.
- Preserve facts, actor/action direction, modality, terminology, UI labels, links, and Markdown/MDX.
- Use lowercase ви for direct address, but do not force ви or ваш into every sentence.
- Do not replace calques with bureaucratic or excessively formal Ukrainian.
- Referential clarity takes priority over avoiding repetition.
- Do not prohibit all UI elements as grammatical subjects. Reject copied or anthropomorphic agency such as «Список показує…», but allow natural causality such as «Перемикачі впливають на…».

### Terminology and self-reference

- In published Ukrainian prose, use «вікно» or «модальне вікно», not «діалог» or «діалогове вікно», as the generic name of a modal UI element.
- Do not change technical ARIA roles, selectors, code, English prose, screenshot filename suffixes such as -dialog.png, or exact visible UI labels.
- Avoid generic self-reference such as «цей посібник» or «цей гайд» when referring to one rendered page. Prefer «ця сторінка» or «цей документ».
- Keep «посібник користувача» when it genuinely names a document type.
- Replace «проведе вас через» and similar renderings of “walks you through” with a direct explanation of the page’s purpose.

### Regression cases

Treat the preferred versions as illustrative, not as the only acceptable output.

1. «Діалог деталей відкривається»
   → «Відкривається вікно з докладною інформацією про транзакцію».

2. «ваша закріплена робоча група»
   → «робоча група, за якою вас закріплено»;
   or, when assignment is already established, «ваша робоча група».

3. «Якщо вам закріплено декілька груп»
   → «Якщо вас закріплено за кількома групами».

4. «Головний екран — місце, де ви обробляєте транзакції»
   → «На головному екрані ви обробляєте транзакції».

5. «Коли ви заходите в систему»
   → «Після входу в систему».

6. «Для вхідних транзакцій це перевірка і підтвердження…»
   → «Під час обробки вхідних транзакцій ви перевіряєте й підтверджуєте…».

7. «транзакції, які знаходяться у черзі»
   → «транзакції з черги» or «транзакції, що перебувають у черзі».

8. «ці значення лише для перегляду, ви ними не керуєте»
   → «Ці значення можна лише переглядати. Змінити їх неможливо».

9. «Список показує курси»
   → «У списку відображаються курси».

10. «транзакцію бере в роботу той, хто першим взяв транзакцію з черги у роботу»
    → «Транзакцію обробляє той, хто першим бере її з черги в роботу».

11. Ambiguous reference:

    «…активну робочу групу і статус сесії. Використовуйте її як відправну точку…»
    → «…активну робочу групу і статус сесії. Використовуйте цю сторінку як відправну точку…».

12. «Цей посібник проведе вас через перший вхід у систему»
    → «Ця сторінка пояснює, як уперше ввійти в систему».

### Negative controls

- Do not replace an unambiguous pronoun merely to force repetition.
- Do not reject natural causality such as «Перемикачі впливають на надходження транзакцій».
- Do not change the relationship direction: operators are assigned to groups.
- Do not alter literal UI labels, code, selectors, links, or formatting.

### Acceptance criteria

- One authoritative shared source contains the natural-Ukrainian rules.
- It is loaded for every applicable @uk authoring and style-review profile.
- Relevant authoring workflows perform a distinct native-Ukrainian reread after drafting for meaning.
- Reviewer and fixer behavior is consistent.
- All listed cases and negative controls are represented in rules or a local regression matrix.
- Official Ukrainian grammar and distilled third-party style-guide corpora are not modified to store project-specific preferences.

---

## Task 2: Minimize discretionary dashes in Ukrainian prose

Add a Ukrainian style rule that discourages repeated or ornamental dashes without changing grammatically required punctuation.

This is a project prose preference. Do not modify the official ua-grammar/05d-dash.md corpus to implement it.

### Required behavior

- First consider simplifying or splitting an overloaded sentence.
- Use a comma, parentheses, or a colon only when grammatically appropriate.
- Use a colon when the following clause explains, specifies, or enumerates what precedes it.
- Do not describe a colon as a universal replacement for a dash.
- Preserve required or justified dashes, including nominal predicates, ranges, direct speech, minus signs, and Markdown syntax.
- Do not impose an arbitrary numerical dash limit.
- Exclude frontmatter delimiters, tables, lists, code, identifiers, and numeric ranges from stylistic overuse checks.

### Regression cases

Unnecessary:

«Статус online — це статус сесії — він не залежить від перемикачів».

Preferred:

«Статус online відображає стан сесії. Він не залежить від перемикачів».

Control cases that must remain valid:

- «Транзакція — основний об’єкт роботи оператора».
- «У 2024—2026 роках».
- Markdown list markers and frontmatter delimiters.

### Acceptance criteria

- Ukrainian authoring, review, and fixing workflows apply the same rule.
- Rewriting is preferred to blind punctuation replacement.
- Regression material contains both a dash that should be removed and a dash that must remain.

---

## Task 3: Make concept topics open by orienting the reader

Update the concept-topic workflow and both UA and EN concept templates.

The first reader-visible prose paragraph after frontmatter, imports, and template comments must explain the page’s scope, purpose, or reader benefit before the page moves into a standalone definition or detailed explanation.

### Required behavior

- The opening may use «Ця сторінка пояснює…», «У цьому документі описано…», or a direct topic-first construction.
- Do not force every page to use the same stock phrase.
- A definition may be integrated into the opening if the paragraph also establishes scope and relevance.
- Do not generate a bare definition first and add the actual page introduction as paragraph two.
- Do not add an introduction that merely repeats the title.

### Regression case

Incorrect:

«Транзакція — це основний об’єкт роботи оператора…»

«Ця сторінка пояснює, чим відрізняються вкладки…»

Expected structure:

1. Introduce what the page explains and why it matters.
2. Define «транзакція» or other required terms.

### Acceptance criteria

- The concept writer and UA/EN templates contain the same ordering rule.
- Self-review checks the first rendered paragraph rather than frontmatter or comments.
- A definition-first opening remains allowed only when the definition itself performs the complete introductory function.

---

## Task 4: Audit and complete root-relative internal links

The toolkit already implements much of this behavior. Audit existing runtime rules, centralize the route-building contract where appropriate, and close only uncovered paths.

For page-to-page documentation links, generate a site-root-relative URL path from:

1. the host project’s declared Docusaurus route or UA URL prefix; and
2. the target page path relative to its configured content root.

Remove .md or .mdx.

### Examples

With URL prefix /:

[архіві транзакцій](../../archive/archive.md)
→ [архіві транзакцій](/archive/archive)

With URL prefix /operator/:

[архіві транзакцій](../../archive/archive.md#statuses)
→ [архіві транзакцій](/operator/archive/archive#statuses)

### Required behavior

- Preserve link text and anchors.
- Join prefixes with exactly one slash.
- Never hardcode /docs/.
- Never use ./ or ../ for another documentation page.
- Do not modify external URLs, ./.assets/image.png, same-page #anchors, MDX imports, or filesystem paths shown as code.

Use a synthetic host configuration because no real documentation project is available.

### Acceptance criteria

- Every runtime workflow that creates, repairs, or validates page links follows one shared contract.
- Translation preserves already-correct routes.
- A targeted search finds no active instruction recommending relative .md page links.
- The task does not attempt to verify whether fixture targets exist in a host project.

---

## Task 5: Align filenames, titles, translations, and sidebar labels

Do not say that a filename and title are literally identical. Define their normalized and semantic relationship.

### Required convention

- The canonical English title determines the lowercase kebab-case slug.
- For newly created pages, the parent directory and filename basename use that slug.
- Both locales use the same relative path and filename.
- The English title names the same topic from which the slug was derived.
- The Ukrainian title is a natural, semantically equivalent translation of the canonical English title.
- An explicit slug field does not justify a semantically unrelated filename or title.
- If the full page title is too long for navigation, preserve the accurate title and use a shorter sidebar_label.
- sidebar_label must remain unambiguous and must not change the page’s subject.

### Examples

Pass:

- platform-rules/platform-rules.md
- EN title: Platform rules
- UA title: Правила платформи

Fail:

- platform-rules/platform-rules.md
- EN title: Operator rules
- UA title: Правила роботи оператора

### Existing pages

Do not silently rename an existing file during an unrelated edit. Report the mismatch and recommend whether to change the title or perform an explicit, link-aware rename.

Define handling for intentional exceptions such as generated files or index.md, if the toolkit supports them.

### Workflow coverage

Apply the convention to planning, page creation, translation, relevant alignment checks, and style review. Avoid duplicating the slug algorithm.

### Acceptance criteria

- The workflow defines one slug-normalization algorithm.
- Folder, basename, EN title, UA title, paired locale path, and optional sidebar_label are covered.
- Matching and mismatching synthetic fixtures are included.

---

## Task 6: Group closely coupled procedure actions

First inspect the repository’s routed Google and Microsoft procedure rules and cite the relevant local files in the implementation report.

Treat the rule below as compatible with those guides, not as a universal requirement directly mandated by both.

### Merge actions when all conditions hold

- They occur in the same window, form, panel, or uninterrupted UI context.
- Together they complete one logical user action.
- A commit action such as Save, Apply, or OK immediately follows the input or selection.
- There is no meaningful intermediate result, decision, warning, validation state, or explanation.
- The combined step remains easy to scan.

### Keep actions separate when

- The user moves to another location or phase.
- Validation or review must occur before committing.
- The commit is destructive or needs a warning.
- An optional branch intervenes.
- The first step is already long or contains complex substeps.
- The commit produces a result that needs its own explanation or screenshot.

### Positive fixture

Avoid:

3. In the **Change password** window, enter the old and new password.
4. Click **Save**.

Prefer:

3. In the **Change password** window, enter the old and new password and click **Save**.

Add a negative fixture where Save must remain separate because validation, a warning, or another state intervenes.

### Acceptance criteria

- The user-guide writer and both user-guide templates use the conditional rule.
- Review and fixing behavior detects needless splitting without combining unrelated actions.
- The report distinguishes source-guide guidance from the project-specific decision.

---

## Task 7: Normalize decorative terminal punctuation in UI-label references

This intentionally changes the current project rule that preserves UI labels completely verbatim. Implement it as an explicit rank-0 project override and reconcile contradictory runtime instructions.

Keep two representations:

1. Exact observed UI label:
   - used in app evidence, selectors, automation, and factual observation;
   - preserves all punctuation.

2. Documentation rendering:
   - removes decorative terminal punctuation from inside the bold UI-label span;
   - preserves internal punctuation and symbols;
   - adds punctuation required by the surrounding sentence outside the bold span.

### Examples

- UI Create! → click **Create**.
- UI Receiving: → in the **Receiving** section.
- UI What’s new? → open **What’s new**.
- UI Save & close → preserve **Save & close**.
- List definition → **Receiving**: transactions that…

### Do not change

- Product UI or screenshots.
- Selectors or raw app evidence.
- Code identifiers and literal status values.
- Exact quoted system messages.
- Internal apostrophes, hyphens, slashes, version dots, or symbols that identify the control.

If normalization leaves no useful textual label, follow the existing icon-only-control workflow instead of inventing a name.

### Acceptance criteria

- The precedence over the existing verbatim-label rule is explicit.
- Authoring, review, fixing, and app-observation workflows distinguish exact evidence from normalized prose.
- Fixtures cover terminal punctuation, internal punctuation, and sentence punctuation outside bold.

---

## Task 8: Enforce rectangular, border-only screenshot annotations

The current shared capture rule permits rounded, match-element, inherited border radii, and a translucent region fill. Remove or deprecate those conflicting behaviors.

### Required invariant

- border-radius: 0.
- Transparent background.
- No translucent fill.
- No circles, ellipses, polygons, arrows, or freehand annotations.
- A rectangular or square border based on the target element or region’s bounding box.
- Configured border color and thickness may remain configurable.

Apply this to both interactive-element annotations and region annotations.

### Configuration compatibility

Existing host configuration must not be able to override the invariant. If a legacy shape setting exists:

- either remove it through an explicit migration; or
- accept it for compatibility, warn that it is deprecated, and normalize the result to rectangular.

Do not silently continue rendering rounded frames.

Audit and update:

- shared injection snippets;
- configuration documentation and examples;
- every Playwright consumer;
- references to rounded, match-element, inherited radius, fill, backgroundColor, or a fixed 6px radius.

Do not change unrelated blur, crop, padding, viewport, color, or thickness behavior.

### Acceptance criteria

- Active snippets explicitly use transparent background and zero radius.
- Every capture workflow routes through the shared rule.
- Targeted searches find no active instruction permitting filled or non-rectangular annotations.
- No real screenshot capture is claimed.

---

## Task 9: Design a multilocale screenshot workflow

This task has an approval gate.

Phase A is analysis and design only. Do not edit runtime rules, skills, templates, or screenshot code before the user approves the proposed workflow.

Inspect every current Playwright capture path and propose one shared runtime design.

### The proposal must define

#### 1. Host-project declarations

- Supported screenshot locales.
- Per-locale content and asset roots.
- How the app switches locale.
- Locale-specific routes and authentication, if applicable.

Screenshot locales must be separate from the authored-document-language setting when those concepts differ.

#### 2. Locale parity

Equivalent screenshots means:

- the same scenario;
- the same business data;
- the same route and UI state;
- the same viewport;
- the same annotation target;
- corresponding crop and output path;
- locale-appropriate UI text.

Do not require byte-identical images. Localized text may change wrapping and geometry.

#### 3. Default scope

- Creating, replacing, or editing a screenshot updates all declared screenshot locales.
- An explicitly locale-scoped request updates only that locale.
- When locale scope or mapping cannot be resolved safely, ask one focused question.

#### 4. Consistency scope

- Page-level consistency by default.
- Section-level consistency when connected pages reuse the same entity, account, transaction, amounts, names, or narrative.
- Criteria for requesting approval before extending a scenario across a section.

#### 5. Scenario manifest

Propose a ledger containing at least:

- scenario ID;
- screenshot or shot ID;
- required locales;
- route and UI state;
- selectors;
- seeded values;
- viewport, crop, and annotation settings;
- expected output path per locale;
- capture status and failure reason.

#### 6. Folder creation

- Create only destinations derived from declared locale mappings.
- Never guess locale directories.

#### 7. Partial failure and recovery

- Never silently leave a partially updated locale set.
- Preserve the previous complete set until the replacement set is complete, or propose another recoverable staging strategy.
- Report unsupported locales and states that cannot be reproduced consistently.

#### 8. Integration points

Cover all present and future Playwright consumers, including app exploration, marker resolution, and writer-requested recapture. All consumers must delegate to one shared locale-aware capture contract.

#### 9. Backward compatibility

Define behavior for a host project with no screenshot-locale configuration.

#### 10. Validation

Use a synthetic two-locale host fixture. Do not create product screenshots in this repository and do not claim Playwright end-to-end validation.

### Deliverables for approval

- One recommended design.
- Alternatives considered.
- Proposed configuration block.
- Capture decision table.
- Example scenario manifest.
- Failure and staging policy.
- Phased implementation plan.
- Unresolved decisions.

Stop after presenting Phase A. Implement Phase B only after explicit user approval.

---

## Recommended order

Complete Tasks 1–7 first, then Task 8, and finish with the design-only Task 9.
