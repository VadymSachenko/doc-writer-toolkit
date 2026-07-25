# Rule router

Load this file first. Then open only the smallest matching set.

| Task or signal | Load |
|---|---|
| Voice, tone, directness, claims | `principles/voice-and-tone.md`, `principles/precision-and-longevity.md` |
| Accessibility or inclusive language | `principles/accessibility.md`, `principles/inclusive-language.md` |
| Translation or global audience | `principles/global-audience.md` |
| Jargon, requirements, recommendations | `principles/jargon-and-prescriptive-writing.md` |
| Grammar, person, voice, tense | `language/grammar-person-and-voice.md` |
| Articles, plurals, possessives | `language/articles-plurals-and-possessives.md` |
| Abbreviation or capitalization | `language/abbreviations-and-capitalization.md` |
| Punctuation | one matching file in `punctuation/` |
| Text styling, dates, numbers, units, math | one matching file in `formatting/` |
| Headings, paragraphs, lists, tables, notices | one matching file in `content-structure/` |
| Task instructions or tutorial | `procedures/procedures.md` plus relevant UI/code rules |
| Diagram, screenshot, figure, or alt text | `visuals/images-and-media.md` |
| Link, cross-reference, or anchor | `linking/` |
| API reference | `technical-content/api-reference-comments.md` |
| Inline code or code sample | `technical-content/code-in-text-and-samples.md` |
| Command line or command output | `technical-content/command-line-syntax.md` |
| Placeholder | `technical-content/placeholders.md` |
| UI element or interaction | `technical-content/ui-elements-and-interaction.md` |
| HTML, Markdown, or semantic tagging | `technical-content/html-markdown-and-semantics.md` |
| Product, feature, trademark | `names-and-naming/product-names-and-trademarks.md` |
| Filename or file type | `names-and-naming/filenames-and-file-types.md` |
| Fictional names, domains, IPs, or accounts | `names-and-naming/safe-example-data.md` |
| Exact word or preferred spelling | Search `terminology/index/`, then open its mapped A–Z chunk |

## Token-efficient loading

1. Start with this router and one topic file.
2. Add another file only when the task crosses rule families.
3. Search `RULE-INDEX.md` or `manifest.json`; do not load either wholesale.
4. Search one terminology letter index; do not load all terminology files.
5. For a user guide, the normal baseline is voice, accessibility, headings,
   procedures, UI interaction, code formatting, and descriptive links.
