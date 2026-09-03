#!/usr/bin/env sh
# Ежедневная резервная копия базы.
#
# Формат custom (-Fc), а не обычный SQL: он сжат и восстанавливается
# параллельно, а из него можно вынуть одну таблицу — на живой базе это
# разница между «десять минут» и «полдня».
#
# Хранение 30 дней (План §19.9). Старее удаляется здесь же: копия, которую
# никто не удаляет, однажды заполняет диск и роняет то, что охраняет.
set -eu

: "${DATABASE_URL:?нужен DATABASE_URL}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/tili}"
KEEP_DAYS="${KEEP_DAYS:-30}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$BACKUP_DIR/tili-$STAMP.dump"

# --no-owner и --no-privileges: копия должна разворачиваться на чистой
# машине, где ролей ещё нет. Иначе восстановление падает на первой же
# строке GRANT — в тот момент, когда времени разбираться меньше всего.
pg_dump --format=custom --no-owner --no-privileges --file="$FILE" "$DATABASE_URL"

# Проверяем сразу: битую копию лучше обнаружить сегодня, а не в день аварии.
pg_restore --list "$FILE" > /dev/null

SIZE="$(wc -c < "$FILE")"
echo "копия готова: $FILE ($SIZE байт)"

find "$BACKUP_DIR" -name 'tili-*.dump' -type f -mtime "+$KEEP_DAYS" -print -delete
