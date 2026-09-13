/*
 * Фича 012 «Заполненность анкет» — карточка панели сотрудника из `AdminMetrics.profiles`.
 * После ответа — числа сервера («63%», «12», «40»); до ответа — прочерки и ни одной цифры
 * (R-178). Красный без фикса: карточки на HEAD не было.
 */
import { render, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import App from '@/App'

const PENDING = Symbol('pending')

function serve(routes: Record<string, unknown>) {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api/, '').split('?')[0] ?? ''
    if (!(path in routes)) return Promise.resolve(json({ error: { code: 'not_found', message: `нет ответа для ${path}` } }, 404))
    const reply = routes[path]
    if (reply === PENDING) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
      })
    }
    return Promise.resolve(json(reply))
  }))
}

const METRICS = {
  users: 12, weddings: 3, vendorsPublished: 40, moderationQueue: 2,
  verificationQueue: 4, complaintsOpen: 0, complaintsOverdue: 0, deals: 5,
  gmv: { amount: 125_000_000, currency: 'RUB' },
  cities: [{ city: 'Уфа', vendors: 51, launchReady: true }],
  llm: { since: '2026-08-13T20:00:00.000Z', calls: 17, answered: 15, inputTokens: 23456, outputTokens: 1890 },
  profiles: { published: 40, complete: 12, averagePercent: 63 },
}

const text = (r: { container: HTMLElement }) => r.container.textContent ?? ''
const digits = (s: string) => s.replace(/\D+/g, '')

async function openAdmin(settled: string) {
  const r = render(<MemoryRouter initialEntries={['/admin']}><App /></MemoryRouter>)
  await waitFor(() => expect(r.container.querySelector('[data-testid="route-loading"]')).toBeNull(), { timeout: 4000 })
  await waitFor(() => expect(text(r)).toContain(settled), { timeout: 4000 })
  return r
}

describe('фича 012: заполненность анкет на дашборде', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
    localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('после ответа — «63%средняя», «12полных анкет», «40опубликовано» и подпись определения', async () => {
    serve({ '/admin/metrics': METRICS })
    const r = await openAdmin('Уфа')
    expect(text(r), 'карточки заполненности нет').toContain('Заполненность анкет')
    expect(text(r)).toContain('63%средняя')
    expect(text(r)).toContain('12полных анкет')
    expect(text(r)).toContain('40опубликовано')
    expect(text(r)).toContain('фото не считаются до подключения хранилища')
  })

  it('до ответа — карточка с прочерками и без единой цифры', async () => {
    serve({ '/admin/metrics': PENDING })
    const r = await openAdmin('Загружаем…')
    expect(text(r)).toContain('Заполненность анкет')
    expect(text(r)).toContain('полных анкет')
    expect(digits(text(r)), 'цифры появились до ответа сервера').toBe('')
  })
})
