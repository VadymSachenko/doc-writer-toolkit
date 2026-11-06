# Contributing to doc-writer-toolkit

This repo is a Claude Code plugin marketplace. The deliverable is the Markdown/JSON content under `plugins/doc-writer-toolkit/` — there is no app to build. A lint, a skill visibility check, the test suites of the ten Node scripts and the unit tests of the Python script run before every merge: see [Checks before a merge](#checks-before-a-merge). See [CLAUDE.md](CLAUDE.md) for a full architectural overview.

## How to add a skill

1. **Create a directory** under `plugins/doc-writer-toolkit/skills/<kebab-name>/`.
2. **Create `SKILL.md`** in that directory. Every skill must follow the contract described in CLAUDE.md ("Skill file shape"):

   ```
   ---
   name: <kebab-name>
   description: '<one-line trigger spec — what the skill does and why>'
   ---
   
   # <skill-name>
   
   ## Scope
   In scope: …  Out of scope: …  (cross-reference sibling skills to avoid overlap)
   
   ## Sources to load
   Numbered allowlist of files loaded at task start.
   
   ## Workflow
   Numbered steps. Writers include a mandatory interview phase and a self-review checklist.
   
   ## Explicit invocation examples
   Phrasing that should trigger the skill. Mark it explicit-invocation only in the description.
   ```

   The contract is about content, not heading text. Every `SKILL.md` says:
   
   - **its scope**: what is in and out, naming the sibling skills that own the rest;
   - **its sources to load**: a short allowlist of files read at task start, and nothing beyond it unless the user names a file;
   - **its ordered steps**: numbered steps or `Step N` / `Phase N` headings; the three `*-writer` skills start with a mandatory interview;
   - **a self-review** run before any file is saved, in every skill that writes files;
   - **explicit invocation examples**: the phrasing that should trigger it.

   These headings are the shape for a new skill; the lint (check f) accepts the same content under other headings, since some existing skills use them (`## Inputs`, `### Step N`).

   Keep `description` in single quotes, writing a `'` inside it as `''`: an unquoted `: ` is invalid YAML, and the skill then loads with no description. The same goes for a command's `description`.

3. **Mark it explicit-invocation only** in the `description` field if the skill edits files (all authoring/translation/review/fix skills must be). State this clearly: "Use explicitly (…)."
4. **No manifest edit needed** — skills are picked up by directory convention.
5. **Update [SKILLS-INDEX.md](plugins/doc-writer-toolkit/SKILLS-INDEX.md)** — add a row to the Skills table.
6. **Check README.md and WORKFLOW.md** — update any prose that lists or counts skills.

## How to add a command

1. **Create `<kebab-name>.md`** under `plugins/doc-writer-toolkit/commands/`.
2. **Keep it thin.** Commands bind `$ARGUMENTS` to paths and hand off with "strictly follow the skill's workflow." Business logic belongs in the skill.

   Canonical shape:
   ```markdown
   ---
   description: '<one-line description>'
   argument-hint: "<arg format>"
   ---

   Use the `<skill-name>` skill to <do thing>.

   - **<Arg label>:** $ARGUMENTS

   Strictly follow the skill's workflow.
   ```

3. **No manifest edit needed** — commands are picked up by directory convention.
4. **Update [SKILLS-INDEX.md](plugins/doc-writer-toolkit/SKILLS-INDEX.md)** — add a row to the Commands table.
5. **Check README.md and WORKFLOW.md** — update any prose that lists or counts commands.

## When you rename or remove a skill or command

- Update or remove the row in [SKILLS-INDEX.md](plugins/doc-writer-toolkit/SKILLS-INDEX.md).
- Search README.md, WORKFLOW.md, and CLAUDE.md for the old name and update references.
- Search all other SKILL.md files for cross-references to the old name (the Scope sections name sibling skills); update them.

## Update checklist (copy when adding/renaming/removing)

```
- [ ] SKILL.md or command .md created / updated / removed
- [ ] SKILLS-INDEX.md row added / updated / removed
- [ ] README.md — skills/commands prose updated if the change affects the public summary
- [ ] WORKFLOW.md — quick reference tables updated; Gaps section updated if a gap was closed
- [ ] Sibling SKILL.md files — Scope cross-references updated if the name changed
- [ ] No product content added to the plugin: product terms, facts and rules belong in the host's product kit (`context/project-paths.md`, "Product kit")
- [ ] CLAUDE.md — architecture section updated if the change affects the documented seam
```

## Checks before a merge

A merge to `main` is a release: hosts with auto-update follow `main`. Run the regression set from the repo root before you open a PR, and again on its last commit:

```bash
node tools/regression.mjs
```

It prints one row per step, with the exit code and the result line. A step whose tool is missing shows `not run` and fails the run; `--allow-not-run` accepts that. `--out <dir>` keeps each step's full output, and `--skip <step,...>` leaves steps out.

| Step | Command | Checks |
|---|---|---|
| `lint` | `node tools/lint-plugin.mjs` | Skill and command frontmatter that strict YAML accepts; every `${CLAUDE_PLUGIN_ROOT}/…` path exists; every style-guide rule file is reachable from its `ROUTING.md`; no file has CRLF line endings; every skill carries the contract's five parts; every screenshot-annotation frame in a snippet is square and unfilled |
| `tools-tests` | `node --test tools/lint-plugin.test.mjs tools/check-visibility.test.mjs tools/harness/harness.test.mjs` | The tools' own tests, including the skill harness (no model calls) |
| `ui-labels`, `locale-sync`, `doc-align`, `screenshot-locales`, `section-state`, `pipeline-measures`, `tracker`, `forge`, `ticket-state`, `video-parts` | `npm test` in each folder under `plugins/doc-writer-toolkit/scripts/` | The scripts' suites. `locale-sync` takes about two minutes; `video-parts` cuts a real tiny video only where `ffmpeg` is installed |
| `visual-pack` | `npm test` in `plugins/doc-writer-toolkit/scripts/visual-pack/` | The offline tests, then the browser test: a fixture site with a broken image and a wide table, and the proof that the script calls no model and asks nothing but its local server. The browser test needs Playwright with Chromium, which this repo does not install: see "Running the browser test" below. Without it the step shows `not run` and fails the run, with the reason in the output |
| `sme-video-context` | `python3 plugins/doc-writer-toolkit/scripts/sme-video-context/tests/run.py` | The Python script's unit tests (standard-library `unittest`, offline). Locally the step runs on the skill's venv, `~/.cache/doc-writer-toolkit/sme-video-venv`, if it exists, else on `python3`; a missing `Pillow` or `ImageHash` shows as `not run` and fails the run, with the install steps in the output. CI installs only `tests/requirements.txt` |
| `validate` | `claude plugin validate plugins/doc-writer-toolkit` | The CLI's own plugin checks |
| `visibility` | `node tools/check-visibility.mjs` | Every skill and command loads with its description. It reads a copy under a sentinel name, so an installed copy can't stand in for the tree under review |

The lint prints the gaps listed in `KNOWN_GAPS` (`tools/lint-plugin.mjs`) as `known`, and they don't fail it. When you close one, remove its entry: an entry that no longer occurs fails the lint.

CI (`.github/workflows/check.yml`) runs the same steps on every pull request and every push to `main`. The two CLI steps run in their own job, with the CLI version pinned. The `sme-video-context` tests run in a job of their own too, on Python 3.9 with only the packages in `tests/requirements.txt` installed. The `visual-pack` browser test runs in a job of its own too, which installs Playwright and Chromium; the matrix job runs its offline tests only. None needs credentials.

### Running the browser test

The `visual-pack` browser test loads Playwright from a folder you name, so this repo has no `node_modules` of its own for it. Point `VISUAL_PACK_PLAYWRIGHT_FROM` at any folder whose `node_modules` has `playwright` (or `@playwright/test`) with Chromium installed. A docs repo you already use for screenshots has both, and it is only read:

```bash
export VISUAL_PACK_PLAYWRIGHT_FROM=/path/to/a/docs/repo      # your shell profile is a good place
node tools/regression.mjs                                    # or: npm test in scripts/visual-pack/
```

Or install Playwright once into a scratch folder and use that:

```bash
npm install --prefix ~/.cache/doc-writer-toolkit/playwright playwright
npx --prefix ~/.cache/doc-writer-toolkit/playwright playwright install chromium
export VISUAL_PACK_PLAYWRIGHT_FROM=~/.cache/doc-writer-toolkit/playwright
```

Don't write a path to your own checkout into a tracked file. Without the variable the offline tests still run and the step reads `not run`.

## Line endings

Every text file is LF, set by `.gitattributes`, and the lint fails on CRLF. The commit that converted the repo is listed in `.git-blame-ignore-revs`. GitHub skips it in blame by itself; to skip it locally, run this once:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

## Validating JSON manifests

```bash
python3 -m json.tool plugins/doc-writer-toolkit/.claude-plugin/plugin.json
python3 -m json.tool .claude-plugin/marketplace.json
```

Both manifests are static — adding skills/commands by directory convention does not require editing them. Don't add a `version` to either: without one, an install tracks this repository's commits, and a pinned version would hold installs back until someone bumps it.
