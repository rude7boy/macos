from __future__ import annotations

import logging
import re
from urllib.parse import parse_qs, urljoin, urlparse

import requests
from bs4 import BeautifulSoup

from app.models import PropertyItem

LOGGER = logging.getLogger(__name__)

BASE_URL = "https://venda-imoveis.caixa.gov.br/sistema/busca-imovel.asp?sltTipoBusca=imoveis"


def parse_currency(value: str) -> float | None:
    if not value:
        return None
    clean = re.sub(r"[^\d,\.]", "", value).replace(".", "").replace(",", ".")
    try:
        return float(clean)
    except ValueError:
        return None


def infer_location(text: str) -> tuple[str, str]:
    # formato mais comum: "Cidade / UF"
    loc_match = re.search(r"([A-Za-zÀ-ÿ\-\s]+)\s*/\s*([A-Z]{2})", text or "")
    if loc_match:
        return loc_match.group(1).strip(), loc_match.group(2).strip()
    return "", ""


def build_external_id(link: str, fallback_title: str) -> str:
    if not link:
        return f"title::{fallback_title[:70]}"
    parsed = urlparse(link)
    q = parse_qs(parsed.query)
    for key in ("imovel", "id", "codigoImovel", "nuImovel"):
        if key in q and q[key]:
            return f"{key}::{q[key][0]}"
    path_id = parsed.path.strip("/").replace("/", "_")
    return f"path::{path_id or fallback_title[:70]}"


class CaixaScraper:
    def __init__(self, base_url: str = BASE_URL):
        self.base_url = base_url
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0.0.0 Safari/537.36"
                )
            }
        )

    def fetch_html(self) -> str:
        response = self.session.get(self.base_url, timeout=30)
        response.raise_for_status()
        response.encoding = response.apparent_encoding
        return response.text

    def extract(self) -> list[PropertyItem]:
        html = self.fetch_html()
        return self.extract_from_html(html)

    def extract_from_html(self, html: str) -> list[PropertyItem]:
        soup = BeautifulSoup(html, "html.parser")

        cards = soup.select(".card, .resultado, .item-imovel, .property-item")
        if cards:
            items = self._parse_cards(cards)
            if items:
                return items

        rows = soup.select("table tr")
        items = self._parse_table_rows(rows)
        LOGGER.info("Imoveis extraidos: %s", len(items))
        return items

    def _parse_cards(self, cards) -> list[PropertyItem]:
        items: list[PropertyItem] = []
        for card in cards:
            raw_text = card.get_text(" ", strip=True)
            title_node = card.select_one("h1, h2, h3, .titulo, .title")
            titulo = (title_node.get_text(strip=True) if title_node else raw_text[:120]).strip()

            link_node = card.select_one("a[href*='imovel'], a[href*='detalhe'], a[href]")
            link = urljoin(self.base_url, link_node["href"]) if link_node and link_node.get("href") else ""

            img_node = card.select_one("img")
            foto = urljoin(self.base_url, img_node["src"]) if img_node and img_node.get("src") else ""

            city, state = infer_location(raw_text)
            venda_match = re.search(r"Venda[^R$]*R\$\s*[\d\.\,]+", raw_text, re.IGNORECASE)
            avaliacao_match = re.search(r"Avalia[çc][aã]o[^R$]*R\$\s*[\d\.\,]+", raw_text, re.IGNORECASE)

            valor_venda = parse_currency(venda_match.group(0) if venda_match else "")
            valor_avaliacao = parse_currency(avaliacao_match.group(0) if avaliacao_match else "")

            external_id = build_external_id(link, titulo)
            items.append(
                PropertyItem(
                    external_id=external_id,
                    titulo=titulo,
                    descricao=raw_text,
                    valor_venda=valor_venda,
                    valor_avaliacao=valor_avaliacao,
                    cidade=city,
                    estado=state,
                    link_caixa=link,
                    foto_capa=foto,
                )
            )
        return [i for i in items if i.titulo and i.link_caixa]

    def _parse_table_rows(self, rows) -> list[PropertyItem]:
        items: list[PropertyItem] = []
        for row in rows:
            link_node = row.select_one("a[href]")
            if not link_node:
                continue

            cells = row.find_all("td")
            if not cells:
                continue

            row_text = row.get_text(" ", strip=True)
            titulo = cells[0].get_text(" ", strip=True) if cells else link_node.get_text(" ", strip=True)
            link = urljoin(self.base_url, link_node.get("href", "").strip())
            foto_node = row.select_one("img[src]")
            foto = urljoin(self.base_url, foto_node["src"]) if foto_node else ""

            city, state = infer_location(row_text)
            valor_venda = parse_currency(row_text if "venda" in row_text.lower() else "")
            valor_avaliacao = parse_currency(row_text if "avalia" in row_text.lower() else "")

            external_id = build_external_id(link, titulo)
            items.append(
                PropertyItem(
                    external_id=external_id,
                    titulo=titulo,
                    descricao=row_text,
                    valor_venda=valor_venda,
                    valor_avaliacao=valor_avaliacao,
                    cidade=city,
                    estado=state,
                    link_caixa=link,
                    foto_capa=foto,
                )
            )
        return [i for i in items if i.titulo and i.link_caixa]
