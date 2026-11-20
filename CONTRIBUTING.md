# Contributing

## Setup

Node 22 and pnpm 10 (`corepack enable` picks the version from `package.json`), and a Postgres.

```bash
pnpm install
docker compose up -d postgres        # or use your own Postgres
export DATABASE_URL=postgres://strand:strand@localhost:5432/strand_test
pnpm test
```

Tests create an isolated schema per test file in `DATABASE_URL` (default
`postgres://localhost/strand_test`) and skip themselves if it isn't reachable.

## Before opening a pull request

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

CI runs the same, then a chaos smoke test and builds the Docker images. Changes to the store, the
worker or the context should also pass `pnpm --filter @strand/chaos chaos`.

## Branching

- `main` holds released code and is tagged `vX.Y.Z`.
- `develop` is where finished work lands.
- Branch from `develop` as `feature/<short-name>` and open a pull request back into `develop`.
- Releases branch from `develop` as `release/X.Y.Z`, are merged into `main`, tagged, and merged
  back into `develop`.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `feat(scope): ...`, `fix: ...`,
`test: ...`, `docs: ...`, `refactor: ...`, `build: ...`, `ci: ...`, `chore: ...`. Imperative mood,
lowercase after the colon, no trailing period.

## Code

- All SQL lives in `packages/sdk/src/store.ts` and the migrations. Parameterised queries only.
- A change to concurrency or failure handling needs a test that reproduces the failure against real
  Postgres, not a mock. For races, check the test fails when the code that prevents the race is
  removed.
- Database changes need a new numbered file in `packages/sdk/src/db/migrations/`.
- Match the surrounding code. Comments explain why, not what.
- UI changes: check light and dark themes and phone width.
