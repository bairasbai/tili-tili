/*
 * Склейки в подписях: «80гостей», «из1 200 000 ₽», «Тиль:главное фото».
 *
 * Родились при переводе интерфейса на t(): пробел остался снаружи ключа и
 * потерялся. DOM при этом валиден, обработчики целы — ни один экранный тест
 * такого не видит, только чтение глазами. Поэтому проверяем разметку.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { projectFile } from '@/test/projectFiles'

function screens(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'ui') out.push(...screens(p)) }
    else if (e.name.endsWith('.tsx') && !e.name.includes('.test.')) out.push(p)
  }
  return out
}

const WORD_START = /^[a-zA-Zа-яА-ЯёЁ0-9]/
const WORD_END = /[a-zA-Zа-яА-ЯёЁ]$/
/* Осознанные исключения:
   «480К» — тысячи в бюджете, слитно по смыслу;
   «один/одна» — следом идёт шаблон, у которого пробел уже внутри (« · стол №»). */
const ALLOWED = new Set(['К', 'один/одна'])

/** Строчные теги — это текст (b, i, em, strong, span). Компоненты с большой
 *  буквы — иконки: рядом с ними пробел не нужен. */
const TEXT_TAG = /^(b|i|em|strong|span|u)$/

describe('подписи не склеиваются', () => {
  const files = screens('src')

  it('экраны просканированы', () => {
    expect(files.length).toBeGreaterThan(15)
  })

  it('значение и слово разделены пробелом', () => {
    const bad: string[] = []
    for (const f of files) {
      const src = projectFile(f)
      for (const m of src.matchAll(/\}\{t\('([^']+)'\)/g))
        if (WORD_START.test(m[1]) && !ALLOWED.has(m[1])) bad.push(`${f}: {…}{t('${m[1].slice(0, 30)}…')`)
      for (const m of src.matchAll(/t\('([^']+)'\)\}\{/g))
        if (WORD_END.test(m[1]) && !/[:.,—·(]$/.test(m[1]) && !ALLOWED.has(m[1])) bad.push(`${f}: t('…${m[1].slice(-30)}')}{…}`)
    }
    expect(bad).toEqual([])
  })

  it('текст вокруг вложенных тегов разделён пробелом', () => {
    const bad: string[] = []
    for (const f of files) {
      const src = projectFile(f)
      for (const m of src.matchAll(/<\/([a-z]+)>\{t\('([^']+)'\)/g))
        if (TEXT_TAG.test(m[1]) && WORD_START.test(m[2])) bad.push(`${f}: </${m[1]}>{t('${m[2].slice(0, 30)}…')`)
      for (const m of src.matchAll(/t\('([^']+)'\)\}<([a-z]+)[ >]/g))
        if (TEXT_TAG.test(m[2]) && WORD_END.test(m[1]) && !ALLOWED.has(m[1])) bad.push(`${f}: t('…${m[1].slice(-30)}')}<${m[2]}>`)
    }
    expect(bad).toEqual([])
  })
})
