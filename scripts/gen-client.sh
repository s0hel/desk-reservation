#!/usr/bin/env bash
# Generate the TypeScript client from the API's OpenAPI schema (TDD §3, §17).
# Runs offline: the schema is dumped from the FastAPI app, no server required.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/packages/api-client/src"
mkdir -p "$OUT"

echo "› dumping OpenAPI schema"
(cd "$ROOT/services/api" && uv run python -c "
import json
from app.main import app
print(json.dumps(app.openapi(), indent=2))
") > "$OUT/openapi.json"

echo "› generating TypeScript types"
(cd "$ROOT" && npx openapi-typescript "$OUT/openapi.json" -o "$OUT/schema.ts")

echo "✓ packages/api-client/src/schema.ts"
