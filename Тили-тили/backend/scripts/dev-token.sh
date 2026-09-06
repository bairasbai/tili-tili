#!/usr/bin/env bash
# Токен живого аккаунта для ручной проверки. ТОЛЬКО РАЗРАБОТКА.
#
# Проверять экраны на выдуманных данных бессмысленно — половина дефектов этого
# проекта нашлась ровно там, где живой ответ разошёлся с ожидаемым. А чтобы
# открыть приложение живым аккаунтом, нужен токен, то есть код из SMS. SMS в
# разработке никуда не уходит: провайдер не подключён (хвост владельца).
#
# Код в базе лежит только хешем — это правильно, иначе утечка базы отдавала бы
# чужие входы. Поэтому здесь он ПОДБИРАЕТСЯ: десять тысяч вариантов, каждый
# сверяется тем же HMAC, каким считает сервер (`src/auth/otp.ts`, `hashCode`).
#
# Почему это не дыра. Подбор требует одновременно доступа к базе и к
# `JWT_REFRESH_SECRET`. У кого есть и то и другое — тому подбирать нечего: он
# и так может выпустить любой токен напрямую. Скрипт не ослабляет вход, он
# экономит время тому, кто уже владеет машиной.
#
# Поэтому же он отказывается работать где-либо, кроме локальной машины: на
# чужой базе такой инструмент был бы именно тем, чем здесь не является.
#
# Использование:
#   ./scripts/dev-token.sh +79170009009            # печатает accessToken
#   ./scripts/dev-token.sh +79170009009 couple.txt # и кладёт его в файл
set -eu

PHONE="${1:?нужен телефон в формате +7XXXXXXXXXX}"
OUT="${2:-}"
BE="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$BE/.env"

[ -f "$ENV_FILE" ] || { echo "нет $ENV_FILE" >&2; exit 1; }

val() { grep -oE "^$1=.*" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r'; }

NODE_ENV_VALUE="$(val NODE_ENV)"
DATABASE_URL="$(val DATABASE_URL)"
SECRET="$(val JWT_REFRESH_SECRET)"
PORT="$(val PORT)"
PORT="${PORT:-3001}"

# ── три запрета, каждый закрывает свой способ выстрелить себе в ногу ──
case "$NODE_ENV_VALUE" in
  production|prod)
    echo "NODE_ENV=$NODE_ENV_VALUE — инструмент разработки на прод не наводится" >&2; exit 1;;
esac
case "$DATABASE_URL" in
  *@localhost:*|*@127.0.0.1:*) ;;
  *) echo "база не локальная — подбор кода к чужой базе не запускается" >&2; exit 1;;
esac
[ -n "$SECRET" ] || { echo "в .env нет JWT_REFRESH_SECRET" >&2; exit 1; }

API="http://127.0.0.1:$PORT"

# Код запрашивается заново: старый мог истечь или быть уже использован, а
# путать соседние коды одного номера — верный способ отладить не то.
curl -sS -X POST "$API/auth/otp" -H 'Content-Type: application/json' \
  -d "{\"phone\":\"$PHONE\"}" -o /dev/null

# psql на Windows не всегда парсит postgres:// URL из Git Bash — разбираем его
# сами на флаги, так надёжнее (проверено на PostgreSQL 16).
DB_USER="$(printf '%s' "$DATABASE_URL" | sed -n 's#.*://\([^:]*\):.*#\1#p')"
DB_PASS="$(printf '%s' "$DATABASE_URL" | sed -n 's#.*://[^:]*:\([^@]*\)@.*#\1#p')"
DB_HOST="$(printf '%s' "$DATABASE_URL" | sed -n 's#.*@\([^:/]*\).*#\1#p')"
DB_PORT="$(printf '%s' "$DATABASE_URL" | sed -n 's#.*@[^:]*:\([0-9]*\)/.*#\1#p')"
DB_NAME="$(printf '%s' "$DATABASE_URL" | sed -n 's#.*/\([^/?]*\)\(?.*\)\?$#\1#p')"

HASH="$(PGPASSWORD="$DB_PASS" PGCLIENTENCODING=UTF8 \
  psql -U "$DB_USER" -h "$DB_HOST" -p "${DB_PORT:-5432}" -d "$DB_NAME" -tAc \
  "select code_hash from otp_codes where phone = '$PHONE' order by created_at desc limit 1")"

[ -n "$HASH" ] || { echo "код не выпущен: сервер на $API не отвечает или номер отклонён" >&2; exit 1; }

CODE="$(SECRET="$SECRET" PHONE="$PHONE" HASH="$HASH" python -c '
import hmac, hashlib, os, sys
secret, phone, target = os.environ["SECRET"], os.environ["PHONE"], os.environ["HASH"]
for i in range(10000):
    code = "%04d" % i
    if hmac.new(secret.encode(), f"{phone}:{code}".encode(), hashlib.sha256).hexdigest() == target:
        print(code); sys.exit(0)
sys.exit("код не подобрался: JWT_REFRESH_SECRET в .env не тот, которым запущен сервер")
')"

TOKEN="$(curl -sS -X POST "$API/auth/otp/verify" -H 'Content-Type: application/json' \
  -d "{\"phone\":\"$PHONE\",\"code\":\"$CODE\",\"device\":\"dev-token.sh\"}" \
  | python -c 'import json,sys; print(json.load(sys.stdin).get("accessToken",""))')"

[ -n "$TOKEN" ] || { echo "вход не прошёл: сервер не отдал токен" >&2; exit 1; }

if [ -n "$OUT" ]; then
  printf '%s' "$TOKEN" > "$OUT"
  echo "$PHONE → $OUT ($(printf '%s' "$TOKEN" | wc -c) байт)"
else
  printf '%s\n' "$TOKEN"
fi
