/*
 * R-257 (ERR-0261) как тест, а не как «быстрая проверка глазами».
 *
 * Правило: `t()` — только в разметке и обработчиках, никогда в инициализаторе
 * константы уровня модуля. Там он исполняется ОДИН раз при импорте, с языком,
 * который стоял в тот момент: строка застывает, а при EN-интерфейсе английский
 * текст оседает в данных (в квизе он уезжал на сервер как ключ ответа).
 *
 * Прежняя проверка была строкой в ERRORS.md: `grep -n "^const .*= .*t('" src/pages`.
 * Она видела только однострочные константы и только в `src/pages` — а нарушения
 * живут ровно в многострочных массивах и в `src/components`, `src/lib`
 * (F-RL5-06/07, F-RL-4-04, F-RL-8-07, ревью 016). Этот тест смотрит везде.
 *
 * Константы-ФУНКЦИИ пропускаются намеренно: `const f = () => t('…')` переводит
 * в момент вызова, это и есть правильное место.
 *
 * ── Про список KNOWN ниже ──────────────────────────────────────────────────
 * Девять констант нарушают правило с давних пор. Просто снять с них `t()`
 * нельзя: ни один их потребитель не переводит строку в месте показа
 * (проверено 2026-09-24), и такая правка молча оставила бы английский
 * интерфейс с русскими словами — а словарный сторож этого НЕ ловит, потому
 * что ключи остались бы размеченными. Каждую константу надо закрывать вместе
 * с её местом показа, файл за файлом, и это отдельный проход.
 *
 * Пока он не сделан, список работает храповиком: старое зафиксировано, новое
 * нарушение — красный тест. Закрывая константу, удалите строку отсюда.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { projectFile } from '@/test/projectFiles'

/** Известный долг: файл → имена констант. Список только сокращается. */
const KNOWN: Record<string, string[]> = {
  'src/components/chrome.tsx': ['tabs', 'vendorTabs'],
  'src/lib/contractTemplates.ts': ['contractTemplates'],
  'src/lib/dressPalettes.ts': ['dressPalettes'],
  'src/lib/inviteThemes.ts': ['inviteThemes'],
  'src/pages/Discover.tsx': ['STORIES'],
  'src/pages/Onboarding.tsx': ['scenes'],
  'src/pages/Smart.tsx': ['planBRisks'],
  'src/pages/Team.tsx': ['ROLES', 'ROLE_NAME'],
  'src/pages/Wedding.tsx': ['CONTRACT_TITLE'],
}

const START = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(.*)$/
const CALL = /(?<![\w$.])(?:t|tr|tt)\(/
/** Инициализатор-функция: `(`, `function`, `async`, дженерик-стрелка. */
const FUNC = /^(?:async\s+)?(?:function\b|\(|<[^>]*>\s*\()/

function sources(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      // `ui` — вендоренный shadcn (CLAUDE.md §9), он словаря не знает вовсе.
      if (e.name !== 'ui' && e.name !== 'test') out.push(...sources(p))
    } else if (/\.(ts|tsx)$/.test(e.name) && !e.name.includes('.test.') && !e.name.includes('i18n.en')) {
      out.push(p)
    }
  }
  return out
}

/** Имена констант уровня модуля, в чьём ТЕЛЕ-ДАННЫХ встретился вызов словаря. */
function offenders(source: string): string[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const found: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = START.exec(lines[i]!)
    if (!m) continue
    const [, name, head] = m as unknown as [string, string, string]
    let depth = 0
    let end = i
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]!) {
        if (ch === '(' || ch === '[' || ch === '{') depth++
        else if (ch === ')' || ch === ']' || ch === '}') depth--
      }
      end = j
      if (depth <= 0) break
    }
    if (!FUNC.test(head) && !head.includes('=>')) {
      for (let j = i; j <= end; j++) if (CALL.test(lines[j]!)) { found.push(name); break }
    }
    i = end
  }
  return [...new Set(found)]
}

describe('R-257: словарь не вызывается при загрузке модуля', () => {
  it('новых нарушений нет, а известные — ровно те, что записаны', () => {
    const actual: Record<string, string[]> = {}
    for (const f of sources('src')) {
      const rel = f.replace(/\\/g, '/')
      const bad = offenders(projectFile(rel))
      if (bad.length) actual[rel] = bad.sort()
    }

    const expected: Record<string, string[]> = {}
    for (const [f, names] of Object.entries(KNOWN)) expected[f] = [...names].sort()

    /* Сравниваем в обе стороны: новое нарушение — красный, но и закрытая
       константа, забытая в списке, — тоже красный. Список обязан говорить
       правду, иначе через месяц он станет украшением. */
    expect(actual).toEqual(expected)
  })

  it('список известного долга не растёт: девять констант, больше не заводим', () => {
    expect(Object.keys(KNOWN)).toHaveLength(9)
  })
})
