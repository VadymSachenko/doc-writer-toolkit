from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "manifest.json"
SOURCE_MAP = ROOT / "source-map.json"


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def frontmatter(text: str) -> dict[str, object] | None:
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---\n", 4)
    if end < 0:
        return None
    lines = text[4:end].splitlines()
    result: dict[str, object] = {}
    i = 0
    while i < len(lines):
        line = lines[i]
        if ":" not in line or line.startswith(" "):
            i += 1
            continue
        key, raw = line.split(":", 1)
        raw = raw.strip()
        if raw.startswith("[") and raw.endswith("]"):
            result[key] = [part.strip().strip("'\"") for part in raw[1:-1].split(",") if part.strip()]
        elif raw:
            result[key] = raw.strip("'\"")
        else:
            values: list[str] = []
            j = i + 1
            while j < len(lines) and lines[j].startswith("  - "):
                values.append(lines[j][4:].strip())
                j += 1
            result[key] = values
            i = j - 1
        i += 1
    return result


def parse(path: Path) -> dict | None:
    text = path.read_text(encoding="utf-8")
    meta = frontmatter(text)
    if meta is None:
        return None
    rules = [
        {"id": match.group(1), "title": match.group(2).strip()}
        for match in re.finditer(r"(?m)^##\s+(GDSG-[A-Z0-9-]+)\s+[—-]\s+(.+?)\s*$", text)
    ]
    data = path.read_bytes()
    return {
        "path": rel(path),
        "id": meta.get("id"),
        "title": meta.get("title"),
        "languages": meta.get("languages", []),
        "content_types": meta.get("content_types", []),
        "source_urls": meta.get("source_urls", []),
        "captured": meta.get("captured"),
        "status": meta.get("status"),
        "keywords": meta.get("keywords", []),
        "rules": rules,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def rebuild() -> dict:
    previous = json.loads(MANIFEST.read_text(encoding="utf-8"))
    source_map = json.loads(SOURCE_MAP.read_text(encoding="utf-8"))
    files = []
    for path in sorted(ROOT.rglob("*.md")):
        item = parse(path)
        if item:
            files.append(item)
    core = [item for item in files if not item["path"].startswith("terminology/a-z/")]
    rules = [{**rule, "file": item["path"]} for item in core for rule in item["rules"]]

    lines = [
        "# Rule index",
        "",
        "Use this file for retrieval, not as a prompt payload. Search by rule ID, title,",
        "keyword, or path, and then load only the matching module.",
        "",
        "## Rule families",
        "",
        "| Family ID | Title | File | Retrieval terms |",
        "|---|---|---|---|",
    ]
    for item in core:
        terms = ", ".join(item["keywords"])
        target = item["path"].replace(" ", "%20")
        lines.append(f"| `{item['id']}` | {item['title']} | [`{item['path']}`]({target}) | {terms} |")
    lines.extend(["", "## Named rules", "", "| Rule ID | Rule | File |", "|---|---|---|"])
    for rule in rules:
        lines.append(f"| `{rule['id']}` | {rule['title']} | `{rule['file']}` |")
    terminology = previous["terminology"]
    lines.extend(
        [
            "",
            "## Terminology retrieval",
            "",
            f"The word list contains {terminology['entries']} entries in {terminology['chunks']} chunks,",
            f"with at most {terminology['max_entries_per_chunk']} entries per chunk. Search",
            "`terminology/index/<letter>.md`, then load the linked chunk. Scope markers are",
            "defined in `terminology/INDEX.md`.",
        ]
    )
    (ROOT / "RULE-INDEX.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    manifest = {
        "schema_version": previous["schema_version"],
        "title": previous["title"],
        "official_root": previous["official_root"],
        "snapshot_date": previous["snapshot_date"],
        "source_pages": len(source_map["pages"]),
        "covered_source_pages": sum(page["covered"] for page in source_map["pages"]),
        "rule_families": len(core),
        "named_rules": len(rules),
        "terminology": terminology,
        "files": files,
        "rules": rules,
        "sources": source_map["pages"],
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {
        "source_pages": manifest["source_pages"],
        "covered_source_pages": manifest["covered_source_pages"],
        "rule_families": manifest["rule_families"],
        "named_rules": manifest["named_rules"],
        "files": len(files),
    }


if __name__ == "__main__":
    print(json.dumps(rebuild()))
