# Screenshot capture — shared rules

Apply these rules whenever taking screenshots via Playwright: inside `app-explorer` (Step 3), inside `resolve-markers` (targeted capture for a `{/* ToDo: add a screenshot */}` marker), and whenever a writer skill requests a re-capture.

These rules govern *how* to capture. For *which* screenshots to select and embed in a doc page, see `screenshot-selection.md`.

---

## Section 0 — Resolve capture configuration (do this first)

Frame **thickness and color**, default scope, compact-image width, and blur radius are **project-declared, not hardcoded** — a project's UI may need a different accent color or a wider compact image than another's. Resolve them before the first capture. **Frame shape is not configurable:** every annotation is a **rectangular, border-only** frame (`border-radius: 0`, transparent fill). This is an invariant — see the annotation invariant below and Section 3.

1. Read the invoking project's `CLAUDE.md` — the same **"Documentation toolkit configuration"** section that declares the style guide and content roots (see `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`). Read these fields:

   | Field | Meaning | Default if undeclared |
   |---|---|---|
   | `Screenshot frame:` | `{thickness}, {color}` — thickness in px; color as hex. Shape is **always** `rectangular` and is not read from config (see below). | `3px, #CC0000` |
   | `Screenshot scope:` | default clip for a plain (non-overlay) capture: `container` (scope ladder, Section 1) or `full-page` (full viewport) | `container` |
   | `Screenshot padding:` | px of padding added around a clipped capture on all sides (Section 1) | `24` |
   | `Compact image width:` | width in px for compact embeds (dialogs, panels) | `480` |
   | `Blur radius:` | CSS blur radius in px for sensitive data (Section 4) | `8` |
   | `Doc content width:` | px width of the main content column in the rendered doc site; used to normalize frame thickness so it appears the same on full-page and compact screenshots (Section 3) | `840` |

2. If a field is present, use its value for every capture in this run.
3. If a field is missing, use the default above **and** offer once to persist the declaration into that project's `CLAUDE.md` under the same section — do not ask again on the next run. Do not stop for a missing field; the defaults are always safe.
4. Never bake a color, width, radius, or padding into a capture from memory — always resolve it from config or the documented default here.

### Annotation shape invariant (not overridable)

The annotation frame is **always a rectangle with square corners and no fill**: `border-radius: 0`, `backgroundColor` unset (transparent), a solid border only. No rounded corners, no translucent region fill, no circles, arrows, or freehand marks. A project **cannot** override this through config.

**Legacy shape config — deprecate, warn, normalize.** Older projects may still declare a three-part `Screenshot frame:` value like `rounded, 3px, #CC0000` or `match-element, 3px, #CC0000`, or a separate shape field. When you read a shape token other than `rectangular`:

1. **Do not silently continue rendering rounded (or element-matched) frames.**
2. **Warn** the user once: name the deprecated shape value found and state that annotations are now rectangular border-only.
3. **Normalize:** ignore the shape token, take only the thickness and color from the value, and render the rectangular border-only frame. Offer once to rewrite the declaration to the two-part `{thickness}, {color}` form.

Example declaration:

```md
## Documentation toolkit configuration

- **Screenshot frame:** `3px, #CC0000`
- **Screenshot scope:** `container`
- **Screenshot padding:** `24`
- **Compact image width:** `480`
- **Blur radius:** `8`
- **Doc content width:** `840`
```

Throughout this file, `{frame.thickness}`, `{frame.color}`, `{padding}`, `{blur.radius}`, and `{doc.content.width}` refer to the resolved values. There is no `{frame.shape}` — the shape is always rectangular.

---

## Section 1 — Scope: how to clip each shot

The default scope for a plain (non-overlay) capture is the resolved `Screenshot scope:` value (Section 0): `container` runs the scope ladder below; `full-page` captures the full viewport. The rules below describe `container`.

**Shot 1 — trigger context (the page state before opening a dialog or dropdown):** use the fallback ladder below. Tried top to bottom; first match wins.

1. Walk up the DOM from the trigger element. Accept the first ancestor that is a semantic landmark: `table`, `[role="grid"]`, `[role="table"]`, `form`, `aside`, `section`, `article`.
2. **Too large:** if the candidate's height exceeds 75 % of the viewport height, go up one more level and restart from step 1.
3. **Named container:** if no semantic landmark was found, accept the first ancestor matching a class or role common in SPA admin UIs: `.card`, `.panel`, `[role="region"]`, `[role="complementary"]`.
4. **Too small:** if the candidate is smaller than 150 px in either dimension, go up one level and restart.
5. **Full-viewport fallback:** if no suitable ancestor is found after walking 5 levels, capture full viewport (`page.screenshot({ path: 'filename.png' })`, no `clip`). Log that the fallback fired and which selector was last tried under this screen's entry in `app-notes.md`.

Clip to the matched container + `{padding}` px padding on all sides (resolved from config, default 24), then annotate the trigger inside it (Section 3) before shooting.

**Shot 2 — the overlay that opened.** Branch by overlay type — this is the key decision:

- **Self-contained overlay** (a centered modal or dialog — typically `[role="dialog"]`, `[role="alertdialog"]`, an element that dims the page behind it): the overlay carries its own context, so clip to **just the overlay's bounding box + `{padding}` px**.

  ```javascript
  const pad = {padding};   // resolved from config (Section 0), default 24
  const box = await page.locator(overlaySelector).boundingBox();
  await page.screenshot({
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: box.width + pad * 2,
      height: box.height + pad * 2,
    },
    path: 'filename.png',
  });
  ```

- **Anchored overlay** (a dropdown, calendar/date-picker, status list, or popover attached to a control inside a panel or toolbar): clipping to only the overlay hides *where on the page* it came from. Instead, clip to the **union rectangle** of the trigger's containing panel (found via the scope ladder above) **and** the open overlay, and annotate the trigger. Now the panel and the open element are visible together.

  ```javascript
  const pad = {padding};   // resolved from config (Section 0), default 24
  const panel   = await page.locator(containerSelector).boundingBox();  // e.g. the filter panel
  const overlay = await page.locator(overlaySelector).boundingBox();     // e.g. the open calendar
  const x = Math.min(panel.x, overlay.x);
  const y = Math.min(panel.y, overlay.y);
  await page.screenshot({
    clip: {
      x: Math.max(0, x - pad),
      y: Math.max(0, y - pad),
      width:  Math.max(panel.x + panel.width,  overlay.x + overlay.width)  - x + pad * 2,
      height: Math.max(panel.y + panel.height, overlay.y + overlay.height) - y + pad * 2,
    },
    path: 'filename.png',
  });
  ```

  For an anchored overlay this single union shot **replaces** the trigger+overlay pair — the trigger context and the open element are already in one image, so do not also produce a separate Shot 1.

Never use `fullPage: true` — it captures scroll-hidden content the user cannot see and produces very tall, unusable images.

---

## Section 2 — Shot pattern for dialogs and menus

When a dialog, modal, drawer, dropdown, or popover is opened by a user action, the number of shots depends on the overlay type (see Section 1, Shot 2):

**Self-contained overlay (centered modal/dialog) — two shots in sequence:**

- **Shot 1 — Trigger context:** the page state *before* triggering, with the trigger element annotated (Section 3). Name: `{subject}-trigger.png`.
- **Shot 2 — Focused result:** after triggering, clipped to the overlay's bounding box (Section 1). Name: `{subject}-dialog.png`.

The doc writer decides which shot(s) to embed per step:
- Step that instructs "click X" → embed Shot 1 (shows where the trigger is)
- Step describing what the dialog contains → embed Shot 2 (focused on the dialog)
- Both shots may be embedded in sequence for a multi-step procedure

**Anchored overlay (dropdown, calendar, status list, popover) — one union shot:**

- A single shot clipped to the union of the trigger's panel and the open overlay, trigger annotated (Section 1). Name: `{subject}-dropdown.png`.
- This one image already shows both the panel context and the open element, so do not produce a separate trigger shot.

For state changes that do not open a separate overlay (e.g., a table refreshes in place after clicking a button), one full-viewport shot *after* the change is sufficient — no trigger context shot needed.

---

## Section 3 — Annotations

Draw the frame as a **separate overlay `<div>` positioned over the element**, not as an `outline`/`border` on the element itself. This is deliberate: an `outline` on the element inherits the element's own `border-radius`, so a rounded button would get a rounded frame. A standalone overlay makes the frame a **rectangle with square corners regardless of the element** — which is the required shape (Section 0 invariant).

The overlay is **border-only and rectangular**: `border-radius: 0` and no background fill, always. Only the border's `thickness` and `color` come from config; the shape never does. Do not read a `{frame.shape}` value — there isn't one.

**Visual-thickness normalization.** A full-page screenshot is displayed at roughly `{doc.content.width} / viewport_width` scale in the doc, while a compact screenshot is displayed at `{compact-width} / clip_width` scale. A fixed CSS `border-width` that looks correct in a compact clip will appear proportionally thinner on a full-page shot. To keep the perceived frame the same across both shot types, compute an `adjustedThickness` before injecting:

```javascript
// For a full-page shot (viewportWidth is page.viewportSize().width):
const scale = {doc.content.width} / viewportWidth;
const adjustedThickness = Math.round({frame.thickness} / scale);

// For a compact clip (clipWidth is the clip.width passed to page.screenshot):
const scale = {compact-width} / clipWidth;
const adjustedThickness = Math.round({frame.thickness} / scale);
```

Use `adjustedThickness` in place of `{frame.thickness}` everywhere inside the inject snippet for that shot.

**Red border — interactive element (button, link, action icon):**

```javascript
// Compute before injecting (example for a compact clip):
const scale = {compact-width} / clipWidth;          // or {doc.content.width} / viewportWidth for full-page
const adjustedThickness = Math.round({frame.thickness} / scale);

const frame = { thickness: adjustedThickness, color: '{frame.color}' };

// inject
await page.locator(selector).evaluate((el, frame) => {
  const r = el.getBoundingClientRect();
  const box = document.createElement('div');
  box.dataset._annotation = '1';
  Object.assign(box.style, {
    position: 'fixed',
    left:   (r.left - frame.thickness) + 'px',
    top:    (r.top  - frame.thickness) + 'px',
    width:  r.width  + 'px',
    height: r.height + 'px',
    border: `${frame.thickness}px solid ${frame.color}`,
    borderRadius: '0',              // rectangular invariant — never rounded or element-matched
    boxSizing: 'content-box',
    pointerEvents: 'none',
    zIndex: '2147483647',
  });
  document.body.appendChild(box);
}, frame);

// take screenshot here

// cleanup
await page.locator('[data-_annotation]').evaluateAll(els => els.forEach(el => el.remove()));
```

**Region highlight — a panel, column, or area a concept page describes:** the **same border-only rectangular overlay** as an interactive element — no translucent fill, no background. A region is distinguished by the area the frame encloses, not by a tint.

```javascript
// Compute before injecting:
const scale = {compact-width} / clipWidth;          // or {doc.content.width} / viewportWidth for full-page
const adjustedThickness = Math.round({frame.thickness} / scale);

const frame = { thickness: adjustedThickness, color: '{frame.color}' };

// inject
await page.locator(selector).evaluate((el, frame) => {
  const r = el.getBoundingClientRect();
  const box = document.createElement('div');
  box.dataset._annotation = '1';
  Object.assign(box.style, {
    position: 'fixed',
    left:   (r.left - frame.thickness) + 'px',
    top:    (r.top  - frame.thickness) + 'px',
    width:  r.width  + 'px',
    height: r.height + 'px',
    border: `${frame.thickness}px solid ${frame.color}`,
    borderRadius: '0',              // rectangular invariant
    boxSizing: 'content-box',       // no backgroundColor — border-only, transparent
    pointerEvents: 'none',
    zIndex: '2147483647',
  });
  document.body.appendChild(box);
}, frame);

// take screenshot here

// cleanup
await page.locator('[data-_annotation]').evaluateAll(els => els.forEach(el => el.remove()));
```

The frame's thickness and color are the resolved config values (Section 0); the shape is the fixed rectangular invariant — never a configured or hardcoded rounded/element-matched shape, and never a background fill. The `adjustedThickness` normalization ensures the frame renders at the declared `{frame.thickness}` in the final doc regardless of whether the shot is full-page or compact.

**When to annotate:**
- `app-explorer`: annotate the primary interactive element for every state captured. For Shot 1 of a two-shot capture and for the union shot of an anchored overlay, always annotate the trigger.
- `resolve-markers`: annotate the element the marker references before re-capturing.
- Writer skills: if a screenshot in `.assets/` has no annotation and the step clearly points to one element, request a targeted re-capture (via `resolve-markers` or `app-explorer` targeted mode) rather than embedding an unannotated image.

---

## Section 4 — Blur for sensitive data

Blur sensitive values *before* shooting. Do not rely on cropping alone when the sensitive value sits inside a table row or card you need to show in full.

**Data types to blur:** financial amounts and balances; transaction IDs and reference numbers; card and account numbers; customer names and email addresses; internal hostnames and environment labels.

```javascript
const blurRadius = {blur.radius};   // resolved from config (Section 0), default 8
const sensitiveSelectors = [
  /* list of CSS selectors for sensitive fields on this screen */
];

// blur
for (const selector of sensitiveSelectors) {
  await page.locator(selector).evaluate((el, r) => { el.style.filter = `blur(${r}px)`; }, blurRadius);
}

// take screenshot here

// restore
for (const selector of sensitiveSelectors) {
  await page.locator(selector).evaluate(el => { el.style.filter = ''; });
}
```

If you cannot identify a CSS selector for a sensitive value, fall back to cropping it out per `screenshot-selection.md` Step 1. If neither is possible, do not save the screenshot — report the blocker in `app-notes.md` under the affected screen.
