# Test checklist — Step 1 (section-readiness)

Run Step 1 on **three** sections so we cover all three starting states.

## What to run

For each section, run:

```
/check-section-readiness <folder>
```

Example: `/check-section-readiness docs/transactions`

Do it for these three (use your real folder paths):

1. **A skeleton section** — blank template files only.
2. **A near-complete section** — drafts that exist but need fixing.
3. **The `balance` folder** — empty, just the folder.

## Before you run — one setup check

The tool reads settings from your project's `CLAUDE.md`. It needs these lines (under a "Documentation toolkit configuration" heading):

- `Content language:` (e.g. `uk`)
- `UA content root:` (e.g. `docs/`)
- `Admin UI:` (`playwright` if the app is reachable, else `none`)

If they're missing, the tool will ask you once. That's expected.

There's also a new optional line I invented — `API test collection:` (path to your Postman collection, or leave it out). If it's not there, the tool just says "not declared" and moves on. No need to add it yet.

## What to look at in each report

The tool saves a report at `<folder>/.sources/section-readiness.json`. Open it and check:

- [ ] **Did it find every page?** Count the pages in the folder vs. the report.
- [ ] **Are the labels right?** Each page is marked `stub` (empty) or `complete` (real content). Did it get them right?
- [ ] **Is the verdict right?** One line: `skeleton`, `needs-revision`, or `greenfield`. Does it match reality?
- [ ] **Are the counts right?** Screenshots, videos, transcripts.
- [ ] **Did it touch anything it shouldn't?** It should ONLY create that one report file. Nothing else changed.

## What to send back

For each section, copy `section-readiness.json` into `../results/`, rename it (e.g. `transactions-readiness.json`), and add a note if anything looked wrong. Then commit and push.

## What to expect (so you're not surprised)

- **Near-complete section** → the useful one. Real report, real labels.
- **Skeleton section** → correct but thin: "N empty pages." It will NOT tell you if the structure is wrong — that needs the app, which is a later step.
- **`balance`** → almost empty: "no pages, no sources." Correct, just underwhelming. Its real value comes later.
 