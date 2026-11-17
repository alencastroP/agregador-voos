.PHONY: up down stop restart logs ps test cov lint fmt search health chaos calm simulate load e2e

up:            ## sobe a stack inteira (providers, agregador, redis, postgres, jaeger, prometheus, grafana)
	docker compose up -d --build --wait

stop:          ## para a stack mantendo os dados do Postgres
	docker compose down

down:          ## derruba tudo e apaga os volumes (dados do dashboard)
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

e2e:           ## testes ponta a ponta contra a stack rodando (rode `make up` antes)
	cd aggregator && npm run test:e2e

cov:           ## testes com relatório de cobertura (meta 85% em domain/application)
	cd aggregator && npm run coverage

lint:          ## eslint + prettier --check + tsc --noEmit
	cd aggregator && npm run lint && npm run typecheck

fmt:
	cd aggregator && npm run format

ORIGIN ?= GRU
DEST   ?= GIG
# Data dinâmica (hoje + 30 dias): uma data fixa vira "data passada" e é rejeitada.
# GNU date (Linux, Git Bash) ou BSD date (macOS). Sobrescreva com `make search SEARCH_DATE=2026-12-12`.
SEARCH_DATE ?= $(shell date -d '+30 days' +%F 2>/dev/null || date -v+30d +%F)
# Formata o JSON com o que houver na máquina (jq ou node); sem nenhum dos dois, imprime cru.
PRETTY = { if command -v jq >/dev/null 2>&1; then jq .; elif command -v node >/dev/null 2>&1; then node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s),null,2)))'; else cat; fi; }

search:        ## busca de exemplo
	@curl -s -X POST localhost:8000/search \
		-H 'Content-Type: application/json' \
		-d '{"origin":"$(ORIGIN)","destination":"$(DEST)","date":"$(SEARCH_DATE)"}' | $(PRETTY)

health:        ## estado de cada componente
	@curl -s localhost:8000/health | $(PRETTY)

chaos:         ## provider-c derrubando ~21% e pendurando ~30% das chamadas
	docker compose -f docker-compose.yml -f docker-compose.chaos.yml up -d --no-deps provider-c

calm:          ## desliga o chaos (recria o provider-c com a config original)
	docker compose up -d --no-deps provider-c

simulate:      ## compara as estratégias de seleção sobre buscas reais dos mocks
	cd aggregator && npm run simulate

load:          ## 200 buscas únicas contra o agregador (use com `make chaos`)
	cd aggregator && npm run load -- --n 200 --concurrency 10
