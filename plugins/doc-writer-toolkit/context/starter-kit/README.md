# Starter kit

Skeletons for a host's product kit. A product kit is a folder in the host repo that holds what is specific to the product its site documents: its terms, its facts and its own rules. The plugin ships no product content, so a host without a kit gets no glossary, no product facts and no product rules.

To start a kit:

1. Copy this folder by hand into the host repo, as a visible folder outside every content root, for example `doc-kit/`. Inside a content root, Docusaurus would render its files as pages. Leave this `README.md` behind.
2. Fill in the files and commit them.
3. Declare the folder in the "Documentation toolkit configuration" block of the host's `CLAUDE.md`:

   ```md
   - **Product kit:** `doc-kit/`
   ```

How skills find the kit, and what they do without one, is in `${CLAUDE_PLUGIN_ROOT}/context/project-paths.md`, "Product kit". Skills only name this folder; they never copy it.

| File | What to put in it |
|---|---|
| `glossary-ua.md`, `glossary-en.md` | The approved terms for Ukrainian and English pages, with their render. The format is `${CLAUDE_PLUGIN_ROOT}/context/doc-rules/glossary-format.md`. Replace the two sample rows. |
| `product-facts.md` | Facts about the product and its API that the writers read as background: concepts, roles, statuses, limits. |
| `product-rules.md` | Rules that hold for this product only, such as its name and short name, the terms that replace common synonyms, and the names of its UI sections. They are rank 0, like `formatting-conventions.md`. |
| `templates/` (optional, not in this folder) | A page template from `${CLAUDE_PLUGIN_ROOT}/context/doc-templates/`, copied under the same file name, with your own examples. A skill reads it in place of the plugin's. Keep the plugin template's structure: skills refer to its variants and sections by name. |
| `glossary.md` (optional, not in this folder) | A bilingual list for people that aligns the two glossaries. No skill reads it. |
