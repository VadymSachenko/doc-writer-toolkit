# Rule router

Load this file first. Then open only the matching topic files.

| Task or signal | Load | Scope |
|---|---|---|
| Voice, tone, clarity, concision | `shared/voice/` | mixed |
| Bias, accessibility, inclusive language | `shared/accessibility/`, `shared/inclusive-content/` | structural |
| Planning, titles, headings, lists, tables | `shared/content-design/` | structural |
| Steps, prerequisites, UI interactions | `shared/procedures/` | structural (alternative-input-methods.md, ui-interactions.md: mixed) |
| Formatting UI, code, keys, messages, titles | `shared/formatting/` | structural |
| API, reference, code examples | `shared/developer-content/` | structural |
| Chatbots, bots, conversational UI | `shared/conversational-content/` | structural |
| Localization and global readiness | `shared/globalization/` | structural |
| English grammar or punctuation | `en-us/grammar/`, `en-us/punctuation/` | language-specific (en-US) |
| English spelling or exact term | Search `en-us/terminology/INDEX.md`, then load its mapped file | language-specific (en-US) |
| Ukrainian voice or natural translation | `uk-ua/voice-and-tone/`, `localization/` | language-specific (uk-UA) |
| Ukrainian UI or documentation | `uk-ua/ui-localization/`, `uk-ua/documentation/` | language-specific (uk-UA) |
| Ukrainian software strings or messages | `uk-ua/software-and-web/` | language-specific (uk-UA) |
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

1. Load this router and one topic file.
2. Add a second file only when the first file links to it or the task crosses rule
   families.
3. Search an index before loading terminology chunks.
4. Never load all A–Z files, the full Ukrainian word index, or the complete manifest
   into model context.
