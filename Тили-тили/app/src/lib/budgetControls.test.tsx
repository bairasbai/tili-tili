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
import type { FamilyContribution, FamilyContributionWrite } from './api/familyContributions'
import type { components } from './api/schema'

vi.mock('@/lib/store', () => ({ useStore: () => ({ weddingId: 'w1' }) }))
const money = (amount: number) => ({ amount, currency: 'RUB' as const })
type Category = { id: string; title: string; planned: ReturnType<typeof money>; limitCustom: boolean; limitVersion: number; fromSlots: number; unknownPrices?: number; color: string; live: null; items: components['schemas']['BudgetItem'][]; linkedItems?: components['schemas']['BudgetItem'][] }
let budget: { total: ReturnType<typeof money>; spent: ReturnType<typeof money>; reserve: ReturnType<typeof money>; reserveBps: number; settingsVersion: number; categories: Category[]; paymentSummary?: components['schemas']['PaymentSummary']; dealChoices?: components['schemas']['Budget']['dealChoices'] }
let writes: { method: string; path: string; body: Record<string, unknown> }[]
let budgetReads = 0
let staleOnce: string | null = null
let family: Map<string, FamilyContribution[]>
let familyReads: number
let creationKeys: string[]
const familyPath = '/weddings/w1/budget/family-contributions'
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
beforeEach(() => {
  setI18nLang('ru'); localStorage.clear(); localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  budget = { total: money(100_000_000), spent: money(5_000_000), reserve: money(10_000_000), reserveBps: 1000, settingsVersion: 0, categories: [
    { id: 'b2', title: 'Фото и видео', planned: money(20_000_000), limitCustom: false, limitVersion: 0, fromSlots: 0, color: '#D9A8A0', live: null, items: [] },
    { id: 'b3', title: 'Декор', planned: money(0), limitCustom: true, limitVersion: 2, fromSlots: 5_000_000, color: '#A8C0D9', live: null, items: [] },
  ] }
  writes = []; budgetReads = 0; staleOnce = null
  family = new Map(); familyReads = 0; creationKeys = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api/, '')
    if (!init?.method || init.method === 'GET') {
      if (path === '/weddings') return json([{ id: 'w1', role: 'couple' }])
      if (path === '/weddings/w1/budget') { budgetReads++; return json(budget) }
      if (path === '/weddings/w1/tips') return json({ items: [] })
      if (path === familyPath) {
        familyReads++
        const items = [...family.values()].map(history => history[0]!)
        const active = items.filter(item => !item.archived)
        return json({ items,
          received: money(active.reduce((sum, item) => sum + item.received.amount, 0)),
          outstanding: money(active.reduce((sum, item) => sum + Math.max(0, item.promised.amount - item.received.amount), 0)),
        })
      }
      if (path.startsWith(familyPath + '/') && path.endsWith('/history')) {
        return json({ items: family.get(path.slice(familyPath.length + 1, -'/history'.length)) ?? [] })
      }
      return json({ error: { code: 'not_found', message: 'нет' } }, 404)
    }
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    writes.push({ method: init.method, path, body })
    if (init.method === 'PUT' && path.endsWith('/deal-link')) {
      const category = budget.categories[1]!
      const item = (category.items[0] ?? category.linkedItems?.[0])!
      item.linkedDealId = body.dealId as string | null
      item.linkedDealLabel = item.linkedDealId ? 'Фотосъёмка' : null
      item.dealLinkVersion = Number(body.version) + 1
      category.items = item.linkedDealId ? [] : [item]
      category.linkedItems = item.linkedDealId ? [item] : []
      budget.spent = money(5_000_000 + (item.linkedDealId ? 0 : item.amount!.amount))
      return json(item)
    }
    if (init.method === 'POST' && path.endsWith('/budget/items')) {
      const key = new Headers(init.headers).get('idempotency-key')!
      creationKeys.push(key)
      const item = { id: 'new-item', ...body, custom: true, dealLinkVersion: 1 }
      if (creationKeys.length === 1) return json({ error: { code: 'unavailable', message: 'Сохранение не подтверждено' } }, 503)
      return json(item, 201)
    }
    if (init.method === 'PUT' && path.startsWith(familyPath + '/')) {
      const id = path.slice(familyPath.length + 1)
      const data = body as unknown as FamilyContributionWrite
      const row: FamilyContribution = { ...data, id, version: data.version + 1, recordedAt: '2026-11-12T12:00:00Z' }
      family.set(id, [row, ...(family.get(id) ?? [])])
      return json(row)
    }
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
  it('FR016 помечает неизвестные цены и сохраняет известный перерасход', async () => {
    budget.categories[0]!.unknownPrices = 2
    budget.categories[1]!.unknownPrices = 1
    open()
    await screen.findByText('Известные обязательства')
    expect(screen.getByText(/Остаток уточняется/)).not.toBeNull()
    expect(screen.queryByText(/запланировано · осталось/)).toBeNull()
    expect(screen.getByText('Не уточнено')).not.toBeNull()
    expect(screen.getAllByText('Сделок с неуточнённой ценой').map(element => element.textContent)).toEqual([
      'Сделок с неуточнённой ценой 2',
      'Сделок с неуточнённой ценой 1',
    ])
    expect(screen.getByText(/Сверх лимита/).textContent!.replace(NBSP, ' ')).toContain('50 000 ₽')
    expect(writes).toEqual([])
  })
  it('FR010 отдельно показывает оплаты, возвраты и остаток по действующим сделкам', async () => {
    budget.paymentSummary = {
      committed: money(300000), recorded: money(120100), remaining: money(179900),
      unallocated: money(0), inactiveDealRecorded: money(0), unknownPrices: 1,
      unknownAmountPayments: 1, amountIncomplete: true, cashFlow: { paid: '9007199254740993', refunded: '30001' },
    }
    open()
    const paid = await screen.findByText('Отмеченные оплаты по всем сделкам')
    const refund = screen.getByText('Отмеченные возвраты по всем сделкам')
    const balance = screen.getByText('Осталось по действующим сделкам')
    expect(paid.nextElementSibling?.textContent?.replace(NBSP, ' ')).toBe('90 071 992 547 409,93 ₽')
    expect(refund.nextElementSibling?.textContent).toBe('300,01 ₽')
    expect(balance.nextElementSibling?.textContent?.replace(NBSP, ' ')).toBe('1 799 ₽ (без сделок, где цена не задана: 1)')
    expect(screen.getByText(/Есть платежи с неизвестной суммой/)).toBeTruthy()
    expect(writes).toEqual([])
  })
  it('SC002 связывает и возвращает ручную статью к отдельному учёту через сервер', async () => {
    budget.dealChoices = [{ id: 'deal1', label: 'Фотосъёмка' }]
    budget.categories[1]!.items = [{ id: 'old', title: 'Печать', amount: money(500000), custom: true, dealLinkVersion: 0 }]
    budget.spent = money(5_500_000)
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Связать со сделкой · Печать' }))
    fireEvent.change(screen.getByLabelText('Сделка для статьи'), { target: { value: 'deal1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить связь' }))
    const deal = await screen.findByRole('link', { name: 'Фотосъёмка' })
    expect(deal.getAttribute('href')).toBe('/deal/deal1')
    expect(writes[0]).toEqual({ method: 'PUT', path: '/weddings/w1/budget/items/old/deal-link', body: { dealId: 'deal1', version: 0 } })
    expect(screen.getByText(/Сверх лимита/).textContent!.replace(NBSP, ' ')).toContain('50 000 ₽')
    fireEvent.click(screen.getByRole('button', { name: 'Изменить связь со сделкой · Печать' }))
    fireEvent.change(screen.getByLabelText('Сделка для статьи'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить связь' }))
    await screen.findByRole('button', { name: 'Связать со сделкой · Печать' })
    expect(writes[1]?.body).toEqual({ dealId: null, version: 1 })
    expect(screen.getByText(/Сверх лимита/).textContent!.replace(NBSP, ' ')).toContain('55 000 ₽')
  })
  it('SC002 повтор создания связанной статьи сохраняет ключ и тело', async () => {
    budget.dealChoices = [{ id: 'deal1', label: 'Фотосъёмка' }]
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Добавить расход' }))
    const title = screen.getByPlaceholderText(/Статья расхода/)
    fireEvent.change(title, { target: { value: 'Печать' } })
    fireEvent.change(screen.getByPlaceholderText('Сумма, ₽'), { target: { value: '500' } })
    fireEvent.change(screen.getByLabelText(/Если расход уже входит в сделку/), { target: { value: 'deal1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Повторить сохранение' }))
    await screen.findByRole('button', { name: 'Добавить расход' })
    expect(creationKeys).toHaveLength(2)
    expect(creationKeys[0]).toBeTruthy()
    expect(creationKeys[1]).toBe(creationKeys[0])
    expect(writes[0]?.body).toEqual({ title: 'Печать', amount: money(50000), categoryId: 'b2', linkedDealId: 'deal1' })
    expect(writes[1]?.body).toEqual(writes[0]?.body)
  })
  it('FR016 отделяет обещание от частичного получения и открывает предыдущие версии', async () => {
    open()
    const section = await screen.findByText('Вклад семьи')
    expect(familyReads).toBe(0)
    fireEvent.click(section)
    fireEvent.click(await screen.findByRole('button', { name: 'Добавить вклад' }))
    fireEvent.change(screen.getByLabelText('Название записи'), { target: { value: 'Родители' } })
    fireEvent.change(screen.getByLabelText('Обещанная сумма, ₽'), { target: { value: '1000,01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить вклад' }))
    const outstanding = () => screen.getByText('Ещё обещано').parentElement!.textContent!.replace(NBSP, ' ')
    const received = () => screen.getByText('Получено от семьи').parentElement!.textContent!.replace(NBSP, ' ')
    await waitFor(() => expect(outstanding()).toContain('1 000,01 ₽'))
    expect(received()).toContain('0 ₽')
    expect(writes[0]?.body).toMatchObject({ version: 0, promised: money(100001), received: money(0) })
    fireEvent.click(screen.getByRole('button', { name: 'Исправить вклад' }))
    fireEvent.change(screen.getByLabelText('Полученная сумма, ₽'), { target: { value: '300,01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить вклад' }))
    await waitFor(() => expect(received()).toContain('300,01 ₽'))
    expect(outstanding()).toContain('700 ₽')
    expect(writes[1]?.path).toBe(writes[0]?.path)
    expect(writes[1]?.body).toMatchObject({ version: 1, promised: money(100001), received: money(30001) })
    fireEvent.click(await screen.findByText('История вклада'))
    await waitFor(() => expect(screen.getAllByText('Полученная сумма')).toHaveLength(3))
    expect(budget.spent).toEqual(money(5_000_000))
  })
})

describe('разбор денег и процента для бюджета', () => {
  it.each([['150 000', 150000], ['0', 0], [' 12 500 ', 12500], ['1500,50', null], ['-5000', null], ['', null], ['12a', null], ['1'.repeat(14), null]])(
    'parseWholeRubles(%j) = %j', (input, expected) => expect(parseWholeRubles(input)).toBe(expected))
  it.each([['10', 1000], ['12,5', 1250], ['12.55', 1255], ['0', 0], ['50', 5000], ['50,01', null], ['0x10', null], [' ', null], ['', null], ['1e1', null], ['12,555', null]])(
    'parseReservePercent(%j) = %j', (input, expected) => expect(parseReservePercent(input)).toBe(expected))
})
