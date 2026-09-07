import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * В исходниках не бывает управляющих байтов.
 *
 * Аудит 2026-09-07 (блок 6) нашёл в `src/app.ts` два настоящих байта NUL
 * внутри комментария: инструмент правки записал упоминание символа самим
 * символом. `grep` считал файл бинарным и молча пропускал его, редактор мог
 * обрезать файл на первом нуле. Проверка — на весь `src` и `test`.
 */
function files(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...files(p))
    else if (/\.(ts|mjs|json|sql|md)$/.test(e.name)) out.push(p)
  }
  return out
}

describe('исходники без управляющих байтов', () => {
  it('ни в src, ни в test, ни в migrations нет NUL и прочих управляющих символов, кроме табуляции и перевода строки', () => {
    const offenders: string[] = []
    for (const dir of ['src', 'test', 'migrations']) {
      for (const f of files(dir)) {
        const buf = readFileSync(f)
        for (let i = 0; i < buf.length; i++) {
          const b = buf[i]!
          if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
            offenders.push(`${f} @${i} (0x${b.toString(16)})`)
            break
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
