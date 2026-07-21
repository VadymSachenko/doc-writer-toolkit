Below is the structured extraction strictly following your transformation framework .
Language is preserved (UA/RU mix), noise removed, ambiguities captured as TODOs.

# API integration: transactions, balances, webhooks, disputes

## Overview

* Система дозволяє партнерам працювати з балансами, транзакціями (inbound/outbound), курсами та диспутами через API
* Авторизація виконується через API токен, налаштований у UI або адмінці
* Транзакції проходять статусний флоу з webhook-нотифікаціями
* Підтримується routing через робочі групи та операторів (внутрішня логіка)
* Є механізми антиспаму (sender-based логіка)

## Key concepts

* **Баланс (Balance)** — еквівалент валюти; одна валюта = один баланс
* **Платіжна система** — джерело курсів і валют
* **Inbound транзакція (Pay-in)** — отримання коштів
* **Outbound транзакція (Payout)** — виплата коштів
* **External ID** — унікальний ID транзакції на стороні клієнта
* **Sender** — анонімізований ID кінцевого користувача клієнта (для антиспаму)
* **Webhook** — callback про зміну статусу транзакції
* **Draft статус** — початковий стан inbound транзакції до approve
* **Working group** — внутрішня група операторів, що обробляє транзакції
* **Operator** — виконавець транзакції
* **Dispute** — запит на оскарження транзакції
* **Change busy amount** — механізм уникнення конфлікту сум
* **Payment method** — тип методу (card, iban, link, quasi)
* **Payment type** — підтип методу (залежить від платіжної системи)

## Functional behavior

### Баланси

* Баланси повертаються через API
* Дані в API = дані в UI
* Один баланс на одну валюту

### Курси

* Прив’язані до платіжної системи
* Частково автоматичні, частково ручні
* Повертаються через окремий endpoint

### Авторизація

* Використовується API токен
* Передається в header
* Обмеження доступу може бути через whitelist IP
* **Every API endpoint requires this same authentication; no exceptions.**

### Webhooks

* Партнер задає:
  * URL для inbound
  * URL для outbound
* Використовується webhook token
* Викликаються при зміні статусу

Особливості:
* Success → відправляється одразу
* Cancel → відправляється з delay ~72 години

## User flow

### Створення inbound транзакції

1. Партнер створює транзакцію (Pay-in API)
2. Транзакція отримує статус `DRAFT`
3. Партнер викликає approve endpoint
4. Статус змінюється на `new`
5. Система:
   * або ставить в чергу (queue)
   * або одразу розподіляє оператору
6. Оператор:
   * бере в роботу (`in progress`)
   * завершує (`done`) або відміняє (`cancelled`)

### Створення outbound транзакції

1. Партнер створює payout транзакцію
2. Статус одразу `new` (без draft)
3. Далі flow аналогічний inbound:
   * queue → work → done/cancel

### Dispute flow

Inbound:
1. Транзакція cancelled
2. Клієнт створює dispute
3. Додає файли (receipts)

Outbound:
1. Транзакція done
2. Клієнт не отримав кошти
3. Створює dispute

## API / Integration insights

### Webhook

* Вихідний запит використовує webhook token клієнта
* Callback при кожній зміні статусу

### Transactions

* Pay-in:
  * статус DRAFT → approved -> статус NEW.
* Payout:
  * одразу NEW

### Cancel

* Партнер може відмінити транзакцію
* Після cancel → переміщується в архів

### Get transaction

* Можна отримати будь-яку транзакцію (не тільки active)

### Polling

* Дозволено, але не рекомендовано (перевага webhook)

## Business rules / logic

* Одна валюта → один баланс
* Одна сума + одна карта → тільки одна активна транзакція
* Change busy amount:
  * якщо сума зайнята → +1 до суми
* Draft timeout:
  * ~5–6 хвилин → якщо не approve → error
* Inbound:
  * не можна змінювати routing після видачі карти
* Outbound:
  * більш гнучкий статус-флоу
* Cancelled транзакції:
  * переходять в архів

## Edge cases / limitations

* Відсутність whitelist IP → 404 помилки
* 404 не деталізується:
  * може означати:
    * transaction not found
    * user not found
    * access denied
* Balance може бути negative (поки не введено обмеження)
* Payout може створюватись без достатнього балансу
* UI і API мають різні обмеження (наприклад dispute без файлів)

## Ambiguities / TODO

* **TODO:** Уточнити повний список статусів транзакцій
  **Why:** Частково описані, але немає повного enum
  **Action:** Запросити backend або подивитись код

* **TODO:** Уточнити точний timeout для draft (5 чи 6 хвилин)
  **Why:** SME не впевнений
  **Action:** Перевірити в конфігурації або коді

* **TODO:** Уточнити логіку routing (групи, оператори)
  **Why:** Описано частково і як внутрішня логіка
  **Action:** Інтерв’ю з backend / ops

* **TODO:** Уточнити payment type vs payment method повну модель
  **Why:** Є тільки приклад для UZS
  **Action:** Запросити повний mapping

* **TODO:** Уточнити логіку rates (персональні курси)
  **Why:** Неясно чи застосовуються в API відповіді
  **Action:** Перевірити через тест API

* **TODO:** Уточнити sender anti-spam логіки (3 варіанти)
  **Why:** SME описав не повністю і плутається
  **Action:** Попросити точну документацію або код

* **TODO:** Уточнити meaning поля `exchange status`
  **Why:** SME не впевнений
  **Action:** Backend clarification

* **TODO:** Уточнити webhook retry / failure handling
  **Why:** Не описано
  **Action:** Backend / infra

## Atomic facts

* One currency corresponds to one balance.
* Balance data returned by API matches UI data.
* Pay-in transactions start with status `draft`.
* Pay-in transactions require explicit approval.
* Payout transactions are created with status `new`.
* Transactions can be cancelled by the partner.
* Cancelled transactions are moved to archive.
* Webhooks are triggered on each status change.
* Successful transactions trigger immediate webhook.
* Cancelled transactions trigger delayed webhook (~72h).
* External ID must be unique per transaction.
* Sender identifies the end user of the partner system.
* Sender is used for anti-spam logic.
* Only one active transaction per card and amount is allowed.
* Change busy amount increases amount to avoid conflicts.
* Dispute can be created only after specific statuses.
* Dispute can contain multiple files.
* Transaction status can be polled via API.
* Webhook usage is recommended over polling.
* IP whitelist is required for API access.
* 404 response may hide multiple error types.

## Cleaned knowledge (de-normalized narrative)

Система API дозволяє партнерам працювати з балансами, транзакціями та диспутами. Баланс прив’язаний до валюти, і кожна валюта має один баланс. Дані балансів, які відображаються в UI, ідентичні тим, що повертаються через API.

Транзакції поділяються на inbound (отримання коштів) та outbound (виплати). Inbound транзакції створюються у статусі draft і потребують додаткового підтвердження через approve endpoint. Якщо підтвердження не відбувається протягом кількох хвилин, транзакція переходить у помилку. Після підтвердження транзакція переходить у статус new і далі розподіляється системою або оператором.

Outbound транзакції створюються одразу у статусі new без етапу draft. Подальший flow аналогічний inbound.

Система використовує webhook-и для повідомлення про зміну статусів. Для цього партнер має налаштувати URL-и і webhook token. Усі зміни статусів супроводжуються callback-ами, при цьому фінальний статус success надсилається одразу, а cancelled — із затримкою.

Для уникнення конфліктів використовується механізм change busy amount, який змінює суму транзакції, якщо така вже існує в системі. Також існує логіка антиспаму через sender ID, яка обмежує кількість активних транзакцій на одного користувача.

Dispute дозволяє оскаржити транзакцію і може містити файли (наприклад, квитанції). Його створення залежить від статусу транзакції.

## Keywords / Tags

API, transactions, payin, payout, webhook, balance, exchange rate, sender, external id, dispute, payment method, routing, operator, status flow, anti-spam
