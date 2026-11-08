# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

This is the **source repository for a Claude Code plugin marketplace** (`doc-writer-toolkit`), not a documentation site itself. It contains skills, slash commands, and content-rule corpora that get installed into *other* Docusaurus documentation projects (currently a single host project). There is no app to build — the deliverable is the Markdown/JSON content under `plugins/doc-writer-toolkit/`, consumed by Claude Code at runtime in a different repo. The checks (a lint, a skill visibility check and the tests of the two Node scripts behind the locale translation pipeline, the one behind the alignment check, the one behind multilocale screenshots, the one behind the section ledger, the one behind the pipeline measures, the one behind the tracker, the one behind the forge, the one behind the ticket ledger and its daily run and the one that cuts a ticket's video into parts, and the unit tests of the Python script behind the SME video pipeline) run with one command (see Commands).

Because of this, most SKILL.md files reference paths like `docs/`, `portal/`, `i18n/en/...`, and `CLAUDE.md` that **do not exist in this repo** — they refer to the target project where the plugin is installed. Do not go looking for those paths here; they're part of the runtime contract the skills expect the host project to satisfy.

## Repository structure

```
.claude-plugin/marketplace.json          # marketplace manifest (lists the plugin(s) below)
tools/                                   # repo checks, not shipped: lint, skill visibility check, regression runner
.github/workflows/check.yml              # CI: runs the checks on pull requests and pushes to main
plugins/doc-writer-toolkit/
  .claude-plugin/plugin.json             # plugin manifest (name/description/author)
  skills/<name>/SKILL.md                 # one skill per directory
  commands/<name>.md                     # slash-command wrappers around skills
  context/doc-rules/                     # UA grammar, project rules, the glossary format
  context/starter-kit/                   # skeletons for a host's product kit: glossaries, product facts, product rules
  context/doc-templates/                 # page templates (API reference, user guide, concept topic)
  context/locale-translation.md          # rules for translating into the further (non-EN) locales
  context/ui-labels.md                   # the UI label check procedure every docs task starts with
  context/changed-blocks.md              # what "the changed part of a page" means (scope mode, sync, locale-sync)
  context/section-state.md               # the document-section ledger: fields, done and stale rules, gates
  context/ticket-flow.md                 # the ticket flow: statuses, ticket states, the next-step rule, the ticket ledger, locks, limits
  context/ticket-roles/                  # the role prompts the ticket runner hands to `claude -p` (triage, writer, reviewer, translator, unattended rules)
  context/google-developer-style-guide/  # distilled GDSG corpus (routed loading)
  context/microsoft-style-guide/         # distilled MSSG corpus, EN + UA localization (routed loading)
  scripts/ui-labels/                     # Node, no deps: UI label store, label check, rename sync (README + tests)
  scripts/locale-sync/                   # Node, no deps: stale detection, changed blocks, checks, state (README + tests)
  scripts/doc-align/                     # Node, no deps: UA/EN structural counts, heading ids and names-table check for doc-alignment-checker (README + tests)
  scripts/screenshot-locales/            # Node, no deps: screenshot locales, per-locale paths, staging, all-or-nothing promotion (README + tests)
  scripts/section-state/                 # Node, no deps: the document-section ledger, status and record (README + tests)
  scripts/pipeline-measures/             # Node, no deps: read-only measures of a docs pipeline from git, gh and the tracker (README + tests)
  scripts/tracker/                       # Node, no deps: the ticket tracker in statuses and transitions, a Trello adapter behind an interface (README + tests)
  scripts/forge/                         # Node, no deps: the forge (PRs, review comments, labels, the event feed) over gh, a GitHub adapter behind an interface (README + tests)
  scripts/ticket-state/                  # Node, no deps: the ticket ledger, the next-step rule, the limits and the daily runner (README + tests)
  scripts/video-parts/                   # Node, no deps: a ticket's video cut into sound parts for transcription, ffmpeg by fixed arguments (README + tests)
  scripts/visual-pack/                   # Node, no deps: one review sheet of the changed pages in every locale, captured with the host's Playwright (README + tests)
  scripts/sme-video-context/             # standalone Python tool, not auto-loaded; unittest tests in tests/ (README)
```

Two manifests gate everything: `marketplace.json` points at `./plugins/doc-writer-toolkit` as a plugin source, and that plugin's own `plugin.json` is what Claude Code reads once installed. If you add a new skill or command directory, no manifest edit is needed — both commands and skills are picked up by directory convention. Neither manifest has a `version`, on purpose: an install tracks this repository's commits. Don't add one.

## Commands used when developing this repo

There's no build. What you'll actually run:

- **Run the regression set before a merge:** `node tools/regression.mjs` from the repo root runs the lint, the tools' tests, the eleven Node script suites, the Python script's tests, `claude plugin validate` and the skill visibility check, and prints one row per step. CI runs the same on every pull request. See CONTRIBUTING.md, "Checks before a merge".
- **Validate a manifest edit:** `python3 -m json.tool plugins/doc-writer-toolkit/.claude-plugin/plugin.json` (or `.claude-plugin/marketplace.json`) — just a JSON syntax check.
- **Try a skill/command end-to-end:** it must be exercised from a *different* repo that has this plugin installed (see README's "Install into a project" section) or from a local checkout added via `extraKnownMarketplaces` pointing at a local path. There is no in-repo harness for running a skill.
- **Test the Node scripts:** `npm test` in `plugins/doc-writer-toolkit/scripts/ui-labels/`, `.../scripts/locale-sync/`, `.../scripts/doc-align/` `.../scripts/screenshot-locales/`, `.../scripts/section-state/`, `.../scripts/pipeline-measures/`, `.../scripts/tracker/`, `.../scripts/forge/`, `.../scripts/ticket-state/` and `.../scripts/video-parts/`. Offline (throwaway git repos and the `command` label adapter; `doc-align` uses inline fixtures, `screenshot-locales` throwaway folders, `pipeline-measures` a throwaway repo with hand-made `gh` and Trello JSON, `tracker` a stand-in Trello server on `127.0.0.1` with invented responses, `forge` a stand-in `gh` that replays invented answers, `ticket-state` in-memory tracker and forge adapters under the real modules, throwaway repos and a stand-in `claude`, `video-parts` a recording fake and stand-in `ffprobe` and `ffmpeg`, plus four tests on real files, a video, a silent video, a playlist and a file list, and sound in other containers, only where `ffmpeg` is installed, as in CI); the `locale-sync` suite takes about two minutes. Keep each script's `README.md` in step with its flags and output fields, and add a test with every behaviour change.
- **Test `visual-pack`:** `npm test` in `plugins/doc-writer-toolkit/scripts/visual-pack/` runs the offline tests, then the browser test if `VISUAL_PACK_PLAYWRIGHT_FROM` names a folder whose `node_modules` has Playwright with Chromium installed. Without it the run exits 2 (`not run`) after the offline tests passed. `npm run test:offline` runs the offline tests alone. See CONTRIBUTING.md, "Running the browser test".
- **Test the Python script:** `python3 plugins/doc-writer-toolkit/scripts/sme-video-context/tests/run.py`, with the skill's venv (`~/.cache/doc-writer-toolkit/sme-video-venv/bin/python`) or any Python that has the two packages in `tests/requirements.txt`. Standard-library `unittest`, offline: no `ffmpeg`, `tesseract`, network or `faster-whisper`. Exit code 2 means a package is missing. Add a test with every behaviour change.
- **`scripts/sme-video-context/sme_video_context.py`:** the Python tool. Setup and run commands are documented in `plugins/doc-writer-toolkit/scripts/sme-video-context/README.md` (needs system `ffmpeg`/`tesseract` plus a Python venv) — follow that file rather than duplicating the steps here, since the `extract-sme-screenshots` skill's own instructions are the current source of truth for how it's actually invoked.

## Architecture

### Generic vs. product-specific seam

Skill *logic* and the plugin's content are generic and reusable for any Docusaurus doc project. Product content lives in the host, not here. Each host keeps a *product kit*: a folder in its own repo, outside every content root (`doc-kit/`), declared as `Product kit:` in its `CLAUDE.md`. It has fixed file names: `glossary-ua.md`, `glossary-en.md`, `product-facts.md`, `product-rules.md` and, optionally, `templates/` and a human-facing bilingual `glossary.md` that no skill loads. The glossaries and `product-rules.md` are rank 0, like `formatting-conventions.md`; `product-facts.md` is background.

- `context/project-paths.md` ("Product kit") is the single source of truth for finding the kit. No kit declared: the run goes on with no glossary, product facts or product rules, and says so. A declared folder that doesn't exist: the run stops and names the path, writing nothing.
- The plugin ships only neutral skeletons in `context/starter-kit/`, which skills name but never copy, and `context/doc-rules/glossary-format.md`, the generic contract for reading a glossary table that `formatting-conventions.md` Ж1, Ж3 and Ж4 rely on.
- `context/doc-templates/` stays in the plugin, with neutral examples, because skill bodies refer to its structure. A host overrides a template with a file of the same name in `<kit>/templates/`.
- `context/doc-rules/doc-examples/` is not product-specific: its worked examples are unrelated third-party content, kept as a prose voice and density reference.

Keep new product content out of the plugin: a product term, fact or rule belongs in the host's kit. Some skill bodies still carry product rules (a term table, the assumed reader); moving them into the kit's `product-rules.md` is the next step.

### Skill file shape

Frontmatter `name` + `description` — the description doubles as the trigger spec. All authoring/translation/review skills are **explicit-invocation only** (they say so in their own description and end with explicit invocation examples) — they must never fire on an implicit request. Preserve that if you touch the description.

The contract is about content, not heading text. Every `SKILL.md` says:

- **its scope**: what is in and out, naming the sibling skills that own the rest;
- **its sources to load**: a short allowlist of files read at task start, and nothing beyond it unless the user names a file;
- **its ordered steps**: numbered steps or `Step N` / `Phase N` headings; the three `*-writer` skills start with a mandatory interview;
- **a self-review** run before any file is saved, in every skill that writes files;
- **explicit invocation examples**: the phrasing that should trigger it.

The headings shown in CONTRIBUTING.md are the shape for a new skill; an existing skill may keep the same content under other headings (style review vs. UA/EN structural alignment, for example, are deliberately separate skills, each with its own scope). The lint's check f (`tools/lint-plugin.mjs`) checks the five parts; a gap that exists today is listed there with its reason.

Commands in `commands/*.md` are thin: they bind `$ARGUMENTS` to concrete paths and hand off with "strictly follow the skill's workflow" — business logic belongs in the skill, not the command.

### Style-guide corpora use signal-driven routed loading, never bulk loading

`context/google-developer-style-guide/` and `context/microsoft-style-guide/` are large distilled corpora (121 and 168 files). Every consumer (`doc-style-reviewer`, and the loading sections of `api-doc-writer`/`doc-translator`) is required to read that corpus's own `ROUTING.md` (or, for UA grammar, `context/doc-rules/ua-grammar/INDEX.md`) first, map document signals to the routing table, and load only the matched topic files — the routing files themselves explicitly forbid loading the full manifest, terminology index, or word index wholesale. If you add rules to these corpora, add a routing-table row rather than expecting consumers to discover the file unaided, and never hand-copy corpus rules into a skill file — skills reference the corpus so it stays the single source of truth.

`doc-style-reviewer` is the one skill with four selectable modes (`gdsg`, `mssg-en`, `mssg-ua`, `ua-grammar`) chosen via a `guide:` argument; each mode reads a different combination of the two corpora plus `ua-grammar/`.

### Style pass (`doc-style-pass`, `/style-pass`)

The pass for the person who approves a page, UA or EN. It runs `doc-style-reviewer`, then `doc-style-fixer` with `apply:mechanical,substantive` (no logic of its own about findings or buckets), and builds one numbered «before» → «after» list from the page's diff against a snapshot, with the bucket 3 questions after it. The user answers with the numbers to undo; each undone item gets its exact «before» back. Every decision goes into the host's `<state root>/style-decisions.jsonl`, and a rule rejected in three passes with no acceptance in between (several rejections in one pass count once) is proposed once as one line for the kit's `product-rules.md`, which the reviewer loads as rank 0. The snapshot and the pass record live in `<state root>/.run/style-pass/`, never committed. `/review-doc-style` and `/fix-doc-style` are unchanged.

### Content paths — and the style guide — are project-declared, not hardcoded

No skill hardcodes a UA content root, an EN i18n root, a URL prefix, or a style-guide name. Every skill that reads/writes doc files by path (`doc-translator`, `doc-alignment-checker`, `concept-doc-writer`, `user-guide-writer`, `api-doc-writer`) or that consults a style guide while drafting resolves both from the *host* project's own `CLAUDE.md`, under a "Documentation toolkit configuration" section:

```md
## Documentation toolkit configuration

- **Style guide:** `gdsg`
- **UA content root:** `docs/`
- **EN i18n root:** `i18n/en/docusaurus-plugin-content-docs/current/`
- **UA URL prefix:** `/`
- **Product kit:** `doc-kit/`
```

- `context/project-paths.md` is the single source of truth for the path-resolution procedure (and the ask-once, offer-to-persist fallback when a project hasn't declared these fields yet).
- `project-paths.md` also resolves which root pair a page belongs to, for hosts that declare more than one; skills point at it.
- `context/style-guide-registry.md` is the equivalent for the style-guide token, plus the corpus/router each token maps to.

Host projects are free to differ in shape here, and none of that difference lives in a skill file: some split content into two separate Docusaurus plugin instances with two i18n output paths (e.g. `portal/` alongside a default-id `docs/`), each a root pair; others use a single tree. A skill never assumes which — it reads the declaration.

Across any project's tree(s), unresolved content is marked with `{/* ToDo: ... */}` and `{/* NEEDS CONFIRMATION: ... */}` HTML comments — every writing/translation/alignment skill knows to preserve, carry over, or check for these markers rather than resolving them silently.

### SME video pipeline

Three skills form a linear pipeline turning a raw meeting recording into doc-ready material, each independent and re-invocable on its own:

1. `extract-sme-screenshots` — shells out to `scripts/sme-video-context/sme_video_context.py` (system deps: `ffmpeg`, `tesseract`; a persistent Python venv at `~/.cache/doc-writer-toolkit/sme-video-venv`), keeps only `images/` (+ transcript if freshly generated), discards the rest of the script's output package.
2. `convert-sme-input` — turns the transcript/notes into a structured `.sources/sme-interview.md`.
3. `cleanup-unused-screenshots` — after a doc is written referencing only some screenshots, moves the rest into `_unused/` (never deletes).

All three operate on `.sources/` and `.assets/` folders that live *inside the host project*, next to the doc page being worked on — not inside this repo.

### Icon-only controls (Ж8 + `identify-ui-icon`)

A control with no text is split along two halves. The rule — how a step names the control and shows its icon — is Ж8 in `context/doc-rules/project-rules/formatting-conventions.md`, which every writer, the updater, the translator and the reviewer already load; no skill restates it. The name comes only from evidence (a tooltip or `aria-label` that `app-explorer` records); without one, Ж8 prescribes a description plus a `NEEDS CONFIRMATION` marker. The lookup — glyph → Iconify id, SVG or screenshot crop — is the on-demand `identify-ui-icon` skill (`/identify-icon`), which the writers call by name only when a step hits such a control. The host picks the render with `Icon rendering:` (`iconify-component`, `iconify-svg`, `screenshot-crop` (default), `describe`), registered in `context/project-paths.md`.

### Section-authoring pipeline (v1 orchestration skills)

Four skills move a whole menu *section* (not just one page) toward publish-ready. Each is invocable on its own and each has a thin command wrapper:

1. `section-readiness` (`/check-section-readiness`) — inventories a section folder, classifies it `skeleton` / `needs-revision` / `greenfield`, and emits a machine-readable `section-readiness.json` verdict.
2. `app-explorer` — explores the live app (navigation + API-seeded state) and writes `.sources/app-notes.md` evidence. The concrete driving tool (Playwright/collection-runner) is not yet wired — see the host project's `CLAUDE.md` config.
3. `section-planner` (`/plan-section`) — reads the folder + app notes and proposes an IA structure (keep/merge/split/add), gated on human approval before anything is written.
4. `resolve-markers` — batch-answers `{/* NEEDS CONFIRMATION */}` markers from app/interview evidence.

`/explore-and-resolve` chains `app-explorer` → `resolve-markers`.

`document-section` (`/document-section`) chains the whole section: readiness → explore → plan → (gate G1, the plan) → write each page → resolve markers → fix → review (two rounds at most) → (gate G5, UA approval, then the user's commit) → EN translation → alignment. Business logic is in the skill; the command is thin. It keeps a ledger in `<section>/.sources/section-state.json`, meant to be committed in the host repo, through `scripts/section-state/` (no AI): `status` checks the ledger against git blob hashes of the files and derives what is stale, what runs next and which gate is open; `record` writes one stage result, and only when the files support it. The files win over the ledger. `context/section-state.md` holds the ledger's fields and its done and stale rules. The plan gate is never pre-approvable; the writers' interview and the fixer's bucket 2 choices stay with those skills (`interview:skip` and `apply:mechanical,substantive` pass on their existing rules). Further locales, screenshot cleanup, updating a complete page and API reference pages (`api-doc-writer` saves to the API reference root and writes English only) are not in the chain: the final report lists or suggests them.

### Screenshot locales

A host that needs screenshots in more than one UI language declares `Screenshot locales:` (separate from `Content language:`) and `Locale switch:`. Every Playwright consumer (`app-explorer`, `resolve-markers`, and the writers through them) then follows one contract, `context/doc-rules/project-rules/screenshot-locales.md`: one scenario per page or section, one capture per locale into a staging folder, and `scripts/screenshot-locales/` (no AI) to derive each locale's `.assets/` path from the root pairs and `docusaurus.config`, keep the per-section ledger (`.sources/screenshot-manifest.json`), and move a set into the docs only when every locale is there. `screenshot-capture.md` stays the one-shot, one-locale mechanic. A host without the declaration runs no new step: it captures once, into the `.assets/` the consuming skill names, as before. Further locales that aren't screenshot locales keep their `locale-sync link-assets` links to the EN images.

### Visual review pack (`scripts/visual-pack/`)

`visual-pack --range <range>` (no AI) finds the docs pages a git range changed, builds the host's site (or takes `--build-dir`), serves it on `127.0.0.1`, opens each page in each locale with the *host's own* Playwright (it has no dependency of its own; `--playwright-from` or `VISUAL_PACK_PLAYWRIGHT_FROM` says where) and writes one HTML sheet under the toolkit state root: pages in rows, locales in columns, the automatic findings on top (broken images, tables wider than the page, text left untranslated). Every request that isn't to the local server is blocked and counted. The model reads only the short summary on stdout. The script's README has the rules.

### Ticket tracker (`scripts/tracker/`)

`tracker <command>` (no AI) is the one place a pipeline talks to the host's ticket tracker, in statuses and transitions: list the cards in a status (with each card's last activity time), read a card, find a card by number or link (archived too), follow the board's actions since a time, download an attachment, comment, move, add and remove labels, set a description, create a card in the intake status. The host's ticket flow settings file (`Ticket flow settings:`, `.claude/ticket-flow.json`; a `.local.json` beside it overrides it) maps each status to lists by name, resolved on every run, and names the transitions, the `neverRead` statuses and the environment variables that hold the credentials. `lib/tracker.mjs` holds every rule (`move` only along a listed transition, never listing a `neverRead` status, `create-card` only in `intake`, no empty comment or description, idempotent writes); `adapters/trello/` is the only code that knows Trello, behind the interface in `lib/adapter-contract.mjs`, so a Jira adapter is a new folder and one registry line. There is no operation to archive, delete or rename a card. The watcher keeps the cursor of the event feed, not the module. Product data (board, list and label names or ids) lives in the host's settings, never here; the tests use invented ids.

### Forge (`scripts/forge/`)

`forge <command>` (no AI) is the one place a pipeline talks to the host's pull requests, over the `gh` CLI (`gh api`, REST and GraphQL): open a PR (the open PR of the same head is returned, a second head in a repo is a second PR), edit its description, read its state with the head and merge commits, its reviews and review threads, the repository's PR event feed and the PRs changed since a time, ask for a review, comment on lines as one review (a line outside the diff is refused first: GitHub rejects the whole review), reply in a thread, post a suggested change, comment, and set labels. It reads the same ticket flow settings file as `tracker` (the `forge` object and the `targets`) and works only on the repos, logins and labels they name: it adds only the targets' stage labels and the check label, removes only stage labels, and so can never set the owner's merge-ready label. `setStageLabel` swaps a PR's stage label in one request, whoever moved the card. `lib/forge.mjs` holds every rule; `adapters/github/` is the only code that knows GitHub, behind the interface in `lib/adapter-contract.mjs`, so a GitLab adapter is a new folder and one registry line. There is no operation to settle a conversation, withdraw a review, give a verdict, join a branch, close a PR or delete a branch, and tests and a grep show it. Every write returns the ids it posted. The watcher keeps the cursor, not the module. Product data lives in the host's settings, never here; the tests use invented names.


### Ticket flow (`scripts/ticket-state/`, `ticket-flow`)

`ticket-state <command>` (no AI) keeps one ledger per docs ticket in the host's git-ignored state folder (`<state>/tickets/<key>.json`) and derives, from the tracker and forge modules (used as libraries), the target repos and the files, each ticket's state, its next step and its open gate: `status` writes nothing; `record` writes one stage result only when the world supports it, and names the reason when it refuses; `handover` gives a ticket to the pipeline (a lost ledger is rebuilt as `mode: hand` first); `lock`/`unlock` are the per-group leases; `config` prints the merged settings (the shared `.claude/ticket-flow.json` and the owner's `.local.json`, deep-merged). The rule, the states and the ledger's fields are `context/ticket-flow.md`. Each PR of a ticket moves on its own (rows 8 to 12 per PR; the card stands where the least advanced PR is). The limits count only tickets a scheduled run started: 3 in progress, 5 waiting, and a group starts only if its estimated cost fits the day's allowance from `claude -p /usage`; high priority first, the oldest within a level. A UA change that only adds heading ids and rewrites links to them keeps every approval and chain stage (`doc-align/lib/idonly.mjs`, defined in the script's README). When every PR is merged, the close step moves the ticket's recorded work files to the Trash (`cleanup.keep`, `cleanup.mode`), never a tracked, unrecorded or kept path.

`runner.mjs` runs the day: finishing first, then the morning triage, then starts within the limits; each step with a role is one `claude -p --agents <file> --agent ticket-<role>` session with the role's model and effort from the settings, the prompts in `context/ticket-roles/` (no compound shell calls: files with the Write tool, one command per call), a PreToolUse hook (`role-hook.mjs`) that reads each command as a shell would and refuses what the role doesn't run, fail closed, and tool rules read only from the tracked settings file at HEAD; one retry with the next model up, and the report `<state>/reports/<date>.md` written with no model call. A failed step runs again only after a person acts on the ticket, after `ticket-state set retry <key>`, or once at the next morning run; two failed sessions with no person's action between them hold the ticket for the owner, and so does a stage's daily session cap (`limits.sessionsPerStageDay`). `--dry-run` plans and changes nothing; `mode: observe` plans and writes only the report. The `ticket-flow` skill is the manual entry point over it. `watcher.mjs`, started every few minutes by a LaunchAgent (`launchd.mjs`), reads what changed on the boards and the PRs and has the runner finish the tickets that changed, starts the morning run once a day and the host's jobs (`hostJobs`); an error in one part of a check is reported and the rest goes on. The stages' own work is not here. Product data lives in the host's settings, never here; the tests use invented ids.
The writer's `videoGate` stage cuts a ticket's video with `scripts/video-parts/` (no AI): `ffprobe` and `ffmpeg` by fixed arguments through `execFile`, the host root the folder it runs in, the video and its parts kept inside the ticket's work folder, plain video and sound containers only (no playlist or file list, which would name files outside it), the sound in parts of at most `video.partMinutes`, and the `videos[]` entry of the record printed as it is. A role session runs it by its path (it is in the runner's `NODE_SCRIPTS`) and never runs `ffmpeg` or `ffprobe` itself: both are denied to every role.

### Locale translation pipeline (`locale-translator`, `/translate-locales`)

Translates a host repo's approved UA pages into every further locale its `docusaurus.config` declares (all except the default and `en`) with no human review, so correctness comes from mechanisms. Three layers, each with a single job:

- `scripts/ui-labels/` (no AI) imports the app's own dictionaries into a label store in the host repo (`<state root>/ui-labels/`, default `.doc-toolkit/`), checks whether the app's UI text changed, and patches renamed labels in UA, EN and every locale on the current branch. `context/ui-labels.md` is the procedure; `doc-page-updater` and the three `*-writer` skills run it at the start of a docs task, `locale-translator` at the start of every run.
- `scripts/locale-sync/` (no AI) does everything that needs no model: stale detection by git blob hashes against per-page state files, the exact changed UA blocks, the binding of bold spans to app strings, per-locale term memory, splicing translated blocks back, screenshot symlinks to the EN images, the scripted checks, and `record`, which advances a page's state only when its checks pass. Sidebar category labels (`_category_.json`) are units like pages, translated into each locale's `current.json`. `stray` lists files a run left outside its roots; `status` warns about untranslated category labels in `current.json` that no `_category_.json` owns.
- `skills/locale-translator/SKILL.md` orchestrates: label check → status (confirmation above 10 pages) → binding pass → terminology pass → one worker per locale in parallel (`worker.md`, rules in `context/locale-translation.md`) → settling what the workers flagged → build and per-page report. It never commits; corrections after a run are redone block by block.

Rules that hold across all three: the user answers for UA and EN only, so nothing about a further locale's wording is asked (the run decides by T1, then term memory, then its own choice recorded in term memory, T6, and reports for information); the UA page is the only source (the EN page is never read — `doc-translator` owns UA → EN and is independent); the app's string always wins over a translation of it (T1); a page that fails its checks is not recorded; nothing is deleted or moved (orphans, moved pages, strays are reported). Host config lives in `context/project-paths.md` under "Label store and locale translation" (`App:`, `UI label source:`, `Locale files:`, `Locale register:`, `Translation scope:`, `Toolkit state root:`); target locales are never declared there, only read from `docusaurus.config`. Product-specific data (label snapshots, term memory) lives in the host repo, not here.

### Templates and the `en` path

All five templates in `context/doc-templates/` are live — none are dead code. The `ua-`-prefixed templates load when a project's resolved content language is `uk`; the EN-named twins load when it is `en`:

- `user-guide-writer` loads `ua-user-guide-template.md` (`uk`) or `user-guide-template.md` (`en`).
- `concept-doc-writer` loads `ua-concept-topic-template.md` (`uk`) or `concept-topic-template.md` (`en`).
- `api-doc-writer` loads `api-reference-template.md` (language-agnostic).

A host may override any of them with a file of the same name in its product kit's `templates/` (`context/project-paths.md`, "Product kit"). The plugin's templates keep neutral examples.

Do **not** delete the EN-named templates. Known gap: they are thinner than their `ua-` twins (the skill bodies encode far more UA-specific structure), so `en` output is currently under-supported — treat that as a parity gap to close, not as evidence the files are unused. Always check what a skill actually loads before editing a template.
