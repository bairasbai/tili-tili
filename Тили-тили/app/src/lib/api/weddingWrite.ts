import { api, newIdempotencyKey, url } from './client'
import type { components } from './schema'

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

export type TaskDraft = components['schemas']['TaskCreate']
export type TaskPatch = components['schemas']['TaskPatch']

export const addTask = (weddingId: string, draft: TaskDraft) =>
  api.post(url('/weddings/{weddingId}/tasks', { weddingId }), draft)

export const patchTask = (weddingId: string, taskId: string, patch: TaskPatch) =>
  api.patch(url('/weddings/{weddingId}/tasks/{taskId}', { weddingId, taskId }), patch)

export const setTaskDone = (weddingId: string, taskId: string, done: boolean) =>
  patchTask(weddingId, taskId, { done })

export const deleteTask = (weddingId: string, taskId: string) =>
  api.delete(url('/weddings/{weddingId}/tasks/{taskId}', { weddingId, taskId }))

/**
 * Переименовать задачу (фича 008, деталь задачи).
 *
 * `PATCH { title }` в контракте был с самого начала, а экран умел только
 * ставить галочку: опечатка в своей задаче жила до удаления. Шаблонные
 * задачи сервер переименовывать тоже даёт — удалять их нельзя (409
 * `system_task`), поэтому у них «Переименовать» есть, а «Удалить» нет.
 */
export const renameTask = (weddingId: string, taskId: string, title: string) =>
  patchTask(weddingId, taskId, { title })

/* ── Гости ── */

export interface GuestDraft {
  name: string
  plusOne?: boolean
  members?: { name: string }[]
  group?: string
  /** E.164 (`+7…`) — для SMS-напоминаний; вводит пара. */
  phone?: string
}

export const addGuest = (weddingId: string, draft: GuestDraft) =>
  api.post(url('/weddings/{weddingId}/guests', { weddingId }), {
    name: draft.name,
    ...(draft.plusOne !== undefined ? { plusOne: draft.plusOne } : {}),
    ...(draft.members?.length ? { members: draft.members } : {}),
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

/** Добавить отдельную персону в уже существующее семейное приглашение. */
export const addGuestMember = (weddingId: string, primaryGuestId: string, name: string) =>
  api.post(
    url('/weddings/{weddingId}/guests/{guestId}/members', { weddingId, guestId: primaryGuestId }),
    { name },
  )


/** Одна строка вставленного списка гостей — уже разобранная экраном (`lib/guestsImport.ts`). */
export type GuestImportRow = { name: string; phone?: string; plusOne?: boolean; members?: { name: string }[]; group?: string }

/**
 * Завести гостей списком (контракт v0.31.0, фича 008).
 *
 * Один запрос на весь список, до 300 строк: сервер заводит их одной
 * транзакцией под замком свадьбы, сам приводит телефон к `+7…` и сам решает,
 * что дубликат — по имени без регистра и пробелов или по телефону, с уже
 * заведёнными гостями и с более ранней строкой того же списка. Пропущенные
 * приходят в `skipped` с причиной; итог на экране — только из этого ответа,
 * не из предпросмотра (инвариант §5.13).
 */
export const importGuests = (weddingId: string, guests: GuestImportRow[]) =>
  api.post(url('/weddings/{weddingId}/guests/import', { weddingId }), { guests })

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

/**
 * Переименовать стол или сменить вместимость (контракт v0.29.0, фича 005).
 *
 * До этого промах по «Добавить стол» жил в рассадке навсегда: ни переименовать,
 * ни убрать. Вместимость меньше числа уже посаженных — 409 `table_full`,
 * текст сервера показывается под кнопкой.
 */
export const patchTable = (weddingId: string, tableId: string, patch: { name?: string; capacity?: number }) =>
  api.patch(url('/weddings/{weddingId}/tables/{tableId}', { weddingId, tableId }), patch)

/** Удалить стол: гости с него уходят в «без стола» на сервере. */
export const deleteTable = (weddingId: string, tableId: string) =>
  api.delete(url('/weddings/{weddingId}/tables/{tableId}', { weddingId, tableId }))

/* ── Тайминг ── */

export interface TimelineDraft {
  outdoor?: boolean
  id?: string
  name: string
  startsAt: string
  endsAt?: string
  who?: string
  location?: string
  icon?: string
  /**
   * Видят ли блок гости в день X (`TimelineEvent.forGuests`, контракт
   * v0.32.0, фича 009). Обязательное, а не `?`: тайминг пишется списком
   * целиком, и блок без поля сервер вернул бы к умолчанию «виден» — снятая
   * галочка у «Сборов невесты» воскресала бы при следующей правке соседа.
   */
  forGuests: boolean
  /** fixed — Day X shift/автопересчёт не двигает этот блок. */
  timingMode: 'fixed' | 'flexible'
  /** Структурированные ответственные из команды свадьбы. */
  assigneeUserIds: string[]
  /** Забронированные/активные сделки-исполнители. */
  dealIds: string[]
  /** Предыдущие блоки + дорога и явный временной запас. */
  dependsOn: { eventId: string; travelMinutes: number; bufferMinutes: number }[]
}

/**
 * Заменить тайминг целиком.
 *
 * Контракт умеет только замену списком: отдельного пути «сдвинуть один блок»
 * нет, есть общий сдвиг (`/timeline/shift`). Поэтому экран отправляет весь
 * список — и обязан отправлять его полным, иначе пропущенные блоки исчезнут.
 */
export const putTimeline = (
  weddingId: string,
  events: TimelineDraft[],
  ifMatch: string,
  onEtag?: (etag: string | null) => void,
) =>
  api.put(url('/weddings/{weddingId}/timeline', { weddingId }), events, { ifMatch, onEtag })

/**
 * Автоплан дня по забронированной команде.
 *
 * Возвращает предпросмотр и список конфликтов, но ничего не применяет —
 * применение это отдельный `putTimeline`.
 */
export const autogenTimeline = (weddingId: string, onEtag?: (etag: string | null) => void) =>
  api.post(url('/weddings/{weddingId}/timeline/autogen', { weddingId }), undefined, { onEtag })

/* ── Логистика ── */

/**
 * Маршрут для гостей. `dealId` — сделка с перевозчиком из слота «Транспорт»
 * (контракт v0.30.0, фича 006): по ней сервер подписывает маршрут именем
 * перевозчика и шлёт ему заметку. Без перевозчика поле не уходит вовсе —
 * у нового маршрута снимать нечего.
 */
export const addBus = (weddingId: string, name: string, from: string, time: string, seats: number, dealId?: string | null) =>
  api.post(url('/weddings/{weddingId}/logistics/buses', { weddingId }), {
    name,
    ...(from ? { from } : {}),
    ...(time ? { time } : {}),
    seats,
    ...(dealId ? { dealId } : {}),
  })

/**
 * Правка маршрута (контракт v0.30.0, фича 006).
 *
 * До этого маршрут можно было только завести и удалить — опечатка во времени
 * стоила записей гостей. Мест меньше занятых персон — 409 `bus_full`, сделка
 * не из слота «Транспорт» — 422 `not_transport`, отменённая — 409
 * `deal_cancelled`; текст сервера показывается под «Сохранить». Снятый
 * перевозчик уходит именно `null`: пропущенное поле сервер читает как «не
 * трогать» (инвариант §5.3).
 */
export const patchBus = (
  weddingId: string,
  busId: string,
  /* `from`/`time` — `null` снимает (контракт: nullable, R-17), пропуск оставляет прежнее. */
  patch: { name?: string; from?: string | null; time?: string | null; seats?: number; dealId?: string | null },
) => api.patch(url('/weddings/{weddingId}/logistics/buses/{busId}', { weddingId, busId }), patch)

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
 * Чем кончилась рассылка (ответ `broadcast` на сервере, статус 202).
 *
 * Два числа, а не одно: `recipients` — скольких гостей касается рассылка,
 * `notified` — скольким членам команды ушло уведомление в приложении. Гостям
 * не доставляется ничего: аккаунта у них нет, SMS и почта не подключены
 * (хвост владельца), а таблицу `broadcasts` не читает ни одна задача. Экран
 * обязан говорить ровно это (ревью D3-06, R-172). `debounced` — повтор в
 * окне 30 секунд, команде второй раз не писали.
 *
 * С контракта v0.29.0 тело 202 описано схемой `BroadcastResult` — тип берётся
 * оттуда, а не называется руками (фича 005).
 */
export type BroadcastResult = components['schemas']['BroadcastResult']

/** Сообщить команде о точках сбора: уведомление в приложении, гостям — нет. */
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

/** Напомнить о меню: уведомление команде в приложении, гостям — нет (см. `BroadcastResult`). */
export const remindMenuPoll = (weddingId: string) =>
  api.post(url('/weddings/{weddingId}/menu-poll/remind', { weddingId }), {}, { idempotencyKey: newIdempotencyKey() })

/* ── Договоры ── */

/**
 * Оформить договор по сделке из шаблона сервера.
 *
 * Стороны, дату, сумму и город подставляет сервер; в `fields` уходят ФИО
 * сторон (обязательны — без них 422 `fields_missing`) и паспортные данные.
 * По незабронированной сделке — 409 `not_booked`, команде свадьбы — 403.
 * Документ ложится в `GET /weddings/{id}/documents` черновиком новой версии.
 */
export const createContract = (dealId: string, templateCode: string, fields: Record<string, string>) =>
  api.post(url('/deals/{dealId}/contract', { dealId }), { templateCode, fields }, { idempotencyKey: newIdempotencyKey() })

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
 * Ответ на «+15 мин» и план Б (контракт v0.29.0, фича 005).
 *
 * `guestsAffected` — скольких ответивших «да» гостей касается сдвиг: им
 * сообщает команда, канала до гостей нет. Прежнее `notifiedGuests` — всегда
 * ноль (D4-18), экран его не читает.
 */
export type DayXBroadcast = components['schemas']['DayXBroadcast']

/**
 * Сдвинуть день X на N минут.
 *
 * Двигает все последующие блоки тайминга и уведомляет команду (§19.6).
 * Раньше кнопка «+15 мин» копила задержку в `tt_dayx` браузера: у пары число
 * росло, а команда о сдвиге не знала.
 */
export const shiftTimeline = (weddingId: string, minutes: number) =>
  api.post(url('/weddings/{weddingId}/timeline/shift', { weddingId }), { minutes }, { idempotencyKey: newIdempotencyKey() })

/**
 * Включить запасной сценарий: сценарий фиксируется, команда получает
 * уведомление. Тоже было тумблером в браузере. Ответ — `DayXBroadcast`
 * (v0.29.0): кого касается, чтобы команда сообщила гостям сама.
 */
export const activatePlanB = (weddingId: string, scenario = 'rain') =>
  api.post(url('/weddings/{weddingId}/planb/activate', { weddingId }), { scenario }, { idempotencyKey: newIdempotencyKey() })

export const setBudgetReserve = (weddingId: string, reserveBps: number, version: number) =>
  api.patch(url('/weddings/{weddingId}/budget/settings', { weddingId }), { reserveBps, version })
export const setBudgetCategoryLimit = (weddingId: string, categoryId: string, amount: { amount: number; currency: 'RUB' }, version: number) =>
  api.put(url('/weddings/{weddingId}/budget/categories/{categoryId}/limit', { weddingId, categoryId }), { amount, version })
export const resetBudgetCategoryLimit = (weddingId: string, categoryId: string, version: number) =>
  api.patch(url('/weddings/{weddingId}/budget/categories/{categoryId}/limit', { weddingId, categoryId }), { reset: true, version })
