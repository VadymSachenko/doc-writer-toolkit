# Rule router

Load this file first. Then open only the matching topic files.

| Task or signal | Load | Scope |
|---|---|---|
| Voice, tone, clarity, concision | `shared/voice/microsoft-voice.md` | mixed |
| Writing for accessibility, screen readers, or alt text | `shared/accessibility/writing-for-accessibility.md` | structural |
| Visual or media accessibility, captions | `shared/accessibility/visual-and-media-accessibility.md` | structural |
| Bias-free or inclusive language | `shared/inclusive-content/bias-free-language.md` | structural |
| Headings | `shared/content-design/headings.md` | structural |
| Lists | `shared/content-design/lists.md` | structural |
| Tables or callout boxes | `shared/content-design/tables-and-callouts.md` | structural |
| SEO, responsive, or findable content | `shared/content-design/responsive-and-searchable-content.md` | structural |
| Content planning or editorial review | `shared/content-design/planning-and-review.md` | structural |
| Step-by-step instructions or numbered procedures | `shared/procedures/step-by-step-instructions.md` | structural |
| UI element interactions (clicks, menus, buttons) | `shared/procedures/ui-interactions.md` | mixed |
| Keyboard, touch, or alternative input | `shared/procedures/alternative-input-methods.md` | mixed |
| Network diagrams or architecture flow charts | `shared/procedures/network-traffic-diagrams.md` | structural |
| Formatting UI elements, instructions, or common elements | `shared/formatting/instructions-and-common-elements.md` | structural |
| Typography, layout, or page/section titles | `shared/formatting/type-layout-and-titles.md` | structural |
| URLs or web addresses | `shared/formatting/urls-and-web-addresses.md` | structural |
| Code samples or code formatting | `shared/developer-content/code-examples-and-formatting.md` | structural |
| Developer documentation conventions | `shared/developer-content/developer-content.md` | structural |
| API reference or parameter tables | `shared/developer-content/reference-documentation.md` | structural |
| Chatbots, bots, or conversational UI | `shared/conversational-content/bots-and-virtual-agents.md` | structural |
| Writing for a global audience | `shared/globalization/global-ready-writing.md` | structural |
| Global web or software design | `shared/globalization/global-web-and-software.md` | structural |
| Example data, artwork, or locale-specific data | `shared/globalization/examples-art-and-data.md` | structural |
| English person, nouns, or pronouns | `en-us/grammar/person-nouns-and-pronouns.md` | language-specific (en-US) |
| English sentence structure or prepositions | `en-us/grammar/sentence-structure-and-prepositions.md` | language-specific (en-US) |
| English verbs or voice | `en-us/grammar/verbs-and-voice.md` | language-specific (en-US) |
| English commas or colons | `en-us/punctuation/commas-and-colons.md` | language-specific (en-US) |
| English general punctuation | `en-us/punctuation/core-punctuation.md` | language-specific (en-US) |
| English dashes, hyphens, or minus sign | `en-us/punctuation/dashes-hyphens-minus.md` | language-specific (en-US) |
| English quotes, apostrophes, ellipses, or slashes | `en-us/punctuation/quotes-apostrophes-ellipses-slashes.md` | language-specific (en-US) |
| English acronyms | `en-us/acronyms.md` | language-specific (en-US) |
| English capitalization | `en-us/capitalization.md` | language-specific (en-US) |
| English numbers or percentages | `en-us/numbers.md` | language-specific (en-US) |
| English contractions | `en-us/word-choice/contractions.md` | language-specific (en-US) |
| Plain language or word choice | `en-us/word-choice/plain-and-precise-language.md` | language-specific (en-US) |
| English spelling or exact term | Search `en-us/terminology/INDEX.md`, then load its mapped file | language-specific (en-US) |
| Ukrainian voice or tone | `uk-ua/voice-and-tone/microsoft-voice.md` | language-specific (uk-UA) |
| How English rules apply to Ukrainian content | `localization/en-to-uk-routing.md`, `localization/rule-applicability.md` | language-specific (uk-UA) |
| Ukrainian-English terminology mapping | `localization/terminology-mapping.md` | language-specific (uk-UA) |
| Ukrainian product/feature names or UI labels | `uk-ua/ui-localization/products-features-and-files.md` | language-specific (uk-UA) |
| Ukrainian documentation typography or titles | `uk-ua/documentation/titles-typography-and-ui.md` | language-specific (uk-UA) |
| Ukrainian keyboard shortcuts, keys, or status values | `uk-ua/software-and-web/keys-shortcuts-and-status.md` | language-specific (uk-UA) |
| Ukrainian error messages or notifications | `uk-ua/software-and-web/messages-and-errors.md` | language-specific (uk-UA) |
| Ukrainian inclusive or accessible language | `uk-ua/inclusive-language/inclusive-and-accessible.md` | language-specific (uk-UA) |
| Ukrainian abbreviations or acronyms | `uk-ua/language-standards/abbreviations-and-acronyms.md` | language-specific (uk-UA) |
| Ukrainian capitalization, descriptors, or prepositions | `uk-ua/language-standards/capitalization-descriptors-prepositions.md` | language-specific (uk-UA) |
| Ukrainian grammar style overlay (Microsoft-specific rules) | `uk-ua/language-standards/grammar-style-overlay.md` | language-specific (uk-UA) |
| Ukrainian orthography precedence | `uk-ua/language-standards/orthography-precedence.md` | language-specific (uk-UA) |
| Ukrainian punctuation localization | `uk-ua/language-standards/punctuation-localization.md` | language-specific (uk-UA) |
| Ukrainian number formats or placeholders | `uk-ua/locale-formats/numbers-and-placeholders.md` | language-specific (uk-UA) |
| Ukrainian exact localization choice | Search `uk-ua/terminology/frequent-choices.md`; load `genitive-it-forms.md` only for an IT genitive form | language-specific (uk-UA) |
| Ukrainian Copilot predefined prompt | `uk-ua/conversational-content/copilot-prompts.md` | language-specific (uk-UA) |
| Ukrainian voiceover or video | `uk-ua/voice-video/voice-and-video.md` | language-specific (uk-UA) |
| Ukrainian spelling, grammar, or punctuation | `uk-ua/grammar-authority.md`, then the mapped external grammar file | language-specific (uk-UA) |
| Conflict between language rules | `AUTHORITY-AND-PRECEDENCE.md`, `localization/conflicts.md` | structural |

For programmatic lookup, filter `manifest.json` by `languages`, `content_types`,
`keywords`, or `status`.

## Reading the Scope column

This corpus covers two languages: `shared/` is language-neutral, `en-us/` describes
en-US, `uk-ua/` and `localization/` describe uk-UA. The Scope column says which rows
hold for which language, so the router can be read under a `<guide>@<lang>` profile
without opening every file.

- `structural` — holds whatever the language of the prose is.
- `language-specific (en-US)` / `language-specific (uk-UA)` — holds only for prose in
  that language. This is the same split the `mssg-en` / `mssg-ua` tokens already make by
  directory; the column states it per row.
- `mixed` — the row's files carry rules of both kinds. Load them and apply the ones that
  fit; each rule file's own frontmatter `scope:` is authoritative. The exact boundary
  between the two kinds is not a judgment call for the reader: it's the file's own
  `language_specific_sections` list, naming the section headings that are
  language-specific. Everything not named there is structural.

The column is a routing hint, not a filter: a scope hint must never be the reason a rule
goes unchecked. When it disagrees with a file's frontmatter, or you are unsure, load the
file. Nothing is skipped when `<lang>` matches the token's language — `mssg-en@en` and
`mssg-ua@uk` each load both scopes.

## Token-efficient loading

1. Load this router and the always-load baseline below.
2. Add a second file only when the first file links to it or the task crosses rule families.
3. Search an index before loading terminology chunks.
4. Never load all A–Z files, the full Ukrainian word index, or the complete manifest into model context.
5. **Always-load baseline:**
   - All profiles: `shared/voice/microsoft-voice.md` — Microsoft voice fundamentals apply to every pass.
   - `@uk` profiles additionally: `uk-ua/voice-and-tone/microsoft-voice.md` — Ukrainian voice and tone conventions.
   Everything else is load-on-trigger via the routing table above.
6. **Within-run cache (batch runs):** When processing multiple pages in the same session (e.g., under the `/document-section` orchestrator), a corpus file already opened earlier in this conversation is still in context — skip re-reading it and use the cached content. Check before every file open whether it was already loaded in this session.
