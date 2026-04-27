from __future__ import annotations

import json
import logging
import os

import requests

LOGGER = logging.getLogger(__name__)


def _post_json(url: str, payload: dict) -> bool:
    try:
        response = requests.post(url, json=payload, timeout=15)
        response.raise_for_status()
        return True
    except requests.RequestException as exc:
        LOGGER.warning("Falha ao enviar alerta para webhook: %s", exc)
        return False


def send_alert(message: str, report: dict) -> None:
    """
    Envia alertas para canais configurados por variaveis de ambiente.
    Suportado:
    - ALERT_WEBHOOK_URL: webhook genérico JSON {message, report}
    - TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID: mensagem resumida
    """
    webhook_url = os.getenv("ALERT_WEBHOOK_URL", "").strip()
    if webhook_url:
        _post_json(webhook_url, {"message": message, "report": report})

    bot_token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.getenv("TELEGRAM_CHAT_ID", "").strip()
    if bot_token and chat_id:
        telegram_url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        text = (
            f"{message}\n"
            f"Total: {report.get('total_items', 0)} | "
            f"Erros: {report.get('error_count', 0)} | "
            f"Erros strict: {report.get('strict_prod', {}).get('error_count', 0)}"
        )
        try:
            response = requests.post(
                telegram_url,
                data={"chat_id": chat_id, "text": text},
                timeout=15,
            )
            response.raise_for_status()
        except requests.RequestException as exc:
            LOGGER.warning("Falha ao enviar alerta Telegram: %s", exc)


def send_alert_to_file(message: str, report: dict, path: str = "./logs/alerts.log") -> None:
    """
    Fallback local para auditoria de alertas quando nenhum canal remoto estiver configurado.
    """
    target = os.path.abspath(path)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    payload = {"message": message, "report": report}
    with open(target, "a", encoding="utf-8") as fp:
        fp.write(json.dumps(payload, ensure_ascii=False) + "\n")
