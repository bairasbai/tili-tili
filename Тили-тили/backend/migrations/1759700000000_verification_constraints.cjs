/**
 * Заявка на проверку: документ — только по https, «на проверке» — одна (фича 005, В1).
 *
 * Оба правила уже держал обработчик (`vendorCabinet.ts`: схема тела и
 * `select … status = 'pending'` перед вставкой). Второе — гонка: два
 * нажатия «Отправить» проходили проверку одновременно и давали две
 * заявки в очереди модерации. Частичный уникальный индекс закрывает гонку,
 * обработчик переводит `23505` в тот же 409 `verification_pending`.
 */
exports.up = (pgm) => {
  pgm.addConstraint(
    'vendor_verifications',
    'vendor_verifications_file_url_https',
    "CHECK (file_url IS NULL OR file_url LIKE 'https://%')",
  )
  pgm.createIndex('vendor_verifications', ['vendor_id'], { unique: true, where: "status = 'pending'" })
}

exports.down = (pgm) => {
  pgm.dropIndex('vendor_verifications', ['vendor_id'], { unique: true, where: "status = 'pending'" })
  pgm.dropConstraint('vendor_verifications', 'vendor_verifications_file_url_https')
}
