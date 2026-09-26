#!/usr/bin/env bash
# Полный живой обход: фикстуры → шесть ролей кликом (390 px) и пара на десктопе (1280 px) → восемь сценариев → сводка.
#
# Нужно поднятым заранее (см. README.md): бэк на 127.0.0.1:3001 с логом в $LIVE_DIR/be.log (раздатчик берёт из него
# dev-коды входа), фронт на 127.0.0.1:3000, раздатчик tok-server.mjs на 127.0.0.1:3999. Состояние прогона (токены,
# state-файлы, отчёты) живёт в $LIVE_DIR — вне репозитория.
set -u
S="$(cd "$(dirname "$0")" && pwd)"
: "${LIVE_DIR:?LIVE_DIR не задан — см. README.md}"
mkdir -p "$LIVE_DIR/crawl/out"

# Сотрудник панели: локально — существующий аккаунт, на чистой базе — одноразовый номер с WALK_MAKE_STAFF=1.
STAFF="${WALK_STAFF_PHONE:-+79000000999}"

echo "== фикстуры"
node "$S/mk-fixtures.mjs" "$STAFF" || exit 1
node "$S/fix-to-tok.mjs" || exit 1
node "$S/mk-ids.mjs" > "$LIVE_DIR/mk-ids.log" 2>&1 || { tail -c 1500 "$LIVE_DIR/mk-ids.log"; exit 1; }
grep -q '"problems": \[\]' "$LIVE_DIR/fixtures-public.json" || echo "mk-ids: есть problems — см. fixtures-public.json"
node "$S/mk-vendor2.mjs" || exit 1

echo "== обход ролей"
bash "$S/couple-all.sh"
bash "$S/roles-all.sh"
bash "$S/run.sh" couple-d couple 0 1 w=1280 /home /search /wedding /wedding/budget /wedding/guests /wedding/seating /deal/{dealId} /us/chats /us/chats/{chatId} /dayx /settings

echo "== сценарии"
# Порядок важен: vendor пишет flow-vendor.ids.json и state-dj.json для deal и misc; destructive — последним.
for f in onboard vendor deal lead join misc; do
  node "$S/flow-$f.cjs" > "$LIVE_DIR/crawl/out/flow-$f.txt" 2>&1
  echo "flow-$f rc=$?"
done
# 092 отменяет свадьбу в разрушительном сценарии — на чистой базе свадьбу ему заводит свой онбординг.
RUN=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).run)" "$LIVE_DIR/fixtures-public.json")
node "$S/flow-onboard.cjs" "9${RUN}092" flow-onboard-092 > "$LIVE_DIR/crawl/out/flow-onboard-092.txt" 2>&1
echo "flow-onboard-092 rc=$?"
# Повторный код тому же номеру — не раньше чем через 60 с (RESEND_AFTER_SECONDS): онбординг только что входил под 092.
sleep 65
node "$S/flow-destructive.cjs" > "$LIVE_DIR/crawl/out/flow-destructive.txt" 2>&1
echo "flow-destructive rc=$?"

echo "== сводка"
node "$S/summary.mjs"
