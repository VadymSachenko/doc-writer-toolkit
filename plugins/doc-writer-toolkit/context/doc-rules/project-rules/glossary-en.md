---
name: Glossary — English
description: Canonical terminology for English-language UCPay documentation. Update when a new document introduces a new term.
metadata:
  type: reference
---

This glossary is the authoritative source of terms for English-language UCPay documents. Update it when a new document introduces a new term not yet listed here.

| Term | Definition |
|---|---|
| **Amount** | The declared value of a transaction at the time of initiation. Don't use: initial amount, original amount. |
| **API token** | A 128-character alphanumeric string used to authenticate requests to the UCPay API. Don't use: partner token, bearer token, auth key. |
| **Archive** | The partner cabinet section containing completed transactions. Don't use: completed transactions, closed items, history. |
| `cancelled` | Transaction status value. **UK spelling** — not `canceled`. UI label: Cancelled. |
| **Dispute** | A transaction challenge raised by an end client. Don't use: complaint, claim, appeal. |
| **End client** | The individual or entity making a payment through a partner's product. Don't use: end user, customer, client (when ambiguous). |
| **Endpoint** | A specific API method address. Don't use: end point. |
| **Finished amount** | The final amount recorded after a transaction completes. Don't use: final amount, confirmed amount, actual amount. |
| `in queue` | Transaction status value — queued for processing. UI label: In queue. |
| `in work` | Transaction status value — being processed. UI label: In work. |
| **Inbound transaction** | A transaction that credits funds to the partner or end client account. Don't use: pay-in, incoming payment — **except in operator cabinet docs**, where **Payin** is the standard term (mirrors the product's Payin/Payout pairing and the operator-facing internal context). |
| **Monitoring** | The partner cabinet section showing active (incomplete) transactions. Don't use: active transactions, live transactions, open items. |
| **Move** | Reassignment of a transaction to a different work group. Don't use: reassignment, transfer, routing change. |
| `new` | Transaction status value — freshly created. UI label: New. |
| **Outbound transaction** | A transaction that withdraws funds from an account. Don't use: payout, outgoing payment, withdrawal — **except in operator cabinet docs**, where **Payout** is the standard term (matches the literal UI label and pairs with Payin). |
| **Partner** | A legal entity connected to the UCPay platform to process payments. Don't use: provider, client, merchant, customer. |
| **Partner cabinet** | The UCPay web interface for managing transactions, settings, and reports. Don't use: client cabinet, dashboard, partner portal. |
| `success` | Transaction status value — completed successfully. UI label: Success. |
| **Transaction** | A financial operation initiated through the UCPay payment gateway. Colloquial: request. Don't use: application, operation. |
| **UCP** | Abbreviation for UniComPay. Use after the first full reference: "UniComPay (UCP)". |
| **UniComPay** | The official platform name. Don't use: Unicompay, UCP Pay. |
| **Webhook** | An HTTP request that UCPay sends to the partner's URL when an event occurs. Don't use: callback, notification, push. |
| **Webhook token** | A key for verifying the authenticity of incoming webhook requests. Don't use: callback token, webhook secret. |
| **Widget** | The UCPay payment component embedded on the partner side. Don't use: component, payment widget (unless disambiguating). |
| **Work group** | The team responsible for processing transactions at a given time. Don't use: team, queue owner, routing group. |
