---
name: internal-links
description: The single shared contract for building, repairing, and validating page-to-page documentation links as site-root-relative URLs, in the form each root pair declares (route or file path). Referenced by every skill that creates, repairs, or validates internal links (concept-doc-writer, user-guide-writer, api-doc-writer, doc-page-updater, doc-alignment-checker, doc-translator, and the fix-doc-todos command) — never copy this algorithm into a skill file.
metadata:
  type: reference
---

# Internal links

Single source of truth for how a **page-to-page documentation link** is written. Every skill that
creates, repairs, translates, or validates such a link resolves the rule here; none of them restates
the algorithm. If you are editing a skill and about to write "UA URL prefix + path, no `.md`", stop —
point at this file instead.

The project declarations this contract needs — the **UA URL prefix**, the **content root** a target
page is measured against and the **page link form** — are those of the root pairs involved, resolved
through `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md` ("Resolving a page's root pair"). Read them
there; do not hardcode `/`, `/docs/`, `portal/`, or any other value.

## The page link form

Each root pair declares how its pages link to each other: `Page link form:` for the primary pair,
`<Name> Page link form:` for a further pair (`project-paths.md`). The value is the host's decision,
made from what its build resolves; never infer it from the pages.

- **`route`** (the default, when the field is absent): the site-root-relative URL, no `.md`/`.mdx`.
- **`file-path`**: the target file's site-root-relative path from its pair's UA content root, with its
  `.md`/`.mdx` kept. For a host whose build resolves file links and breaks on extensionless routes.

The form applies to a link between two pages of the **same pair**: the linking page's pair declares it.
A link to a page of **another pair** is always a route, whatever either pair declares: Docusaurus
resolves a file link only inside the docs instance that holds the page.

## The route-building algorithm

A route is a **site-root-relative URL path** built from two declared inputs:

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

## The file-path algorithm

For a link between two pages of a pair that declares `file-path`:

1. Take the target page path **relative to the pair's content root** (not relative to the current file).
2. **Keep the `.md` / `.mdx` extension** the file has.
3. **Prepend exactly one slash.** No UA URL prefix and no content-root folder: `/webhooks/webhooks.md`,
   not `/docs/webhooks/webhooks.md`.
4. **Preserve the link text and any anchor** unchanged, as for a route.

An EN page under the same pair links to the same path: the locales share one tree.

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

Host D is host C with one more line: its API reference pair links its own pages by file path.

```md
- **API reference Page link form:** `file-path`
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

With **a `file-path` pair** (host D):

- from a `docs/` page to `docs/webhooks/webhooks.md` → `[вебхуки](/webhooks/webhooks.md)`
- from a `docs/` page to `docs/auth/auth.md#tokens` → `[токени](/auth/auth.md#tokens)`
- from a `docs/` page to `portal/settings/settings.md` (another pair) → `[налаштування](/portal/settings/settings)`
- from a `portal/` page to `docs/webhooks/webhooks.md` (another pair) → `[вебхуки](/webhooks/webhooks)`

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
- **Never write a link in the other form.** A route has no `.md`/`.mdx`; a file-path link keeps the
  file's own extension. Never add an extension to a route or drop one from a file-path link.

## Validating a page link

A checker sees only the link, not the target file. First find the linking page's pair and its page link
form (`project-paths.md`). In a `route` pair, every page link is a route: check it with steps 1 to 3.
In a `file-path` pair, check the link by its shape:

- **It ends in `.md`/`.mdx`** (before any anchor): a file-path link. Flag `./`, `../` and a link that
  doesn't start with `/`. Flag a path that starts, by whole segments, with the pair's UA content root
  (`/docs/webhooks/webhooks.md`, where `docs/` is that root): a file-path link starts below it. Skip
  steps 1 to 3.
- **It has no extension**: a route, which must point into another pair. Check it with steps 1 to 3, and
  flag it when step 1 names the linking page's own pair: that pair links its own pages by file path.

Checking a route:

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
  page-to-page link with this contract from the start: the form from the pairs involved, the path from
  the target page's pair.
- **Updating** (`doc-page-updater`) builds a link it adds the same way, and leaves existing links outside its
  blocks as they are.
- **Repair** (the `/fix-doc-todos` command) rewrites a relative page link, or one in the wrong form for
  its pair, to the output of the algorithm that form names.
- **Translation** (`doc-translator`) **preserves an already-correct link verbatim**, route or file path — an EN page links
  to the same site-root-relative path as its UA source (the locales share one path; see
  `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/project-rules/naming-conventions.md`). It does not
  re-derive or "localize" the path.
- **Validation** (`doc-alignment-checker`) checks that a page link has its pair's form and matches the
  algorithm's output for one of the declared prefixes (see "Validating a page link") and flags a mismatch; it **does not** verify the target file exists in a host
  project, and it does not edit prose. It is not a route this task uses to confirm fixture targets.
