from __future__ import annotations

from dataclasses import dataclass


@dataclass
class PropertyItem:
    external_id: str
    titulo: str
    descricao: str
    valor_venda: float | None
    valor_avaliacao: float | None
    cidade: str
    estado: str
    link_caixa: str
    foto_capa: str
