---
name: internal-links
description: The single shared contract for building, repairing, and validating page-to-page documentation links as site-root-relative URLs. Referenced by every skill that creates, repairs, or validates internal links (concept-doc-writer, user-guide-writer, api-doc-writer, doc-alignment-checker, doc-translator, and the fix-doc-todos command) — never copy this algorithm into a skill file.
metadata:
  type: reference
---

# Internal links

Single source of truth for how a **page-to-page documentation link** is written. Every skill that
creates, repairs, translates, or validates such a link resolves the rule here; none of them restates
the algorithm. If you are editing a skill and about to write "UA URL prefix + path, no `.md`", stop —
point at this file instead.

The project declarations this contract needs — the **UA URL prefix** and the **content root** a target
page is measured against — are resolved through `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`. Read
them there; do not hardcode `/`, `/docs/`, `partner-cabinet/`, or any other value.

## The route-building algorithm

A page-to-page link is a **site-root-relative URL path** built from two declared inputs:

1. the host project's declared **UA URL prefix** (its Docusaurus `routeBasePath`); and
2. the **target page's path relative to its configured content root**.

Steps:

1. Take the target page path **relative to the content root** (not relative to the current file).
2. **Remove the `.md` / `.mdx` extension.**
3. **Join** the UA URL prefix and that extensionless path with **exactly one slash** — collapse a
   doubled slash, and never drop the single separator.
4. **Preserve the link text and any anchor** unchanged. Re-attach a `#anchor` (a section link) after
   the path.

The result always begins at the site root (`/…`). It is never document-relative.

## Synthetic host configuration (for the examples below)

No real documentation project is available, so the examples use a **synthetic host**. Two prefixes
are shown to make the join explicit; a real project has exactly one declared prefix.

```md
## Documentation toolkit configuration
- **UA content root:** `docs/`
- **UA URL prefix:** `/`            # host A
# or, for a split custom-id instance:
- **UA URL prefix:** `/operator/`   # host B
```

## Examples

With **UA URL prefix `/`** (host A):

- `[архіві транзакцій](../../archive/archive.md)` → `[архіві транзакцій](/archive/archive)`
- `[статуси](../../archive/archive.md#statuses)` → `[статуси](/archive/archive#statuses)`

With **UA URL prefix `/operator/`** (host B):

- `[архіві транзакцій](../../archive/archive.md#statuses)` → `[архіві транзакцій](/operator/archive/archive#statuses)`

## What this governs — and what it must not touch

**Governs:** page-to-page documentation links only (Prerequisites, Next steps, Related documents,
and inline body links pointing at another `.md`/`.mdx` page in the docs tree).

**Never rewrite or "fix" any of these:**

- **External URLs** (`https://…`, `mailto:`) — left exactly as written.
- **Asset links** — `./.assets/image.png` and any other image/file reference stay document-relative.
- **Same-page anchors** — a bare `#slug` (uk: `#довідкова-інформація-{slug}`) stays bare.
- **MDX `import`/`export` paths.**
- **Filesystem paths shown as code** (inside `` ` `` or a fenced block) — prose that looks like a path
  but is illustrative code, not a link.

## Hard prohibitions

- **Never hardcode `/docs/`** (or any literal prefix). The prefix is always the declared value.
- **Never use `./` or `../` to reach another documentation page.** Document-relative navigation is for
  assets only.
- **Never drop or add an extension back.** No `.md`/`.mdx` in the emitted URL.

## Validation vs. authoring

- **Authoring** skills (`concept-doc-writer`, `user-guide-writer`, `api-doc-writer`) build every new
  page-to-page link with this algorithm from the start.
- **Repair** (`fix-doc-todos`) rewrites a relative or extensioned page link to the algorithm's output.
- **Translation** (`doc-translator`) **preserves an already-correct route verbatim** — an EN page links
  to the same site-root-relative path as its UA source (the locales share one path; see
  `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/naming-conventions.md`). It does not
  re-derive or "localize" the path.
- **Validation** (`doc-alignment-checker`) checks that a page link matches the algorithm's output for
  the declared prefix and flags a mismatch; it **does not** verify the target file exists in a host
  project, and it does not edit prose. It is not a route this task uses to confirm fixture targets.
