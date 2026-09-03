/* Счётчики занятых мест переносятся в триггеры.
 *
 * `taken` и `booked` — производные значения. Обработчик увеличивал их сам,
 * но строки исчезают и мимо него: удаление гостя каскадом уносит запись
 * в автобус, а счётчик остаётся высоким. Автобус выглядит полным при
 * пустом сиденье, и следующий гость не садится.
 *
 * Триггер считает по факту строк и работает при любом пути удаления.
 * `CHECK taken BETWEEN 0 AND seats` остаётся страховкой: переполнение
 * откатывает транзакцию, а обработчик переводит это в 409.
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE FUNCTION bus_seat_counter() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        UPDATE bus_routes SET taken = taken + 1 WHERE id = NEW.bus_id;
        RETURN NEW;
      ELSE
        UPDATE bus_routes SET taken = taken - 1 WHERE id = OLD.bus_id;
        RETURN OLD;
      END IF;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER bus_bookings_count
      AFTER INSERT OR DELETE ON bus_bookings
      FOR EACH ROW EXECUTE FUNCTION bus_seat_counter();

    CREATE FUNCTION hotel_room_counter() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        UPDATE hotel_blocks SET booked = booked + 1 WHERE id = NEW.hotel_id;
        RETURN NEW;
      ELSE
        UPDATE hotel_blocks SET booked = booked - 1 WHERE id = OLD.hotel_id;
        RETURN OLD;
      END IF;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER hotel_bookings_count
      AFTER INSERT OR DELETE ON hotel_bookings
      FOR EACH ROW EXECUTE FUNCTION hotel_room_counter();
  `)
}

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS hotel_bookings_count ON hotel_bookings;
    DROP FUNCTION IF EXISTS hotel_room_counter();
    DROP TRIGGER IF EXISTS bus_bookings_count ON bus_bookings;
    DROP FUNCTION IF EXISTS bus_seat_counter();
  `)
}
