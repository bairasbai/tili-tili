import { ApiError } from '@/lib/api/client'
/*
 * Каталог для тестов экранов.
 *
 * Экраны каталога ходят в сеть, а в jsdom сети нет. Здесь один набор ответов
 * на всех: раньше каждый тест опирался на `lib/data.ts`, и правка мока ломала
 * половину набора разом.
 *
 * Данные намеренно скупые — ровно то, что проверяют экраны: имя, категория,
 * цена, отзывы, признак проверки, пакеты и телефон. Всё остальное сервер
 * отдаёт, но ни один тест на это не смотрит.
 */

export const CATEGORIES = [
  { id: 'photo', title: 'Фотограф', icon: '📸' },
  { id: 'video', title: 'Видеооператор', icon: '🎥' },
]

/* Суммы в копейках — как их отдаёт сервер и как их ждёт `fmt()`. */
export const VENDOR = {
  id: 'v1',
  name: 'Елена Смирнова',
  categoryId: 'photo',
  city: 'Уфа',
  priceFrom: { amount: 8_500_000, currency: 'RUB' },
  rating: 4.9,
  reviewsCount: 47,
  verified: true,
  hasVideo: true,
}

export const VENDOR_DETAIL = {
  ...VENDOR,
  about: 'Светлый живой стиль, ловлю эмоции, а не постановку.',
  /* Телефон приходит заполненным только паре с бронью — до неё сервер шлёт
     null, и экран показывает объяснение вместо номера. */
  phone: null as string | null,
  gallery: ['a', 'b', 'c'],
  packages: [
    { id: 'p1', name: 'Утро и церемония', price: { amount: 4_500_000, currency: 'RUB' }, includes: ['6 часов съёмки'] },
    { id: 'p2', name: 'Полный день', price: { amount: 8_500_000, currency: 'RUB' }, includes: ['12 часов съёмки'] },
    { id: 'p3', name: 'Люкс', price: { amount: 13_000_000, currency: 'RUB' }, includes: ['2 фотографа'] },
  ],
}

/** Тот же подрядчик, но с открытым номером: пара его уже забронировала. */
export const VENDOR_DETAIL_BOOKED = { ...VENDOR_DETAIL, phone: '+7 917 340-11-08' }

export function catalogMock(detail: typeof VENDOR_DETAIL = VENDOR_DETAIL) {
  return {
    getCategories: async () => CATEGORIES,
    getVendors: async () => ({ items: [VENDOR] }),
    /* Анкета отвечает по идентификатору, а не всем одинаково: иначе тест не
       отличит «открыли другого подрядчика» от «остались на прежнем». */
    getVendor: async (id: string) => {
      if (id !== detail.id) throw new ApiError('http', 404, 'not_found', 'Анкета не найдена')
      return detail
    },
    getAvailability: async () => ({ busyDates: [] as string[] }),
    getFavorites: async () => [VENDOR],
    addFavorite: async () => undefined,
    removeFavorite: async () => undefined,
  }
}
