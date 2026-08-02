# Shared folder — passing things between us

This folder is how we hand things back and forth through GitHub. You work on your Mac, I work here, and GitHub is the bridge. Anything in this folder that you push, I can read; anything I put here, you pull.

There are two directions:

## 📤 `to-test/` — things I put here for you

Before a test, I'll drop a short, plain checklist here: what to run, what to look at, what "good" looks like. You **pull** to get it, then follow it on your Mac.

## 📥 `results/` — things you put here for me

After you run a test, copy the report the tool made (and add any notes) into `results/`, then **commit and push**. I'll read it and tell you what it means and what to fix.

### How to send me a test result

1. Run the tool on your Mac.
2. Find the report it created — it lives in the section's `.sources/` folder (for Step 1 that's `section-readiness.json`).
3. Copy that file into `results/`. Rename it so we can tell them apart, e.g. `transactions-readiness.json`, `balance-readiness.json`.
4. Optional but helpful: add a note next to it (a `.md` file or just text) saying what looked right, what looked wrong, anything surprising.
5. Commit and push.

That's it. No special tools — just copy, commit, push, the same GitHub steps you already use.

## A note on where reports are born

The tool always saves its report **inside the project you're documenting** (next to the pages, in `.sources/`). That's on purpose — the report belongs with the docs. This `results/` folder is just a **copy** you bring over so I can see it, because I can't see your other projects — only this toolkit repo.
