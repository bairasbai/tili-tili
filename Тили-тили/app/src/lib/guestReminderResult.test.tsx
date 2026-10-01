// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Guests } from '@/pages/Wedding'
import { StoreProvider } from './store'
import { setI18nLang, type Lang } from './i18n'

type Result = { sent: number; skippedNoPhone: number; skippedLinkUsed: number; failed: number }
const zero: Result = { sent: 0, skippedNoPhone: 0, skippedLinkUsed: 0, failed: 0 }
const endpoint = '/weddings/w1/guests/remind'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
})

function open(reply: () => Promise<Response>, lang: Lang = 'ru', role = 'couple') {
  localStorage.setItem('tt_lang', lang)
  setI18nLang(lang)
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api/, '').split('?')[0]
    if (path === endpoint) { calls.push(init?.method ?? 'GET'); return reply() }
    const wedding = { id: 'w1', title: 'Reminder test', date: '2027-06-14', city: { name: 'Ufa' }, tz: 'Europe/Moscow', role }
    const routes: Record<string, unknown> = {
      '/weddings': [wedding], '/weddings/w1': wedding, '/weddings/w1/slots': [],
      '/me/favorites': [], '/users/me': { id: 'u1', name: 'Owner' },
      '/weddings/w1/guests': [{ id: 'g1', name: 'Reminder recipient', status: 'pending', plusOne: false, phone: null, hasPhone: false }],
    }
    return Promise.resolve(path && path in routes ? json(routes[path]) : json({ error: { code: 'not_found', message: 'Unexpected fixture route' } }, 404))
  }))
  render(<MemoryRouter><StoreProvider><Guests /></StoreProvider></MemoryRouter>)
  return calls
}

async function remind(lang: Lang = 'ru') {
  const button = await screen.findByRole('button', { name: lang === 'en' ? 'Remind those who have not answered' : 'Напомнить не ответившим' })
  fireEvent.click(button)
  return button
}

describe('guest reminder result: server failure counts without real SMS', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
    localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
    localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
    setI18nLang('ru')
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); setI18nLang('ru') })

  it.each(['ru', 'en'] as const)('shows sent/skips/failed together in %s', async lang => {
    const calls = open(async () => json({ sent: 2, skippedNoPhone: 3, skippedLinkUsed: 4, failed: 1 }), lang)
    await remind(lang)
    const expected = lang === 'en'
      ? 'Sent: 2 · no phone number: 3 · link already opened: 4 · Not sent: 1'
      : 'Отправлено: 2 · без телефона: 3 · ссылку уже открыли: 4 · Не отправлено: 1'
    expect(await screen.findByText(expected)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe(expected)
    expect(calls).toEqual(['POST'])
  })

  it('shows complete failure instead of only sent zero', async () => {
    open(async () => json({ ...zero, failed: 5 }))
    await remind()
    expect(await screen.findByText('Отправлено: 0 · Не отправлено: 5')).toBeTruthy()
  })

  it('does not invent a failure when the server reports zero', async () => {
    open(async () => json({ ...zero, sent: 1 }))
    await remind()
    expect(await screen.findByText('Отправлено: 1')).toBeTruthy()
    expect(screen.queryByText(/Не отправлено/)).toBeNull()
  })

  it('keeps skipped recipients separate from failed sends', async () => {
    open(async () => json({ ...zero, skippedNoPhone: 3, skippedLinkUsed: 2 }))
    await remind()
    expect(await screen.findByText('Отправлено: 0 · без телефона: 3 · ссылку уже открыли: 2')).toBeTruthy()
    expect(screen.queryByText(/Не отправлено/)).toBeNull()
  })

  it('clears the previous result when the next attempt receives a daily refusal', async () => {
    let attempts = 0
    open(async () => ++attempts === 1 ? json({ ...zero, sent: 1 }) : json({ error: { code: 'too_often', message: 'Reminder daily refusal' } }, 429))
    await remind()
    expect(await screen.findByText('Отправлено: 1')).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Напомнить не ответившим' }).hasAttribute('disabled')).toBe(false))
    await remind()
    expect(await screen.findByText('Reminder daily refusal')).toBeTruthy()
    expect(screen.queryByText(/Отправлено:/)).toBeNull()
  })

  it('keeps a pending attempt busy and does not submit twice', async () => {
    let release!: (response: Response) => void
    const pending = new Promise<Response>(resolve => { release = resolve })
    const calls = open(() => pending)
    await remind()
    const busy = await screen.findByRole('button', { name: 'Отправляем…' })
    expect(busy.hasAttribute('disabled')).toBe(true)
    fireEvent.click(busy)
    expect(calls).toEqual(['POST'])
    release(json({ ...zero, sent: 1 }))
    expect(await screen.findByText('Отправлено: 1')).toBeTruthy()
  })

  it('offers no reminder action to a helper', async () => {
    const calls = open(async () => json(zero), 'ru', 'helper')
    expect(await screen.findByText('Reminder recipient')).toBeTruthy()
    await waitFor(() => expect(screen.queryByText('Загружаем…')).toBeNull())
    expect(screen.queryByRole('button', { name: 'Напомнить не ответившим' })).toBeNull()
    expect(calls).toEqual([])
  })
})
