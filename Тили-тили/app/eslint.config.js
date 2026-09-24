import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  /* `.claude/` — служебная папка инструментов, и в ней живут git-worktree:
     целые копии репозитория со своим кодом на старом коммите. Git их
     игнорирует (`app/.gitignore`), а eslint про `.gitignore` не знает и линтит
     чужой старый код как свой — в CI этого не видно (чистый чекаут),
     а локально `eslint .` даёт чужие ошибки (ревью 016). */
  globalIgnores(['dist', '.claude']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    /* Вендоренный shadcn/ui (CLAUDE.md §9): файлы поставки нарочно
       экспортируют рядом с компонентами ещё и варианты стилей
       (`buttonVariants`, `badgeVariants` и т. п.) — это их контракт, а не наш
       код. `react-refresh/only-export-components` говорит об эргономике горячей
       перезагрузки при правке файла; эти файлы мы не правим, и семь
       его ошибок держали `eslint .` в CI красным по построению (SB-04,
       ревью 016). Глушится ТОЛЬКО оно и только здесь: всё остальное —
       чистота рендера, правила хуков, TypeScript — для этой папки остаётся
       в силе (нарушение `react-hooks/purity` в `sidebar.tsx` чинилось, а не глушилось). */
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
