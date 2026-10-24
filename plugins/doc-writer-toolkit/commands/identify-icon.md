---
description: 'Find the Iconify id, SVG or screenshot crop for an icon-only UI control, using the identify-ui-icon skill.'
argument-hint: "<screenshot or crop path> <where the control sits> [prefixes:<sets>]"
---

Use the `identify-ui-icon` skill to find the picture for an icon-only control.

- **Arguments:** $ARGUMENTS — the screenshot or crop, where the control sits on it, and optional `prefixes:` for the icon sets to search.

The skill resolves the page folder and the project's `Icon rendering:` field itself (via `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`); do not hardcode them here.

Strictly follow the skill's workflow: reuse the evidence first, never guess an id, and edit no page.

If the screenshot or crop does not exist, stop and tell me before doing anything else.
