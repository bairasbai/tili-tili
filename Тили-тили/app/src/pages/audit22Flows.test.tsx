// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Home from './Home'
import { Budget, Guests, Timeline } from './Wedding'
import { ContractWizard } from './Tools'
import { Logistics } from './Logistics'
import { Join } from './Team'
import { GiftPick } from './Wishlist'
import Invite from './Invite'
import { saveTokens } from '@/lib/api/client'
import { saveGuestToken } from '@/lib/api/guest'
import { setI18nLang } from '@/lib/i18n'
import type { Slot } from '@/lib/types'

const store = vi.hoisted(() => ({ weddingId: '71000000-0000-4000-8000-000000000001', weddingDate: '2030-06-14',
  slots: [] as Slot[], slotsState: 'ready', weddingsState: 'ready', setWeddingId: vi.fn(), finishOnboarding: vi.fn() }))
vi.mock('@/lib/store', () => ({ useStore: () => store }))
const W = store.weddingId, EXTRA = '71000000-0000-4000-8000-000000000002', DEAL = '71000000-0000-4000-8000-000000000003'
const OTHER_W = '71000000-0000-4000-8000-000000000004'
const program = { id: EXTRA, name: 'Второй день', kind: 'second_day' as const, date: '2030-06-16', timeZone: 'Asia/Yekaterinburg', isMain: false, location: null }
const wedding = { id: W, title: 'Синтетическая пара', date: store.weddingDate, tz: 'Europe/Moscow', city: { name: 'Уфа', region: 'Башкортостан' } }
const money = (amount: number) => ({ amount, currency: 'RUB' })
type Call = { path: string; method: string; body: unknown; key: string | null }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ETag: '"audit22-v1"' } })
let calls: Call[], people: unknown[], timeline: unknown[], unknown: string[]
let handler: ((call: Call) => Response | Promise<Response> | undefined) | undefined
let blobs: Blob[]
function mount(page: React.ReactNode, path = '/') { return render(<MemoryRouter initialEntries={[path]}>{page}</MemoryRouter>) }
const writes = (suffix: string) => calls.filter(c => c.method !== 'GET' && c.path.endsWith(suffix))
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); setI18nLang('ru'); store.slots = []; store.setWeddingId.mockReset()
  calls = []; people = []; timeline = []; unknown = []; blobs = []; handler = undefined
  saveTokens({ accessToken: `header.${btoa(JSON.stringify({ sub: W, sid: EXTRA }))}.signature`, refreshToken: 'synthetic-a22' })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, '')
    const call = { path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) as unknown : null,
      key: new Headers(init?.headers).get('Idempotency-Key') }; calls.push(call)
    const custom = handler?.(call); if (custom) return custom
    if (call.method === 'GET') {
      if (path === '/weddings') return json([{ ...wedding, role: 'couple' }, { ...wedding, id: OTHER_W, role: 'helper' }])
      if (path === `/weddings/${W}`) return json(wedding)
      if (path.endsWith('/guests')) return json(people)
      if (path.endsWith('/slots')) return json([])
      if (path.endsWith('/events')) return json([program])
      if (path.endsWith('/timeline')) return json(timeline)
      if (path.endsWith('/timeline/acknowledgments')) return json({ items: [], version: 'audit22-v1' })
      if (path.endsWith('/tips')) return json({ items: [] })
      if (path.endsWith('/budget')) return json({ total: money(0), spent: money(0), reserve: money(0), reserveBps: 1000, settingsVersion: 1,
        categories: [{ id: 'photo', title: 'Фотограф', planned: money(0), fromSlots: 0, items: [] }] })
      if (['/notifications', '/me/favorites'].includes(path) || /\/(tasks|members|buses|hotels)$/.test(path)) return json([])
    }
    if (call.method === 'PATCH' && path === `/weddings/${W}`) return json(wedding)
    if (call.method === 'POST' && /\/(items|hotels)$/.test(path)) return json({ id: DEAL }, 201)
    if (call.method === 'PUT' && path.endsWith('/timeline')) return json(call.body)
    unknown.push(`${call.method} ${path}`)
    return json({ error: { code: 'test_route', message: 'Непредусмотренный запрос' } }, 500)
  }))
  vi.stubGlobal('URL', URL)
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob); return 'blob:synthetic-a22' })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
})
afterEach(async () => {
  cleanup(); await act(async () => undefined); saveGuestToken(null); saveTokens(null)
  vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear()
  expect(unknown).toEqual([])
})

describe('audit22 real page output and HTTP mutations (FE04–12)', () => {
  it('FE04 Home counts each named family row once, including independent yes/pending answers', async () => {
    people = [{ id: 'g1', partyId: 'p', partyPosition: 1, partySize: 2, name: 'Анна', status: 'yes', plusOne: true },
      { id: 'g2', partyId: 'p', partyPosition: 2, partySize: 2, name: 'Борис', status: 'pending' }]
    mount(<Home />)
    await screen.findByText('1 подтвердили · 1 ждут ответа')
  })
  it.each([program.date, null])('FE05 contract preview uses selected event date %s, including unknown date', async date => {
    store.slots = [{ id: 'slot', categoryId: 'photo', label: 'Фотограф', icon: '📷', tile: '', state: 'booked', dealId: DEAL,
      dealState: 'booked', vendor: 'Синтетический фотограф', programEvent: { ...program, date } }]
    mount(<ContractWizard />, `/contract?deal=${DEAL}`)
    fireEvent.click(await screen.findByRole('button', { name: 'Далее' }))
    const label = screen.getByText('Дата оказания услуги')
    expect(label.parentElement?.textContent).toContain(date ? '16 июня 2030' : 'уточняется')
    expect(label.parentElement?.textContent).not.toContain('14 июня')
  })
  it('FE06 displays and edits additional block in its own zone; retains its eventId in the saved list', async () => {
    timeline = [{ id: 'block-extra', eventId: EXTRA, name: 'Ужин второго дня', startsAt: '2030-06-16T05:00:00.000Z', endsAt: null, forGuests: true }]
    mount(<Timeline />)
    const block = await screen.findByText('Ужин второго дня')
    await waitFor(() => expect(block.closest('.card-s')?.textContent).toContain('10:00'))
    fireEvent.click(screen.getByRole('button', { name: 'Править' }))
    fireEvent.click(screen.getByRole('button', { name: 'Изменить блок: Ужин второго дня' }))
    const input = screen.getByLabelText('Начало блока')
    expect((input as HTMLInputElement).value).toContain('2030-06-16T10:00')
    fireEvent.change(input, { target: { value: '2030-06-16T11:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить блок' }))
    await waitFor(() => expect(writes('/timeline')).toHaveLength(1))
    expect(writes('/timeline')[0]!.body).toMatchObject([{ eventId: EXTRA, startsAt: '2030-06-16T06:00:00.000Z' }])
  })
  it.each(['150000,00', '-5000', '1e3'])('FE07 total budget refuses malformed whole rubles %s without changing amount', async text => {
    mount(<Budget />)
    await screen.findByText('Фотограф')
    fireEvent.change(await screen.findByPlaceholderText('Общий бюджет, ₽'), { target: { value: text } })
    const field = screen.getByPlaceholderText('Общий бюджет, ₽').parentElement!
    fireEvent.click(within(field).getByRole('button'))
    await screen.findByRole('alert')
    expect(writes(`/weddings/${W}`)).toHaveLength(0)
    expect((screen.getByPlaceholderText('Общий бюджет, ₽') as HTMLInputElement).value).toBe(text)
  })
  it('FE07 custom expense refuses fractional input and preserves the draft', async () => {
    mount(<Budget />)
    await screen.findByText('Фотограф')
    fireEvent.click(screen.getByRole('button', { name: 'Добавить расход' }))
    const title = screen.getByPlaceholderText<HTMLInputElement>('Статья расхода (например, «Фейерверк»)')
    const amount = screen.getByPlaceholderText<HTMLInputElement>('Сумма, ₽')
    fireEvent.change(title, { target: { value: 'Салют' } })
    fireEvent.change(amount, { target: { value: '1500,50' } })
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Добавить' })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await screen.findByRole('alert')
    expect(writes('/items')).toHaveLength(0)
    expect(title.value).toBe('Салют')
    expect(amount.value).toBe('1500,50')
  })
  it('FE07 valid grouped whole-ruble budget still sends its exact minor-unit amount', async () => {
    mount(<Budget />)
    await screen.findByText('Фотограф')
    const input = await screen.findByPlaceholderText('Общий бюджет, ₽')
    fireEvent.change(input, { target: { value: '150 000' } })
    const save = screen.getByRole('button', { name: 'Задать бюджет' }) as HTMLButtonElement
    expect(save.disabled).toBe(false); expect(input.isConnected).toBe(true)
    fireEvent.click(save)
    await waitFor(() => expect(writes(`/weddings/${W}`), JSON.stringify(calls)).toHaveLength(1))
    expect(writes(`/weddings/${W}`)[0]!.body).toEqual({ budgetTotal: money(15_000_000) })
  })
  it.each(['10 000', '10\u00a0000', '10\u202f000'])('FE08 hotel grouped price %s sends exactly ten thousand rubles', async price => {
    mount(<Logistics />); fireEvent.click(await screen.findByRole('button', { name: 'Добавить отельный блок' }))
    fireEvent.change(screen.getByPlaceholderText('Название отеля'), { target: { value: 'Тестовый отель' } })
    fireEvent.change(screen.getByPlaceholderText('Номеров'), { target: { value: '5' } })
    fireEvent.change(screen.getByPlaceholderText('₽/ночь'), { target: { value: price } })
    fireEvent.click(screen.getByRole('button', { name: 'Добавить отель' }))
    await waitFor(() => expect(writes('/hotels')).toHaveLength(1))
    expect(writes('/hotels')[0]!.body).toMatchObject({ price: money(1_000_000) })
  })
  it('FE08 malformed hotel price remains in the form and sends no request', async () => {
    mount(<Logistics />); fireEvent.click(await screen.findByRole('button', { name: 'Добавить отельный блок' }))
    fireEvent.change(screen.getByPlaceholderText('Название отеля'), { target: { value: 'Тестовый отель' } })
    fireEvent.change(screen.getByPlaceholderText('Номеров'), { target: { value: '5' } })
    fireEvent.change(screen.getByPlaceholderText('₽/ночь'), { target: { value: '1000,50' } })
    fireEvent.click(screen.getByRole('button', { name: 'Добавить отель' })); await screen.findByRole('alert')
    expect(writes('/hotels')).toHaveLength(0)
    expect((screen.getByPlaceholderText('₽/ночь') as HTMLInputElement).value).toBe('1000,50')
  })
  it('FE09 accepting a helper invitation selects its returned wedding even when a couple wedding exists', async () => {
    handler = c => c.path === '/invites/test-code' ? json({ role: 'helper', weddingTitle: 'Чужая свадьба' })
      : c.path === '/invites/test-code/accept' ? json({ weddingId: OTHER_W, role: 'helper' }) : undefined
    mount(<Routes><Route path="/join/:code" element={<Join />} /></Routes>, '/join/test-code')
    const button = await screen.findByRole('button', { name: 'Принять приглашение' })
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(button)
    await screen.findByText('Вы в команде!'); expect(store.setWeddingId).toHaveBeenCalledWith(OTHER_W)
  })
  it.each(['gift', 'fund', 'gift-remount', 'fund-remount', 'gift-closed-remount'])('FE10 an unknown %s contribution outcome retries the same idempotency key and body', async mode => {
    const kind = mode.startsWith('gift') ? 'gift' : 'fund'
    saveGuestToken('synthetic-guest-a22')
    const item = { id: DEAL, name: 'Тестовое желание', group: true, price: money(100000), funded: money(0), reserved: false }
    let attempts = 0
    handler = c => {
      if (c.path === '/gifts/synthetic-guest-a22' && c.method === 'GET') return json({ gifts: kind === 'gift' ? [{ ...item, reserved: mode.includes('closed') && attempts > 0 }] : [], funds: kind === 'fund' ? [{ id: DEAL, name: 'Тестовый фонд', target: money(100000), collected: money(0) }] : [] })
      if (c.method === 'POST' && c.path.startsWith('/gifts/')) { attempts++; return attempts === 1 ? Promise.reject(new TypeError('Lost response')) : json(item) }
      if (c.path.endsWith('/team')) return json([])
      return undefined
    }
    mount(<GiftPick />)
    fireEvent.click(await screen.findByRole('button', { name: kind === 'gift' ? /Скинуться/ : 'Обещаю внести' }))
    fireEvent.change(screen.getByPlaceholderText('Сумма, ₽'), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Записать обещание' })); await screen.findByRole('alert')
    if (mode.endsWith('remount')) {
      cleanup(); mount(<GiftPick />)
      // A pending attempt may restore its open form, otherwise reopen it.
      await screen.findByText(kind === 'gift' ? 'Тестовое желание' : 'Тестовый фонд')
      if (!screen.queryByRole('button', { name: 'Повторить обещание' }) && !screen.queryByRole('button', { name: 'Записать обещание' })) {
        fireEvent.click(screen.getByRole('button', { name: kind === 'gift' ? /Скинуться/ : 'Обещаю внести' }))
        fireEvent.change(screen.getByPlaceholderText('Сумма, ₽'), { target: { value: '100' } })
      }
    }
    fireEvent.click(screen.queryByRole('button', { name: 'Повторить обещание' }) ?? screen.getByRole('button', { name: 'Записать обещание' }))
    await waitFor(() => expect(attempts).toBe(2))
    const posts = calls.filter(c => c.method === 'POST'); expect(posts[0]!.key).toBeTruthy()
    expect(posts[1]!.key).toBe(posts[0]!.key); expect(posts[1]!.body).toEqual(posts[0]!.body)
  })
  it('FE06 conflict refresh reloads event timezone together with the new timeline version', async () => {
    let version = 1
    const block = { id: 'extra', eventId: EXTRA, name: 'Изменяемый ужин', startsAt: '2030-06-16T05:00:00.000Z', forGuests: true }
    const response = (data: unknown) => { const r = json(data); r.headers.set('ETag', `"v${version}"`); return r }
    handler = c => {
      if (c.method === 'GET' && c.path.endsWith('/timeline')) return response([block])
      if (c.method === 'GET' && c.path.endsWith('/events')) return response([{ ...program, timeZone: version === 1 ? 'Asia/Yekaterinburg' : 'Asia/Vladivostok' }])
      if (c.method === 'PUT' && c.path.endsWith('/timeline')) { version = 2; return json({ error: { code: 'timeline_conflict', message: 'Программа изменилась' } }, 409) }
      return undefined
    }
    mount(<Timeline />); await screen.findByText('Изменяемый ужин')
    await waitFor(() => expect(screen.getByText('Изменяемый ужин').closest('.card-s')?.textContent).toContain('10:00'))
    fireEvent.click(screen.getByRole('button', { name: 'Править' }))
    fireEvent.click(screen.getByRole('button', { name: 'Изменить блок: Изменяемый ужин' }))
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить блок' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Обновить' }))
    await waitFor(() => expect(screen.getByText('Изменяемый ужин').closest('.card-s')?.textContent).toContain('15:00'))
  })
  it('FE10 only an explicit separate promise starts a new intent after an unknown outcome', async () => {
    saveGuestToken('synthetic-intent-a22'); let attempts = 0
    const item = { id: DEAL, name: 'Отдельное желание', group: true, price: money(100000), funded: money(0), reserved: false }
    handler = c => {
      if (c.path === '/gifts/synthetic-intent-a22' && c.method === 'GET') return json({ gifts: [item], funds: [] })
      if (c.method === 'POST' && c.path.startsWith('/gifts/')) { attempts++; return attempts === 1 ? Promise.reject(new TypeError('Lost response')) : json(item) }
      if (c.path.endsWith('/team')) return json([])
      return undefined
    }
    mount(<GiftPick />); fireEvent.click(await screen.findByRole('button', { name: /Скинуться/ }))
    fireEvent.change(screen.getByPlaceholderText('Сумма, ₽'), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Записать обещание' })); await screen.findByRole('alert')
    expect((screen.getByRole('button', { name: 'Записать обещание' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Новое отдельное обещание' }))
    fireEvent.click(screen.getByRole('button', { name: /Скинуться/ }))
    fireEvent.change(screen.getByPlaceholderText('Сумма, ₽'), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Записать обещание' }))
    await waitFor(() => expect(attempts).toBe(2))
    const posts = calls.filter(c => c.method === 'POST'); expect(posts[0]!.key).toBeTruthy(); expect(posts[1]!.key).not.toBe(posts[0]!.key)
  })
  it('FE11 failed family RSVP preserves individual choice and food note for retry', async () => {
    saveGuestToken('synthetic-rsvp-a22')
    handler = c => {
      if (c.path === '/rsvp/synthetic-rsvp-a22' && c.method === 'GET') return json({ guestName: 'Анна', status: 'pending', members: [
        { guestId: 'g1', name: 'Анна', status: 'pending' }, { guestId: 'g2', name: 'Борис', status: 'pending' }], wedding: { ...wedding, date: '2099-06-14' } })
      if (c.path === '/rsvp/synthetic-rsvp-a22' && c.method === 'POST') return json({ error: { code: 'internal', message: 'Повторите позже' } }, 500)
      if (c.path.endsWith('/events')) return json({ items: [] })
      return undefined
    }
    mount(<Invite />)
    fireEvent.click(await screen.findByRole('button', { name: 'Открыть приглашение' }))
    await waitFor(() => {
      const buttons = screen.getAllByRole<HTMLButtonElement>('button', { name: 'Приду' })
      expect(buttons).toHaveLength(2)
      expect(buttons.every(button => button.isConnected && !button.disabled)).toBe(true)
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Приду' })[0]!)
    fireEvent.click(await screen.findByRole('button', { name: 'Другое' }))
    fireEvent.change(await screen.findByPlaceholderText('Например: аллергия на орехи'), { target: { value: 'Без орехов' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Не смогу' })[1]!)
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить ответы семьи' }))
    await screen.findByRole('alert')
    const attempts = writes('/rsvp/synthetic-rsvp-a22')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.body).toEqual({ members: [
      { guestId: 'g1', status: 'yes', diet: 'other', dietNote: 'Без орехов', transfer: null },
      { guestId: 'g2', status: 'no' },
    ] })
    expect((screen.getByPlaceholderText('Например: аллергия на орехи') as HTMLInputElement).value).toBe('Без орехов')
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Сохранить ответы семьи' }).disabled).toBe(false))
  })
  it('FE12 guest CSV quotes semicolons, quotes and newlines as one cell and one record', async () => {
    people = [{ id: 'g1', name: 'Анна; "Аня"\nИванова', status: 'yes', partySize: 1 }]
    mount(<Guests />); await screen.findByText('Анна; "Аня" Иванова')
    fireEvent.click(screen.getByRole('button', { name: 'Список CSV' }))
    expect(blobs).toHaveLength(1)
    const text = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsText(blobs[0]!) })
    expect(text).toContain('"Анна; ""Аня""\nИванова";Придёт;нет')
  })
})
