from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "manifest.json"
SOURCE_MAP = ROOT / "source-map.json"
REPORT = ROOT / "maintenance" / "qa-report.md"
EXPECTED = {
    "source_pages": 70,
    "terminology_entries": 598,
    "terminology_chunks": 46,
    "max_entries_per_chunk": 20,
    "scope_counts": {
        "general": 359,
        "do-not-use": 147,
        "use-with-caution": 92,
        "android-only": 17,
        "google-cloud-only": 5,
    },
}


def check(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def markdown_files() -> list[Path]:
    return sorted(p for p in ROOT.rglob("*.md") if ".build" not in p.parts)


def validate() -> tuple[list[str], dict]:
    errors: list[str] = []
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    source_map = json.loads(SOURCE_MAP.read_text(encoding="utf-8"))

    check(manifest["source_pages"] == EXPECTED["source_pages"], "Manifest source-page count changed.", errors)
    check(manifest["covered_source_pages"] == EXPECTED["source_pages"], "Not every source page is covered.", errors)
    check(len(source_map["pages"]) == EXPECTED["source_pages"], "Source map must contain 70 pages.", errors)
    check(all(p["covered"] and p["local_files"] for p in source_map["pages"]), "A source-map page lacks a local destination.", errors)

    terminology = manifest["terminology"]
    check(terminology["entries"] == EXPECTED["terminology_entries"], "Terminology entry count changed.", errors)
    check(terminology["chunks"] == EXPECTED["terminology_chunks"], "Terminology chunk count changed.", errors)
    check(terminology["max_entries_per_chunk"] == EXPECTED["max_entries_per_chunk"], "Chunk limit changed.", errors)
    check(terminology["scope_counts"] == EXPECTED["scope_counts"], "Terminology scope counts changed.", errors)

    chunks = sorted((ROOT / "terminology" / "a-z").glob("*.md"))
    counts = [len(re.findall(r'(?m)^<a id="term-[^"]+"></a>$', p.read_text(encoding="utf-8"))) for p in chunks]
    check(len(chunks) == EXPECTED["terminology_chunks"], "A terminology chunk is missing or extra.", errors)
    check(sum(counts) == EXPECTED["terminology_entries"], "Generated chunks do not contain 598 entries.", errors)
    check(bool(counts) and max(counts) <= EXPECTED["max_entries_per_chunk"], "A terminology chunk exceeds 20 entries.", errors)

    # Validate catalog hashes and stable family IDs.
    family_ids: dict[str, str] = {}
    named_ids: dict[str, str] = {}
    for item in manifest["files"]:
        path = ROOT / item["path"]
        check(path.is_file(), f"Manifest file is missing: {item['path']}", errors)
        if path.is_file():
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            check(digest == item["sha256"], f"Manifest hash is stale: {item['path']}", errors)
        if item["id"] in family_ids:
            errors.append(f"Duplicate family ID {item['id']}: {family_ids[item['id']]} and {item['path']}")
        family_ids[item["id"]] = item["path"]
    for rule in manifest["rules"]:
        if rule["id"] in named_ids:
            errors.append(f"Duplicate named rule ID {rule['id']}: {named_ids[rule['id']]} and {rule['file']}")
        named_ids[rule["id"]] = rule["file"]

    # Validate UTF-8, common mojibake, and local Markdown targets.
    link_pattern = re.compile(r"(?<!!)\[[^\]]*\]\(([^)]+)\)")
    mojibake = ("\u00e2\u20ac", "\u00c3", "\u00c2")
    local_links = 0
    for path in markdown_files():
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            errors.append(f"Not valid UTF-8: {path.relative_to(ROOT).as_posix()}")
            continue
        if any(marker in text for marker in mojibake):
            errors.append(f"Possible mojibake: {path.relative_to(ROOT).as_posix()}")
        for match in link_pattern.finditer(text):
            target = match.group(1).strip().strip("<>").split()[0]
            if target.startswith(("http://", "https://", "mailto:", "#")) or target in {"…", "..."}:
                continue
            target_path = unquote(target.split("#", 1)[0])
            if not target_path:
                continue
            local_links += 1
            resolved = (path.parent / target_path).resolve()
            check(resolved.is_file(), f"Broken local link in {path.relative_to(ROOT).as_posix()}: {target}", errors)

    # Router paths are code literals rather than links, so verify them separately.
    router = (ROOT / "ROUTING.md").read_text(encoding="utf-8")
    router_paths = sorted(set(re.findall(r"`([^`]+\.(?:md|json))`", router)))
    for target in router_paths:
        if "<" in target:
            continue
        check((ROOT / target).is_file(), f"Router target is missing: {target}", errors)

    # Temporary website material must not survive in the delivered corpus.
    retained_web = [p for p in ROOT.rglob("*") if p.is_file() and p.suffix.lower() in {".html", ".txt"}]
    check(not retained_web, "Raw HTML or text extracts remain in the delivered corpus.", errors)

    stats = {
        "source_pages": manifest["source_pages"],
        "covered_source_pages": manifest["covered_source_pages"],
        "rule_families": manifest["rule_families"],
        "named_rules": manifest["named_rules"],
        "terminology_entries": terminology["entries"],
        "terminology_chunks": terminology["chunks"],
        "max_chunk_size": max(counts) if counts else 0,
        "manifest_files": len(manifest["files"]),
        "local_links_checked": local_links,
        "router_targets_checked": len(router_paths),
        "scope_counts": terminology["scope_counts"],
    }
    return errors, stats


def write_report(errors: list[str], stats: dict) -> None:
    status = "PASS" if not errors else "FAIL"
    lines = [
        "# QA report",
        "",
        f"**Status:** {status}  ",
        "**Validated:** 2026-07-16",
        "",
        "## Coverage",
        "",
        f"- Official navigation pages: {stats['covered_source_pages']}/{stats['source_pages']}",
        f"- Rule families: {stats['rule_families']}",
        f"- Named rules: {stats['named_rules']}",
        f"- Terminology: {stats['terminology_entries']} entries in {stats['terminology_chunks']} chunks",
        f"- Largest terminology chunk: {stats['max_chunk_size']} entries",
        "",
        "## Integrity",
        "",
        f"- Manifest-backed files: {stats['manifest_files']}",
        f"- Local Markdown links checked: {stats['local_links_checked']}",
        f"- Router targets checked: {stats['router_targets_checked']}",
        "- UTF-8 and common mojibake scan: passed" if not any("UTF-8" in e or "mojibake" in e for e in errors) else "- UTF-8 and common mojibake scan: failed",
        "- Raw website extracts retained: no" if not any("Raw HTML" in e for e in errors) else "- Raw website extracts retained: yes",
        "",
        "## Terminology scopes",
        "",
    ]
    for scope, count in stats["scope_counts"].items():
        lines.append(f"- `{scope}`: {count}")
    if errors:
        lines.extend(["", "## Failures", ""] + [f"- {error}" for error in errors])
    REPORT.write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    problems, metrics = validate()
    write_report(problems, metrics)
    print(json.dumps({"status": "PASS" if not problems else "FAIL", **metrics, "errors": problems}, ensure_ascii=False))
    sys.exit(1 if problems else 0)
