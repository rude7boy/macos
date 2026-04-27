import json
import tempfile
import unittest
from pathlib import Path

from app.runner import run
from app.scraper import CaixaScraper
from app.validation import StrictProdConfig, validate_items, validate_strict_prod


class ValidationSystemTests(unittest.TestCase):
    def test_extract_from_html_fixture(self):
        html = Path("fixtures/caixa_sample.html").read_text(encoding="utf-8")
        scraper = CaixaScraper()
        items = scraper.extract_from_html(html)

        self.assertEqual(len(items), 2)
        self.assertEqual(items[0].titulo, "Apartamento 2 quartos")
        self.assertEqual(items[0].cidade, "Campinas")
        self.assertEqual(items[0].estado, "SP")
        self.assertEqual(items[0].valor_venda, 200000.00)

    def test_validation_rules(self):
        html = Path("fixtures/caixa_sample.html").read_text(encoding="utf-8")
        scraper = CaixaScraper()
        items = scraper.extract_from_html(html)
        result = validate_items(items, min_items=2)

        self.assertTrue(result.success)
        self.assertEqual(result.error_count, 0)
        self.assertEqual(result.total_items, 2)

    def test_validate_only_generates_report(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            report_path = Path(tmp_dir) / "validation_report.json"
            code = run(
                [
                    "--validate-only",
                    "--html-file",
                    "fixtures/caixa_sample.html",
                    "--min-items",
                    "2",
                    "--report-path",
                    str(report_path),
                ]
            )

            self.assertEqual(code, 0)
            self.assertTrue(report_path.exists())
            payload = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["error_count"], 0)
            self.assertEqual(payload["total_items"], 2)

    def test_strict_prod_detects_abrupt_drop(self):
        html = Path("fixtures/caixa_sample.html").read_text(encoding="utf-8")
        scraper = CaixaScraper()
        items = scraper.extract_from_html(html)
        strict = validate_strict_prod(
            items,
            baseline_total_items=20,
            config=StrictProdConfig(max_drop_ratio=0.6),
        )
        self.assertGreater(strict.error_count, 0)

    def test_validate_only_strict_prod_passes_with_baseline(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            report_path = Path(tmp_dir) / "validation_report.json"
            baseline_path = Path(tmp_dir) / "last_validation_report.json"
            baseline_path.write_text(
                json.dumps({"total_items": 2}, ensure_ascii=False),
                encoding="utf-8",
            )
            code = run(
                [
                    "--validate-only",
                    "--strict-prod",
                    "--html-file",
                    "fixtures/caixa_sample.html",
                    "--min-items",
                    "2",
                    "--report-path",
                    str(report_path),
                    "--baseline-report-path",
                    str(baseline_path),
                    "--min-price-coverage",
                    "1.0",
                    "--min-location-coverage",
                    "1.0",
                    "--min-states",
                    "2",
                    "--max-drop-ratio",
                    "0.9",
                ]
            )
            self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
