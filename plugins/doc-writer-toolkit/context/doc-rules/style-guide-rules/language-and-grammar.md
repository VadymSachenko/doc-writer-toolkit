---
title: Language and grammar
description: Guidelines on language usage, grammar, and phrasing to ensure clarity and consistency.
last_update:
  date: 4/19/2026
---

This document covers language usage, grammar conventions, and phrasing techniques to ensure clarity and consistency in documentation.

For the full version of the guidelines, see the "Language and grammar" section in the [Google developer documentation style guide](https://developers.google.com/style) sidebar.

## Abbreviations

**Rule:** When an abbreviation is likely to be unfamiliar to the audience, spell it out on first mention and include the abbreviation in parentheses immediately after. Italicize both the spelled-out term and the abbreviation. For all subsequent mentions, use the abbreviation alone.

- ✓ **Recommended:** The *internet of things (IoT)* service can even be used for connecting to sensors.
- ⛔️ **Not recommended:** The IoT (internet of things) service can even be used for connecting to sensors.

For details, see [Abbreviations](https://developers.google.com/style/abbreviations).

## Active voice

**Rule:** Use active voice — where the grammatical subject performs the action — instead of passive voice, where the subject is acted upon.

- ✓ **Recommended:** Send a query to the service. The server sends an acknowledgment.
- ⛔️ **Not recommended:** The service is queried, and an acknowledgment is sent.

### Exceptions

**Rule:** Passive voice is acceptable in specific cases.

- To emphasize the object over the action:
  - ✓ **Recommended:** The file is saved.
- To de-emphasize a subject or actor:
  - ✓ **Recommended:** Over 50 conflicts were found in the file.
  - ⛔️ **Not recommended:** You created over 50 conflicts in the file.

For more details about active voice, see [Active voice](https://developers.google.com/style/voice).

## Plurals in parentheses

**Rule:** Don't put optional plurals in parentheses. Use either the plural or the singular form consistently throughout the documentation.

- ✓ **Recommended:** To find your API key, visit the **Credentials** page.
- ⛔️ **Not recommended:** To find your API key(s), visit the **Credentials** page.

For more details, see [Plurals in parentheses](https://developers.google.com/style/plurals-parentheses).

## Present and future tenses

**Rule:** Use the present tense for statements that describe general behavior not associated with a particular time.

**Rule:** Don't document future features or products. Don't pre-announce anything unless it has been confirmed and approved by an authorized person on the team.

**Rule:** Don't use the future tense to describe how a product or feature will work after the next release or update.

**Rule:** Avoid the hypothetical future _would_.

- ✓ **Recommended:** Send a query to the service. The server sends an acknowledgment.
- ✓ **Recommended:** If you send an unsubscribe message, the server removes you from the mailing list.
- ⛔️ **Not recommended:** Send a query to the service. The server will send an acknowledgment.
- ⛔️ **Not recommended:** You can send an unsubscribe message. The server would then remove you from the mailing list.

## Second person and first person

**Rule:** Address the reader using the second person (_you_, _your_) instead of the first person (_we_, _our_, _us_). Assume the reader is the person performing the tasks or making the decisions.

- ✓ **Recommended:** The following sections describe how you can create a website.
- ⛔️ **Not recommended:** The following sections describe how we can create a website.

**Rule:** When telling the reader to do something, use the imperative. The _you_ is implied.

- ✓ **Recommended:** Click **Submit**.

**Rule:** Use the word _user_ only to refer to the user of the software that your reader is developing — not to refer to the reader themselves.

**Rule:** It's OK to use first-person plural pronouns (_we_, _our_, _us_) to refer to the organization that authored the document. Ensure the antecedent is clear.

- ✓ **Recommended:** *`PRODUCT_NAME`* provides an application to create flows, but we don't provide training materials to teach you.

For more details, see [Second person and first person](https://developers.google.com/style/person).

## Sentence structure

**Rule:** When telling the reader to do something, state the circumstance, condition, or goal before the instruction.

- ✓ **Recommended:** To delete the screen, click **Delete**.
- ⛔️ **Not recommended:** Click **Delete** to delete the screen.
- ⛔️ **Not recommended:** Click **Delete** if you want to delete the screen.

**Rule:** For cross-references, either structure works. Put the reason for the reference near the link.

- ✓ **Recommended:** For more information, see [<link to Product plans>].
- ✓ **Recommended:** See [<link to Product plans>] for more information.

For more details, see [Sentence structure](https://developers.google.com/style/sentence-structure).

## Spelling

**Rule:** When in doubt about the spelling of a word, first see the [<link to word list>].

For more details, see [Spelling](https://developers.google.com/style/spelling).