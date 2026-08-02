# TW Workflow Map

Personal reference: your real process stages mapped to toolkit skills. Use this to decide which skill to invoke next, and to spot where you still work manually.

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
    STRUCT -.->|GAP: no skill| GAP1["⚠ section-readiness-check\nnot yet built"]
    APPEXP -.->|GAP: manual today| GAP2["⚠ live-app exploration\nrequires MCP/browser tool access"]
    STYLE_F -.->|FUTURE: orchestrator| GAP3["⚠ write-section command\ncould chain all steps above"]

    classDef skill fill:#d4edda,stroke:#28a745,color:#000
    classDef gap fill:#fff3cd,stroke:#ffc107,color:#000
    classDef stage fill:#e8f4fd,stroke:#0d6efd,color:#000
    classDef terminal fill:#f8f9fa,stroke:#6c757d,color:#000

    class WRITE_C,WRITE_G,WRITE_A,STYLE_R,STYLE_F,TRANSLATE,ALIGN,CLEANUP skill
    class GAP1,GAP2,GAP3 gap
    class PLAN,EXPLORE,DRAFT,REVIEW,LOCALIZE,PUBLISH stage
    class START,DONE terminal
```

---

## Skill quick reference

| Stage | Skill / Command | What it does |
|---|---|---|
| Draft — concept | `concept-doc-writer` | Background topics: how a feature works, what a term means |
| Draft — user guide | `user-guide-writer` | Task-based procedural docs for partner cabinet |
| Draft — API | `api-doc-writer` | One endpoint per page, API reference format |
| Review style | `doc-style-reviewer` | Read-only findings report (gdsg / mssg-ua / ua-grammar) |
| Fix style | `doc-style-fixer` | Applies the reviewer's findings to the file |
| Translate | `doc-translator` | UA → EN, preserves MDX, enforces EN glossary |
| Alignment check | `doc-alignment-checker` | Checks UA and EN pages are structurally in sync |
| Clean screenshots | `cleanup-unused-screenshots` | Moves unreferenced screenshots to `_unused/` |

## Commands quick reference

| Command | Underlying skill |
|---|---|
| `/doc-from-interview` | `convert-sme-input` → `user-guide-writer` |
| `/create-api-doc` | `api-doc-writer` |
| `/review-doc-style` | `doc-style-reviewer` |
| `/fix-doc-style` | `doc-style-fixer` |
| `/fix-doc-todos` | resolves `{/* ToDo */}` markers |
| `/translate-doc` | `doc-translator` |
| `/check-doc-alignment` | `doc-alignment-checker` |

## Gaps (not yet built)

| Gap | Why it matters | What it would need |
|---|---|---|
| `section-readiness-check` | Step 1 is manual today — you eyeball the folder | Skill that reads a section folder, lists stubs vs. complete files, outputs a gap report |
| Live-app exploration | `extract-sme-screenshots` only handles meeting recordings; app exploration is fully manual | MCP or browser tool access to the target app |
| `write-section` orchestrator | Your eventual goal: one command → ready-to-publish | Coordination skill that chains readiness check → writer → style review → translate → align |
