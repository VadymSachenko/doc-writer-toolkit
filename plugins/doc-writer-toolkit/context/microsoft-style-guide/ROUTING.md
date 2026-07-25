# Rule router

Load this file first. Then open only the matching topic files.

| Task or signal | Load |
|---|---|
| Voice, tone, clarity, concision | `shared/voice/` |
| Bias, accessibility, inclusive language | `shared/accessibility/`, `shared/inclusive-content/` |
| Planning, titles, headings, lists, tables | `shared/content-design/` |
| Steps, prerequisites, UI interactions | `shared/procedures/` |
| Formatting UI, code, keys, messages, titles | `shared/formatting/` |
| API, reference, code examples | `shared/developer-content/` |
| Chatbots, bots, conversational UI | `shared/conversational-content/` |
| Localization and global readiness | `shared/globalization/` |
| English grammar or punctuation | `en-us/grammar/`, `en-us/punctuation/` |
| English spelling or exact term | Search `en-us/terminology/INDEX.md`, then load its mapped file |
| Ukrainian voice or natural translation | `uk-ua/voice-and-tone/`, `localization/` |
| Ukrainian UI or documentation | `uk-ua/ui-localization/`, `uk-ua/documentation/` |
| Ukrainian software strings or messages | `uk-ua/software-and-web/` |
| Ukrainian exact localization choice | Search `uk-ua/terminology/frequent-choices.md`; load `genitive-it-forms.md` only for an IT genitive form |
| Ukrainian Copilot predefined prompt | `uk-ua/conversational-content/copilot-prompts.md` |
| Ukrainian voiceover or video | `uk-ua/voice-video/voice-and-video.md` |
| Ukrainian spelling, grammar, or punctuation | `uk-ua/grammar-authority.md`, then the mapped external grammar file |
| Conflict between language rules | `AUTHORITY-AND-PRECEDENCE.md`, `localization/conflicts.md` |

For programmatic lookup, filter `manifest.json` by `languages`, `content_types`,
`keywords`, or `status`.

## Token-efficient loading

1. Load this router and one topic file.
2. Add a second file only when the first file links to it or the task crosses rule
   families.
3. Search an index before loading terminology chunks.
4. Never load all A–Z files, the full Ukrainian word index, or the complete manifest
   into model context.
