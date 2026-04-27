#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-$ROOT_DIR/.venv/bin/python}"

if [[ ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="python3"
fi

mkdir -p "$ROOT_DIR/logs" "$ROOT_DIR/reports"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Etapa 1/2: validacao strict-prod..."
"$PYTHON_BIN" "$ROOT_DIR/monitor_caixa.py" \
  --validate-only \
  --strict-prod \
  --min-items "${MIN_ITEMS:-40}" \
  --min-price-coverage "${MIN_PRICE_COVERAGE:-0.85}" \
  --min-location-coverage "${MIN_LOCATION_COVERAGE:-0.85}" \
  --min-states "${MIN_STATES:-8}" \
  --max-drop-ratio "${MAX_DROP_RATIO:-0.40}" \
  --report-path "$ROOT_DIR/reports/validation_report.json" \
  --baseline-report-path "$ROOT_DIR/reports/last_validation_report.json" \
  --history-path "$ROOT_DIR/reports/validation_history.jsonl" \
  --verbose

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Etapa 2/2: sincronizacao com banco..."
"$PYTHON_BIN" "$ROOT_DIR/monitor_caixa.py" \
  --db-path "${DB_PATH:-$ROOT_DIR/db/database.sqlite}" \
  --report-path "$ROOT_DIR/reports/validation_report.json" \
  --baseline-report-path "$ROOT_DIR/reports/last_validation_report.json" \
  --history-path "$ROOT_DIR/reports/validation_history.jsonl" \
  --verbose

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Pipeline de producao concluido."
