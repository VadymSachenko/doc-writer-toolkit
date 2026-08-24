---
id: MWSG-LOC-EN-UK-ROUTER
title: English-to-Ukrainian rule router
languages: [en-US, uk-UA]
scope: structural
content_types: [localization]
captured: 2026-07-16
status: active
keywords: [translation, applicability, routing, Ukrainian]
---

# English-to-Ukrainian rule router

Use English rules to understand the source intent. Use Ukrainian rules to decide the
target form. Never copy an English mechanical convention into Ukrainian without the
applicability check below.

| Source issue | Load for the Ukrainian target |
|---|---|
| Voice, clarity, directness | `../shared/voice/`, then `../uk-ua/voice-and-tone/` |
| Inclusion or accessibility | `../shared/accessibility/`, `../shared/inclusive-content/`, then `../uk-ua/inclusive-language/` |
| Grammar, spelling, punctuation | `../uk-ua/grammar-authority.md`; add the relevant UK overlay only if localization/UI matters |
| Product or feature name | `../uk-ua/ui-localization/products-features-and-files.md` |
| Documentation title or UI reference | `../uk-ua/documentation/titles-typography-and-ui.md` |
| Error, prompt, status, or placeholder | `../uk-ua/software-and-web/`, `../uk-ua/locale-formats/` |
| Copilot predefined prompt | `../uk-ua/conversational-content/copilot-prompts.md` |
| Exact English term | Search `../en-us/terminology/INDEX.md`; then confirm the Ukrainian equivalent in the approved terminology source or local mapping |

Do not use English title case, article rules, serial-comma rules, contraction rules,
English preposition placement, possessive patterns, or number-word rules as Ukrainian
surface-form instructions.
