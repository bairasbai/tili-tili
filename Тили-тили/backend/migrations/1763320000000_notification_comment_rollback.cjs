// Forward correction for the local schema's inherited NULL comment. Do not
// rewrite applied 176320 or overwrite a different later owner comment on down.
exports.up = () => {}
exports.down = pgm => {
  pgm.sql(`DO $$ BEGIN
    IF col_description('notifications'::regclass,
      (SELECT attnum FROM pg_attribute WHERE attrelid='notifications'::regclass AND attname='pushed_at')) =
      'Legacy push-processing timestamp; does not prove provider acceptance, device delivery or reading' THEN
      COMMENT ON COLUMN notifications.pushed_at IS NULL;
    END IF;
  END $$;`)
}
