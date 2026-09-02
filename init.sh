#!/usr/bin/env bash
# Единая точка верификации проекта. Падает на первой же ошибке.
# Запуск из корня: bash init.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

# ─────────────────────────────── фронтенд ────────────────────────────────
cd "$ROOT/Тили-тили/app"

if [ ! -d node_modules/vitest ]; then
  echo "== фронт: установка зависимостей (pnpm: npm в этом окружении крашится, ERR-0006)"
  pnpm install --node-linker=hoisted
fi

echo "== фронт: типы"
node node_modules/typescript/bin/tsc -b

echo "== фронт: тесты"
node node_modules/vitest/vitest.mjs run

echo "== фронт: линт (свой код; components/ui — вендоренный shadcn)"
node node_modules/eslint/bin/eslint.js src/lib src/pages src/App.tsx src/main.tsx \
  src/components/chrome.tsx src/components/ErrorBoundary.tsx src/components/CityPicker.tsx

echo "== фронт: сборка"
node node_modules/vite/bin/vite.js build

# ──────────────────────────────── бэкенд ─────────────────────────────────
cd "$ROOT/Тили-тили/backend"

if [ ! -d node_modules/vitest ]; then
  echo "== бэк: установка зависимостей"
  pnpm install --node-linker=hoisted
fi

echo "== бэк: типы"
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit

# Контрактный тест внутри: каждый путь openapi.yaml узнан сервером,
# ни одного 404. Падает, если контракт правили, а gen:contract не гоняли.
echo "== бэк: тесты"
node node_modules/vitest/vitest.mjs run

echo "== бэк: линт"
node node_modules/eslint/bin/eslint.js .

echo "== бэк: сборка"
node node_modules/typescript/bin/tsc -p tsconfig.json

echo
echo "OK — фронт и бэк: типы, тесты, линт и сборка прошли."
