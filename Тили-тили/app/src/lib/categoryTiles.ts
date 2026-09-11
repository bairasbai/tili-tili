/*
 * Цвет плитки категории — оформление, а не данные: сервер отдаёт id, title
 * и иконку, палитра живёт здесь. Ключи совпадают с `id` из справочника
 * категорий (миграция seed_categories).
 *
 * Плитки — токены палитры (`index.css`), а не hex: шесть оттенков, которыми
 * они были записаны, — это ровно `--rose-soft`, `--sage-soft`, `--honey`,
 * `--lav`, `--blue` и `--peach`, и с токенами плитки живут и в тёмной теме
 * (ревью D5-27, R-01).
 */
export const CATEGORY_TILE: Record<string, string> = {
  photo: 'bg-[var(--rose-soft)]',
  video: 'bg-[var(--sage-soft)]',
  venue: 'bg-[var(--honey)]',
  host: 'bg-[var(--lav)]',
  dj: 'bg-[var(--blue)]',
  florist: 'bg-[var(--rose-soft)]',
  decor: 'bg-[var(--sage-soft)]',
  stylist: 'bg-[var(--rose-soft)]',
  catering: 'bg-[var(--honey)]',
  light: 'bg-[var(--peach)]',
  cake: 'bg-[var(--honey)]',
  transport: 'bg-[var(--peach)]',
  dress: 'bg-[var(--lav)]',
  suit: 'bg-[var(--blue)]',
  rings: 'bg-[var(--sage-soft)]',
  print: 'bg-[var(--peach)]',
  photobooth: 'bg-[var(--rose-soft)]',
  firework: 'bg-[var(--lav)]',
  reels: 'bg-[var(--rose-soft)]',
  painter: 'bg-[var(--sage-soft)]',
  nanny: 'bg-[var(--peach)]',
  bar: 'bg-[var(--lav)]',
  dance: 'bg-[var(--blue)]',
  agency: 'bg-[var(--rose-soft)]',
  rental: 'bg-[var(--sage-soft)]',
  ceremony: 'bg-[var(--sage-soft)]',
  hair: 'bg-[var(--rose-soft)]',
  coordinator: 'bg-[var(--honey)]',
  show: 'bg-[var(--lav)]',
  staff: 'bg-[var(--blue)]',
  accessories: 'bg-[var(--peach)]',
  hotel: 'bg-[var(--blue)]',
  honeymoon: 'bg-[var(--sage-soft)]',
  vykup: 'bg-[var(--rose-soft)]',
  registrar: 'bg-[var(--honey)]',
}

/** Плитка для неизвестной категории: справочник может вырасти без выката фронта. */
export const DEFAULT_TILE = 'bg-[var(--rose-soft)]'
