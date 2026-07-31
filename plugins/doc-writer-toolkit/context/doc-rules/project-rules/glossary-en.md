---
name: Glossary — English
description: Canonical terminology for English-language UCPay documentation, together with the normative render of each term. Update when a new document introduces a new term.
metadata:
  type: reference
---

This glossary is the authoritative source of terms for English-language UCPay documents. Update it
when a new document introduces a new term not yet listed here.

## How to read the table

- **Term** — the canonical form. Headwords are capitalized as dictionary entries; **in prose**,
  common nouns are lowercase ("the payment method determines…"). Only proper names (UniComPay,
  UCP) and verbatim UI labels keep their capitalization in running text.
- **Render** — the normative formatting of the term in text. This column is **binding**: take the
  render from here rather than deciding it in place. The rules behind it are Ж1, Ж3, and Ж4 in
  `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/formatting-conventions.md`.
- **Code entity** — what the same concept is called in code or in the API. A code entity is always
  in `code font` and always English, spelled as in the code (Ж4). An empty cell means there is no
  code counterpart.
- One concept can have both a term and a code entity — these are **different entities**, each with
  its own render (Ж3). Write "the quasi method" for the concept and `QUASI` for the constant, and
  do not mix them within one role.

**Values of the Render column:**

| Value | Meaning |
|---|---|
| `text` | ordinary type, no styling |
| **`bold` (UI)** | visible UI label — bold, wording preserved verbatim (Ж1) |
| `` `code` `` | literal system value or code entity — code font (Ж4) |
| `*italic*` | a new term at its first definition, once (`GDSG-FORMAT-001`) |

## Terms

| Term | Render | Code entity | Definition |
|---|---|---|---|
| Amount | `text` | | The declared value of a transaction at the time of initiation. Don't use: initial amount, original amount. |
| API token | `text` | | A 128-character alphanumeric string used to authenticate requests to the UCPay API. Don't use: partner token, bearer token, auth key. |
| Archive | **bold** (UI) | | The partner cabinet section containing completed transactions. Don't use: completed transactions, closed items, history. |
| `cancelled` | `code` | `cancelled` | Transaction status value. **UK spelling** — not `canceled` — because it is a literal code value. UI label: **Cancelled**. |
| Dispute | `text` | | A transaction challenge raised by an end client. Don't use: complaint, claim, appeal. |
| End client | `text` | | The individual or entity making a payment through a partner's product. Don't use: end user, customer, client (when ambiguous). |
| Endpoint | `text` | | A specific API method address. Don't use: end point. |
| Finished amount | `text` | | The final amount recorded after a transaction completes. Don't use: final amount, confirmed amount, actual amount. |
| `in queue` | `code` | `in queue` | Transaction status value — queued for processing. UI label: **In queue**. |
| `in work` | `code` | `in work` | Transaction status value — being processed. UI label: **In work**. |
| Inbound transaction | `text` | | A transaction that credits funds to the partner or end client account. Don't use: pay-in, incoming payment — **except in operator cabinet docs**, where **Payin** is the standard term (mirrors the product's Payin/Payout pairing and the operator-facing internal context). |
| Monitoring | **bold** (UI) | | The partner cabinet section showing active (incomplete) transactions. Don't use: active transactions, live transactions, open items. |
| Move | `text` | | Reassignment of a transaction to a different work group. Don't use: reassignment, transfer, routing change. |
| `new` | `code` | `new` | Transaction status value — freshly created. UI label: **New**. |
| Outbound transaction | `text` | | A transaction that withdraws funds from an account. Don't use: payout, outgoing payment, withdrawal — **except in operator cabinet docs**, where **Payout** is the standard term (matches the literal UI label and pairs with Payin). |
| Partner | `text` | | A legal entity connected to the UCPay platform to process payments. Don't use: provider, client, merchant, customer. |
| Partner cabinet | `text` | | The UCPay web interface for managing transactions, settings, and reports. Don't use: client cabinet, dashboard, partner portal. |
| Payment method | `text` | query parameter `paymentMethod`; constants `CARD`, `IBAN`, `LINK`, `QUASI`, `PHONE` | The type of payment requisite UCP returns in response to an inbound transaction: card, IBAN, link, quasi, or phone. Don't use: payment option, payment way, method of payment. |
| Payment type | `text` | `paymentType`; values `HUMO`, `UZCARD`, `CLICK`, `PAYME`, `PAYNET` | A secondary filter applied on top of the payment method. Don't use: payment subtype, method subtype. |
| Phone | `text` | constant `PHONE`, value `phone`, marker `PHONE:` in the `Link` field | The payment method where UCP returns a phone number as the payment requisite. In prose write "the phone method" or "a phone requisite"; use the uppercase form only as a code entity. Don't use: PHONE in prose, phone in prose (as the code value), "phone" in quotation marks. |
| Quasi | `text` | constant `QUASI`, value `quasi` | The payment method that hides the real receiving bank behind a UCP widget. In prose write "the quasi method" or "a quasi requisite"; use the Latin uppercase form only as a code entity. Don't use: QUASI in prose, "quasi" in quotation marks, quasi-method with a hyphen. |
| `REST Proxy` | `code` | `REST Proxy` | The intermediary module between the UCP backend and the bank behind the quasi method. The module name stays English, in code font (Ж4, Ж5). Don't use: RestProxy, rest proxy, **REST Proxy** in bold. |
| `success` | `code` | `success` | Transaction status value — completed successfully. UI label: **Success**. |
| Transaction | `text` | | A financial operation initiated through the UCPay payment gateway. Colloquial: request. Don't use: application, operation. |
| UCP | `text` | | Abbreviation for UniComPay. Use after the first full reference: "UniComPay (UCP)". |
| UniComPay | `text` | | The official platform name. Don't use: Unicompay, UCP Pay. |
| Webhook | `text` | | An HTTP request that UCPay sends to the partner's URL when an event occurs. Don't use: callback, notification, push. |
| Webhook token | `text` | | A key for verifying the authenticity of incoming webhook requests. Don't use: callback token, webhook secret. |
| Widget | `text` | | The UCPay payment component embedded on the partner side. Don't use: component, payment widget (unless disambiguating). |
| Widget host | `text` | `WidgetHost`, `WidgetMonoHost` | The host that renders the payment interface for the end client. `WidgetHost` serves the ordinary widget; `WidgetMonoHost` is the separate host used by the quasi method. Write "widget host" in prose and name a specific host by its code entity. Don't use: widget server, widget domain. |
| Work group | `text` | | The team responsible for processing transactions at a given time. Don't use: team, queue owner, routing group. |
