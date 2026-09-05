import { t } from './i18n'
import { rub } from './money'
// Мок-данные MVP «Тили-тили» — соответствуют openapi-черновику ч.13 плана

export type VendorStatus = 'free' | 'hold' | 'booked' | 'busy'
export type SlotState = 'empty' | 'candidate' | 'hold' | 'booked'

export interface Vendor {
  id: string
  name: string
  /** Рабочий телефон анкеты. Виден паре только после брони (§каталог). */
  phone: string
  category: string
  categoryIcon: string
  tile: string // css class плитки
  rating: number
  reviews: number
  priceFrom: number
  years?: number
  desc: string
  freeOnDate: boolean
  hasVideo: boolean
  isNew?: boolean
  photos: number
  packages: { name: string; price: number; items: string[] }[]
}

export interface Category { id: string; name: string; icon: string; tile: string; count: number }

export const couple = {
  bride: t('Алина'), groom: t('Тимур'),
  full: t('Алина Козлова & Тимур Волков'),
  date: t('14 июня 2027'),
  dateShort: '14.06.2027',
  venue: t('Усадьба «Липовый сад»'),
  city: t('Уфа'),
  style: t('Люкс'),
  guestsTotal: 80,
  guestsConfirmed: 42,
  daysLeft: 287,
  countdown: { m: 9, d: 14, h: 8, min: 42 },
  budgetTotal: rub(1_200_000),
  budgetSpent: rub(850_000),
  teamBooked: 4, teamTotal: 14,
  specialists: t('18 из 25'),
}

export const categories: Category[] = [
  { id: 'photo', name: t('Фотограф'), icon: '📸', tile: 'bg-[#F2DFDC]', count: 128 },
  { id: 'video', name: t('Видеооператор'), icon: '🎥', tile: 'bg-[#E6EEE2]', count: 64 },
  { id: 'venue', name: t('Площадка'), icon: '🏛️', tile: 'bg-[#F0DCB8]', count: 32 },
  { id: 'host', name: t('Ведущий / Тамада'), icon: '🎤', tile: 'bg-[#D9CCE3]', count: 45 },
  { id: 'dj', name: t('DJ / Музыканты'), icon: '🎧', tile: 'bg-[#C3D5E8]', count: 38 },
  { id: 'florist', name: t('Флорист'), icon: '🌸', tile: 'bg-[#F2DFDC]', count: 52 },
  { id: 'decor', name: t('Декоратор'), icon: '✨', tile: 'bg-[#E6EEE2]', count: 29 },
  { id: 'stylist', name: t('Стилист / Визажист'), icon: '💄', tile: 'bg-[#F2DFDC]', count: 41 },
  { id: 'catering', name: t('Кейтеринг'), icon: '🍽️', tile: 'bg-[#F0DCB8]', count: 35 },
  { id: 'light', name: t('Свет и звук'), icon: '💡', tile: 'bg-[#F3E3D3]', count: 18 },
  { id: 'cake', name: t('Кондитер'), icon: '🎂', tile: 'bg-[#F0DCB8]', count: 27 },
  { id: 'transport', name: t('Транспорт / Кортеж'), icon: '🚗', tile: 'bg-[#F3E3D3]', count: 22 },
  { id: 'dress', name: t('Свадебное платье'), icon: '👗', tile: 'bg-[#D9CCE3]', count: 15 },
  { id: 'suit', name: t('Костюм жениха'), icon: '🤵', tile: 'bg-[#C3D5E8]', count: 12 },
  { id: 'rings', name: t('Ювелир / Кольца'), icon: '💍', tile: 'bg-[#E6EEE2]', count: 8 },
  { id: 'print', name: t('Полиграфия'), icon: '📜', tile: 'bg-[#F3E3D3]', count: 19 },
  { id: 'photobooth', name: t('Фотобудка'), icon: '📷', tile: 'bg-[#F2DFDC]', count: 14 },
  { id: 'firework', name: t('Пиротехника'), icon: '🎆', tile: 'bg-[#D9CCE3]', count: 9 },
  { id: 'reels', name: t('Reels-мейкер'), icon: '🎬', tile: 'bg-[#F2DFDC]', count: 11 },
  { id: 'painter', name: 'Live Painter', icon: '🎨', tile: 'bg-[#E6EEE2]', count: 5 },
  { id: 'nanny', name: t('Аниматор / Няня'), icon: '🎪', tile: 'bg-[#F3E3D3]', count: 16 },
  { id: 'bar', name: t('Сомелье / Бар'), icon: '🍷', tile: 'bg-[#D9CCE3]', count: 7 },
  { id: 'dance', name: t('Хореограф'), icon: '💃', tile: 'bg-[#C3D5E8]', count: 13 },
  { id: 'agency', name: t('Организатор'), icon: '🎯', tile: 'bg-[#F2DFDC]', count: 21 },
  { id: 'rental', name: t('Рентал / Мебель'), icon: '🕯️', tile: 'bg-[#E6EEE2]', count: 10 },
  /* Дополнение до 35 категорий плана ч. 8.1 — решение владельца 2026-09-02 */
  { id: 'ceremony', name: t('Площадка выездной церемонии'), icon: '🌿', tile: 'bg-[#E6EEE2]', count: 24 },
  { id: 'hair', name: t('Парикмахер'), icon: '💇', tile: 'bg-[#F2DFDC]', count: 33 },
  { id: 'coordinator', name: t('Координатор дня'), icon: '🎖', tile: 'bg-[#F0DCB8]', count: 17 },
  { id: 'show', name: t('Шоу-программа / Артисты'), icon: '🎭', tile: 'bg-[#D9CCE3]', count: 20 },
  { id: 'staff', name: t('Бармены и официанты'), icon: '🧑‍🍳', tile: 'bg-[#C3D5E8]', count: 26 },
  { id: 'accessories', name: t('Аксессуары и бижутерия'), icon: '👜', tile: 'bg-[#F3E3D3]', count: 14 },
  { id: 'hotel', name: t('Отель для гостей'), icon: '🏨', tile: 'bg-[#C3D5E8]', count: 11 },
  { id: 'honeymoon', name: t('Медовый месяц'), icon: '✈️', tile: 'bg-[#E6EEE2]', count: 9 },
  { id: 'vykup', name: t('Выкуп невесты'), icon: '🎀', tile: 'bg-[#F2DFDC]', count: 12 },
  { id: 'registrar', name: t('Церемониймейстер'), icon: '📜', tile: 'bg-[#F0DCB8]', count: 8 },
]

export const vendors: Vendor[] = [
  {
    id: 'v1', name: t('Елена Смирнова'), phone: '+7 917 340-11-08', category: t('Фотограф'), categoryIcon: '📸', tile: 'bg-[#F2DFDC]',
    rating: 4.9, reviews: 47, priceFrom: rub(85000), years: 5, freeOnDate: true, hasVideo: true, photos: 5,
    desc: t('Светлый живой стиль, ловлю эмоции, а не постановку. Снимаю свадьбы в Уфе и по Башкирии 5 лет — 120+ пар.'),
    packages: [
      { name: t('Утро и церемония'), price: rub(45000), items: [t('6 часов съёмки'), t('250+ фото в обработке'), t('Онлайн-галерея')] },
      { name: t('Полный день'), price: rub(85000), items: [t('12 часов съёмки'), t('500+ фото'), t('Экспресс 30 фото за 48 ч'), t('Премиум-фотокнига')] },
      { name: t('Люкс'), price: rub(130000), items: [t('2 фотографа'), t('Love story в подарок'), t('Слайд-шоу на банкете')] },
    ],
  },
  {
    id: 'v2', name: 'CinemaWedding Team', phone: '+7 917 402-55-19', category: t('Видеооператор'), categoryIcon: '🎥', tile: 'bg-[#E6EEE2]',
    rating: 5.0, reviews: 32, priceFrom: rub(120000), years: 7, freeOnDate: true, hasVideo: true, photos: 5,
    desc: t('Кинематографичные фильмы о дне: 2 камеры, аэросъёмка, звук с петличек. Монтаж за 30 дней.'),
    packages: [
      { name: t('Клип'), price: rub(120000), items: [t('2 оператора'), t('Клип 4–6 мин'), t('Аэросъёмка')] },
      { name: t('Фильм'), price: rub(180000), items: [t('Клип + фильм 25–40 мин'), t('Запись аудио церемонии'), t('RAW-архив')] },
    ],
  },
  {
    id: 'v3', name: t('Усадьба «Липовый сад»'), phone: '+7 347 216-70-40', category: t('Площадка'), categoryIcon: '🏛️', tile: 'bg-[#F0DCB8]',
    rating: 4.7, reviews: 89, priceFrom: rub(250000), freeOnDate: true, hasVideo: true, photos: 5,
    desc: t('Загородная усадьба в 20 минутах от Уфы: шатёр у озера до 120 гостей, липовая аллея для церемонии, номера для молодожёнов.'),
    packages: [
      { name: t('Будни'), price: rub(180000), items: [t('Аренда шатра'), t('Мебель и текстиль'), t('Парковка 60 авто')] },
      { name: t('Выходной'), price: rub(250000), items: [t('Шатёр + аллея'), t('Кейтеринг-зона'), t('Номер молодожёнам'), t('Координатор площадки')] },
    ],
  },
  {
    id: 'v4', name: t('Артём Краснов'), phone: '+7 917 771-26-03', category: t('Ведущий'), categoryIcon: '🎤', tile: 'bg-[#D9CCE3]',
    rating: 4.8, reviews: 56, priceFrom: rub(60000), years: 8, freeOnDate: true, hasVideo: false, photos: 5,
    desc: t('Ведущий без пошлости и конкурсов из 2005-го. Интеллигентный юмор, живой контакт с гостями, английский — по запросу.'),
    packages: [
      { name: t('Банкет'), price: rub(60000), items: [t('6 часов программы'), t('Музыкальное оформление'), t('Сценарий под пару')] },
      { name: t('Церемония + банкет'), price: rub(85000), items: [t('Выездная регистрация'), t('Диджей в комплекте')] },
    ],
  },
  {
    id: 'v5', name: t('Студия «Пион»'), phone: '+7 927 318-44-92', category: t('Флорист'), categoryIcon: '🌸', tile: 'bg-[#F2DFDC]',
    rating: 4.9, reviews: 41, priceFrom: rub(45000), freeOnDate: true, hasVideo: true, photos: 5,
    desc: t('Авторская флористика: букет, бутоньерки, оформление церемонии и столов. Работаем с сезонными цветами и пионами.'),
    packages: [
      { name: t('Букет + детали'), price: rub(15000), items: [t('Букет невесты'), t('Дублёр'), t('Бутоньерка')] },
      { name: t('Церемония'), price: rub(45000), items: [t('Арка / композиция'), t('Дорожка'), t('Букет и бутоньерка')] },
      { name: t('Полное оформление'), price: rub(120000), items: [t('Церемония + банкет'), t('Сervise столов'), t('Монтаж/демонтаж')] },
    ],
  },
  {
    id: 'v6', name: t('Тимур Галин'), phone: '+7 987 254-63-77', category: t('Фотограф'), categoryIcon: '📸', tile: 'bg-[#F2DFDC]',
    rating: 0, reviews: 0, priceFrom: rub(45000), years: 2, freeOnDate: true, hasVideo: false, isNew: true, photos: 3,
    desc: t('Начинающий фотограф с сильным портфолио городских съёмок. Первые свадьбы — по специальной цене.'),
    packages: [{ name: t('Полный день'), price: rub(45000), items: [t('10 часов'), t('300+ фото'), t('Онлайн-галерея')] }],
  },
]

/*
 * Слот команды в том виде, в котором его рисуют экраны.
 *
 * `state` — производная подпись плитки, её считает сервер (`tileState`).
 * `dealState` — настоящее состояние сделки из шести: плитке хватает четырёх,
 * а экрану сделки нужны все, иначе «внесён аванс» и «выполнено» сольются в
 * одну картинку.
 */
export interface Slot { id: string; categoryId: string; label: string; icon: string; tile: string; state: SlotState; vendor?: string; vendorId?: string; price?: number; paid?: number; paidAt?: string; status?: string; external?: boolean; phone?: string; dealId?: string; dealState?: DealState }

/** Шесть состояний сделки плюс отмена — те же, что в контракте. */
export type DealState = 'candidate' | 'contacted' | 'negotiating' | 'booked' | 'paid_deposit' | 'done' | 'cancelled'

export const initialSlots: Slot[] = [
  { id: 's1', categoryId: 'venue', label: t('Площадка'), icon: '🏛️', tile: 'bg-[#F0DCB8]', state: 'booked', vendor: t('Усадьба «Липовый сад»'), price: rub(250000), status: 'Забронировано' },
  { id: 's2', categoryId: 'photo', label: t('Фотограф'), icon: '📸', tile: 'bg-[#F2DFDC]', state: 'booked', vendor: t('Елена Смирнова'), price: rub(85000), status: 'Забронировано' },
  { id: 's3', categoryId: 'video', label: t('Видеограф'), icon: '🎥', tile: 'bg-[#E6EEE2]', state: 'booked', vendor: 'CinemaWedding Team', price: rub(120000), status: 'Забронировано' },
  { id: 's4', categoryId: 'host', label: t('Ведущий'), icon: '🎤', tile: 'bg-[#D9CCE3]', state: 'hold', vendor: t('Артём Краснов'), price: rub(60000), status: 'Аванс 50%' },
  { id: 's5', categoryId: 'florist', label: t('Флорист'), icon: '🌸', tile: 'bg-[#F2DFDC]', state: 'hold', vendor: t('Студия «Пион»'), price: rub(45000), status: 'Hold 72 ч' },
  { id: 's6', categoryId: 'cake', label: t('Кондитер'), icon: '🎂', tile: 'bg-[#F0DCB8]', state: 'candidate', vendor: t('Кандидаты: 2') },
  { id: 's7', categoryId: 'stylist', label: t('Стилист'), icon: '💄', tile: 'bg-[#F2DFDC]', state: 'candidate', vendor: t('Кандидат: 1') },
  { id: 's8', categoryId: 'dj', label: 'DJ', icon: '🎧', tile: 'bg-[#C3D5E8]', state: 'empty' },
  { id: 's9', categoryId: 'decor', label: t('Декоратор'), icon: '✨', tile: 'bg-[#E6EEE2]', state: 'empty' },
  { id: 's10', categoryId: 'transport', label: t('Транспорт'), icon: '🚗', tile: 'bg-[#F3E3D3]', state: 'empty' },
  { id: 's11', categoryId: 'dress', label: t('Платье'), icon: '👗', tile: 'bg-[#D9CCE3]', state: 'empty' },
  { id: 's12', categoryId: 'rings', label: t('Кольца'), icon: '💍', tile: 'bg-[#E6EEE2]', state: 'empty' },
]

export const budgetItems = [
  { name: t('Площадка и кейтеринг'), amount: rub(480000), limit: rub(560000), color: '#D9A8A0' },
  { name: t('Фото и видео'), amount: rub(205000), limit: rub(240000), color: '#A9BCA0' },
  { name: t('Одежда и красота'), amount: rub(76000), limit: rub(180000), color: '#E3C892' },
  { name: t('Развлечения и декор'), amount: rub(48000), limit: rub(144000), color: '#D9CCE3' },
  { name: t('Прочее'), amount: rub(41000), limit: rub(96000), color: '#C3D5E8' },
]

export interface Task { id: string; title: string; done: boolean; due: string; period: string; urgent?: boolean }

export const tasks: Task[] = [
  { id: 't1', title: t('Выбрать дату свадьбы'), done: true, due: t('15 янв'), period: '9' },
  { id: 't2', title: t('Определить бюджет'), done: true, due: t('20 янв'), period: '9' },
  { id: 't3', title: t('Составить список гостей'), done: true, due: t('1 фев'), period: '9' },
  { id: 't4', title: t('Забронировать площадку'), done: true, due: t('5 фев'), period: '9' },
  { id: 't5', title: t('Найти фотографа'), done: true, due: t('15 фев'), period: '9' },
  { id: 't6', title: t('Заказать приглашения'), done: false, due: t('до 1 мар'), period: '9', urgent: true },
  { id: 't7', title: t('Примерка платья (1 из 3)'), done: false, due: t('до 15 мар'), period: '9' },
  { id: 't8', title: t('Дегустация меню'), done: false, due: t('до 1 апр'), period: '6' },
  { id: 't9', title: t('Репетиция первого танца'), done: false, due: t('до 1 мая'), period: '6' },
  { id: 't10', title: t('Забронировать ведущего'), done: false, due: t('до 15 мая'), period: '6', urgent: true },
  { id: 't11', title: t('Утвердить тайминг дня'), done: false, due: t('до 1 июн'), period: '3' },
  { id: 't12', title: t('Финальная рассадка гостей'), done: false, due: t('до 7 июн'), period: '1' },
]

export const timeline = [
  { id: 'e1', icon: '🌅', tile: 'bg-[#F2DFDC]', name: t('Сборы невесты'), loc: t('Отель «Ривьера», номер 304'), time: '08:00 — 13:00', who: t('Стилист Елена · Фотограф Е. Смирнова') },
  { id: 'e2', icon: '🤵', tile: 'bg-[#E6EEE2]', name: t('Сборы жениха'), loc: t('Квартира, ул. Лесная 12'), time: '09:00 — 12:00', who: t('Барбер Иван · Видеооператор') },
  { id: 'e3', icon: '💍', tile: 'bg-[#F0DCB8]', name: t('Доставка букета и деталей'), loc: t('Кольца, клятвы, подарки родителям'), time: '12:00 — 13:00', who: t('Флорист · координатор') },
  { id: 'e4', icon: '💐', tile: 'bg-[#D9CCE3]', name: t('Выездная церемония'), loc: t('Усадьба «Липовый сад», липовая аллея'), time: '16:00 — 17:00', who: t('Гости с 15:30 · регистратор') },
  { id: 'e5', icon: '🥂', tile: 'bg-[#F3E3D3]', name: t('Банкет'), loc: t('Шатёр у озера'), time: '18:00 — 23:00', who: t('Ведущий · DJ · торт в 21:30') },
  { id: 'e6', icon: '🎆', tile: 'bg-[#C3D5E8]', name: t('Салют и финал'), loc: t('Пирс'), time: '22:30 — 23:00', who: t('Фаер-шоу · трансфер гостей 23:00') },
]

export interface Guest { id: string; name: string; status: 'yes' | 'no' | 'pending'; plus: boolean; table?: number }

export const guests: Guest[] = [
  { id: 'g1', name: t('Марина Ивановна (мама)'), status: 'yes', plus: false, table: 1 },
  { id: 'g2', name: t('Игорь Петрович (папа)'), status: 'yes', plus: false, table: 1 },
  { id: 'g3', name: t('Ольга и Денис Соколовы'), status: 'yes', plus: true, table: 3 },
  { id: 'g4', name: t('Руслан Гареев'), status: 'pending', plus: false },
  { id: 'g5', name: t('Тётя Люда'), status: 'yes', plus: false, table: 2 },
  { id: 'g6', name: t('Коллеги Тимура (4)'), status: 'pending', plus: true },
  { id: 'g7', name: t('Айгуль и Марсель'), status: 'no', plus: false },
  { id: 'g8', name: t('Дядя Рафик'), status: 'pending', plus: true },
]

export const contractTemplates = [
  { id: 'c1', icon: '📸', tile: 'bg-[#F2DFDC]', name: t('Договор с фотографом'), desc: t('Услуги фотосъёмки, сроки отдачи, права на фото') },
  { id: 'c2', icon: '🏛️', tile: 'bg-[#F0DCB8]', name: t('Аренда площадки'), desc: t('Дата, время, залог, ответственность сторон') },
  { id: 'c3', icon: '🎤', tile: 'bg-[#D9CCE3]', name: t('Договор с ведущим'), desc: t('Программа, тайминг, аванс 50%') },
  { id: 'c4', icon: '🌸', tile: 'bg-[#E6EEE2]', name: t('Декоратор / флорист'), desc: t('Эскизы, монтаж, форс-мажор с цветами') },
  { id: 'c5', icon: '🎂', tile: 'bg-[#F0DCB8]', name: t('Договор с кондитером'), desc: t('Дегустация, вес, доставка, хранение') },
  { id: 'c6', icon: '📄', tile: 'bg-[#C3D5E8]', name: t('Универсальный договор услуг'), desc: t('Для любой категории + акт выполненных работ') },
]

export interface Chat { id: string; name: string; icon: string; tile: string; last: string; time: string; unread: number; kind: 'vendor' | 'team' | 'day' }

export const chats: Chat[] = [
  { id: 'ch1', name: t('Елена Смирнова'), icon: '📸', tile: 'bg-[#F2DFDC]', last: t('Отправила вам договор и презентацию ✨'), time: '14:32', unread: 2, kind: 'vendor' },
  { id: 'ch2', name: t('Команда свадьбы'), icon: '💍', tile: 'bg-[#F0DCB8]', last: t('Артём: ребята, по звуку свяжусь со световиком'), time: '12:05', unread: 5, kind: 'team' },
  { id: 'ch3', name: t('Артём Краснов'), icon: '🎤', tile: 'bg-[#D9CCE3]', last: t('Аванс получил, дата за вами!'), time: t('вчера'), unread: 0, kind: 'vendor' },
  { id: 'ch4', name: t('Студия «Пион»'), icon: '🌸', tile: 'bg-[#F2DFDC]', last: t('Пришлём эскизы букета до пятницы'), time: t('вчера'), unread: 1, kind: 'vendor' },
  { id: 'ch5', name: t('Чат дня X · гости'), icon: '🥂', tile: 'bg-[#E6EEE2]', last: t('Откроется 13 июня в 09:00'), time: '—', unread: 0, kind: 'day' },
]

export const chatMessages = [
  { id: 'm1', me: false, text: t('Здравствуйте! Свободны на 14 июня 2027? Нам нужен полный день.'), time: '14:10' },
  { id: 'm2', me: true, text: t('Здравствуйте, Алина! Да, 14 июня свободна 🎉 Смотрю, у вас усадьба «Липовый сад» — обожаю там снимать, свет волшебный.'), time: '14:18' },
  { id: 'm3', me: true, text: t('Отправляю договор и презентацию с пакетами. Рекомендую «Полный день» — 12 часов как раз закрывают сборы → салют.'), time: '14:20' },
  { id: 'm4', me: false, text: t('Спасибо! Обсудим с Тимуром вечером и вернёмся. А экспресс-фото за 48 часов правда успеваете?'), time: '14:28' },
  { id: 'm5', me: true, text: t('Гарантирую в договоре 🙂 30 фото через 48 часов, остальное — до 30 дней.'), time: '14:32' },
]

export const aiTips = [
  t('Топ-фотографы Уфы на июнь разбираются за 8 месяцев. Свободных на 14.06 осталось 6 — посмотреть?'),
  t('Пустой слот «Флорист» блокирует автоплан дня — букет нужен к 10:00 сборам.'),
  t('«Площадка и кейтеринг» на 86% лимита. Зафиксируйте меню до 1 марта — дальше цены вырастут ~10%.'),
]

/* Форматирование живёт в money.ts; здесь ре-экспорт, чтобы не трогать 30 импортов. */
export { fmt } from './money'

/* ── Вишлист подарков ─────────────────────────────────────────
   Пара составляет список желаний; гости резервируют подарки анонимно.
   reserved=true → подарок закрыт для остальных (нельзя подарить дважды).
   group=true → складчина: несколько гостей частями закрывают сумму. */
export interface Gift {
  id: string
  name: string
  icon: string
  tile: string
  price: number
  desc?: string
  group: boolean          // можно складчину
  funded: number          // собрано складчиной (₽)
  reserved: boolean       // зарезервирован целиком (анонимно для пары)
}

export const initialGifts: Gift[] = [
  { id: 'gf1', name: t('Телевизор 65"'), icon: '📺', tile: 'bg-[var(--blue)]', price: rub(89990), desc: t('В гостиную, OLED'), group: true, funded: rub(30000), reserved: false },
  { id: 'gf2', name: t('Робот-пылесос'), icon: '🤖', tile: 'bg-[var(--sage-soft)]', price: rub(45000), group: false, funded: rub(0), reserved: true },
  { id: 'gf3', name: t('Кофемашина'), icon: '☕', tile: 'bg-[var(--honey)]', price: rub(62000), desc: t('Зерновая, с капучинатором'), group: true, funded: rub(0), reserved: false },
  { id: 'gf4', name: t('Набор посуды'), icon: '🍽', tile: 'bg-[var(--rose-soft)]', price: rub(18000), group: false, funded: rub(0), reserved: false },
  { id: 'gf5', name: t('Постельное бельё'), icon: '🛏', tile: 'bg-[var(--lav)]', price: rub(12000), group: false, funded: rub(0), reserved: false },
  { id: 'gf6', name: t('Сертификат на путешествие'), icon: '✈️', tile: 'bg-[var(--peach)]', price: rub(150000), desc: t('Мечта — Каппадокия'), group: true, funded: rub(45000), reserved: false },
  { id: 'gf7', name: t('Блендер стационарный'), icon: '🥤', tile: 'bg-[var(--sage-soft)]', price: rub(9500), group: false, funded: rub(0), reserved: false },
  { id: 'gf8', name: t('Ужин в ресторане'), icon: '🕯', tile: 'bg-[var(--rose-soft)]', price: rub(15000), desc: t('Сертификат на двоих'), group: false, funded: rub(0), reserved: true },
]

/* ── Денежные фонды («конверт» онлайн) ── */
export interface Fund { id: string; name: string; icon: string; tile: string; target: number; collected: number }
export const initialFunds: Fund[] = [
  { id: 'f1', name: t('Медовый месяц в Каппадокии'), icon: '🎈', tile: 'bg-[var(--peach)]', target: rub(200000), collected: rub(67500) },
  { id: 'f2', name: t('Первый семейный автомобиль'), icon: '🚗', tile: 'bg-[var(--blue)]', target: rub(500000), collected: rub(40000) },
]

/* ── Анти-вишлист: что просим НЕ дарить ── */
export const initialAntiGifts: string[] = [t('Сервизы'), t('Картины'), t('Сувенирная посуда'), t('Пылесос — уже есть')]

/* ── Общий фотоальбом гостей (модерация парой) ── */
export interface AlbumPhoto { id: string; emoji: string; tile: string; approved: boolean; at: string }
export const initialAlbum: AlbumPhoto[] = [
  { id: 'p1', emoji: '💃', tile: 'bg-[var(--rose-soft)]', approved: true, at: '21:14' },
  { id: 'p2', emoji: '🥂', tile: 'bg-[var(--honey)]', approved: true, at: '19:02' },
  { id: 'p3', emoji: '🎆', tile: 'bg-[var(--blue)]', approved: false, at: '22:41' },
  { id: 'p4', emoji: '🤳', tile: 'bg-[var(--lav)]', approved: true, at: '16:20' },
  { id: 'p5', emoji: '🍰', tile: 'bg-[var(--sage-soft)]', approved: false, at: '21:33' },
]

/* Палитры дресс-кода для приглашения */
export const dressPalettes = [
  { id: 'd1', name: t('Пудровая классика'), colors: ['#E8C4C4', '#D9A8A0', '#C98A8A', '#8FB08A', '#EFE9DF'] },
  { id: 'd2', name: t('Шалфей и сливки'), colors: ['#A9BCA0', '#DCE5D4', '#EFE9DF', '#C9B458', '#5F7A56'] },
  { id: 'd3', name: t('Лавандовый вечер'), colors: ['#D9CCE3', '#B9A7CC', '#8E7AA6', '#EFE9DF', '#3A322B'] },
  { id: 'd4', name: t('Медовый закат'), colors: ['#E3C892', '#D4A96A', '#B98A2F', '#F0DCB8', '#3A322B'] },
]

/* Отзывы гостей о подрядчиках (помечаются отдельно от отзывов пары) */
export interface GuestReview { id: string; vendor: string; stars: number; text: string; at: string }
export const initialGuestReviews: GuestReview[] = [
  { id: 'gr1', vendor: t('Артём Краснов · ведущий'), stars: 5, text: t('Вёл вечер очень деликатно, тосты не затянуты, танцы были!'), at: t('15 июн') },
  { id: 'gr2', vendor: t('Усадьба «Липовый сад»'), stars: 4, text: t('Красивое место и вкусная кухня. Минус — далеко парковаться.'), at: t('16 июн') },
]
