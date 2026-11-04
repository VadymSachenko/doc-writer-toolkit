---
name: Glossary — English
description: Canonical terminology for the product's English pages, together with the normative render of each term. Update it when a page introduces a new term.
---

This glossary is the authoritative source of terms for English pages. How to read the table:
`${CLAUDE_PLUGIN_ROOT}/context/doc-rules/glossary-format.md`. The two rows below are samples: replace
them with your product's terms.

## Terms

| Term | Render | Code entity | Definition |
|---|---|---|---|
| Account | `text` | | The set of user details a person signs in to the app with. Don't use: profile (as a synonym), login. |
| `active` | `code` | `active` | Account status value: the account is active. UI label: **Active**. |

## Names

Names of banks, payment systems and other organizations: the same rows as in `glossary-ua.md`, in the same order. How to fill a row: `glossary-format.md`, "Names". The two rows below are samples: replace them with the names your pages use.

| UA form | EN form | UI forms | API values | Source |
|---|---|---|---|---|
| Лунобанк | Lunobank | LUNOBANK (admin, bank list) | `LUNO` (`bank`) | site: https://lunobank.example/ (UA), https://lunobank.example/en/ (EN); data: the admin bank list; code: `payments-api`@1a2b3c4:`banks.go` |
| Банк Світанок | Svitanok Bank | | | site: https://svitanok.example/ (UA), https://svitanok.example/en/ (EN) |
