// @vitest-environment jsdom
/*
 * Аудит, блок 4: четыре состояния экрана при ЧАСТИЧНОМ отказе сервера.
 *
 * `nomocks.test.tsx` выключает сеть целиком. Но экран читает несколько путей,
 * и отказ одного из них раньше маскировался ответом другого: анкета подрядчика
 * пришла — а «0 новых заявок», «пока ни одного» отзыва и календарь без единого
 * занятого дня дорисовывались от пустого массива. Пара видела «0 подтвердили»,
 * подрядчик — «дата свободна» по календарю, которого сервер не отдал.
 *
 * Здесь сеть отвечает по одним адресам и падает по другим, и экран обязан
 * различать «пусто» и «не пришло» на каждом запросе отдельно (R-178, R-180).
 * Каждый набор краснел на коде до исправления.
 */
import { render, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import App from '@/App'

type Reply = unknown
type Routes = Record<string, Reply>

/* Сеть падает на этом адресе: `TypeError` — то, что бросает настоящий fetch. */
const DOWN = Symbol('down')

/*
 * Сеть по таблице: ключ — путь без `/api` и без строки запроса, значение —
 * тело ответа 200 либо DOWN. Незнакомый адрес получает 404: то, чего экран
 * не запрашивал в этом сценарии, не должно дорисоваться из «удобного» ответа.
 */
function serve(routes: Routes) {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const path = String(input).replace(/^\/api/, '').split('?')[0] ?? ''
    if (!(path in routes)) return Promise.resolve(json({ error: { code: 'not_found', message: `нет ответа для ${path}` } }, 404))
    const reply = routes[path]
    if (reply === DOWN) return Promise.reject(new TypeError('Failed to fetch'))
    return Promise.resolve(json(reply))
  }))
}

/** Слово, которым экран называет упавшую сеть. */
const SERVER_DOWN = 'Сервер недоступен'

const WEDDING = { id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа' }, tz: 'Asia/Yekaterinburg' }

/* Пара с одной свадьбой: всё, что читают главная и разделы свадьбы, отвечает. */
const COUPLE_OK: Routes = {
  '/weddings': [{ ...WEDDING, role: 'couple' }],
  '/weddings/w1': WEDDING,
  '/weddings/w1/slots': [],
  '/weddings/w1/budget': { total: { amount: 10_000_000, currency: 'RUB' }, spent: { amount: 0, currency: 'RUB' }, items: [] },
  '/weddings/w1/tasks': [{ id: 't1', title: 'Выбрать площадку', done: false, period: '9' }],
  '/weddings/w1/guests': [{ id: 'g1', name: 'Гость Первый', status: 'yes', plusOne: false }],
  '/weddings/w1/timeline': [],
  '/weddings/w1/planb': { checklist: [], activatedAt: null },
  '/notifications': [],
  '/me/favorites': [],
  '/users/me': { id: 'u1', name: 'Аня', phone: '+79990000000', push: {}, quietHours: null },
  '/users/me/sessions': [],
}

async function open(route: string, settled: string) {
  const r = render(<MemoryRouter initialEntries={[route]}><App /></MemoryRouter>)
  await waitFor(() => expect(r.container.querySelector('[data-testid="route-loading"]')).toBeNull(), { timeout: 4000 })
  /* Ждём слово, которым экран отчитывается о завершении именно упавшего
     запроса: до него искать нули рано, там честное «Загружаем…». */
  await waitFor(() => expect(r.container.textContent ?? '').toContain(settled), { timeout: 4000 })
  return r.container.textContent ?? ''
}

describe('частичный отказ сервера: экран различает «пусто» и «не пришло»', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
    localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
    localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
    localStorage.setItem('tt_wedding_date', JSON.stringify('2027-06-14'))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('главная: гости не пришли — ни «0 подтвердили», ни совета «добавьте гостей»', async () => {
    serve({ ...COUPLE_OK, '/weddings/w1/guests': DOWN })
    const text = await open('/home', 'Ответы гостей не загрузились')
    expect(text).not.toContain('подтвердили')
    expect(text).not.toContain('ждут ответа')
    expect(text).not.toContain('Добавьте гостей')
  })

  it('главная: гости пришли — числа на месте (контроль, что их не спрятали навсегда)', async () => {
    serve(COUPLE_OK)
    const text = await open('/home', 'подтвердили')
    expect(text).toContain('1 подтвердили')
    expect(text).toContain('0 ждут ответа')
  })

  it('чек-лист: задачи не пришли — нет ни «Всё сделано», ни «0 из 0»', async () => {
    serve({ ...COUPLE_OK, '/weddings/w1/tasks': DOWN })
    const text = await open('/wedding/checklist', SERVER_DOWN)
    expect(text).not.toContain('Всё сделано')
    expect(text).not.toContain('0 из 0')
    expect(text).not.toContain('Чек-лист пуст')
  })

  it('чек-лист: пустой список — это «0 из 0» и «пуст», а не молчание (контроль)', async () => {
    serve({ ...COUPLE_OK, '/weddings/w1/tasks': [] })
    const text = await open('/wedding/checklist', 'Чек-лист пуст')
    expect(text).toContain('0 из 0')
  })

  it('гости: список не пришёл — прочерки вместо «0 придут» и никакого «Список пуст»', async () => {
    serve({ ...COUPLE_OK, '/weddings/w1/guests': DOWN })
    const text = await open('/wedding/guests', SERVER_DOWN)
    expect(text).not.toContain('Список пуст')
    expect(text).not.toContain('0 персон')
    expect(text).toContain('—')
  })

  it('кейтеринг: опрос не пришёл — не «Опрос ещё не составлен» и не «0 из 0 ответили»', async () => {
    serve({ ...COUPLE_OK, '/weddings/w1/menu-poll': DOWN })
    const text = await open('/wedding/catering', SERVER_DOWN)
    expect(text).not.toContain('Опрос ещё не составлен')
    expect(text).not.toContain('0 из 1 ответили')
    expect(text).not.toContain('0 из 0')
  })

  it('рассадка: столы не пришли — не «Столов пока нет»', async () => {
    serve({ ...COUPLE_OK, '/weddings/w1/tables': DOWN })
    const text = await open('/wedding/seating', SERVER_DOWN)
    expect(text).not.toContain('Столов пока нет')
  })

  it('план Б: не пришёл — не «0%» готовности', async () => {
    serve({ ...COUPLE_OK, '/weddings/w1/planb': DOWN })
    const text = await open('/wedding/planb', SERVER_DOWN)
    expect(text).not.toContain('0%')
  })

  it('день X: тайминг не пришёл — не «Тайминг пуст»', async () => {
    serve({ ...COUPLE_OK, '/weddings/w1/timeline': DOWN })
    const text = await open('/dayx', 'Тайминг не загрузился')
    expect(text).not.toContain('Тайминг пуст')
  })

  it('команда: сервер лежит — не «Активных ссылок нет» и не «0 действуют»', async () => {
    serve({ ...COUPLE_OK, '/weddings/w1/members': DOWN, '/weddings/w1/invites': DOWN })
    const text = await open('/us/team', SERVER_DOWN)
    expect(text).not.toContain('Активных ссылок нет')
    expect(text).not.toContain('0 действуют')
    expect(text).not.toContain('Пока только вы')
  })

  it('настройки: профиль не пришёл — ни «Имя не указано», ни тихих часов по умолчанию', async () => {
    serve({ ...COUPLE_OK, '/users/me': DOWN })
    const text = await open('/settings', 'Настройки не загрузились')
    expect(text).not.toContain('Имя не указано')
    expect(text).not.toContain('22:00')
    expect(text).not.toContain('Тихих часов нет')
  })

  it('заметки: первое открытие пустое, а не с чужими «пионами» и «Perfect»', async () => {
    // Заметки — с сервера (фича 014): пустой ответ — «пока нет», без ответа было бы «не пришло».
    serve({ ...COUPLE_OK, '/weddings/w1/notes': [] })
    const text = await open('/notes', 'Заметок пока нет')
    expect(text).not.toContain('пионы')
    expect(text).not.toContain('Perfect')
  })
})

const VENDOR = {
  id: 'v1', name: 'Фотостудия Свет', categoryId: 'photo', city: 'Уфа', verified: false, hasVideo: true,
  gallery: [], packages: [{ name: 'Базовый', price: { amount: 5_000_000, currency: 'RUB' }, includes: [] }],
  rating: null, reviewsCount: 0, about: 'Снимаем свадьбы',
}

const CATALOG_OK: Routes = {
  ...COUPLE_OK,
  '/vendors/v1/booking-policy': { mode: 'legacy_day', revision: '0' },
  '/catalog/vendors/v1': VENDOR,
  '/catalog/vendors/v1/availability': { busyDates: [] },
  '/catalog/vendors/v1/reviews': { items: [] },
  '/catalog/vendors': { items: [] },
  '/catalog/categories': [{ id: 'photo', title: 'Фотограф', icon: '📷' }],
}

describe('анкета подрядчика: галочка и календарь только по ответу сервера', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
    localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
    localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
    localStorage.setItem('tt_wedding_date', JSON.stringify('2027-06-14'))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('занятость не пришла — нет «Свободен на вашу дату»; непроверенный — без «верифицирован»', async () => {
    serve({ ...CATALOG_OK, '/catalog/vendors/v1/availability': DOWN })
    const text = await open('/vendor/v1', 'Занятость не загрузилась')
    expect(text).not.toContain('Свободен на вашу дату')
    expect(text).not.toContain('Ваша дата свободна')
    expect(text).not.toContain('Проверен «Тили-тили»')
    expect(text).not.toContain('верифицирован')
    /* Декоративные константы: у анкеты без единого файла стояли «5 фото ·
       видео до 3 минут» и длительность ролика «1:40». */
    expect(text).not.toContain('1:40')
    expect(text).not.toContain('5 фото')
  })

  it('проверенный подрядчик и свободная дата — карточка и значок есть (контроль)', async () => {
    serve({ ...CATALOG_OK, '/catalog/vendors/v1': { ...VENDOR, verified: true } })
    const text = await open('/vendor/v1', 'Ваша дата свободна')
    expect(text).toContain('Проверен «Тили-тили»')
    expect(text).toContain('Свободен на вашу дату')
  })

  it('дата в занятых — «занята», значка нет (контроль)', async () => {
    serve({ ...CATALOG_OK, '/catalog/vendors/v1/availability': { busyDates: ['2027-06-14'] } })
    const text = await open('/vendor/v1', 'Ваша дата занята')
    expect(text).not.toContain('Свободен на вашу дату')
  })
})

const PROFILE = {
  id: 'v1', name: 'Фотостудия Свет', city: 'Уфа', categoryId: 'photo', about: 'Снимаем свадьбы', phone: '+79990000001',
  published: true, verified: false, packages: [], gallery: [],
}

describe('кабинет подрядчика: анкета пришла, остальное — нет', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
    localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('заявки, отзывы и календарь не пришли — прочерки, а не нули и «пока ни одного»', async () => {
    serve({
      '/vendor/profile': PROFILE, '/vendor/updates': [],
      '/vendor/leads': DOWN, '/vendor/reviews': DOWN, '/vendor/calendar': DOWN,
      '/weddings': [], '/me/favorites': [], '/notifications': [],
    })
    const text = await open('/vendor-app', 'Отзывы не загрузились')
    expect(text).toContain('—новых заявок')
    expect(text).toContain('—занятых дней')
    expect(text).not.toContain('0новых заявок')
    expect(text).not.toContain('0занятых дней')
    expect(text).not.toContain('пока ни одного')
  })

  it('верификация: анкета не пришла — не предлагаем «пройти верификацию»', async () => {
    serve({ '/vendor/profile': DOWN, '/weddings': [], '/me/favorites': [], '/notifications': [] })
    const text = await open('/vendor-app/verification', SERVER_DOWN)
    expect(text).not.toContain('Загрузка документов пока не подключена')
    expect(text).not.toContain('Кто вы')
  })
})

describe('приглашение гостя: упавший блок виден, а не исчезает', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_guest_token', 'tok1')
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('трансфер не пришёл — гость видит ошибку и «Повторить», а не пустоту', async () => {
    serve({
      '/rsvp/tok1': { guestName: 'Марина', status: 'yes', wedding: { title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа' } } },
      '/join/tok1/menu-vote': { options: [] },
      '/join/tok1/shuttle': DOWN,
      '/join/tok1/hotels': [],
    })
    const text = await open('/invite', SERVER_DOWN)
    expect(text).toContain('Трансфер')
    expect(text).toContain('Повторить')
  })
})
