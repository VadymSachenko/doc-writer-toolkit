# Screenshot selection — shared rules

## Three-folder model

Three folders, three distinct roles — do not conflate them:

| Folder | Role |
|---|---|
| `.sources/frames/{video}-frames/` | Full archive of extracted frames + `frames-index.json`. Evidence base. Never embedded directly. |
| `.assets/` | Selected, renamed frames ready for embedding. The **only** folder the page links images from. |
| `.assets/ref/` | Reference-only frames: read for context, **never** embed. |

## Selecting screenshots (four cases)

Decide which case applies:

1. **`.assets/` (root) already has files** — these are the curated set. Skip to the rename/classify steps below and use them as-is; do not re-derive from `frames/`.
2. **`.assets/` is empty and `.sources/frames/{video}-frames/` exists** — do not draft without images and do not silently proceed with zero screenshots. Run the selection procedure:
   1. Read `frames-index.json` (schema: `screenshot`, `seconds`, `timestamp`, `ocr_text`, `transcript_text`, `score`, `reasons`, `source`). It's text — tens of KB even for ~100 frames — read the whole thing, not a sample.
   2. For each step or section you plan to write, find candidates by matching against `ocr_text` (what's visibly on screen) and `transcript_text` (what the SME was saying), prioritizing higher `score`.
   3. **Open only the shortlisted candidates** — aim for 3–8 images for the whole page, not all of them. Confirm each one actually shows what the step needs before using it.
   4. **Copy** (not move) the confirmed files into `.assets/` — `frames/` must stay a complete archive for `cleanup-unused-screenshots` to sweep later.
   5. Continue to the rename/classify steps below on the copied files.
3. **`.assets/` is empty and there is no `frames/` folder** (older run, or none extracted) — fall back to the plain "list `.assets/`" behavior and tell the user no `frames-index.json` exists, so they know why you can't do index-driven selection.
4. **Neither folder exists** — ask the user where screenshots are before proceeding.

## Processing every file in .assets/

For every file that ends up in `.assets/` (root), whichever case applied, work through these steps **in order** — do not rename or embed a file that hasn't passed step 1, even if it "looks clean" on a first glance:

### 1. Screen for sensitive content

**Required — never skip this, and never skip it because the frame looks clean.** A frame pulled from a meeting recording is raw evidence, not embeddable material — it was never composed as a screenshot for a public page. Before anything else:

- **Crop to the part that matters.** Participant bars, toolbars, the dock, browser tabs, side panels — none of that is the subject. Isolate only the UI area the step or section actually needs.
- **Check the cropped result against this list** — faces and people's names; usernames and logins; hostnames, domains, IP addresses; environment labels (`PROD`, `TEST`); internal URLs; tokens, keys, session IDs; card and account numbers; customer personal data; other apps and personal desktop items. Look in toolbars and corners, not just the center of the frame — a sensitive label sitting in a place nobody looks is still disqualifying.
- **If cropping can't remove something on the list** — for example a sensitive label sitting inside a table you need — **blur it instead**: apply `element.style.filter = 'blur(8px)'` via Playwright before re-capturing, or use PIL `ImageFilter.GaussianBlur(radius=12)` on the region bounding box via `ImageDraw` if re-capture is not practical. See `screenshot-capture.md` Section 4 for the full blur pattern. If neither is possible, do not embed the image — report the blocker.
- **Save the cropped result as PNG**, regardless of the source frame's format (frames arrive as `screen-HH-MM-SS.jpg`). Cropping already rewrites the file, so converting at this step costs nothing extra, and PNG suits UI screenshots better — this is also what keeps the `.png` extension in the rename pattern below accurate.
- **Annotation** — if the step or section clearly points to one UI element and the screenshot does not already show an annotation (red outline on the element), request a targeted re-capture with annotation via `resolve-markers` or `app-explorer` targeted mode (see `screenshot-capture.md` Section 3) rather than inserting an unannotated image.
- These checks implement `GDSG-VISUALS` and `GDSG-EXAMPLE-001` from the loaded style guide corpus — consult those entries directly for the underlying rules; they are not repeated here.

### 2. Rename

If the filename is non-descriptive (e.g., `image.png`, `image copy.png`, a random string, or a numeric timestamp — this includes the `screen-HH-MM-SS.jpg`-style names frames arrive with), rename it following the pattern `{subject}-{ui-element-type}.png` in kebab-case:

| UI element type | Suffix | Example |
|---|---|---|
| Full-page menu or table | `-page` or `-page-{tab}` | `transactions-page-payout-tab.png` |
| Dialog / modal window | `-dialog` | `transaction-receipts-dialog.png` |
| Side panel / filter panel | `-pane` | `filters-pane.png` |
| Standalone form | `-form` | `add-receipt-form.png` |
| Confirmation banner / toast | `-banner` | `receipt-uploaded-banner.png` |

Use the Bash tool: `mv "./.assets/old-name.png" "./.assets/new-name.png"`. Rename before drafting so all embed references use the final filename.

### 3. Classify and embed

Classify each file as **full-page** or **compact**:

- **Full-page** — whole menu, dashboard, or table spanning the full content area.
- **Compact** — dialog window, modal, or narrow panel that visually occupies significantly less than the full content width.

Use the embed syntax that matches the classification (note the leading dot on `./.assets/` — images embed from `./.assets/`, not `./assets/`):

- **Full-page:** `![{descriptive alt}](./.assets/{filename})`
- **Compact:** `<img src={require('./.assets/{filename}').default} width="480" alt="{descriptive alt}" />`

This is the single source of truth for the embed markup — consuming skills reference this file rather than restating the JSX/width.
