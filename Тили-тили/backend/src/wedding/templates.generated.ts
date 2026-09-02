/* СГЕНЕРИРОВАНО. Не править руками — правится app/src/lib/data.ts,
 * потом `pnpm run gen:templates`. */

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
