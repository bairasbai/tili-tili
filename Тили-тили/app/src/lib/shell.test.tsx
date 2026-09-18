// @vitest-environment jsdom
/*
 * Оболочка приложения: пути для подпапки, deep-link шим, тема, пустые состояния.
 * Эти вещи не видны в обычных экранных тестах и ломаются молча.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/*
 * Логистика тоже с сервера. Держим её в памяти мока: без этого проверка
 * «последний блок удалён» смотрела бы на состояние экрана, а не на ответ.
 */
const { logisticsState } = vi.hoisted(() => ({
  logisticsState: {
    buses: [] as Array<{ id: string; name: string; seats: number; taken: number }>,
    hotels: [] as Array<{ id: string; name: string; rooms: number; booked: number }>,
  },
}))

/* Мозаика приходит с сервера — общий набор ответов: src/test/slotsMock.ts. */
vi.mock('@/lib/api/weddingData', async (orig) => ({
  ...await orig<object>(),
  ...(await import('@/test/slotsMock')).slotsRead,
  getBuses: async () => logisticsState.buses.map(b => ({ ...b })),
  getHotels: async () => logisticsState.hotels.map(h => ({ ...h })),
  getGuests: async () => [],
}))
vi.mock('@/lib/api/weddingWrite', async (orig) => ({
  ...await orig<object>(),
  deleteHotel: async (_w: string, id: string) => {
    logisticsState.hotels = logisticsState.hotels.filter(h => h.id !== id)
  },
  deleteBus: async (_w: string, id: string) => {
    logisticsState.buses = logisticsState.buses.filter(b => b.id !== id)
  },
}))
import { authorize, resetSlots } from '@/test/slotsMock'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { StoreProvider } from './store'
import { Logistics } from '@/pages/Logistics'
import { WeddingTeam } from '@/pages/Wedding'
import { projectFile } from '@/test/projectFiles'

const html = projectFile('index.html')
const css = projectFile('src/index.css')
const sw = projectFile('public/sw.js')
const manifestRaw = projectFile('public/manifest.webmanifest')
const app = projectFile('src/App.tsx')
const main = projectFile('src/main.tsx')

const manifest = JSON.parse(manifestRaw) as { start_url: string; scope: string; icons: { src: string }[] }

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('приложение переживает размещение в подпапке', () => {
  it('index.html не ссылается на ресурсы от корня домена', () => {
    const absolute = [...html.matchAll(/(?:href|src)="(\/[^/][^"]*)"/g)]
      .map(m => m[1])
      .filter(p => !p.startsWith('/src/')) // dev-точка входа, Vite подменяет её при сборке
    expect(absolute).toEqual([])
  })

  it('манифест адресует иконки и старт относительно себя', () => {
    expect(manifest.start_url.startsWith('/')).toBe(false)
    expect(manifest.scope.startsWith('/')).toBe(false)
    for (const icon of manifest.icons) expect(icon.src.startsWith('/')).toBe(false)
  })

  it('service worker кэширует оболочку относительными путями', () => {
    expect(sw).not.toMatch(/['"]\/index\.html['"]/)
    expect(sw).toMatch(/'\.\/index\.html'/)
  })

  it('service worker не кэширует HTML под адресом статики', () => {
    /* Хостинг с SPA-fallback отдаёт index.html на любой неизвестный путь, а
       preload-сканер браузера успевает запросить манифест относительно глубокой
       ссылки — без проверки в кэш ложилась HTML-страница под адресом манифеста. */
    expect(sw).toContain('looksLikeHtmlSwap')
    expect(sw).toContain('text/html')
  })

  it('роутер получает basename от корня приложения', () => {
    expect(main).toMatch(/BrowserRouter basename=\{appRoot\(\)\}/)
    expect(main).toMatch(/register\(appRoot\(\) \+ 'sw\.js'\)/)
  })
})

describe('deep-link шим знает все роуты', () => {
  /* Шим вычисляет корень приложения по первому известному сегменту пути.
     Если сегмент роута в список не попал, прямая ссылка в подпапке уедет в чужой
     корень — а заметить это на глаз невозможно. */
  const segments: string[] = JSON.parse(
    (html.match(/var SEGMENTS = (\[[^\]]*\])/)?.[1] ?? '[]').replace(/'/g, '"'),
  )
  const routeSegments = [...new Set(
    [...app.matchAll(/path="\/([^"/*]+)/g)].map(m => m[1]).filter(Boolean),
  )]

  it('список сегментов не пустой и разобран', () => {
    expect(segments.length).toBeGreaterThan(10)
    expect(routeSegments.length).toBeGreaterThan(10)
  })

  it('каждый первый сегмент роута есть в шиме', () => {
    const missing = routeSegments.filter(s => !segments.includes(s))
    expect(missing).toEqual([])
  })

  it('в шиме нет сегментов, которых нет в роутах', () => {
    const extra = segments.filter(s => !routeSegments.includes(s))
    expect(extra).toEqual([])
  })
})

describe('тема', () => {
  it('тёмная не включается сама по системной настройке', () => {
    // §16.1: авто-тёмная тема оставляла приложение светлым, а системные контролы тёмными
    expect(css).not.toMatch(/prefers-color-scheme:\s*dark\s*\)\s*\{\s*:root\s*\{\s*color-scheme:\s*dark/)
  })

  it('цвет строки статуса переключается вместе с темой', () => {
    expect(app).toMatch(/meta\[name="theme-color"\]/)
    expect(app).toMatch(/#1E1A16/)
  })
})

describe('десктоп-раскладка (≥900px)', () => {
  it('сайдбаром становится только nav.glass-tab — шапка и строка ввода чата, панель брони анкеты остаются на месте', () => {
    /* ERR-0263: голый `.glass-tab` в десктопных правилах уносил шапку и строку
       ввода чата в колонку 216px за левый край (чат открывался пустым), а панель
       «Написать / Добавить в свадьбу» анкеты ложилась под сайдбар. */
    const desktop = [...css.matchAll(/@media \(min-width: 900px\)\s*\{([\s\S]*?)\n\}/g)]
      .map(m => m[1]!.replace(/\/\*[\s\S]*?\*\//g, ''))
    expect(desktop.length).toBeGreaterThan(0)
    for (const block of desktop) {
      const bare = [...block.matchAll(/(^|[^\w.-])\.glass-tab\b/gm)].map(m => m[0])
      expect(bare).toEqual([])
    }
    expect(desktop.join('\n')).toMatch(/nav\.glass-tab\s*\{/)
  })
})

describe('шрифты подключены до бандла стилей', () => {
  it('в CSS больше нет @import шрифтов', () => {
    expect(css).not.toMatch(/@import url\('https:\/\/fonts/)
  })
  it('в index.html есть preconnect и стиль шрифтов', () => {
    expect(html).toMatch(/rel="preconnect" href="https:\/\/fonts\.gstatic\.com"/)
    expect(html).toMatch(/fonts\.googleapis\.com\/css2/)
  })
})

const wrap = (node: React.ReactNode, route = '/') =>
  render(<MemoryRouter initialEntries={[route]}><StoreProvider>{node}</StoreProvider></MemoryRouter>)

describe('пустые состояния логистики (R-04)', () => {
  /* Маршруты и отельные блоки приходят с сервера: раньше они лежали в
     `tt_buses` и `tt_hotels` на телефоне того, кто их завёл. */
  beforeEach(() => {
    logisticsState.buses = []
    logisticsState.hotels = []
    authorize()
  })

  it('без маршрутов и отельных блоков экран объясняет, что делать', async () => {
    wrap(<Logistics />)
    await waitFor(() => expect(screen.getByText('Маршрутов пока нет')).toBeTruthy())
    expect(screen.getByText('Отельных блоков пока нет')).toBeTruthy()
  })

  it('последний отельный блок можно удалить и экран не пустеет молча', async () => {
    logisticsState.hotels = [{ id: 'h1', name: 'Хилтон', rooms: 6, booked: 0 }]
    wrap(<Logistics />)
    await waitFor(() => expect(screen.getByText('Хилтон')).toBeTruthy())
    expect(screen.queryByText('Отельных блоков пока нет')).toBeNull()

    for (const b of screen.getAllByLabelText('Удалить')) fireEvent.click(b)
    // Удаление уходит на сервер, а список перечитывается его ответом.
    await waitFor(() => expect(logisticsState.hotels).toHaveLength(0))
    await waitFor(() => expect(screen.getByText('Отельных блоков пока нет')).toBeTruthy())
  })
})

describe('плитка слота команды', () => {
  it('показывает переводимый статус, а не латинское booked', async () => {
    resetSlots()
    authorize()
    const { container } = wrap(<WeddingTeam />, '/wedding')
    await waitFor(() => expect(screen.getAllByText('забронирован').length).toBeGreaterThan(0))
    expect(container.textContent).not.toMatch(/\bbooked\b/)
  })
})
