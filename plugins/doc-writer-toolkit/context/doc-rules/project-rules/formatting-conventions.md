---
name: Проєктні конвенції форматування
description: Rank-0 project formatting conventions — what bold, code font and italic mean in this project's pages, how placeholders are written, how one entity is rendered consistently, and how a code entity differs from a human concept. Core section is language-neutral; UA and EN sections carry the per-language conventions. Loaded for every guide profile, in drafting and in review.
metadata:
  type: reference
---

# Проєктні конвенції форматування

Цей файл — **rank-0 шар** проєктних правил. Він вантажиться для **кожного** профілю гайда
(`gdsg@uk`, `gdsg@en`, `mssg-en@en`, `mssg-ua@uk`, `ua-grammar@uk`), і під час написання, і
під час перевірки. Процедуру завантаження визначає
`${CLAUDE_PLUGIN_ROOT}/context/style-guide-registry.md`, розділ «Project rank-0 layer» — вона тут
не дублюється.

**Як цей файл співвідноситься з корпусами:**

- Правило звідси **переважає** будь-яке правило корпусу. Конфлікт із корпусом розв'язується
  **мовчки**: проєктна форма — правильна, це не відхилення й не привід для findings.
- Порушення правила **звідси** — звичайна знахідка перевірки з посиланням на цей файл.
- Там, де правило корпусу вже все сказало, тут стоїть **посилання** на нього, а не переписаний
  текст. Копіювати правила корпусу сюди заборонено — корпус лишається єдиним джерелом.
- Там, де правила в корпусі **немає**, стоїть позначка **проєктне рішення**.

**Чого тут немає:**

| Що | Де живе |
|---|---|
| Правопис української мови | `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/ua-grammar/` (маршрутизація — через `INDEX.md`) |
| Затверджені терміни та їхній рендер | `glossary-ua.md` / `glossary-en.md` у цій же теці |
| Структура сторінки, шаблони | `${CLAUDE_PLUGIN_ROOT}/context/doc-templates/` |
| Продуктові факти про API | `api-integration-context.md` у цій же теці |

---

## Ядро (будь-яка мова)

Правила цього розділу не залежать від мови документа. Вони застосовуються однаково на
українському, англійському і змішаному проєкті.

### Таблиця рендерів

Це проєктне прочитання `GDSG-FORMAT-TEXT` («Choose formatting by meaning»). Читай його там;
нижче — тільки те, що проєкт **дофіксовує** понад корпус.

| Що це | Рендер | Приклад (UA) | Приклад (EN) |
|---|---|---|---|
| Видима мітка елемента інтерфейсу | **жирний** | натисніть **Зберегти** | click **Save** |
| Літеральне значення, показане в UI | **жирний** + `code font` | вкладка **`QUASI`** | the **`QUASI`** tab |
| Код-сутність: константа, поле БД, query-параметр, назва структури, модуля, репозиторію, шлях, файл | `code font` | параметр `paymentMethod` | the `paymentMethod` parameter |
| Плейсхолдер | `*UPPER_SNAKE*` курсивом | `*COLLECTION_ID*` | `*COLLECTION_ID*` |
| Новий термін у місці його визначення | *курсив*, один раз | *квазіреквізит* | *quasi requisite* |
| Людське поняття, назва продукту, назва фічі | звичайний текст | платіжний метод, UniComPay | payment method, UniComPay |
| Емфаза «це важливо» | **немає рендеру** — переписати речення | — | — |

### Ж1 — Жирний = видима мітка UI (Bold = visible UI label)

Жирний позначає **тільки** видиму мітку елемента інтерфейсу: кнопку, поле, пункт меню,
вкладку, підпис поля в адмінці. Написання зберігається дослівно таким, як його показує
інтерфейс.

- **Жирний як емфаза — заборонено.** Ані для «важливого» речення, ані для терміна, ані для
  назви модуля чи фічі. Якщо факт важливий — винеси його в окреме речення або в `:::note`,
  а не виділяй.
- Літеральне значення, показане в UI, — **жирний і `code font` разом**.
- Не жирни назву продукту, фічі, модуля чи репозиторію, якщо це не мітка UI.

**Джерела корпусу:** `GDSG-FORMAT-TEXT` (`formatting/text-formatting.md`) — «Do not combine
styles for general emphasis», «A literal value shown in the UI uses both bold and code
formatting»; `GDSG-UI-001` (`technical-content/ui-elements-and-interaction.md`) — «Do not bold a
product or feature name unless it is the visible name of the UI element», «preserve its displayed
wording».

**Проєктне рішення понад корпус:** корпус каже «formatting sparingly», проєкт каже
**ніколи** — заборона жирного як емфази беззастережна, винятків немає.

| ⛔ Не так | ✅ Так |
|---|---|
| **Транзакція закривається повністю автоматично**, без участі оператора. | Транзакція закривається повністю автоматично, без участі оператора. |
| у відповідь повертається **лінк на віджет** | у відповідь повертається лінк на віджет |
| Модуль **REST Proxy** є посередником… | Модуль `REST Proxy` є посередником… (назва модуля — Ж4) |
| The transaction **is closed fully automatically**. | The transaction is closed fully automatically. |
| поле **A-Bank Collection ID** | поле **A-Bank Collection ID** — мітка UI, жирний правильний |

### Ж2 — Плейсхолдери (Placeholders)

Плейсхолдер записується як **`*PLACEHOLDER_NAME*`**: великими літерами, з підкресленнями як
роздільниками, курсивом.

**Заборонено:** рядок зірочок (`**********`), рядок `x` (`xxxxx`), одиничний `x`, «щось»,
«…», `<тут ваш ID>`, присвійні префікси `MY_` / `YOUR_`, дефіси й пробіли в імені.

**Стосується і плейсхолдерів усередині URL-прикладів.** Це окремо названо, бо саме там їх
пропускають: URL виглядає як цитата з UI, і замаскована частина проїжджає непоміченою.

| ⛔ Не так | ✅ Так |
|---|---|
| `https://pay.a-bank.com.ua/collection/**********` | `https://pay.a-bank.com.ua/collection/*COLLECTION_ID*` |
| `POST /transaction/xxxxx` | `POST /transaction/*TRANSACTION_ID*` |

Кожен плейсхолдер пояснюється при першому вживанні, навіть якщо значення здається очевидним
(`GDSG-PLACEHOLDER-001`, розділ «Explain placeholders»). У fenced-блоці форматування не здатне
відрізнити плейсхолдер від коду — там працює тільки ім'я та пояснення поруч.

**Джерела корпусу:** `GDSG-PLACEHOLDER-001` (`technical-content/placeholders.md`) — «Use a
descriptive uppercase name with underscore delimiters», «Do not use a single `x`, a row of x
characters…», «Do not include possessive adjectives».

**Проєктне рішення понад корпус:** корпус для Markdown пропонує курсивний код — *`PROJECT_ID`*.
Проєкт обрав **курсив без зворотних лапок** — `*PROJECT_ID*` — і тримається його всюди. Корпус
це прямо дозволяє («If uppercase underscore form conflicts with the host language or interface,
use a clear project convention consistently»). Перевірка **не** повідомляє про це як про
відхилення.

### Ж3 — Одна сутність, один рендер (One entity, one render)

Для кожної сутності обирається **рівно один** спосіб написання, і він тримається по всьому
документу — і далі, по всьому набору документів.

Змішування рендерів — помилка **навіть тоді, коли кожен окремий рендер сам по собі
правильний**. Читач сприймає зміну рендеру як зміну сутності.

**Антипатерн із реального кейсу** — одна сторінка, одне поняття, чотири рендери:

```
`QUASI`   «квазі»   quasi   квазі
```

**Як розв'язувати.** Спочатку визнач роль за Ж4 — і рендер зафіксовано. Якщо під однією
англійською фразою реально ховаються **різні** сутності (константа в коді, значення в запиті,
поняття для читача) — це не одна сутність із чотирма рендерами, а три сутності, кожна зі своїм
рендером. Тоді вони мусять і **називатися по-різному** в прозі:

- поняття → метод квазі *(звичайний текст)*
- внутрішня константа → `QUASI` *(code font)*
- значення `paymentMethod` у запиті → `quasi` *(code font)*

Що не можна: писати «метод `QUASI`» в одному абзаці і «метод quasi» в наступному, маючи на
увазі те саме.

**Реєстр обраних рендерів — глосарій.** Колонка **Рендер** у `glossary-ua.md` / `glossary-en.md`
є нормативною: рендер сутності береться звідти, а не вигадується на місці. Сутності, якої там
немає, місце в глосарії, а не в прозі з імпровізованим рендером (див. Ж4, останній пункт).

**Проєктне рішення** — прямої норми в корпусі немає; `GDSG-FORMAT-TEXT` вимагає лише «use
formatting consistently and sparingly».

### Ж4 — Код-сутність проти поняття (Code entity vs. human concept)

Це правило вирішує, **якою мовою** і **яким рендером** записати англомовний термін.

| Роль сутності | Мова | Рендер | Приклади |
|---|---|---|---|
| **Існує в коді**: константа, поле БД, query-параметр, назва структури, назва модуля, назва репозиторію, ендпоінт | англійською, **як у коді** | `code font` | `paymentMethod`, `QUASI`, `CardCoded`, `MonoCFG UUID`, `WidgetMonoHost`, `REST Proxy` |
| **Людське поняття** | мовою документа, термін із глосарію | звичайний текст | `payment method` → платіжний метод; `payment type` → тип платежу |
| **Видима мітка UI** | дослівно, як показує інтерфейс | **жирний** (Ж1) | **A-Bank Collection ID**, **Додати картку** |

**Четверта ситуація — сигнал про діру в глосарії.** Англійський термін стоїть у прозі, для
нього **немає** затвердженого перекладу і його **немає** в коді. Це не привід вигадати рендер на
місці. Дії, у цьому порядку:

1. Додати запис у `glossary-ua.md` / `glossary-en.md` разом із колонкою **Рендер**.
2. Синхронізувати двомовний `glossary.md`.
3. Поки термін не затверджено — поставити поруч
   `{/* NEEDS CONFIRMATION: термін «…» не має затвердженого перекладу */}` і вжити робочий
   варіант **однаково по всьому документу** (Ж3).

Що не можна: лишити англійське слово в українській прозі «як є» тільки тому, що так казав SME.
Мова інтерв'ю — не рендер документа.

**Джерела корпусу:** `GDSG-CODE-001` (`technical-content/code-in-text-and-samples.md`) — перелік
код-сутностей, які йдуть у `code font`, і «Do not use code font for an ordinary product, service,
organization, domain name»; `GDSG-UI-001` — про мітки.

**Проєктне рішення:** саме тришарове розділення ролей (код / поняття / мітка) і вимога брати
поняття з глосарію — проєктні; корпус описує рендери, але не процедуру вибору ролі для
іншомовного терміна.

### Ж5 — Назва репозиторію (Repository name)

Назва репозиторію — у `code font`, як і шляхи всередині нього.

| ⛔ Не так | ✅ Так |
|---|---|
| `controllers/adm/paycard` у репозиторії UCPay-adm-BE | `controllers/adm/paycard` у репозиторії `UCPay-adm-BE` |
| **UCPay-adm-BE** | `UCPay-adm-BE` |

**Проєктне рішення.** У корпусі прямої норми **немає**: `GDSG-CODE-001` перелічує «filenames and
paths, package names», але репозиторій не згадує, а протилежний пункт того ж правила («Do not use
code font for an ordinary product, service, organization») можна прочитати і як заборону. Проєкт
знімає цю неоднозначність на користь `code font` — назва репозиторію є літеральним технічним
ідентифікатором і в реченні майже завжди стоїть поруч зі шляхом усередині нього.

### Ж6 — Документуємо as-is (Document as-is)

У тілі сторінки — **тільки поточна поведінка**.

Плани, майбутні зміни, наміри команди («планує вивести з використання», «буде замінено»,
«скоро додамо»), не оголошені публічно фічі — **тільки** у вигляді закоментованого маркера:

```
{/* ToDo: <що планується> — оновити, коли зміна з'явиться в коді */}
```

Ніколи — у тілі сторінки. Ніколи — у `:::note`, `:::tip` чи `:::warning`: admonition є частиною
сторінки, а не коментарем.

⛔ Не так — у тілі сторінки:

```
:::note
Команда розробки планує вивести спосіб підтвердження через `approve` з використання,
але на цей момент цей метод активний.
:::
```

✅ Так — факт у тексті, план у коментарі:

```
Метод `approve` активний і не позначений у коді як застарілий.

{/* ToDo: команда планує вивести `approve` з використання — оновити, коли в коді
з'явиться позначка deprecated */}
```

**Джерела корпусу:** `GDSG-PRINCIPLES-PRECISION` (`principles/precision-and-longevity.md`) —
«Document available behavior, not unannounced or planned functionality», «Do not pre-announce a
feature in product documentation without the required legal and release approval», «Prefer present
tense for current behavior», а також розділ «Timeless documentation» щодо «на цей момент»,
«наразі», «currently», «recently», «soon».

**Проєктне рішення:** конкретна форма винесення — `{/* ToDo: … */}` — проєктна; вона діє в парі
з `{/* NEEDS CONFIRMATION: … */}` для непідтверджених фактів.

### Ж7 — Мова заголовків (Heading language)

Заголовок пишеться **мовою контенту документа**. Змішаний заголовок заборонено.

- Код-сутність у заголовку допустима — у `code font` (Ж4).
- Поняття, що має термін у глосарії, у заголовку вживається українською/англійською за
  документом, а не мовою джерела чи інтерв'ю.
- Регістр — sentence case (`GDSG-STRUCTURE-HEADINGS`, `GDSG-LANGUAGE-ABBREVIATIONS`).

На українській сторінці:

- ⛔ `### Payment method і payment type` — змішаний заголовок, англійські поняття мають терміни
  в глосарії.
- ✅ `### Платіжний метод і тип платежу` — обидва поняття українською.
- ✅ <code>### Параметри `paymentMethod` і `paymentType`</code> — якщо розділ справді про
  параметри запиту, а не про поняття: тоді це код-сутності й вони лишаються англійськими в
  `code font`.

**Проєктне рішення** — корпус одномовний (`languages: [en-US]`) і питання змішування мов у
заголовку не розглядає взагалі. Регістр заголовків при цьому лишається за корпусом.

### Чекліст ядра

- [ ] Жодного жирного, який не є видимою міткою UI (Ж1)?
- [ ] Жодного жирного «для важливості» (Ж1)?
- [ ] Літеральні значення з UI — жирний **і** `code font` (Ж1)?
- [ ] Усі плейсхолдери — `*UPPER_SNAKE*`, включно з тими, що всередині URL (Ж2)?
- [ ] Жодного рядка зірочок, `xxxxx`, «щось» замість плейсхолдера (Ж2)?
- [ ] Кожна сутність має рівно один рендер по всьому документу (Ж3)?
- [ ] Рендер кожного терміна взято з колонки **Рендер** глосарію, а не вигадано (Ж3)?
- [ ] Англійські терміни розкладено за ролями: код → `code font`, поняття → термін глосарію, мітка → жирний (Ж4)?
- [ ] Кожен англійський термін без перекладу і без коду — доданий у глосарій або позначений `NEEDS CONFIRMATION` (Ж4)?
- [ ] Назви репозиторіїв — у `code font` (Ж5)?
- [ ] У тілі сторінки немає планів і майбутніх змін — вони в `{/* ToDo: … */}` (Ж6)?
- [ ] Заголовки — однією мовою, мовою документа; код-сутності в них у `code font` (Ж7)?

---

## Українською

Розділ діє для документів українською мовою. Правопис сюди не входить — він у
`${CLAUDE_PLUGIN_ROOT}/context/doc-rules/ua-grammar/`, маршрутизація через `INDEX.md`.

### Термінологія

- Канонічні терміни — з `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/glossary-ua.md`
  разом із колонкою **Рендер**. Глосарій нормативний: він задає і термін, і його написання.
- Ключові заміни: **Партнер** (не «провайдер», «клієнт», «мерчант»); **Кінцевий клієнт** (не
  «кінцевий користувач»); **Транзакція** (не «запит», «операція», «аплікація»); **Вхідна
  транзакція** (не «поповнення»); **Вихідна транзакція** (не «виплата» як синонім); **Вебхук**
  (не «колбек», «нотифікація», «пуш»); **API-токен** (не «партнерський токен»); **Кабінет
  партнера** (не «дашборд», «портал»); **Віджет** (не «компонент»). Повний перелік і всі «не
  використовуйте» — у глосарії.
- Новий термін, якого в глосарії немає, спершу додається в глосарій — див. Ж4.

### Назви, бренди, латинка

- **UniComPay** — офіційна назва платформи, без транслітерації: не «Юнікомпей», не «Unicompay»,
  не «UCP Pay». **UCP** — скорочення, тільки після першої повної згадки «UniComPay (UCP)».
- Технічні абревіатури — латинкою, без кирилічної транслітерації: API, UUID, IBAN, JSON, HTTP,
  URL. Не «АПІ», не «апі», не «джейсон».
- Назва платформи, продукту чи фічі — звичайним текстом, не жирним (Ж1).
- Назви розділів кабінету партнера — з великої, як власні назви: **Моніторинг**, **Архів**,
  **Налаштування**. Це водночас видимі мітки UI, тож жирний тут за Ж1 доречний.
- При першій згадці нового скорочення — повна форма + скорочення в дужках, далі тільки
  скорочення (`GDSG-LANGUAGE-ABBREVIATIONS`).

### Лапки

Правописна основа — «ялинки» «…», вкладені — „…" (правопис § 164; файл
`ua-grammar/05f-quotes-slash.md`). Проєктне уточнення до неї:

- UI-мітки в лапки **не беруться** — вони жирні (Ж1): натисніть **Зберегти**, а не натисніть
  «Зберегти».
- Системні значення й статуси в лапки **не беруться** — вони в `code font` (Ж4): статус
  `success`, а не статус «success».
- Дослівний текст системного повідомлення береться в «ялинки» і виділяється жирним:
  з'являється **«Токен недійсний»**.

### Заголовки, списки, процедури

- Sentence case у заголовках і пунктах списків: «Фільтрування транзакцій», не «Фільтрування
  Транзакцій».
- Вступне речення перед нумерованим списком — **повне**, із двокрапкою: «Щоб {ціль}, виконайте
  такі дії:». Не «Щоб {ціль}:» і не «Поля:».
- Однокрокова процедура — коротка форма: `**Щоб {ціль}:**` + маркер `—`. Формула «виконайте такі
  дії» лишається тільки для нумерованого списку.

### Стиль речення

- Інструкція — наказовий спосіб 2-ї особи множини: **натисніть**, **виберіть**, **перевірте**.
  Не інфінітив: ⛔ «Вибрати транзакцію».
- Поведінка системи — теперішнім часом: ✅ «система відкриває форму», ⛔ «система відкриє форму».
- Активний стан, друга особа: ✅ «Ви переглядаєте транзакцію», ⛔ «Транзакція переглядається».
- Порядок «мета → дія»: ✅ «Щоб застосувати фільтр, натисніть **Застосувати**.»
- Числа: до 10 — словами («три кроки»), від 10 — цифрами («12 транзакцій»); точні дані завжди
  цифрами («128 символів»). Між числом і одиницею — нерозривний пробіл.
- Косу риску не вживай замість «та/або»: ✅ «переглянути або редагувати», ⛔
  «переглянути/редагувати».

### Кальки й слова-заборони

Правопис цього не покриває — це проєктні заборони.

| ⛔ Не так | ✅ Так |
|---|---|
| натисніть **на** кнопку | натисніть **кнопку** / виберіть **кнопку** |
| на стороні API | з боку API / у системі UCPay |
| клікнути | натиснути |
| заскролити | гортати |
| зайти у систему | увійти в систему |
| являється | є |
| даний (у значенні «цей») | цей |
| в залежності від | залежно від |
| не дивлячись на | попри / незважаючи на |
| здійснити | виконати |
| відкрити доступ | надати доступ |
| по API / по інструкції | через API / згідно з інструкцією |
| при відправці | під час відправлення |
| слідуючий | наступний |
| вірний (у значенні «правильний») | правильний |

---

## English

This section applies to English-language pages. The Core section above applies unchanged — the
ban on emphasis bold, the placeholder form, the one-entity-one-render rule, the code-entity/concept
split, repository names in code font, as-is documenting, and heading language are not
language-specific.

### Terminology

- Canonical terms come from
  `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/glossary-en.md`, including its **Render**
  column. The glossary is normative for both the term and its rendering.
- Key substitutions: **Partner** (not provider, client, merchant); **End client** (not end user,
  customer); **Transaction** (not application, operation); **Inbound / Outbound transaction** (not
  pay-in / payout — except operator cabinet docs, where **Payin** / **Payout** are the standard
  terms); **Webhook** (not callback, notification, push); **API token** (not partner token, bearer
  token); **Partner cabinet** (not dashboard, partner portal); **Widget** (not component). The full
  list and every "don't use" synonym live in the glossary.
- A term that isn't in the glossary yet gets added to the glossary first — see Ж4.

### Names, brands, abbreviations

- **UniComPay** is the official platform name; **UCP** is the abbreviation, used only after the
  first full mention "UniComPay (UCP)".
- Technical abbreviations stay as-is: API, UUID, IBAN, JSON, HTTP, URL.
- A platform, product, or feature name is ordinary type, never bold (Ж1).
- Expand a new abbreviation at first mention, then use the short form only
  (`GDSG-LANGUAGE-ABBREVIATIONS`).

### Quotation marks

- Straight double quotation marks; punctuation placement follows the corpus
  (`punctuation/quotes-parentheses-ellipses-and-slashes.md`, which is `scope: mixed` — its
  US-English clauses apply on an English project).
- No quotation marks around a UI label — it is bold (Ж1): click **Save**, not click "Save".
- No quotation marks around a system value or status — it is code font (Ж4): the `success`
  status, not the "success" status.

### Headings, lists, procedures

- Sentence case for headings and list items (`GDSG-STRUCTURE-HEADINGS`).
- A full introductory sentence ending in a colon before a numbered list: "To {goal}, do the
  following:". Not "To {goal}:" and not "Fields:".
- A single-step procedure uses the short form: `**To {goal}:**` followed by an em-dash bullet.

### Sentence style

- Steps use the imperative: **click**, **select**, **enter**, **press**. Not the infinitive.
- System behavior in present tense: "the system opens the form", not "the system will open the
  form".
- Active voice, second person (`language/grammar-person-and-voice.md`).
- Numbers: spell out under 10 in prose, use numerals from 10 up; exact data always in numerals.
  Non-breaking space between a number and its unit (`GDSG-FORMAT-NUMBERS`).
- Don't use a slash for "and/or": "view or edit", not "view/edit".
- US spelling per the corpus — **with one project exception**: the transaction status value is
  `cancelled` (UK spelling), because it is a literal code value, not prose. It never becomes
  `canceled`. Prose around it still follows US spelling.
