/* Первая миграция: только расширения. Таблицы приходят с этапами 1+.
 *
 * Правило миграций (План §19.9): только вперёд-совместимые, expand -> migrate ->
 * contract. Колонку добавляем nullable, заполняем, потом делаем NOT NULL —
 * тремя выкатами, а не одним, иначе старый код падает между деплоем и миграцией.
 */
exports.up = (pgm) => {
  // gen_random_uuid() для значений по умолчанию; идентификаторы v7
  // генерирует приложение — они сортируемы по времени, в PG16 их ещё нет.
  pgm.createExtension('pgcrypto', { ifNotExists: true })
  // citext: адрес почты уникален без учёта регистра. Иначе Ivan@ и ivan@
  // заводят два аккаунта на одного человека.
  pgm.createExtension('citext', { ifNotExists: true })
}

exports.down = (pgm) => {
  pgm.dropExtension('citext', { ifExists: true })
  pgm.dropExtension('pgcrypto', { ifExists: true })
}
