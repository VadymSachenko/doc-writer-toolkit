---
id: GDSG-FORMAT-DATES
title: Dates and times
languages: [en-US]
scope: mixed
language_specific_sections:
  - "Times"
content_types: [all]
source_urls:
  - https://developers.google.com/style/dates-times
captured: 2026-07-16
status: active
keywords: [date, time, time zone, UTC, ISO 8601]
---

# Dates and times

## Dates

- In prose, use an unambiguous month-name form: **July 16, 2026**.
- Include the year unless the context makes it unnecessary and cannot become stale.
- Use ISO 8601 `YYYY-MM-DD` when a numeric-only date is required.
- Do not use slash-only dates such as `7/8/26`; readers interpret them differently.
- Avoid seasons as time references. Use months, named quarters, or exact dates.

## Times

- Use a 12-hour clock with uppercase **AM** or **PM**, without periods.
- Omit `:00` for an exact hour unless surrounding data requires consistent precision.
- Add a time zone only when readers need it. Name the geographic zone and include its
  UTC offset when ambiguity or daylight-saving changes matter.
- Use a nonbreaking space between the time and **AM** or **PM** in rendered content.

**Recommended:** July 16, 2026, at 3:30 PM Eastern Time (UTC-4)  
**Not recommended:** 07/16/26 at 15:30 EST

For a machine-readable timestamp, follow the product’s required standard rather than
converting it to prose style.

