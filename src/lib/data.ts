// Мок-данные MVP «Тили-тили» — соответствуют openapi-черновику ч.13 плана

export type VendorStatus = 'free' | 'hold' | 'booked' | 'busy'
export type SlotState = 'empty' | 'candidate' | 'hold' | 'booked'

export interface Vendor {
  id: string
  name: string
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
  bride: 'Алина', groom: 'Тимур',
  full: 'Алина Козлова & Тимур Волков',
  date: '14 июня 2027',
  dateShort: '14.06.2027',
  venue: 'Усадьба «Липовый сад»',
  city: 'Уфа',
  style: 'Люкс',
  guestsTotal: 80,
  guestsConfirmed: 42,
  daysLeft: 287,
  countdown: { m: 9, d: 14, h: 8, min: 42 },
  budgetTotal: 1_200_000,
  budgetSpent: 850_000,
  teamBooked: 4, teamTotal: 14,
  specialists: '18 из 25',
}

export const categories: Category[] = [
  { id: 'photo', name: 'Фотограф', icon: '📸', tile: 'bg-[#F2DFDC]', count: 128 },
  { id: 'video', name: 'Видеооператор', icon: '🎥', tile: 'bg-[#E6EEE2]', count: 64 },
  { id: 'venue', name: 'Площадка', icon: '🏛️', tile: 'bg-[#F0DCB8]', count: 32 },
  { id: 'host', name: 'Ведущий / Тамада', icon: '🎤', tile: 'bg-[#D9CCE3]', count: 45 },
  { id: 'dj', name: 'DJ / Музыканты', icon: '🎧', tile: 'bg-[#C3D5E8]', count: 38 },
  { id: 'florist', name: 'Флорист', icon: '🌸', tile: 'bg-[#F2DFDC]', count: 52 },
  { id: 'decor', name: 'Декоратор', icon: '✨', tile: 'bg-[#E6EEE2]', count: 29 },
  { id: 'stylist', name: 'Стилист / Визажист', icon: '💄', tile: 'bg-[#F2DFDC]', count: 41 },
  { id: 'catering', name: 'Кейтеринг', icon: '🍽️', tile: 'bg-[#F0DCB8]', count: 35 },
  { id: 'light', name: 'Свет и звук', icon: '💡', tile: 'bg-[#F3E3D3]', count: 18 },
  { id: 'cake', name: 'Кондитер', icon: '🎂', tile: 'bg-[#F0DCB8]', count: 27 },
  { id: 'transport', name: 'Транспорт / Кортеж', icon: '🚗', tile: 'bg-[#F3E3D3]', count: 22 },
  { id: 'dress', name: 'Свадебное платье', icon: '👗', tile: 'bg-[#D9CCE3]', count: 15 },
  { id: 'suit', name: 'Костюм жениха', icon: '🤵', tile: 'bg-[#C3D5E8]', count: 12 },
  { id: 'rings', name: 'Ювелир / Кольца', icon: '💍', tile: 'bg-[#E6EEE2]', count: 8 },
  { id: 'print', name: 'Полиграфия', icon: '📜', tile: 'bg-[#F3E3D3]', count: 19 },
  { id: 'photobooth', name: 'Фотобудка', icon: '📷', tile: 'bg-[#F2DFDC]', count: 14 },
  { id: 'firework', name: 'Пиротехника', icon: '🎆', tile: 'bg-[#D9CCE3]', count: 9 },
  { id: 'reels', name: 'Reels-мейкер', icon: '🎬', tile: 'bg-[#F2DFDC]', count: 11 },
  { id: 'painter', name: 'Live Painter', icon: '🎨', tile: 'bg-[#E6EEE2]', count: 5 },
  { id: 'nanny', name: 'Аниматор / Няня', icon: '🎪', tile: 'bg-[#F3E3D3]', count: 16 },
  { id: 'bar', name: 'Сомелье / Бар', icon: '🍷', tile: 'bg-[#D9CCE3]', count: 7 },
  { id: 'dance', name: 'Хореограф', icon: '💃', tile: 'bg-[#C3D5E8]', count: 13 },
  { id: 'agency', name: 'Организатор', icon: '🎯', tile: 'bg-[#F2DFDC]', count: 21 },
  { id: 'rental', name: 'Рентал / Мебель', icon: '🕯️', tile: 'bg-[#E6EEE2]', count: 10 },
]

export const vendors: Vendor[] = [
  {
    id: 'v1', name: 'Елена Смирнова', category: 'Фотограф', categoryIcon: '📸', tile: 'bg-[#F2DFDC]',
    rating: 4.9, reviews: 47, priceFrom: 85000, years: 5, freeOnDate: true, hasVideo: true, photos: 5,
    desc: 'Светлый живой стиль, ловлю эмоции, а не постановку. Снимаю свадьбы в Уфе и по Башкирии 5 лет — 120+ пар.',
    packages: [
      { name: 'Утро и церемония', price: 45000, items: ['6 часов съёмки', '250+ фото в обработке', 'Онлайн-галерея'] },
      { name: 'Полный день', price: 85000, items: ['12 часов съёмки', '500+ фото', 'Экспресс 30 фото за 48 ч', 'Премиум-фотокнига'] },
      { name: 'Люкс', price: 130000, items: ['2 фотографа', 'Love story в подарок', 'Слайд-шоу на банкете'] },
    ],
  },
  {
    id: 'v2', name: 'CinemaWedding Team', category: 'Видеооператор', categoryIcon: '🎥', tile: 'bg-[#E6EEE2]',
    rating: 5.0, reviews: 32, priceFrom: 120000, years: 7, freeOnDate: true, hasVideo: true, photos: 5,
    desc: 'Кинематографичные фильмы о дне: 2 камеры, аэросъёмка, звук с петличек. Монтаж за 30 дней.',
    packages: [
      { name: 'Клип', price: 120000, items: ['2 оператора', 'Клип 4–6 мин', 'Аэросъёмка'] },
      { name: 'Фильм', price: 180000, items: ['Клип + фильм 25–40 мин', 'Запись аудио церемонии', 'RAW-архив'] },
    ],
  },
  {
    id: 'v3', name: 'Усадьба «Липовый сад»', category: 'Площадка', categoryIcon: '🏛️', tile: 'bg-[#F0DCB8]',
    rating: 4.7, reviews: 89, priceFrom: 250000, freeOnDate: true, hasVideo: true, photos: 5,
    desc: 'Загородная усадьба в 20 минутах от Уфы: шатёр у озера до 120 гостей, липовая аллея для церемонии, номера для молодожёнов.',
    packages: [
      { name: 'Будни', price: 180000, items: ['Аренда шатра', 'Мебель и текстиль', 'Парковка 60 авто'] },
      { name: 'Выходной', price: 250000, items: ['Шатёр + аллея', 'Кейтеринг-зона', 'Номер молодожёнам', 'Координатор площадки'] },
    ],
  },
  {
    id: 'v4', name: 'Артём Краснов', category: 'Ведущий', categoryIcon: '🎤', tile: 'bg-[#D9CCE3]',
    rating: 4.8, reviews: 56, priceFrom: 60000, years: 8, freeOnDate: true, hasVideo: false, photos: 5,
    desc: 'Ведущий без пошлости и конкурсов из 2005-го. Интеллигентный юмор, живой контакт с гостями, английский — по запросу.',
    packages: [
      { name: 'Банкет', price: 60000, items: ['6 часов программы', 'Музыкальное оформление', 'Сценарий под пару'] },
      { name: 'Церемония + банкет', price: 85000, items: ['Выездная регистрация', 'Диджей в комплекте'] },
    ],
  },
  {
    id: 'v5', name: 'Студия «Пион»', category: 'Флорист', categoryIcon: '🌸', tile: 'bg-[#F2DFDC]',
    rating: 4.9, reviews: 41, priceFrom: 45000, freeOnDate: true, hasVideo: true, photos: 5,
    desc: 'Авторская флористика: букет, бутоньерки, оформление церемонии и столов. Работаем с сезонными цветами и пионами.',
    packages: [
      { name: 'Букет + детали', price: 15000, items: ['Букет невесты', 'Дублёр', 'Бутоньерка'] },
      { name: 'Церемония', price: 45000, items: ['Арка / композиция', 'Дорожка', 'Букет и бутоньерка'] },
      { name: 'Полное оформление', price: 120000, items: ['Церемония + банкет', 'Сervise столов', 'Монтаж/демонтаж'] },
    ],
  },
  {
    id: 'v6', name: 'Тимур Галин', category: 'Фотограф', categoryIcon: '📸', tile: 'bg-[#F2DFDC]',
    rating: 0, reviews: 0, priceFrom: 45000, years: 2, freeOnDate: true, hasVideo: false, isNew: true, photos: 3,
    desc: 'Начинающий фотограф с сильным портфолио городских съёмок. Первые свадьбы — по специальной цене.',
    packages: [{ name: 'Полный день', price: 45000, items: ['10 часов', '300+ фото', 'Онлайн-галерея'] }],
  },
]

export interface Slot { id: string; categoryId: string; label: string; icon: string; tile: string; state: SlotState; vendor?: string; price?: number; status?: string }

export const initialSlots: Slot[] = [
  { id: 's1', categoryId: 'venue', label: 'Площадка', icon: '🏛️', tile: 'bg-[#F0DCB8]', state: 'booked', vendor: 'Усадьба «Липовый сад»', price: 250000, status: 'Забронировано' },
  { id: 's2', categoryId: 'photo', label: 'Фотограф', icon: '📸', tile: 'bg-[#F2DFDC]', state: 'booked', vendor: 'Елена Смирнова', price: 85000, status: 'Забронировано' },
  { id: 's3', categoryId: 'video', label: 'Видеограф', icon: '🎥', tile: 'bg-[#E6EEE2]', state: 'booked', vendor: 'CinemaWedding Team', price: 120000, status: 'Забронировано' },
  { id: 's4', categoryId: 'host', label: 'Ведущий', icon: '🎤', tile: 'bg-[#D9CCE3]', state: 'hold', vendor: 'Артём Краснов', price: 60000, status: 'Аванс 50%' },
  { id: 's5', categoryId: 'florist', label: 'Флорист', icon: '🌸', tile: 'bg-[#F2DFDC]', state: 'hold', vendor: 'Студия «Пион»', price: 45000, status: 'Hold 72 ч' },
  { id: 's6', categoryId: 'cake', label: 'Кондитер', icon: '🎂', tile: 'bg-[#F0DCB8]', state: 'candidate', vendor: 'Кандидаты: 2' },
  { id: 's7', categoryId: 'stylist', label: 'Стилист', icon: '💄', tile: 'bg-[#F2DFDC]', state: 'candidate', vendor: 'Кандидат: 1' },
  { id: 's8', categoryId: 'dj', label: 'DJ', icon: '🎧', tile: 'bg-[#C3D5E8]', state: 'empty' },
  { id: 's9', categoryId: 'decor', label: 'Декоратор', icon: '✨', tile: 'bg-[#E6EEE2]', state: 'empty' },
  { id: 's10', categoryId: 'transport', label: 'Транспорт', icon: '🚗', tile: 'bg-[#F3E3D3]', state: 'empty' },
  { id: 's11', categoryId: 'dress', label: 'Платье', icon: '👗', tile: 'bg-[#D9CCE3]', state: 'empty' },
  { id: 's12', categoryId: 'rings', label: 'Кольца', icon: '💍', tile: 'bg-[#E6EEE2]', state: 'empty' },
]

export const budgetItems = [
  { name: 'Площадка и кейтеринг', amount: 480000, limit: 560000, color: '#D9A8A0' },
  { name: 'Фото и видео', amount: 205000, limit: 240000, color: '#A9BCA0' },
  { name: 'Одежда и красота', amount: 76000, limit: 180000, color: '#E3C892' },
  { name: 'Развлечения и декор', amount: 48000, limit: 144000, color: '#D9CCE3' },
  { name: 'Прочее', amount: 41000, limit: 96000, color: '#C3D5E8' },
]

export interface Task { id: string; title: string; done: boolean; due: string; period: string; urgent?: boolean }

export const tasks: Task[] = [
  { id: 't1', title: 'Выбрать дату свадьбы', done: true, due: '15 янв', period: '9' },
  { id: 't2', title: 'Определить бюджет', done: true, due: '20 янв', period: '9' },
  { id: 't3', title: 'Составить список гостей', done: true, due: '1 фев', period: '9' },
  { id: 't4', title: 'Забронировать площадку', done: true, due: '5 фев', period: '9' },
  { id: 't5', title: 'Найти фотографа', done: true, due: '15 фев', period: '9' },
  { id: 't6', title: 'Заказать приглашения', done: false, due: 'до 1 мар', period: '9', urgent: true },
  { id: 't7', title: 'Примерка платья (1 из 3)', done: false, due: 'до 15 мар', period: '9' },
  { id: 't8', title: 'Дегустация меню', done: false, due: 'до 1 апр', period: '6' },
  { id: 't9', title: 'Репетиция первого танца', done: false, due: 'до 1 мая', period: '6' },
  { id: 't10', title: 'Забронировать ведущего', done: false, due: 'до 15 мая', period: '6', urgent: true },
  { id: 't11', title: 'Утвердить тайминг дня', done: false, due: 'до 1 июн', period: '3' },
  { id: 't12', title: 'Финальная рассадка гостей', done: false, due: 'до 7 июн', period: '1' },
]

export const timeline = [
  { id: 'e1', icon: '🌅', tile: 'bg-[#F2DFDC]', name: 'Сборы невесты', loc: 'Отель «Ривьера», номер 304', time: '08:00 — 13:00', who: 'Стилист Елена · Фотограф Е. Смирнова' },
  { id: 'e2', icon: '🤵', tile: 'bg-[#E6EEE2]', name: 'Сборы жениха', loc: 'Квартира, ул. Лесная 12', time: '09:00 — 12:00', who: 'Барбер Иван · Видеооператор' },
  { id: 'e3', icon: '💍', tile: 'bg-[#F0DCB8]', name: 'Доставка букета и деталей', loc: 'Кольца, клятвы, подарки родителям', time: '12:00 — 13:00', who: 'Флорист · координатор' },
  { id: 'e4', icon: '💐', tile: 'bg-[#D9CCE3]', name: 'Выездная церемония', loc: 'Усадьба «Липовый сад», липовая аллея', time: '16:00 — 17:00', who: 'Гости с 15:30 · регистратор' },
  { id: 'e5', icon: '🥂', tile: 'bg-[#F3E3D3]', name: 'Банкет', loc: 'Шатёр у озера', time: '18:00 — 23:00', who: 'Ведущий · DJ · торт в 21:30' },
  { id: 'e6', icon: '🎆', tile: 'bg-[#C3D5E8]', name: 'Салют и финал', loc: 'Пирс', time: '22:30 — 23:00', who: 'Фаер-шоу · трансфер гостей 23:00' },
]

export interface Guest { id: string; name: string; status: 'yes' | 'no' | 'pending'; plus: boolean; table?: number }

export const guests: Guest[] = [
  { id: 'g1', name: 'Марина Ивановна (мама)', status: 'yes', plus: false, table: 1 },
  { id: 'g2', name: 'Игорь Петрович (папа)', status: 'yes', plus: false, table: 1 },
  { id: 'g3', name: 'Ольга и Денис Соколовы', status: 'yes', plus: true, table: 3 },
  { id: 'g4', name: 'Руслан Гареев', status: 'pending', plus: false },
  { id: 'g5', name: 'Тётя Люда', status: 'yes', plus: false, table: 2 },
  { id: 'g6', name: 'Коллеги Тимура (4)', status: 'pending', plus: true },
  { id: 'g7', name: 'Айгуль и Марсель', status: 'no', plus: false },
  { id: 'g8', name: 'Дядя Рафик', status: 'pending', plus: true },
]

export const contractTemplates = [
  { id: 'c1', icon: '📸', tile: 'bg-[#F2DFDC]', name: 'Договор с фотографом', desc: 'Услуги фотосъёмки, сроки отдачи, права на фото' },
  { id: 'c2', icon: '🏛️', tile: 'bg-[#F0DCB8]', name: 'Аренда площадки', desc: 'Дата, время, залог, ответственность сторон' },
  { id: 'c3', icon: '🎤', tile: 'bg-[#D9CCE3]', name: 'Договор с ведущим', desc: 'Программа, тайминг, аванс 50%' },
  { id: 'c4', icon: '🌸', tile: 'bg-[#E6EEE2]', name: 'Декоратор / флорист', desc: 'Эскизы, монтаж, форс-мажор с цветами' },
  { id: 'c5', icon: '🎂', tile: 'bg-[#F0DCB8]', name: 'Договор с кондитером', desc: 'Дегустация, вес, доставка, хранение' },
  { id: 'c6', icon: '📄', tile: 'bg-[#C3D5E8]', name: 'Универсальный договор услуг', desc: 'Для любой категории + акт выполненных работ' },
]

export interface Chat { id: string; name: string; icon: string; tile: string; last: string; time: string; unread: number; kind: 'vendor' | 'team' | 'day' }

export const chats: Chat[] = [
  { id: 'ch1', name: 'Елена Смирнова', icon: '📸', tile: 'bg-[#F2DFDC]', last: 'Отправила вам договор и презентацию ✨', time: '14:32', unread: 2, kind: 'vendor' },
  { id: 'ch2', name: 'Команда свадьбы', icon: '💍', tile: 'bg-[#F0DCB8]', last: 'Артём: ребята, по звуку свяжусь со световиком', time: '12:05', unread: 5, kind: 'team' },
  { id: 'ch3', name: 'Артём Краснов', icon: '🎤', tile: 'bg-[#D9CCE3]', last: 'Аванс получил, дата за вами!', time: 'вчера', unread: 0, kind: 'vendor' },
  { id: 'ch4', name: 'Студия «Пион»', icon: '🌸', tile: 'bg-[#F2DFDC]', last: 'Пришлём эскизы букета до пятницы', time: 'вчера', unread: 1, kind: 'vendor' },
  { id: 'ch5', name: 'Чат дня X · гости', icon: '🥂', tile: 'bg-[#E6EEE2]', last: 'Откроется 13 июня в 09:00', time: '—', unread: 0, kind: 'day' },
]

export const chatMessages = [
  { id: 'm1', me: false, text: 'Здравствуйте! Свободны на 14 июня 2027? Нам нужен полный день.', time: '14:10' },
  { id: 'm2', me: true, text: 'Здравствуйте, Алина! Да, 14 июня свободна 🎉 Смотрю, у вас усадьба «Липовый сад» — обожаю там снимать, свет волшебный.', time: '14:18' },
  { id: 'm3', me: true, text: 'Отправляю договор и презентацию с пакетами. Рекомендую «Полный день» — 12 часов как раз закрывают сборы → салют.', time: '14:20' },
  { id: 'm4', me: false, text: 'Спасибо! Обсудим с Тимуром вечером и вернёмся. А экспресс-фото за 48 часов правда успеваете?', time: '14:28' },
  { id: 'm5', me: true, text: 'Гарантирую в договоре 🙂 30 фото через 48 часов, остальное — до 30 дней.', time: '14:32' },
]

export const aiTips = [
  'Топ-фотографы Уфы на июнь разбираются за 8 месяцев. Свободных на 14.06 осталось 6 — посмотреть?',
  'Пустой слот «Флорист» блокирует автоплан дня — букет нужен к 10:00 сборам.',
  '«Площадка и кейтеринг» на 86% лимита. Зафиксируйте меню до 1 марта — дальше цены вырастут ~10%.',
]

export const fmt = (n: number) => new Intl.NumberFormat('ru-RU').format(n) + ' ₽'
