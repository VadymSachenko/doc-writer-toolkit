---
name: code-blocks
description: The single shared rule for what a translation does inside a fenced code block — the text meant for the reader (diagram labels, comments, the descriptions of a folder tree) is translated, the code and the data stay byte for byte. Holds for UA → EN and UA → every further locale. Referenced by doc-translator, doc-alignment-checker and the locale translation rules — never copy it into a skill file.
metadata:
  type: reference
---

# Code blocks in a translation

Single source of truth for **what a translation changes inside a fenced code block**. It holds for every
translation of a UA page: into English (`doc-translator`) and into every further locale (`locale-translator`,
through `${CLAUDE_PLUGIN_ROOT}/context/locale-translation.md` §3). Neither restates it.

A code block has two parts:

- **The reader text:** what a reader of the page reads as language. It is translated like prose, with the
  page's terms.
- **The code part:** everything else. It stays byte for byte: the code, the data, the ids, the keywords, the
  comment markers, the whitespace and the number of lines.

The checks read the two parts with one implementation, `${CLAUDE_PLUGIN_ROOT}/scripts/doc-align/lib/fences.mjs`:
`doc-align` (Check 6 and Check 9) and `locale-sync check` (`code`, `ukrainian-letters`).

## The rules

1. **A diagram (`mermaid`).**
   - Translated: node and edge labels, subgraph titles, participant and actor aliases (`participant A as …`),
     messages (`A->>B: …`), notes, the labels of `alt`, `else`, `loop`, `opt` and the other blocks, a diagram's
     `title`, and `%%` comments.
   - Unchanged: ids, keywords, arrows, `%%{init: …}%%` directives, styling and link lines (`classDef`, `class`,
     `style`, `linkStyle`, `click`), the indentation and the number of lines. A label that is an id at the same time
     (a participant without `as`, a subgraph named by one word) stays as it is.
2. **Other code: its comments.** A comment in the comment syntax of the block's language is translated, and keeps
   its markers and its place on the line. A comment is never added, removed, merged or moved.

   | Language (the info string's first word) | Comments |
   |---|---|
   | `js`, `ts`, `jsx`, `tsx`, `go`, `java`, `kotlin`, `swift`, `c`, `cpp`, `cs`, `rust`, `dart`, `scss`, `jsonc`, `json5` | `// …`, `/* … */` |
   | `bash`, `sh`, `shell`, `zsh`, `python`, `ruby`, `yaml`, `toml`, `dockerfile`, `makefile`, `properties`, `env`, `nginx`, `conf`, `powershell` | `# …` at the start of a word (`${#items}` and a first-line `#!` are code) |
   | `php` | `// …`, `/* … */`, `# …` |
   | `ini` | `# …`, `; …` |
   | `sql` | `-- …`, `/* … */` |
   | `css` | `/* … */` |
   | `html`, `xml`, `svg`, `md` | `<!-- … -->` |

   Text inside a string is never a comment: `"https://…"` and `'a -- b'` are code. `json` has no comments. A
   language not in the table is code from its first line to its last.
3. **Other code: descriptions in plain text.** In a `text`, `txt` or `plaintext` block, or a block with no language,
   the text after ` — ` on a line is a description for the reader (a folder tree: `├── api/   — request handlers`)
   and is translated. Everything up to the dash, the dash and the padding included, stays.
4. **Data stays.** Values in an example (JSON values, request and response bodies, strings, names, a payment
   purpose, a bank name in a value) are what the system sends and returns. They stay exactly as written, Ukrainian
   letters included, in every language.
5. **Prose rules stop at the fence.** Typography rules for a language's prose (EN: no spaces around an em dash,
   capitals after a colon) don't apply inside a code block. A comment is translated in the comment's own style,
   with no period added or removed.
