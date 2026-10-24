---
name: procedure-steps
description: The single shared rule for when closely coupled actions in a numbered procedure share one step (an input or selection and the commit click that completes it) and when they stay separate. Referenced by every skill that writes, edits, reviews, or fixes procedure steps (user-guide-writer, doc-page-updater, doc-style-reviewer, doc-style-fixer) and by both user-guide templates — never copy these conditions into a skill file.
metadata:
  type: reference
---

# Procedure steps: grouping coupled actions

Single source of truth for **when two actions share one step**. Every skill that writes, edits,
reviews, or fixes a numbered procedure resolves the rule here.

## Where the rule comes from

It is a **project decision**, compatible with the routed source guides but not directly mandated by
either. Cite it as this file; cite the guides as the guidance it builds on:

- Google Developer Style Guide, `${CLAUDE_PLUGIN_ROOT}/context/google-developer-style-guide/procedures/procedures.md`:
  one action or one closely coupled action group per step; its own example puts a selection and the
  following **Save** in one step.
- Microsoft Writing Style Guide, `${CLAUDE_PLUGIN_ROOT}/context/microsoft-style-guide/shared/procedures/step-by-step-instructions.md`:
  combine short actions only when they occur in the same place, and include the action that commits
  or completes the task, such as **Apply** or **OK**.

## The rule

1. **Merge** an input or selection with the commit click that completes it (**Save**, **Apply**,
   **OK**, **Submit**) into one step **only when every condition holds**:
   - the actions happen in one window, form, or panel, with no interruption;
   - together they complete one logical user action;
   - the commit immediately follows the input or selection;
   - no meaningful intermediate result, decision, warning, validation state, or explanation
     intervenes;
   - the combined step still scans easily.
2. **Keep them separate when any of these holds:**
   - the user moves to another location or phase;
   - validation or review must happen before committing;
   - the commit is destructive or needs a warning;
   - an optional branch intervenes;
   - the first step is already long or has complex substeps;
   - the commit produces a result that needs its own explanation or screenshot.
3. **"Find X" before an action on that same X** isn't its own step either: merge it into the action.
4. **Location before action**, inside a merged step as in any other: "In the **Change password**
   window, enter the old and new password and click **Save**."
5. **Never merge unrelated actions** to shorten a procedure. Outside these cases: one step, one
   independent action.

## Fixtures

Merge (a needless split):

```md
3. In the **Change password** window, enter the old and new password.
4. Click **Save**.
```

→ `3. In the **Change password** window, enter the old and new password and click **Save**.`

Keep separate (a review state comes before an irreversible commit):

```md
3. In the **Transfer** window, enter the amount.
4. Review the fee shown below the field, then click **Confirm**.
```

Ukrainian:

- ✅ «У вікні **Зміна пароля** введіть старий і новий пароль і натисніть **Зберегти**.»
- ⛔ «У вікні **Зміна пароля** введіть старий і новий пароль.» + окремий крок «Натисніть **Зберегти**.»
- ✅ (окремі кроки) «Введіть суму переказу.» → «Перевірте комісію під полем і натисніть **Підтвердити**.»

## Who does what

- **Writers** (`user-guide-writer`) and the **user-guide templates**: draft steps by this rule.
- **Updater** (`doc-page-updater`): a step it adds or edits follows the rule; it doesn't regroup steps
  outside its blocks.
- **Reviewer** (`doc-style-reviewer`): reports a needless split (rule 1, every merge condition holds)
  as a finding citing this file, with the two guide files as the guidance it builds on, and says it
  is a project decision. It reports nothing when any rule 2 condition holds.
- **Fixer** (`doc-style-fixer`): a merge is a substantive fix (bucket 2); the merged step is shown
  before it is applied.
