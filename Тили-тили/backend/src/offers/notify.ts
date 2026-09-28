import { notify, notifyWedding } from '../notify/notify.js'
import type { Queryable } from '../plugins/db.js'

export type VendorOfferEvent =
  | 'created'
  | 'removed'
  | 'booked_other'
  | 'wedding_cancelled'
  | 'date_changed'

export type CoupleOfferEvent = 'offer' | 'decline'

const VENDOR_COPY: Record<VendorOfferEvent, { title: string; body: string }> = {
  created: {
    title: 'Новый запрос предложения',
    body: 'Пара ждёт ваше предложение.',
  },
  removed: {
    title: 'Запрос предложения отозван',
    body: 'Пара отозвала запрос предложения.',
  },
  booked_other: {
    title: 'Пара выбрала другого исполнителя',
    body: 'Запрос предложения закрыт: пара выбрала другого исполнителя.',
  },
  wedding_cancelled: {
    title: 'Свадьба отменена',
    body: 'Пара отменила свадьбу, запрос предложения закрыт.',
  },
  date_changed: {
    title: 'Дата свадьбы изменилась',
    body: 'Пара перенесла дату, запрос предложения закрыт.',
  },
}

const COUPLE_COPY: Record<CoupleOfferEvent, { title: string; body: string }> = {
  offer: {
    title: 'Новое предложение',
    body: 'Подрядчик прислал предложение.',
  },
  decline: {
    title: 'Ответ на запрос предложения',
    body: 'Подрядчик отказался от запроса.',
  },
}

/**
 * Уведомления подрядчику не называют свадьбу, других кандидатов и условия.
 * Вызывающий передаёт транзакционный client: строка уведомления появляется
 * только вместе с изменением запроса, которое её вызвало.
 */
export async function notifyVendorOfferEvent(
  client: Queryable,
  userId: string,
  weddingTz: string | null,
  event: VendorOfferEvent,
): Promise<void> {
  await notify(
    client,
    {
      userId,
      kind: 'deal',
      ...VENDOR_COPY[event],
      link: '/vendor/offer-requests',
      critical: false,
    },
    new Date(),
    weddingTz,
  )
}

/**
 * Цена, состав и произвольный текст ответа остаются внутри запроса. Новость
 * паре сообщает только тип ответа и ведёт на место свадьбы; helper и
 * coordinator намеренно исключены ролью.
 */
export async function notifyCoupleOfferEvent(
  client: Queryable,
  weddingId: string,
  slotId: string,
  _weddingTz: string | null,
  event: CoupleOfferEvent,
): Promise<void> {
  await notifyWedding(
    client,
    weddingId,
    null,
    {
      kind: 'deal',
      ...COUPLE_COPY[event],
      link: `/wedding/slot/${slotId}`,
      critical: false,
    },
    new Date(),
    false,
    ['couple'],
  )
}
