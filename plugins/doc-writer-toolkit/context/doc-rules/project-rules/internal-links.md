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
page is measured against — are those of the **target page's root pair**, resolved through
`${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` ("Resolving a page's root pair"). Read them there; do
not hardcode `/`, `/docs/`, `portal/`, or any other value.

## The route-building algorithm

A page-to-page link is a **site-root-relative URL path** built from two declared inputs:

1. the **UA URL prefix of the target page's root pair** (its Docusaurus `routeBasePath`); and
2. the **target page's path relative to that pair's UA content root**.

Steps:

1. Take the target page path **relative to its pair's content root** (not relative to the current file).
2. **Remove the `.md` / `.mdx` extension.**
3. **Join** the UA URL prefix and that extensionless path with **exactly one slash** — collapse a
   doubled slash, and never drop the single separator.
4. **Preserve the link text and any anchor** unchanged. Re-attach a `#anchor` (a section link) after
   the path.

The result always begins at the site root (`/…`). It is never document-relative.

## Synthetic host configuration (for the examples below)

No real documentation project is available, so the examples use **synthetic hosts**. A project with
one root pair has one prefix; each further pair has its own.

```md
## Documentation toolkit configuration
- **UA content root:** `docs/`
- **UA URL prefix:** `/`            # host A
# or, for a split custom-id instance:
- **UA URL prefix:** `/operator/`   # host B
```

Host C has two root pairs:

```md
- **UA content root:** `portal/`
- **EN i18n root:** `i18n/en/docusaurus-plugin-content-docs-portal/current/`
- **UA URL prefix:** `/portal/`
- **API reference UA content root:** `docs/`
- **API reference EN i18n root:** `i18n/en/docusaurus-plugin-content-docs/current/`
- **API reference UA URL prefix:** `/`
```

## Examples

With **UA URL prefix `/`** (host A):

- `[архіві транзакцій](../../archive/archive.md)` → `[архіві транзакцій](/archive/archive)`
- `[статуси](../../archive/archive.md#statuses)` → `[статуси](/archive/archive#statuses)`

With **UA URL prefix `/operator/`** (host B):

- `[архіві транзакцій](../../archive/archive.md#statuses)` → `[архіві транзакцій](/operator/archive/archive#statuses)`

With **two root pairs** (host C), each link takes its target's pair:

- from a `docs/` page to `portal/settings/settings.md` → `[налаштування](/portal/settings/settings)`
- from a `portal/` page to `docs/webhooks/webhooks.md` → `[вебхуки](/webhooks/webhooks)`

## What this governs — and what it must not touch

**Governs:** page-to-page documentation links only (Prerequisites, Next steps, Related documents,
and inline body links pointing at another `.md`/`.mdx` page in the docs tree).

**Never rewrite or "fix" any of these:**

- **External URLs** (`https://…`, `mailto:`) — left exactly as written.
- **Asset links** — `./.assets/image.png` and any other image/file reference stay document-relative.
- **Same-page anchors** — a bare `#id` stays bare. The id is the heading's, per `heading-anchors.md` (`#reference-information-{slug}` in both languages).
- **MDX `import`/`export` paths.**
- **Filesystem paths shown as code** (inside `` ` `` or a fenced block) — prose that looks like a path
  but is illustrative code, not a link.

## Hard prohibitions

- **Never hardcode `/docs/`** (or any literal prefix). The prefix is always the declared value.
- **Never use `./` or `../` to reach another documentation page.** Document-relative navigation is for
  assets only.
- **Never drop or add an extension back.** No `.md`/`.mdx` in the emitted URL.

## Validating a route

A checker sees only the route, not the target file. Check it like this:

1. Match the route against every declared UA URL prefix, by whole path segments, with or without the
   prefix's trailing slash: `/portal`, `/portal#x` and `/portal/a` match `/portal/`; `/portal-old/a`
   doesn't. The longest match names the pair: `/portal/settings/settings` belongs to `/portal/`, not to
   `/`. A route that matches no declared prefix has a wrong prefix: flag it. When the project keeps a tree
   outside every pair (an `API reference root:` or an English-native tree, `project-paths.md`), add
   that the route may point into that tree, whose prefix isn't declared.
2. Take the rest of the route after the matched prefix. Flag it as a file path written as a route
   when it starts, by whole segments, with a declared UA content root's full path
   (`/docs/webhooks/webhooks`, where `docs/` is a content root), or with `docs/` when `/docs/` is no
   declared prefix (the hardcoded prefix this file forbids).
3. Flag `./`, `../` and a leftover `.md`/`.mdx` as before.

This is a structural check only: it never looks for the target file.

## Validation vs. authoring

- **Authoring** skills (`concept-doc-writer`, `user-guide-writer`, `api-doc-writer`) build every new
  page-to-page link with this algorithm from the start, from the target page's pair.
- **Repair** (the `/fix-doc-todos` command) rewrites a relative or extensioned page link to the algorithm's output.
- **Translation** (`doc-translator`) **preserves an already-correct route verbatim** — an EN page links
  to the same site-root-relative path as its UA source (the locales share one path; see
  `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/naming-conventions.md`). It does not
  re-derive or "localize" the path.
- **Validation** (`doc-alignment-checker`) checks that a page link matches the algorithm's output for
  one of the declared prefixes (see "Validating a route") and flags a mismatch; it **does not** verify the target file exists in a host
  project, and it does not edit prose. It is not a route this task uses to confirm fixture targets.
