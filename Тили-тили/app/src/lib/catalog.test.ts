/*
 * Обещание онбординга не должно расходиться с каталогом.
 *
 * Первый экран обещает «35 категорий», но берёт это число из текста, а не из
 * данных: экран поиска считает `categories.length` сам, онбординг — нет.
 * Расхождение уже случалось (журнал за 2026-09-02, каталог доводили до 35
 * задним числом), и заметить его глазами нельзя: цифра лежит в строке перевода,
 * а категории — в другом файле.
 *
 * Проверка идёт по шаблону «<число> категорий», а не по литералу 35: текст
 * можно переписать, число обязано остаться равным длине каталога.
 */
import { describe, it, expect } from 'vitest'
import { projectFile } from '@/test/projectFiles'

/*
 * Источник правды — справочник бэкенда, а не мок фронта.
 *
 * Категории приходят с сервера (`GET /catalog/categories`), а в репозитории
 * лежат в `backend/migrations/data/categories.json` — оттуда их и берёт база.
 * Мок `lib/data.ts` снесён на этапе 11; сверять обещание онбординга с ним было
 * бы сверкой двух своих выдумок.
 */
const categories = JSON.parse(projectFile('../backend/migrations/data/categories.json')) as { id: string }[]

/* Русское «N категорий» и английское «N categories» — обе формы обещания. */
const RU_PROMISE = /(\d+)\s+категори[йя]/
const EN_PROMISE = /(\d+)\s+categories/

describe('каталог и обещание онбординга', () => {
  it('категории объявлены по одному разу', () => {
    const ids = categories.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('онбординг обещает ровно столько категорий, сколько есть в каталоге', () => {
    const src = projectFile('src/pages/Onboarding.tsx')
    const m = src.match(RU_PROMISE)
    expect(m, 'в Onboarding.tsx пропало обещание вида «N категорий» — проверка стала холостой').not.toBeNull()
    expect(Number(m![1])).toBe(categories.length)
  })

  it('английский перевод обещания несёт то же число', () => {
    const dict = projectFile('src/lib/i18n.en.ts')
    const ru = projectFile('src/pages/Onboarding.tsx').match(RU_PROMISE)![0]
    /* Ключ словаря — русская строка целиком; ищем ту, где стоит наше обещание. */
    const line = dict.split('\n').find(l => l.includes(ru))
    expect(line, `в словаре нет строки с «${ru}»`).toBeDefined()
    const en = line!.match(EN_PROMISE)
    expect(en, `в английском переводе «${ru}» пропало число`).not.toBeNull()
    expect(Number(en![1])).toBe(categories.length)
  })
})
