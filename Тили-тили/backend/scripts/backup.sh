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
umask 077

: "${DATABASE_URL:?нужен DATABASE_URL}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/tili}"
KEEP_DAYS="${KEEP_DAYS:-30}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$BACKUP_DIR/tili-$STAMP.dump"
PENDING="$(mktemp -d "$BACKUP_DIR/.tili-$STAMP.XXXXXXXX")"
ARCHIVE="$PENDING/archive"
cleanup() {
  rm -f -- "$ARCHIVE"
  rmdir -- "$PENDING"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# --no-owner и --no-privileges: копия должна разворачиваться на чистой
# машине, где ролей ещё нет. Иначе восстановление падает на первой же
# строке GRANT — в тот момент, когда времени разбираться меньше всего.
pg_dump --format=custom --no-owner --no-privileges --file="$ARCHIVE" "$DATABASE_URL"

# Оглавление может читаться даже при обрыве данных. Выгружаем SQL в stdout
# и отбрасываем его, чтобы прочитать данные без подключения к базе.
pg_restore --exit-on-error --file=- "$ARCHIVE" > /dev/null

SIZE="$(wc -c < "$ARCHIVE")"
# Publish on the same filesystem without replacing a backup from another run.
ln -T -- "$ARCHIVE" "$FILE"
echo "копия готова: $FILE ($SIZE байт)"

find "$BACKUP_DIR" -name 'tili-*.dump' -type f -mtime "+$KEEP_DAYS" -print -delete
