---
id: GDSG-LANGUAGE-GRAMMAR
title: Grammar, person, voice, and tense
languages: [en-US]
scope: mixed
language_specific_sections:
  - "GDSG-GRAM-003 — Use clear pronouns"
  - "GDSG-GRAM-007 — Natural prepositions are acceptable"
content_types: [all]
source_urls:
  - https://developers.google.com/style/voice
  - https://developers.google.com/style/anthropomorphism
  - https://developers.google.com/style/prepositions
  - https://developers.google.com/style/tense
  - https://developers.google.com/style/pronouns
  - https://developers.google.com/style/person
  - https://developers.google.com/style/sentence-structure
captured: 2026-07-16
status: active
keywords: [active voice, person, pronouns, tense, sentence structure]
---

# Grammar, person, voice, and tense

## GDSG-GRAM-001 — Prefer active voice

Name the actor and use active voice when it makes responsibility or causality clearer.
Passive voice is acceptable when the action or object matters more than the actor, the
actor is unknown or irrelevant, or naming the actor would distract.

**Recommended:** The service stores the token for 24 hours.  
**Not recommended:** The token is stored for 24 hours by the service.

## GDSG-GRAM-002 — Address the reader as *you*

- Use **you** for the reader and an imperative verb for an instruction.
- Use third person for another person or group, such as an administrator or end user.
- Use **we** only for the organization or authors when its referent is clear. Do not use
  **we** to mean the reader and writer together.
- Avoid first person singular in documentation.

## GDSG-GRAM-003 — Use clear pronouns

- Put a pronoun close to one unambiguous antecedent.
- Use singular **they**, **them**, and **their** when gender is unknown or irrelevant.
- Repeat a noun when **it**, **this**, **that**, or **they** could refer to multiple things.
- Include an optional **that** or **which** when it prevents a misread.
- Use **that** for a restrictive clause and **which**, preceded by a comma, for a
  nonrestrictive clause.

## GDSG-GRAM-004 — Use present tense

Describe current product behavior and documentation in present tense. Do not use future
**will** for the immediate result of an action.

**Recommended:** The request returns an operation ID.  
**Not recommended:** The request will return an operation ID.

Use future tense only for an actual future event. Do not document an unreleased feature
as though publication guarantees delivery.

## GDSG-GRAM-005 — Put context before action

In an instruction, put a condition, location, or short goal before the imperative when
the reader needs that information to act correctly.

**Recommended:** To retain the logs, enable archival storage.  
**Not recommended:** Enable archival storage if you want to retain the logs.

Keep the context short. If it becomes complex, state it in a separate sentence before
the instruction.

## GDSG-GRAM-006 — Use literal subjects

Do not assign human intentions, feelings, or cognition to software or hardware. Describe
what a component does.

**Recommended:** The client rejects an expired certificate.  
**Not recommended:** The client refuses to trust an expired certificate.

## GDSG-GRAM-007 — Natural prepositions are acceptable

It is acceptable to end a sentence with a preposition. Prefer a natural, readable
sentence over an awkward construction created only to avoid a final preposition.

