/*
 * Ревью 018, 018-B: резерв и лимиты категорий на экране бюджета.
 *
 * Сеть подменена целиком: проверяется то, что уходит на сервер (путь, тело,
 * версия), а не внутреннее состояние экрана. До ревью лимит разбирался
 * вырезанием всего, кроме цифр («1500,50» → 150 050 ₽), резерв — `Number()`
 * («0x10» → 16 %, пробел → 0 %), а 409 «изменено на другом устройстве»
 * повторялся по кругу со старой версией.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Budget } from '@/pages/Wedding'
import { setI18nLang } from './i18n'
import { parseReservePercent, parseWholeRubles } from './paymentAmount'

vi.mock('@/lib/store', () => ({ useStore: () => ({ weddingId: 'w1' }) }))
const money = (amount: number) => ({ amount, currency: 'RUB' as const })
type Category = { id: string; title: string; planned: ReturnType<typeof money>; limitCustom: boolean; limitVersion: number; fromSlots: number; color: string; live: null; items: [] }
let budget: { total: ReturnType<typeof money>; spent: ReturnType<typeof money>; reserve: ReturnType<typeof money>; reserveBps: number; settingsVersion: number; categories: Category[] }
let writes: { method: string; path: string; body: Record<string, unknown> }[]
let budgetReads = 0
let staleOnce: string | null = null
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
beforeEach(() => {
  setI18nLang('ru'); localStorage.clear(); localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  budget = { total: money(100_000_000), spent: money(5_000_000), reserve: money(10_000_000), reserveBps: 1000, settingsVersion: 0, categories: [
    { id: 'b2', title: 'Фото и видео', planned: money(20_000_000), limitCustom: false, limitVersion: 0, fromSlots: 0, color: '#D9A8A0', live: null, items: [] },
    { id: 'b3', title: 'Декор', planned: money(0), limitCustom: true, limitVersion: 2, fromSlots: 5_000_000, color: '#A8C0D9', live: null, items: [] },
  ] }
  writes = []; budgetReads = 0; staleOnce = null
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api/, '')
    if (!init?.method || init.method === 'GET') {
      if (path === '/weddings/w1/budget') { budgetReads++; return json(budget) }
      if (path === '/weddings/w1/tips') return json({ items: [] })
      return json({ error: { code: 'not_found', message: 'нет' } }, 404)
    }
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    writes.push({ method: init.method, path, body })
    if (staleOnce && path.endsWith(staleOnce)) {
      staleOnce = null
      // Партнёр успел сохранить: следующая версия — уже на сервере.
      budget.categories[0]!.limitVersion = 1
      return json({ error: { code: 'stale_budget_limit', message: 'Лимит категории уже изменён на другом устройстве' } }, 409)
    }
    if (path.endsWith('/budget/settings')) return json({ reserveBps: body.reserveBps, version: 1 })
    if (init.method === 'PATCH') return new Response(null, { status: 204 })
    return json({ categoryId: 'b2', amount: body.amount, custom: true, version: 1 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const open = () => render(<MemoryRouter><Budget /></MemoryRouter>)
const NBSP = new RegExp('[' + String.fromCharCode(160, 8239) + ']', 'g')

describe('018-B: резерв и лимиты на экране бюджета (ревью 018)', () => {
  it('BF-10: резерв «12,5» уходит 1250 б. п. с версией настроек; «0x10» — отказ без запроса', async () => {
    open()
    const input = await screen.findByLabelText('Резерв, %')
    expect(screen.getByText(/Сейчас/).textContent!.replace(NBSP, ' ')).toContain('10 %')
    fireEvent.change(input, { target: { value: '0x10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    await screen.findByText('Резерв — число от 0 до 50, не больше двух знаков после запятой')
    expect(writes).toEqual([])
    fireEvent.change(input, { target: { value: '12,5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(writes).toEqual([{ method: 'PATCH', path: '/weddings/w1/budget/settings', body: { reserveBps: 1250, version: 0 } }]))
  })
  it('BF-09: лимит «150 000» — 15 000 000 копеек; «1500,50» — отказ без запроса', async () => {
    open()
    const input = await screen.findByLabelText('Фото и видео лимит, ₽')
    const save = screen.getByRole('button', { name: 'Задать лимит: Фото и видео' })
    fireEvent.change(input, { target: { value: '1500,50' } }); fireEvent.click(save)
    await screen.findByText('Введите лимит целым числом рублей, например 150 000')
    expect(writes).toEqual([])
    fireEvent.change(input, { target: { value: '150 000' } }); fireEvent.click(save)
    await waitFor(() => expect(writes).toEqual([{ method: 'PUT', path: '/weddings/w1/budget/categories/b2/limit', body: { amount: money(15_000_000), version: 0 } }]))
  })
  it('BF-08: 409 перечитывает бюджет, черновик остаётся, повтор идёт с новой версией', async () => {
    staleOnce = '/categories/b2/limit'
    open()
    const input = await screen.findByLabelText('Фото и видео лимит, ₽')
    fireEvent.change(input, { target: { value: '150000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Задать лимит: Фото и видео' }))
    await screen.findByText('Бюджет изменился на другом устройстве — данные обновлены. Проверьте и сохраните ещё раз.')
    await waitFor(() => expect(budgetReads).toBe(2))
    expect((screen.getByLabelText('Фото и видео лимит, ₽') as HTMLInputElement).value).toBe('150000')
    fireEvent.click(screen.getByRole('button', { name: 'Задать лимит: Фото и видео' }))
    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[1]!.body).toEqual({ amount: money(15_000_000), version: 1 })
  })
  it('BF-11: лимит 0 при расходах — «Сверх лимита», а не пустая полоса; «Авто» — сброс с версией', async () => {
    open()
    const over = await screen.findByText(/Сверх лимита/)
    expect(over.textContent!.replace(NBSP, ' ')).toContain('50 000 ₽')
    fireEvent.click(screen.getByRole('button', { name: 'Вернуть автоматический лимит: Декор' }))
    await waitFor(() => expect(writes).toEqual([{ method: 'PATCH', path: '/weddings/w1/budget/categories/b3/limit', body: { reset: true, version: 2 } }]))
  })
})

describe('разбор денег и процента для бюджета', () => {
  it.each([['150 000', 150000], ['0', 0], [' 12 500 ', 12500], ['1500,50', null], ['-5000', null], ['', null], ['12a', null], ['1'.repeat(14), null]])(
    'parseWholeRubles(%j) = %j', (input, expected) => expect(parseWholeRubles(input)).toBe(expected))
  it.each([['10', 1000], ['12,5', 1250], ['12.55', 1255], ['0', 0], ['50', 5000], ['50,01', null], ['0x10', null], [' ', null], ['', null], ['1e1', null], ['12,555', null]])(
    'parseReservePercent(%j) = %j', (input, expected) => expect(parseReservePercent(input)).toBe(expected))
})
