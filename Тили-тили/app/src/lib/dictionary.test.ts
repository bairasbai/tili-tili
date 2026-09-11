/*
 * Инварианты словаря (правило R-07).
 *
 * Два класса ошибок, которые невозможно заметить глазами в файле на тысячу строк:
 * повтор ключа (выигрывает последний, более ранний перевод молча исчезает)
 * и строка, добавленная в интерфейс, но забытая в словаре — англоязычный
 * пользователь видит русский текст.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { projectFile } from '@/test/projectFiles'

/* Пары стоят по нескольку в строке, значения содержат кавычки-ёлочки
   и экранированные апострофы — поэтому разбор глобальный, а не построчный. */
const PAIR = /'((?:[^'\\]|\\.)*)':\s*'((?:[^'\\]|\\.)*)'/g
/*
 * Вызовы словаря под любым из принятых имён (ревью D6-10). `Home.tsx`
 * импортирует `t as tr` — имя `t` там занято переменной задачи, — и 54 вызова
 * `tr('…')` сканер не видел: два ключа отсутствовали, и при EN-интерфейсе на
 * главной стояли русские слова.
 */
const USED = /\b(?:t|tr|tt)\('((?:[^'\\]|\\.)*)'\)/g

const dictFiles = ['src/lib/i18n.en.ts', 'src/lib/i18n.en.data.ts']

function sources(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'ui') out.push(...sources(p)) }
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.includes('.test.') && !e.name.includes('i18n.en')) out.push(p)
  }
  return out
}

describe('английский словарь', () => {
  it('ключи объявлены по одному разу', () => {
    const duplicates: string[] = []
    for (const f of dictFiles) {
      const seen = new Set<string>()
      for (const m of projectFile(f).matchAll(PAIR)) {
        if (seen.has(m[1])) duplicates.push(`${f}: «${m[1].slice(0, 60)}»`)
        seen.add(m[1])
      }
    }
    expect(duplicates).toEqual([])
  })

  it('каждая строка интерфейса переведена', () => {
    const dict = new Set<string>()
    for (const f of dictFiles) for (const m of projectFile(f).matchAll(PAIR)) dict.add(m[1])
    expect(dict.size).toBeGreaterThan(1000)

    const used = new Set<string>()
    for (const f of sources('src')) for (const m of projectFile(f).matchAll(USED)) used.add(m[1])
    expect(used.size).toBeGreaterThan(500)

    const missing = [...used].filter(k => !dict.has(k))
    expect(missing).toEqual([])
  })
})
