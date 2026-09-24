// @vitest-environment jsdom
/*
 * R-257, вторая половина прохода: шесть последних констант под `key()`.
 *
 * `contractTemplates`, `dressPalettes`, `inviteThemes`, `STORIES` (Discover),
 * `planBRisks` (Smart), `CONTRACT_TITLE` (Wedding). Форма та же, что у
 * audit50d: экран рисуется по-английски, и спрашиваются обе половины —
 * русского ключа нет И перевод виден. Одной первой мало: пустой экран её
 * проходит.
 *
 * Два места показа — не экран, а файл: заголовок договора в PDF и DOCX.
 * Словарный сторож их не видит так же, как и экранные, поэтому они здесь же.
 *
 * Харнесс — всё приложение под MemoryRouter, как в audit49c: мастер договора
 * доходит до «Договор готов» только через настоящие маршруты и сделку.
 * Фикстуры латиницей — кириллица в них смешалась бы с проверяемыми ключами.
 */
import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import App from '@/App'
import { setI18nLang } from '@/lib/i18n'

vi.mock('@/lib/api/chats', async (orig) => ({
  ...await orig<object>(),
  openChatSocket: () => () => undefined,
}))

type Call = { method: string }
type Routes = Record<string, unknown>

function serve(routes: Routes) {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = decodeURIComponent(String(input).replace(/^\/api/, '').split('?')[0] ?? '')
    if (!(path in routes)) return Promise.resolve(json({ error: { code: 'not_found', message: `no reply for ${path}` } }, 404))
    const stored = routes[path]
    return Promise.resolve(json(typeof stored === 'function' ? (stored as (c: Call) => unknown)({ method: init?.method ?? 'GET' }) : stored))
  }))
}

const WEDDING = { id: 'w1', title: 'A ♥ B', date: '2027-06-14', city: { name: 'Ufa' }, tz: 'Asia/Yekaterinburg', members: [{ user: { id: 'u1', name: 'Ann' }, role: 'couple' }] }
const ME = { id: 'u1', name: 'Ann', phone: '+79990000000', isStaff: false, push: {}, quietHours: null }
const VENDOR = {
  id: 'v1', name: 'Studio Peony', categoryId: 'photo', city: 'Ufa', verified: false, hasVideo: false,
  priceFrom: { amount: 4_000_000, currency: 'RUB' }, rating: null, reviewsCount: 0, packages: [],
}
const DEAL = { id: 'd1', state: 'booked', vendor: VENDOR, externalName: null, externalPhone: null, packageName: 'Full day', price: { amount: 9_000_000, currency: 'RUB' }, paid: { amount: 0, currency: 'RUB' }, paidAt: null }

const ROUTES: Routes = {
  '/weddings': [{ ...WEDDING, role: 'couple' }],
  '/weddings/w1': WEDDING,
  '/weddings/w1/slots': [{ id: 's-photo', categoryId: 'photo', label: 'Фотограф', deal: DEAL, tileState: 'booked' }],
  '/weddings/w1/budget': { total: { amount: 100_000_000, currency: 'RUB' }, spent: { amount: 0, currency: 'RUB' }, reserve: { amount: 10_000_000, currency: 'RUB' }, categories: [] },
  '/weddings/w1/tips': { items: [] },
  '/weddings/w1/tasks': [],
  '/weddings/w1/guests': [],
  '/weddings/w1/planb': { checklist: [], activatedAt: null },
  /* Три черновика: два кода сервера из CONTRACT_TITLE и один без кода —
     у него своя ветка, `key('Договор')`. */
  '/weddings/w1/documents': [
    { id: 'doc1', templateCode: 'photographer', status: 'draft', version: 1 },
    { id: 'doc2', templateCode: 'venue', status: 'draft', version: 1 },
    { id: 'doc3', templateCode: null, status: 'draft', version: 1 },
  ],
  '/inspiration/likes': { storyIds: [] },
  '/notifications': [],
  '/me/favorites': [],
  '/users/me': ME,
  '/catalog/categories': [{ id: 'photo', title: 'Photographer', icon: '📸', vendorsCount: 3 }],
  '/catalog/vendors': { items: [], nextCursor: null },
  '/deals/d1/contract': (c: Call) => (c.method === 'POST' ? { id: 'doc1', version: 1, status: 'draft', templateCode: 'photographer' } : null),
}

const text = () => document.body.textContent ?? ''

/** Язык — в хранилище: `StoreProvider` при монтировании читает `tt_lang` и перебивает модульный. */
async function openEn(route: string, settled: string) {
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  localStorage.setItem('tt_wedding_date', JSON.stringify('2027-06-14'))
  localStorage.setItem('tt_lang', 'en')
  setI18nLang('en')
  serve(ROUTES)
  const r = render(<MemoryRouter initialEntries={[route]}><App /></MemoryRouter>)
  await waitFor(() => expect(r.container.querySelector('[data-testid="route-loading"]')).toBeNull(), { timeout: 4000 })
  await waitFor(() => expect(text()).toContain(settled), { timeout: 4000 })
  return r
}

/** Обе половины сразу: ключей нет, переводы есть. */
function expectTranslated(seen: string, keys: string[], english: string[]) {
  for (const ru of keys) {
    expect(seen, 'в EN остался русский ключ «' + ru + '»').not.toContain(ru)
  }
  for (const en of english) {
    expect(seen, 'перевода «' + en + '» нет — место показа могло просто ничего не нарисовать').toContain(en)
  }
}

const readBlob = (b: Blob) => new Promise<string>((res, rej) => {
  const fr = new FileReader()
  fr.onload = () => res(String(fr.result))
  fr.onerror = () => rej(fr.error)
  fr.readAsText(b)
})

const ownUrl = {
  create: Object.getOwnPropertyDescriptor(URL, 'createObjectURL'),
  revoke: Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL'),
}
function restoreUrl() {
  for (const [name, d] of [['createObjectURL', ownUrl.create], ['revokeObjectURL', ownUrl.revoke]] as const) {
    if (d) Object.defineProperty(URL, name, d)
    else Reflect.deleteProperty(URL, name)
  }
}

describe('R-257: английский интерфейс без русских ключей — шесть последних констант', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    restoreUrl()
    localStorage.clear()
    setI18nLang('ru')
  })

  it('Вдохновение (STORIES): карточки и разбор бюджета переведены', async () => {
    await openEn('/inspiration', 'Inspiration')
    const keys = ['Дина и Руслан', 'Шатёр у реки · Стерлитамак', 'Август 2025', 'Бохо', 'Рустик',
      'Сэкономили на площадке — вложились в декор и живую музыку']
    expectTranslated(text(), keys,
      ['Dina and Ruslan', 'Riverside tent · Sterlitamak', 'August 2025', '🌾 Boho',
        'Saved on the venue — invested in decor and live music'])

    /* Разбор бюджета — отдельный лист со своими местами показа: пара, место,
       сезон, стиль, доли и совет рисуются там заново. */
    fireEvent.click(screen.getAllByRole('button', { name: /Budget breakdown/ })[0]!)
    await waitFor(() => expect(text()).toContain('Where the budget went'), { timeout: 4000 })
    expectTranslated(text(), [...keys, 'Площадка и кейтеринг', 'Декор и флористика'],
      ['Venue and catering', 'Decor and floristry'])
  })

  it('План Б (planBRisks): сценарии и развёрнутое решение переведены', async () => {
    await openEn('/wedding/planb', 'Plan B')
    expectTranslated(text(),
      ['Подрядчик не приехал или отменил в последний день', 'Дождь или непогода на выездной церемонии', 'Забыли кольца или паспорта'],
      ['A vendor didn’t show up or cancelled at the last minute', 'Rain or bad weather at the outdoor ceremony', 'Rings or passports forgotten'])

    fireEvent.click(screen.getByRole('button', { name: /A vendor didn’t show up/ }))
    await waitFor(() => expect(text()).toContain('"Hot swap": the catalogue shows only those free on your date.'), { timeout: 4000 })
    expect(text()).not.toContain('Горячая замена')
  })

  it('Мастер договора (contractTemplates): шаблоны, «Договор готов», заголовок PDF и DOCX переведены', async () => {
    const written: string[] = []
    vi.stubGlobal('open', vi.fn(() => ({ document: { write: (s: string) => { written.push(s) }, close: () => undefined } })))
    let blob: Blob | null = null
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn((b: Blob) => { blob = b; return 'blob:x' }), configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })

    await openEn('/wedding/documents/new?deal=d1', 'New contract')
    expectTranslated(text(),
      ['Договор с фотографом', 'Услуги фотосъёмки, сроки отдачи, права на фото', 'Универсальный договор услуг'],
      ['Contract with the photographer', 'Photography services, delivery terms, photo rights', 'Universal service contract'])

    fireEvent.click(screen.getByRole('button', { name: /^Next$/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Generate contract/ }))
    await waitFor(() => expect(text()).toContain('Contract ready'), { timeout: 4000 })
    expectTranslated(text(), ['Договор с фотографом'], ['«Contract with the photographer»'])

    fireEvent.click(screen.getByRole('button', { name: /PDF/ }))
    expect(written).toHaveLength(1)
    expectTranslated(written[0]!, ['Договор с фотографом'],
      ['<title>Contract with the photographer</title>', '<h1>Contract with the photographer</h1>'])

    fireEvent.click(screen.getByRole('button', { name: /DOCX/ }))
    await waitFor(() => expect(blob).not.toBeNull())
    expectTranslated(await readBlob(blob!), ['Договор с фотографом'], ['<h1>Contract with the photographer</h1>'])
  })

  it('Документы (CONTRACT_TITLE и contractTemplates): черновики и шаблоны переведены', async () => {
    await openEn('/wedding/documents', 'Contract drafts')
    /* Названия шаблонов стоят на экране дважды — в черновиках и в списке
       шаблонов, поэтому черновики сверяются построчно, отдельно от списка. */
    const drafts = screen.getByText('Contract drafts').parentElement!
    expect(Array.from(drafts.querySelectorAll('b'), b => b.textContent)).toEqual(
      ['Contract with the photographer', 'Venue rent', 'Contract'])
    expectTranslated(text(),
      ['Договор с фотографом', 'Аренда площадки', 'Договор с ведущим', 'Услуги фотосъёмки, сроки отдачи, права на фото'],
      ['Contract with the host', 'Photography services, delivery terms, photo rights'])
  })

  it('Приглашения (inviteThemes и dressPalettes): сценарии и палитры переведены', async () => {
    await openEn('/wedding/invites', 'Invitation design')
    expectTranslated(text(),
      ['Театро', 'Бархатный занавес и премьера вашей истории', 'Шалфей', 'Маджестик',
        'Пудровая классика', 'Лавандовый вечер', 'Медовый закат'],
      ['«Teatro»', 'Velvet curtain and the premiere of your story', '«Sage»',
        'Powdery classics', 'Sage and cream', 'Lavender evening'])
  })
})
