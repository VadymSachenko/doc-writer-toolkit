# Skill harness

Runs a skill headless against a plugin tree, many times, on fresh fixture hosts, and checks the result with mechanical assertions. A change to how a skill behaves runs its cases on `main` (the baseline) and on the change (after), then compares the two. No model judges the output: assertions check files, patterns and paths, and a person reads a blind side-by-side sample.

The harness doesn't ship: it lives outside `plugins/`. It needs the `claude` CLI, signed in, because every run is a real session with a cost. Node built-ins only.

## Run a case

```bash
# Baseline: the plugin as it is on main (a worktree of main, for example)
node tools/harness/run.mjs --tree <main worktree>/plugins/doc-writer-toolkit --label main \
  --case tc-01-translate-single-pair --runs 3 --out /tmp/harness

# After: the tree under review
node tools/harness/run.mjs --tree plugins/doc-writer-toolkit --label after \
  --case tc-01-translate-single-pair --runs 3 --out /tmp/harness

node tools/harness/compare.mjs /tmp/harness main after
node tools/harness/blind.mjs /tmp/harness main after
```

| Command | Does |
|---|---|
| `run.mjs` | Runs each case `--runs` times (default 3) and prints pass counts per assertion and the cost (the CLI's API-price estimate; on a plan, see `/usage` instead). `--resume` continues a pass the guard stopped or a crash ended. `--case` takes ids from `cases/` or paths, comma-separated. `--model` overrides the model, for cheap smoke runs. `--out` defaults to the OS temp folder |
| `rescore.mjs` | Re-checks a pass's saved runs against the cases' current assertions, with no model run, for a case whose assertion turned out to be wrong: `--out <dir> --label <name> --case <id>[,<id>…]`. Rewrites `assertions.json`, `summary.json` and `pass.json`; the cost stays as run |
| `compare.mjs` | One row per case and assertion with both labels' pass counts, and a verdict: `regressed` (passed in every baseline run, fails in some after run), `fixed`, `same: pass`, `same: fail` or `mixed`. Exits 1 when anything regressed |
| `blind.mjs` | For each case, run 1 of each label as `X` or `Y` by a seeded coin flip: `output.md` (the final answer) and `diff.patch`, with labels, sentinel names and run paths masked. The key goes to `<packet>.key.json`, beside the packet |
| `fixture.mjs` | Writes a fixture host by hand, to look at it or try a prompt: `node tools/harness/fixture.mjs <dest> single\|multi [--locales de,pl] [--docusaurus]` |

Keep `--out` outside the repo: run outputs never belong in it.

## Plan limits, and turning the harness off

Every run is a full session on your plan. Measured on one plan: one run of `tc-01` used under 1% of the 5-hour session and under 1% of the week. A smaller plan has smaller limits, so the same run takes a larger share.

- **The guard:** before each run, the runner reads `claude -p /usage`. It stops once the 5-hour session is at 80% or the week at 50%, prints where it stopped, and exits 4. Run the rest later with the same arguments plus `--resume`: finished cases are kept. With an API key, `/usage` shows no plan bars, and the guard stays out of the way.
- **Your own limits:** set them in `tools/harness/local.json`, which git ignores, or in the environment, which wins:

  ```json
  { "maxSessionPercent": 60, "maxWeekPercent": 30 }
  ```

  `HARNESS_MAX_SESSION_PERCENT=60 HARNESS_MAX_WEEK_PERCENT=30 node tools/harness/run.mjs …`
- **Off:** `{ "mode": "off" }` in `local.json`, or `HARNESS_MODE=off`. The runner then makes no run and exits 3, so a script can tell "off" from "failed". The harness's own tests (`harness.test.mjs`) make no model calls and still run, and so does the rest of the regression set.

## What a run does

1. Copies the tree to `<out>/<label>/.plugin/harness-<label>`, with the sentinel name `harness-<label>` in its `plugin.json`.
2. Writes a fresh fixture host to `<out>/<label>/<case>/run-<n>/host/` and runs the case's `setup` commands in it.
3. Runs `claude -p <prompt> --plugin-dir <copy> --output-format stream-json --verbose`, with the installed copy of the plugin switched off through `--settings`. `{plugin}` in the prompt becomes the sentinel name, for prompts that call a command: `/{plugin}:translate-doc …`.
4. Saves `transcript.jsonl`, `result.json` (subtype, turns, cost, seconds, final answer), `status.txt` (`git status --porcelain`), `diff.patch` (new files included) and `assertions.json`.
5. Checks, before the case's own assertions:
   - `sentinel-loaded`: the session's plugins include `harness-<label>@inline`, which proves it read the tree under review;
   - `no-foreign-skill`: no `Skill` call went to another copy of this plugin.

Before the first run, every case loads and every `pattern` compiles, so a broken case exits 2 without spending anything. JavaScript takes no inline flags such as `(?i)`; put them in `flags`.

`<out>/<label>/<case>/summary.json` holds the pass counts and the cost per case, and `<out>/<label>/pass.json` holds the whole pass. `pass.json` is saved after every case, so `--resume` also continues a pass that crashed.

## Fixtures

Both shapes are neutral: a portal and an API, with no real product.

- **`single`:** one root pair, `portal/` (UA) and `i18n/en/docusaurus-plugin-content-docs-portal/current/` (EN). A transactions page with 3 sections and two links, one of them to `/webhooks/webhooks`, which is a wrong prefix in this shape. A settings page with a `NEEDS CONFIRMATION` marker. UI labels in `labels/`, read by a `command` label source.
- **`multi`:** adds an API reference pair, `docs/` and `i18n/en/docusaurus-plugin-content-docs/current/`. Its transactions page has 5 sections, and its EN page misses one. A webhooks page exists in this pair only and holds a `ToDo` marker. There are SME notes, a change brief, an API page, and `docs-archive/`, which shares the `docs` stem but is no root.
- **`locales`:** further locales in `docusaurus.config.ts`, for the locale pipeline.
- **`docusaurus`:** `package.json` and `sidebars.js`, so that `npm install && npx docusaurus build` works. Pair it with a `command` assertion.

The host's `CLAUDE.md` declares the fields of the "Documentation toolkit configuration" section.

## Write a case

One JSON file per case in `cases/`, named after its `id`:

```json
{
  "id": "tc-01-translate-single-pair",
  "description": "What the case shows, in one sentence.",
  "fixture": { "shape": "single", "locales": [], "docusaurus": false },
  "setup": ["git rm -q <path> && git commit -q -m 'Remove the EN page'"],
  "prompt": "use doc-translator to translate `transactions/transactions`",
  "options": { "maxTurns": 40, "permissionMode": "acceptEdits", "allowedTools": ["Bash(git:*)"], "timeoutSeconds": 900 },
  "assertions": [
    { "type": "exists", "path": "i18n/en/docusaurus-plugin-content-docs-portal/current/transactions/transactions.md" }
  ]
}
```

`options` also takes `disallowedTools` and `model`. An assertion can carry a `name`, which is what the reports show.

A `setup` command can run a script of the tree under review: from the host, the copy is `../../../.plugin/harness-<label>/` (steps 1 and 2 of "What a run does"), and the label is the name of the folder `../../..`, so `harness-$(basename "$(cd ../../.. && pwd)")` names the current label's copy. The `document-section` cases (`tc-29*`) build their ledger that way, with `scripts/section-state/`, so the ledger always has the shape the script reads.

A `command` assertion gets no value from the setup. To compare with the state the setup left, write it where `git status` doesn't look, such as `.git/`: the `tc-29*` cases end their setup with `git rev-parse HEAD > .git/harness-setup-head`, and their "no commit made" assertion compares `HEAD` with it.

| Type | Fields | Passes when |
|---|---|---|
| `exists`, `absent` | `path` | the file is there, or isn't |
| `match`, `no-match` | `path` (a file, or `output` for the final answer), `pattern` (a regex), optional `flags` | the text matches, or doesn't |
| `frontmatter` | `path` | the file starts with a closed `---` block of `key: value` lines (nested maps and lists allowed) whose values parse as the strings they show |
| `links` | `path`, `form: "root-relative"` | every Markdown link to a page starts with `/`, with no `.md` and no `./` or `../` |
| `diff-lines` | `path`, optional `allow` (a regex) and `flags` | every line the run removed from the file comes back among its added lines (list numbers aside), whole or with text appended to it, or matches `allow`: nothing outside what the brief names changed |
| `skill-called`, `skill-not-called` | `skill` (its own name, without the plugin prefix) | the run called that skill through the `Skill` tool, or didn't |
| `heading-ids` | `path` (a page, or a folder: every page under it), optional `except` (heading texts) | every heading from `##` down ends with a unique `{/* #id */}` and every `](#id)` link names one, per `heading-anchors.md`; headings listed in `except` may stay without |
| `unchanged` | optional `ignore` (path prefixes) | `git status` shows no change outside `ignore` |
| `changed-only` | `paths` (path prefixes) | every changed path starts with one of them |
| `command` | `run`, optional `timeoutSeconds` | the shell command exits 0 in the host, such as a build |

**A headless skill that has to ask** prints its question and ends. An "asks" case asserts that the output names every candidate (`match` on `output`), and that nothing was written (`unchanged`).

**Before you rely on a case,** run it once with `--runs 1` and read what failed. The first runs of a new case mostly find mistakes in the case itself, such as a file the skill is supposed to touch. When a pass shows a wrong assertion, fix the case and run `rescore.mjs` on that pass instead of running it again; say so wherever the results are reported.

## Tests

```bash
node --test tools/harness/harness.test.mjs
```

The tests cover the fixtures, the assertions, the built-in checks, the summaries, the compare verdicts and the blind-packet helpers. They make no model calls.
