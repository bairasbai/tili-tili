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

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('суммы показываются в рублях', () => {
  it('анкета подрядчика: цена пакета', async () => {
    const { container } = wrap(<VendorDetail />, '/vendor/v1', '/vendor/:id')
    /* Анкета приходит с сервера — суммы появляются после ответа, а не в
       первом кадре. */
    await waitFor(() => expect(money(container as HTMLElement)).toContain('85 000 ₽'))
    expect(money(container as HTMLElement)).toContain('130 000 ₽')
  })

  it('бюджет: итог и лимит', () => {
    const { container } = wrap(<Budget />)
    const text = money(container as HTMLElement)
    expect(text).toContain('677 000 ₽')
    expect(text).toContain('1 200 000 ₽')
  })

  it('главная показывает тот же итог, что бюджет', () => {
    const { container } = wrap(<Home />, '/home')
    expect(money(container as HTMLElement)).toContain('677 000 ₽')
  })

  it('сделка: аванс, доплата и итог', () => {
    const { container } = wrap(<Deal />)
    const text = money(container as HTMLElement)
    expect(text).toContain('30 000 ₽')
    expect(text).toContain('60 000 ₽')
  })

  it('вишлист: цена подарка', () => {
    const { container } = wrap(<WishlistManage />)
    expect(money(container as HTMLElement)).toContain('89 990 ₽')
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
