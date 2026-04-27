#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-$ROOT_DIR/.venv/bin/python}"

if [[ ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="python3"
fi

mkdir -p "$ROOT_DIR/logs" "$ROOT_DIR/reports"

TIMESTAMP="$(date '+%Y-%m-%d %H:%M:%S')"
echo "[$TIMESTAMP] Iniciando validacao de producao..."

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
  --verbose

TIMESTAMP_END="$(date '+%Y-%m-%d %H:%M:%S')"
echo "[$TIMESTAMP_END] Validacao de producao concluida com sucesso."
