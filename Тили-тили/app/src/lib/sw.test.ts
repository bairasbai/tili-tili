import { describe, it, expect } from 'vitest'
import { projectFile } from '@/test/projectFiles'

/*
 * Service worker и API (ERR-0204).
 *
 * Обработчик `fetch` в `public/sw.js` кэширует same-origin GET cache-first.
 * Без исключения для `/api/` в это правило попадали и ответы сервера:
 * второй запрос к `GET /weddings/{id}` или к очередям панели отдавал бы
 * вчерашний ответ из Cache API до следующей версии кэша, а серверный
 * `Cache-Control: no-store` Cache API не читает. Тест — по исходнику:
 * поведение worker'а в jsdom не воспроизвести, а исчезновение строки —
 * ровно тот дефект, который здесь закрыт.
 */
describe('service worker не кэширует ответы API', () => {
  it('запросы к /api/ отдаются на откуп сети до любого кэша', () => {
    const sw = projectFile('public/sw.js')
    const fetchHandler = sw.slice(sw.indexOf("addEventListener('fetch'"))
    expect(fetchHandler.length, 'обработчик fetch не найден').toBeGreaterThan(0)
    const guard = fetchHandler.indexOf("pathname.startsWith('/api/')")
    const cache = fetchHandler.indexOf('c.match(request)')
    expect(guard, 'нет исключения для /api/').toBeGreaterThan(0)
    expect(guard, 'исключение стоит после обращения к кэшу').toBeLessThan(cache)
  })
})

/*
 * Кэшируется только сборка приложения и её оболочка — белый список, а не чёрный.
 *
 * Исключение по пути `/api/` закрывает ровно один адрес. База API задаётся
 * `VITE_API_URL`, и на том же origin она может лежать по любому пути
 * (`/v1/`, `/backend/`, `/gw/`). При такой базе прежнее правило снова
 * укладывало ответы сервера в cache-first, и панель отдавала бы вчерашние
 * очереди до следующей версии кэша. Правило перевёрнуто: кэшируем только
 * файлы Vite в `./assets/` (имя с хешем — содержимое не меняется) и оболочку
 * из SHELL; всё остальное — сеть без кэша. Правило «по типу запроса» было
 * шире: картинка с того же origin по любому пути (будущее хранилище фото за
 * прокси) ложилась бы в кэш и показывалась после удаления (фича 014, A11).
 *
 * Проверяем по исходнику: worker в jsdom не поднять. Но разрешающее правило
 * берём из файла и запускаем как правило — `isStaticAsset` вместе с его
 * константами исполняется на поддельных `self` и `location`, — а не сравниваем
 * текстом: иначе тест зелен от того, что нужные буквы где-то встретились.
 */
const SW = 'public/sw.js'

/** Кусок исходника от одного обработчика до следующего. */
function handler(src: string, name: string): string {
  const from = src.indexOf(`addEventListener('${name}'`)
  expect(from, `обработчик ${name} не найден`).toBeGreaterThan(0)
  const rest = src.slice(from + 'addEventListener('.length)
  const to = rest.indexOf('addEventListener(')
  return to === -1 ? rest : rest.slice(0, to)
}

/**
 * `isStaticAsset` из исходника как функция: константы SHELL, STATIC_EXT,
 * ASSETS_DIR и SHELL_PATHS берутся оттуда же, `self.registration.scope` и
 * `location.origin` — подставные, как у приложения в подпапке хостинга.
 */
function staticRule(scope: string): (url: string) => boolean {
  const src = projectFile(SW)
  const shell = src.match(/const SHELL = \[[^\]]*\]/)
  const ext = src.match(/const STATIC_EXT = .*\r?\n/)
  const start = src.indexOf('const ASSETS_DIR')
  const fnStart = src.indexOf('function isStaticAsset')
  const fnEnd = src.indexOf('\n}', fnStart)
  expect(shell, 'нет SHELL').not.toBeNull()
  expect(ext, 'нет STATIC_EXT').not.toBeNull()
  expect(start, 'нет ASSETS_DIR').toBeGreaterThan(0)
  expect(fnStart, 'нет isStaticAsset').toBeGreaterThan(start)
  const body = `${shell![0]}\n${ext![0]}\n${src.slice(start, fnEnd + 2)}\nreturn isStaticAsset`
  const origin = new URL(scope).origin
  const make = new Function('self', 'location', body) as (s: unknown, l: unknown) => (r: { url: string }) => boolean
  const isStaticAsset = make({ registration: { scope } }, { origin })
  return (url) => isStaticAsset({ url: new URL(url, scope).toString() })
}

describe('service worker кэширует только сборку и оболочку', () => {
  it('в кэш идут файлы ./assets/ и оболочка; картинки и JSON по другим путям — нет', () => {
    const at = staticRule('https://tili-tili.ru/')
    for (const p of ['/assets/index-a1b2c3.js', '/assets/main-4f.css', '/assets/serif-9x.woff2', '/assets/hero-77.png', '/icon.svg', '/manifest.webmanifest', '/'])
      expect(at(p), `статика ${p} не попала бы в кэш`).toBe(true)
    for (const p of ['/img/hero.png', '/files/album/1.jpg', '/uploads/passport.png', '/v1/weddings/w1', '/backend/admin/verifications', '/gw/users/me', '/api/weddings', '/admin/verifications', '/assets/'])
      expect(at(p), `адрес ${p} прошёл бы как статика`).toBe(false)
    expect(at('https://cdn.example.com/assets/index-a1.js'), 'чужой origin').toBe(false)
  })

  it('пути считаются от адреса воркера — приложение в подпапке хостинга', () => {
    const at = staticRule('https://host.example/app/')
    expect(at('/app/assets/index-a1.js')).toBe(true)
    expect(at('/app/icon.svg')).toBe(true)
    expect(at('/assets/index-a1.js'), 'корень хостинга — не наша сборка').toBe(false)
    expect(at('/app/photos/1.jpg')).toBe(false)
  })

  it('до кэша доходит только статика: проверка стоит перед caches.match', () => {
    const f = handler(projectFile(SW), 'fetch')
    const guard = f.indexOf('isStaticAsset(request)')
    const cache = f.indexOf('c.match(request)')
    expect(guard, 'в обработчике fetch нет проверки на статику').toBeGreaterThan(0)
    expect(cache, 'обращения к кэшу нет вовсе').toBeGreaterThan(0)
    expect(guard, 'кэш опрашивается до проверки на статику').toBeLessThan(cache)
    /* Ровно одна ветка с кэшем: вторая — это вторая дыра. */
    expect(f.split('c.match(request)').length - 1, 'кэш опрашивается в нескольких ветках').toBe(1)
    expect(f).not.toContain('caches.match(')
  })

  it('офлайн-оболочка на месте: навигация отвечает страницей из кэша', () => {
    const f = handler(projectFile(SW), 'fetch')
    expect(f).toContain("request.mode === 'navigate'")
    expect(f).toContain('caches.open(CACHE).then(c => c.match(OFFLINE_PAGE))')
    /* Навигация разбирается раньше правила статики — иначе прямая ссылка
       офлайн упирается в «не статика, идём в сеть» и получает пустоту. */
    expect(f.indexOf("request.mode === 'navigate'")).toBeLessThan(f.indexOf('isStaticAsset(request)'))
  })

  it('версия кэша поднята, а старые версии чистит activate', () => {
    const src = projectFile(SW)
    const version = src.match(/CACHE_VERSION = 'v(\d+)'/)
    expect(version, 'версия кэша не найдена').not.toBeNull()
    /* Правило кэширования изменилось (фича 014): без новой версии в кэше
       остаются записи, положенные туда старым правилом, и чистить их нечем. */
    expect(Number(version![1]), 'правило сменилось, а версия кэша прежняя').toBeGreaterThanOrEqual(5)
    const a = handler(src, 'activate')
    expect(a).toContain('caches.keys()')
    expect(a, 'activate не отбирает чужие версии').toContain('k !== CACHE')
    expect(a).toContain('k.startsWith(CACHE_PREFIX)')
    expect(a, 'activate не удаляет старые кэши').toContain('caches.delete')
  })
})
