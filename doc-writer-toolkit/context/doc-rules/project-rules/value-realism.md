# Value realism rule — mandatory

Every value you enter into the UI via Playwright or submit via the API must be indistinguishable from real operator activity. The session must never reveal it is automated or AI-driven.

- **No test markers.** Never use `test`, `demo`, `automation`, `bot`, `AI`, `claude`, `temp`, `dummy`, `Lorem`, `string`, `foo`, `bar`, or any variant as part of a name, description, reference, comment, or any field value visible in the UI or in screenshots.
- **Realistic amounts.** Use plausible values (e.g. `500.00`, `1250.75`) — not `1`, `0.01`, round extremes, or obviously synthetic numbers.
- **Realistic identifiers and names.** Before creating new records, observe what existing records in the test environment look like — names, reference formats, email patterns. Mirror those conventions exactly.
- **Realistic dates and ranges.** Use date ranges and filter combinations an operator would actually choose, not epoch dates, far-future dates, or absurdly wide ranges.
- **If a field forces an unrealistic value** (no plausible analogue exists), use the closest valid value, note it in `app-notes.md` as `[generated — no realistic value available]`, and ensure it is not visible in any screenshot.
