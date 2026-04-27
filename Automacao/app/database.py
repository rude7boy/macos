from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

from app.models import PropertyItem

LOGGER = logging.getLogger(__name__)


class OportunidadesRepository:
    def __init__(self, db_path: str = "./db/database.sqlite"):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def ensure_schema(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS oportunidades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                titulo TEXT,
                descricao TEXT,
                valor_venda REAL,
                cidade TEXT,
                estado TEXT,
                latitude REAL,
                longitude REAL,
                link_caixa TEXT UNIQUE,
                foto_capa TEXT,
                status TEXT DEFAULT 'ativo',
                external_id TEXT,
                valor_avaliacao REAL,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_oportunidades_external_id ON oportunidades(external_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_oportunidades_status ON oportunidades(status)")
        conn.commit()

    def fetch_existing_keys(self, conn: sqlite3.Connection) -> dict[str, int]:
        rows = conn.execute("SELECT id, link_caixa, external_id FROM oportunidades").fetchall()
        keys: dict[str, int] = {}
        for row in rows:
            if row["link_caixa"]:
                keys[f"link::{row['link_caixa']}"] = int(row["id"])
            if row["external_id"]:
                keys[f"id::{row['external_id']}"] = int(row["id"])
        return keys

    def upsert_items(
        self,
        conn: sqlite3.Connection,
        items: list[PropertyItem],
        coordinates_lookup: dict[str, tuple[float | None, float | None]],
    ) -> set[int]:
        touched_ids: set[int] = set()
        keys = self.fetch_existing_keys(conn)

        for item in items:
            lat, lon = coordinates_lookup.get(item.external_id, (None, None))
            existing_id = (
                keys.get(f"link::{item.link_caixa}")
                or keys.get(f"id::{item.external_id}")
            )

            payload = (
                item.titulo,
                item.descricao,
                item.valor_venda,
                item.cidade,
                item.estado,
                lat,
                lon,
                item.link_caixa,
                item.foto_capa,
                "ativo",
                item.external_id,
                item.valor_avaliacao,
            )

            if existing_id:
                conn.execute(
                    """
                    UPDATE oportunidades
                    SET titulo = ?,
                        descricao = ?,
                        valor_venda = ?,
                        cidade = ?,
                        estado = ?,
                        latitude = ?,
                        longitude = ?,
                        link_caixa = ?,
                        foto_capa = ?,
                        status = ?,
                        external_id = ?,
                        valor_avaliacao = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (*payload, existing_id),
                )
                touched_ids.add(existing_id)
            else:
                cursor = conn.execute(
                    """
                    INSERT INTO oportunidades (
                        titulo, descricao, valor_venda, cidade, estado,
                        latitude, longitude, link_caixa, foto_capa, status,
                        external_id, valor_avaliacao
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    payload,
                )
                new_id = int(cursor.lastrowid)
                touched_ids.add(new_id)
                keys[f"link::{item.link_caixa}"] = new_id
                keys[f"id::{item.external_id}"] = new_id

        conn.commit()
        return touched_ids

    def mark_removed(self, conn: sqlite3.Connection, active_ids: set[int]) -> int:
        if not active_ids:
            cur = conn.execute("UPDATE oportunidades SET status = 'removido', updated_at = CURRENT_TIMESTAMP")
            conn.commit()
            return cur.rowcount

        placeholders = ",".join("?" for _ in active_ids)
        cur = conn.execute(
            f"""
            UPDATE oportunidades
            SET status = 'removido', updated_at = CURRENT_TIMESTAMP
            WHERE id NOT IN ({placeholders})
            """,
            tuple(active_ids),
        )
        conn.commit()
        return cur.rowcount

    def sync(
        self,
        items: list[PropertyItem],
        coordinates_lookup: dict[str, tuple[float | None, float | None]],
    ) -> dict[str, int]:
        with self.connect() as conn:
            self.ensure_schema(conn)
            touched_ids = self.upsert_items(conn, items, coordinates_lookup)
            removed = self.mark_removed(conn, touched_ids)
            LOGGER.info("Sincronizacao concluida. Ativos: %s | Removidos: %s", len(touched_ids), removed)
            return {"ativos": len(touched_ids), "removidos": removed}
