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
}

export interface TimelineTemplate {
  readonly icon: string
  readonly name: string
  readonly location: string | null
  readonly startsAt: string
  readonly endsAt: string
  readonly who: string | null
  readonly sort: number
}

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
  {"title":"Забронировать площадку","monthsBefore":9,"sort":3},
  {"title":"Найти фотографа","monthsBefore":9,"sort":4},
  {"title":"Заказать приглашения","monthsBefore":9,"sort":5},
  {"title":"Примерка платья (1 из 3)","monthsBefore":9,"sort":6},
  {"title":"Дегустация меню","monthsBefore":6,"sort":7},
  {"title":"Репетиция первого танца","monthsBefore":6,"sort":8},
  {"title":"Забронировать ведущего","monthsBefore":6,"sort":9},
  {"title":"Утвердить тайминг дня","monthsBefore":3,"sort":10},
  {"title":"Финальная рассадка гостей","monthsBefore":1,"sort":11},
] as const

export const TIMELINE_TEMPLATE: readonly TimelineTemplate[] = [
  {"icon":"🌅","name":"Сборы невесты","location":null,"startsAt":"08:00","endsAt":"13:00","who":null,"sort":0},
  {"icon":"🤵","name":"Сборы жениха","location":null,"startsAt":"09:00","endsAt":"12:00","who":null,"sort":1},
  {"icon":"💍","name":"Доставка букета и деталей","location":null,"startsAt":"12:00","endsAt":"13:00","who":null,"sort":2},
  {"icon":"💐","name":"Выездная церемония","location":null,"startsAt":"16:00","endsAt":"17:00","who":null,"sort":3},
  {"icon":"🥂","name":"Банкет","location":null,"startsAt":"18:00","endsAt":"23:00","who":null,"sort":4},
  {"icon":"🎆","name":"Салют и финал","location":null,"startsAt":"22:30","endsAt":"23:00","who":null,"sort":5},
] as const

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
