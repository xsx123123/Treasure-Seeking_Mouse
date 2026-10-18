"""Real PDFProcessor integration, using existing platform dependencies only.

PAPER_TEST_PDF optionally selects a local real paper for the extra round-trip test.
Run with the OmicHub virtualenv; dependency absence is an explicit skip.
"""
import hashlib
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

from test_paper_evidence import paper

HAS_PLATFORM = (importlib.util.find_spec("pypdf") is not None
                and importlib.util.find_spec("cygnusx") is not None)


@unittest.skipUnless(HAS_PLATFORM, "requires existing OmicHub PDFProcessor environment")
class PDFIntegrationTests(unittest.TestCase):
    def setUp(self):
        from pypdf import PdfWriter
        self.writer = PdfWriter()
        self.directory = tempfile.TemporaryDirectory(prefix="paper-pdf-test-")
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "source.pdf"

    def test_blank_pdf_reports_possible_ocr(self):
        self.writer.add_blank_page(width=612, height=792)
        self.writer.write(self.path)
        result = paper.parse_pdf(self.path)
        self.assertEqual(result["extraction_status"], "needs_ocr")
        self.assertEqual(result["possible_ocr_pages"], [1])
        self.assertEqual(result["mentions"], [])

    def test_encrypted_pdf_rejected(self):
        self.writer.add_blank_page(width=612, height=792)
        self.writer.encrypt("test-password")
        self.writer.write(self.path)
        with self.assertRaisesRegex(ValueError, "encrypted"):
            paper.parse_pdf(self.path)

    def test_page_limit_rejected_before_processor(self):
        for _ in range(paper.MAX_PAGES + 1):
            self.writer.add_blank_page(width=612, height=792)
        self.writer.write(self.path)
        with self.assertRaisesRegex(ValueError, "page count"):
            paper.parse_pdf(self.path)

    def test_malformed_pdf_rejected(self):
        from pypdf.errors import PdfReadError
        self.path.write_bytes(b"%PDF-1.7\ntruncated")
        with self.assertRaises(PdfReadError):
            paper.parse_pdf(self.path)

    @unittest.skipUnless(os.environ.get("PAPER_TEST_PDF"), "set PAPER_TEST_PDF for a real paper")
    def test_real_paper_exact_evidence_round_trip(self):
        path = Path(os.environ["PAPER_TEST_PDF"])
        result = paper.parse_pdf(path)
        self.assertIn(result["extraction_status"], ("succeeded", "partial"))
        self.assertEqual(result["source"]["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
        pages = {p["page_number"]: p["text"] for p in result["pages"]}
        for evidence in result["evidence"]:
            self.assertEqual(pages[evidence["page"]][evidence["start"]:evidence["end"]], evidence["quote"])
            digest = hashlib.sha256(
                f"{paper.INDEX_VERSION}:{result['source']['sha256']}:{evidence['page']}:"
                f"{evidence['start']}:{evidence['end']}".encode()
            ).hexdigest()
            self.assertEqual(evidence["id"], digest)
        for mention in result["mentions"]:
            self.assertEqual(mention["verification"], "not_checked")
            self.assertIsNone(mention["match_tier"])


if __name__ == "__main__":
    unittest.main()
