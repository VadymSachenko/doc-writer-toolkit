---
title: Unicompay glossary — bilingual alignment reference
description: Bilingual EN↔UA term mapping for UCPay documentation. Language-specific glossaries for skills are in glossary-ua.md and glossary-en.md.
last_update:
  date: 7/30/2026
---

**Language-specific glossaries (used by writer and reviewer skills):**
- UA docs: `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/glossary-ua.md`
- EN docs: `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/glossary-en.md`

This file is the **bilingual alignment reference** — use it to verify EN↔UA term parity and to check "Don't use" synonyms in both languages. When Claude writes or reviews a page:
- Use the EN column term in English docs. Reject synonyms listed in "EN — Don't use".
- Use the UA column term in Ukrainian docs. Reject synonyms listed in "UA — Don't use".
- **The render of a term is not here.** How a term is formatted — plain text, bold UI label, or code font — lives in the **Render** column of `glossary-ua.md` / `glossary-en.md`, governed by Ж1/Ж3/Ж4 in `formatting-conventions.md`. This file aligns *which word*, not *how it is set*.
- Where a colloquial UA term is in common use, the formal term comes first with the colloquial in parentheses.
- Rows with <!-- NEEDS CONFIRMATION --> require SME sign-off before use in published docs.
- Rows with <!-- MY TRANSLATION --> use a UA term not attested in SME transcripts; confirm before use.


## Core entities

| EN | UA (formal, with colloquial if applicable) | EN — Don't use | UA — Don't use |
|---|---|---|---|
| UCP | UCP | the platform, the system (when ambiguous) | Unicompay, UCPay, платформа, система (коли неоднозначно) |
| Partner | Партнер | provider, client, merchant, customer | провайдер, клієнт, мерчант |
| End client | Кінцевий клієнт | end user, customer, client (when ambiguous) | кінцевий користувач, клієнт (коли неоднозначно) |
| Widget | Віджет | payment widget (unless disambiguation needed), component | віджит <!-- phonetic variant, reject --> |

## Transaction concepts

| EN | UA (formal, with colloquial if applicable) | EN — Don't use | UA — Don't use |
|---|---|---|---|
| Transaction | Транзакція (розм.: заявка) | request, application, operation | запит, аплікація, операція |
| Inbound transaction (operator cabinet: **Payin**) | Вхідна транзакція | pay-in, incoming payment — except operator cabinet docs, where Payin is standard | вхідна заявка, поповнення (коли неоднозначно) |
| Outbound transaction (operator cabinet: **Payout**) | Вихідна транзакція (розм.: виплата) | payout, outgoing payment, withdrawal — except operator cabinet docs, where Payout is standard | виплата (як синонім у публічних доках) |
| Dispute | Диспут | complaint, claim, appeal | скарга, апеляція |
| Monitoring | Моніторинг | active transactions, live transactions, open items | активні транзакції, відкриті заявки |
| Archive | Архів | completed transactions, closed items, history | завершені транзакції, історія |
| Amount | Сума | initial amount, original amount | початкова сума, заявлена сума |
| Finished amount | Фактична сума | final amount, confirmed amount, actual amount | кінцева сума, підтверджена сума |
| Commission | Комісія | fee (unless contextually distinct), charge | збір, плата |
| Work group | Робоча група (розм.: група) | team, queue owner, routing group | команда, черга |
| Move | Переміщення | reassignment, transfer, routing change | перепризначення, переведення |
| Endpoint | Ендпоінт | end point | Енд поінт, кінцева точка | 

## Payment methods

<!-- One concept, several entities: the human concept, the internal constant, and the request value are distinct and each keeps its own render (Ж3/Ж4 in formatting-conventions.md). Never mix them in prose. -->

| EN | UA (formal, with colloquial if applicable) | EN — Don't use | UA — Don't use |
|---|---|---|---|
| Payment method (`paymentMethod`) | Платіжний метод | payment option, payment way, method of payment | метод оплати, спосіб оплати, payment method (англійською в прозі) |
| Payment type (`paymentType`) | Тип платежу | payment subtype, method subtype | тип оплати, підтип методу, payment type (англійською в прозі) |
| Quasi (constant `QUASI`, value `quasi`) | Квазі (константа `QUASI`, значення `quasi`) | QUASI in prose, quasi-method | QUASI у прозі, quasi у прозі, «квазі» в лапках, квазі-метод |

## Transaction status model

<!-- Statuses are written in `code font` when referenced as system values. Capitalization in published docs follows sentence case when used as a noun phrase; code font when referenced as the literal system value. -->

| EN | UA (formal, with colloquial if applicable) | EN — Don't use | UA — Don't use |
|---|---|---|---|
| `new` | `new` (UI: Новий) | created, initial, pending (unless system-defined distinct) | створена, початкова |
| `in queue` | `in queue` (UI: В черзі)| queued, waiting | очікує, у черзі (без коду) |
| `in work` | `in work` (UI: В роботі) | processing, in progress, being handled | у процесі, обробляється |
| `success` | `success` (Успіх) <!-- MY TRANSLATION --> | successful, completed (unless in UI label), done | успішна, завершена (коли неоднозначно) |
| `cancelled` | `cancelled` (Скасована) | canceled (US spelling — reject, use UK), rejected, aborted | відхилена, перервана |

## Integration and security

| EN | UA (formal, with colloquial if applicable) | EN — Don't use | UA — Don't use |
|---|---|---|---|
| API token | API токен | partner token, bearer token, auth key | партнерський токен, ключ автентифікації |
| Webhook | Вебхук | callback, notification, push, server-to-server call | колбек, нотифікація, пуш |
| Webhook token | Токен вебхука | callback token, webhook secret, signature key <!-- NEEDS CONFIRMATION if signature is separate --> | колбек-токен, секрет |
| Webhook URL | URL вебхука | callback URL, notification endpoint | URL колбека |
| IP whitelist | IP whitelist (білий список IP) | allowlist, IP filter, IP permissions | дозволений список IP, IP-фільтр |
| Infogroup | Інфогрупа| info channel, error group, tech group | технічний канал |
| `REST Proxy` | `REST Proxy` | RestProxy, rest proxy, REST Proxy in bold | рест-проксі, REST-проксі, **REST Proxy** жирним |

## Interfaces

| EN | UA (formal, with colloquial if applicable) | EN — Don't use | UA — Don't use |
|---|---|---|---|
| Partner cabinet | Кабінет партнера | client cabinet, dashboard, partner portal | кабінет клієнта, дашборд, портал |
| Admin (internal admin) | Адмінка (розм.) / Адміністративна панель (форм.) | admin panel, backoffice, internal tool | бекофіс, внутрішня панель |
| Operator cabinet | Кабінет оператора | operator panel, ops dashboard | панель оператора, операторський дашборд |
| Environment | Середовище | env, stage (unless naming a specific environment) | енв, стейдж (коли неоднозначно) |
| Widget host (`WidgetHost`, `WidgetMonoHost`) | Віджет-хост (`WidgetHost`, `WidgetMonoHost`) | widget server, widget domain | віджетний сервер, хост віджету |
