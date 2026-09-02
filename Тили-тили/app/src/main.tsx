import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { appRoot } from '@/lib/i18n'
import './index.css'
import App from './App.tsx'

// PWA: офлайн-режим и «установить на экран»
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register(appRoot() + 'sw.js').catch(() => {}))
}

// Восстановление deep-link после редиректа шима в index.html
const redirect = sessionStorage.getItem('tt_redirect')
if (redirect) {
  sessionStorage.removeItem('tt_redirect')
  history.replaceState(null, '', redirect)
}

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
