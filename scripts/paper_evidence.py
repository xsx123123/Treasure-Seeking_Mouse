"""Offline paper evidence indexing; no network, task submission or model instructions.

Run with the OmicHub virtualenv to reuse its installed PDFProcessor. This CLI is
not a public upload API and accepts only a local PDF explicitly chosen by its user.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any

MAX_BYTES = 20 * 1024 * 1024
MAX_PAGES = 200
MAX_TEXT = 2_000_000
INDEX_VERSION = "paper-evidence.v1"
ACCESSION = re.compile(
    r"(?<![A-Za-z0-9_])(?:GSE|GSM|SRP|SRR|SRS|SRX|ERP|ERR|ERS|ERX|DRP|DRR|DRS|DRX|"
    r"PRJNA|PRJEB|PRJDB|PRJCA|CRA|CRR|CRX|CRS|HRA)\d+(?![A-Za-z0-9_])",
    re.IGNORECASE,
)
DOI = re.compile(r"(?<![A-Za-z0-9])10\.\d{4,9}/[-._;()/:A-Z0-9]+", re.IGNORECASE)
PMID = re.compile(r"(?<![A-Za-z0-9_])PMID\s*:\s*(\d{6,9})(?![A-Za-z0-9_])", re.IGNORECASE)
HEADINGS = re.compile(
    r"^\s*(?:\d+[.\s]+)?(abstract|introduction|background|materials and methods|"
    r"methods|results|discussion|conclusions?|data availability(?: statement)?|"
    r"references|bibliography|supplementary (?:information|materials))\s*[:.]?\s*$",
    re.IGNORECASE,
)


def build_index(
    *, source_sha256: str, pages: list[dict[str, Any]], total_pages: int,
    parser: str, parser_success: bool = True, truncated: bool = False,
    ocr_pages: list[int] | None = None,
) -> dict[str, Any]:
    """Index exact parser text; a mention never proves ownership or accessibility.

    Offsets are Unicode code point offsets in that page's text, end exclusive.
    Heading boundaries are heuristic labels, never asserted PDF coordinates.
    """
    if not re.fullmatch(r"[0-9a-f]{64}", source_sha256):
        raise ValueError("invalid source SHA256")
    if not isinstance(total_pages, int) or isinstance(total_pages, bool) or not 0 <= total_pages <= MAX_PAGES:
        raise ValueError("invalid total_pages")
    seen: set[int] = set()
    for page in pages:
        number = page.get("page_number")
        if not isinstance(number, int) or isinstance(number, bool) or not 1 <= number <= total_pages or number in seen:
            raise ValueError("invalid or duplicate page_number")
        if not isinstance(page.get("text"), str):
            raise ValueError("page text must be a string")
        seen.add(number)
    if sum(len(p["text"]) for p in pages) > MAX_TEXT:
        raise ValueError("extracted text exceeds limit")
    indexed_pages = []
    evidence = []
    mentions: dict[str, dict[str, Any]] = {}
    sections = []
    section = "unknown"
    gaps = ["FULL_SCIENTIFIC_INTERPRETATION_NOT_IMPLEMENTED", "DATABASE_VERIFICATION_NOT_RUN",
            "TABLE_AND_FIGURE_LAYOUT_NOT_INDEXED"]
    for page in sorted(pages, key=lambda p: p["page_number"]):
        text = page["text"]
        number = page["page_number"]
        boundaries: list[tuple[int, str]] = [(0, section)]
        offset = 0
        for line in text.splitlines(keepends=True):
            heading = HEADINGS.fullmatch(line.rstrip("\r\n"))
            if heading:
                section = heading[1].lower()
                boundaries.append((offset, section))
                sections.append({"label": section, "page": number, "start": offset,
                                 "end": offset + len(line.rstrip("\r\n")), "method": "heading_heuristic"})
            offset += len(line)
        indexed_pages.append({"page_number": number, "text": text})
        for kind, pattern in (("accession", ACCESSION), ("doi", DOI), ("pmid", PMID)):
            for match in pattern.finditer(text):
                raw = match[0]
                # Sentence punctuation is not part of a DOI; balanced parentheses are.
                if kind == "doi":
                    depth = 0
                    for position, character in enumerate(raw):
                        if character == "(":
                            depth += 1
                        elif character == ")":
                            if depth == 0:
                                raw = raw[:position]
                                break
                            depth -= 1
                    raw = raw.rstrip(".;,:")
                identifier = (raw.upper() if kind == "accession" else
                              f"PMID:{match[1]}" if kind == "pmid" else raw.lower())
                start, end = match.start(), match.start() + len(raw)
                label = next(label for point, label in reversed(boundaries) if point <= start)
                evidence_id = hashlib.sha256(
                    f"{INDEX_VERSION}:{source_sha256}:{number}:{start}:{end}".encode()
                ).hexdigest()
                evidence.append({"id": evidence_id, "page": number, "section": label,
                                 "start": start, "end": end, "quote": text[start:end],
                                 "context": text[max(0, start - 120):min(len(text), end + 120)],
                                 "bbox": None, "figure": None, "table": None})
                item = mentions.setdefault(identifier, {
                    "identifier": identifier, "kind": kind, "evidence_ids": [],
                    "relationship": "mention_only", "verification": "not_checked",
                    "match_tier": None,
                })
                item["evidence_ids"].append(evidence_id)
    readable = {p["page_number"] for p in pages if p["text"].strip()}
    possible_ocr = sorted((set(range(1, total_pages + 1)) - readable) | set(ocr_pages or []))
    if any(not isinstance(n, int) or isinstance(n, bool) or not 1 <= n <= total_pages for n in possible_ocr):
        raise ValueError("invalid OCR page_number")
    if possible_ocr:
        gaps.append("PAGES_WITHOUT_TEXT_OR_OCR_REQUESTED")
    if truncated:
        gaps.append("PARSER_CONTENT_TRUNCATED")
    if not mentions:
        gaps.append("NO_IDENTIFIERS_FOUND")
    extraction_status = "failed" if not parser_success else "needs_ocr" if not readable else (
        "partial" if possible_ocr or truncated else "succeeded"
    )
    return {
        "schema_version": INDEX_VERSION,
        "source": {"sha256": source_sha256, "parser": parser},
        "extraction_status": extraction_status,
        "interpretation_status": "not_started",
        "total_pages": total_pages, "possible_ocr_pages": possible_ocr,
        "sections": sections, "pages": indexed_pages,
        "evidence": evidence, "mentions": list(mentions.values()), "gaps": gaps,
    }


def parse_pdf(path: Path) -> dict[str, Any]:
    # Reject before calling PDFProcessor: its own pre-check can fall back on failure.
    if path.suffix.lower() != ".pdf":
        raise ValueError("only PDF files are accepted")
    with path.open("rb") as source:
        content = source.read(MAX_BYTES + 1)
    if len(content) > MAX_BYTES:
        raise ValueError("PDF exceeds 20 MiB")
    if not content.startswith(b"%PDF-"):
        raise ValueError("invalid PDF signature")
    # Existing platform dependencies; intentionally no new Python dependency set.
    import pypdf
    from cygnusx.application.services.pdf_processor import PDFProcessor

    import io
    reader = pypdf.PdfReader(io.BytesIO(content))
    if reader.is_encrypted:
        raise ValueError("encrypted PDF requires an unlocked source")
    total_pages = len(reader.pages)
    if not 1 <= total_pages <= MAX_PAGES:
        raise ValueError("PDF page count must be between 1 and 200")
    # Parse an immutable snapshot of the bytes hashed above, not a mutable input path.
    import tempfile
    with tempfile.TemporaryDirectory(prefix="paper-evidence-") as tmp:
        snapshot = Path(tmp) / "source.pdf"
        snapshot.write_bytes(content)
        result = PDFProcessor(config={
            "max_chars": MAX_TEXT, "max_file_size_mb": 20, "enable_ocr": False,
            "output_format": "plaintext", "page_marker": "[Page {n}]",
        }).process_sync(str(snapshot))
    indexed = build_index(
        source_sha256=hashlib.sha256(content).hexdigest(),
        pages=[{"page_number": p.page_number, "text": p.text} for p in result.pages],
        total_pages=total_pages, parser=f"omicHub.PDFProcessor/{result.source}",
        parser_success=result.success, truncated=result.metadata.truncated,
        ocr_pages=result.metadata.pages_needing_ocr,
    )
    indexed["source"]["fallback_reason"] = result.fallback_reason
    return indexed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        index = parse_pdf(args.pdf)
        # Never overwrite an existing artifact silently, including the source file.
        with args.output.open("x", encoding="utf-8") as target:
            json.dump(index, target, ensure_ascii=False, indent=2)
        print(json.dumps({"output": str(args.output), "status": index["extraction_status"],
                          "pages": index["total_pages"], "mentions": len(index["mentions"])}))
        return 0 if index["extraction_status"] != "failed" else 1
    except Exception as exc:
        print(json.dumps({"status": "failed", "error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
