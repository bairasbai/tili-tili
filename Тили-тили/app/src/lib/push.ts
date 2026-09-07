import { api } from './api/client'
import { t } from './i18n'

/*
 * Web Push на этом устройстве.
 *
 * До аудита 2026-09-07 (блок 8) клиентской половины push не было вовсе:
 * сервер умел принять подписку и разослать (`notify/push.ts`), а приложение
 * никогда не подписывалось и сервис-воркер не показывал уведомления. Владелец
 * добавил бы ключи VAPID — и ничего бы не изменилось.
 *
 * Публичный ключ приходит в сборку переменной `VITE_VAPID_PUBLIC_KEY` (пара к
 * `VAPID_PUBLIC_KEY` бэкенда). Пока её нет, экран честно говорит, что push
 * появится с ключами; сервер без своих ключей отвечает 501 `push_not_configured`.
 */
export type DevicePushState = 'unsupported' | 'no-key' | 'denied' | 'on' | 'off'

/** Ключ читается при вызове, а не при загрузке модуля: тесты подставляют его через окружение. */
export const vapidPublicKey = (): string | null =>
  ((import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) ?? '').trim() || null

/** base64url → байты для `applicationServerKey`. */
function toKeyBytes(base64url: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4)
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes.buffer
}

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

export async function devicePushState(): Promise<DevicePushState> {
  if (!pushSupported()) return 'unsupported'
  if (!vapidPublicKey()) return 'no-key'
  if (Notification.permission === 'denied') return 'denied'
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  return sub ? 'on' : 'off'
}

/**
 * Включить: разрешение браузера → подписка → регистрация на сервере.
 * Сервер подписку не принял (нет ключей) — снимаем её и в браузере: держать
 * подписку, о которой сервер не знает, значит показывать «включено» впустую.
 */
export async function enableDevicePush(): Promise<void> {
  if (!pushSupported()) throw new Error(t('Этот браузер не умеет push'))
  const key = vapidPublicKey()
  if (!key) throw new Error(t('Ключ Web Push не задан в сборке'))
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error(t('Разрешение на уведомления не дано'))
  const reg = await navigator.serviceWorker.ready
  const sub = (await reg.pushManager.getSubscription())
    ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKeyBytes(key) }))
  const json = sub.toJSON()
  try {
    await api.post('/users/me/push-subscriptions', {
      endpoint: json.endpoint,
      keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
    })
  } catch (e) {
    await sub.unsubscribe().catch(() => undefined)
    throw e
  }
}

/** Выключить: и в браузере, и на сервере — отписка работает даже там, где подписка невозможна. */
export async function disableDevicePush(): Promise<void> {
  if (pushSupported()) {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    await sub?.unsubscribe().catch(() => undefined)
  }
  await api.delete('/users/me/push-subscriptions')
}
