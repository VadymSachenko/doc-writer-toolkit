# Screenshot capture — shared rules

Apply these rules whenever taking screenshots via Playwright: inside `app-explorer` (Step 3), inside `resolve-markers` (targeted capture for a `{/* ToDo: add a screenshot */}` marker), and whenever a writer skill requests a re-capture.

These rules govern *how* to capture. For *which* screenshots to select and embed in a doc page, see `screenshot-selection.md`.

---

## Section 1 — Scope: how to clip each shot

**Shot 1 — trigger context (the page state before opening a dialog or dropdown):** use the fallback ladder below. Tried top to bottom; first match wins.

1. Walk up the DOM from the trigger element. Accept the first ancestor that is a semantic landmark: `table`, `[role="grid"]`, `[role="table"]`, `form`, `aside`, `section`, `article`.
2. **Too large:** if the candidate's height exceeds 75 % of the viewport height, go up one more level and restart from step 1.
3. **Named container:** if no semantic landmark was found, accept the first ancestor matching a class or role common in SPA admin UIs: `.card`, `.panel`, `[role="region"]`, `[role="complementary"]`.
4. **Too small:** if the candidate is smaller than 150 px in either dimension, go up one level and restart.
5. **Full-viewport fallback:** if no suitable ancestor is found after walking 5 levels, capture full viewport (`page.screenshot({ path: 'filename.png' })`, no `clip`). Log that the fallback fired and which selector was last tried under this screen's entry in `app-notes.md`.

Clip to the matched container + 24 px padding on all sides, then annotate the trigger inside it (Section 3) before shooting.

**Shot 2 — the dialog, dropdown, or result state itself:** always clip to the element bounding box + 24 px padding on all sides.

```javascript
const box = await page.locator(dialogSelector).boundingBox();
await page.screenshot({
  clip: {
    x: Math.max(0, box.x - 24),
    y: Math.max(0, box.y - 24),
    width: box.width + 48,
    height: box.height + 48,
  },
  path: 'filename.png',
});
```

Never use `fullPage: true` — it captures scroll-hidden content the user cannot see and produces very tall, unusable images.

---

## Section 2 — Two-shot pattern for dialogs and menus

When a dialog, modal, drawer, or dropdown is opened by a user action, capture **two shots in sequence**:

- **Shot 1 — Trigger context:** the page state *before* triggering, with the trigger element annotated (red outline, Section 3). Name: `{subject}-trigger.png`.
- **Shot 2 — Focused result:** after triggering, clipped to the dialog/dropdown per Section 1. Name: `{subject}-dialog.png` or `{subject}-dropdown.png`.

The doc writer decides which shot(s) to embed per step:
- Step that instructs "click X" → embed Shot 1 (shows where the trigger is)
- Step describing what the dialog contains → embed Shot 2 (focused on the dialog)
- Both shots may be embedded in sequence for a multi-step procedure

For state changes that do not open a separate overlay (e.g., a table refreshes in place after clicking a button), one full-viewport shot *after* the change is sufficient — no trigger context shot needed.

---

## Section 3 — Annotations

Inject annotations before shooting; clean up after. Never leave injected styles in the page between captures.

**Red border — interactive element (button, link, action icon):**

```javascript
// inject
await page.locator(selector).evaluate(el => {
  el.dataset._annotated = '1';
  el.style.outline = '3px solid #CC0000';
  el.style.outlineOffset = '2px';
});

// take screenshot here

// cleanup
await page.locator('[data-_annotated]').evaluateAll(els =>
  els.forEach(el => {
    el.style.outline = '';
    el.style.outlineOffset = '';
    delete el.dataset._annotated;
  })
);
```

**Region highlight — a panel, column, or area a concept page describes:**

```javascript
// inject
await page.locator(selector).evaluate(el => {
  el.dataset._annotated = '1';
  el.style.outline = '3px solid #CC0000';
  el.style.outlineOffset = '2px';
  el.style.backgroundColor = 'rgba(204,0,0,0.06)';
});

// take screenshot here

// cleanup
await page.locator('[data-_annotated]').evaluateAll(els =>
  els.forEach(el => {
    el.style.outline = '';
    el.style.outlineOffset = '';
    el.style.backgroundColor = '';
    delete el.dataset._annotated;
  })
);
```

**When to annotate:**
- `app-explorer`: annotate the primary interactive element for every state captured. For Shot 1 of the two-shot pattern, always annotate the trigger.
- `resolve-markers`: annotate the element the marker references before re-capturing.
- Writer skills: if a screenshot in `.assets/` has no annotation and the step clearly points to one element, request a targeted re-capture (via `resolve-markers` or `app-explorer` targeted mode) rather than embedding an unannotated image.

---

## Section 4 — Blur for sensitive data

Blur sensitive values *before* shooting. Do not rely on cropping alone when the sensitive value sits inside a table row or card you need to show in full.

**Data types to blur:** financial amounts and balances; transaction IDs and reference numbers; card and account numbers; customer names and email addresses; internal hostnames and environment labels.

```javascript
const sensitiveSelectors = [
  /* list of CSS selectors for sensitive fields on this screen */
];

// blur
for (const selector of sensitiveSelectors) {
  await page.locator(selector).evaluate(el => { el.style.filter = 'blur(8px)'; });
}

// take screenshot here

// restore
for (const selector of sensitiveSelectors) {
  await page.locator(selector).evaluate(el => { el.style.filter = ''; });
}
```

If you cannot identify a CSS selector for a sensitive value, fall back to cropping it out per `screenshot-selection.md` Step 1. If neither is possible, do not save the screenshot — report the blocker in `app-notes.md` under the affected screen.
