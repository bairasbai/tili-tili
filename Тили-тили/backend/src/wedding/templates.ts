/* Шаблоны новой свадьбы: слоты команды, чек-лист, тайминг.
 *
 * Раньше файл собирался скриптом из мок-модели фронта (`app/src/lib/data.ts`),
 * которой нет с этапа 11 (снос моков): генератор читал пустоту, а шапка
 * запрещала правки. С фичи 005 это обычный модуль — единственный источник
 * шаблонов, правится руками; соответствие категорий справочнику держит
 * `test/stage2.test.ts`. */

export interface SlotTemplate {
  readonly categoryId: string
  readonly label: string
  readonly sort: number
}

export interface TaskTemplate {
  readonly title: string
  /** За сколько месяцев до свадьбы истекает срок. */
  readonly monthsBefore: number
  readonly sort: number
  /**
   * Категория слота, чью бронь задача означает (фича 018). Пара, ответившая в
   * квизе «уже забронировано», получает её выполненной. Связь — полем, а не
   * сверкой текста: переименованная задача не должна молча потерять смысл.
   */
  readonly categoryId?: PrebookedCategory
}

export interface TimelineTemplate {
  readonly icon: string
  readonly name: string
  readonly location: string | null
  readonly startsAt: string
  readonly endsAt: string
  readonly who: string | null
  readonly sort: number
  readonly timingMode?: 'fixed' | 'flexible'
  /** На сколько дней после даты свадьбы — второй день праздника (фича 018). Нет — в сам день. */
  readonly dayOffset?: number
}

/*
 * Коды ответов квиза (фича 018). Коды, а не подписи вариантов: подпись
 * переводится на экране, и «Классика» на другом языке стала бы другим
 * ответом. Те же списки — в контракте (`WeddingFormat`, `WeddingPlanner`,
 * `PrebookedCategory`) и в CHECK миграции 1761300000000.
 */
export const WEDDING_FORMATS = ['classic', 'outdoor', 'intimate', 'two_day'] as const
export type WeddingFormat = (typeof WEDDING_FORMATS)[number]
export const WEDDING_PLANNERS = ['self', 'agency', 'coordinator'] as const
export type WeddingPlanner = (typeof WEDDING_PLANNERS)[number]
export const PREBOOKED_CATEGORIES = ['venue', 'photo', 'video', 'host'] as const
export type PrebookedCategory = (typeof PREBOOKED_CATEGORIES)[number]

export const SLOT_TEMPLATE: readonly SlotTemplate[] = [
  {"categoryId":"venue","label":"Площадка","sort":0},
  {"categoryId":"photo","label":"Фотограф","sort":1},
  {"categoryId":"video","label":"Видеограф","sort":2},
  {"categoryId":"host","label":"Ведущий","sort":3},
  {"categoryId":"florist","label":"Флорист","sort":4},
  {"categoryId":"cake","label":"Кондитер","sort":5},
  {"categoryId":"stylist","label":"Стилист","sort":6},
  {"categoryId":"dj","label":"DJ","sort":7},
  {"categoryId":"decor","label":"Декоратор","sort":8},
  {"categoryId":"transport","label":"Транспорт","sort":9},
  {"categoryId":"dress","label":"Платье","sort":10},
  {"categoryId":"rings","label":"Кольца","sort":11},
] as const

export const TASK_TEMPLATE: readonly TaskTemplate[] = [
  {"title":"Выбрать дату свадьбы","monthsBefore":9,"sort":0},
  {"title":"Определить бюджет","monthsBefore":9,"sort":1},
  {"title":"Составить список гостей","monthsBefore":9,"sort":2},
  {"title":"Забронировать площадку","monthsBefore":9,"sort":3,"categoryId":"venue"},
  {"title":"Найти фотографа","monthsBefore":9,"sort":4,"categoryId":"photo"},
  {"title":"Заказать приглашения","monthsBefore":9,"sort":5},
  {"title":"Примерка платья (1 из 3)","monthsBefore":9,"sort":6},
  {"title":"Дегустация меню","monthsBefore":6,"sort":7},
  {"title":"Репетиция первого танца","monthsBefore":6,"sort":8},
  {"title":"Забронировать ведущего","monthsBefore":6,"sort":9,"categoryId":"host"},
  {"title":"Утвердить тайминг дня","monthsBefore":3,"sort":10},
  {"title":"Финальная рассадка гостей","monthsBefore":1,"sort":11},
] as const

export const TIMELINE_TEMPLATE: readonly TimelineTemplate[] = [
  {"icon":"🌅","name":"Сборы невесты","location":null,"startsAt":"08:00","endsAt":"13:00","who":null,"sort":0},
  {"icon":"🤵","name":"Сборы жениха","location":null,"startsAt":"09:00","endsAt":"12:00","who":null,"sort":1},
  {"icon":"💍","name":"Доставка букета и деталей","location":null,"startsAt":"12:00","endsAt":"13:00","who":null,"sort":2},
  {"icon":"💐","name":"Выездная церемония","location":null,"startsAt":"16:00","endsAt":"17:00","who":null,"sort":3,"timingMode":"fixed"},
  {"icon":"🥂","name":"Банкет","location":null,"startsAt":"18:00","endsAt":"23:00","who":null,"sort":4},
  {"icon":"🎆","name":"Салют и финал","location":null,"startsAt":"22:30","endsAt":"23:00","who":null,"sort":5},
] as const

/*
 * Слоты сверх базовых двенадцати — по ответам квиза (фича 018). Подписи —
 * названия категорий справочника, как у слота, который пара добавляет сама
 * (`POST /weddings/{id}/slots`, фича 014): одна категория — одна подпись,
 * откуда бы слот ни взялся. Места — после базовых: сначала по формату, потом
 * по «кто планирует».
 */
const FORMAT_SLOTS: Readonly<Record<WeddingFormat, readonly Omit<SlotTemplate, 'sort'>[]>> = {
  classic: [],
  outdoor: [
    { categoryId: 'ceremony', label: 'Площадка выездной церемонии' },
    { categoryId: 'registrar', label: 'Церемониймейстер' },
  ],
  intimate: [],
  two_day: [{ categoryId: 'hotel', label: 'Отель для гостей' }],
}

const PLANNER_SLOTS: Readonly<Record<WeddingPlanner, readonly Omit<SlotTemplate, 'sort'>[]>> = {
  self: [],
  agency: [{ categoryId: 'agency', label: 'Организатор' }],
  coordinator: [{ categoryId: 'coordinator', label: 'Координатор дня' }],
}

/** Мозаика новой свадьбы: базовые 12 и слоты по ответам. Без ответов — ровно базовые, как до фичи. */
export function slotTemplate(format: WeddingFormat | null, planner: WeddingPlanner | null): readonly SlotTemplate[] {
  const extra = [...(format ? FORMAT_SLOTS[format] : []), ...(planner ? PLANNER_SLOTS[planner] : [])]
  return [...SLOT_TEMPLATE, ...extra.map((s, i) => ({ ...s, sort: SLOT_TEMPLATE.length + i }))]
}

/* Блоки, которыми форматы отличаются от шаблона выше (решение владельца 2026-09-26). */
const ZAGS: TimelineTemplate = {"icon":"🏛️","name":"Регистрация в ЗАГСе","location":null,"startsAt":"14:00","endsAt":"15:00","who":null,"sort":3,"timingMode":"fixed"}
const DINNER: TimelineTemplate = {"icon":"🥂","name":"Ужин","location":null,"startsAt":"18:00","endsAt":"22:00","who":null,"sort":4}
const SECOND_DAY: readonly TimelineTemplate[] = [
  {"icon":"🥐","name":"День 2: бранч","location":null,"startsAt":"12:00","endsAt":"14:00","who":null,"sort":6,"dayOffset":1},
  {"icon":"🎉","name":"День 2: продолжение праздника","location":null,"startsAt":"14:00","endsAt":"20:00","who":null,"sort":7,"dayOffset":1},
]

/**
 * Тайминг по формату. Один выбор на двоих — создание свадьбы и первая дата
 * при переносе (`reschedule.ts`): свадьба без даты заводит блоки без времени,
 * и время им потом ставится по `sort` этого же списка. Формат не указан —
 * шаблон выше, как до фичи 018.
 */
export function timelineTemplate(format: WeddingFormat | null): readonly TimelineTemplate[] {
  switch (format) {
    case 'classic':
      return TIMELINE_TEMPLATE.map((e) => (e.name === 'Выездная церемония' ? ZAGS : e))
    case 'intimate':
      return TIMELINE_TEMPLATE.filter((e) => e.name !== 'Салют и финал').map((e) => (e.name === 'Банкет' ? DINNER : e))
    case 'two_day':
      return [...TIMELINE_TEMPLATE, ...SECOND_DAY]
    case 'outdoor':
    case null:
      return TIMELINE_TEMPLATE
  }
}

export interface BudgetCategory {
  readonly id: string
  readonly title: string
  readonly color: string
  /** Доля от общего бюджета пары: лимиты мока пересчитаны в проценты. */
  readonly share: number
}

export const BUDGET_CATEGORIES: readonly BudgetCategory[] = [
  {"id":"b1","title":"Площадка и кейтеринг","color":"#D9A8A0","share":0.459},
  {"id":"b2","title":"Фото и видео","color":"#A9BCA0","share":0.1967},
  {"id":"b3","title":"Одежда и красота","color":"#E3C892","share":0.1475},
  {"id":"b4","title":"Развлечения и декор","color":"#D9CCE3","share":0.118},
  {"id":"b5","title":"Прочее","color":"#C3D5E8","share":0.0787},
] as const

/** Категория подрядчика — строка бюджета. Неизвестная попадает в «Прочее». */
export const BUDGET_BY_VENDOR_CATEGORY: Readonly<Record<string, string>> = {
  "venue": "b1",
  "photo": "b2",
  "video": "b2",
  "dress": "b3",
  "stylist": "b3",
  "rings": "b3",
  "host": "b4",
  "dj": "b4",
  "florist": "b4",
  "decor": "b4",
  "cake": "b4",
  "transport": "b5"
}

export const BUDGET_FALLBACK = "b5"
