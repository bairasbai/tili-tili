/* Ротация refresh внутри одной сессии.
 *
 * Было: каждое обновление токена заводило НОВУЮ строку сессии. Экран
 * «Сессии и устройства» за неделю превращался в список из сотен «входов»,
 * а время входа сбрасывалось при каждом обновлении — по нему нельзя было
 * заметить чужое устройство.
 *
 * Стало: одно устройство — одна строка. Обновление меняет только хеш.
 * Предыдущий хеш сохраняется: по нему ловится повторное предъявление
 * украденного токена — иначе после ротации старый токен просто «не найден»,
 * и кражу не отличить от опечатки.
 */
exports.up = (pgm) => {
  pgm.addColumns('sessions', {
    prev_refresh_hash: { type: 'text' },
    rotated_at: { type: 'timestamptz' },
  })
  pgm.createIndex('sessions', 'prev_refresh_hash', { where: 'prev_refresh_hash IS NOT NULL' })

  // Коды из SMS — персональные данные. Хранить их дольше, чем работает
  // ограничение частоты (час), незачем; уборка идёт при каждом запросе кода,
  // поэтому нужен индекс по времени, а не только по (phone, created_at).
  pgm.createIndex('otp_codes', 'created_at')
}

exports.down = (pgm) => {
  pgm.dropIndex('otp_codes', 'created_at')
  pgm.dropIndex('sessions', 'prev_refresh_hash')
  pgm.dropColumns('sessions', ['prev_refresh_hash', 'rotated_at'])
}
