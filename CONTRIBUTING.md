# Contributing to doc-writer-toolkit

This repo is a Claude Code plugin marketplace. The deliverable is the Markdown/JSON content under `plugins/doc-writer-toolkit/` — there is no app to build. A lint, a skill visibility check and the test suites of the two Node scripts run before every merge: see [Checks before a merge](#checks-before-a-merge). See [CLAUDE.md](CLAUDE.md) for a full architectural overview.

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
| `lint` | `node tools/lint-plugin.mjs` | Skill and command frontmatter that strict YAML accepts; every `${CLAUDE_PLUGIN_ROOT}/…` path exists; every style-guide rule file is reachable from its `ROUTING.md` |
| `tools-tests` | `node --test tools/lint-plugin.test.mjs tools/check-visibility.test.mjs tools/harness/harness.test.mjs` | The tools' own tests, including the skill harness (no model calls) |
| `ui-labels`, `locale-sync` | `npm test` in each folder under `plugins/doc-writer-toolkit/scripts/` | The scripts' suites. `locale-sync` takes about two minutes |
| `validate` | `claude plugin validate plugins/doc-writer-toolkit` | The CLI's own plugin checks |
| `visibility` | `node tools/check-visibility.mjs` | Every skill and command loads with its description. It reads a copy under a sentinel name, so an installed copy can't stand in for the tree under review |

The lint prints the gaps listed in `KNOWN_GAPS` (`tools/lint-plugin.mjs`) as `known`, and they don't fail it. When you close one, remove its entry: an entry that no longer occurs fails the lint.

CI (`.github/workflows/check.yml`) runs the same steps on every pull request and every push to `main`. The two CLI steps run in their own job, with the CLI version pinned. Neither needs credentials.

## Validating JSON manifests

```bash
python3 -m json.tool plugins/doc-writer-toolkit/.claude-plugin/plugin.json
python3 -m json.tool .claude-plugin/marketplace.json
```

Both manifests are static — adding skills/commands by directory convention does not require editing them.
