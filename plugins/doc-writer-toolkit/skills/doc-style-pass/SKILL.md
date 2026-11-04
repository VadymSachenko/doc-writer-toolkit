---
name: doc-style-pass
description: 'One style pass on one documentation page, UA or EN, for the person who approves it: runs doc-style-reviewer, then doc-style-fixer in its apply:mechanical,substantive mode, and ends in a single numbered list (every applied change as «before» → «after» with its rule, then the judgment questions, never applied). The user answers with the numbers to undo: those changes get their exact «before» back, and every decision is logged in the host''s <state root>/style-decisions.jsonl. A rule rejected in three passes with no acceptance in between is proposed once as one exception line for the product kit''s product-rules.md, written only on a yes. Never invoked implicitly: it edits files. Use explicitly ("/style-pass docs/balance/balance.md", "use doc-style-pass on docs/balance/balance.md").'
---

# doc-style-pass

You run one style pass on exactly one page for the person who approves it. They read one list and answer it by number, instead of reading the review and the fixes one by one. The review and the fixes are the existing skills, unchanged: this skill only runs them, turns what changed into the list, undoes what the user rejects and remembers the decision. It edits files, so it starts only when the user asks for it explicitly.

## Scope

- **In scope:** one page, UA or EN, under any root pair, the whole page or only its changed blocks (scope mode); running `doc-style-reviewer` and then `doc-style-fixer` with `apply:mechanical,substantive`; the numbered list; undoing the items the user names; the decision log; proposing an exception line for a rule the user keeps rejecting, pass after pass.
- **Out of scope:**
  - Finding and classifying. `doc-style-reviewer` finds, `doc-style-fixer` classifies and applies. This skill adds no finding, moves no finding to another bucket, and changes nothing on the page that the fixer didn't change, except an undo and a question the user answered with its wording.
  - Bucket 3 (judgment-required) fixes: they are listed as questions and never applied on their own.
  - `{/* ToDo */}` and `{/* NEEDS CONFIRMATION */}` markers (`resolve-markers`, `/fix-doc-todos`), UA/EN alignment (`doc-alignment-checker`), translation (`doc-translator`).
  - More than one page, and unattended runs: `document-section` calls `doc-style-fixer` directly and never this skill.
  - The reviewer's rules and the corpora. An exception the user approves goes into the host's own product kit, never into the plugin.

## Arguments

- `<path>`: the page, from the repo root. Required.
- `guide:<token>` and the scope tokens `--changed [<base>]`, `sections:"…"`, `report:<update-report.md>`: passed through unchanged to `doc-style-reviewer` and `doc-style-fixer`, which resolve them as they always do.
- `undo:<n,…>` or `keep:all`: the answer to a pass on this page that is still open from an earlier session (Step 1). No new review runs.

## Sources to load

1. `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`: `Toolkit state root:` ("Label store and locale translation"; default `.doc-toolkit/`) and the product kit ("Product kit").
2. The page.
3. `<state root>/style-decisions.jsonl`, if it exists: only the lines of the rules the user rejects in this pass (Step 7).
4. `<kit>/product-rules.md`, only when Step 7 proposes a line.

Nothing else. The reviewer and the fixer load their own sources.

**Files this skill writes**, and no others:

- the page: through the fixer (Step 3), the undo and the answered questions (Step 6);
- the run folder `<state root>/.run/style-pass/`: the snapshot `<page id>.before.md` and the pass record `<page id>.json`. `<page id>` is the page path from the repo root without its extension, `/` written as `__` (`docs/balance/balance.md` → `docs__balance__balance`). If `<state root>/.run/.gitignore` doesn't exist, write it with the single line `*`, so nothing in `.run/` is committed;
- `<state root>/style-decisions.jsonl`: the decision log, committed with the pages;
- `<kit>/product-rules.md`: one line, only after the user's yes (Step 7).

## Step 1 — Start

1. The page doesn't exist: stop and say so before loading anything else.
2. Resolve the state root and the product kit through `project-paths.md`. A declared kit folder that doesn't exist stops the run, as that file says.
3. **An open pass.** If `<run>/<page id>.json` exists with `"closed": false`, an earlier pass on this page still waits for its answer.
   - With `undo:` or `keep:all`: go to Step 6 with that record.
   - Otherwise show its list again (Step 5) and ask for the answer. Start a new pass only when the user says to drop the old one: set its `"closed"` to `"dropped"` and log nothing for it.
   - `undo:` or `keep:all` with no open record: stop and say there is no open pass for this page.
4. Copy the page byte for byte to `<run>/<page id>.before.md` (`cp`). This snapshot is the «before» of everything that follows. The time you take it, `YYYY-MM-DDTHH:MM:SS` (`date +%Y-%m-%dT%H:%M:%S`), is the pass id: every log line of this pass carries it (Step 6), and Step 7 counts rejections by it.

## Step 2 — Review

Run `doc-style-reviewer <path>` with the `guide:` and scope tokens you were given. Its report is the only source of findings. Don't retell it: the list in Step 5 is what the user reads.

No findings: say the page is clean, delete the snapshot and stop.

## Step 3 — Fix

Run `doc-style-fixer <path> apply:mechanical,substantive` with the same `guide:` and scope tokens, and name the Step 2 report as the one to use, so the fixer neither reviews again nor asks which report. Everything the fixer does is its own: its buckets, its Scope-block limit, its rule that bucket 3 is never applied. Don't edit the page yourself in this step, and don't run the fixer twice.

## Step 4 — Build the list from the diff

The list is built from what changed on disk, not from memory of the fixer's report.

1. Run `git diff --no-index --word-diff=plain <run>/<page id>.before.md <path>`. Every `[-…-]{+…+}` is a change.
2. Match each change to the finding it applies, by the reviewer card's location and suggested fix and by the fixer's report. **One item per applied finding.** A finding fixed in several places (the reviewer's occurrence sweep) is one item with several places. Changes of two findings that touch or overlap are one item naming both rules: `rule` holds the first, `alsoRules` the others.
3. A change that matches no finding is still an item, with the rule `no finding: changed outside the report`. Say in Step 5 that it should be undone.
4. Each place keeps `line` (in the fixed page), `before` and `after`. They are exact substrings, copied from the snapshot and from the fixed page, never retyped: `’` and `'`, `—` and `-`, `«` and `"` are different characters. Both carry the same surrounding words, widened until `before` occurs exactly once in the snapshot and `after` exactly once in the fixed page.
5. Each bucket 3 finding becomes a question: its text on the page, its rule and the question the fixer asked.
6. Write the pass record `<run>/<page id>.json`. Numbers run through the items, then the questions, so every number is unique:

   ```json
   {
     "page": "docs/balance/balance.md",
     "guide": "gdsg@uk",
     "date": "2026-11-04",
     "pass": "2026-11-04T10:14:03",
     "closed": false,
     "items": [
       {
         "n": 1,
         "rule": { "file": "ua-grammar/01a-vowels-alternations.md", "id": "§7" },
         "finding": "[UA-SPELLING] Straight apostrophe",
         "summary": "typographic apostrophe",
         "places": [ { "line": 12, "before": "обов'язково перегляньте", "after": "обов’язково перегляньте" } ]
       }
     ],
     "questions": [
       { "n": 2, "rule": { "file": "project-rules/formatting-conventions.md", "id": "Ж1" }, "finding": "[FORMATTING] Bold on a concept", "text": "**Payment type**", "question": "Is Payment type a label in the app, or a concept?" }
     ]
   }
   ```

   `guide` is the report's `Profile:` value. `rule.file` and `rule.id` are the finding's citation as the report gives it: the corpus or project file, and the rule id or §. `summary` is the rule in a few words, in the user's language.
7. **Round-trip check.** Undoing every item on the fixed page must give back the snapshot exactly:

   ```bash
   node -e '
   const fs = require("fs"); const [rec, snap, page] = process.argv.slice(1);
   const r = JSON.parse(fs.readFileSync(rec, "utf8")); let t = fs.readFileSync(page, "utf8");
   for (const i of r.items) for (const p of i.places) {
     const k = t.split(p.after).length - 1;
     if (k !== 1) { console.log(`item ${i.n}: "after" found ${k} times`); process.exit(1); }
     t = t.replace(p.after, () => p.before);
   }
   const ok = t === fs.readFileSync(snap, "utf8"); console.log(ok ? "round trip ok" : "round trip differs"); process.exit(ok ? 0 : 1);
   ' <run>/<page id>.json <run>/<page id>.before.md <path>
   ```

   It fails: correct the record (widen an excerpt, add a change you missed) and run it again. Never show a list that fails it.

## Step 5 — Show the one list

Show only this, in the user's language:

```
Style pass: <path> (<profile>). <N> changes applied, <M> questions.

1. «<before>» → «<after>»
   <summary> — <rule id>, <rule file>
2. a. line 14: «<before>» → «<after>»
   b. line 31: «<before>» → «<after>»
   <summary> — <rule id>, <rule file>

Questions, nothing applied:
5. «<text>»: <question> — <rule id>, <rule file>

Reply with the numbers to undo ("undo 2, 4") or "keep all". Answer a question by its number with the wording you want.
```

The excerpts shown are the record's. Only a long one (over about 120 characters) may be shortened with `…` on screen, keeping every changed word; the record keeps the full text. No changes and no questions: say the page is clean and close the record. When the session can't wait for a reply (a headless run), the pass stays open: the user answers later with `undo:` or `keep:all` (Step 1).

## Step 6 — Apply the answer

1. **Unclear answers.** A number that isn't in the list, or an answer you can't read as undo, keep or wording: ask about that number. Apply nothing for it until it's clear.
2. **Undo.** For every place of every item named: replace its `after` with its `before` in the page by an exact string replacement (the Edit tool), and only when `after` occurs exactly once in the page now. If it doesn't, the page changed since the pass: leave that item, name it and ask.
3. **Questions.** A question answered with wording: apply exactly that wording at that finding's place, within the fixer's Step 4 limits (no marker, code or frontmatter, except a `title`/`description` the finding names). An unanswered question changes nothing. Questions aren't logged.
4. **Log.** Append to `<state root>/style-decisions.jsonl` one JSON line per item, in list order: `"decision": "rejected"` for an undone item, `"decision": "accepted"` for a kept one. An item still waiting (point 1 or 2) gets its line once it's settled.

   ```json
   {"date":"2026-11-04","pass":"2026-11-04T10:14:03","page":"docs/balance/balance.md","guide":"gdsg@uk","rule":{"file":"ua-grammar/01a-vowels-alternations.md","id":"§7"},"finding":"[UA-SPELLING] Straight apostrophe","before":"обов'язково перегляньте","after":"обов’язково перегляньте","decision":"rejected"}
   ```

   `before` and `after` are the first place's; an item with several places adds `"places": <count>`. An item with `alsoRules` gets one line per rule, the same decision on each, so every rule's count stays right. No line breaks inside a line.
5. In the pass record, add the answer and set `"closed": true`.

## Step 7 — Propose an exception for a rule rejected in three passes

For each rule (`rule.file` plus `rule.id`) that has a `rejected` line from this pass:

1. Read that rule's lines in the log, in file order, and group them by `pass`. **A rule counts once per pass:** a pass with an `accepted` line for the rule is an acceptance, even if the same pass also rejected it elsewhere on the page; a pass with only `rejected` lines for it is one rejection, however many items it undid. The streak is the number of rejecting passes after the last accepting pass, or from the start when there is none. An `exception` line after the last accepting pass means the rule was already proposed in this streak: skip it.
2. **A streak of 3 passes or more:** propose one line for `<kit>/product-rules.md`. It is the narrowest rule that would have kept every rejected text of the streak, says what the pages do, and names the corpus rule it overrides, in the language of the file's other lines. For example: `- Keep «<text>» as written, an exception to §7 (ua-grammar/01a-vowels-alternations.md): rejected in three style passes.` Show it with the streak's rejected «before» → «after» under it, and ask yes or no. One proposal per rule.
3. **Yes:** append the line under `## Other rules`. Add that heading at the end of the file when it has none; when the file doesn't exist, create it with `# Product rules` and `## Other rules`, the section names of `${CLAUDE_PLUGIN_ROOT}/context/starter-kit/product-rules.md`. `doc-style-reviewer` loads this file as rank 0, so the rule stops firing there on its next run. **No:** change nothing in the kit.
4. Log the answer: `{"date":"…","pass":"…","rule":{…},"decision":"exception","answer":"yes"|"no","line":"<the proposed line>"}`. A proposal left without an answer isn't logged, so the next pass that rejects the rule offers it again.
5. **No product kit declared:** propose no file edit. Say that the rule has been rejected in three passes and that a product kit would hold the exception (`project-paths.md`, "Product kit"), and log `"answer": "no-kit"`.

## Self-review before saving

Before each write in Steps 6 and 7:

- The page differs from the snapshot only by the kept items and the answered questions. With no answered question, rerun the Step 4 check on a copy of the record that holds only the kept items: it must print `round trip ok`.
- Every undone place now reads exactly its `before`.
- The log has one line per settled item, plus one per answered proposal, and each line parses as JSON.
- `<kit>/product-rules.md` changed only after a yes, and only by the one line.
- `git status --short` shows no other file changed: the page, the log and, after a yes, the kit file (the run folder is ignored).
- No bucket 3 fix was applied without the user's wording, and no `{/* ToDo */}` or `{/* NEEDS CONFIRMATION */}` marker was touched.

## Final report

A few lines: how many changes were kept and undone, which questions were answered and which are left, the log's path, and each proposal with its answer. For an EN page, the same pass runs after `doc-translator`.

## Explicit invocation examples

- `/style-pass docs/balance/balance.md`: the guide comes from the project's declaration, as in `/review-doc-style`.
- `/style-pass i18n/en/docusaurus-plugin-content-docs/current/balance/balance.md guide:gdsg`: the EN translation.
- `/style-pass docs/balance/balance.md --changed origin/main`: only the blocks changed since `origin/main`.
- `/style-pass docs/balance/balance.md undo:2,5`: answers a pass left open in an earlier session.
- "Use doc-style-pass on docs/balance/balance.md"
