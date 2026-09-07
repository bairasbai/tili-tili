import { api, url } from './client'
import type { components, paths } from './schema'

/*
 * Панель сотрудника платформы (План §19.10).
 *
 * Одиннадцать операций контракта и ни одного локального типа: всё, что здесь
 * описано, выведено из `schema.ts`. Своя копия схемы разъезжается с сервером
 * молча — экран продолжает собираться, а поля в ответе уже другие.
 *
 * Права проверяет сервер: на каждый из этих адресов посторонний получает 403,
 * и экран показывает отказ, а не пустоту с нулями.
 */

export type AdminMetrics = components['schemas']['AdminMetrics']
export type VerificationItem = components['schemas']['VerificationItem']
export type VerificationRequest = components['schemas']['VerificationRequest']
export type ModerationVendor = components['schemas']['ModerationVendor']
export type ModerationVendorPage = components['schemas']['ModerationVendorPage']
export type Complaint = components['schemas']['Complaint']
export type AdminCategory = components['schemas']['AdminCategory']
export type AdminCategories = components['schemas']['AdminCategories']
export type WeddingSupportCard = components['schemas']['WeddingSupportCard']

/**
 * Тело сохранения справочника — из контракта, а не своё.
 *
 * У тела `PUT` схемы в `components` нет, поэтому тип берётся прямо из пути.
 * Своя копия («categories, synonyms, и, кажется, версия») разошлась бы с
 * сервером молча: поле с опечаткой ушло бы в запрос, сервер отбросил бы его
 * как лишнее, а проверка версии тихо не состоялась бы.
 */
export type AdminCategoriesBody = paths['/admin/categories']['put']['requestBody']['content']['application/json']

/**
 * Строка запроса страницы.
 *
 * Адрес собирается вручную, а не через `url()`: тот подставляет значения в
 * фигурные скобки пути, а здесь строка запроса. Ключ в типах остаётся прежним,
 * поэтому проверка контракта не теряется (приём из `lib/api/catalog.ts`).
 */
function pageQuery(cursor?: string | null): string {
  const p = new URLSearchParams()
  if (cursor) p.set('cursor', cursor)
  return p.toString()
}

/* ── дашборд ── */

export const getAdminMetrics = () => api.get('/admin/metrics')

/* ── очередь анкет ── */

/** Опубликованные и ещё не проверенные анкеты, старейшие сверху. */
export const getModerationQueue = (cursor?: string | null) =>
  api.get(`/admin/moderation/vendors?${pageQuery(cursor)}` as '/admin/moderation/vendors')

/**
 * Решение по анкете.
 *
 * `reject` без причины сервер не принимает: снятие с публикации без объяснения
 * подрядчику нечем исправить. Причина уходит ему в уведомлении.
 */
export const decideVendor = (vendorId: string, action: 'approve' | 'reject' | 'verify', reason?: string) =>
  api.post(url('/admin/moderation/vendors/{vendorId}', { vendorId }), {
    action,
    ...(reason ? { reason } : {}),
  })

/* ── очередь заявок на верификацию ── */

/**
 * Заявки на проверку документов, старейшие сверху.
 *
 * Ни ссылки на документ, ни ИНН в списке нет — их отдаёт только карточка, и
 * только с записью в журнал. Список знает лишь `hasFile`: есть ли что открывать.
 */
export const getVerifications = (cursor?: string | null) =>
  api.get(`/admin/verifications?${pageQuery(cursor)}` as '/admin/verifications')

/**
 * Карточка заявки.
 *
 * Каждый такой запрос сервер пишет в журнал действий (`verification.view`):
 * открытие документов должно быть проверяемым, а не просто возможным.
 */
export const getVerification = (requestId: string) =>
  api.get(url('/admin/verifications/{requestId}', { requestId }))

/**
 * Решение по заявке.
 *
 * `approve` здесь — «документы сверены», а не «анкета проверена»: это разные
 * решения и разные пути. `reject` без непустой причины сервер не принимает
 * (422): отказ без объяснения подрядчику нечем исправить.
 */
export const decideVerification = (requestId: string, action: 'approve' | 'reject', reason?: string) =>
  api.post(url('/admin/verifications/{requestId}', { requestId }), {
    action,
    ...(reason ? { reason } : {}),
  })

/* ── очередь жалоб ── */

export const getComplaints = (cursor?: string | null) =>
  api.get(`/admin/complaints?${pageQuery(cursor)}` as '/admin/complaints')

/**
 * Решение по жалобе.
 *
 * Набор санкций зависит от цели: неприменимую сервер отвергает (422), поэтому
 * экран и не предлагает того, чего не будет. Заметка остаётся в журнале —
 * нарушителю она не уходит.
 */
export const decideComplaint = (
  complaintId: string,
  action: 'dismiss' | 'warn' | 'downrank' | 'block',
  note?: string,
) => api.post(url('/admin/complaints/{complaintId}', { complaintId }), { action, ...(note ? { note } : {}) })

/* ── категории и словарь синонимов ── */

/** Текущее состояние справочника: то, что заменит следующий `putAdminCategories`. */
export const getAdminCategories = () => api.get('/admin/categories')

/**
 * Сохранение справочника.
 *
 * Словарь заменяется ЦЕЛИКОМ: чего не прислали, того больше нет. Поэтому тело
 * собирается от прочитанного, а не от того, что человек успел изменить.
 *
 * `version` — та версия, с которой начата правка (её отдаёт `GET`). Не
 * совпала с текущей — 409 `categories_stale`, и на сервере не меняется
 * ничего: иначе сохранение затёрло бы чужую правку строками, которых
 * сотрудник не видел. Без поля сервер сохраняет без проверки.
 */
export const putAdminCategories = (body: AdminCategoriesBody) => api.put('/admin/categories', body)

/* ── карточка свадьбы по обращению ── */

/**
 * Просмотр чужой свадьбы поддержкой.
 *
 * Причина обязательна (5–500 знаков) и уходит в журнал вместе с именем
 * сотрудника: смотреть по обращению, а не из любопытства, — это должно быть
 * проверяемо (План §19.10 п. 5).
 */
export function getWeddingForSupport(weddingId: string, reason: string) {
  const path = url('/admin/weddings/{weddingId}', { weddingId })
  return api.get(`${path}?reason=${encodeURIComponent(reason)}` as typeof path)
}
