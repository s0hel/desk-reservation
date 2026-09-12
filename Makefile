.PHONY: up down db-reset migrate seed api worker test test-mobile test-e2e test-all test-db-drop lint gen-client

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

worker:        ## drain the outbox: notifications for bookings and cancellations
	cd services/api && uv run python -m app.workers.outbox

test:          ## api suite; runs against deskflow_test, recreated each run
	cd services/api && uv run pytest -q

test-mobile:   ## mobile unit tests (jest)
	cd apps/mobile && npx jest

test-e2e:      ## drive the app in the iOS simulator (needs make up, make api and Metro)
	bash scripts/e2e.sh

test-all: test test-mobile

test-db-drop:  ## remove the test database; the next `make test` recreates it
	docker compose exec -T postgres psql -U deskflow_owner -d postgres \
		-c 'DROP DATABASE IF EXISTS deskflow_test WITH (FORCE)'

lint:
	cd services/api && uv run ruff check . && uv run ruff format --check .

gen-client:
	bash scripts/gen-client.sh
