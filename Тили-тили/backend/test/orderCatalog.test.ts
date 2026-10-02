import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CATEGORY_BRIEFS, EXECUTION_KINDS, getCategoryBrief, validateBrief } from '../src/orders/catalog.js'

const categories: { id: string; name: string }[] = JSON.parse(readFileSync(new URL('../migrations/data/categories.json', import.meta.url), 'utf8'))

describe('profession briefs for actual wedding services', () => {
  it('covers every actual catalog category without assigning services or forcing a work kind', () => {
    expect(CATEGORY_BRIEFS.map(item => item.categoryId).sort()).toEqual(categories.map(item => item.id).sort())
    expect(new Set(CATEGORY_BRIEFS.map(item => item.categoryId)).size).toBe(categories.length)
    for (const { id, name } of categories) {
      const brief = getCategoryBrief(id)
      expect(brief?.label).toBe(name)
      expect(brief?.autoAssign).toBe(false)
      expect(validateBrief(id, {})).toEqual([])
      expect(brief?.fields.filter(field => field.group === 'core').length).toBeLessThanOrEqual(5)
    }
    expect(EXECUTION_KINDS).toEqual(['timed_service', 'supply', 'rental', 'deliverable', 'appointment'])
    expect(getCategoryBrief('florist')?.suggestedKinds).toContain('supply')
    expect(getCategoryBrief('florist')?.suggestedKinds).toContain('timed_service')
    expect(getCategoryBrief('photo')?.suggestedKinds).toContain('deliverable')
    expect(getCategoryBrief('honeymoon')?.autoAssign).toBe(false)
    expect(getCategoryBrief('vykup')?.autoAssign).toBe(false)
  })

  // Examples are written from the intended working scenario, independently of
  // descriptor generation. Each profession must accept its useful minimum.
  it.each([
    ['photo', { photographer: 'Ирина', priorityShots: ['Семейный портрет'], deliverables: '300 обработанных кадров', deliveryDate: '2027-07-01', publication: 'По отдельному согласию' }],
    ['video', { coverage: 'Церемония и банкет', deliverables: 'Фильм и короткий ролик', audio: 'Подключение к пульту', deliveryDate: '2027-08-01' }],
    ['venue', { capacity: 80, zones: ['Зал', 'Терраса'], accessWindow: 'Монтаж с 09:00', administrator: 'Администратор зала', backupPlace: 'Малый зал по договорённости' }],
    ['host', { names: 'Елена и Александр', language: 'Русский', excludedTopics: ['Политика'], program: 'Приветствие, тосты, танец', workWindow: '17:00–23:00' }],
    ['dj', { performers: 'DJ Сергей', keyTracks: ['Первый танец'], soundcheck: 'До открытия зала', equipment: 'Пульт и микрофоны', excludedTracks: ['Несогласованные треки'] }],
    ['florist', { items: ['Букет', 'Бутоньерка'], quantity: 2, substitutions: 'Только согласованные', deliveryPlace: 'Отель', recipient: 'Помощница', zones: ['Арка'], installationWindow: 'До 14:00' }],
    ['decor', { zones: ['Арка', 'Столы'], design: 'Версия эскиза 2', installationWindow: '10:00–13:00', rentedItems: ['Стойки'], dismantlingWindow: 'После 23:00' }],
    ['stylist', { clients: ['Невеста', 'Мама'], sequence: 'Сначала мама', readyBy: 'Невеста к 11:00', specialist: 'Анна', trial: 'В мае' }],
    ['catering', { portions: 80, menu: 'Согласованное меню банкета', kitchenContact: 'Менеджер кухни', menuRequirements: 'Отдельный вариант без мяса', allergenInformation: 'Состав блюд от исполнителя', changeDeadline: '2027-06-01' }],
    ['light', { equipment: 'Два микрофона и комплект света', operator: 'Сергей', access: 'Служебный вход', soundcheck: 'Перед церемонией', dismantlingWindow: 'После окончания' }],
    ['cake', { composition: 'Согласованная начинка', portions: 80, storageInstructions: 'Инструкция кондитера', recipient: 'Менеджер банкета', deliveryDate: '2027-06-14' }],
    ['transport', { tripDate: '2027-06-14', route: 'Отель — площадка', capacity: 20, driver: 'Водитель рейса', stops: ['Главный вход'], returnTrip: 'Отдельный согласованный рейс' }],
    ['dress', { item: 'Платье модели А', arrangement: 'Аренда', size: '44', fittings: 'Доработка длины', pickupDate: '2027-06-10', returnDate: '2027-06-16' }],
    ['suit', { item: 'Костюм модели Б', arrangement: 'Покупка', size: '50', fittings: 'Примерка в мае', pickupDate: '2027-06-10' }],
    ['rings', { items: ['Кольцо 1', 'Кольцо 2'], sizes: '17 и 19', engraving: 'Согласованный текст', pickupDate: '2027-06-01', keeper: 'Свидетель' }],
    ['print', { layout: 'Макет приглашения', proofText: 'Имена и адрес проверяют стороны', quantity: 40, deliveryDate: '2027-05-01', approvedVersion: 'Для отдельного согласования: версия 3' }],
    ['photobooth', { place: 'Фойе', workWindow: '18:00–22:00', equipment: 'Будка и принтер', output: 'Печать и ссылка на файлы', printQuantity: 100 }],
    ['firework', { operator: 'Ответственный исполнитель', venueContact: 'Администратор', place: 'Согласованная зона', launchConditions: 'Определяются исполнителем и площадкой', cancellationTerms: 'Согласованные условия' }],
    ['reels', { coverage: 'Церемония', deliverables: 'Три коротких ролика', deliveryDate: '2027-06-15', publication: 'После согласования', releaseWindow: 'Первый ролик на следующий день' }],
    ['painter', { subject: 'Церемония', format: 'Холст 50 × 70', workWindow: 'На площадке до 20:00', deliveryDate: '2027-06-20', recipient: 'Пара' }],
    ['nanny', { childrenCount: 5, ageGroup: '5–8 лет', adultContact: 'Назначенный взрослый', workWindow: '17:00–21:00', handover: 'Передать взрослому лично', program: 'Игры по договорённости' }],
    ['bar', { drinks: 'Согласованный список', purchaser: 'Исполнитель', quantities: 'По согласованной смете', staff: 'Два бармена', venueRules: 'Правила площадки' }],
    ['dance', { participants: ['Невеста', 'Жених'], rehearsals: 'Четыре встречи', music: 'Выбранный трек', readyDate: '2027-06-01', djHandover: 'Передать согласованный файл' }],
    ['agency', { scope: 'Подготовка и координация', staff: 'Анна и Ирина', authority: 'Требует отдельной выдачи доступа', decisionLimits: 'Расходы согласовывает пара', replacement: 'По договорённости' }],
    ['rental', { items: ['Стул', 'Стол'], quantity: 50, deliveryDate: '2027-06-13', returnDate: '2027-06-15', recipient: 'Координатор', deliveryRequired: true, condition: 'Проверка при передаче' }],
    ['ceremony', { zones: ['Церемония'], capacity: 80, accessWindow: 'С 10:00', accessibility: 'Согласованный доступный маршрут', backupPlace: 'По договорённости' }],
    ['hair', { clients: ['Невеста'], sequence: 'После визажа', readyBy: '11:00', specialist: 'Ольга', trial: 'По договорённости' }],
    ['coordinator', { scope: 'Ведение свадебного дня', workWindow: '09:00–01:00', backupContact: 'Дублёр', handover: 'Передать инструкции дублёру', authority: 'Отдельное приглашение' }],
    ['show', { performers: 'Три артиста', performanceWindow: 'Два выхода по 10 минут', preparation: 'Монтаж до гостей', leadContact: 'Руководитель', venueRequirements: 'Согласованный райдер' }],
    ['staff', { staff: 'Четыре официанта', leadContact: 'Старший смены', workWindow: '16:00–00:00', duties: 'Обслуживание столов', workingConditions: 'Согласованные перерывы' }],
    ['accessories', { item: 'Украшение для волос', quantity: 1, pickupDate: '2027-06-10', recipient: 'Невеста', compatibility: 'По выбранному образу' }],
    ['hotel', { rooms: 3, occupants: 5, checkIn: '2027-06-13', checkOut: '2027-06-16', roomAllocation: 'Две пары и отдельный гость', confirmation: 'Подтверждение отеля' }],
    ['honeymoon', { startDate: '2027-06-18', endDate: '2027-06-25', bookings: 'Выбранные брони', confirmationOwner: 'Пара', documentChecklist: 'Проверить наличие документов, без номеров' }],
    ['vykup', { program: 'Выбранный парой сценарий', place: 'Дом', responsible: 'Подруга', props: ['Ленты'], workWindow: '10:00–10:20' }],
    ['registrar', { format: 'Символическая церемония', names: 'Имена пары', script: 'Согласованный текст', workWindow: '15:00 на площадке', authority: 'Проведение выбранной церемонии' }],
  ] as const)('accepts the useful %s agreement without forcing extra reports', (category, agreement) => {
    expect(validateBrief(category, agreement)).toEqual([])
  })

  it('distinguishes delivery from installation while allowing one combined florist order', () => {
    expect(validateBrief('florist', { items: ['Букет'], quantity: 1, recipient: 'Невеста' }, 'shop')).toEqual([])
    expect(validateBrief('florist', { zones: ['Арка'], access: 'Вход с 10:00', dismantlingWindow: '23:00' }, 'installation')).toEqual([])
    expect(validateBrief('florist', { installationWindow: '10:00' }, 'shop')).toEqual([{ field: 'installationWindow', code: 'unknown_field' }])
    expect(validateBrief('florist', { quantity: 1, zones: ['Арка'] })).toEqual([])
    expect(getCategoryBrief('florist', 'shop')?.fields.some(field => field.key === 'installationWindow')).toBe(false)
  })

  it('does not equate entertainment with accepting responsibility for children', () => {
    expect(validateBrief('nanny', { childrenCount: 3, handover: 'Назначенному взрослому' }, 'supervision')).toEqual([])
    expect(validateBrief('nanny', { program: 'Игры' }, 'entertainment')).toEqual([])
    expect(validateBrief('nanny', { handover: 'Назначенному взрослому' }, 'entertainment')).toEqual([{ field: 'handover', code: 'unknown_field' }])
    expect(validateBrief('nanny', { program: 'Игры' }, 'supervision')).toEqual([{ field: 'program', code: 'unknown_field' }])
    expect(validateBrief('nanny', { handover: 'Назначенному взрослому', program: 'Игры' })).toEqual([])
  })

  it('resolves only real categories and applicable subtypes', () => {
    expect(getCategoryBrief('__proto__')).toBeUndefined()
    expect(getCategoryBrief('photo', 'shop')).toBeUndefined()
    expect(getCategoryBrief('florist', '')).toBeUndefined()
    expect(validateBrief('missing', {})).toEqual([{ field: '$', code: 'unknown_category' }])
    expect(validateBrief('photo', {}, 'shop')).toEqual([{ field: '$', code: 'invalid_subtype' }])
    expect(validateBrief('nanny', {}, 'installation')).toEqual([{ field: '$', code: 'invalid_subtype' }])
  })

  it('allows missing draft values and explicit clears without filling facts or mutating input', () => {
    const draft = Object.freeze({ quantity: null, recipient: '', items: [] })
    expect(validateBrief('florist', draft)).toEqual([])
    expect(draft).toEqual({ quantity: null, recipient: '', items: [] })
    expect(validateBrief('florist', { quantity: undefined })).toEqual([{ field: 'quantity', code: 'invalid_type' }])
    expect(validateBrief('florist', { inventedStatus: null })).toEqual([{ field: 'inventedStatus', code: 'unknown_field' }])
  })

  it.each([null, undefined, [], 'brief', 1, true, new Date(), Object.create({ quantity: 1 })])('rejects non-flat or non-JSON brief input: %s', input => {
    expect(validateBrief('florist', input)).toEqual([{ field: '$', code: 'invalid_brief' }])
  })

  it('accepts null-prototype data but rejects prototype keys and does not invoke getters', () => {
    const data = Object.assign(Object.create(null), { quantity: 2 })
    expect(validateBrief('florist', data)).toEqual([])
    expect(validateBrief('florist', JSON.parse('{"__proto__":{"quantity":1},"constructor":"x"}'))).toEqual([
      { field: '__proto__', code: 'unknown_field' }, { field: 'constructor', code: 'unknown_field' },
    ])
    const getter = Object.defineProperty({}, 'quantity', { enumerable: true, get() { throw new Error('must not read accessor') } })
    expect(validateBrief('florist', getter)).toEqual([{ field: 'quantity', code: 'invalid_type' }])
    expect(validateBrief('florist', { [Symbol('hidden')]: 1 })).toEqual([{ field: '$', code: 'invalid_brief' }])
  })

  it('keeps errors bounded and never returns submitted secrets', () => {
    expect(validateBrief('florist', Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`key${i}`, 'x'])))).toEqual([{ field: '$', code: 'invalid_brief' }])
    expect(validateBrief('florist', { ['x'.repeat(81)]: 'value' })).toEqual([{ field: '$', code: 'invalid_brief' }])
    expect(JSON.stringify(validateBrief('photo', { photographer: 'secret'.repeat(1000) }))).not.toContain('secret')
  })

  it.each([1.5, NaN, Infinity, -Infinity, '2', {}, false, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe or wrong-type item quantities: %s', quantity => {
    expect(validateBrief('florist', { quantity })).toEqual([{ field: 'quantity', code: 'invalid_type' }])
  })

  it('bounds people, item quantities and arrays without silently truncating', () => {
    expect(validateBrief('hotel', { occupants: 0 })).toEqual([{ field: 'occupants', code: 'out_of_range' }])
    expect(validateBrief('hotel', { occupants: 10_001 })).toEqual([{ field: 'occupants', code: 'out_of_range' }])
    expect(validateBrief('florist', { quantity: 100_001 })).toEqual([{ field: 'quantity', code: 'out_of_range' }])
    expect(validateBrief('florist', { quantity: 100_000 })).toEqual([])
    expect(validateBrief('photo', { priorityShots: Array(41).fill('Кадр') })).toEqual([{ field: 'priorityShots', code: 'too_many_items' }])
    expect(validateBrief('photo', { priorityShots: ['x'.repeat(201)] })).toEqual([{ field: 'priorityShots', code: 'too_long' }])
    expect(validateBrief('photo', { priorityShots: [null] })).toEqual([{ field: 'priorityShots', code: 'invalid_type' }])
    expect(validateBrief('photo', { priorityShots: Array(1) })).toEqual([{ field: 'priorityShots', code: 'invalid_type' }])
    expect(validateBrief('photo', { priorityShots: 'Кадр' })).toEqual([{ field: 'priorityShots', code: 'invalid_type' }])
  })

  it('enforces text, real boolean and enumerated arrangement types', () => {
    expect(validateBrief('host', { program: 'x'.repeat(2001) })).toEqual([{ field: 'program', code: 'too_long' }])
    expect(validateBrief('host', { program: 'Краткая программа\nСогласованные выходы' })).toEqual([])
    expect(validateBrief('host', { program: 'test\u0000' })).toEqual([{ field: 'program', code: 'invalid_value' }])
    expect(validateBrief('host', { program: { text: 'nested' } })).toEqual([{ field: 'program', code: 'invalid_type' }])
    expect(validateBrief('rental', { deliveryRequired: 'false' })).toEqual([{ field: 'deliveryRequired', code: 'invalid_type' }])
    expect(validateBrief('rental', { deliveryRequired: false })).toEqual([])
    expect(validateBrief('dress', { arrangement: 'Аренда' })).toEqual([])
    expect(validateBrief('dress', { arrangement: 'Считаем купленным' })).toEqual([{ field: 'arrangement', code: 'invalid_value' }])
    expect(validateBrief('dress', { arrangement: null })).toEqual([])
  })

  it.each(['2027-02-30', '2027-02-29', '2100-02-29', '2027-13-01', '0000-01-01', '2027-6-14', '2027-06-14T10:00:00Z'])('rejects a false deadline instead of passing it to storage: %s', deliveryDate => {
    expect(validateBrief('photo', { deliveryDate })).toEqual([{ field: 'deliveryDate', code: 'invalid_value' }])
  })

  it('accepts real leap dates and leaves date ordering to order-level validation', () => {
    expect(validateBrief('photo', { deliveryDate: '2028-02-29' })).toEqual([])
    expect(validateBrief('photo', { deliveryDate: 20270614 })).toEqual([{ field: 'deliveryDate', code: 'invalid_type' }])
    // Descriptor validation cannot know appointment/event context or whether
    // an earlier date is a change draft; order integration validates ranges.
    expect(validateBrief('hotel', { checkIn: '2027-06-14', checkOut: '2027-06-15' })).toEqual([])
  })

  it('exports serializable immutable descriptors, never actual customer values', () => {
    expect(JSON.parse(JSON.stringify(CATEGORY_BRIEFS))).toHaveLength(categories.length)
    expect(Object.isFrozen(CATEGORY_BRIEFS)).toBe(true)
    const shop = getCategoryBrief('florist', 'shop')!
    expect(Object.isFrozen(shop)).toBe(true)
    expect(Object.isFrozen(shop.fields)).toBe(true)
    expect(Object.isFrozen(shop.fields[0])).toBe(true)
    expect(shop.subtypeId).toBe('shop')
    expect(shop.fields.every(field => !('value' in field) && !('required' in field))).toBe(true)
  })
})
