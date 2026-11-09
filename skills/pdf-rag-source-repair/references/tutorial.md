# Diagnose a missing PDF source without rewriting it

This example uses only fictional content generated locally. It demonstrates
page localization and text-layer decisions, not OCR accuracy or retrieval quality.
Run commands from this skill's directory. They work in PowerShell or a POSIX
shell with Python 3.10 or later available as `python`.

## 1. Run the dependency-free example

```sh
python scripts/make_demo.py demo
python scripts/audit_pdf.py demo/pages.json --output demo/layers-report.json
python -m unittest discover -s tests -v
```

Use a fresh destination name when rerunning. The generator refuses an existing
directory, and the audit refuses to overwrite any existing report. The generated
files are `demo/pages.json` and `demo/sample.pdf`; no external documents, fonts,
OCR tools, services, or credentials are used. The report contains metrics and
fixed diagnostic codes, with no source text or file paths. It still contains an
input fingerprint and page characteristics, so keep real-document reports private
when those metadata are sensitive.

The five fictional layer records produce these results under the default policy:

| Physical page | Observation | Candidate layer | Meaning |
| --- | --- | --- | --- |
| 1 | Substantial embedded text | `embedded` | No explicit encoding damage detected |
| 2 | Repeated `(cid:...)` tokens | `none` | Alphanumeric volume did not establish readable prose |
| 3 | Empty embedded text, image evidence, fabricated OCR text | `ocr` | A readable OCR candidate exists; its correctness remains unassessed |
| 4 | Readable embedded text and differing OCR numbers | `embedded` | Retain one layer; neither candidate is semantically certified |
| 5 | Short figure label | `embedded` | Sparse text is a review clue, not automatically corruption |

Page 4 deliberately differs by `12 ms` versus `72 ms`. The audit does not detect
which value is correct and never concatenates the two. Page 3's JSON OCR is
fabricated for testing; it did not come from an OCR engine and does not describe
the colored square in the generated PDF.

## 2. Exercise real PDF extraction

Only PDF mode needs `pypdf`. JSON mode and the core tests use the standard library.
If the dependency is not already available, install it in an environment of your
choice; the audit never installs packages itself. A tested optional version is:

```sh
python -m pip install pypdf==6.10.0
python scripts/audit_pdf.py demo/sample.pdf --pages 1-3 --output demo/pdf-report.json
python -m unittest discover -s tests -v
```

Installing a package may require network access; it is not needed for the first
example. The test suite skips PDF integration tests if `pypdf` is absent. With it
installed, the tests parse the actual generated PDF and verify glyph-code flags
and image-object evidence. No OCR engine or network service runs during tests.

In PDF mode, page 3 has an empty text layer and a raster image, so its candidate is
`none` and its flags include `image_only_suspected`. The script did not recognize
the picture. The PDF's page 2 contains visible printed glyph-code strings, which
test detection of extractor output patterns; it is not a simulation of every
broken font mapping. This small document does not establish coverage of large,
complex, or damaged PDFs.

On a real source, choose a small page set first:

```sh
python scripts/audit_pdf.py document.pdf --pages 2,5-7
```

Page numbers are physical, 1-based positions, not printed labels. Duplicates are
removed and pages are sorted. Without `--pages`, all pages are audited read-only.
`--format pdf` or `--format json` overrides extension-based selection.

## 3. Read a report correctly

Every report includes `schema_version`, `input_kind`, `input_sha256`,
`selected_pages`, the exact heuristic `policy`, per-page observations, and a
summary. The input is hashed before and after inspection; a changed input causes
failure before report publication. For JSON mode, the hash identifies the JSON
file, not the PDF from which someone may have exported those layers. Keep and
verify the PDF checksum separately when tracing provenance.

Each layer records character counts, glyph and Unicode damage ratios, an
`encoding` classification, and a `density` classification:

- `no_explicit_damage` means the detector found neither of its explicit damage
  patterns. It does not establish reading order, language quality, or correct OCR.
- `suspect` identifies repeated glyph codes or enough replacement, private-use,
  unpaired surrogate, or unexpected control characters. Literal code examples
  and legitimate custom font symbols can cause false positives; review the rendered page.
- `empty` means the layer has no non-whitespace characters.
- `unavailable` means no layer was provided or extraction failed. A supplied
  empty string and a missing layer are distinct observations.
- `sparse` means fewer alphanumeric characters than the configured threshold.
  Numbers, short labels, multilingual text, and formulas need no dictionary to
  remain eligible for review. Meaningful diagrams may still lack searchable prose.

`candidate_layer` recommends `embedded`, `ocr`, or `none` on encoding/density
grounds only. Readable embedded text is preferred; a substantial readable OCR
candidate can replace sparse embedded labels in the recommendation. This is an
advisory choice for review and makes no changes. Every layer and page keeps
`semantic_accuracy: "not_assessed"`.

Image evidence reports only whether an embedded image XObject was found while
walking the page's resources, including nested forms. It does not prove that the
page is a scan or contains a useful figure. `absent` does not establish that OCR
is unnecessary: vector outlines and unusual text rendering can still need a
rendered-page inspection. `unknown` is an incomplete inspection, never a claim
that the page contains no images. `rendered_page` is always `not_checked` because
this helper does not render or open images.

Exit status is separate from quality:

| Exit | Meaning |
| --- | --- |
| `0` | Inspection completed, even if corruption or empty text was flagged |
| `1` | A report was produced, but extraction or image-resource inspection was incomplete for a page |
| `2` | Configuration, dependency, file, size, encryption, or input-format failure; no valid report was produced |

Fixed error codes and messages go to stderr. Extractor exception text, document
fragments, filenames, and tracebacks are omitted. Output goes to stdout unless
`--output` requests a new JSON file.

## 4. Compare private layer exports

To compare observations from your existing extraction/OCR pipeline without a
PDF dependency, create a UTF-8 JSON input with this exact top-level shape:

```json
{
  "pages": [
    {
      "page": 1,
      "embedded_text": "Figure 2",
      "ocr_text": "An optional independently obtained OCR candidate.",
      "embedded_images": "present"
    }
  ]
}
```

Pages must be consecutive starting at 1. `embedded_text` is required and is a
string or `null`. `ocr_text` is optional, also a string or `null`; no OCR is run
to fill it. `embedded_images` is optional and is `present`, `absent`, or `unknown`
(default). Unknown image evidence leads to incomplete inspection status. The
input JSON contains private raw text; the generated report does not repeat it.

The thresholds are starting heuristics, not corpus-independent quality gates.
Tune them using representative reviewed pages and record the resulting policy:

```sh
python scripts/audit_pdf.py demo/pages.json --glyph-min-count 6 --glyph-fraction 0.3 --sparse-alnum 100
```

`--damage-min-count` and `--damage-fraction` tune Unicode damage checks.
`--max-input-mib` defaults to 64 MiB and `--max-page-chars` to 1,000,000 per layer.
These bounds reject large files/layers; they do not harden a parser against hostile
PDFs or bound decompression, extraction memory, CPU, or page-tree expansion.
Use your normal isolated document-processing environment and resource limits for
untrusted PDFs. Encrypted PDFs are rejected; use an authorized decrypted copy.

## 5. Hand off a limited repair

The audit does not repair files or update an application. A useful handoff names
the verified PDF hash, exact page set, observed defect, candidate extraction
method, and a small list of facts to compare visually. Include the existing
chunk/index/cache versions so old entries can be located.

If OCR is appropriate, render only the selected pages using an available local
renderer, run local OCR with the required language packs, and keep both raw layers
plus the source/page provenance. The helper does not bundle those tools or assume
a database schema. Check their availability before proposing runnable commands.
Review numbers, units, minus signs, superscripts, table alignment, figure labels,
and reading order against the page. A successful OCR command proves completion,
not accuracy.

After review, stage a coherent chosen layer and affected chunks. Publish the
matching index/cache version consistently, retaining the previous version for
rollback. Re-run known queries and inspect the exact source payload sent to the
model; confirm support for images if those are required. A retrieval failure with
good source text may instead concern filters, chunking, indexing, or request
construction. Do not mass-reprocess a library merely because a heuristic fires.
