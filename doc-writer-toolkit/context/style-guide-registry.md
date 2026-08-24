---
name: style-guide-registry
description: Canonical map of style-guide tokens to their corpus/router, the `<guide>@<lang>` profile model that composes a token with a content language, and the shared procedure for resolving which profile applies to a project. Referenced by doc-style-reviewer and every drafting skill — never copy this table or procedure into another skill file.
---

# Style guide registry

Single source of truth for three things every skill in this plugin needs:

1. Which `guide:` tokens exist, and where each one's corpus/router lives.
2. How a token and a content language compose into a **profile** — the ordered stack of rule layers that actually applies to one file.
3. How a skill resolves the profile for the project it's running in, and what to do if the project declares nothing.

If you're editing a skill and find yourself about to write a style-guide name (`gdsg`, `mssg-en`, ...) or a corpus path directly into that skill's prose, stop — reference this file instead. This registry is the only place that mapping should exist. Skills reference it; they don't copy it.

## Guide modes

| `guide:` token | Label | Corpus language | Corpus/corpora | Router |
|---|---|---|---|---|
| `gdsg` | Google Developer Style Guide (English) | `en` | `${CLAUDE_PLUGIN_ROOT}/context/google-developer-style-guide/` | `ROUTING.md` |
| `mssg-en` | Microsoft Writing Style Guide (English) | `en` | `${CLAUDE_PLUGIN_ROOT}/context/microsoft-style-guide/` (`en-us/`, `shared/` only) | `ROUTING.md` |
| `mssg-ua` | Microsoft Ukrainian Localization Style Guide + UA grammar authority | `uk` | `${CLAUDE_PLUGIN_ROOT}/context/microsoft-style-guide/` (`uk-ua/`, `shared/` only) **+** `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/ua-grammar/` | `ROUTING.md` + `INDEX.md` |
| `ua-grammar` | Official Ukrainian orthography (Український правопис 2019) — grammar/punctuation only | `uk` | `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/ua-grammar/` | `INDEX.md` |

**Corpus language** is the language that corpus's own `scope: language-specific` rule files are written about. It decides whether layer 2 of a profile loads (see below). It does **not** decide whether the corpus may be used on text in another language — that's what profiles are for.

These four tokens are stable. Each one still works as a direct `guide:` argument exactly as it always did; profiles are a layer on top of them, not a replacement, and there is deliberately no fifth token for a corpus/language combination (a hand-maintained allowlist of combinations is what the profile model exists to avoid).

## Guide profiles

A **profile** is what a review or a drafting pass actually runs under. It is named `<guide>@<lang>` — `gdsg@uk`, `gdsg@en`, `mssg-en@en`, `mssg-ua@uk`, `ua-grammar@uk` — where `<guide>` is one of the four tokens above and `<lang>` (`uk` or `en`) is the language of the single file being written or reviewed.

### Layer stack

A profile resolves to four layers, loaded in this order. Later layers outrank earlier ones.

1. **Structural rules of the chosen corpus** — every routed rule file carrying `scope: structural` in its frontmatter. Loaded for every profile, whatever `<lang>` is. These are the rules that hold regardless of the language of the prose: document structure, meaning-based formatting (bold, italic, code font), placeholders, brackets, notices, timelessness, links, images, tables, diagrams.
2. **Language-specific rules of the chosen corpus** — routed rule files carrying `scope: language-specific`. Loaded **only when `<lang>` equals the corpus language** in the Guide modes table. These are the rules bound to one language: articles, contractions, US spelling, the English word list, English punctuation inside quotation marks.
3. **The language corpus for `<lang>`** — for `uk`, `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/ua-grammar/` (Український правопис 2019), routed through its `INDEX.md`. For `en` this layer is empty: an English guide's own layer 2 already is the English language layer.
4. **Project rules — rank 0.** Always loaded, for every profile, in both drafting and review. Outranks everything above. See "Project rank-0 layer" below.

### What the `scope:` tag does and does not do

`scope:` exists for exactly one purpose: to let a corpus be applied to text in a language it wasn't written for, without dragging in rules that cannot hold there. It is **not** a way of trimming a corpus down.

**The frontmatter `scope:` key has exactly three valid values** — this is a closed vocabulary, not an open one:

- `structural` — the rule holds whatever the language of the prose is. Applied for every profile, always.
- `language-specific` — the rule is bound to one language. Applied only when `<lang>` matches the corpus language in the Guide modes table above; otherwise not applied at all.
- `mixed` — the file carries rules of both kinds, and pairs with a second frontmatter key, `language_specific_sections`: an array of the file's own section headings, verbatim, that carry the language-specific rules. Sections named there are applied only when `<lang>` matches the corpus language; every other section of the file — the unnamed remainder — is applied always, exactly like `structural`.

Reading rule, one clause per value: `structural` → applies always. `language-specific` → applies only on a language match. `mixed` → the sections listed in `language_specific_sections` apply only on a language match; the rest of the file applies always.

- When `<lang>` matches the corpus language — `gdsg@en`, `mssg-en@en`, `mssg-ua@uk` — **every** scope category loads in full, `mixed` files included, `language_specific_sections` and all. Nothing is cut, nothing is filtered. `gdsg@en` is the whole Google Developer Style Guide, exactly as `guide:gdsg` was before profiles existed.
- When `<lang>` differs — `gdsg@uk` — layer 2 (`language-specific` files) is set aside, the `language_specific_sections` of `mixed` files are set aside along with it, and layer 3 supplies that language's own rules in their place. Every `structural` rule, and every section of a `mixed` file not named in `language_specific_sections`, still applies in full.
- **`scope: mixed` without a `language_specific_sections` key is an incomplete tag.** It states that both kinds of rule are present without saying where the language-specific ones sit — which leaves the subfile boundary to a guess, and guessing here is not permitted. When this is what a loaded file's frontmatter actually says: apply the file's structural material as normal, but withhold a finding on anything ambiguous between the two kinds, and record the incomplete tag (file + row) wherever the skill reports what it consulted, so it gets fixed at the source rather than guessed around on every run.
- When a rule file's scope is unclear, or a routing table's scope hint disagrees with the file's own frontmatter, **load the file**. The frontmatter — including its `language_specific_sections` list, when present — is authoritative, and any rule whose scope doesn't match the profile is simply not applied. A scope hint is a routing shortcut, never the reason a rule goes unchecked or the source of truth for which rules apply.

### Profile expansions

The plugin must behave identically on a Ukrainian-only project, an English-only project, and a mixed one. These are the expansions; every one of them is reachable from the same two declarations plus the file's own language.

**Ukrainian-only project** — `Style guide: gdsg`, `Content language: uk`. Every file resolves to **`gdsg@uk`**:

1. Google Developer Style Guide, `scope: structural` files matched by its `ROUTING.md`.
2. *(skipped — GDSG's language-specific rules are en-US and don't hold for Ukrainian prose)*
3. `context/doc-rules/ua-grammar/`, routed through `INDEX.md`.
4. `project-rules/formatting-conventions.md` + `project-rules/glossary-ua.md`.

This is the combination "structural GDSG, then Ukrainian orthography, then project rules." A Ukrainian file under a `gdsg` declaration must resolve here and run — it is not a language mismatch and must not stop the run.

**English-only project** — `Style guide: gdsg`, `Content language: en`. Every file resolves to **`gdsg@en`**:

1. GDSG `scope: structural` files matched by `ROUTING.md`.
2. GDSG `scope: language-specific` files matched by `ROUTING.md` — **loaded**. On an English project nothing is cut.
3. *(empty — layer 2 is the English layer)*
4. `project-rules/formatting-conventions.md` + `project-rules/glossary-en.md`.

**Mixed project** — `Style guide: gdsg`, `Content language: uk,en`. The declaration authorizes both languages; the language of the file in hand picks the profile, per file, with no prompt: a Ukrainian file resolves to `gdsg@uk` (stack above), an English file to `gdsg@en` (stack above). For a review, the file's language comes from detection; for drafting, from the target location and template.

The same shape holds for the other tokens:

| Profile | Layer 1 (structural) | Layer 2 (language-specific) | Layer 3 (language corpus) | Layer 4 (rank 0) |
|---|---|---|---|---|
| `gdsg@en` | GDSG | GDSG en-US — loaded | — | conventions + `glossary-en.md` |
| `gdsg@uk` | GDSG | skipped | `ua-grammar/` | conventions + `glossary-ua.md` |
| `mssg-en@en` | MSSG `shared/` | MSSG `en-us/` — loaded | — | conventions + `glossary-en.md` |
| `mssg-ua@uk` | MSSG `shared/` | MSSG `uk-ua/` — loaded | `ua-grammar/` (reached through `uk-ua/grammar-authority.md`) | conventions + `glossary-ua.md` |
| `ua-grammar@uk` | — | — | `ua-grammar/` | conventions only (no glossary — see below) |

`mssg-en@uk` and `mssg-ua@en` are constructible but near-empty in practice: each drops its own language layer and gets nothing back for the file's actual language (`mssg-en@uk` keeps `shared/` structural plus `ua-grammar/`; `mssg-ua@en` keeps `shared/` structural and nothing else). If a caller lands on one of these, run it but say plainly in the report header that the better-matched token for this file's language is `mssg-ua` / `mssg-en` respectively.

## Content signals

Both reviewing an existing page and drafting a new one need the same vocabulary of "what's in this content" to feed a router below. Scan for:

- Procedures/imperative steps, numbered or bulleted lists
- Code blocks and inline code
- API-reference structure (parameter tables, request/response objects)
- UI element mentions, placeholders (`*PLACEHOLDER*`, `{param}`, `<PLACEHOLDER>`)
- Tables, links, images and alt text
- Numbers, units, dates, percentages
- Proper names, brand/product names, Latin-script terms embedded in Cyrillic prose
- Admonitions (MDX `:::note`, `:::tip`, `:::warning`, `:::caution`)
- MDX components (`<Tabs>`, `<TabItem>`, etc.)
- Frontmatter `title`/`description` present

## Loading procedure per guide

Each branch below loads layers 1–3 of the resolved profile. Layer 4 is loaded separately and always — see "Project rank-0 layer."

While routing, carry the profile's `<lang>` with you: each corpus's `ROUTING.md` marks the scope of every row, and a row that is language-specific for a language other than `<lang>` is skipped. When a row is marked as spanning both scopes, load it and apply only the rules whose own frontmatter `scope:` fits the profile.

### `gdsg`
1. Read `${CLAUDE_PLUGIN_ROOT}/context/google-developer-style-guide/ROUTING.md`.
2. Map the content signals above to the routing table rows.
3. Load only the matched topic files. Quote ROUTING.md's own instruction: "Never load the full manifest, source map, all terminology indexes, or all rule files into model context."
4. Do not load all A–Z terminology chunks or the full terminology manifest — search `terminology/INDEX.md` only when a specific term arises.
5. **If `<lang>` is `en`** (profile `gdsg@en`): load every matched row, both scopes. Nothing is filtered out.
6. **If `<lang>` is not `en`** (profile `gdsg@uk`): skip the matched rows marked `language-specific (en-US)`, keep every `structural` row in full, and additionally follow layer 3 into `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/ua-grammar/INDEX.md` under the `ua-grammar` branch's rules below (its "Load triggers" table, topical files `01a`–`05g` only, no `00-cheatsheet.md`, no wholesale `99-word-index.md`).

### `mssg-en`
1. Read `${CLAUDE_PLUGIN_ROOT}/context/microsoft-style-guide/ROUTING.md`.
2. Use **only** the `en-us/*` and `shared/*` rows from the routing table — skip `uk-ua/*` rows entirely.
3. Map the content signals to those rows and load only the matched files.
4. Quote ROUTING.md: "Never load all A–Z files, the full Ukrainian word index, or the complete manifest into model context."
5. Do not load all `en-us/terminology/a-z/*.md` chunks — search `en-us/terminology/INDEX.md` only when a specific term arises.
6. If `<lang>` is not `en`, the `en-us/*` rows are the language-specific layer and are skipped — leaving `shared/*` plus layer 3. Prefer `mssg-ua` for Ukrainian text; see the note under "Profile expansions."

### `mssg-ua`
1. Read `${CLAUDE_PLUGIN_ROOT}/context/microsoft-style-guide/ROUTING.md`.
2. Use **only** the `uk-ua/*` and `shared/*` rows — skip `en-us/*` rows.
3. For the "Ukrainian spelling, grammar, or punctuation" signal, follow that row's instruction into `uk-ua/grammar-authority.md`, then onward to `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/ua-grammar/INDEX.md`. That path is this profile's layer 3.
4. For `doc-rules/ua-grammar/INDEX.md`, map the content signals against its own "Load triggers" table and load only the matched topical files (`01a`–`05g`, not `00-cheatsheet.md`).
5. **Do not** load `doc-rules/ua-grammar/00-cheatsheet.md` — see "Project rank-0 layer."
6. **Token budget:** `ua-grammar/INDEX.md`'s minimum always-load set is ~62k tokens alone. Stick to signal-driven loading; do not over-load. Never load `99-word-index.md` wholesale — search it only for a specific word.

### `ua-grammar`
1. Read `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/ua-grammar/INDEX.md`.
2. Map the content signals against its "Load triggers" table.
3. Load only the matched topical files (`01a`–`05g`).
4. **Do not** load `00-cheatsheet.md` — see "Project rank-0 layer."
5. **Never** load `99-word-index.md` wholesale — grep it only when verifying a specific word's spelling.
6. **Token budget:** same as above. Signal-driven baseline only.

### Note on `ua-grammar` as a special case

`ua-grammar` is not "a style guide" in the same sense as the other three — Ukrainian orthography has no competing alternative standard the way GDSG/MSSG-EN do, so it is never itself the project's declared `Style guide:` choice for Ukrainian-language drafting/review; it's the language's own rules, always in force for Ukrainian content. In the profile model this is exactly layer 3: every `@uk` profile reaches Ukrainian orthography, whichever token sits in layer 1. `guide:ua-grammar` remains available as a direct argument for an orthography-only pass, where layers 1–2 are deliberately empty.

Avoid double-applying it: if the resolved profile is `mssg-ua@uk`, don't separately run a second, full `ua-grammar` pass on top — its rules are already reached through `mssg-ua`'s own routing (step 3 above), which is that profile's layer 3. The same caution applies to `gdsg@uk`: layer 3 is loaded once, through the `ua-grammar` branch, not twice.

## Project rank-0 layer

Two files, both under `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/`, always loaded as layer 4 — for every profile, in drafting and in review alike:

| File | What it carries | Loaded for |
|---|---|---|
| `formatting-conventions.md` | the project's own formatting conventions (how placeholders are written, what bold/italic/code font mean in this project's pages, and the like) | every profile, always |
| `glossary-ua.md` / `glossary-en.md` | project-approved terminology, picked to match the profile's `<lang>` | every profile except `ua-grammar@uk` |

Rules for this layer:

- **Rank 0 means it outranks every corpus rule.** When a project rule and a corpus rule conflict, the project rule wins **silently** — no finding, no suggested "fix," no note. E.g. the glossary mandates «ендпоінт», so never suggest «кінцева точка» in its place even though the Microsoft Ukrainian glossary localizes it that way; likewise, a formatting convention that differs from the corpus's default is the correct form for this project, not a deviation from it.
- **Silence runs one way.** A conflict with a corpus rule is silent, but a document that *breaks* a project rule is a normal finding — cite the project file as its source.
- **A missing file is not an error.** If either file doesn't exist in this install, skip it silently and note it as "not present" wherever the skill reports which sources it consulted. Other projects installing this plugin may have neither; `formatting-conventions.md` in particular may not exist yet in a given install.
- **`ua-grammar` takes conventions but not the glossary.** That mode is pure orthographic correctness with no terminology opinions, so the glossary stays out; `formatting-conventions.md` still loads, because its job there is to keep project formatting choices from being reported as errors.
- **`00-cheatsheet.md` is not part of this layer** and is never loaded by a review. Orthography comes from `ua-grammar/`'s topical files and project conventions come from `formatting-conventions.md`; the cheatsheet only duplicates them.

## Resolving which guide a project uses

This is the procedure every skill follows before consulting the tables above — drafting skills and `doc-style-reviewer` alike. It ends with a resolved profile `<guide>@<lang>` and a record of where each half came from.

1. **Read the project's declarations.** The invoking project's `CLAUDE.md` carries a "Documentation toolkit configuration" section holding `Style guide:` and `Content language:` alongside the path fields. How to read that section, and the ask-once/offer-to-persist fallback for a field that isn't there, is the procedure in `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` — follow it there; do not restate it here or in a skill.

2. **Resolve `<guide>`.**
   - An explicit `guide:` argument (only `doc-style-reviewer` accepts one) **overrides** the declaration. Manual override stays available and is never second-guessed.
   - Otherwise use the project's declared `Style guide:` token.
   - Only if there is neither an argument nor a declaration: ask the user once, listing the four tokens and labels from the Guide modes table, and offer to persist the answer per the fallback in `project-paths.md`.

3. **Resolve `<lang>`.** It is always the language of the single file being written or reviewed, checked against the project's `Content language:` declaration (`uk`, `en`, or `uk,en`):
   - Declared as one language, and the file agrees → that language.
   - Declared as `uk,en` → whichever language the file is. Reviews detect it from the file; drafting takes it from the target location and template.
   - Field absent → use the file's language (detected, or the language being drafted), proceed, and tell the user the project has no `Content language:` declaration, offering to persist one.

4. **Check for a real mismatch.** Stop and ask **only** when the file's language is not among the project's declared `Content language:` values — a Ukrainian file in a project declared `en`, say, which usually means the file is in the wrong place. Show the detected language and the declaration. One exception: a file under the project's EN i18n root (resolved per `project-paths.md`) is a translation, so English there is expected under any declaration and never triggers this prompt.

   A file whose language merely differs from the *corpus* language is **not** a mismatch. That's the ordinary `gdsg@uk` case, and it resolves through the layer stack without a prompt.

5. **Compose and announce.** Compose `<guide>@<lang>`, load layers 1–4, and state the resolved profile and its provenance (argument vs. project declaration vs. asked) wherever the skill reports what it did. Never silently default to a guide, and never silently work with no guide at all without telling the user why (e.g. the user declined to pick one).

Do not restate this procedure in the calling skill's own file — the calling skill's "Sources to load" section should be a short pointer into this file, not a paraphrase of it.
