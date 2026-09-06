/*
 * Дополнение словаря: строки, которых нет в разметке.
 *
 * Здесь остались две группы. Первая — тексты шаблонов приглашений
 * (`lib/inviteThemes.ts`). Вторая — то, что приходит с сервера и переводится
 * динамически: названия категорий каталога, подписи слотов, города и регионы.
 * В коде их не найти — они лежат в данных бэкенда, и без этих ключей
 * английский интерфейс говорил бы по-русски.
 *
 * Сто девятнадцать строк удалённого `lib/data.ts` отсюда убраны вместе с ним:
 * «Здравствуйте, Алина! Да, 14 июня свободна», «Топ-фотографы Уфы на июнь
 * разбираются за 8 месяцев», «Медовый месяц в Каппадокии» — переводить нечего,
 * этих данных больше нет.
 */
export const EN_DATA: Record<string, string> = {
  ' + 100 км': ' + 100 km',
  'Все →': 'All →',
  'запланировано · осталось': 'planned · left',
  '12 часов съёмки': '12 hours of shooting',
  '2 фотографа': '2 photographers',
  '6 часов съёмки': '6 hours of shooting',
  'DJ / Музыканты': 'DJ / Musicians',
  'Reels-мейкер': 'Reels maker',
  'Алина Козлова & Тимур Волков': 'Alina Kozlova & Timur Volkov',
  'Аниматор / Няня': 'Entertainer / Nanny',
  'Аренда площадки': 'Venue rent',
  'Бархатный занавес и премьера вашей истории': 'Velvet curtain and the premiere of your story',
  'Ведущий / Тамада': 'Host / MC',
  'Видеооператор': 'Videographer',
  'Воздушные цветы и мягкая романтика': 'Airy flowers and soft romance',
  'Выбрать дату свадьбы': 'Choose the wedding date',
  'Дата, время, залог, ответственность сторон': 'Date, time, deposit, liability of the parties',
  'Дегустация, вес, доставка, хранение': 'Tasting, weight, delivery, storage',
  'Декоратор': 'Decorator',
  'Декоратор / флорист': 'Decorator / florist',
  'Для любой категории + акт выполненных работ': 'For any category + acceptance certificate',
  'Договор с ведущим': 'Contract with the host',
  'Договор с кондитером': 'Contract with the baker',
  'Жемчуг, золото и вышивка ручной работы': 'Pearls, gold and handmade embroidery',
  'Журнальная типографика, строгая композиция': 'Editorial typography, strict composition',
  'Забронировано': 'Booked',
  'Итальянское лето и кинематографичный свет': 'Italian summer and cinematic light',
  'Кейтеринг': 'Catering',
  'Кольца': 'Rings',
  'Команда свадьбы': 'Wedding team',
  'Кондитер': 'Baker',
  'Костюм жениха': 'Groom’s suit',
  'Маджестик': 'Majestic',
  'Морская графика и свежий синий акцент': 'Marine graphics and a fresh blue accent',
  'Ольга и Денис Соколовы': 'Olga and Denis Sokolov',
  'Организатор': 'Planner',
  'Пиротехника': 'Pyrotechnics',
  'Платье': 'Dress',
  'Полиграфия': 'Print',
  'Природная спокойная элегантность': 'Natural, calm elegance',
  'Программа, тайминг, аванс 50%': 'Program, timeline, 50% deposit',
  'Рентал / Мебель': 'Rentals / Furniture',
  'Свадебное платье': 'Wedding dress',
  'Свет и звук': 'Light and sound',
  'Современная типографика с лёгким характером': 'Modern typography with a light character',
  'Сомелье / Бар': 'Sommelier / Bar',
  'Стилист': 'Stylist',
  'Стилист / Визажист': 'Stylist / Makeup artist',
  'Студия «Пион»': '“Pion” studio',
  'Таинственный сад и камерная романтика': 'Secret garden and intimate romance',
  'Театро': 'Teatro',
  'Транспорт': 'Transport',
  'Транспорт / Кортеж': 'Transport / Motorcade',
  'Тёплая богемная палитра и свободная композиция': 'Warm bohemian palette and free composition',
  'Универсальный договор услуг': 'Universal service contract',
  'Услуги фотосъёмки, сроки отдачи, права на фото': 'Photography services, delivery terms, photo rights',
  'Флорист': 'Florist',
  'Фотобудка': 'Photo booth',
  'Хореограф': 'Choreographer',
  'Шалфей': 'Sage',
  'Эскизы, монтаж, форс-мажор с цветами': 'Sketches, setup, flower force majeure',
  'Ювелир / Кольца': 'Jewelry / Rings',
  'до 1 мар': 'by Mar 1',
}

// Вишлист — данные (EN)
export const EN_DATA_GIFTS: Record<string, string> = {
  'Робот-пылесос': 'Robot vacuum',
}

// Фонды, анти-вишлист, палитры (EN)
export const EN_DATA_GIFTS2: Record<string, string> = {
  'Пудровая классика': 'Powdery classics',
  'Шалфей и сливки': 'Sage and cream',
  'Лавандовый вечер': 'Lavender evening',
  'Медовый закат': 'Honey sunset',
}
