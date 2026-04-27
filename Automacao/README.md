# Monitor de Imoveis da Caixa

Script em Python para monitorar imoveis de leilao da Caixa, sincronizando com SQLite e atualizando status de anuncios removidos.

## Requisitos

- Python 3.9+
- Dependencias em `requirements.txt`

## Instalacao

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Execucao

```bash
python3 monitor_caixa.py --db-path ./db/database.sqlite
```

Modo verboso:

```bash
python3 monitor_caixa.py --verbose
```

## Sistema de validacao (100% operacional)

### 1) Validacao offline (sem rede)

Usa um HTML local para comprovar se o parser continua funcionando:

```bash
python3 monitor_caixa.py --validate-only --html-file fixtures/caixa_sample.html --min-items 2
```

### 2) Validacao online (site real)

Executa scraping real e falha se nao atingir a qualidade minima:

```bash
python3 monitor_caixa.py --validate-only --min-items 10
```

### 3) Relatorio estruturado

Toda validacao gera JSON em:

- `./reports/validation_report.json`

Conteudo do relatorio:

- total de itens
- itens validos
- quantidade de erros/avisos
- lista detalhada de erros/avisos por item

### 5) Modo rigoroso de producao (`--strict-prod`)

Esse modo bloqueia a execucao quando detectar anomalias tipicas de quebra de scraping:

- queda abrupta no volume de imoveis vs ultima execucao
- baixa cobertura de `valor_venda`
- baixa cobertura de `cidade/estado`
- baixa diversidade de UFs

Exemplo:

```bash
python3 monitor_caixa.py \
  --validate-only \
  --strict-prod \
  --min-items 20 \
  --min-price-coverage 0.85 \
  --min-location-coverage 0.85 \
  --min-states 5 \
  --max-drop-ratio 0.40
```

Baseline usado para comparar volume:

- `./reports/last_validation_report.json`

Voce pode trocar com `--baseline-report-path`.

### 6) Perfil recomendado Caixa + script pronto

Criei um script com perfil de producao recomendado:

- `scripts/validate_prod.sh`

Thresholds padrao do perfil:

- `MIN_ITEMS=40`
- `MIN_PRICE_COVERAGE=0.85`
- `MIN_LOCATION_COVERAGE=0.85`
- `MIN_STATES=8`
- `MAX_DROP_RATIO=0.40`

Rodar:

```bash
./scripts/validate_prod.sh
```

Sobrescrever thresholds (exemplo):

```bash
MIN_ITEMS=30 MIN_STATES=6 ./scripts/validate_prod.sh
```

Esse script:

- executa em `--validate-only --strict-prod`
- grava em `reports/validation_report.json`
- atualiza baseline em `reports/last_validation_report.json`
- retorna erro (exit code `1`) quando a validacao reprova

### 4) Testes automatizados

```bash
python3 -m unittest discover -s tests -p "test_*.py"
```

## Regras de sincronizacao

- Identificador principal: `link_caixa` e fallback em `external_id` (derivado do link/ID da Caixa).
- Se ja existe: faz `UPDATE`.
- Se nao existe: faz `INSERT`.
- Se existe no banco mas nao voltou do scraping: muda `status` para `removido`.

## Tabela alvo

O script garante a criacao da tabela `oportunidades` com as colunas solicitadas:

- `titulo`
- `descricao`
- `valor_venda`
- `cidade`
- `estado`
- `latitude`
- `longitude`
- `link_caixa`
- `foto_capa`
- `status`

Campos extras adicionados para robustez da sincronizacao: `external_id`, `valor_avaliacao`, `updated_at`.

## Cron Job (exemplo)

Executar a cada hora:

```cron
0 * * * * cd /Users/erickyan/Desktop/Automacao && /Users/erickyan/Desktop/Automacao/.venv/bin/python monitor_caixa.py >> logs/cron.log 2>&1
```

Antes, crie o diretorio de logs:

```bash
mkdir -p logs
```

Cron para validacao de producao a cada hora:

```cron
0 * * * * cd /Users/erickyan/Desktop/Automacao && ./scripts/validate_prod.sh >> logs/validate_prod.log 2>&1
```

### 7) Pipeline completo em producao (validar + sincronizar)

Script criado:

- `scripts/run_prod.sh`

Fluxo:

1. executa validacao strict-prod
2. somente se passar, sincroniza SQLite

Rodar manual:

```bash
./scripts/run_prod.sh
```

Cron exemplo:

```cron
10 * * * * cd /Users/erickyan/Desktop/Automacao && ./scripts/run_prod.sh >> logs/run_prod.log 2>&1
```

## Dashboard de controle

Painel criado para acompanhar se o scraping esta saudavel:

- `dashboard.py` (servidor Flask)
- `templates/index.html` (interface)

Informacoes exibidas:

- saude geral (operacional/atencao)
- metricas do ultimo scraping (itens, erros, avisos)
- metricas do strict-prod
- status do banco (ativos/removidos/com geolocalizacao)
- historico de execucoes (grafico)
- tabela com ultimos 100 imoveis monitorados
- filtros por status, UF, cidade, texto e faixa de preco
- exportacao CSV dos registros filtrados

Executar dashboard:

```bash
python3 dashboard.py
```

Abrir no navegador:

- `http://localhost:8080`

Exportacao CSV:

- `http://localhost:8080/export.csv` (respeita os filtros da tela)

## Alertas automáticos

Quando houver falha de validacao (normal ou strict-prod), o sistema envia alerta e registra fallback local.

Canais suportados:

- Webhook generico (`ALERT_WEBHOOK_URL`)
- Telegram (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`)
- Fallback local em `logs/alerts.log`

Exemplo com webhook:

```bash
ALERT_WEBHOOK_URL="https://seu-webhook" ./scripts/run_prod.sh
```

Exemplo com Telegram:

```bash
TELEGRAM_BOT_TOKEN="xxx" TELEGRAM_CHAT_ID="123456" ./scripts/run_prod.sh
```
