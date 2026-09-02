#!/usr/bin/env bash
# Единая точка верификации проекта. Падает на первой же ошибке.
# Запуск из корня: bash init.sh
set -euo pipefail

cd "$(dirname "$0")/Тили-тили/app"

if [ ! -d node_modules/vitest ]; then
  echo "== установка зависимостей (pnpm: npm в этом окружении крашится, ERR-0006)"
  pnpm install --node-linker=hoisted
fi

echo "== типы"
node node_modules/typescript/bin/tsc -b

echo "== тесты"
node node_modules/vitest/vitest.mjs run

echo "== линт (свой код; components/ui — вендоренный shadcn)"
node node_modules/eslint/bin/eslint.js src/lib src/pages src/App.tsx src/main.tsx \
  src/components/chrome.tsx src/components/ErrorBoundary.tsx src/components/CityPicker.tsx

echo "== сборка"
node node_modules/vite/bin/vite.js build

echo
echo "OK — типы, тесты, линт и сборка прошли."
