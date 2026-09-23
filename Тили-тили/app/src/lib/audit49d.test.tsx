// @vitest-environment jsdom
/*
 * ERR-0274 / R-274 (review-016, лейна FL-4, RUN-NONCE ffed980e5bceaf1d).
 *
 * Баг (F-RL5-02, TR-1 §3.2 row 2 / §7 FL-4): в EN-интерфейсе быстрые чипы города квиза
 * (`Quiz.tsx:258-262`) мапили уже ПЕРЕВЕДЁННЫЙ список — `[t('Уфа'), t('Сибай'), …].map(n => …)` —
 * и сохраняли `n` (перевод, например `'Ufa'`) через `setCity(n, …)`/`setAnswers`; регион-тернарник
 * сравнивал `n === 'Москва'` с уже переведённым значением. `createWedding` уходил на сервер с
 * `city.name = 'Ufa'`, сервер ищет город точным совпадением (`weddings.ts:207-213`) → 404 на
 * последнем шаге квиза. Инвариант нарушен дважды: в хранилище лежит русский ключ справочника
 * (CLAUDE.md §5.2, R-07), а `t()` — только в разметке чипа (тот же класс, что ERR-0261/R-257).
 *
 * Файл целиком в EN: `lib/i18n.ts` читает `tt_lang` один раз при первой загрузке модуля
 * (`cur` — модульная переменная), поэтому язык фиксируется через `vi.hoisted` до импорта
 * `App`/`lib/i18n` — тот же приём, что в `evidence\RL-5\repro\rl5-quiz-en.test.tsx` (A1/A2),
 * откуда унаследован харнесс (review-016, TR-1 §7 FL-4 «Tests to write first»).
 */
vi.hoisted(() => {
  localStorage.clear()
  localStorage.setItem('tt_lang', 'en')
})

import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import App from '@/App'
import { t } from '@/lib/i18n'

/* Живой канал чата подменяется, как в audit27/audit32/RL-5-A: после создания свадьбы квиз
   уводит на /home, а настоящий WebSocket в jsdom тянулся бы к серверу и переподключался по таймеру. */
vi.mock('@/lib/api/chats', async (orig) => ({
  ...await orig<object>(),
  openChatSocket: () => () => undefined,
}))

type RouteMap = Record<string, unknown>
type Call = { method: string; path: string; url: string; body: unknown }

function serve(routes: RouteMap): Call[] {
  const calls: Call[] = []
  const json = (body: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const full = String(input).replace(/^\/api/, '')
    const path = decodeURIComponent(full.split('?')[0] ?? '')
    let body: unknown = null
    try { body = init?.body ? JSON.parse(String(init.body)) : null } catch { body = init?.body }
    const call: Call = { method: init?.method ?? 'GET', path, url: full, body }
    calls.push(call)
    if (!(path in routes)) return Promise.resolve(json({ error: { code: 'not_found', message: `нет ответа для ${path}` } }, 404))
    const stored = routes[path]
    const reply = typeof stored === 'function' ? (stored as (c: Call) => unknown)(call) : stored
    return Promise.resolve(json(reply))
  }))
  return calls
}

const text = (r: { container: HTMLElement }) => r.container.textContent ?? ''

async function open(route: string, settled: string) {
  const r = render(<MemoryRouter initialEntries={[route]}><App /></MemoryRouter>)
  await waitFor(() => expect(r.container.querySelector('[data-testid="route-loading"]')).toBeNull(), { timeout: 4000 })
  await waitFor(() => expect(text(r)).toContain(settled), { timeout: 4000 })
  return r
}

const routes = (): RouteMap => ({
  '/weddings': (c: Call) => (c.method === 'POST' ? { id: 'w2' } : []),
  '/weddings/w2': { id: 'w2', title: 'X ♥ Y', date: null, city: { name: 'Уфа', region: 'Башкортостан' }, members: [] },
  '/weddings/w2/slots': [],
  '/weddings/w2/budget': { total: { amount: 0, currency: 'RUB' }, spent: { amount: 0, currency: 'RUB' }, categories: [] },
  '/weddings/w2/tips': { items: [] }, '/weddings/w2/tasks': [], '/weddings/w2/guests': [],
  '/notifications': [], '/users/me': { id: 'u1', name: 'Аня' },
})

/* `tt_city`/`tt_city_region` пишутся сырой строкой (`safeSet`, lib/usePersist.ts) — без JSON. */
const stored = (key: string) => localStorage.getItem(key)

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function toCityStep() {
  const r = await open('/quiz', t('Когда ваша свадьба?'))
  fireEvent.click(screen.getByRole('button', { name: t('Пропустить вопрос') }))
  await waitFor(() => expect(text(r)).toContain(t('Город праздника?')), { timeout: 4000 })
  return r
}

/** От шага города (уже открыт, чип выбран) до шага имени: шесть промежуточных «Пропустить». */
async function skipToNameStep() {
  for (let step = 0; step < 6; step += 1) {
    const skip = screen.queryByRole('button', { name: t('Пропустить вопрос') })
    if (!skip) break
    fireEvent.click(skip)
  }
  await waitFor(() => expect(screen.queryByPlaceholderText(t('Имя'))).not.toBeNull(), { timeout: 4000 })
}

describe('audit49d · ERR-0274/R-274 · EN-квиз: быстрый выбор города хранит ключ, не перевод', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_lang', 'en')
    localStorage.setItem('tt_onboarded', '1')
    localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('T1: чип «Ufa» рисует перевод и сохраняет канонический ключ «Уфа»/«Башкортостан»', async () => {
    serve(routes())
    await toCityStep()
    const chip = screen.getByRole('button', { name: t('Уфа') })
    expect(chip.textContent, 'подпись чипа должна быть переводом').toBe(t('Уфа'))
    fireEvent.click(chip)
    expect(stored('tt_city'), 'в сторе должен лежать русский ключ, а не перевод').toBe('Уфа')
    expect(stored('tt_city_region'), 'регион должен быть русским ключом').toBe('Башкортостан')
  })

  it('T2: POST /weddings несёт city { name: "Уфа", region: "Башкортостан" } — не перевод', async () => {
    const calls = serve(routes())
    await toCityStep()
    fireEvent.click(screen.getByRole('button', { name: t('Уфа') }))
    fireEvent.click(screen.getByRole('button', { name: t('Далее') }))
    await skipToNameStep()
    fireEvent.change(screen.getByPlaceholderText(t('Имя')), { target: { value: 'Тимур' } })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(escapeRe(t('Создать мою свадьбу ✨'))) }))
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/weddings')).toBe(true), { timeout: 4000 })
    const post = calls.find(c => c.method === 'POST' && c.path === '/weddings')!
    expect((post.body as { city: { name: string; region: string } }).city, 'сервер получил перевод вместо ключа справочника')
      .toEqual({ name: 'Уфа', region: 'Башкортостан' })
  })

  it('T3: чип «Moscow» хранит регион ключом «Москва», не переводом (регион-тернарник читает ключ)', async () => {
    serve(routes())
    await toCityStep()
    const chip = screen.getByRole('button', { name: t('Москва') })
    expect(chip.textContent, 'подпись чипа должна быть переводом').toBe(t('Москва'))
    fireEvent.click(chip)
    expect(stored('tt_city'), 'в сторе должен лежать русский ключ').toBe('Москва')
    expect(stored('tt_city_region'), 'регион-тернарник сравнивал перевод, а не ключ').toBe('Москва')
  })
})
