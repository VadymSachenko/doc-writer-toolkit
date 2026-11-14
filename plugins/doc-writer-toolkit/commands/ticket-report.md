---
description: 'Show the ticket flow''s morning report for a date (today by default): what waits for you first, then the report as written.'
argument-hint: "[yyyy-mm-dd | today | yesterday]"
---

Use the `ticket-report-reader` skill to show the ticket flow's report.

- **Arguments:** $ARGUMENTS — the date, or nothing for today. Pass it through unchanged.

The skill finds the host's state folder itself through `ticket-state config`; do not hardcode a path here.

Strictly follow the skill's workflow: read the report file only. Do not write or refresh the report, run a step, or change a setting.
