/*
 * Мозаика команды для тестов экранов.
 *
 * Слоты приходят с сервера, а в jsdom сети нет. Здесь живая мозаика в памяти:
 * действие меняет её так же, как это сделал бы сервер, и следующее чтение
 * отдаёт новое состояние. Без этого тест проверял бы только то, что запрос
 * ушёл, — но не то, что экран показал ответ.
 *
 * Состояние плитки (`tileState`) здесь, как и на сервере, считает «сервер»:
 * мок повторяет его переходы, а не даёт экрану вычислять их самому.
 */
import type { ServerSlot } from '@/lib/api/slots'

/** Двенадцать слотов шаблона свадьбы — те же, что заводит `POST /weddings`. */
const TEMPLATE: ReadonlyArray<{ id: string; categoryId: string; label: string }> = [
  { id: 's1', categoryId: 'venue', label: 'Площадка' },
  { id: 's2', categoryId: 'photo', label: 'Фотограф' },
  { id: 's3', categoryId: 'video', label: 'Видеограф' },
  { id: 's4', categoryId: 'host', label: 'Ведущий' },
  { id: 's5', categoryId: 'florist', label: 'Флорист' },
  { id: 's6', categoryId: 'cake', label: 'Кондитер' },
  { id: 's7', categoryId: 'stylist', label: 'Стилист' },
  { id: 's8', categoryId: 'dj', label: 'DJ' },
  { id: 's9', categoryId: 'decor', label: 'Декоратор' },
  { id: 's10', categoryId: 'transport', label: 'Транспорт' },
  { id: 's11', categoryId: 'dress', label: 'Платье' },
  { id: 's12', categoryId: 'rings', label: 'Кольца' },
]

let mosaic: ServerSlot[] = []

/** Мозаика на старте теста: всё пусто, кроме перечисленных броней. */
export function resetSlots(booked: Record<string, string> = { s1: 'Усадьба Белый Сад' }): void {
  mosaic = TEMPLATE.map(t => booked[t.id]
    ? { ...t, tileState: 'booked' as const, deal: { id: `d-${t.id}`, state: 'booked' as const, vendor: { id: `v-${t.id}`, name: booked[t.id] }, price: { amount: 4_500_000, currency: 'RUB' } } }
    : { ...t, tileState: 'empty' as const, deal: null })
}

const find = (slotId: string) => mosaic.find(s => s.id === slotId)

/**
 * Вход в аккаунт со свадьбой.
 *
 * Мозаика закрыта двумя условиями: человек вошёл и свадьба выбрана. Тест,
 * который забыл про любое из них, получит пустой экран и упадёт не там, где
 * ошибка.
 */
export function authorize(weddingId = 'w1'): void {
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  localStorage.setItem('tt_wedding_id', JSON.stringify(weddingId))
}

/*
 * Ответы `@/lib/api/weddingData` в части мозаики.
 *
 * Отдаём копию, а не саму мозаику: React сравнивает состояние по ссылке, и
 * тот же массив после действия не вызвал бы перерисовку — экран показывал бы
 * старые плитки при верных данных.
 */
export const slotsRead = { getSlots: async () => mosaic.map(s => ({ ...s })) }

/** Ответы `@/lib/api/slots`: те же переходы состояний, что делает сервер. */
export const slotsWrite = {
  bookSlot: async (_w: string, slotId: string, vendorId: string, price: number) => {
    const s = find(slotId)
    if (s) { s.tileState = 'booked'; s.deal = { id: `d-${slotId}`, state: 'booked', vendor: { id: vendorId, name: `Подрядчик ${vendorId}` }, price: { amount: price, currency: 'RUB' } } }
  },
  cancelSlot: async (_w: string, slotId: string) => {
    const s = find(slotId)
    if (s) { s.tileState = 'empty'; s.deal = null }
  },
  paySlotAmount: async (_w: string, slotId: string) => {
    const s = find(slotId)
    if (s) { s.tileState = 'paid'; if (s.deal) s.deal.state = 'paid_deposit' }
  },
  addExternal: async (_w: string, slotId: string, vendorName: string, price: number, phone?: string) => {
    const s = find(slotId)
    if (s) { s.tileState = 'booked'; s.deal = { id: `d-${slotId}`, state: 'booked', externalName: vendorName, externalPhone: phone ?? null, price: { amount: price, currency: 'RUB' } } }
  },
  removeExternal: async (_w: string, slotId: string) => {
    const s = find(slotId)
    if (s) { s.tileState = 'empty'; s.deal = null }
  },
  inviteExternalVendor: async () => undefined,
}

/** Ответ `POST /deals/{dealId}` — переход вперёд по цепочке состояний. */
export const dealsWrite = {
  advanceDeal: async (dealId: string, state: string) => {
    const s = mosaic.find(x => x.deal?.id === dealId)
    if (s?.deal) s.deal.state = state as NonNullable<ServerSlot['deal']>['state']
  },
}
