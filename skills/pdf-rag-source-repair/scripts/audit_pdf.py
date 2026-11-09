#!/usr/bin/env python3
"""Read-only, metadata-only PDF/text-layer audit. Python 3.10+, optional pypdf."""

from __future__ import annotations

import argparse
from collections import Counter
from contextlib import contextmanager
from dataclasses import asdict, dataclass
import hashlib
import json
import logging
from pathlib import Path
import re
import sys
import unicodedata
import warnings


GLYPH_CODE = re.compile(
    r"(?<!\w)/(?:gid|g)[0-9]+(?!\w)|\((?:cid|gid)\s*:\s*[0-9]+\)",
    re.IGNORECASE,
)


class AuditError(Exception):
    """A public error containing a fixed message, never an extractor exception."""

    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


@dataclass(frozen=True)
class Policy:
    glyph_min_count: int = 4
    glyph_fraction: float = 0.25
    damage_min_count: int = 3
    damage_fraction: float = 0.08
    sparse_alnum: int = 64
    max_page_chars: int = 1_000_000


def measure(text: str | None, policy: Policy) -> dict:
    """Measure encoding and density; never score language or semantic accuracy."""
    if text is None:
        return {"availability": "unavailable", "encoding": "unavailable",
                "density": "unavailable", "semantic_accuracy": "not_assessed"}
    if len(text) > policy.max_page_chars:
        raise AuditError("page_text_limit", "A text layer exceeds the configured character limit.")
    visible = sum(not char.isspace() for char in text)
    alnum = sum(char.isalnum() for char in text)
    matches = list(GLYPH_CODE.finditer(text))
    glyph_chars = sum(len(match.group(0)) for match in matches)
    damaged = damaged_whitespace = 0
    for char in text:
        category = unicodedata.category(char)
        if char == "\ufffd" or category in ("Co", "Cs") or (category == "Cc" and char not in "\r\n\t"):
            damaged += 1
            damaged_whitespace += char.isspace()
    # Match whitespace inside a glyph token is excluded from the denominator.
    glyph_visible = sum(sum(not char.isspace() for char in match.group(0)) for match in matches)
    glyph_fraction = glyph_visible / max(visible, 1)
    damage_fraction = damaged / max(visible + damaged_whitespace, 1)
    reasons = []
    if len(matches) >= policy.glyph_min_count and glyph_fraction >= policy.glyph_fraction:
        reasons.append("repeated_glyph_codes")
    if damaged >= policy.damage_min_count and damage_fraction >= policy.damage_fraction:
        reasons.append("unicode_damage")
    return {
        "availability": "available", "characters": len(text),
        "non_whitespace": visible, "alphanumeric": alnum,
        "glyph_tokens": len(matches), "glyph_characters": glyph_chars,
        "glyph_fraction": round(glyph_fraction, 6),
        "damaged_characters": damaged, "damage_fraction": round(damage_fraction, 6),
        "encoding": "suspect" if reasons else ("empty" if not visible else "no_explicit_damage"),
        "encoding_reasons": reasons,
        "density": "sparse" if alnum < policy.sparse_alnum else "substantial",
        "semantic_accuracy": "not_assessed",
    }


def usable(metrics: dict) -> bool:
    return metrics["encoding"] == "no_explicit_damage" and metrics.get("alphanumeric", 0) >= 3


def inspect_layers(number: int, embedded: str | None, ocr: str | None,
                   images: str, policy: Policy, *, extraction_failed: bool = False) -> dict:
    """Return an advisory single-layer choice. No source text is returned."""
    embedded_metrics = measure(embedded, policy)
    ocr_metrics = measure(ocr, policy)
    flags = []
    if extraction_failed:
        flags.append("text_extraction_failed")
    if images == "unknown":
        flags.append("image_resource_inspection_incomplete")
    for label, metrics in (("embedded", embedded_metrics), ("ocr", ocr_metrics)):
        for reason in metrics.get("encoding_reasons", []):
            flags.append(f"{label}_{reason}")
    if embedded_metrics["encoding"] == "empty":
        flags.append("embedded_text_empty")
        flags.append("image_only_suspected" if images == "present" else "render_review_needed")
    elif embedded_metrics["density"] == "sparse":
        flags.append("embedded_text_sparse")

    if usable(embedded_metrics):
        if embedded_metrics["density"] == "sparse" and usable(ocr_metrics) and ocr_metrics["density"] == "substantial":
            candidate, reason = "ocr", "denser_readable_ocr_candidate"
        else:
            candidate, reason = "embedded", "readable_embedded_candidate"
    elif usable(ocr_metrics):
        candidate, reason = "ocr", "embedded_unusable_ocr_candidate"
    else:
        candidate, reason = "none", "no_readable_text_candidate"
        flags.append("searchable_text_unconfirmed")
    return {
        "page": number, "embedded": embedded_metrics, "ocr": ocr_metrics,
        "image_evidence": {"embedded_image_objects": images, "rendered_page": "not_checked"},
        "candidate_layer": candidate, "candidate_reason": reason,
        "semantic_accuracy": "not_assessed", "flags": flags,
    }


def select_pages(spec: str | None, count: int) -> list[int]:
    if count < 1:
        raise AuditError("no_pages", "The input contains no pages.")
    if spec is None:
        return list(range(1, count + 1))
    numbers = set()
    for part in spec.split(","):
        if not re.fullmatch(r"[0-9]+(?:-[0-9]+)?", part.strip()):
            raise AuditError("page_selection", "Use 1-based pages such as 1,3-5.")
        endpoints = [int(value) for value in part.strip().split("-")]
        first, last = endpoints[0], endpoints[-1]
        if first < 1 or last < first or last > count:
            raise AuditError("page_selection", "A selected page is outside the input page range.")
        numbers.update(range(first, last + 1))
    return sorted(numbers)


def fingerprint(path: Path, max_bytes: int) -> str:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(65536), b""):
            size += len(block)
            if size > max_bytes:
                raise AuditError("input_limit", "The input exceeds the configured byte limit.")
            digest.update(block)
    return digest.hexdigest()


def load_layers(path: Path, page_spec: str | None, policy: Policy, max_bytes: int) -> tuple[int, list[dict]]:
    with path.open("rb") as stream:
        raw = stream.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise AuditError("input_limit", "The input exceeds the configured byte limit.")
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeError, RecursionError):
        raise AuditError("invalid_json", "The layer input must be valid UTF-8 JSON.") from None
    if not isinstance(data, dict) or set(data) != {"pages"} or not isinstance(data["pages"], list):
        raise AuditError("layer_schema", "The layer input must contain only a pages array.")
    pages = data["pages"]
    for number, page in enumerate(pages, 1):
        if not isinstance(page, dict) or set(page) - {"page", "embedded_text", "ocr_text", "embedded_images"}:
            raise AuditError("layer_schema", "A page has unsupported fields or is not an object.")
        if type(page.get("page")) is not int or page["page"] != number:
            raise AuditError("layer_schema", "JSON pages must be consecutive, starting at 1.")
        if "embedded_text" not in page or any(
            page.get(key) is not None and not isinstance(page[key], str)
            for key in ("embedded_text", "ocr_text")
        ):
            raise AuditError("layer_schema", "Page text layers must be strings or null.")
        if page.get("embedded_images", "unknown") not in ("present", "absent", "unknown"):
            raise AuditError("layer_schema", "Embedded image evidence must be present, absent, or unknown.")
        if any(isinstance(page.get(key), str) and len(page[key]) > policy.max_page_chars
               for key in ("embedded_text", "ocr_text")):
            raise AuditError("page_text_limit", "A text layer exceeds the configured character limit.")
    selected = select_pages(page_spec, len(pages))
    results = [inspect_layers(number, pages[number - 1]["embedded_text"],
                              pages[number - 1].get("ocr_text"),
                              pages[number - 1].get("embedded_images", "unknown"), policy)
               for number in selected]
    return len(pages), results


def image_presence(page) -> str:
    """Inspect XObject resources, including forms, without decoding image pixels."""
    seen = set()

    def visit(resources, depth=0):
        if resources is None:
            return "absent"
        if depth > 12:
            return "unknown"
        try:
            resources = resources.get_object()
            if not isinstance(resources, dict):
                return "unknown"
            xobjects = resources.get("/XObject")
            if xobjects is None:
                return "absent"
            xobjects = xobjects.get_object()
            if not isinstance(xobjects, dict):
                return "unknown"
            incomplete = False
            for reference in xobjects.values():
                obj = reference.get_object()
                if not isinstance(obj, dict):
                    incomplete = True
                    continue
                identity = id(obj)
                if identity in seen:
                    continue
                seen.add(identity)
                if obj.get("/Subtype") == "/Image":
                    return "present"
                if obj.get("/Subtype") == "/Form":
                    result = visit(obj.get("/Resources"), depth + 1)
                    if result == "present":
                        return result
                    incomplete |= result == "unknown"
            return "unknown" if incomplete else "absent"
        except Exception:
            return "unknown"

    try:
        return visit(page.get("/Resources"))
    except Exception:
        return "unknown"


@contextmanager
def quiet_extractor():
    """Prevent library warnings from including source fragments or filenames."""
    logger = logging.getLogger("pypdf")
    handlers, propagate = logger.handlers[:], logger.propagate
    logger.handlers = [logging.NullHandler()]
    logger.propagate = False
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            yield
    finally:
        logger.handlers, logger.propagate = handlers, propagate


def load_pdf(path: Path, page_spec: str | None, policy: Policy) -> tuple[int, list[dict]]:
    try:
        from pypdf import PdfReader
    except ImportError:
        raise AuditError("missing_pypdf", "PDF mode requires pypdf; install it or use a JSON layer input.") from None
    with quiet_extractor(), path.open("rb") as stream:
        try:
            reader = PdfReader(stream, strict=False)
            if reader.is_encrypted:
                raise AuditError("encrypted_pdf", "Encrypted PDFs are not supported; use an authorized decrypted copy.")
            count = len(reader.pages)
            selected = select_pages(page_spec, count)
        except AuditError:
            raise
        except Exception:
            raise AuditError("invalid_pdf", "The PDF page tree could not be read.") from None
        results = []
        for number in selected:
            try:
                page = reader.pages[number - 1]
            except Exception:
                results.append(inspect_layers(number, None, None, "unknown", policy, extraction_failed=True))
                continue
            failed = False
            try:
                text = page.extract_text()
                # pypdf returns an empty string for an image-only/blank page.
                text = "" if text is None else text
                if not isinstance(text, str):
                    raise ValueError("Unexpected extraction result")
            except Exception:
                text, failed = None, True
            results.append(inspect_layers(number, text, None, image_presence(page), policy,
                                          extraction_failed=failed))
    return count, results


def make_report(path: Path, input_kind: str, page_spec: str | None, policy: Policy, max_bytes: int) -> dict:
    original_hash = fingerprint(path, max_bytes)
    if input_kind == "pdf":
        count, pages = load_pdf(path, page_spec, policy)
    else:
        count, pages = load_layers(path, page_spec, policy, max_bytes)
    if fingerprint(path, max_bytes) != original_hash:
        raise AuditError("input_changed", "The input changed during the audit; no report was produced.")
    flags = Counter(flag for page in pages for flag in page["flags"])
    failures = sum("text_extraction_failed" in page["flags"]
                   or "image_resource_inspection_incomplete" in page["flags"] for page in pages)
    return {
        "schema_version": 1, "input_kind": input_kind,
        "input_sha256": original_hash, "total_pages": count,
        "selected_pages": [page["page"] for page in pages],
        "policy": asdict(policy),
        "summary": {"audited_pages": len(pages), "pages_with_incomplete_inspection": failures,
                    "candidate_layers": dict(Counter(page["candidate_layer"] for page in pages)),
                    "flag_counts": dict(sorted(flags.items()))},
        "semantic_accuracy": "not_assessed", "pages": pages,
    }


def positive_int(value: str) -> int:
    try:
        number = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("must be a positive integer") from None
    if number < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return number


def fraction(value: str) -> float:
    try:
        number = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError("must be greater than 0 and at most 1") from None
    if not 0 < number <= 1:
        raise argparse.ArgumentTypeError("must be greater than 0 and at most 1")
    return number


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--format", choices=("pdf", "json"), help="default: json for .json, otherwise pdf")
    parser.add_argument("--pages", help="physical 1-based page numbers, e.g. 1,3-5; default: all")
    parser.add_argument("--output", type=Path, help="create a new JSON report; default: stdout; never overwrite")
    parser.add_argument("--max-input-mib", type=positive_int, default=64)
    parser.add_argument("--max-page-chars", type=positive_int, default=1_000_000)
    parser.add_argument("--glyph-min-count", type=positive_int, default=4)
    parser.add_argument("--glyph-fraction", type=fraction, default=0.25)
    parser.add_argument("--damage-min-count", type=positive_int, default=3)
    parser.add_argument("--damage-fraction", type=fraction, default=0.08)
    parser.add_argument("--sparse-alnum", type=positive_int, default=64)
    args = parser.parse_args(argv)
    policy = Policy(args.glyph_min_count, args.glyph_fraction, args.damage_min_count,
                    args.damage_fraction, args.sparse_alnum, args.max_page_chars)
    try:
        kind = args.format or ("json" if args.input.suffix.lower() == ".json" else "pdf")
        report = make_report(args.input, kind, args.pages, policy, args.max_input_mib * 1024 * 1024)
        content = json.dumps(report, indent=2, ensure_ascii=True) + "\n"
        if args.output is None:
            sys.stdout.write(content)
        else:
            with args.output.open("x", encoding="utf-8", newline="\n") as stream:
                stream.write(content)
        return 1 if report["summary"]["pages_with_incomplete_inspection"] else 0
    except AuditError as exc:
        error = {"code": exc.code, "message": str(exc)}
    except FileExistsError:
        error = {"code": "output_exists", "message": "The report destination already exists; choose a new file."}
    except OSError:
        error = {"code": "file_io", "message": "An input or output file could not be accessed."}
    except (ValueError, RecursionError):
        error = {"code": "invalid_input", "message": "The input could not be processed."}
    sys.stderr.write(json.dumps({"error": error}) + "\n")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
