---
description: Running log of bugs, inconsistencies, malfunctions, and missing features found in the doc-writer-toolkit plugin.
---

# Toolkit TODO

Log issues here as you find them. **Claude must not read this file or plan/apply any fixes from it unless explicitly asked** (e.g. "check todo.md", "plan fixes for batch 1", "process the todo list"). Entries just accumulate until then.

## Entry format

- [ ] **[bug|inconsistency|malfunction|missing-feature]** Short title
  - Where: skill/command/context file path
  - What: what's wrong, what you expected instead
  - Batch: (fill in when ready to schedule it)

## Entries

<!-- Add new entries above this line -->

## Batches

Group entries into numbered batches here, in the order they should be tackled. Only fill this in when ready to plan a round — Claude works batch by batch, not ad hoc.

### Batch 1

-
#### Issue 1


Some user guides has an incomplete кferences section when they are generated.

The idea of references table is to describe elements that users see, not just click or drag and drop. For example, is a user click a button in the table of transactions archive, it means all table fields must be included rather than just that specific button. The button is already explained in the step, while all the fields remain unexplained. 

Also sometimes AI includes references directly into a step, which mst the step cumpbersome. References must alway stay in the deidacted section.

Приклад пробелми, де таблиця присутня безпосередньо у самому кроці

```markdown
<Accordion title="7. Сума">

На цьому, останньому, етапі ви вказуєте суми, з якими працює картка. Цей етап містить кілька полів із подібними назвами — таблиця нижче описує кожне з них:

| Атрибут | Опис |
|---|---|
| Сума транзакції (мінімальна – максимальна) | Два поля: мінімальна та максимальна сума однієї вхідної транзакції, яку картка може прийняти. |
| Максимальний баланс на карті | Сума, після досягнення якої картка перестає отримувати нові вхідні заявки. |
| Сума | Поточний баланс картки. Під час додавання нової картки поле порожнє (баланс ще відсутній) і доступне для редагування. |
| Коментар | Коментар до картки. |

1. Заповніть поля **Сума транзакції (мінімальна – максимальна)** і **Максимальний баланс на карті**.
2. У полі **Коментар** введіть коментар до картки.
3. Натисніть **Зберегти**.

**Результат:** На цьому додавання картки завершено. Нова картка з'являється на вкладці **Поточні** в меню **Картки**.

</Accordion>
```

#### Issue 2

While doc asset links are generated as relative (which is correct), the doc links are relateive as well. However, they must be absolute and start with the project folder root (e.g. for a docusaurus project it can be /docs/balance/add-cards/add-cards.md or /balance/add-cards/add-cards.md depending on config). Now, all links are relative to the document that are in.

#### Issue 3

Етапи у юзер гайді мають завжди бути в imperative mood і коли зер продивлюється загловоки цих етапів йому має бути зрозумілий загальний флоу. А потім він розкриває кожен етап і вже виконує конкретні кроки. Зараз Юзер гайд з етапами може згенеруватися з іменниками у загаловку і не завжди зрозумілий флоу.

Приклад як зараз:

```markdown
## Етапи додавання картки

Щоб додати картку для отримання платежів, пройдіть такі етапи майстра **Додати картку для отримання**:

<Accordion title="1. Рахунок">

На цьому етапі ви обираєте тип платіжного реквізиту, за яким картка отримуватиме вхідні транзакції.

1. У бічній панелі, поряд із міткою **Баланс карток:**, натисніть кнопку іконки. Відкривається сторінка з меню **Картки**.
2. ...
...

**Результат:** ...

</Accordion>

<Accordion title="2. Банк інфо">

На цьому етапі ви вказуєте валюту картки та банк, який її обслуговує.

1. У полі **Валюта** виберіть валюту картки.
2. ...
...

**Результат:** ...
</Accordion>

<Accordion title="3. Macrodroid">

На цьому етапі...

1. ...
...

**Результат:** ...

</Accordion>

<Accordion title="4. Оператор">

На цьому етапі...

1. ...
...


**Результат:** ...

</Accordion>

<Accordion title="5. Налаштування">

На цьому етапі...

1. ...
...


**Результат:** ...


</Accordion>

<Accordion title="6. Ліміти">

На цьому етапі...

1. ...
...


**Результат:** ...

</Accordion>

<Accordion title="7. Сума">

Н
На цьому етапі...

1. ...
...


**Результат:** ...

</Accordion>
```

Приклад як має бути:

```markdown
## Етапи додавання картки

Щоб додати картку для отримання платежів, пройдіть такі етапи майстра **Додати картку для отримання**:

<Accordion title="1. Cтворіть рахунок">

На цьому етапі ви обираєте тип платіжного реквізиту, за яким картка отримуватиме вхідні транзакції.

1. У бічній панелі, поряд із міткою **Баланс карток:**, натисніть кнопку іконки. Відкривається сторінка з меню **Картки**.
2. ...
...

**Результат:** ...

</Accordion>

<Accordion title="2. Вкажіть бінківську інформацію">

На цьому етапі ви вказуєте валюту картки та банк, який її обслуговує.

1. У полі **Валюта** виберіть валюту картки.
2. ...
...

**Результат:** ...
</Accordion>

<Accordion title="3. Налаштуйте Macrodroid">

На цьому етапі...

1. ...
...

**Результат:** ...

</Accordion>

<Accordion title="4. Закріпіть карту за оператором">

На цьому етапі...

1. ...
...


**Результат:** ...

</Accordion>

<Accordion title="5. Налаштуйте паузу для карти">

На цьому етапі...

1. ...
...


**Результат:** ...


</Accordion>

<Accordion title="6. Встановіть ліміти">

На цьому етапі...

1. ...
...


**Результат:** ...

</Accordion>

<Accordion title="7. Задайте сумау">

Н
На цьому етапі...

1. ...
...


**Результат:** ...

</Accordion>
```