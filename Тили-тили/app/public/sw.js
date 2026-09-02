/*
 * Тили-тили service worker: app-shell кэш, офлайн-режим.
 *
 * Все пути относительные и разрешаются от адреса самого воркера — приложение
 * может лежать в подпапке статического хостинга, и абсолютный '/' указывал бы
 * на чужой корень: кэш не наполнялся, офлайн не работал.
 */
const CACHE = 'tilitili-v2'
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg']
const OFFLINE_PAGE = new URL('./index.html', self.registration.scope).toString()

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (e) => {
  const { request } = e
  if (request.method !== 'GET') return
  // Навигация: network-first, офлайн — оболочка приложения (SPA)
  if (request.mode === 'navigate') {
    e.respondWith(fetch(request).catch(() => caches.match(OFFLINE_PAGE)))
    return
  }
  // Статика: cache-first, затем сеть с докэшированием
  e.respondWith(
    caches.match(request).then(hit => hit || fetch(request).then(res => {
      if (res.ok && new URL(request.url).origin === location.origin) {
        const copy = res.clone()
        caches.open(CACHE).then(c => c.put(request, copy))
      }
      return res
    }))
  )
})
