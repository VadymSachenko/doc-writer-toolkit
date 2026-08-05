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
| Punctuation | one matching file in `punctuation/` | mixed |
| Text styling, dates, numbers, units, math | one matching file in `formatting/` | structural (dates-and-times.md: mixed) |
| Headings, paragraphs, lists, tables, notices | one matching file in `content-structure/` | structural |
| Task instructions or tutorial | `procedures/procedures.md` plus relevant UI/code rules | structural |
| Diagram, screenshot, figure, or alt text | `visuals/images-and-media.md` | structural |
| Link, cross-reference, or anchor | `linking/` | structural |
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

1. Start with this router and one topic file.
2. Add another file only when the task crosses rule families.
3. Search `RULE-INDEX.md` or `manifest.json`; do not load either wholesale.
4. Search one terminology letter index; do not load all terminology files.
5. For a user guide, the normal baseline is voice, accessibility, headings,
   procedures, UI interaction, code formatting, and descriptive links.
