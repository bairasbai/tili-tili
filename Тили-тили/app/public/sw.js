/* Тили-тили service worker: app-shell кэш, офлайн-режим */
const CACHE = 'tilitili-v1'
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (e) => {
  const { request } = e
  if (request.method !== 'GET') return
  // Навигация: network-first, офлайн — index.html (SPA)
  if (request.mode === 'navigate') {
    e.respondWith(fetch(request).catch(() => caches.match('/index.html')))
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
