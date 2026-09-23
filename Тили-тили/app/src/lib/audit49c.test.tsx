// @vitest-environment jsdom
/*
 * FL-3 · ERR-0273 / R-273 (ревью-016, RUN-NONCE ffed980e5bceaf1d), D-волна 1 (ARB-1 §C2).
 *
 * F-RL5-01 (S1, CONFIRMED, TR-1 §3.1 / §7 FL-3): `contractHTML` (Tools.tsx:401-414)
 * собирала HTML договора из `${f.vendor}` / `${f.customer}` / `${f.passport}` /
 * `${f.city}` / `${f.date}` / `${f.amount}` / `${name}` без экранирования;
 * `downloadPdf` (Tools.tsx:436-438) писала этот HTML прямо в `document.write` окна,
 * открытого `window.open('', '_blank')`, — окно `about:blank` наследует происхождение
 * приложения, поэтому скрипт в имени подрядчика выполняется с доступом к
 * `localStorage` пары (`tt_auth`). Имя подрядчика — чужая анкета, проверенная только
 * `minLength 2 / maxLength 120` (`vendor.ts:131`): хранимая (stored) XSS, один тап
 * «PDF» — и владелец аккаунта пары скомпрометирован. `downloadDocx` (Tools.tsx:428-433)
 * несёт тот же неэкранированный HTML в Blob для Word.
 *
 * Адаптировано из `evidence\RL-5\repro\rl5-pages.test.tsx` (тест B1, красный на HEAD
 * e67ffcf — `evidence\RL-5\09-repro-a2.log`). Харнесс — из `audit48.test.tsx`.
 *
 * T1-T3 — обязательные приёмочные тесты TR-1 §7 FL-3 (разметка в имени подрядчика;
 * кавычки в заказчике/паспорте; DOCX). T4-T7 — дополнительные атакующие нагрузки на
 * тот же сток (script-тег, выход из атрибута, `javascript:`-ссылка, HTML-сущности и
 * кириллица) — требование брифа implementer'а сверх минимума TR-1.
 */
import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import App from '@/App'
import { escapeHtml } from '@/lib/utils'

vi.mock('@/lib/api/chats', async (orig) => ({
  ...await orig<object>(),
  openChatSocket: () => () => undefined,
}))

type Routes = Record<string, unknown>
type Call = { method: string; path: string; url: string; body: unknown }

function isStatus(v: unknown): v is { __status: number; body: unknown } {
  return typeof v === 'object' && v !== null && '__status' in v
}
const withStatus = (status: number, code: string, message: string) => ({ __status: status, body: { error: { code, message } } })

function serve(routes: Routes): Call[] {
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
    if (isStatus(reply)) return Promise.resolve(json(reply.body, reply.__status))
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

const signedIn = () => {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  localStorage.setItem('tt_wedding_date', JSON.stringify('2027-06-14'))
  localStorage.setItem('tt_city', JSON.stringify('Уфа'))
}
const WEDDING = { id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа', region: 'Башкортостан' }, tz: 'Asia/Yekaterinburg', members: [{ user: { id: 'u1', name: 'Аня' }, role: 'couple' }] }
const ME = { id: 'u1', name: 'Аня', phone: '+79990000000', isStaff: false, push: { tasks: true, chats: true, deals: true, tips: true }, quietHours: { from: '22:00', to: '09:00' } }

function vendorNamed(name: string) {
  return {
    id: 'v1', name, categoryId: 'photo', city: 'Уфа', verified: false, hasVideo: false,
    priceFrom: { amount: 4_000_000, currency: 'RUB' }, rating: null, reviewsCount: 0,
    packages: [{ id: 'p1', name: 'Полный день', price: { amount: 9_000_000, currency: 'RUB' }, items: [] }],
  }
}
function dealWithVendor(vendor: ReturnType<typeof vendorNamed>) {
  return { id: 'd1', state: 'booked', vendor, externalName: null, externalPhone: null, packageName: 'Полный день', price: { amount: 9_000_000, currency: 'RUB' }, paid: { amount: 0, currency: 'RUB' }, paidAt: null }
}
const base = (over: Routes = {}): Routes => ({
  '/weddings': [{ ...WEDDING, role: 'couple' }],
  '/weddings/w1': WEDDING,
  '/weddings/w1/slots': [{ id: 's-photo', categoryId: 'photo', label: 'Фотограф', deal: dealWithVendor(vendorNamed('Студия «Пион»')), tileState: 'booked' }],
  '/weddings/w1/budget': { total: { amount: 100_000_000, currency: 'RUB' }, spent: { amount: 0, currency: 'RUB' }, reserve: { amount: 10_000_000, currency: 'RUB' }, categories: [] },
  '/weddings/w1/tips': { items: [] },
  '/weddings/w1/tasks': [],
  '/weddings/w1/guests': [],
  '/notifications': [],
  '/me/favorites': [],
  '/users/me': ME,
  '/catalog/categories': [{ id: 'photo', title: 'Фотограф', icon: '📸', vendorsCount: 3 }],
  '/catalog/vendors': { items: [], nextCursor: null },
  '/vendor/profile': withStatus(404, 'not_found', 'Анкета ещё не создана'),
  '/deals/d1/contract': (c: Call) => (c.method === 'POST' ? { id: 'doc1', version: 1, status: 'draft', templateCode: 'photographer' } : withStatus(404, 'not_found', 'нет')),
  ...over,
})

/** Открывает мастер договора и доводит его до экрана «Договор готов» с заданным именем подрядчика и (опционально) полями заказчика/паспорта. */
async function readyContract(vendorName: string, customerName?: string, passport?: string) {
  signedIn()
  serve(base({ '/weddings/w1/slots': [{ id: 's-photo', categoryId: 'photo', label: 'Фотограф', deal: dealWithVendor(vendorNamed(vendorName)), tileState: 'booked' }] }))
  const r = await open('/wedding/documents/new?deal=d1', 'Новый договор')
  fireEvent.click(screen.getByRole('button', { name: /^Далее$/ }))
  await waitFor(() => expect(text(r)).toContain('Заказчик'), { timeout: 4000 })
  if (customerName !== undefined) {
    fireEvent.change(screen.getByPlaceholderText('ФИО заказчика — как в паспорте'), { target: { value: customerName } })
  }
  if (passport !== undefined) {
    fireEvent.change(screen.getByPlaceholderText('Заполните перед подписанием'), { target: { value: passport } })
  }
  fireEvent.click(screen.getByRole('button', { name: /Сгенерировать договор/ }))
  await waitFor(() => expect(text(r)).toContain('Договор готов'), { timeout: 4000 })
}

function stubWindowOpen(): string[] {
  const written: string[] = []
  const fakeWin = { document: { write: (s: string) => { written.push(s) }, close: () => undefined } }
  vi.stubGlobal('open', vi.fn(() => fakeWin))
  return written
}

const readBlob = (b: Blob) => new Promise<string>((res, rej) => {
  const fr = new FileReader()
  fr.onload = () => res(String(fr.result))
  fr.onerror = () => rej(fr.error)
  fr.readAsText(b)
})

describe('FL-3 · договор в PDF/DOCX: чужие и пользовательские строки экранированы (F-RL5-01)', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('T1: имя подрядчика с разметкой не проходит в document.write как код', async () => {
    const written = stubWindowOpen()
    await readyContract('Студия <img src=x onerror="window.__fl3_pwned=1">')
    fireEvent.click(screen.getByRole('button', { name: /PDF/ }))
    expect(written.length).toBe(1)
    const html = written[0]!
    expect(html).not.toContain('<img src=x onerror=')
    expect(html).toContain('&lt;img src=x onerror=')
  })

  it('T2: кавычки в полях заказчика и паспорта экранированы', async () => {
    const written = stubWindowOpen()
    await readyContract('Студия «Пион»', 'Анна "Иванова"', "серия А №123 'копия'")
    fireEvent.click(screen.getByRole('button', { name: /PDF/ }))
    const html = written[0]!
    expect(html).not.toContain('"Иванова"')
    expect(html).toContain('&quot;Иванова&quot;')
    expect(html).not.toContain("'копия'")
    expect(html).toContain('&#39;копия&#39;')
  })

  it('T3: DOCX-файл несёт тот же экранированный HTML, что и PDF', async () => {
    let captured: Blob | null = null
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn((b: Blob) => { captured = b; return 'blob:x' }), configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
    await readyContract('Студия <img src=x onerror="window.__fl3_pwned=1">')
    fireEvent.click(screen.getByRole('button', { name: /DOCX/ }))
    await waitFor(() => expect(captured).not.toBeNull())
    const html = await readBlob(captured!)
    expect(html).not.toContain('<img src=x onerror=')
    expect(html).toContain('&lt;img src=x onerror=')
  })

  it('T4: script-тег в имени подрядчика не проходит как код', async () => {
    const written = stubWindowOpen()
    await readyContract('Студия <script>window.__fl3_script=1</script>')
    fireEvent.click(screen.getByRole('button', { name: /PDF/ }))
    const html = written[0]!
    expect(html).not.toContain('<script>window.__fl3_script=1</script>')
    expect(html).toContain('&lt;script&gt;window.__fl3_script=1&lt;/script&gt;')
  })

  it('T5: кавычка и новый тег в имени подрядчика (типичная нагрузка выхода из атрибута) не собирают код', async () => {
    const written = stubWindowOpen()
    await readyContract('Студия"><svg onload="window.__fl3_svg=1">')
    fireEvent.click(screen.getByRole('button', { name: /PDF/ }))
    const html = written[0]!
    expect(html).not.toContain('"><svg onload="window.__fl3_svg=1">')
    expect(html).toContain('&quot;&gt;&lt;svg onload=&quot;window.__fl3_svg=1&quot;&gt;')
  })

  it('T6: javascript:-ссылка в имени подрядчика остаётся текстом', async () => {
    const written = stubWindowOpen()
    await readyContract('Студия <a href="javascript:window.__fl3_href=1">клик</a>')
    fireEvent.click(screen.getByRole('button', { name: /PDF/ }))
    const html = written[0]!
    expect(html).not.toContain('<a href="javascript:window.__fl3_href=1">')
    expect(html).toContain('&lt;a href=&quot;javascript:window.__fl3_href=1&quot;&gt;')
  })

  it('T7: амперсанд и кавычки становятся сущностями, кириллица не искажается', async () => {
    const written = stubWindowOpen()
    await readyContract('Фото & Видео «Ромашка» "люкс"')
    fireEvent.click(screen.getByRole('button', { name: /PDF/ }))
    const html = written[0]!
    expect(html).toContain('Фото &amp; Видео «Ромашка» &quot;люкс&quot;')
    expect(html).not.toContain(' & ')
    expect(html).not.toContain('"люкс"')
  })
})

describe('escapeHtml (lib/utils) — модульные тесты помощника R-273', () => {
  it('экранирует все пять спецсимволов & < > " \' по отдельности', () => {
    expect(escapeHtml('&')).toBe('&amp;')
    expect(escapeHtml('<')).toBe('&lt;')
    expect(escapeHtml('>')).toBe('&gt;')
    expect(escapeHtml('"')).toBe('&quot;')
    expect(escapeHtml("'")).toBe('&#39;')
  })

  it('порядок замены не задваивает амперсанд у уже экранированных символов', () => {
    expect(escapeHtml('<')).toBe('&lt;')
    expect(escapeHtml('<img src=x onerror="a">')).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;')
  })

  it('кириллица и типографские кавычки-ёлочки проходят без изменений', () => {
    expect(escapeHtml('Студия «Пион», Анна Иванова')).toBe('Студия «Пион», Анна Иванова')
  })

  it('пустая строка остаётся пустой строкой', () => {
    expect(escapeHtml('')).toBe('')
  })

  it('нагрузка F-RL5-01 целиком совпадает с ручным расчётом', () => {
    const payload = 'Студия <img src=x onerror="window.__fl3_pwned=1">'
    expect(escapeHtml(payload)).toBe('Студия &lt;img src=x onerror=&quot;window.__fl3_pwned=1&quot;&gt;')
  })
})
