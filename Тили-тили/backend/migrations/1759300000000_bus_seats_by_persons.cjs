/**
 * Автобус считает людей, а не записи (фича 005, В1).
 *
 * Запись гостя «с +1» — двое на сиденьях, а триггер `bus_seat_counter`
 * прибавлял единицу: `taken` на экране пары врал ровно на число «+1», а
 * отказ «мест нет» считал персоны в обработчике (ERR-0234) — правило жило
 * не там, где должно (CLAUDE.md §5 п. 11).
 *
 * Число персон хранится в самой записи (`bus_bookings.persons`): при
 * удалении гостя записи уходят каскадом, и строки гостя в тот момент уже
 * нет — считать «1 + plus_one» по гостю из триггера удаления нельзя.
 * Ставится триггером при вставке, пересчитывается при смене `plus_one`.
 *
 * `bus_taken_bounded` пересоздаётся `NOT VALID`: четыре тестовых маршрута
 * в дев-базе уже переполнены по персонам (места 1, гость с +1). Старые
 * строки остаются как есть — честное «переполнен», а не подогнанное число,
 * — новые и изменённые проверяются. `VALIDATE CONSTRAINT` — после уборки
 * данных владельцем (RELEASE-BLOCKERS.md).
 */
exports.up = (pgm) => {
  pgm.addColumns('bus_bookings', {
    persons: { type: 'smallint', notNull: true, default: 1 },
  })
  pgm.addConstraint('bus_bookings', 'bus_bookings_persons_range', 'CHECK (persons BETWEEN 1 AND 2)')

  pgm.sql(`
    UPDATE bus_bookings b SET persons = 1 + g.plus_one::int
      FROM guests g WHERE g.id = b.guest_id;

    -- Персоны записи — от гостя, обработчику знать об этом не нужно.
    CREATE FUNCTION bus_booking_persons() RETURNS trigger AS $$
    BEGIN
      SELECT 1 + plus_one::int INTO NEW.persons FROM guests WHERE id = NEW.guest_id;
      NEW.persons := coalesce(NEW.persons, 1);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER bus_bookings_persons
      BEFORE INSERT ON bus_bookings
      FOR EACH ROW EXECUTE FUNCTION bus_booking_persons();

    CREATE OR REPLACE FUNCTION bus_seat_counter() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        UPDATE bus_routes SET taken = taken + NEW.persons WHERE id = NEW.bus_id;
        RETURN NEW;
      ELSIF TG_OP = 'UPDATE' THEN
        UPDATE bus_routes SET taken = taken + (NEW.persons - OLD.persons) WHERE id = NEW.bus_id;
        RETURN NEW;
      ELSE
        UPDATE bus_routes SET taken = taken - OLD.persons WHERE id = OLD.bus_id;
        RETURN OLD;
      END IF;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS bus_bookings_count ON bus_bookings;
    CREATE TRIGGER bus_bookings_count
      AFTER INSERT OR DELETE OR UPDATE OF persons ON bus_bookings
      FOR EACH ROW EXECUTE FUNCTION bus_seat_counter();

    -- Гость передумал насчёт «+1» — его записи в автобус пересчитываются.
    CREATE FUNCTION bus_bookings_follow_plus_one() RETURNS trigger AS $$
    BEGIN
      UPDATE bus_bookings SET persons = 1 + NEW.plus_one::int WHERE guest_id = NEW.id;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER guests_plus_one_seats
      AFTER UPDATE OF plus_one ON guests
      FOR EACH ROW WHEN (OLD.plus_one IS DISTINCT FROM NEW.plus_one)
      EXECUTE FUNCTION bus_bookings_follow_plus_one();

    ALTER TABLE bus_routes DROP CONSTRAINT bus_taken_bounded;
    UPDATE bus_routes r SET taken = coalesce(
      (SELECT sum(b.persons) FROM bus_bookings b WHERE b.bus_id = r.id), 0);
    ALTER TABLE bus_routes ADD CONSTRAINT bus_taken_bounded
      CHECK (taken >= 0 AND taken <= seats) NOT VALID;
  `)
}

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS guests_plus_one_seats ON guests;
    DROP FUNCTION IF EXISTS bus_bookings_follow_plus_one();
    DROP TRIGGER IF EXISTS bus_bookings_count ON bus_bookings;
    DROP TRIGGER IF EXISTS bus_bookings_persons ON bus_bookings;
    DROP FUNCTION IF EXISTS bus_booking_persons();

    CREATE OR REPLACE FUNCTION bus_seat_counter() RETURNS trigger AS $$
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

    ALTER TABLE bus_routes DROP CONSTRAINT bus_taken_bounded;
    UPDATE bus_routes r SET taken = (SELECT count(*) FROM bus_bookings b WHERE b.bus_id = r.id);
    ALTER TABLE bus_routes ADD CONSTRAINT bus_taken_bounded CHECK (taken >= 0 AND taken <= seats) NOT VALID;
  `)
  pgm.dropConstraint('bus_bookings', 'bus_bookings_persons_range')
  pgm.dropColumns('bus_bookings', ['persons'])
}
