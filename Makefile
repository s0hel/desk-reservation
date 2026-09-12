.PHONY: up down db-reset migrate seed api test lint gen-client

up:            ## start postgres, redis, mailpit
	docker compose up -d --wait

down:
	docker compose down

db-reset:      ## destroy and recreate the database volume
	docker compose down -v && docker compose up -d --wait && $(MAKE) migrate seed

migrate:
	cd services/api && uv run alembic upgrade head

seed:          ## one org, two floors, 120 desks, 6 rooms (TDD §21)
	cd services/api && uv run python -m app.seed

api:
	cd services/api && uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

test:
	cd services/api && uv run pytest -q

lint:
	cd services/api && uv run ruff check . && uv run ruff format --check .

gen-client:
	bash scripts/gen-client.sh
