// @vitest-environment jsdom
/*
 * Суммы на экранах.
 *
 * Тест написан ДО перевода денег на копейки и фиксирует, что видит
 * пользователь. Ошибка в сто раз — самая вероятная при смене единиц измерения
 * и самая незаметная в коде, поэтому проверяются конкретные строки.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/* Анкета подрядчика ходит в сеть — в jsdom её нет. Ответы каталога общие
   для всех экранных тестов: src/test/catalogMock.ts. */
vi.mock('@/lib/api/catalog', async () => (await import('@/test/catalogMock')).catalogMock())

/* Список желаний приходит с сервера: цена на экране — это его ответ, а не
   константа мока. */
vi.mock('@/lib/api/gifts', async (orig) => ({
  ...await orig<object>(),
  getWishlist: async () => ({
    gifts: [{ id: 'gf1', name: 'Робот-пылесос', icon: '🤖', price: { amount: 8_999_000, currency: 'RUB' }, funded: { amount: 0, currency: 'RUB' }, group: false, reserved: false }],
    funds: [],
    antiGifts: [],
  }),
}))

/* Данные свадьбы тоже приходят с сервера: бюджет и главная должны считать по
   одному и тому же ответу, иначе «одинаковый итог» проверяется на двух разных
   источниках и ничего не значит. */
vi.mock('@/lib/api/weddingData', () => ({
  getBudget: async () => ({
    total: { amount: 120_000_000, currency: 'RUB' },
    spent: { amount: 67_700_000, currency: 'RUB' },
    categories: [
      { id: 'b1', title: 'Площадка и кейтеринг', planned: { amount: 56_000_000 }, fromSlots: 48_000_000, color: '#D9A8A0', live: null, items: [] },
    ],
  }),
  getTasks: async () => [{ id: 't1', title: 'Выбрать дату', period: '9', done: false, custom: false }],
  getGuests: async () => [],
  getTimeline: async () => [],
  getDocuments: async () => [],
  getPlanB: async () => ({ checklist: [], activatedAt: null, scenario: null }),
  getSlots: async () => (await import('@/test/slotsMock')).slotsRead.getSlots(),
  getWedding: async () => ({ title: 'Алина & Тимур', city: { name: 'Уфа' }, tz: 'Asia/Yekaterinburg' }),
}))
import { authorize, resetSlots } from '@/test/slotsMock'
import { render, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { StoreProvider } from './store'
import { VendorDetail } from '@/pages/Search'
import { Budget } from '@/pages/Wedding'
import { Deal } from '@/pages/Tools'
import { WishlistManage } from '@/pages/Wishlist'
import Home from '@/pages/Home'

/*
 * Экран рендерится внутри маршрута, а не просто под роутером.
 *
 * Анкета подрядчика читает `:id` через useParams: без объявленного пути он
 * пустой, и раньше это скрывалось подстановкой первого подрядчика из мока —
 * тест «проходил», глядя на чужую анкету.
 */
const wrap = (node: React.ReactNode, route = '/', path?: string) =>
  render(
    <MemoryRouter initialEntries={[route]}>
      <StoreProvider>
        {path ? <Routes><Route path={path} element={node} /></Routes> : node}
      </StoreProvider>
    </MemoryRouter>,
  )

/** Неразрывные пробелы из Intl приводим к обычным, чтобы сравнивать по-человечески. */
/** Intl разделяет разряды неразрывным пробелом — приводим к обычному,
 *  иначе сравнение строк ломается на невидимом символе. */
const NARROW = String.fromCharCode(160, 8239)
const money = (el: HTMLElement) => el.textContent!.replace(new RegExp('[' + NARROW + ']', 'g'), ' ')

beforeEach(() => {
  localStorage.clear()
  /* Экраны свадьбы спрашивают сервер только при известной свадьбе и только
     после входа — без этого они честно показывают пусто, и проверять на них
     суммы нечего. */
  authorize()
  resetSlots()
})
afterEach(cleanup)

describe('суммы показываются в рублях', () => {
  it('анкета подрядчика: цена пакета', async () => {
    const { container } = wrap(<VendorDetail />, '/vendor/v1', '/vendor/:id')
    /* Анкета приходит с сервера — суммы появляются после ответа, а не в
       первом кадре. */
    await waitFor(() => expect(money(container as HTMLElement)).toContain('85 000 ₽'))
    expect(money(container as HTMLElement)).toContain('130 000 ₽')
  })

  it('бюджет: итог и лимит', async () => {
    const { container } = wrap(<Budget />)
    await waitFor(() => expect(money(container as HTMLElement)).toContain('677 000 ₽'))
    expect(money(container as HTMLElement)).toContain('1 200 000 ₽')
  })

  it('главная показывает тот же итог, что бюджет', async () => {
    /* Смысл проверки — не число само по себе, а совпадение: оба экрана считают
       по одному ответу сервера. Раньше главная считала по мокам и расходилась
       с бюджетом на всю сумму. */
    const { container } = wrap(<Home />, '/home')
    await waitFor(() => expect(money(container as HTMLElement)).toContain('677 000 ₽'))
    expect(money(container as HTMLElement)).toContain('1 200 000 ₽')
  })

  it('сделка показывает сумму из ответа сервера', async () => {
    /* Раньше здесь стояли 30 000 и 60 000 — константы разметки, не связанные
       ни с какой сделкой: экран показывал их всем и всегда. */
    const { container } = wrap(<Deal />, '/deal/d-s1', '/deal/:id')
    await waitFor(() => expect(money(container as HTMLElement)).toContain('45 000 ₽'))
  })

  it('вишлист: цена подарка приходит с сервера', async () => {
    /* Раньше список желаний лежал в `tt_gifts` браузера, и цена бралась из
       мока. Теперь она приходит с сервера — как и резерв, общий на пару и
       всех гостей. */
    const { container } = wrap(<WishlistManage />)
    await waitFor(() => expect(money(container as HTMLElement)).toContain('89 990 ₽'))
  })

  it('нигде не мелькают суммы, увеличенные в сто раз', () => {
    for (const [node, route] of [[<Budget />, '/'], [<Home />, '/home'], [<Deal />, '/']] as const) {
      cleanup()
      const { container } = wrap(node, route)
      const text = money(container as HTMLElement)
      expect(text).not.toContain('8 500 000')
      expect(text).not.toContain('67 700 000')
      expect(text).not.toContain('120 000 000')
    }
  })
})
