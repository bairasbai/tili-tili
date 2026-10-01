import { isRealDate } from '../wedding/dates.js'

/** Suggestions describe the work; they never reserve capacity or assign duties. */
export const EXECUTION_KINDS = Object.freeze(['timed_service', 'supply', 'rental', 'deliverable', 'appointment'] as const)
export type ExecutionKind = typeof EXECUTION_KINDS[number]
export type BriefFieldType = 'string' | 'string_array' | 'integer' | 'boolean' | 'date'
export interface BriefField {
  readonly key: string
  /** Russian translation key, translated by the consuming UI. */
  readonly label: string
  readonly type: BriefFieldType
  readonly group: 'core' | 'optional'
  readonly maxLength?: number
  readonly maxItems?: number
  readonly min?: number
  readonly max?: number
  readonly options?: readonly string[]
}
export interface BriefSubtype {
  readonly id: string
  readonly label: string
  readonly suggestedKinds: readonly ExecutionKind[]
  readonly fields: readonly BriefField[]
}
export interface CategoryBrief {
  readonly categoryId: string
  readonly label: string
  readonly suggestedKinds: readonly ExecutionKind[]
  readonly fields: readonly BriefField[]
  readonly subtypes?: readonly BriefSubtype[]
  readonly autoAssign: false
}
export interface ResolvedCategoryBrief extends CategoryBrief { readonly subtypeId?: string }
export type BriefFieldErrorCode = 'unknown_category' | 'invalid_subtype' | 'invalid_brief' | 'unknown_field' | 'invalid_type' | 'too_long' | 'too_many_items' | 'out_of_range' | 'invalid_value'
export interface BriefFieldError { field: string; code: BriefFieldErrorCode }

const text = (key: string, label: string, maxLength = 500): BriefField => ({ key, label, type: 'string', group: 'core', maxLength })
const list = (key: string, label: string): BriefField => ({ key, label, type: 'string_array', group: 'core', maxLength: 200, maxItems: 40 })
const count = (key: string, label: string, max = 10_000): BriefField => ({ key, label, type: 'integer', group: 'core', min: 1, max })
const date = (key: string, label: string): BriefField => ({ key, label, type: 'date', group: 'core' })
const flag = (key: string, label: string): BriefField => ({ key, label, type: 'boolean', group: 'core' })
const choice = (key: string, label: string, options: string[]): BriefField => ({ ...text(key, label, 100), options: Object.freeze(options) })
const optional = (field: BriefField): BriefField => ({ ...field, group: 'optional' })
const fields = (values: BriefField[]): readonly BriefField[] => Object.freeze(values.map(field => Object.freeze(field)))
const subtype = (id: string, label: string, kinds: ExecutionKind[], values: BriefField[]): BriefSubtype => Object.freeze({ id, label, suggestedKinds: Object.freeze(kinds), fields: fields(values) })
const category = (categoryId: string, label: string, kinds: ExecutionKind[], values: BriefField[], subtypes?: BriefSubtype[]): CategoryBrief => Object.freeze({
  categoryId, label, suggestedKinds: Object.freeze(kinds), fields: fields(values), autoAssign: false,
  ...(subtypes ? { subtypes: Object.freeze(subtypes) } : {}),
})

const deliveryFields = [text('deliveryPlace', 'Место передачи'), text('recipient', 'Кто принимает заказ'), date('deliveryDate', 'Дата передачи'), optional(text('deliveryWindow', 'Согласованное время передачи'))]
const flowerCore = [list('items', 'Цветы и композиции'), count('quantity', 'Количество', 100_000), text('palette', 'Палитра'), text('substitutions', 'Допустимые замены')]
const flowerSupply = [...flowerCore, ...deliveryFields.map(optional)]
const flowerInstallation = [list('zones', 'Зоны оформления'), text('design', 'Согласованный эскиз'), text('access', 'Доступ для монтажа'), text('installationWindow', 'Время монтажа'), optional(text('dismantlingWindow', 'Время демонтажа')), ...flowerCore.map(optional), ...deliveryFields.map(optional)]
const childCommon = [count('childrenCount', 'Количество детей'), text('ageGroup', 'Возрастная группа'), text('adultContact', 'Ответственный взрослый'), text('workWindow', 'Время работы')]
const supervision = [...childCommon, optional(text('handover', 'Порядок передачи ребёнка взрослому', 1000))]
const entertainment = [...childCommon, optional(text('program', 'Программа развлечений', 1000))]

/** Flat draft briefs stay short: core fields first, advanced details on demand.
 * Dates/windows are agreements, not calculated availability. Existing order,
 * guest and event values should be reused by the caller instead of re-entered.
 */
export const CATEGORY_BRIEFS: readonly CategoryBrief[] = Object.freeze([
  category('photo', 'Фотограф', ['timed_service', 'deliverable'], [
    text('coverage', 'Какие события снимать'), text('photographer', 'Назначенный фотограф'), text('workWindow', 'Часы и места съёмки'), text('deliverables', 'Состав результата'), date('deliveryDate', 'Срок передачи результата'),
    optional(list('priorityShots', 'Важные кадры')), optional(text('publication', 'Условия публикации')), optional(text('reviewProcess', 'Замечания и приёмка')),
  ]),
  category('video', 'Видеооператор', ['timed_service', 'deliverable'], [
    text('coverage', 'Какие события снимать'), text('operator', 'Назначенный оператор'), text('deliverables', 'Состав материалов'), date('deliveryDate', 'Срок передачи результата'),
    optional(text('workWindow', 'Часы и места съёмки')), optional(text('audio', 'Запись звука')), optional(text('publication', 'Условия публикации')), optional(text('reviewProcess', 'Замечания и приёмка')),
  ]),
  category('venue', 'Площадка', ['timed_service', 'rental'], [
    count('capacity', 'Согласованная вместимость'), list('zones', 'Доступные зоны'), text('accessWindow', 'Время доступа и освобождения'), text('administrator', 'Контакт администратора'),
    optional(text('restrictions', 'Ограничения площадки', 1000)), optional(text('backupPlace', 'Согласованное резервное помещение')), optional(text('extras', 'Условия дополнительных услуг')),
  ]),
  category('host', 'Ведущий / Тамада', ['timed_service'], [
    text('program', 'Согласованная программа', 2000), text('names', 'Имена и произношение'), text('language', 'Язык программы'), text('workWindow', 'Начало и конец работы'),
    optional(list('excludedTopics', 'Нежелательные темы')), optional(text('djContact', 'Взаимодействие с DJ')),
  ]),
  category('dj', 'DJ / Музыканты', ['timed_service'], [
    text('performers', 'Кто выступает'), text('workWindow', 'Интервалы выступления'), list('keyTracks', 'Ключевые треки'), text('equipment', 'Оборудование и подключение', 1000),
    optional(list('excludedTracks', 'Треки и темы без включения')), optional(text('soundcheck', 'Проверка звука')), optional(text('backupContact', 'Резервный контакт')),
  ]),
  category('florist', 'Флорист', ['supply', 'timed_service', 'rental'], [...flowerSupply, ...flowerInstallation.filter(field => !flowerSupply.some(existing => existing.key === field.key)).map(optional)], [
    subtype('shop', 'Продажа и доставка цветов', ['supply'], flowerSupply),
    subtype('installation', 'Оформление площадки', ['timed_service', 'supply', 'rental'], flowerInstallation),
  ]),
  category('decor', 'Декоратор', ['timed_service', 'supply', 'rental'], [
    list('zones', 'Зоны оформления'), text('design', 'Согласованный эскиз'), text('composition', 'Состав оформления', 1000), text('installationWindow', 'Время монтажа'),
    optional(text('access', 'Доступ на площадку')), optional(text('dismantlingWindow', 'Время демонтажа')), optional(list('rentedItems', 'Арендованные элементы')),
  ]),
  category('stylist', 'Стилист / Визажист', ['appointment', 'timed_service'], [
    list('clients', 'Кому нужна услуга'), text('sequence', 'Последовательность работы'), text('readyBy', 'Согласованное время готовности'), text('specialist', 'Назначенный мастер'),
    optional(text('place', 'Место работы')), optional(text('trial', 'Проба по договорённости')),
  ]),
  category('catering', 'Кейтеринг', ['supply', 'timed_service'], [
    text('menu', 'Согласованное меню', 2000), count('portions', 'Окончательное количество порций'), text('serviceWindow', 'Время обслуживания'), text('kitchenContact', 'Ответственный кухни'),
    optional(text('menuRequirements', 'Требования к меню', 1000)), optional(text('allergenInformation', 'Информация об аллергенах от исполнителя', 1000)), optional(date('changeDeadline', 'Срок согласования изменений')), optional(text('lateChanges', 'Порядок изменений после срока')),
  ]),
  category('light', 'Свет и звук', ['rental', 'timed_service'], [
    text('equipment', 'Комплект оборудования', 1000), text('operator', 'Назначенный оператор'), text('installationWindow', 'Время монтажа'), text('soundcheck', 'Проверка работоспособности'),
    optional(text('venueRequirements', 'Потребности и ограничения площадки', 1000)), optional(text('access', 'Доступ для монтажа')), optional(text('dismantlingWindow', 'Время демонтажа')),
  ]),
  category('cake', 'Кондитер', ['supply'], [
    text('composition', 'Согласованный состав'), count('portions', 'Количество порций'), text('design', 'Согласованное оформление'), date('deliveryDate', 'Дата передачи'), text('recipient', 'Кто принимает заказ'),
    optional(text('allergenInformation', 'Информация об аллергенах от исполнителя', 1000)), optional(text('storageInstructions', 'Условия хранения от исполнителя', 1000)), optional(text('deliveryPlace', 'Место передачи')), optional(text('deliveryWindow', 'Согласованное время передачи')),
  ]),
  category('transport', 'Транспорт / Кортеж', ['timed_service'], [
    text('route', 'Маршрут и направление', 1000), date('tripDate', 'Дата рейса'), text('departureWindow', 'Время отправления'), text('driver', 'Назначенный водитель'), count('capacity', 'Количество пассажирских мест'),
    optional(text('vehicle', 'Согласованный автомобиль')), optional(list('stops', 'Остановки')), optional(text('returnTrip', 'Обратный рейс')), optional(text('backupContact', 'Резервный контакт')),
  ]),
  category('dress', 'Свадебное платье', ['supply', 'rental', 'appointment'], [
    text('item', 'Выбранное изделие'), choice('arrangement', 'Покупка или аренда', ['Покупка', 'Аренда']), text('size', 'Согласованный размер'), date('pickupDate', 'Срок выдачи'),
    optional(text('fittings', 'Примерки и доработка')), optional(date('returnDate', 'Срок возврата')), optional(text('depositTerms', 'Условия залога')),
  ]),
  category('suit', 'Костюм жениха', ['supply', 'rental', 'appointment'], [
    text('item', 'Выбранное изделие'), choice('arrangement', 'Покупка или аренда', ['Покупка', 'Аренда']), text('size', 'Согласованный размер'), date('pickupDate', 'Срок выдачи'),
    optional(text('fittings', 'Примерки и доработка')), optional(date('returnDate', 'Срок возврата')), optional(text('depositTerms', 'Условия залога')),
  ]),
  category('rings', 'Ювелир / Кольца', ['supply', 'appointment'], [
    list('items', 'Выбранные изделия'), text('sizes', 'Согласованные размеры'), date('pickupDate', 'Срок получения'), text('keeper', 'Кто хранит кольца к церемонии'),
    optional(text('engraving', 'Согласованная гравировка')), optional(text('recipient', 'Кто получает заказ')),
  ]),
  category('print', 'Полиграфия', ['supply', 'deliverable'], [
    text('layout', 'Согласованный макет'), text('proofText', 'Имена и текст для проверки', 2000), count('quantity', 'Количество экземпляров', 100_000), date('deliveryDate', 'Срок получения'),
    optional(text('approvedVersion', 'Версия макета для отдельного согласования')), optional(text('recipient', 'Кто получает заказ')),
  ]),
  category('photobooth', 'Фотобудка', ['rental', 'timed_service', 'deliverable'], [
    text('place', 'Место установки'), text('workWindow', 'Время работы'), text('equipment', 'Согласованный комплект'), text('output', 'Печать и выдача файлов'),
    optional(count('printQuantity', 'Согласованное количество отпечатков', 100_000)), optional(text('installationWindow', 'Время монтажа')), optional(text('dismantlingWindow', 'Время демонтажа')),
  ]),
  category('firework', 'Пиротехника', ['timed_service'], [
    text('operator', 'Ответственный исполнитель'), text('place', 'Согласованное место'), text('workWindow', 'Время запуска'), text('venueContact', 'Контакт для согласования с площадкой'),
    optional(text('launchConditions', 'Условия допуска от исполнителя и площадки', 1000)), optional(text('cancellationTerms', 'Условия отмены')), optional(text('decisionOwner', 'Кто принимает решение о запуске')),
  ]),
  category('reels', 'Reels-мейкер', ['timed_service', 'deliverable'], [
    text('coverage', 'Какие события снимать'), text('deliverables', 'Согласованные материалы'), date('deliveryDate', 'Срок передачи'), text('publication', 'Условия публикации'),
    optional(text('releaseWindow', 'Срок быстрых публикаций')), optional(text('reviewProcess', 'Замечания и приёмка')),
  ]),
  category('painter', 'Live Painter', ['timed_service', 'deliverable'], [
    text('subject', 'Согласованный сюжет'), text('format', 'Формат работы'), text('workWindow', 'Рабочее место и интервал'), date('deliveryDate', 'Срок передачи'),
    optional(text('recipient', 'Кто получает работу')), optional(text('reviewProcess', 'Замечания и приёмка')),
  ]),
  category('nanny', 'Аниматор / Няня', ['timed_service'], [...childCommon, ...supervision.slice(childCommon.length), ...entertainment.slice(childCommon.length)], [
    subtype('supervision', 'Присмотр за детьми', ['timed_service'], supervision),
    subtype('entertainment', 'Развлекательная программа', ['timed_service'], entertainment),
  ]),
  category('bar', 'Сомелье / Бар', ['supply', 'timed_service', 'rental'], [
    text('drinks', 'Состав напитков', 1000), text('purchaser', 'Кто закупает напитки и расходники'), text('serviceWindow', 'Время и состав обслуживания'), text('staff', 'Назначенные сотрудники'),
    optional(text('quantities', 'Согласованные объёмы')), optional(text('equipment', 'Оборудование')), optional(text('venueRules', 'Правила площадки')),
  ]),
  category('dance', 'Хореограф', ['appointment', 'deliverable'], [
    list('participants', 'Участники репетиций'), text('rehearsals', 'Согласованные репетиции'), text('music', 'Согласованная музыка'), date('readyDate', 'Срок подготовки танца'),
    optional(text('djHandover', 'Передача трека DJ')),
  ]),
  category('agency', 'Организатор', ['timed_service', 'deliverable'], [
    text('scope', 'Состав работ', 2000), text('staff', 'Ответственные сотрудники'), text('authority', 'Согласованные полномочия', 1000), text('handover', 'Передача дел'),
    optional(text('decisionLimits', 'Ограничения решений и расходов')), optional(text('replacement', 'Порядок замены сотрудников')),
  ]),
  category('rental', 'Рентал / Мебель', ['rental'], [
    list('items', 'Предметы аренды'), count('quantity', 'Общее количество предметов', 100_000), date('deliveryDate', 'Дата передачи'), date('returnDate', 'Дата возврата'), text('recipient', 'Кто принимает предметы'),
    optional(flag('deliveryRequired', 'Нужна доставка')), optional(text('deliveryPlace', 'Место передачи')), optional(text('condition', 'Согласованный порядок проверки состояния')), optional(text('depositTerms', 'Условия залога')), optional(text('disputeProcess', 'Порядок разногласий')),
  ]),
  category('ceremony', 'Площадка выездной церемонии', ['timed_service', 'rental'], [
    list('zones', 'Зоны церемонии'), count('capacity', 'Согласованная вместимость'), text('accessWindow', 'Время доступа'), text('administrator', 'Контакт площадки'),
    optional(text('accessibility', 'Доступность маршрута')), optional(text('installationWindow', 'Время монтажа')), optional(text('backupPlace', 'Согласованное резервное место')),
  ]),
  category('hair', 'Парикмахер', ['appointment', 'timed_service'], [
    list('clients', 'Кому нужна услуга'), text('sequence', 'Последовательность работы'), text('readyBy', 'Согласованное время готовности'), text('specialist', 'Назначенный мастер'),
    optional(text('place', 'Место работы')), optional(text('trial', 'Проба по договорённости')),
  ]),
  category('coordinator', 'Координатор дня', ['timed_service'], [
    text('scope', 'Обязанности координатора', 2000), text('workWindow', 'Время работы'), text('backupContact', 'Контакт дублёра'), text('handover', 'Передача ответственности'),
    optional(text('authority', 'Полномочия для отдельного приглашения', 1000)), optional(text('instructions', 'Согласованные инструкции', 2000)),
  ]),
  category('show', 'Шоу-программа / Артисты', ['timed_service'], [
    text('performers', 'Состав выступающих'), text('performanceWindow', 'Выходы и длительность'), text('preparation', 'Подготовка выступления'), text('leadContact', 'Контакт руководителя'),
    optional(text('venueRequirements', 'Требования к площадке', 1000)), optional(text('cancellationTerms', 'Условия отмены')),
  ]),
  category('staff', 'Бармены и официанты', ['timed_service'], [
    text('staff', 'Состав смены'), text('leadContact', 'Контакт руководителя'), text('workWindow', 'Места и время работы'), text('duties', 'Согласованные обязанности', 1000),
    optional(text('workingConditions', 'Согласованные бытовые условия')), optional(text('replacement', 'Порядок замены сотрудников')),
  ]),
  category('accessories', 'Аксессуары и бижутерия', ['supply', 'rental'], [
    text('item', 'Выбранное изделие'), count('quantity', 'Количество', 100_000), date('pickupDate', 'Срок получения'), text('recipient', 'Кто получает заказ'),
    optional(text('compatibility', 'Согласованные параметры совместимости')), optional(date('returnDate', 'Срок возврата')),
  ]),
  category('hotel', 'Отель для гостей', ['rental'], [
    count('rooms', 'Количество комнат'), count('occupants', 'Количество проживающих'), date('checkIn', 'Дата заезда'), date('checkOut', 'Дата выезда'), text('confirmation', 'Источник подтверждения размещения'),
    optional(text('roomAllocation', 'Распределение по комнатам', 1000)), optional(text('accommodationRequirements', 'Требования к размещению', 1000)), optional(text('hotelContact', 'Контакт отеля')),
  ]),
  category('honeymoon', 'Медовый месяц', ['appointment', 'supply'], [
    date('startDate', 'Начало поездки'), date('endDate', 'Конец поездки'), text('bookings', 'Выбранные брони', 1000), text('confirmationOwner', 'Кто подтверждает брони'),
    optional(text('documentChecklist', 'Перечень необходимых документов без реквизитов')),
  ]),
  category('vykup', 'Выкуп невесты', ['timed_service'], [
    text('program', 'Согласованная программа', 1000), text('place', 'Место проведения'), text('responsible', 'Ответственный за проведение'),
    optional(list('props', 'Реквизит')), optional(text('workWindow', 'Время проведения')),
  ]),
  category('registrar', 'Церемониймейстер', ['timed_service', 'appointment'], [
    text('format', 'Выбранный формат церемонии'), text('names', 'Имена и произношение'), text('script', 'Согласованный текст', 2000), text('workWindow', 'Место и время церемонии'),
    optional(text('rehearsal', 'Репетиция по договорённости')), optional(text('authority', 'Обязанности в выбранной церемонии')),
  ]),
])

export function getCategoryBrief(categoryId: string, subtypeId?: string): ResolvedCategoryBrief | undefined {
  const found = CATEGORY_BRIEFS.find(item => item.categoryId === categoryId)
  if (!found) return undefined
  if (subtypeId === undefined) return found
  const selected = found.subtypes?.find(item => item.id === subtypeId)
  if (!selected) return undefined
  return Object.freeze({ ...found, subtypeId, suggestedKinds: selected.suggestedKinds, fields: selected.fields })
}

// No submitted values appear in errors or descriptors. Validation never fills
// missing facts, transforms drafts, grants permissions or records acceptance.
export function validateBrief(categoryId: string, brief: unknown, subtypeId?: string): BriefFieldError[] {
  const category = getCategoryBrief(categoryId)
  if (!category) return [{ field: '$', code: 'unknown_category' }]
  const resolved = getCategoryBrief(categoryId, subtypeId)
  if (!resolved) return [{ field: '$', code: 'invalid_subtype' }]
  if (!brief || typeof brief !== 'object' || Array.isArray(brief)) return [{ field: '$', code: 'invalid_brief' }]
  const proto: unknown = Object.getPrototypeOf(brief)
  if (proto !== Object.prototype && proto !== null) return [{ field: '$', code: 'invalid_brief' }]
  const keys = Reflect.ownKeys(brief)
  if (keys.length > 64 || keys.some(key => typeof key !== 'string' || key.length > 80)) return [{ field: '$', code: 'invalid_brief' }]
  const allowed = new Map(resolved.fields.map(field => [field.key, field]))
  const errors: BriefFieldError[] = []
  for (const key of keys as string[]) {
    const field = allowed.get(key)
    if (!field) { errors.push({ field: key, code: 'unknown_field' }); continue }
    const property = Object.getOwnPropertyDescriptor(brief, key)
    if (!property || !('value' in property)) { errors.push({ field: key, code: 'invalid_type' }); continue }
    const value: unknown = property.value
    if (value === null) continue // Explicit clear; absence is an untouched draft.
    const code = validateValue(field, value)
    if (code) errors.push({ field: key, code })
  }
  return errors
}

function hasForbiddenControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true
  }
  return false
}
function validateText(field: BriefField, value: unknown): BriefFieldErrorCode | undefined {
  if (typeof value !== 'string') return 'invalid_type'
  if (value.length > (field.maxLength ?? 500)) return 'too_long'
  if (hasForbiddenControl(value)) return 'invalid_value'
  if (field.options && !field.options.includes(value)) return 'invalid_value'
  return undefined
}
function validateValue(field: BriefField, value: unknown): BriefFieldErrorCode | undefined {
  switch (field.type) {
    case 'string': return validateText(field, value)
    case 'string_array':
      if (!Array.isArray(value)) return 'invalid_type'
      if (value.length > (field.maxItems ?? 40)) return 'too_many_items'
      for (let i = 0; i < value.length; i++) {
        const code = validateText(field, value[i])
        if (code) return code
      }
      return undefined
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return 'invalid_type'
      return value < (field.min ?? 0) || value > (field.max ?? 1_000_000) ? 'out_of_range' : undefined
    case 'boolean': return typeof value === 'boolean' ? undefined : 'invalid_type'
    case 'date':
      if (typeof value !== 'string') return 'invalid_type'
      return isRealDate(value) ? undefined : 'invalid_value'
  }
}
