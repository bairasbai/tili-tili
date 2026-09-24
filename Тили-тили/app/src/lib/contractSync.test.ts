/*
 * F-RL6-06 (ревью 016) — сторож свежести контракта на стороне фронта.
 *
 * `src/lib/api/schema.ts` — это побайтовая копия `backend/src/contract/
 * api.generated.ts`: оба рождаются одной командой из `openapi.yaml`
 * (CLAUDE.md §5 п. 9). У бэкенда сторож расхождения есть, у фронта не было:
 * правку контракта, прогнанную только через `gen-contract`, фронтовый набор
 * не замечал, и типы экранов молча отставали от сервера до первого 404 или
 * 422 в живом обходе.
 *
 * Пять строк, но именно они превращают «надо не забыть перегенерировать» в
 * красный тест.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('контракт: schema.ts фронта равен api.generated.ts бэкенда', () => {
  it('файлы совпадают побайтово — иначе не прогнали gen-contract', () => {
    const front = read('./api/schema.ts')
    const back = read('../../../backend/src/contract/api.generated.ts')
    expect(front.length, 'размеры разошлись — контракт перегенерирован не везде').toBe(back.length)
    expect(front).toBe(back)
  })
})
