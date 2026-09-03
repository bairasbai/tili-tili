/* Чат со своим подрядчиком — тем, кого пара нашла сама (§11).
 *
 * У него нет анкеты в каталоге и нет аккаунта: он приходит по ссылке
 * на свой слот. Поэтому чат привязывается к СЛОТУ, а не к подрядчику —
 * `chats.vendor_id` для него пуст по определению.
 *
 * Отдельный вид, а не «vendor без vendor_id»: ограничение
 * `(kind = 'vendor') = (vendor_id IS NOT NULL)` держит смысл вида, и
 * ослаблять его ради одного случая значит потерять проверку для всех
 * остальных.
 */
exports.up = (pgm) => {
  pgm.addColumns('chats', {
    slot_id: { type: 'uuid', references: 'slots', onDelete: 'CASCADE' },
  })

  pgm.dropConstraint('chats', 'chats_kind_known')
  pgm.addConstraint('chats', 'chats_kind_known', "CHECK (kind IN ('vendor','team','day','tilly','external'))")

  // Слот обязателен ровно у своего вида чата и бессмыслен у остальных.
  pgm.addConstraint('chats', 'chats_slot_only_for_external', "CHECK ((kind = 'external') = (slot_id IS NOT NULL))")

  /* Командный чат, чат дня и Тиль у свадьбы по одному — а своих подрядчиков
   * может быть несколько, по одному на слот. Прежний индекс покрывал всё,
   * кроме `vendor`, и запретил бы второго своего подрядчика. */
  pgm.dropIndex('chats', ['wedding_id', 'kind'], { unique: true, where: "kind <> 'vendor'" })
  pgm.createIndex('chats', ['wedding_id', 'kind'], {
    unique: true,
    where: "kind NOT IN ('vendor','external')",
  })
  pgm.createIndex('chats', ['wedding_id', 'slot_id'], { unique: true, where: "kind = 'external'" })

  /* Своим подрядчикам, добавленным до этой миграции, чат заводится сразу:
   * иначе он появится только у тех, кого пригласят заново. */
  pgm.sql(`
    INSERT INTO chats (id, wedding_id, kind, slot_id)
    SELECT gen_random_uuid(), d.wedding_id, 'external', d.slot_id
      FROM deals d
     WHERE d.external_name IS NOT NULL AND d.slot_id IS NOT NULL
       AND d.state <> 'cancelled'
    ON CONFLICT DO NOTHING;
  `)
}

exports.down = (pgm) => {
  pgm.sql("DELETE FROM chats WHERE kind = 'external';")
  pgm.dropIndex('chats', ['wedding_id', 'slot_id'], { unique: true, where: "kind = 'external'" })
  pgm.dropIndex('chats', ['wedding_id', 'kind'], { unique: true, where: "kind NOT IN ('vendor','external')" })
  pgm.createIndex('chats', ['wedding_id', 'kind'], { unique: true, where: "kind <> 'vendor'" })
  pgm.dropConstraint('chats', 'chats_slot_only_for_external')
  pgm.dropConstraint('chats', 'chats_kind_known')
  pgm.addConstraint('chats', 'chats_kind_known', "CHECK (kind IN ('vendor','team','day','tilly'))")
  pgm.dropColumns('chats', ['slot_id'])
}
