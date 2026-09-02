import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
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

  it('типы из контракта не отстают: каждая схема есть в api.generated.ts', () => {
    // openapi-typescript вызывать в тесте дорого, поэтому сверяем состав.
    // Ловит главный случай: контракт вырос, `pnpm run gen:types` не гоняли,
    // и обработчик этапа N ссылается на тип, которого в файле нет.
    const doc = fs.readFileSync(CONTRACT_FILE, 'utf8')
    const types = fs.readFileSync(path.resolve(OUT_FILE, '..', 'api.generated.ts'), 'utf8')

    const schemaNames = [...doc.matchAll(/^ {4}([A-Z][A-Za-z0-9]*):$/gm)].map((m) => m[1]!)
    expect(schemaNames.length).toBeGreaterThan(30)
    const missingSchemas = schemaNames.filter((n) => !types.includes(`${n}:`))
    expect(missingSchemas).toEqual([])

    const missingPaths = readOperations()
      .map((o) => o.openapi)
      .filter((p, i, a) => a.indexOf(p) === i)
      .filter((p) => !types.includes(`"${p}"`))
    expect(missingPaths).toEqual([])
  })

  it('файл на диске совпадает с тем, что выдаёт генератор', () => {
    const doc = fs.readFileSync(CONTRACT_FILE, 'utf8')
    const version = /^\s{2}version:\s*(\S+)/m.exec(doc)?.[1] ?? 'unknown'
    const expected = render(readOperations(), version)
    const actual = fs.readFileSync(OUT_FILE, 'utf8').split('\r\n').join('\n')
    expect(actual).toBe(expected)
  })
})
