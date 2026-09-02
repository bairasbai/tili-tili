/*
 * Контраст текста (правило R-13, норма WCAG AA — 4.5:1).
 *
 * Проверяется два слоя: токены обеих тем и цвета, вписанные прямо в классы.
 * Второй слой важнее: именно там цвет легче всего подобрать «на глаз»
 * и не заметить, что подпись перестала читаться.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { projectFile } from '@/test/projectFiles'

const css = projectFile('src/index.css')

const AA = 4.5

/** Все экраны и общие компоненты; вендоренный shadcn и тесты не в счёт. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'ui') out.push(...sourceFiles(p)) }
    else if (e.name.endsWith('.tsx') && !e.name.includes('.test.')) out.push(p)
  }
  return out
}

const hex = (h: string) => { const v = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(v.slice(i, i + 2), 16)) }
const lum = (c: number[]) => {
  const s = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) })
  return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2]
}
const ratio = (a: string, b: string) => {
  const [l1, l2] = [lum(hex(a)), lum(hex(b))]
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

/** Значения токенов из блока объявлений темы. */
function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of block.matchAll(/(--[\w-]+):\s*(#[0-9A-Fa-f]{6})/g)) out[m[1]] = m[2]
  return out
}

const lightBlock = css.slice(css.indexOf(':root {'), css.indexOf('[data-theme="dark"]'))
const darkBlock = css.slice(css.indexOf('[data-theme="dark"] {'))
const light = tokens(lightBlock)
const dark = { ...light, ...tokens(darkBlock.slice(0, darkBlock.indexOf('}'))) }

/* Токены, которыми набирается текст. Заливки (--rose, --sage, --honey, --track)
   сюда не входят: к ним применяются другие правила. */
const TEXT_TOKENS = ['--ink', '--ink2', '--soft', '--soft2', '--rose-deep', '--sage-deep', '--honey-deep']

describe('контраст токенов текста', () => {
  for (const [themeName, theme] of [['светлая', light], ['тёмная', dark]] as const) {
    for (const token of TEXT_TOKENS) {
      it(`${themeName}: ${token} читается на фоне и на карточке`, () => {
        const color = theme[token]
        expect(color, `токен ${token} не найден`).toBeTruthy()
        expect(ratio(color, theme['--bg']), `${token} на --bg`).toBeGreaterThanOrEqual(AA)
        expect(ratio(color, theme['--card']), `${token} на --card`).toBeGreaterThanOrEqual(AA)
      })
    }
  }
})

/* Цвета, вписанные в классы напрямую и стоящие НЕ на светлом фоне.
   Каждый должен быть объяснён — иначе список превращается в свалку исключений. */
const ON_DARK: Record<string, string> = {
  '#EFE9DF': 'подпись на тёмной плашке bg-[var(--ink)] в фотоальбоме',
  '#E3C892': 'заливка звезды рейтинга — графический элемент, не текст',
}

/* Экраны читаются с диска: у vite-суффикса ?raw поведение зависит от типа файла,
   а тест обязан падать на пустом содержимом, а не тихо проходить. */
const modules: Record<string, string> = Object.fromEntries(
  sourceFiles('src').map(p => [p, projectFile(p)]),
)

describe('контраст цветов, вписанных в классы', () => {
  const found = new Map<string, string[]>()
  for (const [file, source] of Object.entries(modules)) {
    for (const m of source.matchAll(/text-\[(#[0-9A-Fa-f]{6})\]/g)) {
      const color = m[1].toUpperCase()
      found.set(color, [...(found.get(color) ?? []), file])
    }
  }

  it('экраны действительно просканированы', () => {
    expect(Object.keys(modules).length).toBeGreaterThan(15)
    expect(found.size).toBeGreaterThan(0)
  })

  it('каждый цвет текста на светлом фоне проходит норму', () => {
    const bad = [...found.entries()]
      .filter(([c]) => !(c in ON_DARK))
      .map(([c, files]) => ({ c, r: +ratio(c, light['--bg']).toFixed(2), files: [...new Set(files)].length }))
      .filter(x => x.r < AA)
    expect(bad).toEqual([])
  })

  it('в списке исключений нет цветов, которых больше нет в коде', () => {
    const stale = Object.keys(ON_DARK).filter(c => !found.has(c))
    expect(stale).toEqual([])
  })
})
