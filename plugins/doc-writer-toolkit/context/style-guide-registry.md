---
name: style-guide-registry
description: Canonical map of style-guide tokens to their corpus/router, plus the shared procedure for resolving which guide applies to a project. Referenced by doc-style-reviewer and every drafting skill — never copy this table or procedure into another skill file.
---

# Style guide registry

Single source of truth for two things every skill in this plugin needs:

1. Which `guide:` tokens exist, and where each one's corpus/router lives.
2. How a skill decides **which** guide applies to the project it's running in, and what to do if none is declared.

If you're editing a skill and find yourself about to write a style-guide name (`gdsg`, `mssg-en`, ...) or a corpus path directly into that skill's prose, stop — reference this file instead. This registry is the only place that mapping should exist. Skills reference it; they don't copy it.

## Guide modes

| `guide:` token | Label | Corpus/corpora | Router |
|---|---|---|---|
| `gdsg` | Google Developer Style Guide (English) | `${CLAUDE_PLUGIN_ROOT}/context/google-developer-style-guide/` | `ROUTING.md` |
| `mssg-en` | Microsoft Writing Style Guide (English) | `${CLAUDE_PLUGIN_ROOT}/context/microsoft-style-guide/` (`en-us/`, `shared/` only) | `ROUTING.md` |
| `mssg-ua` | Microsoft Ukrainian Localization Style Guide + UA grammar authority | `${CLAUDE_PLUGIN_ROOT}/context/microsoft-style-guide/` (`uk-ua/`, `shared/` only) **+** `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/ua-grammar/` | `ROUTING.md` + `INDEX.md` |
| `ua-grammar` | Official Ukrainian orthography (Український правопис 2019) — grammar/punctuation only | `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/ua-grammar/` | `INDEX.md` |

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

### `gdsg`
1. Read `${CLAUDE_PLUGIN_ROOT}/context/google-developer-style-guide/ROUTING.md`.
2. Map the content signals above to the routing table rows.
3. Load only the matched topic files. Quote ROUTING.md's own instruction: "Never load the full manifest, source map, all terminology indexes, or all rule files into model context."
4. Do not load all A–Z terminology chunks or the full terminology manifest — search `terminology/INDEX.md` only when a specific term arises.

### `mssg-en`
1. Read `${CLAUDE_PLUGIN_ROOT}/context/microsoft-style-guide/ROUTING.md`.
2. Use **only** the `en-us/*` and `shared/*` rows from the routing table — skip `uk-ua/*` rows entirely.
3. Map the content signals to those rows and load only the matched files.
4. Quote ROUTING.md: "Never load all A–Z files, the full Ukrainian word index, or the complete manifest into model context."
5. Do not load all `en-us/terminology/a-z/*.md` chunks — search `en-us/terminology/INDEX.md` only when a specific term arises.

### `mssg-ua`
1. Read `${CLAUDE_PLUGIN_ROOT}/context/microsoft-style-guide/ROUTING.md`.
2. Use **only** the `uk-ua/*` and `shared/*` rows — skip `en-us/*` rows.
3. For the "Ukrainian spelling, grammar, or punctuation" signal, follow that row's instruction into `uk-ua/grammar-authority.md`, then onward to `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/ua-grammar/INDEX.md`.
4. For `doc-rules/ua-grammar/INDEX.md`, map the content signals against its own "Load triggers" table and load only the matched topical files (`01a`–`05g`, not `00-cheatsheet.md`).
5. **Do not** load `doc-rules/ua-grammar/00-cheatsheet.md` — it contains project-specific terminology overrides and is not universal.
6. **Token budget:** `ua-grammar/INDEX.md`'s minimum always-load set is ~62k tokens alone. Stick to signal-driven loading; do not over-load. Never load `99-word-index.md` wholesale — search it only for a specific word.

### `ua-grammar`
1. Read `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/ua-grammar/INDEX.md`.
2. Map the content signals against its "Load triggers" table.
3. Load only the matched topical files (`01a`–`05g`).
4. **Do not** load `00-cheatsheet.md` — not universal.
5. **Never** load `99-word-index.md` wholesale — grep it only when verifying a specific word's spelling.
6. **Token budget:** same as above. Signal-driven baseline only.

### Note on `ua-grammar` as a special case

`ua-grammar` is not "a style guide" in the same sense as the other three — Ukrainian orthography has no competing alternative standard the way GDSG/MSSG-EN do, so it is never itself the project's declared `Style guide:` choice for Ukrainian-language drafting/review; it's the language's own rules, always in force for Ukrainian content. `mssg-ua` already routes into it as a downstream dependency (step 3 above). Avoid double-applying it: if the resolved guide is `mssg-ua`, don't separately run a second, full `ua-grammar` pass on top — its rules are already reached through `mssg-ua`'s own routing.

## Resolving which guide a project uses

This is the procedure a **drafting** skill follows before consulting the table above. (`doc-style-reviewer` is the exception — its caller passes `guide:` explicitly as an argument, so it skips straight to the loading procedure for that token.)

1. Check the invoking project's `CLAUDE.md` for a "Documentation toolkit configuration" section with a `Style guide:` field.
2. If found, resolve that token against the Guide modes table above and follow its loading procedure before/while drafting — not only in a separate review pass afterward.
3. If the project's `CLAUDE.md` has no such section, or no `Style guide:` field in it: **ask the user once**, listing the four tokens and labels from the table above, and offer to write the answer back into that project's `CLAUDE.md` as a new section:

   ```md
   ## Documentation toolkit configuration

   - **Style guide:** `<chosen token>`
   ```

   so the question isn't repeated on the next invocation in that project.
4. Never silently default to a guide, and never silently draft with no guide at all without telling the user why (e.g. the user declined to pick one).

Do not restate this procedure in the calling skill's own file — the calling skill's "Sources to load" section should be a short pointer into this file, not a paraphrase of it.
