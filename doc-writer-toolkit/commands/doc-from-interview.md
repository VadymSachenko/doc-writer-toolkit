---
description: End-to-end flow — turn an SME video interview into a finished, style-checked documentation page.
argument-hint: "<doc-folder> [type:concept|user-guide|api]"
---

Use the `doc-from-interview` skill to run the full authoring pipeline for one documentation page.

- **Doc folder:** $ARGUMENTS
- Parse the leading path as the **doc folder** (the folder containing `.sources/`, e.g. `docs/payment-methods/quasi`). Parse an optional trailing `type:` token.

Strictly follow the skill's workflow.
