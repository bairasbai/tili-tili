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
import { projectFile } from '@/test/projectFiles'

/* ВСЕ маршруты приложения (App.tsx), кроме `/inspiration`: истории там —
   редакционный контент, и контракт прямо говорит, что они живут во фронте
   (сервер хранит только отметки «нравится»). Список сверяется с App.tsx
   ниже: новый маршрут без проверки здесь — красный тест. */
const ROUTES = [
  '/', '/quiz', '/auth', '/invite', '/i/c1', '/join/c1',
  '/home', '/notifications', '/settings', '/support', '/legal/offer', '/legal/privacy',
  '/search', '/search/photo', '/vendor/v1',
  '/wedding', '/wedding/slot/s1', '/wedding/budget', '/wedding/checklist',
  '/wedding/timeline', '/wedding/guests', '/wedding/documents', '/wedding/documents/new',
  '/wedding/invites', '/wedding/seating', '/wedding/wishlist', '/gifts', '/wedding/album',
  '/wedding/logistics', '/wedding/catering', '/wedding/planb',
  '/us', '/us/chats', '/us/chats/c1', '/us/team',
  '/deal/d1', '/assistant', '/compare', '/dayx', '/after',
  '/favorites', '/venues', '/notes', '/tools/alcohol',
  '/vendor-app', '/vendor-app/profile', '/vendor-app/deals', '/vendor-app/verification',
  '/vendor-app/leads/l1', '/vendor-app/reviews', '/vendor-app/analytics',
  /* Фича 007: чаты и настройки кабинета — те же экраны пары в режиме кабинета. */
  '/vendor-app/chats', '/vendor-app/chats/c1', '/vendor-app/settings',
  '/admin', '/admin/moderation', '/admin/moderation/v1',
  '/admin/verifications', '/admin/verifications/r1',
  '/admin/complaints', '/admin/categories', '/admin/wedding',
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
  /* Три «заметки», которые экран показывал при первом открытии как свои. */
  'пионы + эвкалипт', '«Perfect»',
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
  '/home': ['0%', '0/0', ' подтвердили', 'ждут ответа', 'Добавьте гостей', 'Все задачи закрыты', 'Чек-лист пуст', 'Пока никто не забронирован'],
  '/wedding': ['0 забронировано', '0 из 0'],
  '/wedding/budget': ['запланировано'],
  '/wedding/checklist': ['Всё сделано', '0 из 0', 'Чек-лист пуст'],
  '/wedding/timeline': ['Тайминг пуст'],
  '/wedding/guests': ['0 в списке', 'Список пуст', '0 персон'],
  '/wedding/catering': ['Опрос ещё не составлен', '0 из 0'],
  '/wedding/seating': ['Столов пока нет', 'гостей пока нет'],
  '/wedding/planb': ['0%'],
  '/wedding/logistics': ['Маршрутов пока нет', 'Отельных блоков пока нет', '0/0 мест'],
  '/wedding/wishlist': ['Пока пусто'],
  '/wedding/album': ['0 кадров'],
  '/search': ['0 категорий'],
  '/search/photo': ['0 рядом'],
  '/vendor/v1': ['Свободен на вашу дату', 'верифицирован', '1:40', '5 фото'],
  '/favorites': ['0 отложено'],
  '/dayx': ['Тайминг пуст', 'Забронированных подрядчиков пока нет'],
  /* Плитки итогов: число и подпись стоят вплотную. */
  '/after': ['0подрядчиков', '0гостей', '0кадров', '0отзывов'],
  '/us/team': ['Пока только вы', 'Активных ссылок нет', '0 действуют'],
  '/settings': ['Имя не указано', '22:00', 'Тихих часов нет'],
  '/notes': ['Все заметки разобраны'],
  '/vendor-app/deals': ['ожидается по сделкам', 'активных сделок'],
  '/vendor-app/analytics': ['Доход', 'Воронка анкеты'],
  '/vendor-app/verification': ['Загрузка документов пока не подключена', 'Кто вы'],
  /* Панель сотрудника: показатели платформы и оборот. «0 жалоб» рядом с
     «Сервер недоступен» читается как «жалоб нет» — и очередь стоит
     незамеченной. Число и подпись в плитке стоят вплотную, как в «/after».
     Списка городов без ответа сервера тоже нет: пустой список утверждал бы,
     что платформы нет ни в одном городе. */
  '/admin': [
    '0Аккаунтов', '0Свадеб', '0Анкет в каталоге', '0Анкет в очереди',
    '0Заявок на верификацию', '0Жалоб открыто', '0Просрочено', '0Сделок', '0 ₽',
    'Городов с анкетами пока нет', 'готов к запуску',
  ],
  '/admin/moderation': ['Очередь пуста — все анкеты проверены'],
  /* Очередь заявок: «Заявок нет» без ответа сервера читается как «разбирать
     нечего», и документы лежат непроверенными. */
  '/admin/verifications': ['Заявок нет'],
  /* Карточка заявки: вид документа, ИНН и слова про документ — утверждения о
     заявке, которой с сервера не пришло. */
  '/admin/verifications/r1': ['Документ не приложен', 'ИНН не указан', 'Анкета не опубликована'],
  '/admin/complaints': ['Нерассмотренных жалоб нет', 'просрочено'],
  '/admin/categories': ['Словарь пуст — поиск ищет только по названиям'],
  /* «Загружаем…» навсегда — тоже неправда: экран обещает то, чего не будет. */
  '/wedding/slot/s1': ['Загружаем…'],
  '/deal/d1': ['Загружаем…'],
}

describe('список маршрутов проверки полный', () => {
  /* Аудит, блок 4: тринадцать маршрутов (в том числе /notes с тремя чужими
     заметками) не входили в перебор — экран без сервера никто не проверял. */
  it('каждый path из App.tsx, кроме /inspiration, есть в ROUTES', () => {
    const src = projectFile('src/App.tsx')
    const paths = [...src.matchAll(/path="([^"]+)"/g)].map(m => m[1]!).filter(p => p !== '*' && p !== '/inspiration')
    expect(paths.length).toBeGreaterThan(40)
    const missing = paths.filter(p => {
      const re = new RegExp(`^${p.replace(/:[^/]+/g, '[^/]+')}$`)
      return !ROUTES.some(r => re.test(r))
    })
    expect(missing).toEqual([])
  })
})

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
      await waitFor(() => expect(container.querySelector('[data-testid="route-loading"]')).toBeNull(), { timeout: 4000 })
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
