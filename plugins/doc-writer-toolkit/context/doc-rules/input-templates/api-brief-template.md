---
endpoint: <human-readable name, for example, Create payout transaction>
slug: <kebab-case slug, for example, create-payout-transaction>
---

# API brief: <endpoint name>

<!--
HOW TO USE THIS BRIEF

Fill every section. If a section does not apply, write N/A — do not delete the heading.
Annotated JSON: use // comments inside JSON examples to mark required/optional, type, length, constraints, and notes. Keep one fact per comment. Do not worry about JSON validity — these are not executed; the api-doc-writer skill strips comments before publishing.
Mark uncertain values with TODO inline.
-->

## Purpose

<One paragraph: what this endpoint does, who calls it, and when. Plain language, no marketing.>

## Authentication

<Specific: which token, which header. Confirm whether IP whitelist is required or recommended for this endpoint.>

## Endpoint

```
<METHOD> {API_HOST}/<path>
```

<If the endpoint deprecates or replaces another endpoint, mention it here.>

## Prerequisites

<List anything that must be true before the call works. Examples: partner has positive balance, payout webhook URL is configured, IP is whitelisted, feature flag is enabled. Write N/A if there are none.>

## Request

```jsonc
{
  // Annotate every field. Format per comment:
  //   <required|optional>, <type>, [length or constraint], <description>.
  // Use TODO to flag uncertain facts.
  //
  // Example:
  //   "currency": "UAH",  // required, string (3 chars), must match balance currency
  //   "card": "4441111157473310",  // optional, string (exactly 16 digits), mutually exclusive with `reference` and `iban`
}
```

<If the request supports multiple variants (e.g., card payload vs. iban payload), include one annotated JSON block per variant, with a one-line heading above each.>

## Sub-objects

<For each nested object in the request, repeat the annotated-JSON pattern. Skip this section if there are no sub-objects.>

### `<sub-object name>`

```jsonc
{
  // <field>: <value>,  // required|optional, <type>, <description>
}
```

## Response (success)

```jsonc
{
  // Annotate every field returned. Mark fields that are conditionally returned (e.g., "card returned only when iban is not present").
  // Use TODO for fields whose meaning is unclear.
}
```

<If the response shape varies (e.g., card response vs. iban response), include one annotated JSON block per variant.>

## Errors

<List every error response observed. Use the format below. Include the trigger condition that produced the error.>

### <Trigger condition, for example, ExternalId already exists>

```json
{
  "error": "this [ExternalId] present in transaction list already"
}
```

### <Next trigger condition>

```json
{
  "error": "..."
}
```

## Quirks and edge cases

<Observed but non-error behaviors that surprise the reader. Examples: negative amounts converted to positive; empty externalId auto-replaced with a UUID; whitespace fields silently dropped. Write N/A if none.>

### <Trigger condition, for example, amount is negative>

```jsonc
{
  // <quirk note: e.g., system converts to positive value 1, returns success>
}
```

## Status flow

<What happens after this call. State the initial status this endpoint produces and the next transitions. Link to the canonical status flow page when present.>

## Webhook notification

<Whether this endpoint triggers webhook delivery, on which status changes. Link to the canonical webhook page when present.>

## Related endpoints

<List related endpoints with one-line purpose for each. Examples:
- `GET {API_HOST}/transaction/<uuid>` — check transaction status
- `POST {API_HOST}/transaction/cancel` — cancel a pending transaction
- Webhook delivery — receive status updates>

## Open questions / TODO

<Numbered list. For each item: what is unclear, why it matters, and the action to resolve.

1. **TODO:** <what is unclear>.
   **Why:** <why it blocks documentation>.
   **Action:** <who or what resolves it>.>