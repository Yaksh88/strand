.PHONY: install db test lint fmt build chaos bench dev up down

install:
	pnpm install

# A local Postgres for development and tests (skip if you already have one).
db:
	docker compose up -d postgres

test:
	pnpm test

lint:
	pnpm format:check && pnpm lint && pnpm typecheck

fmt:
	pnpm format

build:
	pnpm build

chaos:
	pnpm --filter @strand/chaos chaos

bench:
	pnpm --filter @strand/benchmarks bench

# API server with auto-reload; run the dashboard dev server separately with
#   pnpm --filter @strand/dashboard dev
dev:
	DATABASE_URL=postgres://localhost/strand pnpm --filter @strand/server dev

up:
	docker compose --profile demo up --build

down:
	docker compose --profile demo down
