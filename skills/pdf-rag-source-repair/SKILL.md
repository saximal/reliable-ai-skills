---
name: pdf-rag-source-repair
description: Diagnose page-level PDF extraction and RAG source failures, compare embedded and OCR text layers, and plan bounded source repair when visible content is missing from retrieval or encoded as glyph codes.
---

# PDF RAG source repair

Find where usable source evidence disappears before changing prompts or replacing a model. These instructions work with any AI assistant or as a manual checklist; the optional Python tools run locally.

## Diagnose

1. Identify the exact source file and its checksum, affected physical PDF pages (1-based), expected facts, and the failing query. Distinguish physical pages from printed page labels.
2. Compare the rendered page, embedded text, and any OCR candidate separately. Run `python scripts/audit_pdf.py document.pdf --pages 2,5-7` for a metadata-only report. For private exported text layers or an offline demonstration, use the JSON format in [the tutorial](references/tutorial.md). Read the report's limitations before interpreting its flags.
3. Trace the same source version through selected page text, chunks, index entries, caches, retrieved results, and the actual model request. Check page IDs and source hashes, not just processing counters. If retrieval includes the right page but the request drops its text or image, repair that handoff. Check that the chosen model accepts images before relying on page images.
4. Treat repeated `(cid:...)`, `/g123`, `/gid123`, replacement characters, private-use characters, and unexpected controls as encoding clues. A large character count does not establish readable text. Sparse or empty text can require visual review even when no embedded image object is detected: outlines, vector text, blank pages, and failed extraction need different treatment.

## Bound the repair

- Preserve the source and separate embedded/OCR observations. Prefer one coherent layer per page; do not append differing OCR to embedded prose. A denser layer is only a candidate until page review verifies reading order, numbers, units, symbols, tables, and labels.
- Distinguish **encoding readability**, **searchable text availability**, **image evidence**, and **semantic accuracy**. The script assesses encoding and density heuristically. It neither renders pages nor runs OCR, and it always reports semantic accuracy as unassessed.
- Propose an explicit source hash and page set before running OCR or changing stored content. Use local rendering/OCR only when available and within the user's scope. Diagnose offline first; do not upload source pages or invoke paid services implicitly.
- Stage repaired candidates. Rebuild only the affected chunks/index/cache entries after review, publish a consistent version, and retain rollback data. A code fix does not rewrite already published chunks or invalidate stale caches.
- Validate with a small set of known page facts and retrieval queries against the rebuilt source. Report what remains unverified. Processing completion or valid UTF-8 does not establish OCR accuracy.

The bundled audit never edits a PDF, runs OCR, contacts a service, or rebuilds an index. It does not trigger bulk repair. See [the tutorial](references/tutorial.md) for a clean example, dependencies, report meanings, and a limited repair handoff.
