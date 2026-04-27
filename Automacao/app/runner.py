from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime
from pathlib import Path

from app.alerts import send_alert, send_alert_to_file
from app.database import OportunidadesRepository
from app.geocoding import GeocoderService
from app.scraper import CaixaScraper
from app.validation import StrictProdConfig, validate_items, validate_strict_prod


def configure_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Monitor de imoveis Caixa -> SQLite")
    parser.add_argument("--db-path", default="./db/database.sqlite", help="Caminho do SQLite")
    parser.add_argument("--verbose", action="store_true", help="Ativa logs detalhados")
    parser.add_argument("--validate-only", action="store_true", help="Executa apenas validacao de scraping")
    parser.add_argument("--min-items", type=int, default=1, help="Quantidade minima esperada no scraping")
    parser.add_argument("--html-file", default="", help="Arquivo HTML local para validar parser sem rede")
    parser.add_argument("--report-path", default="./reports/validation_report.json", help="Caminho do relatorio JSON")
    parser.add_argument("--strict-prod", action="store_true", help="Ativa validacao rigorosa para producao")
    parser.add_argument("--baseline-report-path", default="./reports/last_validation_report.json", help="Relatorio baseline da execucao anterior")
    parser.add_argument("--min-price-coverage", type=float, default=0.8, help="Cobertura minima de valor_venda no strict-prod")
    parser.add_argument("--min-location-coverage", type=float, default=0.8, help="Cobertura minima de cidade/estado no strict-prod")
    parser.add_argument("--min-states", type=int, default=1, help="Numero minimo de UFs distintas no strict-prod")
    parser.add_argument("--max-drop-ratio", type=float, default=0.6, help="Queda maxima permitida vs baseline no strict-prod")
    parser.add_argument(
        "--history-path",
        default="./reports/validation_history.jsonl",
        help="Historico de validacoes em JSONL",
    )
    return parser.parse_args(argv)


def write_validation_report(report_path: str, payload: dict) -> None:
    target = Path(report_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def append_history(history_path: str, payload: dict) -> None:
    target = Path(history_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a", encoding="utf-8") as fp:
        fp.write(json.dumps(payload, ensure_ascii=False) + "\n")


def read_previous_total_items(report_path: str) -> int | None:
    target = Path(report_path)
    if not target.exists():
        return None
    try:
        payload = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    value = payload.get("total_items")
    return int(value) if isinstance(value, int) else None


def run(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    configure_logging(args.verbose)
    logger = logging.getLogger("runner")

    started_at = datetime.now()
    logger.info("Iniciando monitor da Caixa...")

    scraper = CaixaScraper()
    repo = OportunidadesRepository(args.db_path)
    geocoder = GeocoderService()

    try:
        if args.html_file:
            html = Path(args.html_file).read_text(encoding="utf-8")
            items = scraper.extract_from_html(html)
        else:
            items = scraper.extract()
    except Exception as exc:  # pragma: no cover - guardrail for cron execution
        logger.exception("Erro durante scraping: %s", exc)
        return 1

    validation = validate_items(items, min_items=args.min_items)
    strict_validation = None
    if args.strict_prod:
        strict_config = StrictProdConfig(
            min_price_coverage=args.min_price_coverage,
            min_location_coverage=args.min_location_coverage,
            min_states=args.min_states,
            max_drop_ratio=args.max_drop_ratio,
        )
        baseline_total = read_previous_total_items(args.baseline_report_path)
        strict_validation = validate_strict_prod(items, baseline_total, strict_config)

    report = {
        "executed_at": datetime.now().isoformat(),
        "source": args.html_file or scraper.base_url,
        "total_items": validation.total_items,
        "valid_items": validation.valid_items,
        "error_count": validation.error_count,
        "warning_count": validation.warning_count,
        "errors": validation.errors,
        "warnings": validation.warnings,
        "strict_prod": {
            "enabled": bool(args.strict_prod),
            "error_count": strict_validation.error_count if strict_validation else 0,
            "warning_count": strict_validation.warning_count if strict_validation else 0,
            "errors": strict_validation.errors if strict_validation else [],
            "warnings": strict_validation.warnings if strict_validation else [],
            "thresholds": {
                "min_price_coverage": args.min_price_coverage,
                "min_location_coverage": args.min_location_coverage,
                "min_states": args.min_states,
                "max_drop_ratio": args.max_drop_ratio,
            },
        },
    }
    write_validation_report(args.report_path, report)
    write_validation_report(args.baseline_report_path, report)
    append_history(args.history_path, report)

    if validation.warning_count:
        logger.warning("Validacao com avisos: %s", validation.warning_count)
    if validation.error_count:
        logger.error("Validacao com erros: %s", validation.error_count)
        send_alert("Falha na validacao do scraping (regras basicas).", report)
        send_alert_to_file("Falha na validacao do scraping (regras basicas).", report)
        return 1
    if strict_validation and strict_validation.warning_count:
        logger.warning("Validacao strict-prod com avisos: %s", strict_validation.warning_count)
    if strict_validation and strict_validation.error_count:
        logger.error("Validacao strict-prod com erros: %s", strict_validation.error_count)
        send_alert("Falha na validacao strict-prod do scraping.", report)
        send_alert_to_file("Falha na validacao strict-prod do scraping.", report)
        return 1

    if args.validate_only:
        logger.info("Validacao concluida com sucesso. Nenhuma escrita no banco.")
        return 0

    if not items:
        logger.warning("Nenhum imovel extraido. Encerrando sem alterar banco.")
        return 0

    coords: dict[str, tuple[float | None, float | None]] = {}
    for item in items:
        coords[item.external_id] = geocoder.geocode_city_state(item.cidade, item.estado)

    try:
        result = repo.sync(items, coords)
    except Exception as exc:  # pragma: no cover - guardrail for cron execution
        logger.exception("Erro durante sincronizacao no banco: %s", exc)
        return 1

    elapsed = datetime.now() - started_at
    logger.info(
        "Execucao finalizada. Ativos=%s | Removidos=%s | Tempo=%s",
        result["ativos"],
        result["removidos"],
        elapsed,
    )
    return 0
