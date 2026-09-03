/* Часовой пояс города — и свадьбы.
 *
 * До этой миграции `weddings.tz` не заполнялся никогда: обработчик брал
 * из справочника `null::text as tz`, потому что колонки не было. Всё, что
 * зависит от местного времени, считалось по Москве для всей страны —
 * чат дня X во Владивостоке открывался в день свадьбы после обеда вместо
 * «накануне в 09:00».
 *
 * Зона определяется субъектом федерации, а не координатами: границы
 * часовых поясов в России идут ровно по границам регионов, и таблица
 * ниже — справочные данные, а не догадка.
 */
const TZ_BY_REGION = {
  // UTC+3
  'Москва': 'Europe/Moscow',
  'Санкт-Петербург': 'Europe/Moscow',
  'Воронежская область': 'Europe/Moscow',
  'Краснодарский край': 'Europe/Moscow',
  'Нижегородская область': 'Europe/Moscow',
  'Ростовская область': 'Europe/Moscow',
  'Тульская область': 'Europe/Moscow',
  'Ярославская область': 'Europe/Moscow',
  'Татарстан': 'Europe/Moscow',
  'Волгоградская область': 'Europe/Volgograd',
  // UTC+4
  'Самарская область': 'Europe/Samara',
  'Удмуртия': 'Europe/Samara',
  // UTC+5
  'Башкортостан': 'Asia/Yekaterinburg',
  'Пермский край': 'Asia/Yekaterinburg',
  'Свердловская область': 'Asia/Yekaterinburg',
  'Челябинская область': 'Asia/Yekaterinburg',
  'Оренбургская область': 'Asia/Yekaterinburg',
  'Тюменская область': 'Asia/Yekaterinburg',
  // UTC+6
  'Омская область': 'Asia/Omsk',
  // UTC+7
  'Новосибирская область': 'Asia/Novosibirsk',
  'Алтайский край': 'Asia/Barnaul',
  'Красноярский край': 'Asia/Krasnoyarsk',
  // UTC+8
  'Иркутская область': 'Asia/Irkutsk',
  // UTC+10
  'Приморский край': 'Asia/Vladivostok',
  'Хабаровский край': 'Asia/Vladivostok',
}

exports.up = (pgm) => {
  pgm.addColumns('cities', { tz: { type: 'text' } })

  // Кавычки удваиваем сами: в названиях регионов апострофов нет, но
  // подставлять данные в SQL без экранирования нельзя даже свои.
  const quote = (v) => `'${String(v).replace(/'/g, "''")}'`
  const pairs = Object.entries(TZ_BY_REGION)
    .map(([region, tz]) => `(${quote(region)}, ${quote(tz)})`)
    .join(', ')
  pgm.sql(`
    UPDATE cities c SET tz = m.tz
      FROM (VALUES ${pairs}) AS m(region, tz)
     WHERE c.region = m.region;
  `)

  /* Свадьбам, заведённым до этой миграции, пояс проставляется от города.
   * Уже указанный вручную не трогаем: человек мог поправить его сам. */
  pgm.sql(`
    UPDATE weddings w SET tz = c.tz
      FROM cities c
     WHERE c.id = w.city_id AND w.tz IS NULL AND c.tz IS NOT NULL;
  `)

  /* Смена даты и пояса пересчитывает открытие чата дня X — триггер уже
   * стоит с этапа 7. Здесь достаточно прогнать его по изменённым строкам. */
  pgm.sql(`UPDATE weddings SET tz = tz WHERE tz IS NOT NULL;`)
}

exports.down = (pgm) => {
  pgm.dropColumns('cities', ['tz'])
}
