from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse

from app.models import PropertyItem


@dataclass
class ValidationResult:
    total_items: int
    valid_items: int
    error_count: int
    warning_count: int
    errors: list[str]
    warnings: list[str]

    @property
    def success(self) -> bool:
        return self.error_count == 0


@dataclass
class StrictProdConfig:
    min_price_coverage: float = 0.8
    min_location_coverage: float = 0.8
    min_states: int = 1
    max_drop_ratio: float = 0.6


def _is_http_url(url: str) -> bool:
    if not url:
        return False
    parsed = urlparse(url)
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


def validate_items(items: list[PropertyItem], min_items: int = 1) -> ValidationResult:
    errors: list[str] = []
    warnings: list[str] = []
    valid_items = 0

    if len(items) < min_items:
        errors.append(f"Quantidade insuficiente de itens: {len(items)} < {min_items}")

    seen_links: set[str] = set()
    seen_external_ids: set[str] = set()

    for idx, item in enumerate(items, start=1):
        item_errors: list[str] = []
        item_warnings: list[str] = []

        if not item.titulo:
            item_errors.append("titulo vazio")
        if not item.link_caixa:
            item_errors.append("link_caixa vazio")
        if item.link_caixa and not _is_http_url(item.link_caixa):
            item_errors.append("link_caixa invalido")
        if item.foto_capa and not _is_http_url(item.foto_capa):
            item_warnings.append("foto_capa sem URL valida")
        if item.valor_venda is not None and item.valor_venda <= 0:
            item_warnings.append("valor_venda nao positivo")
        if item.valor_avaliacao is not None and item.valor_avaliacao <= 0:
            item_warnings.append("valor_avaliacao nao positivo")
        if not item.cidade or not item.estado:
            item_warnings.append("cidade/estado ausentes")
        if item.link_caixa in seen_links:
            item_errors.append("link_caixa duplicado")
        if item.external_id in seen_external_ids:
            item_warnings.append("external_id duplicado")

        seen_links.add(item.link_caixa)
        seen_external_ids.add(item.external_id)

        if item_errors:
            for message in item_errors:
                errors.append(f"[item {idx}] {message}")
        else:
            valid_items += 1
        for message in item_warnings:
            warnings.append(f"[item {idx}] {message}")

    return ValidationResult(
        total_items=len(items),
        valid_items=valid_items,
        error_count=len(errors),
        warning_count=len(warnings),
        errors=errors,
        warnings=warnings,
    )


def validate_strict_prod(
    items: list[PropertyItem],
    baseline_total_items: int | None,
    config: StrictProdConfig,
) -> ValidationResult:
    errors: list[str] = []
    warnings: list[str] = []
    total_items = len(items)

    if total_items == 0:
        errors.append("Nenhum item extraido em modo strict-prod")
        return ValidationResult(
            total_items=0,
            valid_items=0,
            error_count=1,
            warning_count=0,
            errors=errors,
            warnings=warnings,
        )

    with_price = sum(1 for i in items if i.valor_venda is not None and i.valor_venda > 0)
    with_location = sum(1 for i in items if i.cidade and i.estado)
    states = {i.estado for i in items if i.estado}

    price_coverage = with_price / total_items
    location_coverage = with_location / total_items

    if price_coverage < config.min_price_coverage:
        errors.append(
            f"Cobertura de valor_venda baixa: {price_coverage:.2%} < {config.min_price_coverage:.2%}"
        )
    if location_coverage < config.min_location_coverage:
        errors.append(
            f"Cobertura de cidade/estado baixa: {location_coverage:.2%} < {config.min_location_coverage:.2%}"
        )
    if len(states) < config.min_states:
        errors.append(f"Poucas UFs identificadas: {len(states)} < {config.min_states}")

    if baseline_total_items is not None and baseline_total_items > 0:
        threshold = baseline_total_items * (1 - config.max_drop_ratio)
        if total_items < threshold:
            errors.append(
                f"Queda abrupta de volume: atual={total_items} baseline={baseline_total_items} "
                f"queda_max={config.max_drop_ratio:.0%}"
            )
    else:
        warnings.append("Sem baseline anterior para validar queda de volume")

    return ValidationResult(
        total_items=total_items,
        valid_items=total_items - len(errors),
        error_count=len(errors),
        warning_count=len(warnings),
        errors=errors,
        warnings=warnings,
    )
