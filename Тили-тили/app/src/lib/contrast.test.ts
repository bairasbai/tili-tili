/*
 * Контраст текста (правило R-13, норма WCAG AA — 4.5:1).
 *
 * Три слоя проверки:
 *   1. токены текста на фоне и на карточке — обе темы;
 *   2. токены текста на цветной заливке — *-deep рассчитаны на --bg и на
 *      собственной пастельной заливке проваливаются, для неё есть *-ink;
 *   3. сплошной скан классов: каждая пара «заливка + цвет текста» в одной
 *      строке классов считается в обеих темах.
 *
 * Третий слой важнее двух первых: там цвет подбирают «на глаз» и не замечают,
 * что подпись перестала читаться. Хардкод цвета текста запрещён отдельно —
 * он не переключается вместе с темой (R-23).
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
/** Заливка с прозрачностью лежит на фоне экрана, а не в пустоте. */
const over = (fg: string, bg: string, a: number) => {
  const [f, b] = [hex(fg), hex(bg)]
  return '#' + [0, 1, 2].map(i => Math.round(f[i] * a + b[i] * (1 - a)).toString(16).padStart(2, '0')).join('').toUpperCase()
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
const THEMES = [['светлая', light], ['тёмная', dark]] as const

/* Токены, которыми набирается текст поверх фона и карточек. Заливки
   (--rose, --sage, --honey, --track, --blue, --lav) сюда не входят. */
const TEXT_TOKENS = ['--ink', '--ink2', '--soft', '--soft2', '--rose-deep', '--sage-deep', '--honey-deep']

describe('контраст токенов текста', () => {
  for (const [themeName, theme] of THEMES) {
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

/* ---------- Текст на цветной заливке ----------
   *-deep подобраны под светлый --bg и на своей же пастельной заливке дают
   3.69–4.31. Для букв и иконок поверх заливки заведены отдельные *-ink. */
const ON_FILL: [text: string, fill: string][] = [
  ['--rose-ink', '--rose-soft'],
  ['--sage-ink', '--sage-soft'],
  ['--honey-ink', '--honey'],
  ['--blue-ink', '--blue'],
  ['--lav-ink', '--lav'],
  ['--track-ink', '--track'],
]

describe('контраст текста на цветной заливке', () => {
  for (const [themeName, theme] of THEMES) {
    for (const [text, fill] of ON_FILL) {
      it(`${themeName}: ${text} читается на ${fill}`, () => {
        expect(theme[text], `токен ${text} не найден`).toBeTruthy()
        expect(theme[fill], `токен ${fill} не найден`).toBeTruthy()
        expect(ratio(theme[text], theme[fill]), `${text} на ${fill}`).toBeGreaterThanOrEqual(AA)
      })
    }
  }
})

/* Экраны читаются с диска: у vite-суффикса ?raw поведение зависит от типа файла,
   а тест обязан падать на пустом содержимом, а не тихо проходить. */
const modules: Record<string, string> = Object.fromEntries(
  sourceFiles('src').map(p => [p, projectFile(p)]),
)

/* Пары «заливка + цвет текста», написанные в одной строке классов. Исключения
   объясняются здесь и нигде больше: список без объяснений превращается в свалку. */
const PAIR_SKIP: Record<string, string> = {}

type Pair = { file: string; line: number; text: string; fill: string; alpha?: number }

/** Все пары из строк классов: `bg-[…]` и `text-[…]` внутри одного литерала. */
function classPairs(): Pair[] {
  const out: Pair[] = []
  const COLOR = String.raw`(?:#[0-9A-Fa-f]{6}|var\(--[\w-]+\))`
  for (const [file, source] of Object.entries(modules)) {
    source.split('\n').forEach((line, i) => {
      for (const lit of line.matchAll(/'[^'\n]*'|"[^"\n]*"/g)) {
        const s = lit[0]
        const fills = [...s.matchAll(new RegExp(String.raw`\bbg-\[(${COLOR})\](?:\/(\d{1,3}))?`, 'g'))]
        const texts = [...s.matchAll(new RegExp(String.raw`\btext-\[(${COLOR})\]`, 'g'))]
        if (fills.length !== 1 || !texts.length) continue
        for (const t of texts) out.push({ file, line: i + 1, text: t[1], fill: fills[0][1], alpha: fills[0][2] ? Number(fills[0][2]) / 100 : undefined })
      }
    })
  }
  return out
}

describe('контраст пар «заливка + текст» в классах', () => {
  const pairs = classPairs()

  it('экраны просканированы и пары найдены', () => {
    expect(Object.keys(modules).length).toBeGreaterThan(15)
    expect(pairs.length).toBeGreaterThan(20)
  })

  for (const [themeName, theme] of THEMES) {
    it(`${themeName}: каждая пара проходит норму`, () => {
      const resolve = (raw: string) => {
        const m = /^var\((--[\w-]+)\)$/.exec(raw)
        return m ? theme[m[1]] : raw
      }
      const bad = pairs
        .filter(p => !(`${p.text} on ${p.fill}` in PAIR_SKIP))
        .map(p => {
          const fg = resolve(p.text)
          let bg = resolve(p.fill)
          if (!fg || !bg) return null
          if (p.alpha !== undefined) bg = over(bg, theme['--bg'], p.alpha)
          return { at: `${p.file}:${p.line}`, pair: `${p.text} на ${p.fill}`, r: +ratio(fg, bg).toFixed(2) }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null && x.r < AA)
      expect(bad).toEqual([])
    })
  }

  it('в списке исключений нет пар, которых больше нет в коде', () => {
    const live = new Set(pairs.map(p => `${p.text} on ${p.fill}`))
    expect(Object.keys(PAIR_SKIP).filter(k => !live.has(k))).toEqual([])
  })
})

/* Хардкод цвета текста не переключается вместе с темой: в светлой он может
   проходить норму, а в тёмной оказаться на инвертированной заливке (R-23). */
describe('цвет текста задаётся токеном', () => {
  it('в классах нет text-[#rrggbb]', () => {
    const hits: string[] = []
    for (const [file, source] of Object.entries(modules)) {
      source.split('\n').forEach((line, i) => {
        if (/text-\[#[0-9A-Fa-f]{6}\]/.test(line)) hits.push(`${file}:${i + 1}`)
      })
    }
    expect(hits).toEqual([])
  })
})

/* Регрессия: *-deep снова оказался на своей же заливке. Проверяется отдельно от
   общего скана — так падение называет виновника, а не просто цифру. */
describe('*-deep не стоит на своей заливке', () => {
  const WRONG: [fill: string, wrong: string, right: string][] = [
    ['--rose-soft', '--rose-deep', '--rose-ink'],
    ['--sage-soft', '--sage-deep', '--sage-ink'],
    ['--honey', '--honey-deep', '--honey-ink'],
  ]
  for (const [fill, wrong, right] of WRONG) {
    it(`вместо ${wrong} на ${fill} стоит ${right}`, () => {
      const hits: string[] = []
      for (const [file, source] of Object.entries(modules)) {
        source.split('\n').forEach((line, i) => {
          for (const lit of line.matchAll(/'[^'\n]*'|"[^"\n]*"/g)) {
            if (lit[0].includes(`bg-[var(${fill})]`) && lit[0].includes(`text-[var(${wrong})]`)) hits.push(`${file}:${i + 1}`)
          }
        })
      }
      expect(hits).toEqual([])
    })
  }
})
