# Copy-paste prompt — Step 1 test (all 3 sections)

Paste the block below into Claude Code on your Mac, from inside the `UCPAY-DOC-OPERATOR` project. No edits needed. Run it once per branch — it scans whichever of the three folders exist on your current branch and skips the rest.

---

```
Run the section-readiness skill (Step 1 of the section-writing pipeline) on my documentation sections. This is a read-only stocktake — do NOT write or edit any doc pages, only produce the readiness reports.

My test project is at /Users/vadym/Projects/UCPAY-DOC-OPERATOR/ and the three sections to check are:
- docs/transactions   (expected: near-complete drafts → verdict "needs-revision")
- docs/balance        (expected: blank skeleton; the placeholder structure text in the .md files can be treated as empty → verdict "skeleton")
- docs/archive        (expected: partial, rawer than transactions → let the tool judge)

Because each section may live on its own branch, only some of these folders may exist on my current branch. For each of the three:
- If the folder exists, run section-readiness on it.
- If it does not exist, skip it and tell me you skipped it (I'll switch branches and re-run).

Before scanning, check my project's CLAUDE.md for the "Documentation toolkit configuration" section (content language, content root, Admin UI). If any required field is missing, ask me once and offer to add it.

For each section you scan:
1. Produce the report at <section>/.sources/section-readiness.json as the skill defines.
2. ALSO copy that report to /Users/vadym/Projects/doc-writer-toolkit/shared/results/ , renamed by section — transactions-readiness.json, balance-readiness.json, archive-readiness.json. Create the results folder if it isn't there.
3. Give me a 2–3 line plain-English summary: the verdict, how many pages and their labels (empty vs finished), and what source material exists.

At the end, remind me to commit and push the doc-writer-toolkit repo so the reports reach the toolkit side.
```

---

## After it runs

1. It saved 1–3 reports into `/Users/vadym/Projects/doc-writer-toolkit/shared/results/`.
2. Go to the **doc-writer-toolkit** repo, commit, push.
3. Tell me here — I'll read the reports and tell you what they mean and what to fix.

If you were on the transactions branch, you'll get the transactions report and "skipped balance and archive." Switch branch, paste the same prompt again, and it'll do the next one.
