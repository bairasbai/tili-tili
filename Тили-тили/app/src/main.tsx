import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { appRoot } from '@/lib/i18n'
import './index.css'
import App from './App.tsx'
import { observeController, observeRegistration } from '@/lib/serviceWorkerUpdate'
import { sanitizeOfflineBootstrap } from '@/lib/offlineBootstrap'

sanitizeOfflineBootstrap()

// PWA: офлайн-режим и «установить на экран»
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  observeController(navigator.serviceWorker)
  window.addEventListener('load', () => navigator.serviceWorker.register(appRoot() + 'sw.js').then(observeRegistration).catch(() => {}))
}

/*
 * Восстановление deep-link после редиректа шима в index.html.
 *
 * В try/catch — как и запись в самом шиме: при заблокированных данных сайта
 * (Chrome «блокировать все cookie», iframe без allow-same-origin) обращение
 * к sessionStorage бросает SecurityError. Здесь это верхний уровень модуля,
 * до createRoot: без защиты React не смонтируется вовсе, и вместо приложения
 * человек получит пустую белую страницу — ErrorBoundary до неё не доживает.
 */
let redirect: string | null = null
try {
  redirect = sessionStorage.getItem('tt_redirect')
  if (redirect) sessionStorage.removeItem('tt_redirect')
} catch { /* хранилище недоступно — открываемся с текущего адреса */ }
/*
 * Восстанавливаем только путь этого сайта: `/…`, но не `//…` (ревью D6-06).
 * Запись кладёт шим из index.html, а тот берёт её из адресной строки —
 * `//evil.com/auth` там возможен. `history.replaceState` с чужим origin
 * бросает SecurityError на верхнем уровне модуля, до `createRoot`: вместо
 * приложения человек получал бы пустую страницу.
 */
if (redirect && redirect.startsWith('/') && !redirect.startsWith('//')) history.replaceState(null, '', redirect)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* basename от корня приложения: на статическом хостинге приложение может
        лежать в подпапке, и без него восстановленный deep-link не совпал бы
        ни с одним роутом и увёл бы пользователя из подпапки. */}
    <BrowserRouter basename={appRoot()}>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
