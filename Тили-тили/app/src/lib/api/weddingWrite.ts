import { api, newIdempotencyKey, url } from './client'

/*
 * Запись данных свадьбы: чек-лист, гости, бюджет, столы, тайминг.
 *
 * Всё это правит общий на всю пару список, а не настройку устройства: галочку
 * ставит один, а видят оба. Поэтому после каждой записи экран перечитывает
 * список с сервера, а не подкручивает свою копию — иначе на втором телефоне
 * останется старое, и разойдётся оно молча.
 *
 * Ключа идемпотентности здесь нет намеренно: контракт требует его только на
 * необратимых действиях со сделками и деньгами. Повторно добавленный гость —
 * это лишняя строка, которую видно и легко удалить, а не потерянные деньги.
 */

/* ── Чек-лист ── */

export const addTask = (weddingId: string, title: string, period: string) =>
  api.post(url('/weddings/{weddingId}/tasks', { weddingId }), { title, period })

export const setTaskDone = (weddingId: string, taskId: string, done: boolean) =>
  api.patch(url('/weddings/{weddingId}/tasks/{taskId}', { weddingId, taskId }), { done })

export const deleteTask = (weddingId: string, taskId: string) =>
  api.delete(url('/weddings/{weddingId}/tasks/{taskId}', { weddingId, taskId }))

/* ── Гости ── */

export interface GuestDraft {
  name: string
  plusOne?: boolean
  group?: string
  /** E.164 (`+7…`) — для SMS-напоминаний; вводит пара. */
  phone?: string
}

export const addGuest = (weddingId: string, draft: GuestDraft) =>
  api.post(url('/weddings/{weddingId}/guests', { weddingId }), {
    name: draft.name,
    ...(draft.plusOne !== undefined ? { plusOne: draft.plusOne } : {}),
    ...(draft.group ? { group: draft.group } : {}),
    /* Телефон — для SMS-напоминания молчащим (`POST …/guests/remind`):
       без него у кнопки «Напомнить» не было ни одного адресата. */
    ...(draft.phone ? { phone: draft.phone } : {}),
  })

/**
 * Правка гостя. `tableId: null` — снять с места за столом.
 *
 * Снятое значение уходит именно как `null`: пропущенное поле сервер читает как
 * «не трогать», и гость остался бы сидеть за столом, с которого его убрали.
 */
export const patchGuest = (
  weddingId: string,
  guestId: string,
  patch: { name?: string; plusOne?: boolean; status?: 'yes' | 'no' | 'pending'; tableId?: string | null; phone?: string | null },
) => api.patch(url('/weddings/{weddingId}/guests/{guestId}', { weddingId, guestId }), patch)

export const deleteGuest = (weddingId: string, guestId: string) =>
  api.delete(url('/weddings/{weddingId}/guests/{guestId}', { weddingId, guestId }))

/* ── Бюджет ── */

/** Своя статья расхода. Сумма — в копейках, как её хранит сервер. */
export const addBudgetItem = (weddingId: string, title: string, amount: number, categoryId: string) =>
  api.post(url('/weddings/{weddingId}/budget/items', { weddingId }), {
    title,
    amount: { amount, currency: 'RUB' },
    categoryId,
  })

export const deleteBudgetItem = (weddingId: string, itemId: string) =>
  api.delete(url('/weddings/{weddingId}/budget/items/{itemId}', { weddingId, itemId }))

/* ── Столы ── */

export const getTables = (weddingId: string) =>
  api.get(url('/weddings/{weddingId}/tables', { weddingId }))

/** Стол. Поле вместимости в контракте называется `capacity`, не `seats`. */
export const addTable = (weddingId: string, name: string, capacity: number) =>
  api.post(url('/weddings/{weddingId}/tables', { weddingId }), { name, capacity })

/* ── Тайминг ── */

export interface TimelineDraft {
  id?: string
  name: string
  startsAt: string
  endsAt?: string
  who?: string
  location?: string
  icon?: string
}

/**
 * Заменить тайминг целиком.
 *
 * Контракт умеет только замену списком: отдельного пути «сдвинуть один блок»
 * нет, есть общий сдвиг (`/timeline/shift`). Поэтому экран отправляет весь
 * список — и обязан отправлять его полным, иначе пропущенные блоки исчезнут.
 */
export const putTimeline = (weddingId: string, events: TimelineDraft[]) =>
  api.put(url('/weddings/{weddingId}/timeline', { weddingId }), events)

/**
 * Автоплан дня по забронированной команде.
 *
 * Возвращает предпросмотр и список конфликтов, но ничего не применяет —
 * применение это отдельный `putTimeline`.
 */
export const autogenTimeline = (weddingId: string) =>
  api.post(url('/weddings/{weddingId}/timeline/autogen', { weddingId }))

/* ── Логистика ── */

export const addBus = (weddingId: string, name: string, from: string, time: string, seats: number) =>
  api.post(url('/weddings/{weddingId}/logistics/buses', { weddingId }), {
    name,
    ...(from ? { from } : {}),
    ...(time ? { time } : {}),
    seats,
  })

export const deleteBus = (weddingId: string, busId: string) =>
  api.delete(url('/weddings/{weddingId}/logistics/buses/{busId}', { weddingId, busId }))

export const addHotel = (weddingId: string, name: string, rooms: number, price?: number, deadline?: string, promo?: string) =>
  api.post(url('/weddings/{weddingId}/logistics/hotels', { weddingId }), {
    name,
    rooms,
    ...(price != null ? { price: { amount: price, currency: 'RUB' } } : {}),
    ...(deadline ? { deadline } : {}),
    ...(promo ? { promo } : {}),
  })

export const deleteHotel = (weddingId: string, hotelId: string) =>
  api.delete(url('/weddings/{weddingId}/logistics/hotels/{hotelId}', { weddingId, hotelId }))

/**
 * Разослать точки сбора записавшимся.
 *
 * Рассылка идёт очередью, ответ — 202: «принято», а не «доставлено». Экран
 * обязан говорить именно так, иначе обещает то, чего ещё не случилось.
 */
export const notifyPickup = (weddingId: string) =>
  api.post(url('/weddings/{weddingId}/logistics/notify-pickup', { weddingId }), {}, { idempotencyKey: newIdempotencyKey() })

/* ── Опрос по меню ── */

export interface MenuOptionDraft { id?: string; name: string }

/** Опрос заменяется целиком: отдельного пути «добавить вариант» контракт не знает. */
export const putMenuPoll = (weddingId: string, question: string, options: MenuOptionDraft[], sent?: boolean) =>
  api.put(url('/weddings/{weddingId}/menu-poll', { weddingId }), {
    question,
    options,
    ...(sent !== undefined ? { sent } : {}),
  })

export const remindMenuPoll = (weddingId: string) =>
  api.post(url('/weddings/{weddingId}/menu-poll/remind', { weddingId }), {}, { idempotencyKey: newIdempotencyKey() })

/** Одноразовая ссылка-приглашение конкретному гостю. */
export const guestInviteLink = (weddingId: string, guestId: string) =>
  api.post(url('/weddings/{weddingId}/guests/{guestId}/invite-link', { weddingId, guestId }), {}) as Promise<{ url?: string; expiresAt?: string } | undefined>

/**
 * Напомнить тем, кто не ответил на приглашение.
 *
 * Одно СМС каждому молчащему с телефоном — раньше пара обходила список руками.
 * Гостю, чья личная ссылка уже открыта, отсюда не пишут: новая ссылка гасит
 * его токен и уводит за собой всё, что он выбрал (§9). Сервер называет такие
 * случаи отдельным числом, а не прячет их в «отправлено».
 */
export const remindGuests = (weddingId: string) =>
  api.post(url('/weddings/{weddingId}/guests/remind', { weddingId }), {})

/**
 * Сдвинуть день X на N минут.
 *
 * Двигает все последующие блоки тайминга и рассылает команде и гостям (§19.6).
 * Раньше кнопка «+15 мин» копила задержку в `tt_dayx` браузера: у пары число
 * росло, а команда о сдвиге не знала.
 */
export const shiftTimeline = (weddingId: string, minutes: number) =>
  api.post(url('/weddings/{weddingId}/timeline/shift', { weddingId }), { minutes }, { idempotencyKey: newIdempotencyKey() })

/**
 * Включить запасной сценарий: тайминг пересобирается, команда и гости получают
 * новую точку сбора. Тоже было тумблером в браузере.
 */
export const activatePlanB = (weddingId: string, scenario = 'rain') =>
  api.post(url('/weddings/{weddingId}/planb/activate', { weddingId }), { scenario }, { idempotencyKey: newIdempotencyKey() })
