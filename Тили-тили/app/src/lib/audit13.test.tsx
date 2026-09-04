// @vitest-environment jsdom
/*
 * Регрессии по аудиту 2026-09-03.
 *
 * Каждый набор здесь падал бы до своего исправления. Тест, который проходит
 * и на сломанном коде, ничего не сторожит.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { StoreProvider, useStore } from './store'
import { countdownTo } from './weddingDate'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('обратный отсчёт в конце месяца', () => {
  /*
   * Якорь «сейчас плюс N месяцев» строился через new Date(y, m, 31) и уезжал
   * в следующий месяц (31 февраля → 3 марта), а откат setMonth(-1) возвращал
   * не исходное число, а смещённое. Отсчёт терял до трёх суток у любой пары,
   * открывшей главный экран 29-го, 30-го или 31-го числа.
   */
  it('31 января → 28 февраля: месяц целиком, а не 25 дней', () => {
    expect(countdownTo('2026-02-28', new Date(2026, 0, 31, 12, 0))).toEqual({ m: 1, d: 0, h: 4, min: 0 })
  })

  it('31 марта → 20 апреля: 20 дней, а не 19', () => {
    expect(countdownTo('2026-04-20', new Date(2026, 2, 31, 12, 0))).toEqual({ m: 0, d: 20, h: 4, min: 0 })
  })

  it('31 мая → 15 июля: 1 месяц и 15 дней, а не 14', () => {
    expect(countdownTo('2026-07-15', new Date(2026, 4, 31, 12, 0))).toEqual({ m: 1, d: 15, h: 4, min: 0 })
  })

  it('середина месяца считалась верно и осталась прежней', () => {
    expect(countdownTo('2026-02-28', new Date(2026, 0, 15, 12, 0))).toEqual({ m: 1, d: 13, h: 4, min: 0 })
  })

  it('остаток дней ни в один день года не вылезает за длину месяца', () => {
    // Якорь, ушедший вперёд цели, даёт отрицательный или раздутый остаток.
    for (let month = 0; month < 12; month++) {
      for (let day = 1; day <= 31; day++) {
        const now = new Date(2026, month, day, 12, 0)
        if (now.getMonth() !== month) continue // 31 апреля не существует
        const left = countdownTo('2027-06-14', now)
        expect(left.d).toBeGreaterThanOrEqual(0)
        expect(left.d).toBeLessThan(31)
        expect(left.h).toBeGreaterThanOrEqual(0)
        expect(left.min).toBeGreaterThanOrEqual(0)
      }
    }
  })
})

/** Пробник: показывает значения, которые провайдер взял из хранилища. */
function Probe() {
  const { city, lang, onboarded } = useStore()
  return <div data-testid="probe">{`${city}|${lang}|${onboarded ? '1' : '0'}`}</div>
}

const denied = () => {
  throw new DOMException('Access is denied for this document', 'SecurityError')
}

describe('заблокированные данные сайта', () => {
  /*
   * В Chrome с «блокировать все cookie» и в iframe без allow-same-origin
   * обращение к хранилищу БРОСАЕТ SecurityError, а не возвращает null.
   * Инициализаторы useState в StoreProvider выполняются в фазе рендера:
   * необработанное исключение там клало приложение на экран ErrorBoundary,
   * из которого перезагрузка не выводила — провайдер падал снова.
   */
  it('StoreProvider поднимается и отдаёт значения по умолчанию', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(denied)
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(denied)

    render(<StoreProvider><Probe /></StoreProvider>)

    expect(screen.getByTestId('probe').textContent).toBe('Уфа|ru|0')
  })

  it('запись в недоступное хранилище не роняет обработчик', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(denied)
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(denied)

    // Провайдер сохраняет город при монтировании дочерних экранов и в сеттерах;
    // ни один из этих путей не должен выбрасывать наружу.
    expect(() => render(<StoreProvider><Probe /></StoreProvider>)).not.toThrow()
  })

  it('точка входа не оставляет белый экран при недоступном sessionStorage', async () => {
    vi.spyOn(window.sessionStorage, 'getItem').mockImplementation(denied)
    vi.spyOn(window.sessionStorage, 'removeItem').mockImplementation(denied)
    document.body.innerHTML = '<div id="root"></div>'

    /* main.tsx читает tt_redirect на ВЕРХНЕМ УРОВНЕ модуля, до createRoot.
     * Без защиты модуль падал на импорте, React не монтировался вовсе,
     * и человек получал пустую страницу — ErrorBoundary до неё не доживает. */
    await expect(import('../main')).resolves.toBeDefined()
    // createRoot в React 19 рисует асинхронно — ждём первый кадр.
    await waitFor(() => expect(document.getElementById('root')!.childElementCount).toBeGreaterThan(0))
  })
})
