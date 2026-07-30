---
title: Formatting and organization
description: Guidelines for structuring and formatting documentation, including admonitions, headings, numbers, and procedures.
last_update:
  date: 4/19/2026
---

This document explains how to structure and format your documentation, including admonitions, headings, numbers, procedures, and how to refer to words as words.

For the full version of the guidelines, see the "Formatting and organization" section in the [Google developer documentation style guide](https://developers.google.com/style) sidebar.

## Admonitions

**Rule:** To give the reader important or useful information that isn't part of the flow of the text, offset the information with an admonition.

For more details, see [Notes, cautions, warnings, and other notices](https://developers.google.com/style/notices).

### Note and info blocks

**Rule:** Use a note or info block for ordinary asides — information that is useful but not critical.

**Example:** "Generating excessive amounts of traffic to external systems can resemble a denial-of-service attack."

```
:::note

All VPC networks include firewall rules.

:::
```

```
:::info

The process may take up to 2 minutes.

:::
```

### Warning block

**Rule:** Use a warning block for "don't do this" statements or for steps that might be irreversible.

If a reader doesn't heed the warning, they can lose money, lose work, or open themselves to a security breach. For example, "Don't put a password on the command line; doing so is a security risk."

```
:::warning

Do not manually edit or delete generated table entries.

:::
```

### Tip block

**Rule:** Use a tip block for shortcuts or steps that help the reader complete a task faster.

```
:::tip

You can copy all Solid prices at once: in the **Inary** tab, click **Copy**. This copies all prices from Solid to Inary.

:::
```

### Success block

**Rule:** Use a success block only in interactive or dynamic content to confirm a completed action or an error-free status. Don't use success blocks in ordinary static pages.

In Docusaurus, the success block reuses the `tip` admonition with the `[success]` modifier, which swaps the bulb emoji for a checkmark.

```
:::tip[success]

You've successfully created a product plan.

:::
```

## Headings and titles

**Rule:** Write document titles based on the primary purpose of the document. If a document is primarily a tutorial but has a conceptual introduction, write a task-based title.

**Rule:** Write section headings based on the type of content in the section.

**Rule:** For task-based headings, start with a [bare infinitive](https://wikipedia.org/wiki/Infinitive#English) verb (also called a plain or base form verb). In English, the imperative mood uses the same form.

**Rule:** For conceptual or non-task-based headings, use a [noun phrase](https://wikipedia.org/wiki/Noun_phrase) that doesn't start with an _-ing_ verb.

| Heading type | ✓ **Recommended** | ⛔️ **Not recommended** |
|---|---|---|
| Task-based (quickstarts, how-tos, tutorials) | Create product plans | Creating product plans |
| Conceptual (concept docs) | Translation wrapper variable configuration | Configuring Translation wrapper variables |

**Rule:** Don't include numbers in headings to indicate a sequence of sections.

**Rule:** Don't use empty headings or headings with no associated content.

✓ **Recommended:**

```
## Checkout types

There are two types of checkouts: modal window checkout and payment-integrated checkout.

## Modal checkout
```

⛔️ **Not recommended:**

```
## Checkout types

## Modal checkout
```

For more details, see [Headings and titles](https://developers.google.com/style/headings).

## Numbers

### Ordinal numbers

**Rule:** Spell out all ordinal numbers in text.

- ✓ **Recommended:** first, fifth, twelfth, forty-third
- ⛔️ **Not recommended:** 1st, 5th, 12th, 43rd

### Numbers as words

**Rule:** Spell out numbers from zero through nine, and any number that starts a sentence.

- ✓ **Recommended:** two-day offer
- ✓ **Recommended:** four product plans
- ✓ **Recommended:** Fifteen directories are created.

### Numbers as numerals

**Rule:** Use numerals for the following:

- Numbers 10 and greater.
  - ✓ **Recommended:** The link expires in 24 hours.
  - ✓ **Recommended:** 18 years old
- Numbers less than 10 when they appear in the same sentence with numbers 10 or greater.
  - ✓ **Recommended:** The user guide contains 15 steps but only 6 of them are mandatory.
- Negative numbers.
- Most fractions.
- Percentages.
- Dimensions.
- Numbers containing decimal points.
  - ✓ **Recommended:** 1.0 inches (treat decimal numbers as plural even when less than or equal to 1.0)
  - ✓ **Recommended:** 0.3 inches (place a zero before the decimal point for numbers less than one)
- Measurements.
  - ✓ **Recommended:** 8 pixels
- Numbers in a range.

**Exception:** Always use numerals for the following, even if the value is less than 10:

- Version numbers.
  - ✓ **Recommended:** version 3
- Technical quantities, such as amounts of memory, disk space, numbers of queries, or usage limits.
  - ✓ **Recommended:** 6 queries per second; 50 Mbps; 64-bit
- Page, chapter, and section numbers.
- Prices.
- Numbers without units (for example, in mathematical expressions).

For more details, see [Numbers](https://developers.google.com/style/numbers).

## Procedures

**Rule:** A procedure is a sequence of numbered steps for accomplishing a task.

**Rule:** In most cases, introduce a procedure with an introductory sentence that provides context the section heading doesn't cover. Don't simply repeat the heading; if the heading already explains the procedure and no additional context is needed, omit the introductory sentence.

- ✓ **Recommended:** To configure screen settings, follow these steps:
- ✓ **Also recommended:** Configure screen settings:
- ⛔️ **Not recommended:** To configure screen settings:

### Optional steps

**Rule:** For an optional step, begin the step with `Optional` followed by a colon.

- ✓ **Recommended:** Optional: Type an arbitrary string ...
- ⛔️ **Not recommended:** (Optional) Type an arbitrary string ...

For more details about procedures, introductory sentences, single-step procedures, substeps, ordering of components in a step, multi-action procedures, and more, see [Procedures](https://developers.google.com/style/procedures).

For a summary, see [Summary of guidelines for writing procedures](https://developers.google.com/style/procedures#summary-of-guidelines-for-writing-procedures).

## Words as words

**Rule:** When referring to a particular word or phrase as the word or phrase itself, use italics.

- ✓ **Recommended:** Don't use _&_ (ampersand) as a conjunction. Use the word _and_ instead.
- ⛔️ **Not recommended:** Don't use **&** (ampersand) as a conjunction. Use the word **and** instead.

**Rule:** When referring to letters as letters, use italics.

- ✓ **Recommended:** To form a possessive of a singular noun, add _'s_ to the end of the word.
- ⛔️ **Not recommended:** To form a possessive of a singular noun, add "'s" to the end of the word.

For more details, see [Words as words](https://developers.google.com/style/words-as-words).