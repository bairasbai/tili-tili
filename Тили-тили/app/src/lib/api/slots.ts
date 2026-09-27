import { api, ApiError, newIdempotencyKey, url } from './client'

/*
 * Мозаика команды: бронь, отмена, аванс, свои подрядчики.
 *
 * Всё, что здесь есть, необратимо на той стороне: бронь занимает дату в
 * календаре подрядчика, аванс двигает деньги. Поэтому каждое такое действие
 * уходит с ключом идемпотентности — сервер по нему отличает повтор одного
 * нажатия от второго намерения.
 *
 * Состояние слота клиент не вычисляет: `tileState` приходит готовым и помечен
 * readOnly. Считать его самому значит завести второй набор правил, который
 * разойдётся с серверным на первом же непредусмотренном переходе.
 */

export interface SlotDeal {
  id?: string
  /* Шесть состояний сделки плюс отмена. Плитке хватает производного
     `tileState`, но экрану сделки нужно настоящее: `paid` в мозаике — это и
     внесённый аванс, и выполненная работа. */
  state?: 'candidate' | 'contacted' | 'negotiating' | 'booked' | 'paid_deposit' | 'done' | 'cancelled'
  vendor?: { id?: string; name?: string } | null
  externalName?: string | null
  externalPhone?: string | null
  price?: { amount?: number; currency?: string }
  /* Сколько уже внесено по сделке и когда был последний платёж. Считает
     сервер: сумма, посчитанная на клиенте, разошлась бы с его расчётом на
     первом же возврате. Приходит только тому, кто видит деньги. */
  paid?: { amount?: number; currency?: string }
  paidAt?: string | null
  /* Название пакета, по которому бронировали (контракт v0.29.0, фича 005).
     null — бронь без пакета или пакет снят с витрины; экран сделки показывает
     его только когда он есть. */
  packageName?: string | null
}

export interface ServerSlot {
  id?: string
  categoryId?: string
  label?: string
  tileState?: 'empty' | 'candidate' | 'hold' | 'booked' | 'paid'
  deal?: SlotDeal | null
  /* «Уже забронировано вне приложения» из квиза (фича 018): только у слота без сделки. */
  prebooked?: boolean
}

const slotPath = (weddingId: string, slotId: string, tail: string) =>
  url(`/weddings/{weddingId}/slots/{slotId}/${tail}` as '/weddings/{weddingId}/slots/{slotId}/book', { weddingId, slotId })

/**
 * Слот категории вне шаблона мозаики (фича 014, A1).
 *
 * Шаблон — 12 категорий, каталог знает 35: у аниматора или пиротехника места
 * в мозаике не было, и «Добавить в свадьбу» на их анкетах упиралось в надпись.
 * Слот заводит сервер; если он уже есть, сервер отвечает 409 `slot_exists` и
 * называет его в `details.slotId` — второй слот одной категории мозаике не
 * нужен, бронь идёт в существующий. Возвращает идентификатор слота, в который
 * можно бронировать.
 */
export async function ensureSlotForCategory(weddingId: string, categoryId: string): Promise<string> {
  try {
    const slot = await api.post(url('/weddings/{weddingId}/slots', { weddingId }), { categoryId })
    if (!slot?.id) throw new Error('сервер не вернул слот')
    return slot.id
  } catch (e) {
    const existing = e instanceof ApiError && e.status === 409 ? e.details.slotId : undefined
    if (typeof existing === 'string' && existing) return existing
    throw e
  }
}

/** Забронировать подрядчика из каталога. Цена — в копейках. */
export const bookSlot = (weddingId: string, slotId: string, vendorId: string, price: number, packageId?: string) =>
  api.post(
    slotPath(weddingId, slotId, 'book'),
    { vendorId, price: { amount: price, currency: 'RUB' }, ...(packageId ? { packageId } : {}) },
    { idempotencyKey: newIdempotencyKey() },
  )

/** Отменить бронь. Дата уходит обратно в календарь подрядчика. */
export const cancelSlot = (weddingId: string, slotId: string) =>
  api.post(slotPath(weddingId, slotId, 'cancel'), {}, { idempotencyKey: newIdempotencyKey() })

/**
 * Зафиксировать оплату по сделке.
 *
 * Без суммы сервер записывает всю цену сделки: путь называется «оплата
 * (доплата/полная)», а не «аванс». Первая оплата двигает сделку в
 * `paid_deposit`, дальше меняется только сумма оплаченного.
 */
export const paySlotAmount = (weddingId: string, slotId: string, amount?: number) =>
  api.post(
    slotPath(weddingId, slotId, 'pay'),
    amount != null ? { amount: { amount, currency: 'RUB' } } : {},
    { idempotencyKey: newIdempotencyKey() },
  )

/** Свой подрядчик не из каталога: имя и телефон вводит пара. */
export const addExternal = (weddingId: string, slotId: string, vendorName: string, price: number, phone?: string) =>
  api.post(
    slotPath(weddingId, slotId, 'external'),
    /* Поле называется `vendorName`, а не `name`: у своего подрядчика нет
       карточки в каталоге, и сервер отличает его именно по этому полю. */
    { vendorName, price: { amount: price, currency: 'RUB' }, ...(phone ? { phone } : {}) },
    { idempotencyKey: newIdempotencyKey() },
  )

export const removeExternal = (weddingId: string, slotId: string) =>
  api.delete(slotPath(weddingId, slotId, 'external') as '/weddings/{weddingId}/slots/{slotId}/external')

/**
 * «Нет, ещё ищем» — снять отметку «уже забронировано вне приложения» (фича 018).
 * Слот становится обычным пустым; повтор безвреден — сервер отвечает 204 и без отметки.
 */
export const unmarkPrebookedSlot = (weddingId: string, slotId: string) =>
  api.delete(slotPath(weddingId, slotId, 'prebooked') as '/weddings/{weddingId}/slots/{slotId}/prebooked')

/**
 * Позвать своего подрядчика в приложение.
 *
 * Ссылку выдаёт сервер: одноразовый токен со сроком жизни 30 дней, привязанный
 * к слоту. Собрать её на клиенте из идентификатора слота нельзя — по такой
 * ссылке никто никуда не войдёт.
 */
export const inviteExternalVendor = (weddingId: string, slotId: string) =>
  api.post(slotPath(weddingId, slotId, 'external/invite'), {}, { idempotencyKey: newIdempotencyKey() }) as Promise<{ token?: string; url?: string; expiresAt?: string } | undefined>

/** Перевести сделку в следующее состояние: контракт разрешает только вперёд. */
export const advanceDeal = (dealId: string, state: string) =>
  api.patch(url('/deals/{dealId}', { dealId }), { state }, { idempotencyKey: newIdempotencyKey() })

/**
 * Журнал сделки: переходы состояния и правки цены.
 *
 * События писались с самого начала и не читались нигде — при споре «мы
 * договаривались о другой сумме» доказательство лежало в базе. Автор назван
 * ролью: чужого имени и идентификатора здесь нет.
 */
export const getDealEvents = (dealId: string) =>
  api.get(url('/deals/{dealId}/events', { dealId }))
