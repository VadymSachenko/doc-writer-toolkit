# TW Workflow Map

The documentation process stages mapped to the toolkit's skills. Use it to decide which skill to invoke next, and to spot the stages that are still manual.

---

```mermaid
flowchart TD
    START([Choose a section to document\ne.g. Transactions]) --> STRUCT

    subgraph PLAN["1 · PLAN"]
        STRUCT[Check folder structure\nvalidate file list vs. app menu]
        STRUCT --> FILETYPE{What's needed?}
        FILETYPE -->|Background / how it works| CONCEPT_NEEDED[Concept topic needed]
        FILETYPE -->|Step-by-step task| GUIDE_NEEDED[User guide needed]
        FILETYPE -->|Endpoint reference| API_NEEDED[API doc needed]
    end

    subgraph EXPLORE["2 · EXPLORE APP"]
        CONCEPT_NEEDED & GUIDE_NEEDED & API_NEEDED --> APPEXP[Explore app\nreproduce steps\nread existing user/API docs]
        APPEXP --> SCREENS[Take screenshots\nnote steps and edge cases]
    end

    subgraph DRAFT["3 · DRAFT"]
        SCREENS --> WRITE_C[concept-doc-writer]
        SCREENS --> WRITE_G[user-guide-writer]
        SCREENS --> WRITE_A[api-doc-writer]
    end

    subgraph REVIEW["4 · REVIEW"]
        WRITE_C & WRITE_G & WRITE_A --> STYLE_R[doc-style-reviewer\nguide: gdsg / mssg-ua]
        STYLE_R --> STYLE_F[doc-style-fixer]
    end

    subgraph LOCALIZE["5 · LOCALIZE"]
        STYLE_F --> TRANSLATE[doc-translator\nUA → EN]
        TRANSLATE --> ALIGN[doc-alignment-checker\nUA ↔ EN structural check]
    end

    subgraph PUBLISH["6 · PUBLISH"]
        ALIGN --> CLEANUP[cleanup-unused-screenshots]
        CLEANUP --> DONE([Section ready to publish])
    end

    %% Gap annotations
    STRUCT -.->|now: skills| DONE1["✓ section-readiness / section-planner\nbuilt — /check-section-readiness, /plan-section"]
    APPEXP -.->|built| GAP2["app-explorer built ✓ driving tool defined\n(Playwright MCP / collection runner) named + preflight-checked;\nhost project declares/connects it in config"]
    STYLE_F -.->|built| DONE3["✓ document-section: the whole chain\nwith a resumable ledger — /document-section"]

    classDef skill fill:#d4edda,stroke:#28a745,color:#000
    classDef gap fill:#fff3cd,stroke:#ffc107,color:#000
    classDef stage fill:#e8f4fd,stroke:#0d6efd,color:#000
    classDef terminal fill:#f8f9fa,stroke:#6c757d,color:#000

    class WRITE_C,WRITE_G,WRITE_A,STYLE_R,STYLE_F,TRANSLATE,ALIGN,CLEANUP,DONE1,DONE3 skill
    class GAP2 gap
    class PLAN,EXPLORE,DRAFT,REVIEW,LOCALIZE,PUBLISH stage
    class START,DONE terminal
```

---

## Skill quick reference

| Stage | Skill / Command | What it does |
|---|---|---|
| Readiness check | `section-readiness` | Classifies a section folder (skeleton / needs-revision / greenfield), emits a JSON verdict |
| Explore app | `app-explorer` | Explores the live app + API-seeded state, writes `.sources/app-notes.md` |
| Plan section | `section-planner` | Proposes IA (keep/merge/split/add) for a section, gated on approval |
| Whole section | `document-section` | Chains readiness → explore → plan → write → resolve markers → fix → review → UA approval → translate → align for one section, with a resumable ledger; stops at the approval gates |
| Draft — concept | `concept-doc-writer` | Background topics: how a feature works, what a term means |
| Draft — user guide | `user-guide-writer` | Task-based procedural docs for the product's UI |
| Draft — API | `api-doc-writer` | One endpoint per page, API reference format |
| Update a page | `doc-page-updater` | Applies a change brief to an approved page with the smallest edit; writes update-report.md for the scoped review / sync translation that follow |
| Resolve markers | `resolve-markers` | Batch-answers `{/* NEEDS CONFIRMATION */}` markers from evidence |
| Review style | `doc-style-reviewer` | Read-only findings report (gdsg / mssg-en / mssg-ua / ua-grammar) |
| Fix style | `doc-style-fixer` | Applies the reviewer's findings to the file |
| Translate | `doc-translator` | UA → EN, preserves MDX, enforces EN glossary |
| Translate — further locales | `locale-translator` | UA → every other locale of the site (not EN), only changed blocks, UI labels from the app's own dictionaries, scripted checks |
| Alignment check | `doc-alignment-checker` | Checks UA and EN pages are structurally in sync |
| Clean screenshots | `cleanup-unused-screenshots` | Moves unreferenced screenshots to `_unused/` |
| Icon-only controls | `identify-ui-icon` | Finds the Iconify id, SVG or screenshot crop for a control with no text; the writers call it by name |
| Screenshots from a recording | `extract-sme-screenshots` | Pulls deduplicated screenshots (and, if needed, a transcript) from an SME recording in `.sources/` |
| SME notes | `convert-sme-input` | Turns a transcript or raw notes into a structured `.sources/sme-interview.md` |

The full per-page pipeline from an SME video to a style-reviewed draft (`/doc-from-interview`) and the link-TODO repair (`/fix-doc-todos`) are commands, listed below. See [`SKILLS-INDEX.md`](plugins/doc-writer-toolkit/SKILLS-INDEX.md) for the canonical list with invocation examples.

## Commands quick reference

| Command | Underlying skill |
|---|---|
| `/doc-from-interview` | `extract-sme-screenshots` → `convert-sme-input` → the writer chosen by `type:` (`concept-doc-writer`, `user-guide-writer` or `api-doc-writer`) → `doc-style-reviewer` → `doc-style-fixer` |
| `/create-api-doc` | `api-doc-writer` |
| `/check-section-readiness` | `section-readiness` |
| `/plan-section` | `section-planner` |
| `/document-section` | `document-section`: `section-readiness` → `app-explorer` → `section-planner` → the writer by `docType` → `resolve-markers` → `doc-style-fixer` → `doc-style-reviewer` → `doc-translator` → `doc-alignment-checker` |
| `/explore-and-resolve` | `app-explorer` → `resolve-markers` |
| `/review-doc-style` | `doc-style-reviewer` |
| `/fix-doc-style` | `doc-style-fixer` |
| `/fix-doc-todos` | its own steps resolve link-type `{/* ToDo */}` markers, then `doc-alignment-checker` |
| `/translate-doc` | `doc-translator` |
| `/check-doc-alignment` | `doc-alignment-checker` |
| `/translate-locales` | `locale-translator` |
| `/update-doc-page` | `doc-page-updater` |
| `/identify-icon` | `identify-ui-icon` |

## Gaps (setup requirements)

| Gap | Why it matters | What it needs |
|---|---|---|
| Live-app driving tool | `app-explorer` names its driving tool (Playwright MCP / collection runner) and preflight-checks it; what remains is wiring the actual MCP server + runner into the host project and declaring them in its config | Playwright MCP server + collection runner connected in the session and declared in the host project's "Documentation toolkit configuration" |
