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
    const cache = fetchHandler.indexOf('caches.match(request)')
    expect(guard, 'нет исключения для /api/').toBeGreaterThan(0)
    expect(guard, 'исключение стоит после обращения к кэшу').toBeLessThan(cache)
  })
})

/*
 * Кэшируется только явная статика — белый список, а не чёрный.
 *
 * Исключение по пути `/api/` закрывает ровно один адрес. База API задаётся
 * `VITE_API_URL`, и на том же origin она может лежать по любому пути
 * (`/v1/`, `/backend/`, `/gw/`). При такой базе прежнее правило снова
 * укладывало ответы сервера в cache-first, и панель отдавала бы вчерашние
 * очереди до следующей версии кэша. Правило перевёрнуто: кэшируем только то,
 * что названо статикой, всё остальное — сеть без кэша.
 *
 * Проверяем по исходнику: worker в jsdom не поднять. Но разрешающие правила
 * берём из файла и запускаем как правила, а не сравниваем текстом — иначе
 * тест зелен от того, что нужные буквы где-то встретились.
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

/** Регулярка расширений — из исходника, как настоящая регулярка. */
function staticExt(src: string): RegExp {
  const m = src.match(/STATIC_EXT = \/(.+)\/([a-z]*)\r?\n/)
  expect(m, 'в sw.js нет списка расширений STATIC_EXT').not.toBeNull()
  return new RegExp(m![1]!, m![2]!)
}

describe('service worker кэширует только статику приложения', () => {
  it('разрешение — по типу запроса, а не по отсутствию /api/ в пути', () => {
    const src = projectFile(SW)
    expect(src, 'нет проверки request.destination').toContain('request.destination')
    const set = src.match(/STATIC_DEST = new Set\(\[([^\]]*)\]\)/)
    expect(set, 'нет списка разрешённых типов STATIC_DEST').not.toBeNull()
    for (const dest of ['script', 'style', 'image', 'font', 'manifest'])
      expect(set![1]!, `тип ${dest} не разрешён`).toContain(`'${dest}'`)
    /* Документ в список не входит: страницу отдаёт ветка навигации. */
    expect(set![1]!, 'документ попал в статику — офлайн-оболочка ломается').not.toContain("'document'")
  })

  it('разрешение по расширению впускает статику и не впускает адреса API', () => {
    const ext = staticExt(projectFile(SW))
    for (const p of ['/assets/index-a1b2c3.js', '/assets/main-4f.css', '/icon.svg', '/favicon.ico', '/manifest.webmanifest', '/fonts/serif.woff2', '/img/hero.png'])
      expect(ext.test(p), `статика ${p} не попала бы в кэш`).toBe(true)
    for (const p of ['/v1/weddings/w1', '/backend/admin/verifications', '/gw/users/me', '/api/weddings', '/', '/admin/verifications'])
      expect(ext.test(p), `адрес ${p} прошёл бы как статика`).toBe(false)
  })

  it('до кэша доходит только статика: проверка стоит перед caches.match', () => {
    const f = handler(projectFile(SW), 'fetch')
    const guard = f.indexOf('isStaticAsset(request)')
    const cache = f.indexOf('caches.match(request)')
    expect(guard, 'в обработчике fetch нет проверки на статику').toBeGreaterThan(0)
    expect(cache, 'обращения к кэшу нет вовсе').toBeGreaterThan(0)
    expect(guard, 'кэш опрашивается до проверки на статику').toBeLessThan(cache)
    /* Ровно одна ветка с кэшем: вторая — это вторая дыра. */
    expect(f.split('caches.match(request)').length - 1, 'кэш опрашивается в нескольких ветках').toBe(1)
  })

  it('офлайн-оболочка на месте: навигация отвечает страницей из кэша', () => {
    const f = handler(projectFile(SW), 'fetch')
    expect(f).toContain("request.mode === 'navigate'")
    expect(f).toContain('caches.match(OFFLINE_PAGE)')
    /* Навигация разбирается раньше правила статики — иначе прямая ссылка
       офлайн упирается в «не статика, идём в сеть» и получает пустоту. */
    expect(f.indexOf("request.mode === 'navigate'")).toBeLessThan(f.indexOf('isStaticAsset(request)'))
  })

  it('версия кэша поднята, а старые версии чистит activate', () => {
    const src = projectFile(SW)
    const version = src.match(/CACHE = 'tilitili-v(\d+)'/)
    expect(version, 'версия кэша не найдена').not.toBeNull()
    /* Правило кэширования изменилось: без новой версии в кэше остаются записи,
       положенные туда старым правилом, и чистить их нечем. */
    expect(Number(version![1]), 'правило сменилось, а версия кэша прежняя').toBeGreaterThanOrEqual(4)
    const a = handler(src, 'activate')
    expect(a).toContain('caches.keys()')
    expect(a, 'activate не отбирает чужие версии').toContain('k !== CACHE')
    expect(a, 'activate не удаляет старые кэши').toContain('caches.delete')
  })
})
