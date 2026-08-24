# Rule router

Load this file first. Then open only the smallest matching set.

| Task or signal | Load | Scope |
|---|---|---|
| Voice, tone, directness, claims | `principles/voice-and-tone.md`, `principles/precision-and-longevity.md` | structural |
| Accessibility or inclusive language | `principles/accessibility.md`, `principles/inclusive-language.md` | structural |
| Translation or global audience | `principles/global-audience.md` | mixed |
| Jargon, requirements, recommendations | `principles/jargon-and-prescriptive-writing.md` | mixed |
| Grammar, person, voice, tense | `language/grammar-person-and-voice.md` | mixed |
| Articles, plurals, possessives | `language/articles-plurals-and-possessives.md` | language-specific (en-US) |
| Abbreviation or capitalization | `language/abbreviations-and-capitalization.md` | mixed |
| Action verbs for UI or procedures | `language/reference-verbs.md` | structural |
| Commas, colons, or list introductions | `punctuation/commas-and-colons.md` | mixed |
| Dashes, hyphens, or number/date ranges | `punctuation/dashes-hyphens-and-ranges.md` | mixed |
| Periods, semicolons, or end punctuation | `punctuation/periods-semicolons-and-end-punctuation.md` | mixed |
| Quotation marks, parentheses, ellipses, or slashes | `punctuation/quotes-parentheses-ellipses-and-slashes.md` | mixed |
| Bold, italic, code font, or text styling | `formatting/text-formatting.md` | structural |
| Numbers, units, or measurements | `formatting/numbers-and-units.md` | structural |
| Dates or times | `formatting/dates-and-times.md` | mixed |
| Mathematical notation or phone numbers | `formatting/mathematical-notation-and-phone.md` | structural |
| Headings or paragraphs | `content-structure/headings-and-paragraphs.md` | structural |
| Lists | `content-structure/lists.md` | structural |
| Tables | `content-structure/tables.md` | structural |
| Notices, notes, cautions, warnings, or footnotes | `content-structure/notices-and-footnotes.md` | structural |
| Task instructions or tutorial | `procedures/procedures.md` plus relevant UI/code rules | structural |
| Diagram, screenshot, figure, or alt text | `visuals/images-and-media.md` | structural |
| Links or cross-references | `linking/links-and-cross-references.md` | structural |
| Anchors or jump targets | `linking/anchors-and-targets.md` | structural |
| API reference | `technical-content/api-reference-comments.md` | structural |
| Inline code or code sample | `technical-content/code-in-text-and-samples.md` | structural |
| Command line or command output | `technical-content/command-line-syntax.md` | structural |
| Placeholder | `technical-content/placeholders.md` | structural |
| UI element or interaction | `technical-content/ui-elements-and-interaction.md` | structural |
| HTML, Markdown, or semantic tagging | `technical-content/html-markdown-and-semantics.md` | structural |
| Product, feature, trademark | `names-and-naming/product-names-and-trademarks.md` | structural |
| Filename or file type | `names-and-naming/filenames-and-file-types.md` | structural |
| Fictional names, domains, IPs, or accounts | `names-and-naming/safe-example-data.md` | structural |
| Exact word or preferred spelling | Search `terminology/index/`, then open its mapped A–Z chunk | language-specific (en-US) |

## Reading the Scope column

This corpus describes **en-US**. The Scope column says which rows still hold when it is
applied to a document in another language, so the router can be read under a
`<guide>@<lang>` profile without opening every file.

- `structural` — holds whatever the language of the prose is.
- `language-specific (en-US)` — holds only for English prose.
- `mixed` — the row's file carries rules of both kinds. Load it and apply the ones that
  fit; each rule file's own frontmatter `scope:` is authoritative. The exact boundary
  between the two kinds is not a judgment call for the reader: it's the file's own
  `language_specific_sections` list, naming the section headings that are
  language-specific. Everything not named there is structural.

The column is a routing hint, not a filter: a scope hint must never be the reason a rule
goes unchecked. When it disagrees with a file's frontmatter, or you are unsure, load the
file. Nothing here is skipped when `<lang>` is `en` — an English profile loads every
matched row, both scopes.

## Token-efficient loading

1. Start with this router and the always-load baseline below.
2. Add one routing-table file per matched signal — only when the task crosses that rule family.
3. Search `RULE-INDEX.md` or `manifest.json`; do not load either wholesale.
4. Search one terminology letter index; do not load all terminology files.
5. **Always-load baseline:** `principles/voice-and-tone.md` and `language/grammar-person-and-voice.md` apply to every review and drafting pass regardless of content signals — load them before consulting the routing table. Everything else is load-on-trigger.
6. For a typical user guide or procedure, the baseline plus these files covers most needs: `content-structure/headings-and-paragraphs.md`, `content-structure/lists.md`, `procedures/procedures.md`, `technical-content/ui-elements-and-interaction.md`, `technical-content/code-in-text-and-samples.md`, `linking/links-and-cross-references.md`.
7. **Within-run cache (batch runs):** When processing multiple pages in the same session (e.g., under the `/document-section` orchestrator), a corpus file already opened earlier in this conversation is still in context — skip re-reading it and use the cached content. Check before every file open whether it was already loaded in this session.
