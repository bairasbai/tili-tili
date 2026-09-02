import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { readOperations, render, CONTRACT_FILE, OUT_FILE } from '../scripts/gen-contract.mjs'
import { CONTRACT_OPERATIONS } from '../src/contract/paths.generated.js'

/**
 * Сторож против расхождения: контракт поправили, `pnpm run gen:contract`
 * забыли — и сервер продолжает отдавать 404 на новый путь, а не 501.
 * Тест падает раньше, чем это заметит фронт.
 */
describe('генерация списка путей', () => {
  it('контракт на месте', () => {
    expect(fs.existsSync(CONTRACT_FILE)).toBe(true)
  })

  it('сгенерированный файл совпадает с контрактом', () => {
    const fromContract = readOperations()
    const committed = CONTRACT_OPERATIONS.map((o) => ({ ...o }))
    expect(committed).toEqual(fromContract)
  })

  it('файл на диске совпадает с тем, что выдаёт генератор', () => {
    const doc = fs.readFileSync(CONTRACT_FILE, 'utf8')
    const version = /^\s{2}version:\s*(\S+)/m.exec(doc)?.[1] ?? 'unknown'
    const expected = render(readOperations(), version)
    const actual = fs.readFileSync(OUT_FILE, 'utf8').split('\r\n').join('\n')
    expect(actual).toBe(expected)
  })
})
