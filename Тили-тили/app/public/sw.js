/*
 * Тили-тили service worker: app-shell кэш, офлайн-режим.
 *
 * Все пути относительные и разрешаются от адреса самого воркера — приложение
 * может лежать в подпапке статического хостинга, и абсолютный '/' указывал бы
 * на чужой корень: кэш не наполнялся, офлайн не работал.
 */
/* Версия поднята вместе с правилом кэширования (ниже): в кэше v3 лежат записи,
   положенные туда прежним «всё, кроме /api/», — их вычищает `activate`. */
const CACHE = 'tilitili-v4'
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg']
const OFFLINE_PAGE = new URL('./index.html', self.registration.scope).toString()

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()))
})

/*
 * Хостинг с SPA-fallback отдаёт index.html на любой неизвестный путь. При заходе
 * по прямой ссылке вида /app/wedding/guests preload-сканер браузера успевает
 * запросить ./manifest.webmanifest и ./icon.svg относительно ГЛУБОКОГО пути —
 * ещё до того, как шим в index.html уведёт на корень приложения. Без проверки
 * в кэш легла бы HTML-страница под адресом манифеста.
 */
function looksLikeHtmlSwap(request, response) {
  const isHtml = (response.headers.get('content-type') ?? '').includes('text/html')
  const path = new URL(request.url).pathname
  const wantsHtml = path.endsWith('/') || path.endsWith('.html')
  return isHtml && !wantsHtml
}

/*
 * Что попадает в кэш: белый список, а не чёрный.
 *
 * Правило «всё, кроме /api/» защищает ровно один путь. База API задаётся
 * VITE_API_URL и на том же origin может лежать где угодно — '/v1/',
 * '/backend/', '/gw/'. При такой базе ответы сервера снова ложились бы в
 * cache-first, и панель отдавала бы вчерашние очереди до следующей версии
 * кэша (Cache-Control: no-store Cache API не читает, ERR-0204).
 *
 * Поэтому наоборот: кэшируем только то, что названо статикой приложения —
 * по типу запроса и по расширению, — а всё остальное, любой JSON по любому
 * адресу, уходит в сеть без кэша. Документ в список не входит: страницу
 * отдаёт ветка навигации, у неё своё правило и своя офлайн-оболочка.
 */
const STATIC_DEST = new Set(['script', 'style', 'image', 'font', 'manifest'])
const STATIC_EXT = /\.(?:js|mjs|css|png|jpe?g|webp|gif|svg|ico|webmanifest|woff2?|ttf|otf)$/i

function isStaticAsset(request) {
  const url = new URL(request.url)
  /* Чужой origin в кэш не кладём: он живёт своей жизнью, и версия нашего
     кэша ему не указ. */
  if (url.origin !== location.origin) return false
  return STATIC_DEST.has(request.destination) || STATIC_EXT.test(url.pathname)
}

/*
 * Web Push. Сервер шлёт { title, body, data: { link } } (backend notify/push.ts).
 * До аудита 2026-09-07 (блок 8) обработчиков не было: ключи VAPID ничего бы
 * не включили — уведомление доходило до воркера и молча пропадало.
 */
self.addEventListener('push', (e) => {
  let payload = {}
  try { payload = e.data ? e.data.json() : {} } catch { payload = { body: e.data ? e.data.text() : '' } }
  const title = payload.title || 'Тили-тили'
  e.waitUntil(self.registration.showNotification(title, {
    body: payload.body || '',
    icon: './icon.svg',
    badge: './icon.svg',
    data: payload.data || {},
  }))
})

/*
 * Тап по уведомлению открывает центр уведомлений: там ссылка сервера
 * переводится в маршрут с учётом роли (lib/api/notifications.ts) — воркер
 * роли не знает, и вести подрядчика на экран сделки пары нельзя.
 */
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const target = new URL('./notifications', self.registration.scope).toString()
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const own = list.find((c) => c.url.startsWith(self.registration.scope))
    if (own) return (own.navigate ? own.navigate(target) : Promise.resolve(own)).then((c) => (c || own).focus()).catch(() => own.focus())
    return self.clients.openWindow(target)
  }))
})

self.addEventListener('fetch', (e) => {
  const { request } = e
  if (request.method !== 'GET') return
  // API — только сеть. Ответы `/api/*` живут секунды: cache-first отдавал бы
  // вчерашнюю свадьбу и вчерашние очереди панели до следующей версии кэша,
  // а `Cache-Control: no-store` сервера Cache API не читает (ERR-0204).
  if (new URL(request.url).pathname.startsWith('/api/')) return
  // Навигация: network-first, офлайн — оболочка приложения (SPA)
  if (request.mode === 'navigate') {
    e.respondWith(fetch(request).catch(() => caches.match(OFFLINE_PAGE)))
    return
  }
  // Не статика — сеть без кэша, и воркер в это даже не вмешивается. Сюда
  // попадает API по любому адресу, а не только по `/api/` (см. isStaticAsset).
  if (!isStaticAsset(request)) return
  // Статика: cache-first, затем сеть с докэшированием
  e.respondWith(
    caches.match(request).then(hit => hit || fetch(request).then(res => {
      if (res.ok && !looksLikeHtmlSwap(request, res)) {
        const copy = res.clone()
        caches.open(CACHE).then(c => c.put(request, copy))
      }
      return res
    }))
  )
})
