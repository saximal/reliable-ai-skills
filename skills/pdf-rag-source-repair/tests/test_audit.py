"""Offline behavioral tests; no OCR engine, network, or provider is used."""

from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import audit_pdf as audit
import make_demo


class EncodingTests(unittest.TestCase):
    def setUp(self):
        self.policy = audit.Policy()

    def test_multilingual_numbers_and_short_labels_are_not_encoding_damage(self):
        for text in ("Figure 2", "42 + 17 = 59", "Пример текста 12 мг", "測定値 12 mg", "α β γ 12 μm"):
            with self.subTest(text=text):
                self.assertEqual(audit.measure(text, self.policy)["encoding"], "no_explicit_damage")

    def test_glyph_names_do_not_become_usable_by_accumulating_characters(self):
        for token in ("(cid:14)", "(gid: 45)", "/g37", "/gid123"):
            metrics = audit.measure(" ".join([token] * 30), self.policy)
            self.assertEqual(metrics["encoding"], "suspect")
            self.assertFalse(audit.usable(metrics))

    def test_single_literal_example_in_prose_is_allowed(self):
        metrics = audit.measure(make_demo.NOTE + " Syntax example: (cid:12).", self.policy)
        self.assertEqual(metrics["encoding"], "no_explicit_damage")

    def test_replacement_private_use_and_unexpected_controls_are_suspect(self):
        for bad in ("\ufffd", "\ue321", "\ud800", "\x00", "\x0b"):
            metrics = audit.measure("AB " + bad * 20, self.policy)
            self.assertIn("unicode_damage", metrics["encoding_reasons"])
            self.assertLessEqual(metrics["damage_fraction"], 1)
        self.assertEqual(audit.measure("Text\nmore\r\ttext", self.policy)["damaged_characters"], 0)

    def test_empty_and_missing_are_different(self):
        self.assertEqual(audit.measure(" \t\n", self.policy)["encoding"], "empty")
        self.assertEqual(audit.measure(None, self.policy)["encoding"], "unavailable")

    def test_readability_does_not_claim_semantic_accuracy_or_merge_layers(self):
        result = audit.inspect_layers(1, make_demo.NOTE, make_demo.NOTE.replace("12 ms", "72 ms"),
                                      "absent", self.policy)
        self.assertEqual(result["candidate_layer"], "embedded")
        self.assertEqual(result["semantic_accuracy"], "not_assessed")
        self.assertEqual(result["ocr"]["semantic_accuracy"], "not_assessed")
        serialized = json.dumps(result)
        self.assertNotIn("12 ms", serialized)
        self.assertNotIn("72 ms", serialized)

    def test_denser_ocr_is_candidate_but_short_embedded_labels_are_kept_without_it(self):
        result = audit.inspect_layers(1, "Fig 2", make_demo.OCR, "present", self.policy)
        self.assertEqual(result["candidate_layer"], "ocr")
        result = audit.inspect_layers(1, "Fig 2", None, "absent", self.policy)
        self.assertEqual(result["candidate_layer"], "embedded")

    def test_corrupt_ocr_cannot_displace_readable_labels(self):
        result = audit.inspect_layers(1, "Fig 2", "/gid12 " * 100, "present", self.policy)
        self.assertEqual(result["candidate_layer"], "embedded")

    def test_image_only_is_a_suspicion_and_missing_image_objects_still_need_review(self):
        for images, expected in (("present", "image_only_suspected"),
                                 ("absent", "render_review_needed"), ("unknown", "render_review_needed")):
            result = audit.inspect_layers(1, "", None, images, self.policy)
            self.assertIn(expected, result["flags"])
            self.assertEqual(result["image_evidence"]["rendered_page"], "not_checked")
            self.assertEqual(result["candidate_layer"], "none")

    def test_threshold_override_is_observable(self):
        text = "(cid:1) " * 4
        self.assertEqual(audit.measure(text, self.policy)["encoding"], "suspect")
        self.assertEqual(audit.measure(text, audit.Policy(glyph_min_count=5))["encoding"], "no_explicit_damage")


class ResourceTests(unittest.TestCase):
    class Object(dict):
        def get_object(self):
            return self

    def test_nested_form_image_is_detected_without_pixel_decoding(self):
        image = self.Object({"/Subtype": "/Image"})
        form = self.Object({"/Subtype": "/Form", "/Resources": self.Object({"/XObject": self.Object({"/Im": image})})})
        page = {"/Resources": self.Object({"/XObject": self.Object({"/Form": form})})}
        self.assertEqual(audit.image_presence(page), "present")

    def test_resource_failure_stays_unknown(self):
        class Broken:
            def get_object(self):
                raise RuntimeError("PRIVATE source fragment")
        self.assertEqual(audit.image_presence({"/Resources": Broken()}), "unknown")
        self.assertEqual(audit.image_presence({}), "absent")


class CliTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.input = self.directory / "PRIVATE-filename.json"
        self.input.write_text(json.dumps(make_demo.demo_layers()), encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def run_cli(self, *args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = audit.main(list(map(str, args)))
        return code, stdout.getvalue(), stderr.getvalue()

    def test_clean_example_reports_per_page_without_source_text_or_paths(self):
        original = self.input.read_bytes()
        code, stdout, stderr = self.run_cli(self.input)
        self.assertEqual((code, stderr), (0, ""))
        report = json.loads(stdout)
        self.assertEqual(report["selected_pages"], [1, 2, 3, 4, 5])
        self.assertEqual([page["candidate_layer"] for page in report["pages"]],
                         ["embedded", "none", "ocr", "embedded", "embedded"])
        self.assertNotIn("PRIVATE-filename", stdout)
        self.assertNotIn("Synthetic laboratory", stdout)
        self.assertNotIn("(cid:10)", stdout)
        self.assertEqual(self.input.read_bytes(), original)

    def test_page_selection_normalizes_duplicates_and_checks_bounds(self):
        code, stdout, _ = self.run_cli(self.input, "--pages", "3,1-2,3")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(stdout)["selected_pages"], [1, 2, 3])
        for selection in ("0", "6", "2-1", "1-999999999", "1,,2"):
            code, stdout, stderr = self.run_cli(self.input, "--pages", selection)
            self.assertEqual(code, 2)
            self.assertEqual(stdout, "")
            self.assertEqual(json.loads(stderr)["error"]["code"], "page_selection")

    def test_existing_output_and_source_are_never_overwritten(self):
        original = self.input.read_bytes()
        code, stdout, stderr = self.run_cli(self.input, "--output", self.input)
        self.assertEqual((code, stdout), (2, ""))
        self.assertEqual(json.loads(stderr)["error"]["code"], "output_exists")
        self.assertEqual(self.input.read_bytes(), original)

    def test_missing_input_error_is_sanitized(self):
        code, stdout, stderr = self.run_cli(self.directory / "PRIVATE-missing.pdf")
        self.assertEqual((code, stdout), (2, ""))
        self.assertEqual(json.loads(stderr)["error"]["code"], "file_io")
        self.assertNotIn("PRIVATE", stderr)
        self.assertNotIn("Traceback", stderr)

    def test_unavailable_pypdf_is_actionable_and_does_not_break_json_mode(self):
        pdf = self.directory / "sample.pdf"
        pdf.write_bytes(make_demo.demo_pdf())
        with patch.dict(sys.modules, {"pypdf": None}):
            code, stdout, stderr = self.run_cli(pdf)
        self.assertEqual((code, stdout), (2, ""))
        self.assertEqual(json.loads(stderr)["error"]["code"], "missing_pypdf")
        self.assertEqual(self.run_cli(self.input)[0], 0)

    def test_invalid_json_does_not_echo_its_content(self):
        self.input.write_text('{"pages": PRIVATE CONTENT}', encoding="utf-8")
        code, stdout, stderr = self.run_cli(self.input)
        self.assertEqual((code, stdout), (2, ""))
        self.assertEqual(json.loads(stderr)["error"]["code"], "invalid_json")
        self.assertNotIn("PRIVATE", stderr)

    def test_layer_schema_rejects_wrong_text_types_and_page_identifiers(self):
        for pages in ([{"page": True, "embedded_text": "x"}],
                      [{"page": 1, "embedded_text": ["x"]}],
                      [{"page": 2, "embedded_text": "x"}],
                      [{"page": 1, "embedded_text": "x", "other": "private"}]):
            self.input.write_text(json.dumps({"pages": pages}), encoding="utf-8")
            code, stdout, stderr = self.run_cli(self.input)
            self.assertEqual((code, stdout), (2, ""))
            self.assertEqual(json.loads(stderr)["error"]["code"], "layer_schema")

    def test_size_limits_fail_before_report_publication(self):
        code, stdout, stderr = self.run_cli(self.input, "--max-page-chars", "5")
        self.assertEqual((code, stdout), (2, ""))
        self.assertEqual(json.loads(stderr)["error"]["code"], "page_text_limit")
        with self.assertRaises(audit.AuditError) as caught:
            audit.make_report(self.input, "json", None, audit.Policy(), max_bytes=10)
        self.assertEqual(caught.exception.code, "input_limit")

    def test_source_change_discards_report(self):
        with patch.object(audit, "fingerprint", side_effect=["a" * 64, "b" * 64]):
            code, stdout, stderr = self.run_cli(self.input)
        self.assertEqual((code, stdout), (2, ""))
        self.assertEqual(json.loads(stderr)["error"]["code"], "input_changed")

    def test_incomplete_extraction_has_distinct_exit_status(self):
        page = audit.inspect_layers(1, None, None, "unknown", audit.Policy(), extraction_failed=True)
        with patch.object(audit, "load_pdf", return_value=(1, [page])):
            code, stdout, stderr = self.run_cli(self.input, "--format", "pdf")
        self.assertEqual((code, stderr), (1, ""))
        self.assertEqual(json.loads(stdout)["summary"]["pages_with_incomplete_inspection"], 1)


@unittest.skipUnless(importlib.util.find_spec("pypdf"), "optional pypdf is not installed")
class PdfIntegrationTests(unittest.TestCase):
    def test_real_generated_pdf_page_extraction_and_image_evidence(self):
        with TemporaryDirectory() as temp:
            source = Path(temp) / "sample.pdf"
            source.write_bytes(make_demo.demo_pdf())
            original = source.read_bytes()
            report = audit.make_report(source, "pdf", None, audit.Policy(), 1024 * 1024)
            self.assertEqual(report["total_pages"], 5)
            self.assertEqual(report["summary"]["pages_with_incomplete_inspection"], 0)
            self.assertIn("embedded_repeated_glyph_codes", report["pages"][1]["flags"])
            self.assertIn("image_only_suspected", report["pages"][2]["flags"])
            self.assertEqual(report["pages"][2]["candidate_layer"], "none")
            self.assertEqual(source.read_bytes(), original)

    def test_malformed_pdf_is_sanitized(self):
        with TemporaryDirectory() as temp:
            source = Path(temp) / "private.pdf"
            source.write_bytes(b"PRIVATE SOURCE CONTENT")
            stdout, stderr = io.StringIO(), io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                code = audit.main([str(source)])
            self.assertEqual(code, 2)
            self.assertNotIn("PRIVATE", stdout.getvalue() + stderr.getvalue())
            self.assertEqual(json.loads(stderr.getvalue())["error"]["code"], "invalid_pdf")

    def test_encrypted_pdf_has_an_actionable_error(self):
        from pypdf import PdfReader, PdfWriter
        with TemporaryDirectory() as temp:
            source = Path(temp) / "locked.pdf"
            writer = PdfWriter()
            reader = PdfReader(io.BytesIO(make_demo.demo_pdf()))
            for page in reader.pages:
                writer.add_page(page)
            writer.encrypt("fictional-example-password")
            with source.open("wb") as stream:
                writer.write(stream)
            stdout, stderr = io.StringIO(), io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                code = audit.main([str(source)])
            self.assertEqual((code, stdout.getvalue()), (2, ""))
            self.assertEqual(json.loads(stderr.getvalue())["error"]["code"], "encrypted_pdf")


class DemoTests(unittest.TestCase):
    def test_generation_is_deterministic_and_refuses_existing_destination(self):
        self.assertEqual(make_demo.demo_pdf(), make_demo.demo_pdf())
        with TemporaryDirectory() as temp, redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            destination = Path(temp) / "demo"
            self.assertEqual(make_demo.main([str(destination)]), 0)
            original = (destination / "sample.pdf").read_bytes()
            self.assertEqual(make_demo.main([str(destination)]), 2)
            self.assertEqual((destination / "sample.pdf").read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
