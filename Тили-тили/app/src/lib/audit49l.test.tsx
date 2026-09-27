// @vitest-environment jsdom
/*
 * Ревью 016, лейн FL-11 · F-RL-8-04 + F-RL-8-03 (ERR-0281 / R-281) — findings\TR-1.md §7 «### FL-11»,
 * решено по findings\FL-11-plan.md (G1, PLAN-CONFLICT resolution, GATELOG row 147).
 *
 * Что закрывается:
 *  — мастер анкеты подставлял 0 ₽ вместо `null`, когда сервер вернул пакет
 *    без цены: `packages: (p?.packages ?? []).map(x => ({ ..., price: x.price?.amount ?? 0 }))`
 *    (`VendorApp.tsx:416`) — «Далее» отправлял `PUT /vendor/profile` с ценой,
 *    которую подрядчик никогда не вводил, и каталог показывал пакет как «0 ₽» (T1, T3);
 *  — «Добавить» в форме пакета молчал, если цена пуста или не число:
 *    `if (!pkgName.trim() || !rubles) return` (`VendorApp.tsx:461`) — ни слова,
 *    форма просто оставалась как была (T2a, T2b, T2c).
 *
 * T1 — контрактный факт, а не буквальный `null` на проводе: `VendorUpsert.packages[].price`
 * это `$ref Money`, необязательное поле, но НЕ nullable (`Тили-тили_API_openapi.yaml:4652`;
 * сгенерированный `app/src/lib/api/schema.ts:8199`); серверная схема записи `MONEY_SCHEMA`
 * (`backend/src/routes/vendor.ts:22-30,161`) без `nullable` отклоняет буквальный `null` —
 * 422, проверено исполняемым AJV-пробником той же версии/опций, что использует сервер
 * (`findings\FL-11-plan.md` §2). Поэтому пакет без цены уходит БЕЗ поля `price` вовсе —
 * отсутствие поля сервер хранит как `null` (`vendor.ts:293`): цена остаётся не названной,
 * а не «0 ₽» и не 422. T0 — контроль (нетривиальность harness): пакет с ценой не должен
 * измениться этим лейном ни на HEAD, ни после фикса.
 *
 * Проверяется то, что ушло на сервер (тело `PUT`) и что видно на экране после
 * отказа, а не то, что нарисовал обработчик — приём harness `serve` из
 * audit32/audit34/audit46.
 */
import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { StoreProvider } from './store'
import { VendorProfileWizard } from '@/pages/VendorApp'
import { fmt, rub } from '@/lib/money'

type Routes = Record<string, unknown>
type Call = { method: string; path: string; url: string; body: unknown }

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
    return Promise.resolve(json(reply))
  }))
  return calls
}

const text = (r: { container: HTMLElement }) => r.container.textContent ?? ''
const puts = (calls: Call[], path: string) => calls.filter(c => c.method === 'PUT' && c.path === path)

const signedIn = () => {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
}

const CATEGORIES = [{ id: 'photo', title: 'Фотограф', icon: '📷' }]

const openWizard = () =>
  render(
    <MemoryRouter initialEntries={['/vendor-app/profile']}>
      <StoreProvider>
        <Routes><Route path="/vendor-app/profile" element={<VendorProfileWizard />} /></Routes>
      </StoreProvider>
    </MemoryRouter>,
  )

/** Общая часть анкеты — отличаются только `packages`. */
const baseProfile = (packages: unknown[]) => ({
  id: 'v1', name: 'Фотостудия Свет', categoryId: 'photo', city: 'Уфа',
  about: 'Снимаем свадьбы', phone: '+79990000001', published: false, verified: false,
  mediaRights: true, gallery: [], rating: null, reviewsCount: 0,
  packages,
})

describe('FL-11 · T1: цена пакета из ответа сервера — не подменяется нулём и не улетает как null', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('T0 контроль: пакет с ценой уходит без изменений (нетривиальность harness — зелёный на HEAD и после фикса)', async () => {
    const PROFILE = baseProfile([{ id: 'pkg2', name: 'Базовый', price: { amount: 1_234_500, currency: 'RUB' }, includes: [] }])
    const calls = serve({
      '/vendor/profile': (c: Call) => (c.method === 'PUT' ? { ...PROFILE, ...(c.body as object) } : PROFILE),
      '/catalog/categories': CATEGORIES,
    })
    signedIn()
    const r = openWizard()
    await waitFor(() => expect(text(r)).toContain('Шаг 1 из 5'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Далее'))
    await waitFor(() => expect(text(r)).toContain('Шаг 2 из 5'), { timeout: 4000 })
    const sent = puts(calls, '/vendor/profile').at(-1)!.body as { packages: Array<Record<string, unknown>> }
    // С 019 (FR-006) «как был» — с id и составом: без них сервер заводил пакет заново.
    expect(sent.packages[0], 'пакет с ценой должен уйти как был').toStrictEqual({ id: 'pkg2', name: 'Базовый', price: { amount: 1_234_500, currency: 'RUB' }, includes: [] })
  })

  it('пакет без цены (price: null от сервера) → «Далее» шлёт PUT без поля price у этого пакета, не {amount:0}; пакет с ценой уходит как был', async () => {
    const PROFILE = baseProfile([
      { id: 'pkg1', name: 'Пакет без цены', price: null, includes: [] },
      { id: 'pkg2', name: 'Базовый', price: { amount: 1_234_500, currency: 'RUB' }, includes: ['съёмка'] },
    ])
    const calls = serve({
      '/vendor/profile': (c: Call) => (c.method === 'PUT' ? { ...PROFILE, ...(c.body as object) } : PROFILE),
      '/catalog/categories': CATEGORIES,
    })
    signedIn()
    const r = openWizard()
    await waitFor(() => expect(text(r)).toContain('Шаг 1 из 5'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Далее'))
    await waitFor(() => expect(text(r)).toContain('Шаг 2 из 5'), { timeout: 4000 })
    const sent = puts(calls, '/vendor/profile').at(-1)!.body as { packages: Array<Record<string, unknown>> }
    expect(sent.packages, 'мастер не отправил список пакетов вовсе').toHaveLength(2)
    expect(sent.packages[0], 'пакет без цены должен уйти без поля price — {amount:0} = ERR-0281, null = 422 по контракту').toStrictEqual({ id: 'pkg1', name: 'Пакет без цены', includes: [] })
    expect(sent.packages[1], 'пакет с ценой должен уйти как был').toStrictEqual({ id: 'pkg2', name: 'Базовый', price: { amount: 1_234_500, currency: 'RUB' }, includes: ['съёмка'] })
  })

  it('шаг «Услуги и цены»: пакет без цены показан словами «цена не названа», а не «0 ₽»', async () => {
    const PROFILE = baseProfile([
      { id: 'pkg1', name: 'Пакет без цены', price: null, includes: [] },
      { id: 'pkg2', name: 'Базовый', price: { amount: 1_234_500, currency: 'RUB' }, includes: ['съёмка'] },
    ])
    serve({
      '/vendor/profile': (c: Call) => (c.method === 'PUT' ? { ...PROFILE, ...(c.body as object) } : PROFILE),
      '/catalog/categories': CATEGORIES,
    })
    signedIn()
    const r = openWizard()
    await waitFor(() => expect(text(r)).toContain('Шаг 1 из 5'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Далее'))
    await waitFor(() => expect(text(r)).toContain('Шаг 2 из 5'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Далее'))
    await waitFor(() => expect(text(r)).toContain('Шаг 3 из 5 · Услуги и цены'), { timeout: 4000 })
    expect(text(r)).toContain('Пакет без цены')
    expect(text(r), 'пакет без цены показан как 0 ₽ (ERR-0281)').toContain('цена не названа')
    expect(text(r)).toContain(fmt(1_234_500))
    expect(text(r)).not.toContain('0 ₽')
  })
})

describe('FL-11 · T2: «Добавить» пакет без цены — словами, а не молча', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const PROFILE = {
    id: 'v1', name: 'Фотостудия Свет', categoryId: 'photo', city: 'Уфа',
    about: 'Снимаем свадьбы', phone: '+79990000001', published: false, verified: false,
    mediaRights: true, packages: [], gallery: [], rating: null, reviewsCount: 0,
  }
  const openAtPackagesStep = async () => {
    const calls = serve({
      '/vendor/profile': (c: Call) => (c.method === 'PUT' ? { ...PROFILE, ...(c.body as object) } : PROFILE),
      '/catalog/categories': CATEGORIES,
    })
    signedIn()
    const r = openWizard()
    await waitFor(() => expect(text(r)).toContain('Шаг 1 из 5'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Далее'))
    await waitFor(() => expect(text(r)).toContain('Шаг 2 из 5'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Далее'))
    await waitFor(() => expect(text(r)).toContain('Шаг 3 из 5 · Услуги и цены'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Добавить пакет'))
    await waitFor(() => expect(screen.getByPlaceholderText('Название пакета')).toBeTruthy(), { timeout: 4000 })
    return { r, calls }
  }

  it('название есть, цена пустая → отказ словами «Укажите название и цену пакета…», пакет не добавлен, запроса нет', async () => {
    const { r, calls } = await openAtPackagesStep()
    const before = calls.length
    fireEvent.change(screen.getByPlaceholderText('Название пакета'), { target: { value: 'Свадебный день' } })
    fireEvent.click(screen.getByText('Добавить'))
    await waitFor(
      () => expect(text(r), 'молчаливый отказ — нет слов об ошибке (F-RL-8-03)').toContain('Укажите название и цену пакета — целое число рублей больше нуля'),
      { timeout: 4000 },
    )
    expect(calls.length, '«Добавить» с пустой ценой не должен ходить в сеть').toBe(before)
    expect(screen.queryByText('Свадебный день'), 'пакет добавился без цены').toBeNull()
    expect((screen.getByPlaceholderText('Название пакета') as HTMLInputElement).value, 'поле стёрлось при отказе — должно остаться').toBe('Свадебный день')
  })

  it('название есть, цена «0» → тот же словесный отказ (ноль — тоже не цена)', async () => {
    const { r, calls } = await openAtPackagesStep()
    const before = calls.length
    fireEvent.change(screen.getByPlaceholderText('Название пакета'), { target: { value: 'Свадебный день' } })
    fireEvent.change(screen.getByPlaceholderText('Цена, ₽'), { target: { value: '0' } })
    fireEvent.click(screen.getByText('Добавить'))
    await waitFor(
      () => expect(text(r)).toContain('Укажите название и цену пакета — целое число рублей больше нуля'),
      { timeout: 4000 },
    )
    expect(calls.length).toBe(before)
    expect(screen.queryByText('Свадебный день')).toBeNull()
  })

  it('после словесного отказа — валидная цена добавляет пакет: сообщение исчезает, форма закрывается, запроса всё ещё нет', async () => {
    const { r, calls } = await openAtPackagesStep()
    const before = calls.length
    fireEvent.change(screen.getByPlaceholderText('Название пакета'), { target: { value: 'Свадебный день' } })
    fireEvent.click(screen.getByText('Добавить'))
    await waitFor(
      () => expect(text(r)).toContain('Укажите название и цену пакета — целое число рублей больше нуля'),
      { timeout: 4000 },
    )
    const price = screen.getByPlaceholderText('Цена, ₽')
    fireEvent.change(price, { target: { value: '15 000' } })
    fireEvent.click(screen.getByText('Добавить'))
    await waitFor(() => expect(text(r)).toContain(fmt(rub(15000))), { timeout: 4000 })
    expect(text(r)).toContain('Свадебный день')
    expect(text(r), 'сообщение об отказе должно исчезнуть после успешного добавления').not.toContain('Укажите название и цену пакета')
    expect(screen.queryByPlaceholderText('Название пакета'), 'форма пакета должна закрыться после добавления').toBeNull()
    expect(calls.length, 'добавление пакета — локальное состояние, запрос уходит только по «Далее»').toBe(before)
  })
})

/*
 * 019, FR-006 (ERR-0318): мастер отправлял пакеты без id и без состава. Сервер заменял список
 * целиком — каждое «Далее» заводило пакеты заново, брони теряли пакет, состав стирался. Теперь
 * черновик держит id и состав, переносит id новых пакетов из ответа `PUT`, пакет правится на месте.
 */
describe('019 · FR-006: мастер держит id и состав пакетов', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  type SentPackage = { id?: string; name: string; price?: { amount: number; currency: string }; includes?: string[] }
  /** Как сервер: пакет без id получает новый id на своём месте списка, ответ — в присланном порядке. */
  const serveProfile = (packages: unknown[]) => {
    let put = 0
    const profile = baseProfile(packages)
    return serve({
      '/vendor/profile': (c: Call) => {
        if (c.method !== 'PUT') return profile
        put += 1
        const body = c.body as { packages?: SentPackage[] }
        return {
          ...profile,
          ...body,
          packages: (body.packages ?? []).map((pkg, i) => ({
            id: pkg.id ?? `srv-${put}-${i}`, name: pkg.name, price: pkg.price ?? null, includes: pkg.includes ?? [],
          })),
        }
      },
      '/catalog/categories': CATEGORIES,
    })
  }
  const toPackagesStep = async (r: ReturnType<typeof openWizard>) => {
    await waitFor(() => expect(text(r)).toContain('Шаг 1 из 5'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Далее'))
    await waitFor(() => expect(text(r)).toContain('Шаг 2 из 5'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Далее'))
    await waitFor(() => expect(text(r)).toContain('Шаг 3 из 5 · Услуги и цены'), { timeout: 4000 })
  }
  const next = async (r: ReturnType<typeof openWizard>, step: string) => {
    fireEvent.click(screen.getByText('Далее'))
    await waitFor(() => expect(text(r)).toContain(step), { timeout: 4000 })
  }
  const lastPackages = (calls: Call[]) => (puts(calls, '/vendor/profile').at(-1)!.body as { packages: SentPackage[] }).packages

  it('новый пакет с составом: первый «Далее» — без id, следующий — с id из ответа, сервер не заводит его заново', async () => {
    const calls = serveProfile([])
    signedIn()
    const r = openWizard()
    await toPackagesStep(r)
    fireEvent.click(screen.getByText('Добавить пакет'))
    fireEvent.change(screen.getByPlaceholderText('Название пакета'), { target: { value: 'Свадебный день' } })
    fireEvent.change(screen.getByPlaceholderText('Цена, ₽'), { target: { value: '15 000' } })
    fireEvent.change(screen.getByLabelText('Что входит'), { target: { value: '8 часов съёмки\n\n 300 фото в обработке ' } })
    fireEvent.click(screen.getByText('Добавить'))
    await waitFor(() => expect(text(r)).toContain('8 часов съёмки · 300 фото в обработке'), { timeout: 4000 })

    await next(r, 'Шаг 4 из 5')
    expect(lastPackages(calls)).toStrictEqual([
      { name: 'Свадебный день', price: { amount: rub(15000), currency: 'RUB' }, includes: ['8 часов съёмки', '300 фото в обработке'] },
    ])
    const created = puts(calls, '/vendor/profile').length
    await next(r, 'Шаг 5 из 5')
    // До исправления второй шаг снова слал пакет без id: сервер удалял только что созданный и заводил новый.
    expect(lastPackages(calls), 'второй шаг должен прислать id пакета, созданного на первом').toStrictEqual([
      { id: `srv-${created}-0`, name: 'Свадебный день', price: { amount: rub(15000), currency: 'RUB' }, includes: ['8 часов съёмки', '300 фото в обработке'] },
    ])
  })

  it('«Изменить» правит пакет на месте: новое имя, цена и состав уходят с тем же id', async () => {
    const calls = serveProfile([
      { id: 'pkg1', name: 'Мини', price: { amount: rub(9000), currency: 'RUB' }, includes: ['2 часа'] },
      { id: 'pkg2', name: 'Базовый', price: { amount: rub(15000), currency: 'RUB' }, includes: ['съёмка'] },
    ])
    signedIn()
    const r = openWizard()
    await toPackagesStep(r)
    fireEvent.click(screen.getByLabelText('Изменить пакет Базовый'))
    expect((screen.getByPlaceholderText('Название пакета') as HTMLInputElement).value).toBe('Базовый')
    expect((screen.getByPlaceholderText('Цена, ₽') as HTMLInputElement).value).toBe('15000')
    expect((screen.getByLabelText('Что входит') as HTMLTextAreaElement).value).toBe('съёмка')
    fireEvent.change(screen.getByPlaceholderText('Название пакета'), { target: { value: 'Базовый плюс' } })
    fireEvent.change(screen.getByPlaceholderText('Цена, ₽'), { target: { value: '18000' } })
    fireEvent.change(screen.getByLabelText('Что входит'), { target: { value: 'съёмка\nвидео' } })
    fireEvent.click(screen.getByText('Сохранить'))
    await waitFor(() => expect(text(r)).toContain('Базовый плюс'), { timeout: 4000 })

    await next(r, 'Шаг 4 из 5')
    expect(lastPackages(calls)).toStrictEqual([
      { id: 'pkg1', name: 'Мини', price: { amount: rub(9000), currency: 'RUB' }, includes: ['2 часа'] },
      { id: 'pkg2', name: 'Базовый плюс', price: { amount: rub(18000), currency: 'RUB' }, includes: ['съёмка', 'видео'] },
    ])
  })

  it('пакет без цены: правка состава не заставляет выдумывать цену — цена остаётся не названной', async () => {
    const calls = serveProfile([{ id: 'pkg1', name: 'По запросу', price: null, includes: [] }])
    signedIn()
    const r = openWizard()
    await toPackagesStep(r)
    fireEvent.click(screen.getByLabelText('Изменить пакет По запросу'))
    expect((screen.getByPlaceholderText('Цена, ₽') as HTMLInputElement).value).toBe('')
    fireEvent.change(screen.getByLabelText('Что входит'), { target: { value: 'выездная церемония' } })
    fireEvent.click(screen.getByText('Сохранить'))
    await waitFor(() => expect(text(r)).toContain('выездная церемония'), { timeout: 4000 })
    expect(text(r)).not.toContain('Укажите название и цену пакета')
    expect(text(r)).toContain('цена не названа')

    await next(r, 'Шаг 4 из 5')
    expect(lastPackages(calls)).toStrictEqual([{ id: 'pkg1', name: 'По запросу', includes: ['выездная церемония'] }])
  })

  it('копейки пакета, заведённого вне мастера, переживают правку состава — поле цены не трогали', async () => {
    const calls = serveProfile([{ id: 'pkg1', name: 'Фуршет', price: { amount: 1_234_550, currency: 'RUB' }, includes: [] }])
    signedIn()
    const r = openWizard()
    await toPackagesStep(r)
    fireEvent.click(screen.getByLabelText('Изменить пакет Фуршет'))
    expect((screen.getByPlaceholderText('Цена, ₽') as HTMLInputElement).value).toBe('12345,50')
    fireEvent.change(screen.getByLabelText('Что входит'), { target: { value: 'канапе' } })
    fireEvent.click(screen.getByText('Сохранить'))
    await waitFor(() => expect(text(r)).toContain('канапе'), { timeout: 4000 })
    expect(text(r)).not.toContain('Укажите название и цену пакета')

    await next(r, 'Шаг 4 из 5')
    expect(lastPackages(calls)).toStrictEqual([{ id: 'pkg1', name: 'Фуршет', price: { amount: 1_234_550, currency: 'RUB' }, includes: ['канапе'] }])
  })

  it('цена «1500,50» — отказ словами, а не пакет за 150 050 ₽', async () => {
    const calls = serveProfile([])
    signedIn()
    const r = openWizard()
    await toPackagesStep(r)
    const before = calls.length
    fireEvent.click(screen.getByText('Добавить пакет'))
    fireEvent.change(screen.getByPlaceholderText('Название пакета'), { target: { value: 'Свадебный день' } })
    fireEvent.change(screen.getByPlaceholderText('Цена, ₽'), { target: { value: '1500,50' } })
    fireEvent.click(screen.getByText('Добавить'))
    await waitFor(() => expect(text(r)).toContain('Укажите название и цену пакета — целое число рублей больше нуля'), { timeout: 4000 })
    expect(text(r), 'вырезание нецифр сделало из 1500,50 сумму в сто раз больше').not.toContain(fmt(rub(150050)))
    expect(calls.length).toBe(before)
  })

  it('состав длиннее 40 пунктов — отказ словами, пакет не добавлен', async () => {
    serveProfile([])
    signedIn()
    const r = openWizard()
    await toPackagesStep(r)
    fireEvent.click(screen.getByText('Добавить пакет'))
    fireEvent.change(screen.getByPlaceholderText('Название пакета'), { target: { value: 'Всё включено' } })
    fireEvent.change(screen.getByPlaceholderText('Цена, ₽'), { target: { value: '50000' } })
    fireEvent.change(screen.getByLabelText('Что входит'), { target: { value: Array.from({ length: 41 }, (_, i) => `пункт ${i + 1}`).join('\n') } })
    fireEvent.click(screen.getByText('Добавить'))
    await waitFor(() => expect(text(r)).toContain('В составе пакета — до 40 пунктов, каждый до 200 знаков'), { timeout: 4000 })
    expect(screen.getByPlaceholderText('Название пакета')).toBeTruthy()
  })
})
