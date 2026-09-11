// @vitest-environment jsdom
/*
 * Версия справочника категорий (фича 004): сохранение не проходит поверх
 * чужой правки молча.
 *
 * Четыре класса дыр, ради которых написан этот файл:
 *  — сохранение без версии: `PUT` заменяет справочник ЦЕЛИКОМ, и двое
 *    сотрудников, открывшие экран одновременно, затирают правки друг друга —
 *    выигрывает последний сохранивший, и никто об этом не узнаёт;
 *  — отказ без выхода: 409 показан словами, но чинить его нечем — повтор того
 *    же тела получит тот же отказ, а кнопки «Перечитать» на экране нет;
 *  — перечитывание, которое ничего не перечитало: черновик остался прежним,
 *    и следующее сохранение уходит с той же устаревшей версией по кругу;
 *  — версия, застрявшая на первом ответе: после успешного сохранения экран
 *    продолжает править от старого отпечатка, и вторая правка подряд получает
 *    отказ на ровном месте (FR-004).
 *
 * Проверяется тело запроса и текст экрана, а не то, что нарисовал обработчик.
 */
import { render, cleanup, waitFor, fireEvent, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import App from '@/App'

type Routes = Record<string, unknown>
type Call = { method: string; path: string; url: string; body: unknown }

/** Ответ со своим кодом: отказ по версии и прочие честные не-200. */
const withStatus = (status: number, code: string, message: string) =>
  ({ __status: status, body: { error: { code, message } } })

function isStatus(v: unknown): v is { __status: number; body: unknown } {
  return typeof v === 'object' && v !== null && '__status' in v
}

/*
 * Сеть по таблице плюс журнал вызовов (приём из `audit23.test.tsx`): ключ —
 * путь без `/api` и без строки запроса. Незнакомый адрес получает 404 — то,
 * чего экран не запрашивал в этом сценарии, не дорисуется из «удобного» ответа.
 */
function serve(routes: Routes): Call[] {
  const calls: Call[] = []
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const full = String(input).replace(/^\/api/, '')
    const path = full.split('?')[0] ?? ''
    let body: unknown = null
    try { body = init?.body ? JSON.parse(String(init.body)) : null } catch { body = init?.body }
    calls.push({ method: init?.method ?? 'GET', path, url: full, body })
    if (!(path in routes)) return Promise.resolve(json({ error: { code: 'not_found', message: `нет ответа для ${path}` } }, 404))
    const stored = routes[path]
    /* Ответ зависит от метода и от номера запроса: GET и PUT одного пути —
       один ключ таблицы, а второй GET обязан отличаться от первого. */
    const reply = typeof stored === 'function' ? (stored as (c: Call) => unknown)(calls[calls.length - 1]!) : stored
    if (isStatus(reply)) return Promise.resolve(json(reply.body, reply.__status))
    return Promise.resolve(json(reply))
  }))
  return calls
}

async function open(route: string, settled: string) {
  const r = render(<MemoryRouter initialEntries={[route]}><App /></MemoryRouter>)
  await waitFor(() => expect(r.container.querySelector('[data-testid="route-loading"]')).toBeNull(), { timeout: 4000 })
  /* Ждём слово, которым экран отчитывается о завершении запроса: до него
     искать поля рано, там честное «Загружаем…». */
  await waitFor(() => expect(r.container.textContent ?? '').toContain(settled), { timeout: 4000 })
  return r
}

const staff = () => {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
}

/* Отпечатки содержимого: шестнадцать шестнадцатеричных знаков, как в контракте. */
const V1 = '9f2c1ab340de77b5'
const V2 = '4d80e6115ca39207'

/** Справочник в тот момент, когда сотрудник открыл экран. */
const CATEGORIES_V1 = {
  categories: [
    { id: 'photo', title: 'Фотограф', icon: '📷', sort: 1 },
    { id: 'host', title: 'Ведущий', icon: '🎤', sort: 2 },
  ],
  synonyms: { тамада: 'host' },
  version: V1,
}

/** Тот же справочник после чужой правки: другое название и другая версия. */
const CATEGORIES_V2 = {
  categories: [
    { id: 'photo', title: 'Фотостудия', icon: '📷', sort: 1 },
    { id: 'host', title: 'Ведущий', icon: '🎤', sort: 2 },
  ],
  synonyms: { тамада: 'host', ведущий: 'host' },
  version: V2,
}

/** Ответ без версии: проверка версии необязательна, экран обязан работать и так. */
const CATEGORIES_NO_VERSION = { categories: CATEGORIES_V1.categories, synonyms: CATEGORIES_V1.synonyms }

/** Отказ сервера по версии — дословно тот, что отдаёт `backend/src/routes/admin.ts`. */
const STALE = withStatus(409, 'categories_stale', 'Справочник изменили, пока вы его правили — перечитайте и повторите')
const REREAD = 'Перечитать — несохранённые правки заменятся'

/** Заголовок раздела: по нему видно, что ответ сервера дошёл и форма собрана. */
const SETTLED = 'Словарь синонимов'

/** Слова всех предупреждений экрана одной строкой. */
const alerts = () => screen.getAllByRole('alert').map(a => a.textContent ?? '').join(' | ')

/** Нажать «Сохранить» и подтвердить замену словаря в диалоге. */
function confirmSave() {
  fireEvent.click(screen.getByText('Сохранить'))
  fireEvent.click(within(screen.getByRole('dialog')).getByText('Сохранить'))
}

const titles = () => (screen.getAllByLabelText('Название категории') as HTMLInputElement[]).map(i => i.value)
const puts = (calls: Call[]) => calls.filter(c => c.method === 'PUT' && c.path === '/admin/categories')
const gets = (calls: Call[]) => calls.filter(c => c.method === 'GET' && c.path === '/admin/categories')

/* ── US1. Сохранение поверх чужой правки отклоняется ───────────────────── */

describe('справочник категорий: сохранение идёт с версией, с которой начата правка', () => {
  beforeEach(staff)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('тело PUT несёт версию из ответа GET', async () => {
    const calls = serve({
      '/admin/categories': (c: Call) => (c.method === 'PUT' ? { categories: 2, synonyms: 1, version: V2 } : CATEGORIES_V1),
    })
    await open('/admin/categories', SETTLED)
    confirmSave()

    await waitFor(() => expect(puts(calls).length).toBe(1))
    const body = puts(calls)[0]!.body as { version?: string }
    expect(body.version, 'сохранение ушло без версии — чужая правка затрётся молча').toBe(V1)
  })

  it('справочник без версии — сохранение уходит без поля, а не с пустым', async () => {
    /* Проверка версии необязательна (FR-006): сервер, который её не отдал,
       не должен получать `version: ""` и отказывать на ровном месте. */
    const calls = serve({
      '/admin/categories': (c: Call) => (c.method === 'PUT' ? { categories: 2, synonyms: 1 } : CATEGORIES_NO_VERSION),
    })
    await open('/admin/categories', SETTLED)
    confirmSave()

    await waitFor(() => expect(puts(calls).length).toBe(1))
    const body = puts(calls)[0]!.body as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['categories', 'synonyms'])
  })

  it('409 categories_stale: текст сервера, кнопка «Перечитать» и ни одного повторного PUT', async () => {
    const calls = serve({ '/admin/categories': (c: Call) => (c.method === 'PUT' ? STALE : CATEGORIES_V1) })
    await open('/admin/categories', SETTLED)
    confirmSave()

    await waitFor(() => expect(alerts()).toContain('Справочник изменили, пока вы его правили'))
    /* Отказ без выхода — не отказ: повтор того же тела получит тот же 409. */
    expect(screen.getByText(REREAD), 'отказ показан, а починить его нечем').toBeTruthy()
    /* Диалог закрыт: он обещает сохранение, которого не произошло. */
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(puts(calls).length, 'экран повторил сохранение сам').toBe(1)
  })

  it('«Перечитать» спрашивает сервер заново и заменяет черновик его ответом', async () => {
    let served = 0
    const calls = serve({
      '/admin/categories': (c: Call) => {
        if (c.method === 'PUT') return STALE
        served += 1
        return served === 1 ? CATEGORIES_V1 : CATEGORIES_V2
      },
    })
    await open('/admin/categories', SETTLED)

    /* Своя несохранённая правка: после перечитывания её быть не должно. */
    fireEvent.change(screen.getAllByLabelText('Название категории')[0]!, { target: { value: 'Мой фотограф' } })
    expect(titles()).toEqual(['Мой фотограф', 'Ведущий'])

    confirmSave()
    await waitFor(() => expect(screen.queryByText(REREAD)).not.toBeNull())
    expect(gets(calls).length).toBe(1)

    fireEvent.click(screen.getByText(REREAD))
    await waitFor(() => expect(gets(calls).length, 'кнопка ничего не спросила у сервера').toBe(2))
    await waitFor(() => expect(titles()).toEqual(['Фотостудия', 'Ведущий']))
    /* Свежий словарь тоже пришёл на экран, а не только категории. */
    expect(screen.getByDisplayValue('ведущий')).toBeTruthy()
    /* Отказ снят: он относился к прошлому справочнику. */
    expect(screen.queryByText(REREAD)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('после успешного сохранения правка продолжается от новой версии, а не от старой', async () => {
    /* FR-004: экран перечитывает справочник и берёт версию из свежего ответа.
       Останься она прежней — второе сохранение подряд получило бы 409. */
    let served = 0
    const calls = serve({
      '/admin/categories': (c: Call) => {
        if (c.method === 'PUT') return { categories: 2, synonyms: 1, version: V2 }
        served += 1
        return served === 1 ? CATEGORIES_V1 : CATEGORIES_V2
      },
    })
    await open('/admin/categories', SETTLED)
    confirmSave()

    await waitFor(() => expect(gets(calls).length).toBe(2))
    await waitFor(() => expect(titles()).toEqual(['Фотостудия', 'Ведущий']))

    confirmSave()
    await waitFor(() => expect(puts(calls).length).toBe(2))
    const body = puts(calls)[1]!.body as { version?: string }
    expect(body.version, 'вторая правка ушла с версией, которой на сервере уже нет').toBe(V2)
  })
})
