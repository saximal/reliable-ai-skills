#!/usr/bin/env python3
"""Create fictional text layers and a tiny PDF without third-party packages."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


NOTE = (
    "Synthetic laboratory note. The sample interval is 12 ms. "
    "Record the interval and compare it with the calibration table. "
    "This document contains fictional measurements for a local demonstration."
)
OCR = (
    "Synthetic image page candidate. A technician records the calibration step "
    "and a fictional sample count of 24. This text is fabricated to test layer "
    "selection; it was not recognized by an OCR engine."
)


def demo_layers() -> dict:
    return {"pages": [
        {"page": 1, "embedded_text": NOTE, "embedded_images": "absent"},
        {"page": 2, "embedded_text": " ".join(f"(cid:{number})" for number in range(10, 25)),
         "embedded_images": "absent"},
        {"page": 3, "embedded_text": "", "ocr_text": OCR, "embedded_images": "present"},
        {"page": 4, "embedded_text": NOTE, "ocr_text": NOTE.replace("12 ms", "72 ms"),
         "embedded_images": "absent"},
        {"page": 5, "embedded_text": "Figure 2", "embedded_images": "absent"},
    ]}


def demo_pdf() -> bytes:
    """A standards-shaped PDF: text, visible glyph codes, raster-only, text, labels.

    The raster is only a colored square, not a real scanned document. Keeping it
    deliberately simple avoids distributing external fonts, scans, or textbooks.
    """
    objects: list[bytes] = []

    def add(value: bytes) -> int:
        objects.append(value)
        return len(objects)

    add(b"<< /Type /Catalog /Pages 2 0 R >>")
    add(b"")  # Filled after page object IDs are known.
    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    pixels = b"\x20\x80\xb0"
    image = add(b"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 "
                b"/ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\n"
                + pixels + b"\nendstream")
    page_ids = []
    for record in demo_layers()["pages"]:
        if record["page"] == 3:
            commands = b"q 200 0 0 200 72 480 cm /Im0 Do Q"
            resources = f"<< /XObject << /Im0 {image} 0 R >> >>".encode("ascii")
        else:
            # Keep long fictional prose on multiple lines inside the page.
            text = record["embedded_text"]
            lines = [text[offset:offset + 70] for offset in range(0, len(text), 70)]
            escaped = [line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
                       for line in lines]
            commands = ("BT /F1 12 Tf 72 720 Td 16 TL "
                        + " T* ".join(f"({line}) Tj" for line in escaped) + " ET").encode("ascii")
            resources = f"<< /Font << /F1 {font} 0 R >> >>".encode("ascii")
        content = add(f"<< /Length {len(commands)} >>\nstream\n".encode("ascii")
                      + commands + b"\nendstream")
        page_ids.append(add(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources "
                            + resources + f" /Contents {content} 0 R >>".encode("ascii")))
    objects[1] = (f"<< /Type /Pages /Count {len(page_ids)} /Kids ["
                  + " ".join(f"{number} 0 R" for number in page_ids) + "] >>").encode("ascii")
    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, value in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(f"{number} 0 obj\n".encode("ascii") + value + b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode("ascii"))
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend((f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\n"
                   f"startxref\n{xref}\n%%EOF\n").encode("ascii"))
    return bytes(output)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, help="a new directory; never overwrite an existing directory")
    args = parser.parse_args(argv)
    try:
        args.destination.mkdir(parents=True, exist_ok=False)
        (args.destination / "pages.json").write_text(
            json.dumps(demo_layers(), indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
        (args.destination / "sample.pdf").write_bytes(demo_pdf())
    except FileExistsError:
        sys.stderr.write("The destination already exists; choose a new directory.\n")
        return 2
    except OSError:
        sys.stderr.write("The demonstration files could not be created.\n")
        return 2
    print("Created fictional pages.json and sample.pdf in the new destination directory.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
