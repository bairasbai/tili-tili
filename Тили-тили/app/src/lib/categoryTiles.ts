/*
 * Цвет плитки категории — оформление, а не данные: сервер отдаёт id, title
 * и иконку, палитра живёт здесь. Ключи совпадают с `id` из справочника
 * категорий (миграция seed_categories).
 */
export const CATEGORY_TILE: Record<string, string> = {
  photo: 'bg-[#F2DFDC]',
  video: 'bg-[#E6EEE2]',
  venue: 'bg-[#F0DCB8]',
  host: 'bg-[#D9CCE3]',
  dj: 'bg-[#C3D5E8]',
  florist: 'bg-[#F2DFDC]',
  decor: 'bg-[#E6EEE2]',
  stylist: 'bg-[#F2DFDC]',
  catering: 'bg-[#F0DCB8]',
  light: 'bg-[#F3E3D3]',
  cake: 'bg-[#F0DCB8]',
  transport: 'bg-[#F3E3D3]',
  dress: 'bg-[#D9CCE3]',
  suit: 'bg-[#C3D5E8]',
  rings: 'bg-[#E6EEE2]',
  print: 'bg-[#F3E3D3]',
  photobooth: 'bg-[#F2DFDC]',
  firework: 'bg-[#D9CCE3]',
  reels: 'bg-[#F2DFDC]',
  painter: 'bg-[#E6EEE2]',
  nanny: 'bg-[#F3E3D3]',
  bar: 'bg-[#D9CCE3]',
  dance: 'bg-[#C3D5E8]',
  agency: 'bg-[#F2DFDC]',
  rental: 'bg-[#E6EEE2]',
  ceremony: 'bg-[#E6EEE2]',
  hair: 'bg-[#F2DFDC]',
  coordinator: 'bg-[#F0DCB8]',
  show: 'bg-[#D9CCE3]',
  staff: 'bg-[#C3D5E8]',
  accessories: 'bg-[#F3E3D3]',
  hotel: 'bg-[#C3D5E8]',
  honeymoon: 'bg-[#E6EEE2]',
  vykup: 'bg-[#F2DFDC]',
  registrar: 'bg-[#F0DCB8]',
}

/** Плитка для неизвестной категории: справочник может вырасти без выката фронта. */
export const DEFAULT_TILE = 'bg-[var(--rose-soft)]'
