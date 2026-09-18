#!/usr/bin/env sh
# Репетиция восстановления (План §19.9).
#
# Копия, которую ни разу не разворачивали, — это не резервная копия,
# а файл. Скрипт делает то же, что придётся делать в аварии, и меряет
# время: цель RTO — четыре часа, и она проверяется, а не декларируется.
#
# Порядок ровно как в аварии:
#   1. снять копию с боевой базы,
#   2. создать ЧИСТУЮ базу (не ту же самую — иначе проверка ничего не стоит),
#   3. развернуть в неё копию,
#   4. убедиться, что схема на месте и данные читаются.
set -eu

: "${DATABASE_URL:?нужен DATABASE_URL}"
DRILL_DB="${DRILL_DB:-tili_drill}"
ADMIN_URL="${ADMIN_URL:-$DATABASE_URL}"
WORK="${WORK:-/tmp/tili-drill}"

START="$(date +%s)"
mkdir -p "$WORK"
DUMP="$WORK/drill.dump"

echo "1/4 снимаю копию"
pg_dump --format=custom --no-owner --no-privileges --file="$DUMP" "$DATABASE_URL"

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
