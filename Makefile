.PHONY: up down restart logs ps test cov lint fmt search health chaos calm simulate load obs obs-down

up:            ## sobe tudo (providers + redis + agregador)
	docker compose up -d --build

down:          ## derruba tudo e limpa volumes
	docker compose down -v

restart:
	docker compose restart aggregator

logs:
	docker compose logs -f aggregator

ps:
	docker compose ps

# Agregador em Node/TypeScript (docs/adr/0001): mesmos alvos, implementação npm.
test:          ## testes unitários + integração
	cd aggregator && npm test

cov:           ## testes com relatório de cobertura (meta 85% em domain/application)
	cd aggregator && npm run coverage

lint:          ## eslint + prettier --check + tsc --noEmit
	cd aggregator && npm run lint && npm run typecheck

fmt:
	cd aggregator && npm run format

PYTHON ?= python3
ORIGIN ?= GRU
DEST   ?= GIG
# Data dinâmica (hoje + 30 dias): uma data fixa vira "data passada" e é rejeitada.
# Sobrescreva com `make search SEARCH_DATE=2026-12-12`.
SEARCH_DATE ?= $(shell $(PYTHON) -c "import datetime as d; print(d.date.today() + d.timedelta(days=30))")

search:        ## busca de exemplo
	@curl -s -X POST localhost:8000/search \
		-H 'Content-Type: application/json' \
		-d '{"origin":"$(ORIGIN)","destination":"$(DEST)","date":"$(SEARCH_DATE)"}' | $(PYTHON) -m json.tool

health:
	@curl -s localhost:8000/health | $(PYTHON) -m json.tool

chaos:         ## provider-c derrubando ~21% e pendurando ~30% das chamadas
	docker compose -f docker-compose.yml -f docker-compose.chaos.yml up -d --no-deps provider-c

calm:          ## desliga o chaos (recria o provider-c com a config original)
	docker compose up -d --no-deps provider-c

obs:           ## sobe tudo + Jaeger (16686) e Prometheus (9090)
	docker compose --profile observability up -d --build

obs-down:
	docker compose --profile observability down

simulate:      ## compara as estratégias de seleção sobre buscas reais dos mocks
	cd aggregator && npm run simulate

load:          ## 200 buscas únicas contra o agregador (use com `make chaos`)
	cd aggregator && npm run load -- --n 200 --concurrency 10
