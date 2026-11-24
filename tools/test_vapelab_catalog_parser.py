"""Offline parser tests: extraction, source evidence and Qwen CSV package."""
from __future__ import annotations

import csv
import json
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlparse

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

from vapelab_catalog_parser import (  # noqa: E402
    extract_categories,
    extract_collection_cards,
    extract_product_page,
    Crawler,
    package_qwen_results,
    raw_row_from_manifest,
    validate_qwen_enrichment,
)
from bs4 import BeautifulSoup  # noqa: E402


class CatalogExtractionTests(unittest.TestCase):
    def test_categories_keep_parent_and_subcategory(self):
        html = """
        <ul>
          <li><a href="/collection/heaters">Нагреватели табака</a>
            <ul><li><a href="/collection/glo-air">Glo Air</a></li></ul>
          </li>
        </ul>
        """
        categories = extract_categories(BeautifulSoup(html, "html.parser"), "https://vapelab.site")
        self.assertEqual(categories["https://vapelab.site/collection/heaters"]["category_name"], "Нагреватели табака")
        self.assertEqual(categories["https://vapelab.site/collection/glo-air"]["category_name"], "Нагреватели табака")
        self.assertEqual(categories["https://vapelab.site/collection/glo-air"]["subcategory_name"], "Glo Air")

    def test_product_extraction_preserves_source_evidence_and_price_conflict(self):
        collection_html = """
        <div class="product-card">
          <a href="/product/glo-air-white"><span>Glo Air Белый</span>
            <span class="price">1 300 ₽</span><span>В наличии</span></a>
        </div>
        """
        collection = extract_collection_cards(
            BeautifulSoup(collection_html, "html.parser"), "https://vapelab.site/collection/glo-air"
        )
        card = collection["https://vapelab.site/product/glo-air-white"]
        self.assertEqual(card["price_raw"], "1 300 ₽")
        self.assertEqual(card["availability_label_raw"], "В наличии")

        product_html = '''
        <html><head>
          <title>Glo Air Белый — VAPELAB</title>
          <meta property="og:title" content="Glo Air Белый">
          <meta property="og:description" content="Нагреватель табака, описание со страницы.">
          <link rel="canonical" href="https://vapelab.site/product/glo-air-white">
          <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Product","name":"Glo Air Белый",
           "sku":"GA-WHITE","brand":{"@type":"Brand","name":"Glo"},
           "description":"Корпус из анодированного алюминия, масса 76 г.",
           "image":["https://cdn.insales-shop.ru/images/glo-white.webp"],
           "offers":{"@type":"Offer","price":"1299","priceCurrency":"RUB","availability":"https://schema.org/PreOrder"},
           "material":"Анодированный алюминий","weight":"76 g"}
          </script>
        </head><body><main><h1>Glo Air Белый</h1><div class="product-description">
          <p>Корпус из анодированного алюминия с покрытием Soft touch. Время зарядки 90 минут.</p>
          <p>Совместимость: Neo Demi, Kent, Baisha</p><p>Цвет: Белый</p>
        </div></main></body></html>
        '''
        extracted = extract_product_page(
            BeautifulSoup(product_html, "html.parser"),
            "https://vapelab.site/product/glo-air-white",
            {"category_name": "Нагреватели табака", "subcategory_name": "Glo Air", "category_path": "Нагреватели табака / Glo Air"},
            card,
        )
        self.assertEqual(extracted["name"], "Glo Air Белый")
        self.assertEqual(extracted["sku"], "GA-WHITE")
        self.assertEqual(extracted["brand"], "Glo")
        self.assertEqual(extracted["price_raw"], "1299")
        self.assertEqual(extracted["currency"], "RUB")
        self.assertEqual(extracted["availability_label_raw"], "Предзаказ")
        self.assertTrue(extracted["price_conflict"])
        self.assertTrue(extracted["availability_conflict"])
        self.assertEqual(len(extracted["price_observations"]), 2)
        self.assertTrue(extracted["image_url"].endswith("glo-white.webp"))
        self.assertEqual(extracted["canonical_url"], "https://vapelab.site/product/glo-air-white")
        self.assertIn("76 g", extracted["specifications"]["weight"])
        self.assertEqual(extracted["specifications"]["compatibility"], "Neo Demi, Kent, Baisha")
        self.assertEqual(extracted["specifications"]["color"], "Белый")
        self.assertTrue(extracted["description"].startswith("Корпус из анодированного алюминия"))
        self.assertTrue(any("Цена в карточке" in flag for flag in extracted["data_quality_flags"]))

    def test_collection_card_separates_discounted_and_old_price(self):
        html = "<div class='product-card'><a href='/product/sample'>Тестовый товар <span>4 000 ₽</span><span>3 000 ₽</span></a></div>"
        cards = extract_collection_cards(BeautifulSoup(html, "html.parser"), "https://vapelab.site/collection/sample")
        card = cards["https://vapelab.site/product/sample"]
        self.assertEqual(card["old_price_raw"], "4 000 ₽")
        self.assertEqual(card["price_raw"], "3 000 ₽")


class CrawlerWorkspaceTests(unittest.TestCase):
    def test_crawl_creates_slug_folders_manifest_and_qwen_project_command(self):
        home = BeautifulSoup(
            "<ul><li><a href='/collection/heaters'>Нагреватели табака</a><ul><li><a href='/collection/glo-air'>Glo Air</a></li></ul></li></ul>",
            "html.parser",
        )
        collection = BeautifulSoup(
            "<div><a href='/product/glo-air-white'>Glo Air Белый <span>1 300 ₽</span><span>Предзаказ</span></a></div>",
            "html.parser",
        )
        product_html = '''<html><head><title>Glo Air Белый</title><script type="application/ld+json">
        {"@type":"Product","name":"Glo Air Белый","sku":"GA-WHITE","brand":{"name":"Glo"},
         "description":"Устройство с фактическим описанием.","image":"https://cdn.insales-shop.ru/glo.webp",
         "offers":{"price":"1300","priceCurrency":"RUB","availability":"https://schema.org/InStock"}}
        </script></head><body><h1>Glo Air Белый</h1></body></html>'''
        product = BeautifulSoup(product_html, "html.parser")

        class FixtureCrawler(Crawler):
            def check_robots(self):
                self.robots_checked = True
                self.robots.parse(["User-agent: *", "Allow: /"])

            def get(self, url):
                path = urlparse(url).path
                if path == "/":
                    return home
                if path in ("/collection/heaters", "/collection/glo-air"):
                    return collection
                if path == "/product/glo-air-white":
                    return product
                raise AssertionError(f"Unexpected fixture URL: {url}")

            def download_image(self, image_url, target_dir, index):
                target_dir.mkdir(parents=True, exist_ok=True)
                target = target_dir / f"{index:02d}-image.webp"
                target.write_bytes(b"fixture-image")
                return {"path": str(target).replace("\\", "/"), "sha256": "fixture", "bytes": "13"}

        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp) / "workspace"
            crawler = FixtureCrawler("https://vapelab.site", workspace, delay=0, max_collections=5, max_products=10, download_images=True)
            manifest = crawler.crawl()
            self.assertEqual(manifest["counts"]["products_saved"], 1)
            item = manifest["items"][0]
            self.assertTrue((workspace / item["source_file"]).exists())
            self.assertTrue((workspace / "images" / "glo-air-white" / "01-image.webp").exists())
            self.assertTrue((workspace / "QWEN.md").exists())
            qwen_command = (workspace / ".qwen" / "commands" / "enrich-catalog.md").read_text(encoding="utf-8")
            qwen_instructions = (workspace / "QWEN.md").read_text(encoding="utf-8")
            self.assertTrue((workspace / ".qwen" / "commands" / "enrich-catalog.md").exists())
            self.assertIn("web_search", qwen_command)
            self.assertIn("web_fetch", qwen_command)
            self.assertIn("images_dir", qwen_command)
            self.assertIn("rights_status", qwen_command)
            self.assertIn("Не копируй описания чужих магазинов дословно", qwen_instructions)
            self.assertTrue((workspace / "products-raw.csv").exists())
            self.assertTrue(item["age_review_required"])
            raw = json.loads((workspace / item["source_file"]).read_text(encoding="utf-8"))
            self.assertEqual(raw["category_name"], "Нагреватели табака")
            self.assertEqual(raw["subcategory_name"], "Glo Air")
            self.assertEqual(len(raw["category_observations"]), 2)
            self.assertEqual(raw["price_raw"], "1300")
            self.assertEqual(raw["is_reservable_import_default"], 0)
            self.assertIn("Товар найден в нескольких категориях", " ".join(raw["data_quality_flags"]))

    def test_owner_confirmation_never_overrides_explicit_robots_access_denial(self):
        class Response:
            status_code = 403
            text = "Forbidden"

        with tempfile.TemporaryDirectory() as temp:
            crawler = Crawler("https://vapelab.site", Path(temp), delay=0, owner_confirmed=True)
            crawler.session.get = lambda *args, **kwargs: Response()
            with self.assertRaisesRegex(RuntimeError, "не обходит запреты доступа"):
                crawler.check_robots()

    def test_external_cdn_robots_access_denial_blocks_image_fetch(self):
        class Response:
            status_code = 403
            text = "Forbidden"

        with tempfile.TemporaryDirectory() as temp:
            crawler = Crawler("https://vapelab.site", Path(temp), delay=0, owner_confirmed=True)
            crawler.session.get = lambda *args, **kwargs: Response()
            self.assertFalse(crawler.can_fetch_url("https://cdn.insales-shop.ru/image.webp"))


class QwenPackageTests(unittest.TestCase):
    def test_manifest_package_exports_variant_rows_and_safe_defaults(self):
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp)
            product_dir = workspace / "products" / "glo-air-white"
            product_dir.mkdir(parents=True)
            image_dir = workspace / "images" / "glo-air-white"
            image_dir.mkdir(parents=True)
            source = {
                "name": "Glo Air Белый", "sku": "GA-WHITE", "brand": "Glo",
                "category_name": "Нагреватели табака", "subcategory_name": "Glo Air",
                "category_path": "Нагреватели табака / Glo Air",
                "description": "Фактическое описание.", "price_raw": "1299", "currency": "RUB",
                "availability_label_raw": "Предзаказ", "source_url": "https://vapelab.site/product/glo-air-white",
                "seo_h1_source": "Glo Air Белый", "seo_title_source": "Glo Air Белый — характеристики",
                "seo_description_source": "Характеристики устройства Glo Air.",
                "canonical_url": "https://vapelab.site/product/glo-air-white",
                "images": [{"url": "https://cdn.insales-shop.ru/glo.webp", "alt": "Glo Air", "source_page": "https://vapelab.site/product/glo-air-white"}],
                "variants": [
                    {"name": "Белый", "sku": "GA-WHITE", "price_raw": "1299", "currency": "RUB", "availability_label_raw": "Предзаказ", "attributes": {"color": "Белый"}},
                    {"name": "Графит", "sku": "", "price_raw": "", "currency": "RUB", "availability_label_raw": "", "attributes": {"color": "Графит"}},
                ],
            }
            (product_dir / "source.json").write_text(json.dumps(source, ensure_ascii=False), encoding="utf-8")
            item = {
                "id": "glo-air-white", "slug": "glo-air-white", "source_url": source["source_url"],
                "source_file": "products/glo-air-white/source.json",
                "images_dir": "images/glo-air-white", "output_file": "products/glo-air-white/enriched.json",
                "enrichment_status": "completed", "age_review_required": True,
            }
            manifest = {"manifest_version": "1.0", "counts": {"products_saved": 1}, "items": [item]}
            (workspace / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
            enriched = {
                "description": "Нейтральное справочное описание.",
                "product_type": "Устройство нагревания табака",
                "format": "Компактное устройство",
                "seo_h1": "Glo Air Белый: характеристики",
                "seo_title": "Glo Air Белый — сведения и характеристики",
                "seo_description": "Справочные данные о модели Glo Air Белый.",
                "seo_keywords": ["Glo Air Белый", "характеристики Glo Air"],
                "missing_fields": ["гарантия"], "source_facts_used": ["name", "description"], "review_notes": [],
            }
            (product_dir / "enriched.json").write_text(json.dumps(enriched, ensure_ascii=False), encoding="utf-8")

            self.assertEqual(package_qwen_results(workspace), 0)
            with (workspace / "products-import.csv").open(encoding="utf-8-sig", newline="") as stream:
                rows = list(csv.DictReader(stream, delimiter=";"))
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["Статус: draft / published"], "draft")
            self.assertEqual(rows[0]["Разрешить индексацию: 1 / 0"], "0")
            self.assertEqual(rows[0]["Разрешить бронирование: 1 / 0"], "0")
            self.assertEqual(rows[0]["Требуется проверка 18+: 1 / 0"], "1")
            self.assertEqual(rows[0]["SEO Description"], "Справочные данные о модели Glo Air Белый.")
            self.assertEqual(rows[1]["Название варианта"], "Графит")
            self.assertEqual(rows[1]["Артикул варианта"], "")
            self.assertEqual(rows[1]["Цена варианта (исходная строка)"], "")
            updated_manifest = json.loads((workspace / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(updated_manifest["counts"]["products_packaged"], 1)
            self.assertEqual(updated_manifest["counts"]["rows_packaged"], 2)

    def test_qwen_cannot_override_source_fields_or_publication_controls(self):
        valid = validate_qwen_enrichment({"description": "Нейтральный текст", "seo_keywords": ["модель"]}, "demo")
        self.assertEqual(valid["description"], "Нейтральный текст")
        with self.assertRaisesRegex(RuntimeError, "запрещённые поля"):
            validate_qwen_enrichment({"description": "Текст", "price_raw": "1 000"}, "demo")
        with self.assertRaisesRegex(RuntimeError, "seo_keywords"):
            validate_qwen_enrichment({"seo_keywords": ["ok", 123]}, "demo")

    def test_raw_row_never_guesses_missing_price_or_sku(self):
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp)
            product_dir = workspace / "products" / "empty-product"
            product_dir.mkdir(parents=True)
            (product_dir / "source.json").write_text(json.dumps({"name": "Test", "images": []}), encoding="utf-8")
            item = {"source_file": "products/empty-product/source.json"}
            row = raw_row_from_manifest(workspace, item)
            self.assertEqual(row["sku"], "")
            self.assertEqual(row["price_raw"], "")
            self.assertEqual(row["status"], "draft")
            self.assertEqual(row["robots_index"], "0")
            self.assertEqual(row["is_reservable"], "0")


if __name__ == "__main__":
    unittest.main(verbosity=2)
