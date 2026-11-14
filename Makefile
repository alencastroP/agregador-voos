.PHONY: up down restart logs ps test cov lint fmt search health chaos

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

test:
	cd aggregator && uv run pytest

cov:
	cd aggregator && uv run pytest --cov=app --cov-report=term-missing

lint:
	cd aggregator && uv run ruff check . && uv run ruff format --check .

fmt:
	cd aggregator && uv run ruff format . && uv run ruff check . --fix

search:        ## busca de exemplo
	@curl -s -X POST localhost:8000/search \
		-H 'Content-Type: application/json' \
		-d '{"origin":"GRU","destination":"GIG","date":"2026-10-12"}' | python3 -m json.tool

health:
	@curl -s localhost:8000/health | python3 -m json.tool

chaos:         ## provider-c derrubando 30% e pendurando 30% das chamadas
	docker compose run -d --rm --service-ports \
		-e FAIL_RATE=0.3 -e TIMEOUT_RATE=0.3 provider-c
