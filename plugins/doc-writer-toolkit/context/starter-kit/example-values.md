---
name: Example values
description: The values the product's code samples and examples use, in every language. System values are never translated, example values are the same on every page, and existing pairs keep older pages aligned. Add a value here before a page uses it.
---

How to read this file, and what each skill does with it: `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/example-values-format.md`. The rows below are samples: replace them with your product's values.

## System values

Strings the system returns as they are. They are never translated, in code or in prose that quotes them. Names of organizations that the API returns are in the names table of the glossaries.

| Value | Field | Source |
|---|---|---|
| `Платіж відхилено банком` | `errorReason` | code: `payments-api`@1a2b3c4:`errors/messages.go` |
| `Оплата послуг` | `paymentPurpose`, when the request leaves it empty | NEEDS CONFIRMATION |

## Example values

The values examples use, the same on every page: in English, with a person's name as a Ukrainian name in Latin letters. Obviously test values only.

| Kind | Value | Fields |
|---|---|---|
| Person's name | `Olena Marchenko` | `recipient`, `recipientName` |
| Person's name, a second one | `Taras Hnatiuk` | `senderName` |
| Phone number | `+380000000001` | `phoneNumber` |
| Card number | `4111111111111111` | `card` |
| IBAN | `UA000000000000000000000000001` | `recipientIban` |
| Amount | `1500` | `amount` |
| Comment | `The funds did not arrive.` | `comment` |

## Existing pairs

Pages written before this file, whose UA and EN code samples hold different values: the UA value, the EN value kept with it, and the pages it holds for (each page's path relative to its content root, without the extension). Leave the table empty when there are none, and never add a pair for new content.

| UA value | EN value | Type | Pages |
|---|---|---|---|
| `Петренко Олег` | `John Smith` | example | `api/create-payment` |
