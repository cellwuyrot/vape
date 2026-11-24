#!/usr/bin/env python3
"""Сбор публичных фактов каталога InSales/VAPELAB и подготовка набора для Qwen + CRM.

Команды:
  python tools/vapelab_catalog_parser.py crawl --output ./qwen-workspace --owner-confirmed --download-images
  python tools/vapelab_catalog_parser.py package --workspace ./qwen-workspace

Скрипт ничего не публикует и не изменяет на исходном сайте. Все товары создаются
в CSV со статусом draft, запретом индексации и отключённым бронированием.
Неизвестные цены/SKU не угадываются. Перед запуском проверьте права на копирование,
robots.txt и условия сайта. Скрипт не обходит CAPTCHA, авторизацию, paywall или anti-bot.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import mimetypes
import os
import re
import sys
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urljoin, urlparse, urlunparse, unquote
from urllib.robotparser import RobotFileParser

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError as exc:  # pragma: no cover - exercised by CLI on user's machine
    print("Не найдены зависимости. Выполните: py -m pip install -r tools/requirements-vapelab-parser.txt", file=sys.stderr)
    raise SystemExit(2) from exc

BASE_DEFAULT = "https://vapelab.site"
USER_AGENT = "VAPELABCatalogAudit/1.0 (+local owner-authorized catalog migration; contact administrator)"
IMAGE_HOST_SUFFIXES = ("vapelab.site", "insales-shop.ru")
PRODUCT_PATH_RE = re.compile(r"/product/[^/?#]+", re.I)
COLLECTION_PATH_RE = re.compile(r"/collection/[^/?#]+", re.I)
PRICE_RE = re.compile(r"(?:\d[\d\s\u00a0]*\d|\d)\s*(?:₽|руб(?:\.|лей|ля|ль)?|р\.)", re.I)

IMPORT_HEADERS = [
    "Название товара", "Артикул / SKU", "Бренд", "Основная категория", "Подкатегория",
    "Тип товара", "Формат / вариант", "Описание", "Цена (как в источнике)",
    "Старая цена (как в источнике)", "Валюта", "Подпись наличия (как в источнике)",
    "Статус склада: in_stock / out_of_stock / preorder / unknown", "URL источника", "Статус: draft / published", "SEO H1", "SEO Title", "SEO Description",
    "Ключевые фразы через запятую", "Частотность (целое число)",
    "Класс частотности: high / medium / low", "URL изображения", "ALT изображения",
    "Страница-источник изображения", "Поисковый запрос изображения", "Название варианта",
    "Артикул варианта", "Цена варианта (исходная строка)", "Старая цена варианта",
    "Наличие варианта (как в источнике)", "Вкус", "Объём", "Крепость", "Цвет",
    "Комплектация", "Совместимость", "Атрибуты варианта JSON", "Canonical URL",
    "Разрешить индексацию: 1 / 0", "Поисковая система", "Регион частотности",
    "Намерение поискового запроса", "Источник частотности", "Дата проверки частотности",
    "Требуется проверка 18+: 1 / 0", "Разрешить бронирование: 1 / 0",
]

FIELD_KEYS = {
    "name": "Название товара", "sku": "Артикул / SKU", "brand": "Бренд",
    "category_name": "Основная категория", "subcategory_name": "Подкатегория",
    "product_type": "Тип товара", "format": "Формат / вариант", "description": "Описание",
    "price_raw": "Цена (как в источнике)", "old_price_raw": "Старая цена (как в источнике)",
    "currency": "Валюта", "availability_label_raw": "Подпись наличия (как в источнике)",
    "availability_status": "Статус склада: in_stock / out_of_stock / preorder / unknown",
    "source_url": "URL источника", "status": "Статус: draft / published", "seo_h1": "SEO H1",
    "seo_title": "SEO Title", "seo_description": "SEO Description",
    "seo_keywords": "Ключевые фразы через запятую", "canonical_url": "Canonical URL",
    "robots_index": "Разрешить индексацию: 1 / 0", "image_url": "URL изображения",
    "image_alt": "ALT изображения", "image_source_url": "Страница-источник изображения",
    "image_search_query": "Поисковый запрос изображения", "variant_name": "Название варианта",
    "variant_sku": "Артикул варианта", "variant_price_raw": "Цена варианта (исходная строка)",
    "variant_old_price_raw": "Старая цена варианта", "variant_availability_label_raw": "Наличие варианта (как в источнике)",
    "taste": "Вкус", "volume": "Объём", "strength": "Крепость", "color": "Цвет",
    "package": "Комплектация", "compatibility": "Совместимость", "variant_attributes_json": "Атрибуты варианта JSON",
    "search_volume": "Частотность (целое число)", "frequency_class": "Класс частотности: high / medium / low",
    "search_engine": "Поисковая система", "search_region": "Регион частотности",
    "search_intent": "Намерение поискового запроса", "search_source": "Источник частотности",
    "search_checked_at": "Дата проверки частотности", "image_search_query": "Поисковый запрос изображения",
    "is_18_plus": "Требуется проверка 18+: 1 / 0", "is_reservable": "Разрешить бронирование: 1 / 0",
}

AGE_REVIEW_TOKENS = (
    "табак", "сигар", "стик", "никот", "вейп", "однораз", "pod", "картридж",
    "жидкост", "кальян", "пауч", "махорк", "нагревател",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return ", ".join(clean_text(item) for item in value if item is not None)
    if isinstance(value, dict):
        return clean_text(value.get("name") or value.get("@id") or "")
    text = str(value)
    if "<" in text and ">" in text:
        text = BeautifulSoup(text, "html.parser").get_text(" ", strip=True)
    else:
        text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def absolute_url(base: str, href: str) -> str:
    url = urljoin(base, (href or "").strip())
    parts = urlparse(url)
    # Remove fragments and tracking params; preserve functional query strings like page.
    query_parts = [piece for piece in parts.query.split("&") if piece and not piece.lower().startswith(("utm_", "yclid=", "gclid="))]
    return urlunparse((parts.scheme, parts.netloc, parts.path.rstrip("/") or "/", "", "&".join(query_parts), ""))


def slug_from_url(url: str) -> str:
    slug = urlparse(url).path.rstrip("/").split("/")[-1]
    slug = unquote(slug).strip().lower()
    slug = re.sub(r"[^a-z0-9а-яё_-]+", "-", slug, flags=re.I)
    slug = re.sub(r"[-_]{2,}", "-", slug).strip("-_")
    return slug or hashlib.sha1(url.encode()).hexdigest()[:12]


def safe_filename(value: str) -> str:
    value = unicodedata.normalize("NFKC", value)
    value = re.sub(r"[^a-zA-Z0-9а-яА-ЯёЁ._-]+", "-", value).strip(".-_")
    return value[:120] or "item"


def walk_jsonld(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, list):
        for item in value:
            yield from walk_jsonld(item)
    elif isinstance(value, dict):
        yield value
        graph = value.get("@graph")
        if graph is not None:
            yield from walk_jsonld(graph)
        for key in ("itemListElement", "mainEntity", "hasVariant", "offers"):
            child = value.get(key)
            if isinstance(child, (dict, list)):
                yield from walk_jsonld(child)


def get_jsonld_products(soup: BeautifulSoup) -> list[dict[str, Any]]:
    products: list[dict[str, Any]] = []
    for script in soup.select('script[type="application/ld+json"]'):
        raw = script.string or script.get_text(" ", strip=True)
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            continue
        for obj in walk_jsonld(data):
            raw_type = obj.get("@type", [])
            types = raw_type if isinstance(raw_type, list) else [raw_type]
            if any(str(t).lower() == "product" for t in types):
                products.append(obj)
    return products


def first_nonempty(*values: Any) -> str:
    for value in values:
        text = clean_text(value)
        if text:
            return text
    return ""


def extract_offer(product: dict[str, Any]) -> tuple[str, str, str]:
    offers = product.get("offers") or {}
    if isinstance(offers, list):
        offer_list = [item for item in offers if isinstance(item, dict)]
    elif isinstance(offers, dict):
        offer_list = [offers]
    else:
        offer_list = []
    price = ""
    currency = ""
    availability = ""
    for offer in offer_list:
        price = price or first_nonempty(offer.get("price"), offer.get("lowPrice"), offer.get("highPrice"))
        currency = currency or clean_text(offer.get("priceCurrency"))
        availability = availability or clean_text(offer.get("availability"))
    if availability:
        tail = availability.rsplit("/", 1)[-1]
        availability = {
            "InStock": "В наличии", "OutOfStock": "Нет в наличии", "PreOrder": "Предзаказ",
            "BackOrder": "Под заказ", "LimitedAvailability": "Ограниченное наличие",
        }.get(tail, tail)
    return price, currency, availability


def extract_brand(product: dict[str, Any]) -> str:
    brand = product.get("brand")
    if isinstance(brand, dict):
        return first_nonempty(brand.get("name"))
    return clean_text(brand)


def extract_card_text(link) -> str:
    node = link
    for _ in range(7):
        if node is None:
            break
        text = clean_text(node.get_text(" ", strip=True))
        if len(text) > len(clean_text(link.get_text(" ", strip=True))) and (PRICE_RE.search(text) or re.search(r"в наличии|предзаказ|нет в наличии", text, re.I)):
            return text[:2500]
        node = node.parent
    return clean_text(link.get_text(" ", strip=True))


def extract_collection_cards(soup: BeautifulSoup, page_url: str) -> dict[str, dict[str, str]]:
    cards: dict[str, dict[str, str]] = {}
    for link in soup.select('a[href*="/product/"]'):
        url = absolute_url(page_url, link.get("href", ""))
        if not PRODUCT_PATH_RE.search(urlparse(url).path):
            continue
        text = extract_card_text(link)
        price_matches = PRICE_RE.findall(text)
        price_match = price_matches[-1] if price_matches else ""
        old_price_match = price_matches[0] if len(price_matches) > 1 else ""
        availability = ""
        for marker in ("В наличии", "Предзаказ", "Нет в наличии", "Под заказ"):
            if marker.lower() in text.lower():
                availability = marker
                break
        cards[url] = {
            "price_raw": price_match.strip() if price_match else "",
            "old_price_raw": old_price_match.strip() if old_price_match else "",
            "availability_label_raw": availability,
            "card_text": text,
            "source_url": page_url,
        }
    return cards


def extract_categories(home_soup: BeautifulSoup, base: str) -> dict[str, dict[str, str]]:
    categories: dict[str, dict[str, str]] = {}
    for link in home_soup.select('a[href*="/collection/"]'):
        url = absolute_url(base, link.get("href", ""))
        if not COLLECTION_PATH_RE.search(urlparse(url).path):
            continue
        label = clean_text(link.get_text(" ", strip=True))
        label = re.sub(r"\s+\d+\s*$", "", label).strip()
        if not label:
            continue
        current_li = link.find_parent("li")
        parent_li = current_li.find_parent("li") if current_li else None
        parent_label = ""
        if parent_li:
            # Read only direct category anchors of the parent item. Descendant
            # anchors belong to subcategories and must not become the parent.
            for candidate in parent_li.find_all("a", href=re.compile(r"/collection/"), recursive=False):
                candidate_url = absolute_url(base, candidate.get("href", ""))
                candidate_label = clean_text(candidate.get_text(" ", strip=True))
                candidate_label = re.sub(r"\s+\d+\s*$", "", candidate_label).strip()
                if candidate_url != url and candidate_label:
                    parent_label = candidate_label
                    break
        categories[url] = {
            "category_name": parent_label or label,
            "subcategory_name": label if parent_label else "",
            "category_path": "/".join(v for v in (parent_label, label) if v),
            "label": label,
        }
    return categories


def extract_images(soup: BeautifulSoup, product: dict[str, Any], page_url: str) -> list[dict[str, str]]:
    raw_images: list[Any] = []
    schema_images = product.get("image") if product else None
    if isinstance(schema_images, str):
        raw_images.append(schema_images)
    elif isinstance(schema_images, list):
        raw_images.extend(schema_images)
    og = soup.select_one('meta[property="og:image"]')
    if og and og.get("content"):
        raw_images.append(og["content"])
    for img in soup.select('main img[src], .product img[src], .product-gallery img[src], img[itemprop="image"][src]'):
        raw_images.append(img.get("data-src") or img.get("data-original") or img.get("src"))
    result = []
    seen = set()
    for raw in raw_images:
        url = absolute_url(page_url, str(raw)) if raw else ""
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        if parsed.scheme not in ("http", "https") or not host:
            continue
        if not (host == "vapelab.site" or host.endswith(".insales-shop.ru") or host == "insales-shop.ru"):
            continue
        if url in seen:
            continue
        seen.add(url)
        result.append({"url": url, "alt": "", "source_page": page_url})
    for img in soup.select('main img[alt], .product img[alt], .product-gallery img[alt]'):
        src = img.get("data-src") or img.get("src")
        if not src:
            continue
        url = absolute_url(page_url, src)
        for item in result:
            if item["url"] == url and not item["alt"]:
                item["alt"] = clean_text(img.get("alt"))
    return result[:20]


SPEC_LABEL_FIELDS = {
    "вкус": "taste", "вкусы": "taste", "объем": "volume", "объём": "volume",
    "крепость": "strength", "содержание никотина": "strength", "цвет": "color",
    "комплектация": "package", "состав комплекта": "package",
    "совместимость": "compatibility", "подходит для": "compatibility",
}

def schema_value(value: Any) -> str:
    if isinstance(value, dict):
        amount = first_nonempty(value.get("value"), value.get("name"))
        unit = first_nonempty(value.get("unitText"), value.get("unitCode"))
        return f"{amount} {unit}".strip() if amount else clean_text(value.get("name") or value.get("@id"))
    return clean_text(value)

def extract_specifications(soup: BeautifulSoup, product: dict[str, Any], description_node=None) -> dict[str, str]:
    specifications: dict[str, str] = {}
    for key in ("color", "material", "weight", "width", "height", "depth", "size"):
        if product.get(key):
            specifications[key] = schema_value(product[key])

    additional = product.get("additionalProperty") or []
    if isinstance(additional, dict):
        additional = [additional]
    if isinstance(additional, list):
        for prop in additional:
            if not isinstance(prop, dict):
                continue
            label = first_nonempty(prop.get("name"), prop.get("propertyID"))
            value = schema_value(prop.get("value"))
            if label and value:
                specifications[label] = value

    containers = []
    if description_node is not None:
        containers.append(description_node)
    for selector in (".product-specifications", ".product__properties", ".product-properties", "#product-properties"):
        node = soup.select_one(selector)
        if node is not None and node not in containers:
            containers.append(node)

    for container in containers:
        for dt in container.select("dl dt"):
            dd = dt.find_next_sibling("dd")
            label = clean_text(dt.get_text(" ", strip=True)).rstrip(":")
            value = clean_text(dd.get_text(" ", strip=True)) if dd else ""
            if label and value:
                specifications.setdefault(label, value)
        for row in container.select("tr"):
            cells = row.find_all(["th", "td"], recursive=False)
            if len(cells) >= 2:
                label = clean_text(cells[0].get_text(" ", strip=True)).rstrip(":")
                value = clean_text(cells[1].get_text(" ", strip=True))
                if label and value:
                    specifications.setdefault(label, value)
        for node in container.select("p, li"):
            text = clean_text(node.get_text(" ", strip=True))
            match = re.match(r"^([^:：]{2,90})[:：]\s*(.{1,500})$", text)
            if match:
                specifications.setdefault(match.group(1).strip(), match.group(2).strip())

    # Preserve raw labels in the JSON evidence, but also add normalized fields
    # understood by the CRM product importer. Do not infer missing values.
    for label, value in list(specifications.items()):
        field = SPEC_LABEL_FIELDS.get(re.sub(r"\s+", " ", label.strip().lower()))
        if field and value:
            specifications.setdefault(field, value)
    return specifications


def extract_product_page(soup: BeautifulSoup, page_url: str, category: dict[str, str], card: dict[str, str]) -> dict[str, Any]:
    schemas = get_jsonld_products(soup)
    product = schemas[0] if schemas else {}
    h1 = soup.select_one("h1")
    title = first_nonempty(h1.get_text(" ", strip=True) if h1 else "", product.get("name"), soup.select_one('meta[property="og:title"]') and soup.select_one('meta[property="og:title"]').get("content"), soup.title.string if soup.title else "")
    description_meta = soup.select_one('meta[property="og:description"]') or soup.select_one('meta[name="description"]')
    main_description = (
        soup.select_one('[itemprop="description"]')
        or soup.select_one(".product-description")
        or soup.select_one(".product__description")
        or soup.select_one(".product-description__content")
        or soup.select_one("#product-description")
    )
    description_candidates = [
        ("product-jsonld", clean_text(product.get("description"))),
        ("visible-product-description", clean_text(main_description.get_text("\n", strip=True)) if main_description else ""),
        ("meta-description", clean_text(description_meta.get("content")) if description_meta else ""),
    ]
    nonempty_descriptions = [(kind, value) for kind, value in description_candidates if value]
    description_source, description = max(nonempty_descriptions, key=lambda item: len(item[1])) if nonempty_descriptions else ("", "")
    description_observations = [{"kind": kind, "value": value, "url": page_url} for kind, value in nonempty_descriptions]
    sku = first_nonempty(product.get("sku"), product.get("mpn"))
    brand = extract_brand(product)
    schema_price, currency, schema_availability = extract_offer(product)
    price = schema_price or card.get("price_raw", "")
    old_price = card.get("old_price_raw", "")
    availability = schema_availability or card.get("availability_label_raw", "")
    availability_sources = []
    if schema_availability:
        availability_sources.append({"value": schema_availability, "url": page_url, "kind": "product-jsonld"})
    if card.get("availability_label_raw"):
        availability_sources.append({"value": card["availability_label_raw"], "url": card.get("source_url", ""), "kind": "collection-card"})
    availability_conflict = len({entry["value"].strip().lower() for entry in availability_sources if entry["value"]}) > 1
    price_sources = []
    if schema_price:
        price_sources.append({"value": schema_price, "url": page_url, "kind": "product-jsonld"})
    if card.get("price_raw"):
        price_sources.append({"value": card["price_raw"], "url": card.get("source_url", ""), "kind": "collection-card"})
    conflict = len({re.sub(r"[^\d.,]", "", entry["value"]) for entry in price_sources if entry["value"]}) > 1

    canonical_tag = soup.select_one('link[rel="canonical"]')
    title_tag = soup.select_one("title")
    canonical = absolute_url(page_url, canonical_tag.get("href")) if canonical_tag and canonical_tag.get("href") else page_url
    meta_title = clean_text(title_tag.string if title_tag else "")
    seo_description = clean_text(description_meta.get("content")) if description_meta else ""

    variants: list[dict[str, Any]] = []
    has_variant = product.get("hasVariant")
    if isinstance(has_variant, dict):
        has_variant = [has_variant]
    if isinstance(has_variant, list):
        for variant in has_variant:
            if not isinstance(variant, dict):
                continue
            vprice, vcurrency, vavailability = extract_offer(variant)
            variants.append({
                "name": first_nonempty(variant.get("name"), variant.get("color")),
                "sku": clean_text(variant.get("sku")), "price_raw": vprice,
                "currency": vcurrency, "availability_label_raw": vavailability,
                "attributes": {"color": clean_text(variant.get("color"))} if variant.get("color") else {},
            })
    images = extract_images(soup, product, page_url)
    attrs = extract_specifications(soup, product, main_description)

    return {
        "source_url": page_url,
        "name": title,
        "sku": sku,
        "brand": brand,
        "category_name": category.get("category_name", ""),
        "subcategory_name": category.get("subcategory_name", ""),
        "category_path": category.get("category_path", ""),
        "description": description,
        "description_source": description_source,
        "description_observations": description_observations,
        "price_raw": price,
        "old_price_raw": old_price,
        "currency": currency or ("RUB" if "₽" in price or "руб" in price.lower() else ""),
        "availability_label_raw": availability,
        "price_observations": price_sources,
        "old_price_observations": ([{"value": old_price, "url": card.get("source_url", ""), "kind": "collection-card-old-price"}] if old_price else []),
        "price_conflict": conflict,
        "availability_observations": availability_sources,
        "availability_conflict": availability_conflict,
        "seo_title_source": meta_title,
        "seo_description_source": seo_description,
        "seo_h1_source": clean_text(h1.get_text(" ", strip=True)) if h1 else "",
        "canonical_url": canonical,
        "image_url": images[0]["url"] if images else "",
        "images": images,
        "variants": variants,
        "specifications": attrs,
        "jsonld_product": product,
        "collection_evidence": card.get("card_text", ""),
        "collection_source_url": card.get("source_url", ""),
        "data_quality_flags": [flag for flag, condition in (
            ("SKU не обнаружен в открытых данных", not sku),
            ("Цена отсутствует в открытых данных", not price),
            ("Цена в карточке и коллекции различается — нужна ручная проверка", conflict),
            ("Статус наличия в карточке и коллекции различается — нужна ручная проверка", availability_conflict),
            ("Описание отсутствует", not description),
            ("Изображение не обнаружено", not images),
        ) if condition],
        "captured_at": utc_now(),
    }


@dataclass
class Crawler:
    base_url: str
    output: Path
    delay: float = 1.5
    timeout: float = 25.0
    max_collections: int = 400
    max_products: int = 10000
    download_images: bool = False
    owner_confirmed: bool = False

    def __post_init__(self):
        self.base_url = self.base_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT, "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.7"})
        self.robots = RobotFileParser()
        self.robots_checked = False
        # CDN rules are checked against that CDN's own robots.txt, not the
        # source shop's robots.txt. None means the host returned HTTP 4xx
        # (RFC 9309: robots file unavailable); False means access is blocked.
        self.host_robots: dict[str, RobotFileParser | None | bool] = {}
        self.last_request = 0.0
        self.errors: list[dict[str, str]] = []

    def wait_for_request(self):
        wait = self.delay - (time.monotonic() - self.last_request)
        if wait > 0:
            time.sleep(wait)

    def can_fetch_url(self, url: str) -> bool:
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        base_host = (urlparse(self.base_url).hostname or "").lower()
        if host == base_host:
            return not self.robots_checked or self.robots.can_fetch(USER_AGENT, url)
        cached = self.host_robots.get(host, "missing")
        if cached == "missing":
            robots_url = f"{parsed.scheme or 'https'}://{host}/robots.txt"
            try:
                self.wait_for_request()
                response = self.session.get(robots_url, timeout=self.timeout)
                self.last_request = time.monotonic()
                if response.status_code == 200:
                    rules = RobotFileParser()
                    rules.set_url(robots_url)
                    rules.parse(response.text.splitlines())
                    cached = rules
                elif response.status_code in {401, 403, 429}:
                    # Explicit access denial / rate limiting is never treated as
                    # an absent robots file and cannot be overridden by owner confirmation.
                    cached = False
                elif 400 <= response.status_code < 500:
                    # RFC 9309: unavailable robots file (e.g. 404) means no rules.
                    cached = None
                else:
                    # 5xx means robots is unreachable: fail closed for this host.
                    cached = False
            except requests.RequestException as exc:
                self.errors.append({"url": robots_url, "error": f"CDN robots.txt: {exc}"})
                cached = False
            self.host_robots[host] = cached
        if cached is False:
            return False
        if cached is None:
            return True
        return cached.can_fetch(USER_AGENT, url)

    def check_robots(self):
        robots_url = urljoin(self.base_url + "/", "robots.txt")
        try:
            response = self.session.get(robots_url, timeout=self.timeout)
            if response.status_code == 200:
                self.robots.set_url(robots_url)
                self.robots.parse(response.text.splitlines())
                self.robots_checked = True
            elif response.status_code in {401, 403, 429}:
                raise RuntimeError(
                    f"Сайт отклонил запрос robots.txt (HTTP {response.status_code}). "
                    "Парсер не обходит запреты доступа или ограничение частоты запросов."
                )
            elif self.owner_confirmed:
                print(f"ПРЕДУПРЕЖДЕНИЕ: robots.txt отсутствует или временно недоступен (HTTP {response.status_code}); владелец подтвердил право на аудит.")
            else:
                raise RuntimeError(f"robots.txt недоступен (HTTP {response.status_code}). После проверки прав и правил повторите с --owner-confirmed.")
        except requests.RequestException as exc:
            if not self.owner_confirmed:
                raise RuntimeError(f"Не удалось проверить robots.txt: {exc}. Если вы владелец сайта и подтвердили право на аудит, повторите с --owner-confirmed.") from exc
            print(f"ПРЕДУПРЕЖДЕНИЕ: robots.txt не удалось получить ({exc}); владелец подтвердил право на аудит.")
        if self.robots_checked and not self.robots.can_fetch(USER_AGENT, self.base_url + "/"):
            raise RuntimeError("robots.txt запрещает обход главной страницы выбранному User-Agent.")

    def get(self, url: str) -> BeautifulSoup:
        url = absolute_url(self.base_url, url)
        host = (urlparse(url).hostname or "").lower()
        base_host = (urlparse(self.base_url).hostname or "").lower()
        if host != base_host:
            raise RuntimeError(f"Внешний URL отклонён: {url}")
        if self.robots_checked and not self.robots.can_fetch(USER_AGENT, url):
            raise PermissionError(f"robots.txt запрещает: {url}")
        self.wait_for_request()
        response = self.session.get(url, timeout=self.timeout)
        self.last_request = time.monotonic()
        response.raise_for_status()
        if "text/html" not in response.headers.get("Content-Type", "text/html"):
            raise RuntimeError(f"Ожидалась HTML-страница: {url}")
        return BeautifulSoup(response.text, "html.parser")

    def discover(self) -> tuple[dict[str, dict[str, str]], dict[str, dict[str, str]]]:
        home = self.get(self.base_url + "/")
        categories = extract_categories(home, self.base_url)
        if not categories:
            for link in home.select('a[href*="/collection/"]'):
                url = absolute_url(self.base_url, link.get("href", ""))
                label = clean_text(link.get_text(" ", strip=True))
                if COLLECTION_PATH_RE.search(urlparse(url).path) and label:
                    categories[url] = {"category_name": re.sub(r"\s+\d+\s*$", "", label), "subcategory_name": "", "category_path": label, "label": label}
        return categories, {}

    def collection_products(self, collection_url: str) -> tuple[dict[str, dict[str, str]], list[str]]:
        cards: dict[str, dict[str, str]] = {}
        pages = [collection_url]
        visited: set[str] = set()
        while pages and len(visited) < 20:
            page_url = pages.pop(0)
            if page_url in visited:
                continue
            visited.add(page_url)
            try:
                soup = self.get(page_url)
            except Exception as exc:
                self.errors.append({"url": page_url, "error": str(exc)})
                continue
            cards.update(extract_collection_cards(soup, page_url))
            for link in soup.select('a[href*="page="], a[rel="next"]'):
                candidate = absolute_url(page_url, link.get("href", ""))
                if candidate not in visited and candidate not in pages and COLLECTION_PATH_RE.search(urlparse(candidate).path):
                    pages.append(candidate)
        return cards, list(cards)

    def download_image(self, image_url: str, target_dir: Path, index: int) -> dict[str, str] | None:
        host = (urlparse(image_url).hostname or "").lower()
        if not any(host == suffix or host.endswith("." + suffix) for suffix in IMAGE_HOST_SUFFIXES):
            return None
        if not self.can_fetch_url(image_url):
            return None
        try:
            self.wait_for_request()
            response = self.session.get(image_url, timeout=self.timeout, stream=True)
            self.last_request = time.monotonic()
            response.raise_for_status()
            content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
            ext = mimetypes.guess_extension(content_type) or Path(urlparse(image_url).path).suffix.lower()
            if ext == ".jpe": ext = ".jpg"
            if ext not in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
                return None
            content = bytearray()
            for chunk in response.iter_content(64 * 1024):
                content.extend(chunk)
                if len(content) > 20 * 1024 * 1024:
                    return None
            if not content:
                return None
            if ext in (".jpg", ".jpeg") and not content.startswith(b"\xff\xd8\xff"):
                return None
            if ext == ".png" and not content.startswith(b"\x89PNG\r\n\x1a\n"):
                return None
            if ext == ".webp" and not (content.startswith(b"RIFF") and content[8:12] == b"WEBP"):
                return None
            target_dir.mkdir(parents=True, exist_ok=True)
            target = target_dir / f"{index:02d}-image{ext}"
            target.write_bytes(content)
            return {"path": str(target).replace("\\", "/"), "sha256": hashlib.sha256(content).hexdigest(), "bytes": str(len(content))}
        except requests.RequestException as exc:
            self.errors.append({"url": image_url, "error": f"image: {exc}"})
            return None

    def crawl(self) -> dict[str, Any]:
        self.output.mkdir(parents=True, exist_ok=True)
        self.check_robots()
        categories, _ = self.discover()
        print(f"Найдено коллекций: {len(categories)}")
        all_cards: dict[str, dict[str, str]] = {}
        product_categories: dict[str, dict[str, str]] = {}
        product_category_observations: dict[str, list[dict[str, str]]] = {}
        for number, (collection_url, category) in enumerate(list(categories.items())[: self.max_collections], 1):
            try:
                cards, urls = self.collection_products(collection_url)
                for url, card in cards.items():
                    all_cards.setdefault(url, card)
                    product_categories.setdefault(url, category)
                    observations = product_category_observations.setdefault(url, [])
                    if not any(entry.get("category_path") == category.get("category_path") for entry in observations):
                        observations.append({**category, "source_url": collection_url})
            except Exception as exc:
                self.errors.append({"url": collection_url, "error": str(exc)})
            if number % 20 == 0:
                print(f"Коллекции: {number}/{min(len(categories), self.max_collections)}; товаров обнаружено: {len(all_cards)}")
        print(f"Уникальных карточек найдено: {len(all_cards)}")
        for product_url, observations in product_category_observations.items():
            if observations:
                # Prefer a nested collection path over its parent, while keeping
                # every observed path for manual confirmation in source.json.
                product_categories[product_url] = max(
                    observations,
                    key=lambda entry: (str(entry.get("category_path", "")).count("/"), len(str(entry.get("category_path", "")))),
                )

        manifest_items = []
        products_root = self.output / "products"
        images_root = self.output / "images"
        for count, (url, card) in enumerate(list(all_cards.items())[: self.max_products], 1):
            try:
                soup = self.get(url)
                slug = slug_from_url(url)
                raw = extract_product_page(soup, url, product_categories.get(url, {}), card)
                raw["category_observations"] = product_category_observations.get(url, [])
                if len(raw["category_observations"]) > 1:
                    raw["data_quality_flags"].append("Товар найден в нескольких категориях — проверьте основную категорию")
                if not raw["name"]:
                    raw["data_quality_flags"].append("Название не обнаружено — нужна ручная проверка")
                category_text = (raw.get("category_path", "") + " " + raw.get("category_name", "")).lower()
                needs_age_review = any(token in category_text for token in AGE_REVIEW_TOKENS)
                raw["age_review_required"] = needs_age_review
                raw["is_18_plus_import_suggestion"] = 1 if needs_age_review else ""
                raw["is_reservable_import_default"] = 0
                raw["status_import_default"] = "draft"
                raw["robots_index_import_default"] = 0
                raw["image_rights_review_required"] = bool(raw["images"])
                raw["source_platform"] = "InSales (observed from public page structure)"

                product_dir = products_root / slug
                product_dir.mkdir(parents=True, exist_ok=True)
                (product_dir / "source.json").write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")

                downloaded = []
                if self.download_images:
                    image_dir = images_root / slug
                    for idx, image in enumerate(raw["images"], 1):
                        saved = self.download_image(image["url"], image_dir, idx)
                        if saved:
                            downloaded.append({**image, **saved})
                    raw["downloaded_images"] = downloaded
                    (product_dir / "source.json").write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")

                manifest_items.append({
                    "id": slug,
                    "slug": slug,
                    "source_url": url,
                    "source_file": f"products/{slug}/source.json",
                    "images_dir": f"images/{slug}",
                    "output_file": f"products/{slug}/enriched.json",
                    "enrichment_status": "pending",
                    "age_review_required": needs_age_review,
                    "fields_to_prepare": ["description", "product_type", "format", "seo_h1", "seo_title", "seo_description", "seo_keywords"],
                    "fields_that_must_not_be_guessed": ["sku", "price_raw", "old_price_raw", "availability_label_raw", "is_18_plus", "is_reservable", "brand"],
                    "data_quality_flags": raw["data_quality_flags"],
                })
                if count % 25 == 0:
                    print(f"Карточки: {count}/{min(len(all_cards), self.max_products)}")
            except Exception as exc:
                self.errors.append({"url": url, "error": str(exc)})

        manifest = {
            "manifest_version": "1.0",
            "created_at": utc_now(),
            "source": {"base_url": self.base_url, "platform_observed": "InSales", "robots_checked": self.robots_checked, "user_agent": USER_AGENT},
            "workflow": {"qwen_profile": "vapelab-catalog-enrichment", "instruction_file": "QWEN.md", "command": "/enrich-catalog", "import_file_after_enrichment": "products-import.csv"},
            "policy": {
                "all_products_start_as_draft": True,
                "robots_index_default": 0,
                "reservation_default": 0,
                "age_classification_requires_admin_review": True,
                "price_and_sku_must_never_be_invented": True,
                "image_rights_must_be_checked_before_publication": True,
            },
            "counts": {"collections_discovered": len(categories), "products_discovered": len(all_cards), "products_saved": len(manifest_items), "errors": len(self.errors)},
            "items": manifest_items,
            "errors": self.errors,
        }
        (self.output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        (self.output / "collections.json").write_text(json.dumps([{"url": url, **data} for url, data in categories.items()], ensure_ascii=False, indent=2), encoding="utf-8")
        self.write_workspace_instructions()
        write_csv(self.output / "products-raw.csv", [raw_row_from_manifest(self.output, item) for item in manifest_items])
        (self.output / "README.txt").write_text(WORKSPACE_README, encoding="utf-8")
        print(f"Готово. manifest: {len(manifest_items)} карточек; ошибки: {len(self.errors)}; папка: {self.output}")
        return manifest

    def write_workspace_instructions(self):
        (self.output / "QWEN.md").write_text(QWEN_INSTRUCTIONS, encoding="utf-8")
        command_dir = self.output / ".qwen" / "commands"
        command_dir.mkdir(parents=True, exist_ok=True)
        (command_dir / "enrich-catalog.md").write_text(QWEN_COMMAND, encoding="utf-8")


def raw_row_from_manifest(workspace: Path, item: dict[str, Any]) -> dict[str, str]:
    raw = json.loads((workspace / item["source_file"]).read_text(encoding="utf-8"))
    images = raw.get("images") or []
    primary_image = images[0] if images else {}
    specifications = raw.get("specifications") or {}
    variant_attributes = {key: value for key, value in specifications.items() if key not in {"taste", "volume", "strength", "color", "package", "compatibility"}}
    return {
        "name": raw.get("name", ""), "sku": raw.get("sku", ""), "brand": raw.get("brand", ""),
        "category_name": raw.get("category_name", ""), "subcategory_name": raw.get("subcategory_name", ""),
        "product_type": "", "format": "", "description": raw.get("description", ""),
        "price_raw": raw.get("price_raw", ""), "old_price_raw": raw.get("old_price_raw", ""), "currency": raw.get("currency", ""),
        "availability_label_raw": raw.get("availability_label_raw", ""),
        "availability_status": ("out_of_stock" if any(x in str(raw.get("availability_label_raw", "")).lower() for x in ("нет в наличии", "отсутств", "нет остат")) else "preorder" if any(x in str(raw.get("availability_label_raw", "")).lower() for x in ("предзаказ", "ожидается")) else "in_stock" if "в наличии" in str(raw.get("availability_label_raw", "")).lower() else "unknown"),
        "source_url": raw.get("source_url", ""),
        "status": "draft", "seo_h1": raw.get("seo_h1_source", ""), "seo_title": raw.get("seo_title_source", ""),
        "seo_description": raw.get("seo_description_source", ""), "seo_keywords": "", "search_volume": "",
        "frequency_class": "", "search_engine": "", "search_region": "", "search_intent": "",
        "search_source": "", "search_checked_at": "", "image_url": primary_image.get("url", ""),
        "image_alt": primary_image.get("alt", ""), "image_source_url": primary_image.get("source_page", raw.get("source_url", "")),
        "image_search_query": raw.get("name", ""), "variant_name": "", "variant_sku": "",
        "variant_price_raw": "", "variant_old_price_raw": "", "variant_availability_label_raw": "",
        "taste": specifications.get("taste", ""), "volume": specifications.get("volume", ""),
        "strength": specifications.get("strength", ""), "color": specifications.get("color", ""),
        "package": specifications.get("package", ""), "compatibility": specifications.get("compatibility", ""),
        "variant_attributes_json": json.dumps(variant_attributes, ensure_ascii=False) if variant_attributes else "",
        "canonical_url": raw.get("canonical_url", raw.get("source_url", "")),
        "robots_index": "0", "is_18_plus": "1" if raw.get("age_review_required") else "", "is_reservable": "0",
    }


ENRICHED_TEXT_LIMITS = {
    "description": 12000, "product_type": 240, "format": 240,
    "seo_h1": 300, "seo_title": 300, "seo_description": 1000,
}
ENRICHED_META_FIELDS = {"missing_fields", "source_facts_used", "review_notes"}

def validate_qwen_enrichment(payload: Any, item_id: str = "unknown") -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise RuntimeError(f"{item_id}: enriched.json должен содержать JSON-объект")
    allowed = set(ENRICHED_TEXT_LIMITS) | {"seo_keywords"} | ENRICHED_META_FIELDS
    unexpected = sorted(set(payload) - allowed)
    if unexpected:
        raise RuntimeError(f"{item_id}: запрещённые поля в enriched.json: {', '.join(unexpected)}. Цена, SKU, наличие, статус, возраст и бронирование берутся только из источника/админки.")
    cleaned: dict[str, Any] = {}
    for field, limit in ENRICHED_TEXT_LIMITS.items():
        value = payload.get(field, "")
        if value is None:
            value = ""
        if not isinstance(value, str):
            raise RuntimeError(f"{item_id}: поле {field} должно быть строкой")
        cleaned[field] = value.strip()[:limit]
    keywords = payload.get("seo_keywords", [])
    if isinstance(keywords, str):
        keywords = [part.strip() for part in re.split(r"[,;\n]", keywords) if part.strip()]
    if not isinstance(keywords, list) or any(not isinstance(value, str) for value in keywords):
        raise RuntimeError(f"{item_id}: seo_keywords должно быть списком строк или строкой через запятую")
    cleaned["seo_keywords"] = list(dict.fromkeys(value.strip()[:120] for value in keywords if value.strip()))[:40]
    for field in ENRICHED_META_FIELDS:
        value = payload.get(field, [])
        if not isinstance(value, list) or any(not isinstance(entry, str) for entry in value):
            raise RuntimeError(f"{item_id}: {field} должен быть списком строк")
        cleaned[field] = [entry.strip()[:500] for entry in value if entry.strip()][:80]
    return cleaned


def rows_for_manifest_item(workspace: Path, item: dict[str, Any], enriched: dict[str, Any]) -> list[dict[str, str]]:
    source_path = workspace / item["source_file"]
    raw = json.loads(source_path.read_text(encoding="utf-8"))
    base = raw_row_from_manifest(workspace, item)
    # Qwen may rewrite only neutral descriptions/SEO fields from source facts.
    for key in ("description", "product_type", "format", "seo_h1", "seo_title", "seo_description"):
        if enriched.get(key):
            base[key] = str(enriched[key]).strip()
    keywords = enriched.get("seo_keywords") or []
    if isinstance(keywords, list):
        base["seo_keywords"] = ", ".join(str(x).strip() for x in keywords if str(x).strip())
    elif isinstance(keywords, str):
        base["seo_keywords"] = keywords

    # A separate row for each source-confirmed variant lets the VAPELAB importer
    # upsert one product and add several variants without inventing their SKUs/prices.
    variants = raw.get("variants") or []
    if not variants:
        return [base]
    result = []
    for variant in variants:
        row = dict(base)
        row["variant_name"] = str(variant.get("name", "") or "")
        row["variant_sku"] = str(variant.get("sku", "") or "")
        row["variant_price_raw"] = str(variant.get("price_raw", "") or "")
        row["variant_availability_label_raw"] = str(variant.get("availability_label_raw", "") or "")
        row["currency"] = str(variant.get("currency", "") or row["currency"])
        attributes = variant.get("attributes") or {}
        if attributes:
            row["variant_attributes_json"] = json.dumps(attributes, ensure_ascii=False)
        result.append(row)
    return result


def write_csv(path: Path, rows: list[dict[str, str]]):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=IMPORT_HEADERS, delimiter=";", extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            output = {header: "" for header in IMPORT_HEADERS}
            for field_key, header in FIELD_KEYS.items():
                output[header] = row.get(field_key, "")
            writer.writerow(output)


def package_qwen_results(workspace: Path, require_enriched: bool = True) -> int:
    manifest_path = workspace / "manifest.json"
    if not manifest_path.exists():
        raise RuntimeError(f"Не найден manifest.json в {workspace}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    rows = []
    missing = []
    for item in manifest.get("items", []):
        source_path = workspace / item["source_file"]
        if not source_path.exists():
            missing.append(f"{item.get('id')}: нет source.json")
            continue
        raw = json.loads(source_path.read_text(encoding="utf-8"))
        enriched_path = workspace / item["output_file"]
        enriched = {}
        if enriched_path.exists():
            enriched = validate_qwen_enrichment(json.loads(enriched_path.read_text(encoding="utf-8")), item.get("id", "unknown"))
        elif require_enriched:
            missing.append(item.get("id", "unknown"))
            continue

        item_rows = rows_for_manifest_item(workspace, item, enriched)
        # Publication, indexing, age review and reservations never come from Qwen.
        for row in item_rows:
            row["status"] = "draft"
            row["robots_index"] = "0"
            row["is_reservable"] = "0"
            row["is_18_plus"] = "1" if item.get("age_review_required") else ""
            rows.append(row)
        if enriched:
            item["enrichment_status"] = "packaged"
    if missing and require_enriched:
        print(f"Не обработано Qwen: {len(missing)} позиций. Пример: {', '.join(missing[:8])}")
        print("Запустите Qwen Code и команду /enrich-catalog, затем повторите package.")
        return 2
    out = workspace / "products-import.csv"
    write_csv(out, rows)
    manifest["packaged_at"] = utc_now()
    manifest["counts"]["products_packaged"] = sum(1 for item in manifest.get("items", []) if item.get("enrichment_status") == "packaged")
    manifest["counts"]["rows_packaged"] = len(rows)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Создан {out} — строк: {len(rows)}")
    return 0


QWEN_INSTRUCTIONS = """# VAPELAB Qwen catalog workspace

Ты работаешь с локальным набором фактов и создаёшь проверенные черновики товарных карточек. `manifest.json` — прикладной manifest заданий этого проекта, а не встроенный формат Qwen Code.

## Перед началом
- Проверь доступные инструменты командой `/tools`.
- Если доступны `web_search` и `web_fetch`, используй их для поиска официальных источников производителя и уточнения только недостающих фактов. Поддержка зависит от провайдера/режима Qwen Code; если инструментов нет, не изображай поиск и не используй сомнительные обходы — отметь отсутствие данных в `missing_fields` и `review_notes`.
- `web_fetch` может сохранять бинарные файлы локально; если он вернул локальный путь к изображению, проверь файл и перемести его в `images_dir` задания.

## Главные правила
- Один элемент manifest = один товар; работай только с указанными `source_file`, `images_dir`, `output_file`.
- Источник истины — `products/<slug>/source.json`. Дополнительные источники допустимы только для проверки фактов; сохраняй URL и дату/контекст проверки.
- Ищи в первую очередь сайт производителя, официальную спецификацию, руководство, официальный пресс-кит или медиатеку.
- Не копируй описания чужих магазинов дословно. Составляй новый нейтральный структурированный текст собственными словами только из подтверждённых фактов.
- Не выдумывай SKU, цену, старую цену, наличие, бренд, крепость, состав, сертификаты, гарантию, совместимость, изображения, возрастную классификацию или иные характеристики.
- Для полей без достоверного факта верни пустую строку и перечисли их в `missing_fields`.
- Сохраняй числа, единицы измерения, режимы и совместимость буквально; можно нормализовать оформление, но нельзя менять значение.
- Не генерируй рекламные обещания, рекомендации к потреблению, медицинские/оздоровительные утверждения, обращения к несовершеннолетним или призывы к покупке. Описание должно быть нейтральным справочным текстом.
- В `seo_keywords` добавляй только релевантные нейтральные запросы, следующие из имени/категории/подтверждённых характеристик; не приписывай поисковую частотность без инструмента/данных.
- Не заполняй `is_18_plus`, `is_reservable`, `robots_index` и `status`: ими управляет скрипт/администратор. Все товары остаются draft, noindex и без бронирования.

## Изображения и права
- Не скачивай изображения с сайтов-конкурентов, маркетплейсов или из поисковой выдачи только потому, что URL публичный.
- Скачивай и сохраняй изображение в `images_dir` только если оно принадлежит владельцу проекта, предоставлено им, либо источник прямо разрешает коммерческое повторное использование (например, официальный медиакит с ясными условиями).
- Если лицензия/право использования не подтверждены, не скачивай файл: запиши кандидата в `image-sources.json` со статусом `needs_review` и запроси проверку владельца.
- Если право подтверждено: сохрани главный файл как `01-main.<ext>`, дополнительные — `02-extra.<ext>` и т. д. Не скачивай дубликаты, водяные знаки, чужой цвет/вариант модели или изображения плохого качества.
- Для каждого изображения запиши `page_url`, `direct_url`, `local_file`, `rights_status` (`confirmed` или `needs_review`) и `rights_evidence` в `products/<slug>/image-sources.json`.
- Не обходи CAPTCHA, авторизацию, paywall, robots.txt, 401/403/429, rate limits или иные ограничения доступа. При явном запрете остановись.

## Содержимое enriched.json
Создай описание, тип, формат и SEO-поля. SEO должно точно соответствовать товару, не быть набором повторов и не обещать того, чего нет в фактах. Слова/ключи не должны добавлять свойства или аудиторию, которых источник не подтверждает.

```json
{
  "description": "...",
  "product_type": "...",
  "format": "...",
  "seo_h1": "...",
  "seo_title": "...",
  "seo_description": "...",
  "seo_keywords": ["..."],
  "missing_fields": ["..."],
  "source_facts_used": ["..."],
  "review_notes": ["..."]
}
```

Не меняй `source.json` и другие исходные факты. Записывай только `enriched.json` и, при наличии кандидатов/разрешённых локальных изображений, `image-sources.json`/файлы в `images_dir`. `manifest.json` обновляй точечно: после успешной записи `enriched.json` выставь `enrichment_status` в `completed` и добавь `completed_at`; для каждого изображения сохрани статус прав отдельно. Не меняй чужие элементы manifest. Обрабатывай максимум заданий, указанных в аргументе (по умолчанию 5), чтобы владелец мог проверить выборку.
"""

QWEN_COMMAND = """---
description: Найти официальные источники, подготовить текст/SEO и проверить изображения для выбранных товаров VAPELAB
---

Прочитай `manifest.json` и `QWEN.md`. Аргумент команды: {{args}}.

Сначала выполни `/tools` и проверь, доступны ли `web_search` и `web_fetch`. Если недоступны, не имитируй интернет-поиск: подготовь карточку только по `source.json`, перечисли недостающие поля и продолжай без скачивания изображений.

Если аргумент — ID/slug, обработай только этот элемент. Если аргумент — целое число, обработай не более указанного количества `pending` элементов. Если аргумент пустой, обработай первые 5 элементов со статусом `pending`.

Для каждого задания:
1. Прочитай только его `source_file`, проверь `images_dir` и исходные изображения.
2. При наличии `web_search` найди официальную страницу/спецификацию производителя и, отдельно, официальный медиакит/источник изображения. Используй `web_fetch` только для страниц, нужных для подтверждения конкретных фактов.
3. Не копируй текст магазина дословно. Напиши самостоятельное нейтральное описание и точные SEO-поля по подтверждённым фактам. Не выдумывай характеристики.
4. Изображение скачивай только при подтверждённом праве коммерческого повторного использования/владении. Если права неясны — не скачивай. При разрешённом скачивании получи файл через `web_fetch` или допустимый штатный инструмент, проверь тип/размер и скопируй его в `images_dir` как `01-main.ext`, `02-extra.ext`.
5. Создай/обнови `products/<slug>/image-sources.json` с массивом изображений: `page_url`, `direct_url`, `local_file`, `rights_status`, `rights_evidence`. Если право не подтверждено, используй `rights_status: "needs_review"` и `local_file: ""`.
6. Создай `output_file` строго по JSON-схеме `QWEN.md`. Не меняй цену, SKU, наличие, возраст, бронирование, статус или robots.
7. После успешной записи измени статус только этого элемента manifest на `completed`, добавь `completed_at` в ISO-8601. Если данных недостаточно — оставь поля пустыми и перечисли `missing_fields`.

Не обходи CAPTCHA, авторизацию, paywall, robots.txt, 401/403/429, rate limits или другие ограничения доступа. Не используй фото конкурентов/маркетплейсов без прав. Не публикуй товар автоматически. В конце выведи обработанные ID, найденные локальные изображения, источники/статус прав и товары, которым нужна ручная проверка.
"""

WORKSPACE_README = """VAPELAB catalog import workspace

1) Посмотрите manifest.json и products/*/source.json. Источники хранятся отдельно от Qwen output.
2) Откройте эту папку в Qwen Code. Сначала проверьте /tools: web_search и web_fetch доступны не для каждого провайдера Qwen Code.
3) Выполните /enrich-catalog 5 (или конкретный slug). Qwen подготовит самостоятельное описание и SEO по подтверждённым фактам; при разрешённых правах сохранит изображения в images/<slug>/.
4) Проверьте enriched.json, image-sources.json, missing_fields и review_notes. Не публикуйте изображения со статусом needs_review до подтверждения прав.
5) Выполните: python <path-to-project>/tools/vapelab_catalog_parser.py package --workspace .
6) Импортируйте products-import.csv через CRM → Импорт → Товары. В мастере вручную проверьте сопоставление колонок, сначала запустите пробный импорт.
7) Загрузите папку images через CRM → Витрина → Товары → Загрузить папку фото. Имена каталогов должны совпадать со slug товара.

По умолчанию все записи draft, noindex, без бронирования. Возрастной признак формируется консервативно по категории и требует ручной проверки. Цены/SKU/наличие не выдумываются. Публичность карточки и право использования каждого изображения утверждает администратор.
"""


def cmd_crawl(args):
    crawler = Crawler(args.base_url, Path(args.output).resolve(), args.delay, args.timeout, args.max_collections, args.max_products, args.download_images, args.owner_confirmed)
    crawler.crawl()
    return 0


def cmd_package(args):
    return package_qwen_results(Path(args.workspace).resolve(), not args.include_unenriched)


def main() -> int:
    parser = argparse.ArgumentParser(description="Публичный каталог → JSON/изображения → Qwen manifest → CSV для VAPELAB CRM")
    sub = parser.add_subparsers(dest="command", required=True)
    crawl = sub.add_parser("crawl", help="Собрать видимые публичные карточки товаров")
    crawl.add_argument("--base-url", default=BASE_DEFAULT)
    crawl.add_argument("--output", default="./qwen-workspace")
    crawl.add_argument("--delay", type=float, default=1.5)
    crawl.add_argument("--timeout", type=float, default=25)
    crawl.add_argument("--max-collections", type=int, default=400)
    crawl.add_argument("--max-products", type=int, default=10000)
    crawl.add_argument("--download-images", action="store_true", help="Скачать публичные изображения в images/<slug>/; запускайте только при наличии прав")
    crawl.add_argument("--owner-confirmed", action="store_true", help="Подтверждение владельца/разрешения на аудит, используется только если robots.txt не удалось проверить")
    crawl.set_defaults(func=cmd_crawl)
    package = sub.add_parser("package", help="Собрать CSV импорта из source.json + enriched.json")
    package.add_argument("--workspace", default="./qwen-workspace")
    package.add_argument("--include-unenriched", action="store_true", help="Разрешить экспортировать исходные строки без Qwen enriched.json")
    package.set_defaults(func=cmd_package)
    args = parser.parse_args()
    try:
        return args.func(args)
    except Exception as exc:
        print(f"ОШИБКА: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
