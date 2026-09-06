// @vitest-environment jsdom
/*
 * Сервер выключен — значит данных нет ни на одном экране.
 *
 * Это проверка последнего этапа миграции. Раньше приложение было витриной:
 * при выключенном сервере оно всё равно показывало «Алину и Тимура», четырёх
 * подрядчиков со статусами, «Артём Краснов получил 30 000 ₽», два подписанных
 * договора и телефон «+7 917 ···-45-67». Человек видел чужую свадьбу и считал
 * её своей.
 *
 * Здесь сети нет вовсе: каждый запрос падает. Экран обязан сказать об этом
 * словами — и не подставить вместо ответа выдумку. Тест перебирает все
 * маршруты и ищет строки, которые могли прийти только из моков.
 *
 * Если экран заново обзаведётся «заглушкой на случай, если сервер не ответил»,
 * этот тест покраснеет — в том и смысл.
 */
import { render, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import App from '@/App'

/* Маршруты пары, подрядчика и гостя. `/inspiration` не входит: истории там —
   редакционный контент, и контракт прямо говорит, что они живут во фронте
   (сервер хранит только отметки «нравится»). */
const ROUTES = [
  '/home', '/notifications', '/settings', '/support',
  '/search', '/search/photo', '/vendor/v1',
  '/wedding', '/wedding/slot/s1', '/wedding/budget', '/wedding/checklist',
  '/wedding/timeline', '/wedding/guests', '/wedding/documents',
  '/wedding/invites', '/wedding/seating', '/wedding/wishlist', '/gifts', '/wedding/album',
  '/wedding/logistics', '/wedding/catering', '/wedding/planb',
  '/us', '/us/chats', '/us/team',
  '/deal/d1', '/assistant', '/compare', '/dayx', '/after',
  '/favorites', '/venues',
  '/vendor-app', '/vendor-app/profile', '/vendor-app/deals',
  '/vendor-app/leads/l1', '/vendor-app/reviews', '/vendor-app/analytics',
]

/*
 * Следы моков. Каждая строка когда-то стояла в коде и выдавалась за данные
 * человека: имена выдуманной пары, выдуманные подрядчики и суммы, выдуманные
 * устройства и тикеты, телефоны-пустышки и слово «демо» на живом экране.
 */
const MOCK_TRACES = [
  'Алина', 'Тимур', 'Артём Краснов', 'Соколов',
  'Валеева', 'Козлова', 'Волков',
  'Пион', 'Липовый сад', 'Белый Сад',
  '000-00-00', '···-45-67', '42/50',
  'iPhone · Safari', 'Android · Chrome',
  'Тикет #', 'демо',
  '+15 мин задержка', 'МИН К ПЛАНУ',
]

/*
 * Ноль — это значение, а не «неизвестно».
 *
 * Первая волна проверки искала выдуманные имена и суммы и ничего не нашла.
 * Но экраны считали счётчики от `?? []` и рядом с честным «Сервер недоступен»
 * показывали «0 гостей», «0 забронировано», «0 ₽ ожидается по сделкам»,
 * «Доход 0 ₽». Пара читает это не как «мы не знаем», а как «никто не ответил»
 * и «денег не осталось» — и звонит подрядчикам выяснять, что случилось.
 *
 * Здесь перечислено то, чего на экране без сервера быть не должно.
 */
const FORBIDDEN_WHEN_DOWN: Record<string, string[]> = {
  '/home': ['0%', '0/0'],
  '/wedding': ['0 забронировано'],
  '/wedding/budget': ['запланировано'],
  '/wedding/guests': ['0 в списке'],
  '/wedding/album': ['0 кадров'],
  '/search': ['0 категорий'],
  '/search/photo': ['0 рядом'],
  '/favorites': ['0 отложено'],
  '/us/team': ['Пока только вы'],
  '/vendor-app/deals': ['ожидается по сделкам', 'активных сделок'],
  '/vendor-app/analytics': ['Доход', 'Воронка анкеты'],
  /* «Загружаем…» навсегда — тоже неправда: экран обещает то, чего не будет. */
  '/wedding/slot/s1': ['Загружаем…'],
  '/deal/d1': ['Загружаем…'],
}

describe('сервер выключен: ни один экран не показывает выдумку', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
    /* Вход есть, свадьба выбрана — иначе экраны показали бы приглашение войти
       и проверять было бы нечего. Ответов при этом нет: сети нет. */
    localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
    localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  for (const r of ROUTES) {
    it(`без сервера ${r} пуст`, async () => {
      const { container, unmount } = render(
        <MemoryRouter initialEntries={[r]}><App /></MemoryRouter>,
      )
      await waitFor(() => expect(container.querySelector('[data-testid="route-loading"]')).toBeNull())
      /* Ждём, пока экран отработает отказ: до этого он честно показывает
         «Загружаем…», и искать в нём следы моков рано. На экранах с
         несколькими запросами какой-то из них может остаться в загрузке —
         это не мешает проверке, поэтому ожидание не обязательное. */
      await waitFor(() => expect(container.textContent ?? '').not.toContain('Загружаем…')).catch(() => undefined)

      const text = container.textContent ?? ''
      const found = MOCK_TRACES.filter(m => text.includes(m))
      expect(found, `${r}: на экране без сервера остались следы моков`).toEqual([])

      /* Числа без ответа сервера — такая же выдумка, только цифрами. */
      const zeros = (FORBIDDEN_WHEN_DOWN[r] ?? []).filter(m => text.includes(m))
      expect(zeros, `${r}: без сервера показаны числа, которых неоткуда взять`).toEqual([])
      unmount()
    })
  }
})
