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
