from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from flask import Flask, Response, render_template, request


def _read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _read_history(path: Path, limit: int = 30) -> list[dict]:
    if not path.exists():
        return []
    rows: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows[-limit:]


def _query_db(
    db_path: Path,
    status: str = "",
    estado: str = "",
    cidade: str = "",
    query: str = "",
    min_preco: float | None = None,
    max_preco: float | None = None,
    page: int = 1,
    page_size: int = 100,
    sort_by: str = "updated_at",
    sort_dir: str = "desc",
    include_all: bool = False,
) -> dict:
    if not db_path.exists():
        return {"db_exists": False, "stats": {}, "rows": [], "estados": [], "total_filtered": 0, "total_pages": 0}

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        stats = {
            "total": conn.execute("SELECT COUNT(*) FROM oportunidades").fetchone()[0],
            "ativos": conn.execute("SELECT COUNT(*) FROM oportunidades WHERE status='ativo'").fetchone()[0],
            "removidos": conn.execute("SELECT COUNT(*) FROM oportunidades WHERE status='removido'").fetchone()[0],
            "com_preco": conn.execute(
                "SELECT COUNT(*) FROM oportunidades WHERE valor_venda IS NOT NULL AND valor_venda > 0"
            ).fetchone()[0],
            "com_geolocalizacao": conn.execute(
                "SELECT COUNT(*) FROM oportunidades WHERE latitude IS NOT NULL AND longitude IS NOT NULL"
            ).fetchone()[0],
        }
        estados_rows = conn.execute(
            "SELECT DISTINCT estado FROM oportunidades WHERE estado IS NOT NULL AND estado <> '' ORDER BY estado"
        ).fetchall()

        filters: list[str] = []
        params: list[object] = []
        if status:
            filters.append("status = ?")
            params.append(status)
        if estado:
            filters.append("estado = ?")
            params.append(estado)
        if cidade:
            filters.append("LOWER(cidade) LIKE ?")
            params.append(f"%{cidade.lower()}%")
        if query:
            filters.append("(LOWER(titulo) LIKE ? OR LOWER(descricao) LIKE ?)")
            pattern = f"%{query.lower()}%"
            params.extend([pattern, pattern])
        if min_preco is not None:
            filters.append("valor_venda >= ?")
            params.append(min_preco)
        if max_preco is not None:
            filters.append("valor_venda <= ?")
            params.append(max_preco)

        where_clause = f"WHERE {' AND '.join(filters)}" if filters else ""
        total_filtered = conn.execute(
            f"SELECT COUNT(*) FROM oportunidades {where_clause}",
            params,
        ).fetchone()[0]

        safe_sort_columns = {
            "titulo": "titulo",
            "valor_venda": "valor_venda",
            "cidade": "cidade",
            "estado": "estado",
            "status": "status",
            "updated_at": "updated_at",
        }
        sort_column = safe_sort_columns.get(sort_by, "updated_at")
        safe_sort_dir = "ASC" if sort_dir.lower() == "asc" else "DESC"
        safe_page = max(page, 1)
        safe_page_size = max(1, min(page_size, 500))
        offset = (safe_page - 1) * safe_page_size

        query_params = list(params)
        limit_clause = ""
        if not include_all:
            limit_clause = "LIMIT ? OFFSET ?"
            query_params.extend([safe_page_size, offset])

        rows = conn.execute(
            f"""
            SELECT titulo, valor_venda, cidade, estado, link_caixa, status, updated_at
            FROM oportunidades
            {where_clause}
            ORDER BY {sort_column} {safe_sort_dir}
            {limit_clause}
            """,
            query_params,
        ).fetchall()

    total_pages = 1 if include_all else (int((total_filtered + safe_page_size - 1) / safe_page_size) if total_filtered else 0)
    return {
        "db_exists": True,
        "stats": stats,
        "rows": [dict(r) for r in rows],
        "estados": [r[0] for r in estados_rows if r[0]],
        "total_filtered": int(total_filtered),
        "total_pages": int(total_pages),
    }


def _parse_float(value: str) -> float | None:
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _parse_int(value: str, default: int) -> int:
    if not value:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def create_app() -> Flask:
    app = Flask(__name__, template_folder="../templates")

    @app.route("/")
    def index():
        root = Path(".")
        report = _read_json(root / "reports" / "validation_report.json")
        history = _read_history(root / "reports" / "validation_history.jsonl")
        filters = {
            "status": request.args.get("status", "").strip(),
            "estado": request.args.get("estado", "").strip(),
            "cidade": request.args.get("cidade", "").strip(),
            "query": request.args.get("query", "").strip(),
            "min_preco": request.args.get("min_preco", "").strip(),
            "max_preco": request.args.get("max_preco", "").strip(),
            "page": request.args.get("page", "1").strip(),
            "page_size": request.args.get("page_size", "100").strip(),
            "sort_by": request.args.get("sort_by", "updated_at").strip(),
            "sort_dir": request.args.get("sort_dir", "desc").strip(),
        }
        page = _parse_int(filters["page"], 1)
        page_size = _parse_int(filters["page_size"], 100)
        db_payload = _query_db(
            root / "db" / "database.sqlite",
            status=filters["status"],
            estado=filters["estado"],
            cidade=filters["cidade"],
            query=filters["query"],
            min_preco=_parse_float(filters["min_preco"]),
            max_preco=_parse_float(filters["max_preco"]),
            page=page,
            page_size=page_size,
            sort_by=filters["sort_by"],
            sort_dir=filters["sort_dir"],
        )

        strict = report.get("strict_prod", {})
        health_ok = bool(report) and report.get("error_count", 1) == 0 and strict.get("error_count", 0) == 0

        return render_template(
            "index.html",
            report=report,
            strict=strict,
            history=history,
            db_payload=db_payload,
            health_ok=health_ok,
            filters=filters,
            page=page,
            page_size=page_size,
        )

    @app.route("/export.csv")
    def export_csv():
        root = Path(".")
        status = request.args.get("status", "").strip()
        estado = request.args.get("estado", "").strip()
        cidade = request.args.get("cidade", "").strip()
        query = request.args.get("query", "").strip()
        min_preco = _parse_float(request.args.get("min_preco", "").strip())
        max_preco = _parse_float(request.args.get("max_preco", "").strip())
        sort_by = request.args.get("sort_by", "updated_at").strip()
        sort_dir = request.args.get("sort_dir", "desc").strip()
        payload = _query_db(
            root / "db" / "database.sqlite",
            status=status,
            estado=estado,
            cidade=cidade,
            query=query,
            min_preco=min_preco,
            max_preco=max_preco,
            sort_by=sort_by,
            sort_dir=sort_dir,
            include_all=True,
        )
        lines = ["titulo,valor_venda,cidade,estado,status,updated_at,link_caixa"]
        for row in payload["rows"]:
            safe = lambda v: str(v or "").replace('"', '""')
            lines.append(
                f"\"{safe(row['titulo'])}\",\"{safe(row['valor_venda'])}\","
                f"\"{safe(row['cidade'])}\",\"{safe(row['estado'])}\","
                f"\"{safe(row['status'])}\",\"{safe(row['updated_at'])}\",\"{safe(row['link_caixa'])}\""
            )
        content = "\n".join(lines)
        return Response(
            content,
            mimetype="text/csv",
            headers={"Content-Disposition": "attachment; filename=oportunidades.csv"},
        )

    return app
