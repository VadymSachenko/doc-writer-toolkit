# Contributing to doc-writer-toolkit

This repo is a Claude Code plugin marketplace. The deliverable is the Markdown/JSON content under `plugins/doc-writer-toolkit/` — there is no app to build. Before you push, run the plugin lint and the tests (see [Validating](#validating)); CI runs the same checks on every pull request. See [CLAUDE.md](CLAUDE.md) for a full architectural overview.

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

   Wrap the `description` value in single quotes and write an apostrophe inside it as `''`. An unquoted value that contains `: ` (an invocation example such as `"skill-name: do X"` is enough) is invalid YAML, and Claude Code then loads the skill without a description, so the model never offers it. The same rule applies to command frontmatter.

   **Note on the contract:** the four headings above are the target shape for new skills. Several existing skills (read-only diagnostics, SME-video helpers, reviewer/fixer skills) use equivalent content under other headings, for example a procedure or checks section instead of `## Workflow`, or scope stated in the opening paragraph. A skill meets the contract when a reader can find its scope, its allowlist of loaded files and its ordered steps; the exact heading text is not enforced.

3. **Mark it explicit-invocation only** in the `description` field — every skill in this plugin is. State this clearly: "Use explicitly (…)." A command or skill that hands off to it by name counts as explicit; say so in its "Explicit invocation examples" section if one does.
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
- [ ] `node tools/lint-plugin.mjs` passes
```

## Validating

```bash
node tools/lint-plugin.mjs              # frontmatter YAML, ${CLAUDE_PLUGIN_ROOT} paths, router coverage, line endings
node --test tools/lint-plugin.test.mjs  # the lint's own tests
claude plugin validate .                # marketplace and plugin manifests
(cd plugins/doc-writer-toolkit/scripts/ui-labels && npm test)
(cd plugins/doc-writer-toolkit/scripts/locale-sync && npm test)   # about two minutes
```

CI (`.github/workflows/check.yml`) runs the lint, its tests and both script suites on every push to `main` and every pull request, on Node 18 and the current LTS. The lint needs no dependencies; when it reports a style-guide rule file that no `ROUTING.md` row reaches, add a row for it (or, for an index or meta file, an allowlist entry in `tools/lint-plugin.mjs`).

Both manifests are static — adding skills/commands by directory convention does not require editing them.

Don't add a `version` field to either manifest. Claude Code keeps every install on a pinned version until the string changes, so installs would stop receiving new commits; without it, an install's version is the commit SHA. Record notable changes in [CHANGELOG.md](CHANGELOG.md) instead.
