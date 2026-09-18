/**
 * Хвосты плана бэкенда (сверка планов 2026-09-18): три поля, которых план
 * требовал с первого дня, а код так и не завёл.
 *
 * 1. `consents.adult` — 152-ФЗ, раздел 7 плана: «чекбокс „мне есть 18“ в
 *    согласии — возраст отдельным флагом». `policy_version` покрывает текст,
 *    возраст текстом не покрывается. Прежние строки получают `false`: что
 *    человек не подтверждал, того в базе нет — дорисовывать «да» задним
 *    числом нельзя. Сервер старые согласия не отзывает: повторный вход
 *    показывает галочку заново, и новая строка ложится с флагом.
 *
 * 2. `vendors.media_rights_at` — раздел 7 плана: «флаг при PUT /vendor/profile —
 *    права на фото и согласие снятых». Момент, а не boolean: подтверждение —
 *    это событие с датой, как согласие на ПДн. Ставится один раз, не снимается.
 *
 * 3. `job_marks` — ключи фоновых задач раздела 5 (`after:{weddingId}:{step}`,
 *    `catering:{weddingId}:{date}`): вторая отправка за тем же ключом не встаёт
 *    (`on conflict do nothing`), сколько раз задачу ни перезапусти — тот же
 *    приём, что `digest_sent`, только без таблицы на каждую задачу.
 */
exports.up = (pgm) => {
  pgm.addColumns('consents', {
    adult: { type: 'boolean', notNull: true, default: false },
  })
  pgm.addColumns('vendors', {
    media_rights_at: { type: 'timestamptz' },
  })
  pgm.createTable('job_marks', {
    key: { type: 'text', primaryKey: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('job_marks', 'job_marks_key_length', 'CHECK (length(key) BETWEEN 1 AND 120)')
}

exports.down = (pgm) => {
  pgm.dropTable('job_marks')
  pgm.dropColumns('vendors', ['media_rights_at'])
  pgm.dropColumns('consents', ['adult'])
}
