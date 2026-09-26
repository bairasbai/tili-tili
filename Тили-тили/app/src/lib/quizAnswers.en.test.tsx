// @vitest-environment jsdom
/*
 * Фича 018 на втором языке (R-257, R-297): новые строки шага имён и карточки «Уже забронировано»
 * переводятся в месте показа. Проверяются обе половины — русского ключа на экране нет И перевод виден.
 * Язык фиксируется до импорта `lib/i18n` (`vi.hoisted`), как в `audit49d`.
 */
vi.hoisted(() => {
  localStorage.clear()
  localStorage.setItem('tt_lang', 'en')
})

import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StoreProvider } from './store'
import { t } from './i18n'
import Quiz from '@/pages/Quiz'
import Home from '@/pages/Home'
import { SlotDetail } from '@/pages/Wedding'

type RouteMap = Record<string, unknown>

function serve(routes: RouteMap) {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const path = decodeURIComponent(String(input).replace(/^\/api/, '').split('?')[0] ?? '')
    if (!(path in routes)) return Promise.resolve(new Response(JSON.stringify({ error: { code: 'not_found', message: path } }), { status: 404, headers: { 'content-type': 'application/json' } }))
    return Promise.resolve(json(routes[path]))
  }))
}

const renderAt = (initial: string, routes: React.ReactNode) =>
  render(
    <MemoryRouter initialEntries={[initial]}>
      <StoreProvider>
        <Routes>{routes}</Routes>
      </StoreProvider>
    </MemoryRouter>,
  )
const text = (r: { container: HTMLElement }) => r.container.textContent ?? ''

const signedIn = (wedding: boolean) => {
  localStorage.clear()
  localStorage.setItem('tt_lang', 'en')
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  if (wedding) localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
}

const WEDDING = { id: 'w1', title: 'Alina ♥ Timur', date: '2027-06-14', city: { name: 'Уфа', region: 'Башкортостан' } }
const ROUTES: RouteMap = {
  '/weddings': [{ ...WEDDING, role: 'couple' }],
  '/weddings/w1': WEDDING,
  '/weddings/w1/slots': [{ id: 's-venue', categoryId: 'venue', label: 'Площадка', deal: null, tileState: 'empty', prebooked: true }],
  '/weddings/w1/budget': { total: { amount: 0, currency: 'RUB' }, spent: { amount: 0, currency: 'RUB' }, categories: [] },
  '/weddings/w1/tips': { items: [] },
  '/weddings/w1/tasks': [],
  '/weddings/w1/guests': [],
  '/notifications': [],
  '/me/favorites': [],
  '/users/me': { id: 'u1', name: 'Alina' },
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('фича 018 по-английски', () => {
  beforeEach(() => signedIn(false))

  it('шаг имён: заголовок, два поля и подсказка — переводом, без русских ключей', async () => {
    serve(ROUTES)
    const r = renderAt('/quiz', <Route path="/quiz" element={<Quiz />} />)
    for (let step = 0; step < 8; step++) fireEvent.click(screen.getByText(t('Пропустить вопрос')))
    expect(t('Как вас зовут?')).toBe('What are your names?')
    expect(screen.getByRole('heading', { name: 'What are your names?' })).toBeTruthy()
    await waitFor(() => expect((screen.getByPlaceholderText('Your name') as HTMLInputElement).value).toBe('Alina'), { timeout: 4000 })
    expect(screen.getByPlaceholderText('Your partner’s name')).toBeTruthy()
    expect(text(r)).toContain('Your name will be saved to your profile')
    for (const ru of ['Как вас зовут?', 'Ваше имя', 'Имя партнёра', 'сохранится в профиле']) expect(text(r)).not.toContain(ru)
    expect(screen.queryByPlaceholderText('Ваше имя')).toBeNull()
    expect(screen.queryByPlaceholderText('Имя партнёра')).toBeNull()
  })

  it('карточка «Уже забронировано» на главной и экран слота — переводом', async () => {
    signedIn(true)
    serve(ROUTES)
    const home = renderAt('/home', <Route path="/home" element={<Home />} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'No, still looking' })).toBeTruthy(), { timeout: 4000 })
    expect(screen.getByRole('button', { name: 'Add the vendor' })).toBeTruthy()
    expect(text(home)).toContain('Outside the app — from your quiz answer')
    expect(text(home)).toContain('Already booked')
    for (const ru of ['Нет, ещё ищем', 'Добавить подрядчика', 'Вне приложения', 'Уже забронировано']) expect(text(home)).not.toContain(ru)
    cleanup()

    const slot = renderAt('/wedding/slot/s-venue', <Route path="/wedding/slot/:id" element={<SlotDetail />} />)
    await waitFor(() => expect(text(slot)).toContain('You said in the quiz that this vendor is already booked'), { timeout: 4000 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'No, still looking' })).toBeTruthy(), { timeout: 4000 })
    expect(text(slot)).not.toContain('Вы отметили в квизе')
  })
})
