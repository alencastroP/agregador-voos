# Gerador do dashboard do Grafana (fonte da verdade continua sendo o JSON versionado).
# Uso: python observability/grafana/build_dashboard.py observability/grafana/dashboards/aggregator.json
# Mudou um painel? Edite aqui, regenere e rode `make test`: o teste de integração executa
# toda query SQL do JSON contra o Postgres real.
"""Gera observability/grafana/dashboards/aggregator.json (versionado no repo)."""
import json, sys

PG = {"type": "grafana-postgresql-datasource", "uid": "postgres"}
PROM = {"type": "prometheus", "uid": "prometheus"}

panels = []
_id = [0]


def nid():
    _id[0] += 1
    return _id[0]


def row(title, y):
    panels.append({"type": "row", "title": title, "id": nid(), "collapsed": False,
                   "gridPos": {"h": 1, "w": 24, "x": 0, "y": y}, "panels": []})


def sql(raw, fmt="table", ref="A"):
    return {"datasource": PG, "refId": ref, "format": fmt, "rawQuery": True, "editorMode": "code",
            "rawSql": raw.strip()}


def prom(expr, legend, ref="A", instant=False):
    """instant=True para painéis de número único: um valor sobre o período inteiro ($__range)."""
    return {"datasource": PROM, "refId": ref, "expr": expr, "legendFormat": legend,
            "range": not instant, "instant": instant}


def stat(title, desc, target, pos, unit="none", decimals=None, thresholds=None, ds=PG):
    p = {"type": "stat", "title": title, "description": desc, "id": nid(), "datasource": ds,
         "gridPos": pos, "targets": [target],
         "options": {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
                     "colorMode": "value", "graphMode": "none", "textMode": "value", "justifyMode": "center"},
         "fieldConfig": {"defaults": {"unit": unit, "color": {"mode": "thresholds"},
                                      "thresholds": {"mode": "absolute",
                                                     "steps": thresholds or [{"color": "blue", "value": None}]}},
                         "overrides": []}}
    if decimals is not None:
        p["fieldConfig"]["defaults"]["decimals"] = decimals
    panels.append(p)


def timeseries(title, desc, targets, pos, unit="none", ds=PG, stack=False, overrides=None):
    panels.append({"type": "timeseries", "title": title, "description": desc, "id": nid(), "datasource": ds,
                   "gridPos": pos, "targets": targets,
                   "options": {"legend": {"displayMode": "list", "placement": "bottom", "showLegend": True},
                               "tooltip": {"mode": "multi", "sort": "desc"}},
                   "fieldConfig": {"defaults": {"unit": unit, "custom": {
                       "drawStyle": "line", "lineWidth": 2, "fillOpacity": 15, "showPoints": "auto",
                       "stacking": {"mode": "normal" if stack else "none", "group": "A"}}},
                       "overrides": overrides or []}})


def table(title, desc, target, pos, overrides=None):
    panels.append({"type": "table", "title": title, "description": desc, "id": nid(), "datasource": PG,
                   "gridPos": pos, "targets": [target],
                   "options": {"showHeader": True, "cellHeight": "sm"},
                   "fieldConfig": {"defaults": {}, "overrides": overrides or []}})


def color(name, c):
    return {"matcher": {"id": "byName", "options": name},
            "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": c}}]}


# Base: só buscas CALCULADAS (cache hit não repete ofertas, ver schema.ts)
OFFERS = """FROM selected_offers o JOIN searches s ON s.id = o.search_id WHERE $__timeFilter(s.requested_at)"""

# ===================================================================== NEGÓCIO
y = 0
row("💰 Negócio: a estratégia vale a pena? (Postgres)", y); y += 1
stat("Incentivo a mais vs. 'sempre o mais barato'",
     "Quanto a estratégia rende a mais do que exibir sempre a oferta mais barata (soma das ofertas exibidas, R$).",
     sql(f"SELECT coalesce(sum(o.incentive_gain_vs_cheapest_cents), 0) / 100.0 AS ganho {OFFERS}"),
     {"h": 5, "w": 5, "x": 0, "y": y}, unit="currencyBRL", decimals=2,
     thresholds=[{"color": "green", "value": None}])
stat("Custo extra para o cliente",
     "Quanto o cliente pagaria a mais, somado, por exibirmos uma oferta que não é a mais barata (R$).",
     sql(f"SELECT coalesce(sum(o.customer_delta_cents), 0) / 100.0 AS custo {OFFERS}"),
     {"h": 5, "w": 5, "x": 5, "y": y}, unit="currencyBRL", decimals=2,
     thresholds=[{"color": "orange", "value": None}])
stat("R$ do cliente por R$ 1 ganho",
     "Custo do cliente ÷ ganho da empresa. Abaixo de 1 = ganha-ganha; a 'max_incentive' fica em ~3,3.",
     sql(f"SELECT sum(o.customer_delta_cents)::numeric / nullif(sum(o.incentive_gain_vs_cheapest_cents), 0) AS razao {OFFERS}"),
     {"h": 5, "w": 4, "x": 10, "y": y}, decimals=2,
     thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 1.0}, {"color": "red", "value": 2.0}])
stat("Voos em que a escolha ≠ mais barato",
     "% das ofertas exibidas em que a estratégia não mostrou a mais barata (balanced ≈ 17%, max_incentive ≈ 58%).",
     sql(f"SELECT 100.0 * avg((o.customer_delta_cents > 0)::int) AS pct {OFFERS}"),
     {"h": 5, "w": 5, "x": 14, "y": y}, unit="percent", decimals=1,
     thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 25}, {"color": "red", "value": 40}])
stat("Custo extra médio por voo afetado",
     "Nos voos em que a escolha diferiu do mais barato, quanto o cliente pagaria a mais, em média.",
     sql(f"SELECT avg(o.customer_delta_cents) FILTER (WHERE o.customer_delta_cents > 0) / 100.0 AS medio {OFFERS}"),
     {"h": 5, "w": 5, "x": 19, "y": y}, unit="currencyBRL", decimals=2,
     thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 15}, {"color": "red", "value": 25}])
y += 5
timeseries("Ganho da empresa × custo do cliente (por hora)",
           "O principal argumento de negócio: a linha verde precisa crescer sem a laranja disparar.",
           [sql(f"""SELECT $__timeGroupAlias(s.requested_at, '1h'),
       sum(o.incentive_gain_vs_cheapest_cents) / 100.0 AS "Incentivo a mais (R$)",
       sum(o.customer_delta_cents) / 100.0 AS "Custo extra do cliente (R$)"
{OFFERS}
GROUP BY 1 ORDER BY 1""", fmt="time_series")],
           {"h": 8, "w": 14, "x": 0, "y": y}, unit="currencyBRL",
           overrides=[color("Incentivo a mais (R$)", "green"), color("Custo extra do cliente (R$)", "orange")])
panels.append({"type": "piechart", "title": "Share de vitória por provider",
               "description": "De quem é a oferta exibida. B domina A (mais barato e rende mais); C só vence dentro da banda.",
               "id": nid(), "datasource": PG, "gridPos": {"h": 8, "w": 5, "x": 14, "y": y},
               "targets": [sql(f"SELECT o.chosen_provider AS provider, count(*) AS voos {OFFERS} GROUP BY 1 ORDER BY 1")],
               "options": {"reduceOptions": {"values": True, "calcs": [], "fields": ""}, "pieType": "donut",
                           "legend": {"displayMode": "table", "placement": "bottom", "values": ["percent"], "showLegend": True},
                           "displayLabels": ["percent"]},
               "fieldConfig": {"defaults": {}, "overrides": []}})
table("Escolhido × mais barato",
      "Quando o provider exibido não é o mais barato, de quem é a oferta mais barata e quanto custa a diferença.",
      sql(f"""SELECT o.chosen_provider AS "exibido", o.cheapest_provider AS "mais barato",
       count(*) AS "voos",
       round(avg(o.customer_delta_cents) / 100.0, 2) AS "Δ cliente médio (R$)",
       round(avg(o.incentive_gain_vs_cheapest_cents) / 100.0, 2) AS "ganho médio (R$)"
{OFFERS}
GROUP BY 1, 2 ORDER BY 3 DESC"""),
      {"h": 8, "w": 5, "x": 19, "y": y})
y += 8

# ==================================================================== OPERAÇÃO
row("⚙️ Operação: providers, resiliência e cache (Prometheus)", y); y += 1
timeseries("Disponibilidade por provider (%)",
           "Chamadas lógicas (já com retry) que terminaram ok. Com `make chaos`, o provider-c cai para ~89%.",
           [prom('100 * sum by (provider) (rate(provider_request_duration_seconds_count{status="ok"}[$__rate_interval])) '
                 '/ sum by (provider) (rate(provider_request_duration_seconds_count[$__rate_interval]))', "{{provider}}")],
           {"h": 8, "w": 8, "x": 0, "y": y}, unit="percent", ds=PROM)
timeseries("Latência por provider: p50 / p95 / p99",
           "Inclui retries. O orçamento por provider é 3 s.",
           [prom('histogram_quantile(0.50, sum by (le, provider) (rate(provider_request_duration_seconds_bucket[$__rate_interval])))', "p50 {{provider}}", "A"),
            prom('histogram_quantile(0.95, sum by (le, provider) (rate(provider_request_duration_seconds_bucket[$__rate_interval])))', "p95 {{provider}}", "B"),
            prom('histogram_quantile(0.99, sum by (le, provider) (rate(provider_request_duration_seconds_bucket[$__rate_interval])))', "p99 {{provider}}", "C")],
           {"h": 8, "w": 8, "x": 8, "y": y}, unit="s", ds=PROM)
panels.append({"type": "state-timeline", "title": "Circuit breaker por provider",
               "description": "Verde = fechado; amarelo = half-open (sonda); vermelho = aberto (provider pulado).",
               "id": nid(), "datasource": PROM, "gridPos": {"h": 8, "w": 8, "x": 16, "y": y},
               "targets": [prom("max by (provider) (circuit_breaker_state)", "{{provider}}")],
               "options": {"showValue": "never", "mergeValues": True, "rowHeight": 0.8,
                           "legend": {"showLegend": False}},
               "fieldConfig": {"defaults": {"color": {"mode": "thresholds"},
                                            "thresholds": {"mode": "absolute", "steps": [
                                                {"color": "green", "value": None}, {"color": "yellow", "value": 1},
                                                {"color": "red", "value": 2}]},
                                            "mappings": [{"type": "value", "options": {
                                                "0": {"text": "fechado", "color": "green"},
                                                "1": {"text": "half-open", "color": "yellow"},
                                                "2": {"text": "aberto", "color": "red"}}}]},
                               "overrides": []}})
y += 8
timeseries("Taxa de timeout e erro por provider (%)",
           "Fração das chamadas lógicas que terminaram em timeout ou erro.",
           [prom('100 * sum by (provider, type) (rate(provider_errors_total[$__rate_interval])) '
                 '/ on (provider) group_left sum by (provider) (rate(provider_request_duration_seconds_count[$__rate_interval]))',
                 "{{provider}} {{type}}")],
           {"h": 7, "w": 8, "x": 0, "y": y}, unit="percent", ds=PROM)
timeseries("Buscas por resultado (req/s)",
           "ok × parcial (algum provider falhou) × todos falharam (503).",
           [prom("sum by (outcome) (rate(search_requests_total[$__rate_interval]))", "{{outcome}}")],
           {"h": 7, "w": 8, "x": 8, "y": y}, unit="reqps", ds=PROM, stack=True,
           overrides=[color("ok", "green"), color("partial", "orange"), color("all_failed", "red")])
stat("Cache hit ratio",
     "Buscas servidas do Redis ÷ total, no período do dashboard. Falha do Redis conta como miss.",
     prom("sum(increase(cache_hits_total[$__range])) / (sum(increase(cache_hits_total[$__range])) + sum(increase(cache_misses_total[$__range])))", "hit ratio", instant=True),
     {"h": 7, "w": 4, "x": 16, "y": y}, unit="percentunit", decimals=1, ds=PROM,
     thresholds=[{"color": "orange", "value": None}, {"color": "green", "value": 0.3}])
stat("p95 do POST /search",
     "Latência de ponta a ponta percebida pelo agente, no período do dashboard.",
     prom('histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{route="/search"}[$__range])))', "p95", instant=True),
     {"h": 7, "w": 4, "x": 20, "y": y}, unit="s", decimals=2, ds=PROM,
     thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 1.5}, {"color": "red", "value": 3}])
y += 7
timeseries("Qualidade dos dados: ofertas descartadas por motivo",
           "Registros sujos dos providers (moeda estrangeira, preço zero, fora do contrato).",
           [prom("sum by (provider, reason) (increase(offers_discarded_total[$__rate_interval]))", "{{provider}} · {{reason}}")],
           {"h": 6, "w": 12, "x": 0, "y": y}, ds=PROM, stack=True)
timeseries("Retries e buscas coalescidas",
           "Tentativas extras do retry e buscas que pegaram carona numa idêntica em andamento (single-flight).",
           [prom("sum by (provider) (increase(provider_retries_total[$__rate_interval]))", "retries {{provider}}", "A"),
            prom("sum(increase(search_coalesced_total[$__rate_interval]))", "coalescidas", "B")],
           {"h": 6, "w": 12, "x": 12, "y": y}, ds=PROM)
y += 6

# ===================================================================== DEMANDA
row("📈 Demanda: o que os agentes estão buscando (Postgres)", y); y += 1
stat("Buscas no período", "Todas as buscas servidas, inclusive do cache.",
     sql("SELECT count(*) AS buscas FROM searches WHERE $__timeFilter(requested_at)"),
     {"h": 5, "w": 4, "x": 0, "y": y})
stat("Antecedência média (dias)", "Data da viagem − data da busca (fuso de São Paulo).",
     sql("""SELECT avg(travel_date - (requested_at AT TIME ZONE 'America/Sao_Paulo')::date) AS dias
FROM searches WHERE $__timeFilter(requested_at)"""),
     {"h": 5, "w": 4, "x": 4, "y": y}, decimals=0)
stat("Buscas parciais", "% de buscas em que algum provider falhou.",
     sql("SELECT 100.0 * avg(partial::int) AS pct FROM searches WHERE $__timeFilter(requested_at)"),
     {"h": 5, "w": 4, "x": 8, "y": y}, unit="percent", decimals=1,
     thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 5}, {"color": "red", "value": 20}])
table("Top rotas",
      "Rotas mais buscadas e com que antecedência.",
      sql("""SELECT origin || ' → ' || destination AS "rota",
       count(*) AS "buscas",
       round(avg(travel_date - (requested_at AT TIME ZONE 'America/Sao_Paulo')::date)) AS "antecedência média (dias)",
       round(100.0 * avg(cache_hit::int), 1) AS "% do cache"
FROM searches WHERE $__timeFilter(requested_at)
GROUP BY 1 ORDER BY 2 DESC LIMIT 10"""),
      {"h": 10, "w": 12, "x": 12, "y": y})
y += 5
timeseries("Buscas por hora",
           "Volume de buscas e quanto dele veio do cache.",
           [sql("""SELECT $__timeGroupAlias(requested_at, '1h'),
       count(*) FILTER (WHERE NOT cache_hit) AS "calculadas",
       count(*) FILTER (WHERE cache_hit) AS "do cache"
FROM searches WHERE $__timeFilter(requested_at)
GROUP BY 1 ORDER BY 1""", fmt="time_series")],
           {"h": 5, "w": 12, "x": 0, "y": y}, stack=True)

dashboard = {
    "uid": "aggregator-insights",
    "title": "Agregador de Voos · Insights",
    "description": "Negócio (estratégia de seleção), operação (providers, resiliência, cache) e demanda.",
    "tags": ["passhub", "agregador"],
    "timezone": "browser",
    "schemaVersion": 39,
    "version": 1,
    "editable": False,
    "graphTooltip": 1,
    "refresh": "10s",
    "time": {"from": "now-6h", "to": "now"},
    "templating": {"list": []},
    "annotations": {"list": []},
    "links": [{"title": "Jaeger (traces)", "url": "http://localhost:16686", "type": "link", "targetBlank": True}],
    "panels": panels,
}
with open(sys.argv[1], "w", encoding="utf-8", newline="\n") as f:
    json.dump(dashboard, f, ensure_ascii=False, indent=2)
    f.write("\n")
print(f"{len(panels)} panels, {sum(1 for p in panels if p['type']=='row')} rows")
