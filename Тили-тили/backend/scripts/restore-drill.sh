#!/usr/bin/env sh
# Репетиция восстановления (План §19.9).
#
# Копия, которую ни разу не разворачивали, — это не резервная копия,
# а файл. Скрипт делает то же, что придётся делать в аварии, и меряет
# время: цель RTO — четыре часа, и она проверяется, а не декларируется.
#
# Порядок ровно как в аварии:
#   1. взять копию — файл из $BACKUP_DIR (DUMP=…), а на плановой репетиции
#      без DUMP — свежий дамп боевой базы,
#   2. создать ЧИСТУЮ базу (не ту же самую — иначе проверка ничего не стоит),
#   3. развернуть в неё копию,
#   4. убедиться, что схема на месте и данные читаются.
#
#   DUMP="$BACKUP_DIR/tili-<время>.dump" DRILL_DB=tili_restore \
#   ADMIN_URL=postgres://postgres:…@host:5432/postgres sh scripts/restore-drill.sh
set -eu

: "${DATABASE_URL:?нужен DATABASE_URL}"
DRILL_DB="${DRILL_DB:-tili_drill}"
ADMIN_URL="${ADMIN_URL:-$DATABASE_URL}"
WORK="${WORK:-/tmp/tili-drill}"
DUMP="${DUMP:-}"

# Имя целевой базы — первым делом, до любого обращения к серверу: шаг 2 делает
# DROP DATABASE, и DRILL_DB, совпавший с боевой базой, стёр бы её (FL-15,
# ERR-0285). Служебные базы и имена не из [A-Za-z0-9_] (кавычки, пробелы,
# точка с запятой попали бы в SQL) — туда же.
SOURCE_DB="$(printf '%s' "$DATABASE_URL" | sed -e 's#^[^/]*//[^/]*/##' -e 's#[?].*$##')"
case "$SOURCE_DB" in
  '' | *[!A-Za-z0-9_-]*)
    echo "ОСТАНОВКА: не разобрал имя боевой базы в DATABASE_URL (\"$SOURCE_DB\") — укажи его явно: …:5432/tili" >&2
    exit 2
    ;;
esac
case "$DRILL_DB" in
  "$SOURCE_DB" | postgres | template0 | template1 | *[!A-Za-z0-9_]*)
    echo "ОСТАНОВКА: DRILL_DB=\"$DRILL_DB\" — боевая ($SOURCE_DB), служебная база или недопустимое имя." >&2
    echo "Копия разворачивается только в отдельную базу, например DRILL_DB=tili_restore" >&2
    exit 2
    ;;
esac

# Файл копии — тоже до проверки прав и до шага 2: не читается или не архив
# pg_dump — останавливаемся, ничего не создав и не удалив.
if [ -n "$DUMP" ]; then
  if [ ! -r "$DUMP" ]; then
    echo "ОСТАНОВКА: копия \"$DUMP\" не найдена или не читается." >&2
    exit 2
  fi
  if ! pg_restore --list "$DUMP" >/dev/null; then
    echo "ОСТАНОВКА: \"$DUMP\" — не архив pg_dump (нужен --format=custom, как у backup.sh)." >&2
    exit 2
  fi
fi

# Проверка прав ДО съёма копии: без неё репетиция падала на шаге 2,
# потратив минуты на 86 МБ дампа, и оставляла оператора разбираться с ошибкой
# прав в аварийном режиме (RELEASE-BLOCKERS №31). Лечится одной командой
# суперпользователя, один раз на машину.
CAN_CREATE="$(psql -tAc "select rolcreatedb or rolsuper from pg_roles where rolname = current_user" "$ADMIN_URL" 2>/dev/null || echo f)"
if [ "$CAN_CREATE" != "t" ]; then
  echo "ОСТАНОВКА: роль без права CREATE DATABASE — шаг 2 невозможен." >&2
  echo "Выдать право (один раз, от суперпользователя):" >&2
  echo "  psql -U postgres -c 'ALTER ROLE tili CREATEDB'" >&2
  echo "Либо передать адрес суперпользователя: ADMIN_URL=postgres://postgres:...@localhost:5432/postgres" >&2
  exit 2
fi

START="$(date +%s)"

if [ -n "$DUMP" ]; then
  echo "1/4 беру копию $DUMP"
else
  # Без DUMP — плановая репетиция на свежем дампе. В аварии указывай файл из
  # $BACKUP_DIR: свежий дамп упавшей базы — не то, что нужно восстанавливать.
  mkdir -p "$WORK"
  DUMP="$WORK/drill.dump"
  echo "1/4 снимаю свежую копию (DUMP не задан)"
  pg_dump --format=custom --no-owner --no-privileges --file="$DUMP" "$DATABASE_URL"
fi

echo "2/4 создаю чистую базу $DRILL_DB"
# Опции — ДО адреса базы: psql на Windows не переставляет аргументы, и опции
# после адреса молча отбрасываются («лишний аргумент игнорируется»); на Linux
# порядок безразличен. Роли базы нужен CREATEDB — или ADMIN_URL суперпользователя.
psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$DRILL_DB\"" "$ADMIN_URL" >/dev/null
psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DRILL_DB\"" "$ADMIN_URL" >/dev/null

echo "3/4 разворачиваю копию"
TARGET_URL="$(printf '%s' "$DATABASE_URL" | sed "s#/[^/?]*\(?\|$\)#/$DRILL_DB\1#")"
# --exit-on-error: молчаливое «восстановилось наполовину» хуже отказа.
pg_restore --dbname="$TARGET_URL" --no-owner --no-privileges --exit-on-error "$DUMP"

echo "4/4 сверяю"
TABLES="$(psql -tAc "select count(*) from information_schema.tables where table_schema='public'" "$TARGET_URL")"
MIGRATIONS="$(psql -tAc "select count(*) from pgmigrations" "$TARGET_URL")"
USERS="$(psql -tAc "select count(*) from users" "$TARGET_URL")"

ELAPSED=$(( $(date +%s) - START ))
echo "таблиц: $TABLES · миграций: $MIGRATIONS · пользователей: $USERS · время: ${ELAPSED}с"

# Пустая схема — самый частый вид «успешного» восстановления: команда
# отработала, файл прочитался, данных нет.
if [ "$TABLES" -lt 30 ] || [ "$MIGRATIONS" -lt 1 ]; then
  echo "ПРОВАЛ: схема развернулась не полностью"
  exit 1
fi

echo "репетиция пройдена; база $DRILL_DB оставлена для осмотра"
