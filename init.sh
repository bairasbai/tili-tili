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

# Та же команда, что в CI (`.github/workflows/ci.yml`): раньше гейт линтовал
# список файлов, а CI — всё дерево, и CI был красным по построению на
# вендоренном shadcn (SB-04, ревью 016). Граница теперь живёт в
# `eslint.config.js`, а не в аргументах двух разных команд.
echo "== фронт: линт (всё дерево, как в CI)"
node node_modules/eslint/bin/eslint.js .

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
#
# Тесты с живой базой идут только при заданных подключениях. Чтобы включить их
# локально: docker compose up -d db redis && pnpm run migrate up, затем
#   TEST_DATABASE_URL=postgres://tili:tili@localhost:5432/tili \
#   TEST_REDIS_URL=redis://localhost:6379 bash init.sh
# В CI службы подняты, там они не пропускаются.
echo "== бэк: тесты"
if [ -z "${TEST_DATABASE_URL:-}" ]; then
  echo "   (набор с живой базой пропускается: TEST_DATABASE_URL не задан)"
fi
node node_modules/vitest/vitest.mjs run

echo "== бэк: линт"
node node_modules/eslint/bin/eslint.js .

echo "== бэк: сборка"
node node_modules/typescript/bin/tsc -p tsconfig.json

echo
echo "OK — фронт и бэк: типы, тесты, линт и сборка прошли."
