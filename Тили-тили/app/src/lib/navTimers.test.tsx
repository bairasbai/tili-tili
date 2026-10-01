// @vitest-environment jsdom
/*
 * Отложенный переход после подтверждения — регрессия аудита 2026-09-03.
 *
 * «Добавить в свадьбу» и «Выбрать» показывают галочку и через 900 мс уводят
 * на /wedding. Раньше это был голый setTimeout в обработчике: таймер жил
 * дольше экрана и утаскивал человека со страницы, которую он за эти 900 мс
 * успел открыть сам.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/* Анкета приходит с сервера — кнопка появляется после ответа. Общий набор
   ответов каталога: src/test/catalogMock.ts. */
vi.mock('@/lib/api/catalog', async () => (await import('@/test/catalogMock')).catalogMock())
/* Бронь уходит на сервер, и галочка ставится только после ответа: без живой
   мозаики кнопка честно скажет «этой категории нет в мозаике» и никуда не
   уведёт. Общий набор ответов: src/test/slotsMock.ts. */
vi.mock('@/lib/api/weddingData', async (orig) => ({ ...await orig<object>(), ...(await import('@/test/slotsMock')).slotsRead }))
vi.mock('@/lib/api/slots', async (orig) => ({ ...await orig<object>(), ...(await import('@/test/slotsMock')).slotsWrite }))
import { authorize, resetSlots } from '@/test/slotsMock'
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react'

const { navSpy } = vi.hoisted(() => ({ navSpy: vi.fn() }))
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>()
  return { ...actual, useNavigate: () => navSpy }
})

import { MemoryRouter, Route, Routes } from 'react-router'
import { StoreProvider } from './store'
import { VendorDetail } from '@/pages/Search'

let policyReads = 0
let unexpected: string[] = []
beforeEach(() => {
  resetSlots(); authorize(); policyReads = 0; unexpected = []
  // Keep the real policy and membership HTTP wrappers: the timer controls
  // below apply to a positively identified current couple + legacy company.
  const wedding = { id: 'w1', title: 'Аня и Боря', date: '2027-06-14', city: { name: 'Уфа', region: 'Башкортостан' }, tz: 'Asia/Yekaterinburg' }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api/, '').split('?')[0], method = init?.method ?? 'GET'
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (method === 'GET') {
      if (path === '/weddings') return reply([{ ...wedding, role: 'couple' }])
      if (path === '/weddings/w1') return reply(wedding)
      if (path === '/vendors/v1/booking-policy') { policyReads++; return reply({ mode: 'legacy_day', revision: '0' }) }
      if (path === '/weddings/w1/slots/s2/shortlist') return reply([])
      if (path === '/catalog/vendors/v1/reviews') return reply({ items: [], nextCursor: null })
      if (path === '/vendor/profile') return reply({ error: { code: 'not_found', message: 'Анкеты подрядчика пока нет' } }, 404)
    }
    unexpected.push(`${method} ${path}`)
    return reply({ error: { code: 'not_found', message: 'Неизвестный тестовый маршрут' } }, 404)
  }))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  navSpy.mockClear()
  vi.unstubAllGlobals()
  localStorage.clear()
  expect(unexpected).toEqual([])
})

/* Анкета читает `:id` через useParams — маршрут объявляем, иначе экран
   честно показывает «не найдена». Раньше это скрывала подстановка первого
   подрядчика из мока. */
const renderPage = (ui: React.ReactElement) =>
  render(
    <MemoryRouter initialEntries={['/vendor/v1']}>
      <StoreProvider>
        <Routes><Route path="/vendor/:id" element={ui} /></Routes>
      </StoreProvider>
    </MemoryRouter>,
  )

describe('анкета подрядчика: «Добавить в свадьбу»', () => {
  it('переход происходит, если человек остался на экране', async () => {
    renderPage(<VendorDetail />)
    /* Ждём анкету на настоящих таймерах: с поддельными промис ответа не
       доезжает, и кнопки на экране ещё нет. */
    const add = await screen.findByText('Добавить в свадьбу')
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false))
    vi.useFakeTimers()

    fireEvent.click(add)
    /* Галочка ставится после ответа сервера, и только она заводит таймер.
       Промисы поддельные таймеры не трогают — их нужно прокрутить руками,
       иначе advanceTimersByTime сработает раньше, чем таймер появится. */
    await act(async () => {})
    expect(screen.getByText('✓ В моей свадьбе!')).toBeTruthy()
    expect(policyReads).toBe(2)
    expect(navSpy).not.toHaveBeenCalled()

    act(() => { vi.advanceTimersByTime(900) })
    expect(navSpy).toHaveBeenCalledWith('/wedding')
  })

  it('уход с экрана до срабатывания отменяет переход', async () => {
    const { unmount } = renderPage(<VendorDetail />)
    const add = await screen.findByText('Добавить в свадьбу')
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false))
    vi.useFakeTimers()

    fireEvent.click(add)
    await act(async () => {}) // дождались ответа сервера — таймер заведён
    expect(screen.getByText('✓ В моей свадьбе!')).toBeTruthy()
    expect(policyReads).toBe(2)
    unmount() // человек нажал «назад» и открыл другой экран

    act(() => { vi.advanceTimersByTime(5000) })
    // До фикса таймер переживал экран и уводил на /wedding уже оттуда.
    expect(navSpy).not.toHaveBeenCalled()
  })
})

/*
 * Отложенного перехода на экране сравнения больше нет: «Выбрать» бронировало
 * подрядчика и через 900 мс уводило на мозаику — но передавало на сервер имя
 * там, где нужен идентификатор, и не бронировало ничего. Теперь кнопка
 * открывает анкету сразу, таймера нет и отменять нечего.
 */
