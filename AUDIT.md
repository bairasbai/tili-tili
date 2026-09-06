# AUDIT.md — аудит перед первым выпуском на живых людей

Начат 2026-09-06. Идёт по блокам строго по порядку. Отметки:

- `[x] ПРОВЕРЕНО, ЧИСТО` — с доказательством: file:line, команда и её вывод, строка из БД.
- `[x] НАЙДЕНО И ЗАКРЫТО` — что было, чем закрыто, каким тестом закреплено, коммит.
- `[ ] НЕ ЗАКРЫВАЕТСЯ КОДОМ` — почему и что нужно от владельца (дублируется в `RELEASE-BLOCKERS.md`).

Правила аудита: моков нет (`nomocks.test.tsx`), ноль ≠ «неизвестно» (R-178), кнопка делает то, что
написано (R-176), правка контракта = 4 генератора (R-159), новая строка = ключ EN, регрессия обязательна
и доказана снятием фикса, коммит только поимённым списком путей (R-129), проверка способом, отличным
от того, каким делал (R-132).

Базовая линия на входе (2026-09-06 12:09): фронт 23 файла · 295 тестов; бэкенд 49 файлов · 555 + 9 пропущено.
Ниже неё опускаться нельзя ни на одном шаге.

---

## Блок 0. Окружение

- [x] ПРОВЕРЕНО, ЧИСТО — **База.** Системный кластер `postgresql-x64-16`, порт 5432 (PID 6340).
  `psql -U tili -d tili`: `PostgreSQL 16.15`; `select count(*) from information_schema.tables where table_schema='public'` → **62**;
  `select count(*), max(name) from pgmigrations` → **22 | 1759100000000_guest_reminders**. Данных от прошлых прогонов:
  users 23071, weddings 11925, vendors 7140, deals 4215, guests 4062, chats 26947, notifications 13463.
- [x] ПРОВЕРЕНО, ЧИСТО — **Серверы.** `netstat -ano`: `127.0.0.1:3000` — vite (PID 9096, `vite.js --host 127.0.0.1`),
  `127.0.0.1:3001` — бэкенд (PID 1664, `tsx watch src/index.ts`). `curl :3001/health` → `{"status":"ok"}`;
  `curl :3001/health/ready` → `{"status":"not_ready","db":"up","redis":"down"}` — `REDIS_URL` в `.env` пуст, Memurai
  не поднят (ждёт UAC владельца, см. session-handoff). Разбор «readiness без Redis» — блок 9. `curl :3000/` → 200.
- [x] ПРОВЕРЕНО, ЧИСТО — **Бэкенд, базовая линия.** `TEST_DATABASE_URL=postgres://tili:tili@localhost:5432/tili node node_modules/vitest/vitest.mjs run`:
  `Test Files 49 passed (49) · Tests 555 passed | 9 skipped (564) · Duration 43.25s · EXIT=0`. Девять пропущенных — `TEST_REDIS_URL` (R-123: названы, не забыты).
- [x] ПРОВЕРЕНО, ЧИСТО — **Фронт, базовая линия.** `npm run verify` (tsc -b → vitest → eslint → vite build):
  `Test Files 23 passed (23) · Tests 295 passed (295) · ✓ built in 6.89s · EXIT=0`. Предупреждения сборки: Tailwind
  `duration-[1300ms]` и `duration-[1500ms]` («If this is content and not a class…») ×2; в прогоне тестов 23 строки
  `(Use node --trace-warnings …)` от Node 25 — оба пункта в блок 9 («сборка без предупреждений»).
- [x] ПРОВЕРЕНО, ЧИСТО — **Рабочее дерево.** `git status --short` пуст, `HEAD = 4ee9f78`. Параллельных сессий нет (хук локов: «No active locks»).
- [x] ПРОВЕРЕНО, ЧИСТО — **Инструменты.** Node v25.9.0, pnpm 11.1.2, `psql` только по полному пути
  `C:/Program Files/PostgreSQL/16/bin/psql.exe` с `PGCLIENTENCODING=UTF8` (в PATH его нет).

---

## Блок 1. Контракт против бэкенда

Метод: два независимых прохода (R-132). **Механический** — `audit-contract.mjs` (временный, в коммит не входит):
регистрация маршрутов перехвачена у `find-my-way`, схемы тел/строки запроса/параметров сняты с маршрутизатора и
сопоставлены с `openapi.yaml`; каждая операция вызвана без токена; коды ответов сняты из исходника обработчика.
**Живой** — `audit-probe.mjs`: настоящая база, пользователь через OTP (код подобран по `code_hash`), мусор
(`abc`, `1'or'1`, усечённый uuid, `../x`, `%00`) во все 56 путей с параметрами адреса и в 22 строки запроса.
Первый проход дал 187 строк, из них существенных 60; второй — 5xx там, где первый молчал.

- [x] ПРОВЕРЕНО, ЧИСТО — **Каждый путь контракта реализован, лишних обработчиков нет.** Вывод скрипта:
  `registered routes: 153 · contract ops: 152 · registered but NOT in contract: OPTIONS * (CORS) · in contract but NOT registered: (пусто)`.
  Закреплено: `test/routing.test.ts` «реализованный путь контракта заглушку не получает» / «ни один путь не отвечает 404»,
  `test/contract.test.ts`. Единственный 501 «своим кодом» — `GET /auth/oauth/{provider}` → `oauth_not_configured` (хвост владельца).
- [x] НАЙДЕНО И ЗАКРЫТО — **Тела запросов расходились с контрактом в 5 операциях (ERR-0166).** Обработчик принимал то,
  чего контракт не знал, и фронт по сгенерированным типам не мог этого прислать: `POST …/guests` `phone`;
  `PATCH …/guests/{guestId}` `group, phone, diet, dietNote, transfer`; `POST /rsvp/{guestToken}` `diet, dietNote, transfer`
  (гость не мог сообщить ограничения по еде, хотя колонки и обработчик есть с этапа 7 — `guests.ts:449-462`);
  `POST /catalog/concierge` `city`. Обратное: `PATCH /users/me` объявлял правку `email`, обработчик её не принимает
  (`users.ts:129-140`) → `email` стал `readOnly` с объяснением (отправителя писем нет).
  Закрыто контрактом **v0.24.0** + `GUEST_COLUMNS`/`toGuest`/`PATCH` возвращают и правят телефон (`guests.ts`).
  Тест: `test/audit14.test.ts` «поля тела запроса у обработчика те же, что в контракте» (падал на v0.23 — 5 строк
  расхождений) и «телефон гостя: принимается, возвращается, правится и стирается» (снятие фикса → `expected undefined to be '+79170001122'`).
- [x] НАЙДЕНО И ЗАКРЫТО — **Обязательные поля.** Обработчик требовал, контракт молчал: `PATCH …/members/{userId}` `role`,
  `PUT …/menu-poll` `options`, `PATCH …/album/{photoId}` `approved` → `required` добавлен в контракт. `POST …/logistics/buses`
  (`name, seats`) и `…/hotels` (`name, rooms`) — обработчик строже схем `BusRoute`/`HotelBlock`, у которых `required` нет;
  фронт шлёт все четыре (`Logistics.tsx`), клиент по контракту получил бы 422 — сознательно оставлено: `required`
  на схеме ответа сделал бы `taken`/`booked` обязательными для чтения. Записано здесь как известная граница.
- [x] НАЙДЕНО И ЗАКРЫТО — **`security`: 18 операций без входа числились за `bearerAuth`.** Без токена они шли в базу
  (`503 db_unavailable` в прогоне без базы вместо 401): `GET /invites/{code}`, `GET /auth/oauth/{provider}`, `GET /geo/cities`,
  `GET /geo/nearest`, `GET /chats/{chatId}/ws`, `GET|POST /rsvp/{guestToken}`, `GET /gifts/{guestToken}`,
  `POST|DELETE …/reserve`, `POST …/fund`, `POST …/funds/{fundId}`, `GET /guest-vendor/{token}`, `GET|POST …/messages`,
  `GET|POST /join/{guestToken}/shuttle`, `GET …/team`, `GET|POST …/hotels`, `GET|POST …/menu-vote` → `security: []`.
  Тест: `audit14` «security контракта совпадает с тем, что делает сервер без токена». Каталог (`/catalog/*`) остался за входом — верно (ERR-0029).
- [x] НАЙДЕНО И ЗАКРЫТО — **Коды ответов.** Сервер отдавал, контракт не объявлял (15): `DELETE …/members/{userId}` 409 `last_couple`
  (`weddings.ts:470`); `POST …/slots/{slotId}/cancel` 409 `slot_empty|already_cancelled` (`slots.ts:147,153`);
  `…/pay` 409 `slot_empty|not_booked|no_price|overpay` (`slots.ts:194-221`); `…/external` 409 `slot_taken` (`slots.ts:286`);
  `DELETE …/tasks/{taskId}` 409 `system_task` (`day.ts:126`); `POST /vendor/leads/{leadId}` 409 `lead_won` (`vendorCabinet.ts:161`);
  `POST /catalog/vendors/{id}/reviews` 409 `review_exists` (`reviews.ts:132`); `PATCH …/wishlist/{giftId}` 409 `gift_price_below_funded`
  (`gifts.ts:229`); `POST /gifts/{t}/funds/{fundId}` 409 `idempotency_key_reused` (`gifts.ts:~520`); `POST /users/me/consent` 409
  `policy_version_stale` (`users.ts:78`); `POST /deals/{id}/contract` 409 `not_booked` (`documents.ts:120`); `POST /catalog/concierge`
  409 `concierge_pending` (`catalog.ts:357`); `POST /vendor/verification` 409 `verification_pending` (`vendorCabinet.ts:414`);
  `POST /chats/{id}/messages` 429 `QuotaExceeded` (`chats.ts:373`); 501 у OAuth, `POST /users/me/push-subscriptions`, `POST /media/upload-url`
  → новый общий ответ `NotConfigured`. Контракт объявлял, сервер не делал: `DELETE /users/me` 409 — **реализован** (ERR-0167);
  `POST …/guest-reviews` 409 — снят (повтор редактирует, так и описано, `reviews.ts:213-216`). Коды из помощников сверены
  чтением: `PATCH /weddings/{id}` и `…/reschedule` 409 `team_busy` — `wedding/reschedule.ts`; `/health/ready` 503 — `health.ts:27`;
  чаты 423 — `chats/access.ts:132,136`; `…/fund` 429 — `claimContribution` (`gifts.ts:543`); `guest-vendor/*` 410 — `slots.ts:373,492`.
  Тест: `audit14` «коды ответов, которые обработчик выдаёт сам, объявлены в контракте».
- [x] НАЙДЕНО И ЗАКРЫТО — **Заголовок `Idempotency-Key`.** `POST …/slots/{slotId}/cancel` требовал ключ (`withIdempotency`, `required=true`
  по умолчанию, `slots.ts:144`), контракт его не называл — клиент по контракту получал 400 (класс ERR-0038, R-52). Объявлен как у
  `book`/`pay`; фронт уже слал (`lib/api/slots.ts:54`). Остальные 13 объявленных заголовков совпадают с вызовами `withIdempotency`
  (сверено списком: `day.ts:496,648`, `dayx.ts:56,181`, `deals.ts:168`, `slots.ts:90,191`, `weddingLifecycle.ts:55`); `documents.ts:74`
  ключ принимает необязательно, как и контракт.
- [x] НАЙДЕНО И ЗАКРЫТО — **Схема ответа `MenuPoll`.** Контракт: `sent: boolean`; сервер: `sentAt` (`day.ts:539`) — объявленное
  поле не приходило никогда (R-98), `prod5` эту схему не покрывал. Контракт: `sentAt` (date-time, nullable, readOnly).
- [x] ПРОВЕРЕНО, ЧИСТО — **Параметры строки запроса.** `limit`/`cursor` (`GET /chats/{id}/messages`, `GET /guest-vendor/{t}/messages`,
  `GET /admin/*`), `guestToken` (`…/guest-reviews`, `…/album`), `token` (`…/ws`) в схемах Fastify не описаны — читаются кодом:
  `parsePageQuery` (`pagination.ts:80-85`: 1…100, иначе 400 `bad_limit`), `readGuestToken`, обработчик WebSocket. Живой прогон:
  `?limit=abc` → 422, `?limit=100000` → 422, `?cursor=abc` → 400 `bad_cursor`, `?date=2027-02-30` → 422 `bad_date`, `?sort=zzz` → 422,
  `?radiusKm=-1` → 422, `/geo/nearest?lat=999` → 422, `/vendor/calendar?month=2027-13` → 422, `?guestToken=abc` → 401.
- [x] НАЙДЕНО И ЗАКРЫТО — **Мусор в параметрах адреса и тела → 500 (ERR-0165).** Прогон мусора по 56 путям с параметрами: ни одной
  пятисотки на `abc`, `1'or'1`, усечённом uuid, `../x` (R-108/R-113 держат). На NUL-байте (`%00`) — **500** в девяти входах из десяти:
  `POST …/guests {name}`, `PATCH /users/me {name}`, `POST /weddings {partnerName}`, `/geo/cities?q=`, `/catalog/vendors?q=`,
  `/catalog/vendors?city=`, `/invite/a%00b`, `/rsvp/a%00b`, `/gifts/a%00b`. Закрыто хуком `preValidation` в `app.ts` (422 `invalid_character`).
  Тест: `audit14` (4 входа без базы; снятие фикса → 503/401 вместо 422). Живой dev-сервер после фикса: `/rsvp/a%00b` → 422,
  `/geo/cities?q=Уфа%00` → 422, `/geo/cities?q=Уфа` → 200.
- [x] ПРОВЕРЕНО, ЧИСТО — **Порядок «валидация раньше входа».** 52 защищённых пути с телом без токена отвечают 422, а не 401:
  у Fastify валидация схемы идёт до `preHandler`, где стоят `requireConsent` и матрица доступа. До входа не происходит ничего,
  кроме разбора JSON (`app.ts` парсер) и проверки схемы; сами схемы — публичный контракт. Оставлено намеренно, записано здесь;
  перенос входа в `onRequest` тронул бы 60 объявлений маршрутов ради 401 вместо 422 без выигрыша в безопасности.
- [x] ПРОВЕРЕНО, ЧИСТО — **Генераторы.** После каждой правки контракта: `gen-contract` (117 путей, 152 операции), `gen-schemas` (40 схем),
  `gen:types`, `openapi-typescript` у фронта. `contract-sync.test.ts` «файл на диске совпадает с тем, что выдаёт генератор» — зелёный.
- [ ] НЕ ЗАКРЫВАЕТСЯ КОДОМ — **`POST /media/upload-url`** отвечает 501 `storage_not_configured` до разбора тела (`vendor.ts:394-403`):
  без бакета и ключей S3 выдавать ссылку в никуда нельзя. Нужно от владельца: S3 Timeweb (`S3_ENDPOINT/BUCKET/ACCESS_KEY/SECRET_KEY`).
  Тогда же обработчику нужна схема тела из контракта (`kind, contentType, sizeBytes`) — сейчас проверять нечего.
- Хвосты, переданные дальше: форма гостя не спрашивает еду и трансфер, форма гостя у пары не собирает телефон
  (контракт теперь позволяет) — **блок 5**; `POST /catalog/concierge` фронтом не вызывается вовсе — **блок 5/6**;
  503 `code_collision` у выпуска кодов приглашений/ссылок/рефералки (`invites.ts:51,209`, `guests.ts:352`) — внутренний повтор
  «попробуйте ещё раз», в контракт не вынесен; `GET /weddings/{id}/album` при `security: []` без обоих удостоверений отвечает 401 —
  по замыслу (гость по токену, команда по Bearer), исключение прописано в тесте.

**Прогон после блока 1:** бэкенд `Test Files 50 passed · Tests 566 passed | 9 skipped (575) · EXIT=0` (+11 к базовой линии);
фронт `Test Files 23 passed · Tests 297 passed (297) · ✓ built in 6.38s · EXIT=0` (+2). Первый полный прогон фронта шёл
параллельно с бэкендом и дал два ложных падения `nomocks.test.tsx` по таймауту ожидания экрана; в одиночку 38/38 и полный
`verify` зелёный — R-177 распространяется и на фронт: сюиты не гонять одновременно. Коммит блока: см. `git log` — «Аудит, блок 1».
