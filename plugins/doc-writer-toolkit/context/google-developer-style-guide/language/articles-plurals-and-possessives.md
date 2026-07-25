---
id: GDSG-LANGUAGE-NOUNS
title: Articles, plurals, and possessives
languages: [en-US]
content_types: [all]
source_urls:
  - https://developers.google.com/style/articles
  - https://developers.google.com/style/pluralization
  - https://developers.google.com/style/possessives
captured: 2026-07-16
status: active
keywords: [articles, a, an, the, plurals, possessives, agreement]
---

# Articles, plurals, and possessives

## Articles

- Include **a**, **an**, and **the** when normal English grammar calls for them. Omitting
  articles to sound terse can make technical text harder to parse or translate.
- Choose **a** or **an** by the pronounced initial sound, not the written first letter:
  *an SQL query* if SQL is pronounced “ess-cue-ell”; *a URL* if pronounced “you-are-ell.”
- Do not add an article to a product name unless the official name or ordinary sentence
  grammar requires one.

## GDSG-NOUN-001 — Form ordinary plurals

Use standard US English plurals. Do not add an apostrophe to form a plural.

- Add **s** to most abbreviations; add **es** when the abbreviation ends in an s, sh,
  ch, or x sound.
- Keep a spelled-out term and its abbreviation the same grammatical number.
- Use a plural verb after **one or more** and a singular verb after **more than one**.
- Do not put an optional plural in parentheses. Write a definite number or use a phrase
  such as **one or more files**.

## GDSG-NOUN-002 — Treat measurements consistently

- Use a singular unit after exactly 1 and a plural unit after 0, a decimal other than 1,
  or any other number.
- Do not pluralize an abbreviated unit after a number: `5 GB`, not `5 GBs`.
- Put a nonbreaking space between a number and most unit symbols; see
  `../formatting/numbers-and-units.md`.

## GDSG-NOUN-003 — Do not inflect protected or literal names

Do not manually pluralize a trademark, class name, method, constant, or other literal
code entity. Add a common noun and inflect that noun.

**Recommended:** Create two `Intent` objects.  
**Not recommended:** Create two `Intents`.

## Possessives

- For a singular noun or a plural noun not ending in **s**, add **’s**.
- For a plural noun ending in **s**, add an apostrophe after the **s**.
- Rewrite a possessive product, feature, company, or code name when it could imply
  ownership or make the literal name hard to recognize. Use an attributive noun or an
  **of** phrase instead.

**Recommended:** the API response; the value of `MAX_SIZE`  
**Not recommended:** the API’s response; `MAX_SIZE`’s value

