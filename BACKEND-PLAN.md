# План разработки бэкенда «Тили-тили» — end-to-end

> Составлен 2026-09-02 по контракту `Тили-тили/Тили-тили_API_openapi.yaml` **v0.16** (105 путей, 134 операции, 39 схем), документам «Бизнес-логика и бэкенд», «План приложения» (ч. 12–20), `CLAUDE.md`, `ERRORS.md` и фактической форме данных фронтенда (`app/src/lib/`).
>
> Источник правды по API — openapi.yaml. Расхождения, которые план нашёл при составлении, закрыты в контракте v0.2 — история решений в разделе 8.
>
> Решения владельца от 2026-09-02 приняты как данность: деньги в копейках + ISO 4217 у каждой суммы; сделка в шести состояниях, у слота своего статуса нет; гость опознаётся одним персональным токеном; переноса данных с моков не будет; 35 категорий; согласие на ПДн явным действием; данные в РФ, хостинг Timeweb Cloud.

---

## 1. Выбор стека

**Node.js 22 LTS + TypeScript + Fastify 5, PostgreSQL 16, Redis 7, BullMQ, S3-совместимое хранилище. Хостинг — Timeweb Cloud, площадка в РФ (решение владельца 2026-09-02).**

Почему Node, а не Python:

1. **Один язык на обе стороны.** Фронтенд — TypeScript. Типы запросов и ответов генерируются из openapi.yaml один раз (`openapi-typescript`) и подключаются и к клиенту, и к серверу. С Python это два независимых слоя типов, которые расходятся первыми.
2. **Fastify валидирует JSON Schema из коробки** — это тот же формат, что в openapi. Схема из контракта становится валидатором запроса без переписывания.
3. **Команда — один человек, работающий с ИИ-ассистентом.** Второй язык — второй набор инструментов, линтеров, тестовых раннеров и грабель окружения (см. ERR-0006: npm на этой машине уже сломан, pnpm работает). Одна экосистема — одна точка боли.
4. **BullMQ на Redis** закрывает фоновые задачи (hold 72 ч, открытие чата дня X, рассылки) с повторами, задержками и dead-letter без отдельного брокера.

**Цена разворота.** Бизнес-логика по этому плану живёт в трёх местах: SQL-схема с ограничениями, миграции и тонкий HTTP-слой. Схема и миграции — чистый SQL, переезжают в FastAPI без изменений. Контракт — тоже. Переписать придётся обработчики и фоновые задачи: при 103 путях это 3–4 недели одного разработчика. Терпимо, потому что самое дорогое — данные и инварианты — не привязано к языку.

**Что фиксируется на этапе 0, чтобы разворот остался дешёвым:** никакой логики в ORM-хуках; инварианты — в ограничениях БД; обработчики не знают про Fastify глубже `request/reply`.

### 1.1. Инфраструктура: Timeweb Cloud

| Что нужно по плану | Услуга Timeweb | Комментарий |
|---|---|---|
| Сервер приложения | VPS (Ubuntu 24.04 LTS) | Fastify + BullMQ-воркеры в одном процессе на старте; воркеры выносятся отдельно, когда очередь начнёт расти |
| PostgreSQL 16 | **Управляемая БД** — отдельно от VPS | Не на VPS: план требует RPO ≤ 24 ч, RTO ≤ 4 ч и ежемесячную репетицию восстановления (§19.9). В управляемой БД бэкапы и восстановление — штатная функция, а не своя обвязка, которую надо проверять |
| Redis 7 (очереди) | На том же VPS | Очереди на старте небольшие, отдельный managed Redis — когда появится вторая машина или воркеры уедут отдельно. Потеря Redis не теряет данные: страховочные проходы по БД перезапустят задачи (раздел 5) |
| S3 для медиа | Объектное хранилище | Presigned upload анкет и альбома; CDN-раздача |
| Домен, DNS, SSL | Домены + Let's Encrypt | `tili-tili.ru` |
| Фронтенд | Apps (статика) | Сборка `app/` с SPA-fallback. Deep-link шим и относительные пути уже сделаны — приложение готово и к корню домена, и к подпапке |

**Локация — только Санкт-Петербург или Москва.** У Timeweb есть площадки вне РФ (Амстердам, Казахстан, Польша). Выбор не той локации нарушает 152-ФЗ, и по работающему приложению это никак не видно — проверяется только в панели. Фактическая локация каждого ресурса (VPS, БД, S3) фиксируется в runbook на этапе 9 и перепроверяется при любом переносе.

**Что хостинг не закрывает.** Владелец становится оператором персональных данных и обязан подать уведомление в Роскомнадзор **до начала обработки** — то есть до первого реального пользователя, а не до запуска. Это бумага, а не сервер; идёт тем же пакетом, что оферта и политика у юриста (раздел 7).

---

## 2. Схема базы данных

PostgreSQL 16, одна схема `public`, миграции — `node-pg-migrate`, только вперёд-совместимые (expand → migrate → contract, План §19.9). Время — `timestamptz`. Идентификаторы — `uuid` (v7, сортируемые).

**Деньги.** В базе — две колонки: `bigint` копеек и `currency char(3)` рядом. В API — объект `{ amount, currency }` (схема `Money` контракта v0.2). Колонка валюты заводится сразу у каждой суммы, хотя в MVP везде `RUB`: добавить колонку в пустую таблицу — минута, добавить её в работающую базу с данными — миграция и простой. Ограничение `CHECK currency = 'RUB'` снимается вместе с поддержкой курсов ЦБ (План §19.7).

Обозначения: **PK** — первичный ключ, **FK** — внешний ключ, **UQ** — уникальность, **IDX** — индекс.

### 2.1. Пользователи и доступ

| Таблица | Поля | Ключи и ограничения |
|---|---|---|
| `users` | id uuid, phone text, email text, name text, lang char(2), theme text, tz text, created_at, deleted_at | PK id · UQ phone · UQ email (nullable) · IDX deleted_at — soft-delete на 30 дней (§19.1) |
| `otp_codes` | phone text, code_hash text, expires_at, attempts int, created_at | PK (phone, created_at) · IDX expires_at — чистка по крону |
| `sessions` | id uuid, user_id, refresh_hash text, device text, created_at, revoked_at | PK id · FK user_id · IDX (user_id, revoked_at) — экран «Сессии и устройства» |
| `consents` | id uuid, user_id, policy_version text, given_at, ip inet, withdrawn_at | PK id · FK user_id · IDX (user_id, withdrawn_at) — подтверждение по 152-ФЗ, запись не удаляется |
| `otp_codes` | id uuid, phone text, code_hash text, expires_at, attempts int, created_at, consumed_at, ip inet | PK id · IDX (phone, created_at) · CHECK attempts ≤ 5 — код хранится хешем с серверным секретом; лимиты (5 мин жизни, 5 попыток, 5 отправок в час) живут в этой же таблице, а не в памяти процесса |
| `notification_prefs` | user_id, tasks bool, chats bool, deals bool, tips bool, quiet_from time, quiet_to time | PK user_id · FK user_id |
| `referrals` | code text, owner_id, invited_id, applied_at, earned bigint, currency | PK code · FK owner_id · **UQ invited_id** — код применяется один раз на аккаунт и только до первой сделки |
| `push_subscriptions` | id uuid, user_id, endpoint text, keys jsonb, created_at | PK id · UQ endpoint · FK user_id |

### 2.2. Свадьба и участники

| Таблица | Поля | Ключи и ограничения |
|---|---|---|
| `weddings` | id uuid, owner_id, title text, date date, city_id, venue text, style text, guests_planned int, budget_total bigint, currency char(3), tz text, invite_theme_id smallint, invite_text text, invite_code text, created_at, archived_at | PK id · FK owner_id → users · FK city_id · UQ invite_code — публичный код `/join/:code` · IDX date — фоновые переходы DayX/After |
| `wedding_members` | wedding_id, user_id, role text, joined_at | PK (wedding_id, user_id) · CHECK role IN (couple, helper, coordinator, vendor) · IDX user_id |
| `invites` | code text, wedding_id, role text, label text, expires_at, accepted_by uuid, accepted_at, revoked_at | PK code · FK wedding_id · IDX (wedding_id, revoked_at) — одноразовость: `accepted_at IS NULL` в условии UPDATE |
| `external_invites` | token text, wedding_id, slot_id, expires_at, accepted_at, revoked_at | PK token · FK slot_id · TTL 30 дней (§11), scope `guest_vendor` |

### 2.3. Справочники и каталог

| Таблица | Поля | Ключи и ограничения |
|---|---|---|
| `cities` | id int, name text, region text, district text, lat, lon, population int | PK id · IDX name (trigram, `pg_trgm`) — автокомплит с ё→е через `unaccent` |
| `categories` | id text, title text, icon text, sort int | PK id — ровно 35 строк, seed из `data.ts` |
| `vendors` | id uuid, user_id, category_id, city_id, name text, about text, price_from bigint, currency, years int, photo_url text, published_at, moderated_at, verified_at, rating numeric(2,1), reviews_count int, couple_reviews_count int (фича 005: порог показа рейтинга — по отзывам пар), created_at | PK id · FK user_id · FK category_id · FK city_id · IDX (category_id, city_id, published_at) — выдача · IDX user_id |
| `vendor_packages` | id uuid, vendor_id, name text, price bigint, currency, items jsonb, sort int | PK id · FK vendor_id · IDX vendor_id |
| `vendor_media` | id uuid, vendor_id, kind text, url text, duration_s int, sort int | PK id · FK vendor_id · CHECK kind IN (photo, video) · CHECK duration_s ≤ 180 |
| `vendor_busy_dates` | vendor_id, date date, source text, deal_id uuid | **PK (vendor_id, date)** — единственная строка на дату; source IN (manual, deal) |
| `favorites` | user_id, vendor_id, created_at | PK (user_id, vendor_id) |
| `vendor_verifications` | id uuid, vendor_id, kind text, file_url text, inn text, status text, checked_at | PK id · FK vendor_id · CHECK kind IN (passport, ip, company) · CHECK file_url LIKE 'https://%' · UQ (vendor_id) WHERE status='pending' (фича 005) · документы не публикуются никогда, публична только галочка |
| `concierge_requests` | id uuid, user_id, category_id, budget bigint, currency, comment text, status text, created_at | PK id · FK user_id · IDX (status, created_at) — подбор вручную, пока в городе меньше 50 анкет |

### 2.4. Команда, сделки, деньги

| Таблица | Поля | Ключи и ограничения |
|---|---|---|
| `slots` | id uuid, wedding_id, category_id, label text, sort int, deal_id uuid, created_at | PK id · FK wedding_id · FK category_id · IDX wedding_id · UQ deal_id (nullable) — один слот = одна сделка |
| `deals` | id uuid, wedding_id, slot_id, vendor_id (nullable), external_name text, external_phone text, package_id (nullable, FK vendor_packages ON DELETE SET NULL — фича 005), state text, price bigint, currency, negotiating_until timestamptz, booked_at, done_at, cancelled_at, cancel_reason text, created_at | PK id · FK wedding_id · FK slot_id · FK vendor_id · CHECK state IN (candidate, contacted, negotiating, booked, paid_deposit, done, cancelled) · CHECK (vendor_id IS NOT NULL) OR (external_name IS NOT NULL) · IDX (wedding_id, state) · IDX negotiating_until WHERE state='negotiating' — истечение hold |
| `deal_events` | id uuid, deal_id, from_state, to_state, actor_id, note text, at | PK id · FK deal_id · IDX (deal_id, at) — история сделки на экране |
| `payments` | id uuid, deal_id, kind text, amount bigint, currency, status text, provider_ref text, created_at | PK id · FK deal_id · CHECK kind IN (deposit, balance, refund) · IDX deal_id |
| `idempotency_keys` | key text, user_id, route text, request_hash text, status int, body jsonb, created_at | **PK key** · IDX created_at — чистка через 24 ч |
| `budget_items` | id uuid, wedding_id, title text, category_id, amount bigint, limit_amount bigint, currency, created_at | PK id · FK wedding_id · IDX wedding_id — только ручные статьи; суммы по сделкам считаются на лету (§3.1: производные не хранить) |
| `leads` | id uuid, vendor_id, wedding_id, message text, state text, hold_until, created_at | PK id · FK vendor_id · FK wedding_id · CHECK state IN (new, replied, hold, declined, won) · IDX (vendor_id, state) |

### 2.5. Гости и день X

| Таблица | Поля | Ключи и ограничения |
|---|---|---|
| `guests` | id uuid, wedding_id, name text, phone text, rsvp text, plus_one bool, group_name text, diet text, transfer bool, table_id, menu_option_id, rsvp_token text, created_at | PK id · FK wedding_id · FK table_id · UQ rsvp_token · CHECK rsvp IN (yes, no, pending) · IDX (wedding_id, rsvp) |
| `guest_invite_codes` | code text, guest_id, issued_at, expires_at, used_at | PK code · FK guest_id · IDX (guest_id) WHERE used_at IS NULL — одноразовый код гасится при первом обмене на `guest_token`; сырой токен паре не отдаётся |
| `tables` | id uuid, wedding_id, number int, capacity int | PK id · FK wedding_id · UQ (wedding_id, number) |
| `tasks` | id uuid, wedding_id, title text, period text, due date, source text, done_at | PK id · FK wedding_id · CHECK source IN (system, user, ai) · IDX (wedding_id, done_at) |
| `timeline_events` | id uuid, wedding_id, name text, location text, starts_at, ends_at, who text, icon text, sort int, for_guests bool (default true — гость в день X видит только такие блоки, фича 009) | PK id · FK wedding_id · IDX (wedding_id, sort) |
| `timeline_shifts` | id uuid, wedding_id, minutes int, actor_id, at | PK id · FK wedding_id — «+15 мин» дня X, накопительно |
| `bus_routes` | id uuid, wedding_id, name text, pickup text, departs time, seats int, taken int (персоны — считает триггер, фича 005), deal_id (nullable, FK deals ON DELETE SET NULL — перевозчик как подрядчик, фича 006) | PK id · FK wedding_id · FK deal_id · **CHECK taken BETWEEN 0 AND seats** (NOT VALID до уборки тестовых строк) · IDX deal_id |
| `bus_bookings` | bus_id, guest_id, persons smallint (1 или 2 — ставится триггером из guests.plus_one, фича 005), created_at | **PK (bus_id, guest_id)** · FK оба · CHECK persons BETWEEN 1 AND 2 · триггеры: `bus_bookings_persons` (BEFORE INSERT), `bus_bookings_count` (taken ± persons), `guests_plus_one_seats` (пересчёт при смене plus_one) |
| `hotel_blocks` | id uuid, wedding_id, name text, rooms int, booked int, price bigint, currency, deadline date, promo text | PK id · FK wedding_id · **CHECK booked BETWEEN 0 AND rooms** |
| `hotel_bookings` | hotel_id, guest_id, created_at | **PK (hotel_id, guest_id)** |
| `menu_polls` | wedding_id, question text, sent_at | PK wedding_id · FK wedding_id |
| `menu_options` | id uuid, wedding_id, name text, icon text, sort int | PK id · FK wedding_id |
| `menu_votes` | guest_id, option_id, at | **PK guest_id** — один голос на гостя; повтор = UPSERT |
| `album_photos` | id uuid, wedding_id, url text, approved bool, uploaded_by text, created_at | PK id · FK wedding_id · IDX (wedding_id, approved) |

### 2.6. Подарки

| Таблица | Поля | Ключи и ограничения |
|---|---|---|
| `gifts` | id uuid, wedding_id, name text, descr text, price bigint, currency, is_group bool, funded bigint, created_at | PK id · FK wedding_id · CHECK funded ≤ price |
| `gift_reservations` | gift_id, guest_token text, reserved_at | **PK gift_id** — вторая строка невозможна физически · guest_token паре не отдаётся никогда |
| `gift_contributions` | id uuid, gift_id, guest_token, amount bigint, currency, idempotency_key text, created_at | PK id · FK gift_id · UQ idempotency_key |
| `funds` | id uuid, wedding_id, name text, target bigint, collected bigint, currency | PK id · FK wedding_id |
| `fund_contributions` | id uuid, fund_id, guest_token, amount bigint, idempotency_key text, created_at | PK id · FK fund_id · UQ idempotency_key |
| `anti_gifts` | wedding_id, text | PK (wedding_id, text) |

### 2.7. Общение, отзывы, служебное

| Таблица | Поля | Ключи и ограничения |
|---|---|---|
| `chats` | id uuid, wedding_id, kind text, vendor_id, slot_id, deal_id (фича 005: чат своего подрядчика — по сделке), opens_at timestamptz, created_at | PK id · FK wedding_id · CHECK kind IN (vendor, team, day, tilly, external, crew) · UQ (wedding_id, vendor_id) WHERE kind='vendor' · UQ (deal_id) WHERE kind='external' · CHECK (kind='external') = (deal_id IS NOT NULL) · CHECK (kind='external') = (slot_id IS NOT NULL) |
| `chat_members` | chat_id, user_id, last_read_at | PK (chat_id, user_id) |
| `messages` | id uuid, chat_id, sender_id, guest_id (nullable, FK guests ON DELETE SET NULL — реплика гостя в чате дня X, фича 009), text text, attachments jsonb, created_at | PK id · FK chat_id · FK guest_id · **CHECK num_nonnulls(sender_id, guest_id) ≤ 1** (один автор) · IDX (chat_id, created_at) |
| `tilly_usage` | id uuid, wedding_id, chat_id, message_id (nullable, FK messages ON DELETE SET NULL — реплика Тиля), provider text, model text, input_tokens int, output_tokens int, latency_ms int, outcome text, created_at (фича 010: одна строка на каждое обращение к модели — ответ, отказ провайдера или заглушка; расход для дашборда `AdminMetrics.llm`) | PK id · FK wedding_id (CASCADE) · FK chat_id (CASCADE) · FK message_id · CHECK outcome IN (answered, failed, stub) · IDX created_at · IDX (wedding_id, created_at) |
| `notes` | id uuid, wedding_id, author_id (nullable, FK users ON DELETE SET NULL), text text, created_at (фича 014, блокер №7: заметки команды свадьбы — раньше `localStorage` одного телефона) | PK id · FK wedding_id (CASCADE) · FK author_id · CHECK length(text) BETWEEN 1 AND 2000 · IDX (wedding_id, created_at) |
| `reviews` | id uuid, vendor_id, wedding_id, deal_id, source text, guest_token text, guest_id (nullable, FK guests ON DELETE SET NULL — фича 005), stars smallint, text text, reply text, created_at, moderated_at | PK id · FK vendor_id · CHECK source IN (couple, guest) · CHECK stars BETWEEN 1 AND 5 · **UQ deal_id** (отзыв пары — один на сделку) · **UQ (guest_id, vendor_id) WHERE guest_id IS NOT NULL** (отзыв гостя — один на подрядчика; ключ — гость, не ссылка: перевыпуск ссылки второго отзыва не даёт) |
| `notifications` | id uuid, user_id, kind text, title text, body text, link text, read_at, created_at | PK id · FK user_id · IDX (user_id, read_at, created_at) |
| `documents` | id uuid, deal_id, template_code text, version int, fields jsonb, file_url text, status text | PK id · FK deal_id · CHECK status IN (draft, sent, signed) |
| `complaints` | id uuid, reporter_id, target_kind text, target_id uuid, category text, text text, status text, created_at | PK id · IDX (status, created_at) — очередь модерации · CHECK complaints_resolution_by_target (санкция применима к цели: vendor — dismiss/warn/downrank/block, review — dismiss/warn/block, message/deal — dismiss/warn; фича 005, NOT VALID до уборки старых строк — RELEASE-BLOCKERS №26) |
| `audit_log` | id bigint, actor_id, action text, entity text, entity_id uuid, diff jsonb, at | PK id · IDX (entity, entity_id) · **только INSERT**: роли приложения нет прав на UPDATE/DELETE (План §12.4) |

### 2.8. Ограничения, исключающие гонки

Каждая гонка снята не кодом, а базой. Код лишь переводит ошибку ограничения в HTTP 409.

| Гонка | Что гарантирует | Как именно |
|---|---|---|
| **Двойное бронирование даты подрядчика** | `vendor_busy_dates` PK (vendor_id, date) | Переход сделки в `booked` и INSERT в `vendor_busy_dates` — в одной транзакции. Вторая пара получает `unique_violation` → откат → 409. Ручная отметка «занято» подрядчиком — та же таблица, source = manual. Двух строк на дату не бывает в принципе (План §18.3). |
| **Двойной резерв подарка** | `gift_reservations` PK gift_id | Резерв — INSERT, не UPDATE флага. Второй INSERT падает. Снятие резерва — DELETE только `WHERE guest_token = $1` (чужой резерв снять нельзя). Пара читает `EXISTS(SELECT 1 FROM gift_reservations WHERE gift_id=…)` — токен в ответ не попадает. |
| **Переполнение автобуса** | CHECK `taken ≤ seats` + PK (bus_id, guest_id); с фичи 005 `taken` — сумма персон (`1 + plus_one`), считает триггер по `bus_bookings.persons` | `UPDATE bus_routes SET taken = taken + 1 WHERE id = $1 AND taken < seats RETURNING id` в одной транзакции с INSERT в `bus_bookings`. Ноль строк — 409. CHECK — страховка от любого обходного пути. Гость не запишется дважды из-за PK. |
| **Переполнение отельного блока** | То же, что автобус: CHECK `booked ≤ rooms` + PK (hotel_id, guest_id) | Идентичный паттерн. |
| **Повторное начисление / оплата** | `idempotency_keys` PK key | Первый запрос: ключ пишется в той же транзакции, что и эффект. Повтор: SELECT по ключу → тот же статус и тело ответа, эффект не повторяется. Ключ scoped по (user_id, route) внутри `key` — чужой ключ не сработает. Для гостевых операций (взносы, резервы) — UQ на `idempotency_key` прямо в таблице взносов. |
| **Один голос гостя за блюдо** | `menu_votes` PK guest_id | UPSERT: повтор меняет выбор, а не добавляет второй. |
| **Один отзыв на сделку / на подрядчика от гостя** | UQ deal_id · UQ (guest_token, vendor_id) | Повторная отправка — 409, клиент показывает «редактировать». |
| **Одноразовая ссылка приглашения** | `UPDATE invites SET accepted_by=$1, accepted_at=now() WHERE code=$2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING` | Ноль строк — ссылка использована, отозвана или просрочена. Проверка и захват в одном операторе. |

Уровень изоляции — `READ COMMITTED` по умолчанию; всё перечисленное работает на нём за счёт ограничений, а не за счёт `SERIALIZABLE`.

---

## 3. Этапы

Порядок подобран так, что после каждого этапа приложение остаётся работоспособным: экраны, ещё не переведённые на API, продолжают жить на моках. Все 69 путей контракта распределены, каждый — ровно в один этап.

Оценки — календарные дни одного разработчика с ИИ-ассистентом, включая тесты и документацию. Без учёта ожидания внешних сторон (юрист, SMS-провайдер, хостинг).

### Этап 0 — Каркас · 3 дня

Папка `backend/` рядом с `app/` в том же репозитории, Fastify + TypeScript, PostgreSQL и Redis в `docker-compose`, миграции, генерация типов из `openapi.yaml`, валидация запросов по схемам контракта, единый формат ошибок `{ error: { code, message } }`, пагинация `limit/cursor`, `GET /health`, CI: типы + тесты + контрактный тест (каждый путь контракта имеет обработчик или явно помечен «не реализован» с кодом 501).

**Пути контракта:** нет.
**Экраны с моков:** нет.
**Готово, когда:** `curl /health` → 200; `pnpm test` зелёный; контрактный тест перечисляет 128 операций на 103 путях и ни разу не получает 404.

### Этап 1 — Вход, согласие, профиль, гео · 5 дней

**Пути (11):** `/auth/otp`, `/auth/otp/verify`, `/auth/refresh`, `/auth/oauth/{provider}`, `/users/me/consent`, `/users/me`, `/users/me/sessions`, `/users/me/sessions/{sessionId}`, `/users/me/export`, `/geo/cities`, `/geo/nearest`.

**Контракт v0.3.** Первая редакция описывала вход по `email` + `password`. Экран `/auth` во фронте (`app/src/pages/Account.tsx`) реализует телефон и четырёхзначный код, поля пароля в продукте нет вообще, и этот же раздел плана требует OTP по SMS. Два источника из трёх сходятся — поправлен контракт: `/auth/register` и `/auth/login` заменены на `POST /auth/otp` и `POST /auth/otp/verify`. Регистрация и вход — одно действие: аккаунт заводится при первой успешной проверке кода. Добавлен `DELETE /users/me/sessions` — выход со всех устройств одной операцией вместо цикла по списку.

OTP по SMS: основной провайдер SMSAero, резервный — с автопереключением (План ч. 17 п. 4). JWT access 15 мин + refresh 30 дней с ротацией; таблица `sessions`.

**Ограничителей три, и каждый закрывает свою дыру.** На номер (5 в час) — чтобы чужой телефон не заваливали сообщениями. На адрес (100 в час, настраивается) — против перебора номеров с одной машины; порог намеренно высокий, потому что у мобильных операторов сотни абонентов сидят за одним адресом, и жёсткий лимит отрезал бы оператора целиком. Общий потолок (500 в час) — единственное, что реально ограничивает счёт за SMS: список из тысячи номеров обходит лимит на номер, ботнет обходит лимит на адрес. Срабатывание потолка пишется в лог как авария.

**`TRUST_PROXY` задаётся числом прыжков, а не флагом.** `trustProxy: true` означает «верю `X-Forwarded-For` от кого угодно» — любой клиент назначает себе адрес и обходит ограничитель (ERR-0027). По умолчанию заголовку не верим; за балансировщиком Timeweb ставится 1.

**Сессия — это устройство, а не пара токенов.** Обмен refresh меняет хеш в существующей строке, а не заводит новую: иначе экран «Сессии и устройства» за неделю показывает сотни «входов», а время входа сбрасывается каждые 15 минут (ERR-0025). Согласие пишется с версией документа, датой и IP. Гео — таблица `cities` из `app/src/lib/cities.ts` + `pg_trgm`; Яндекс Геокодер — позже (Карта экранов §0.2.1).

**Экраны с моков:** `/auth`, `/legal/*`, `/settings` (сессии, язык), `CityPicker`.
**Готово, когда:** сценарий «телефон → код → токены → refresh → выход со всех устройств» проходит интеграционным тестом; регистрация без `POST /users/me/consent` возвращает 403 на любой защищённый путь; `GET /geo/cities?q=сиб` отдаёт «Сибай» первым.

**OAuth отложен.** `/auth/oauth/{provider}` отвечает 501 с кодом `oauth_not_configured` — не «забыт», а ждёт приложений во ВКонтакте, Яндексе, Google и Telegram: их регистрирует владелец. На экране входа кнопок OAuth сейчас нет, продукт этим путём не ходит. Остальные десять путей этапа сданы.

**SMS.** Отправитель сменный: `console` в разработке (код уходит в лог), `smsaero` в production. Без учётной записи SMSAero прод-отправка невозможна, но весь сценарий входа рабочий — не хватает только последней мили. `NODE_ENV=production` без настоящего провайдера не стартует: с кодом в логе никто не войдёт.

### Этап 2 — Свадьба и команда · 5 дней

**Пути (9):** `/weddings`, `/weddings/{weddingId}`, `/weddings/{weddingId}/members`, `/weddings/{weddingId}/members/{userId}`, `/weddings/{weddingId}/invites`, `/invites/{code}`, `/invites/{code}/accept`, `/users/me/referral`, `/referral/{code}/apply`.

Создание свадьбы из квиза: 12 слотов, 12 системных задач, 5 категорий бюджета, шаблон тайминга. Роли и одноразовые ссылки на 7 дней. Матрица доступа из раздела 6 включается здесь и покрывает все последующие этапы.

**Экраны с моков:** `/quiz` (создание), `/home` (карточка свадьбы), `/us`, `/us/team`, `/join/:code`.
**Готово, когда:** helper с валидным токеном получает 403 на `GET /weddings/{id}/budget`; ссылка-приглашение принимается ровно один раз (второй `accept` → 410 по контракту, не 409); тест на роли × пути этапа зелёный.

**Матрица доступа — один хук, а не проверка в обработчике.** Правила раздела 6 живут единым списком и применяются ко ВСЕМ путям со свадьбой в адресе, включая те, обработчиков у которых ещё нет. Поэтому «helper видит 403 на бюджете» верно уже сейчас: путь этапа 4 закрыт с этапа 2 и не откроется по недосмотру. Всё, что не описано явно, доступно только паре — запрет по умолчанию: ошибка в эту сторону валит тест этапа, ошибка в другую не видна никогда.

**Чужая свадьба — 404, а не 403.** Иначе по кодам ответа перебором выясняется, какие идентификаторы существуют. По той же причине «нет такого кода», «отозван», «истёк» и «уже использован» для приглашения дают один и тот же ответ.

**Категории приехали раньше срока.** `categories` и сид 35 записей относятся к этапу 3, но создание свадьбы заводит 12 слотов, а слот ссылается на категорию. Вместе с ними заведены `slots`, `tasks` и `timeline_events`: данные создаются здесь, обработчики придут на этапах 4 и 5.

**Коды приглашений длиннее, чем в примере контракта.** `ДРУГ-7F3K` — это около 20 бит, миллион вариантов, перебираемых скриптом за минуты. Стало `ДРУГ-7F3K-QX9M`, ~38 бит; вместе с семью днями жизни и одноразовостью этого достаточно. Алфавит без похожих знаков (нет 0 и O, 1 и I и L, 5 и S, 8 и B): код читают вслух и переписывают с экрана.

### Этап 3 — Каталог и анкета подрядчика · 7 дней

**Пути (12):** `/catalog/categories`, `/catalog/vendors`, `/catalog/vendors/{vendorId}`, `/catalog/vendors/{vendorId}/availability`, `/catalog/concierge`, `/me/favorites`, `/me/favorites/{vendorId}`, `/vendor/profile`, `/vendor/profile/publish`, `/vendor/calendar`, `/vendor/calendar/busy`, `/media/upload-url`.

Фильтры выдачи: категория, город, «свободен на дату» (через `vendor_busy_dates`), цена, рейтинг, видео. Ротация новичков: 10 % выдачи — анкеты без отзывов (План §19.2). Автопубликация + пост-модерация: `published_at` ставится сразу, `moderated_at` — модератором. Медиа: presigned upload в S3, серверная проверка длительности видео ≤ 180 с — без эндпоинта в контракте (раздел 8).

**Экраны с моков:** `/search`, `/search/:catId`, `/vendor/:id`, `/favorites`, `/compare`, `/vendor-app/profile`, календарь в `/vendor-app`.
**Готово, когда:** `GET /catalog/vendors?categoryId=photo&date=2027-06-14` не возвращает подрядчика с этой датой в `vendor_busy_dates`; выдача из 20 анкет содержит ≥ 2 без отзывов; `PUT /vendor/profile` с видео 200 с отклоняется.

**Контракт v0.5.** Критерии этапа были невыполнимы по контракту: параметра `date` в выдаче не было, а длительность видео передать было негде — в `VendorUpsert` только `portfolioUrls`, массив строк. Дописаны `date`, `ratingMin`, `hasVideo`, `VendorUpsert.media` с `durationS`, `Vendor.verified` и `Vendor.hasVideo`.

**Каталог за входом.** И контракт (у путей нет `security: []`), и матрица раздела 6 (у гостя в строке `/catalog/*` стоит «—») требуют аутентификации. Открытый каталог отдаёт базу подрядчиков любому скрипту (ERR-0029).

**Длительность видео пока declarative.** Ограничение 180 с проверяется по числу, которое присылает клиент. Настоящая проверка файла возможна только после загрузки в хранилище — вместе с S3. До тех пор ограничение стоит в трёх местах (схема, обработчик, `CHECK` в БД), но защищает от ошибки, а не от умысла.

**Ротация новичков — только первая страница.** На страницах с курсором подмена даёт повторы и пропуски: строка, вставленная в середину, сдвигает всё, что идёт после неё.

### Этап 4 — Слоты, сделки, деньги, документы · 10 дней

**Пути (15):** `/weddings/{weddingId}/slots`, `/weddings/{weddingId}/slots/{slotId}/book`, `/weddings/{weddingId}/slots/{slotId}/cancel`, `/weddings/{weddingId}/slots/{slotId}/pay`, `/weddings/{weddingId}/slots/{slotId}/external`, `/weddings/{weddingId}/slots/{slotId}/external/invite`, `/guest-vendor/{token}`, `/deals/{dealId}`, `/deals/{dealId}/contract`, `/weddings/{weddingId}/documents`, `/weddings/{weddingId}/reschedule`, `/weddings/{weddingId}/cancel`, `/weddings/{weddingId}/budget`, `/weddings/{weddingId}/budget/items`, `/weddings/{weddingId}/budget/items/{itemId}`.

Самый нагруженный этап. Машина состояний сделки в шести состояниях с журналом `deal_events`; переход в `booked` захватывает дату в `vendor_busy_dates` в той же транзакции; hold 72 ч — `negotiating_until`, истечение — фоновая задача (раздел 5). Оплаты — только статусы, без эквайринга (План §3.2: платежи вне MVP): `pay` создаёт запись `payments` со статусом `recorded`, деньги ходят между парой и подрядчиком напрямую. Идемпотентность на `book`, `pay`, `cancel`. Бюджет — единый расчёт по образцу `app/src/lib/budget.ts`: обязательства из сделок + ручные статьи, ничего не хранится производного.

**Экраны с моков:** `/wedding`, `/wedding/slot/:id`, `/deal`, `/wedding/budget`, счётчики на `/home`.
**Готово, когда:** две параллельные транзакции `book` на одну дату одного подрядчика — ровно одна успешна, вторая 409 (тест с двумя соединениями); повтор `pay` с тем же `Idempotency-Key` не создаёт вторую запись в `payments`; `GET /budget` после `cancel` уменьшает `spent` на цену сделки без ручного пересчёта.

**Гонка за слот оказалась второй, и её ограничение не ловило.** Уникальность на `slots.deal_id` не мешает двум РАЗНЫМ сделкам занять один слот: идентификаторы разные, конфликта нет. Захват делается условием в самом `UPDATE` — `set deal_id = $2 where id = $1 and deal_id is null` (ERR-0035).

**Мягкая бронь истекает при чтении, пока нет фоновой задачи.** Тот же `UPDATE`, что будет в задаче этапа 7, выполняется перед выдачей слотов и бюджета: иначе пара видит «бронь держится» через неделю после истечения 72 часов. Условие в `WHERE` делает повтор пустым, поэтому задача потом просто добавит расписание.

**Ключи идемпотентности подметаются тем же кодом, который их пишет** (ERR-0036): между этапом 4 и фоновыми задачами этапа 7 таблица иначе растёт три этапа подряд.

**Бюджет считается на лету и нигде не хранится.** Обязательства по сделкам (включая мягкую бронь) плюс ручные статьи. Строки бюджета и их доли берутся из `app/src/lib/data.ts` и `budget.ts` генератором: доля, а не сумма, потому что лимиты мока заданы под свадьбу за 1,5 млн, а бюджет у каждой пары свой.

**Договор — запись, файлы ждут хранилища.** Поля подставляются интерполяцией (инвариант 5 харнесса: шаблон не исполняет код на паспортных данных), версия растёт при переоформлении, `pdfUrl` и `docxUrl` пока `null`. Ссылка в никуда хуже честного `null`.

### Этап 5 — Гости, RSVP, рассадка, тайминг, логистика, меню, альбом · 9 дней

**Пути (22):** `/weddings/{weddingId}/guests`, `/weddings/{weddingId}/guests/{guestId}`, `/weddings/{weddingId}/guests/{guestId}/invite-link`, `/invite/{shareCode}`, `/weddings/{weddingId}/tables`, `/rsvp/{guestToken}`, `/weddings/{weddingId}/tasks`, `/weddings/{weddingId}/tasks/{taskId}`, `/weddings/{weddingId}/timeline`, `/weddings/{weddingId}/timeline/autogen`, `/weddings/{weddingId}/album`, `/weddings/{weddingId}/album/{photoId}`, `/weddings/{weddingId}/logistics/buses`, `/weddings/{weddingId}/logistics/buses/{busId}`, `/weddings/{weddingId}/logistics/hotels`, `/weddings/{weddingId}/logistics/hotels/{hotelId}`, `/weddings/{weddingId}/logistics/notify-pickup`, `/join/{guestToken}/shuttle`, `/join/{guestToken}/hotels`, `/weddings/{weddingId}/menu-poll`, `/weddings/{weddingId}/menu-poll/remind`, `/join/{guestToken}/menu-vote`.

Гость работает по токену без аккаунта. Атомарные места в автобусе и номере. Счётчики персон — как во фронте: запись с «+1» — двое. Рассылки — через очередь с дебаунсом 30 с (План §13.4). Автосводка кейтерингу — фоновая задача (раздел 5).

**Экраны с моков:** `/wedding/guests`, `/wedding/seating`, `/wedding/checklist`, `/wedding/logistics`, `/wedding/catering`, `/invite` (RSVP), `/wedding/invites`.
**Готово, когда:** 21 параллельная запись в автобус на 20 мест — ровно 20 успешных; повтор `menu-vote` тем же гостем меняет голос, а сумма голосов не растёт; `notify-pickup` дважды за 30 с — одна рассылка.

**Контракт v0.7.** У `POST /weddings/{id}/album` гостевой токен ссылался на `parameters/GuestToken`, а тот описан как `in: path` — в адресе этого параметра нет, описание невыполнимо. Добавлен `GuestTokenQuery`; альбом читается и пополняется с токеном в строке запроса.

**Счётчики мест ведут триггеры, а не обработчик** (ERR-0040): строки исчезают и мимо кода — удаление гостя уносит запись каскадом. `CHECK taken BETWEEN 0 AND seats` остаётся страховкой и переводится в 409.

**Дебаунс — не идемпотентность.** Второе нажатие «Разослать» приходит со своим ключом, и по ключу оно новое. Окно в 30 секунд закрывает именно это; журнал рассылок чистится через 90 дней.

**Место в номере занимается так же, как в автобусе.** Пути записи в контракте не было вовсе — блоки показывались, занять номер было нечем, хотя описание этапа требует «атомарные места в автобусе И НОМЕРЕ» (ERR-0043). Добавлен `POST /join/{guestToken}/hotels`.

**Гость едет одним автобусом и живёт в одном отеле.** Первичный ключ `(bus_id, guest_id)` запрещает две записи в один рейс, но не «только в один»: запись на другой рейс снимает прежнюю (ERR-0044). Ответ «не приду» освобождает и сиденье, и номер.

**Порции считает сервер.** `expectedPortions` в опросе меню: запись с «+1» — два человека и две порции. Считать это на клиенте значит получить разные ответы на разных экранах.

**Гость ходит по токену и только по белому списку путей.** Хук доступа пускает его на `/weddings/{id}/album` и только на свою свадьбу; на остальные пути со свадьбой в адресе его токен не действует.

### Этап 6 — Подарки и фонды · 4 дня

**Пути (9):** `/weddings/{weddingId}/wishlist`, `/weddings/{weddingId}/wishlist/{giftId}`, `/weddings/{weddingId}/anti-gifts`, `/weddings/{weddingId}/funds`, `/weddings/{weddingId}/funds/{fundId}`, `/gifts/{guestToken}`, `/gifts/{guestToken}/{giftId}/reserve`, `/gifts/{guestToken}/{giftId}/fund`, `/gifts/{guestToken}/funds/{fundId}`.

Анонимность — правило номер один (§9): ответ паре собирается запросом, который физически не читает `guest_token`. Складчина закрывает подарок при `funded ≥ price`. Маркетплейс «купить в приложении» и выплата фондов паре — вне MVP (платежи).

**Экраны с моков:** `/wedding/wishlist`, `/gifts`.
**Готово, когда:** два параллельных `reserve` — один 200, второй 409; тело любого ответа для роли `couple` не содержит подстроки `guest_token` (проверяется тестом на всех путях этапа); `DELETE reserve` чужим токеном → 403.

**Анонимность держится на том, чего нет в запросе.** Резерв в ответе паре — это `exists(...)`, колонка `guest_token` не читается вовсе: нечего отдать — нечего и утечь. Но критерий «в ответе нет подстроки `guest_token`» проверяет один шаг, а утечка шла через два: ссылку выдаёт пара, значит, она могла обменять её сама и открыть гостевую страницу (ERR-0047). Перевыпуск ссылки теперь меняет токен.

**Токен — это личность.** Резервы висят на токене, а не на госте: внешнего ключа между ними нет, и каскад их не видит. Триггер на удаление гостя и на смену токена освобождает резервы прежнего (ERR-0046) — иначе подарок остаётся занят тем, кого больше нет.

**Резерв и складчина исключают друг друга.** Иначе один гость забирает подарок, в который уже сложились двое, и их деньги повисают на чужом резерве. По той же причине подарок с деньгами внутри не удаляется и не дешевеет ниже собранного — как и фонд с деньгами.

**Ключ идемпотентности придумывает клиент** — значит, потоку он не мешает. Отдельный счёт взносов на гостя, свыше — 429 (ERR-0048).

**Значок подарка вернулся в контракт.** §9 описывает `icon` у подарка и фонда, мок хранит свой значок у каждого; в контракте поля не было. Плитка (`tile`) осталась на клиенте: это цвет из палитры по месту в списке — дизайн-токен, а не данные.

**Третий проход по этапам 5 и 6** нашёл ещё три дыры — все за пределами обработчика.

**Секрет в адресе — секрет в логе.** Гостевой токен стоит в пути, а путь пишется в лог каждого запроса: лог был списком рабочих ключей и заодно ответом на «кто что подарил» (ERR-0050). Маскировка — в сериализаторе логгера, список путей закреплён тестом.

**429 бывает двух видов.** Временный отказ обязан нести `Retry-After`, постоянная квота — не должна: заголовок «повторите позже» на исчерпанном пределе посылает клиента в цикл (ERR-0051). В контракте появился `QuotaExceeded`.

**Повтор — не новый запрос.** Проверка предела стояла перед проверкой ключа идемпотентности, и повтор засчитанного взноса получал отказ (ERR-0052).

### Этап 7 — Чаты, уведомления, день X, фоновые задачи · 8 дней

**Пути (9):** `/chats`, `/chats/{chatId}/messages`, `/chats/{chatId}/typing`, `/chats/vendor/{vendorId}`, `/notifications`, `/notifications/{id}/read`, `/users/me/push-subscriptions`, `/weddings/{weddingId}/timeline/shift`, `/weddings/{weddingId}/planb/activate`.

Realtime — WebSocket на том же Fastify (`@fastify/websocket`), fallback — поллинг раз в 30 с (§13.4). Чат команды создаётся при второй сделке в `booked` (План §8.5). Чат дня X создаётся сразу, `opens_at = date − 1 день, 09:00` по `weddings.tz`, до открытия — 423 Locked. Push: Web Push (VAPID) с тихими часами и лимитом 3 в день вне дня X (План §18.6). Здесь же — вся очередь BullMQ из раздела 5.

**Экраны с моков:** `/us/chats`, `/us/chats/:id`, `/notifications`, `/dayx` (чат и статусы), `/assistant` (заглушка `tilly` без LLM — ответ «временно без ИИ», План §19.8).
**Готово, когда:** сообщение доставляется второму соединению WebSocket < 1 с в тесте; `POST /chats/{day}/messages` до `opens_at` → 423, после — 200; при `quiet_from=22:00` push в 23:00 не отправляется, а откладывается на 09:00.

**Чаты заводит база, а не обработчик.** Свадьба создаётся в одном месте, дата меняется в двух, сделка становится `booked` в трёх. Помнить про чат в каждом — то же самое, что вести счётчик мест руками (ERR-0040). Триггеры: чат дня X и Тиль при создании свадьбы, срок открытия едет за датой, командный чат — на второй сделке в работе.

**Чат дня X виден до открытия.** Он существует с самого начала и до срока отвечает 423 `chat_not_open_yet`: 403 сказало бы «вам нельзя», а человеку нужно «откроется 13 июня в 09:00». Даты нет вовсе — 423 `wedding_date_unknown` (ERR-0054).

**Тихие часы — про звук, а не про право знать.** В приложении уведомление появляется сразу, откладывается только push: выбросить его значило бы потерять новость. Лимит «3 в день» раскладывает лишнее по ближайшим суткам со свободным местом, а не сваливает всё в завтра (ERR-0053). Сделки и день X идут мимо обоих ограничений.

**Живой канал — через Redis, а не в памяти процесса.** Соединения живут в процессе, а процессов за балансировщиком несколько: без общего канала сообщение доходило бы только тем, кто попал на тот же сервер, и выглядело бы как «иногда не приходит». Событие уходит в pub/sub и возвращается всем процессам, включая свой. Токен доступа стоит в строке запроса — браузерный WebSocket заголовки ставить не умеет, — поэтому маскируется в логах наравне с гостевыми (ERR-0050). Отказ приходит внутри соединения и закрывает его кодом 4000+status: молча оборвать рукопожатие значит послать клиента переподключаться вечно.

**Web Push без ключей отвечает 501, а не притворяется.** `push_not_configured` вместо тихо принятой подписки, которая никогда ничего не получит. Ключи генерируются `pnpm gen:vapid` и живут только в окружении. Отправка помечает уведомление отправленным В ТОЙ ЖЕ выборке (`for update skip locked`): иначе два прохода очереди возьмут одну строку и человек получит push дважды. Подписка удаляется на 404 и 410 — это «получателя больше нет», а не сбой сети.

**Ограничение частоты — в Redis и по токену.** §13.4 требует 10 запросов в секунду на токен; ключ считается по токену, а не по адресу: за одним адресом сидит целый свадебный чат с общим Wi-Fi. Без Redis ограничителя нет — счётчик в памяти процесса за балансировщиком означал бы лимит, умноженный на число процессов (ERR-0064).

**Получателей уведомления даёт матрица §18.6, а не таблица участников.** Подрядчик не член команды, но галочка ему стоит в трёх строках из шести — чат, сделки, день X. Рассылка по `wedding_members` его не видела вовсе, и сдвинутый тайминг до ведущего не доходил (ERR-0061).

**О смене статуса сделки рассылает ЖУРНАЛ, а не место перехода.** Состояние меняется в четырёх местах, и вызов рассылки в каждом — четыре места, где о ней можно забыть; забыли во всех (ERR-0062). Задача разбирает `deal_events`, отметка `notified_at` делает повтор пустым. Подрядчику пишем того же дела, а не «всем забронированным»: на снятой броне сделка уже не `booked`.

**Ответы гостей уходят паре сводкой раз в день** (§18.6), а не уведомлением на каждое «приду»: полторы сотни гостей — полторы сотни звонков (ERR-0063).

**Раздел 5 — это девять задач, а не строчка в составе этапа.** Сделаны восемь: рассылка созревших push, уборка, истечение брони, напоминание за 12 часов до её конца, зов в открывшийся чат дня X, еженедельный дайджест дедлайнов, рассылка по журналу сделок, суточная сводка по RSVP. Оставшиеся упираются в почту и SMS: сводка кейтерингу (вебхук или письмо подрядчику), напоминания ГОСТЯМ по RSVP (у гостя нет аккаунта — уведомить его в приложении нечем) и цепочка «после свадьбы» (ERR-0056).

**В день X тихих часов и лимита нет** (План §18.6). Свадьба идёт прямо сейчас, и «разбудим утром» здесь значит «уже неважно». Считается вопросом «не сегодня ли свадьба» при отправке, а не ночным флагом: флаг пришлось бы ставить, снимать и переносить вместе с датой (ERR-0057).

**Расписание — в очереди, а не в системном cron.** Очередь одна и деплой один; cron пришлось бы настраивать на каждой машине, и он запустил бы задачу на всех сразу. Планировщик именованный: рестарт обновляет расписание, а не заводит вторую такую же задачу. Сейчас в расписании три: рассылка созревших push (раз в минуту), уборка просроченного (ежечасно), страховка на истечение брони (ежечасно) — ленивый путь снимает бронь при чтении, но пара может не открывать приложение неделями, а дата у подрядчика всё это время занята.

### Этап 8 — Кабинет подрядчика, отзывы, модерация · 9 дней

**Пути (16):** `/vendor/leads`, `/vendor/leads/{leadId}`, `/vendor/reviews`, `/vendor/reviews/{reviewId}/reply`, `/vendor/analytics`, `/vendor/verification`, `/catalog/vendors/{vendorId}/reviews`, `/weddings/{weddingId}/guest-reviews`, `/complaints`, `/admin/moderation/vendors`, `/admin/moderation/vendors/{vendorId}`, `/admin/complaints`, `/admin/complaints/{complaintId}`, `/admin/categories`, `/admin/metrics`, `/admin/weddings/{weddingId}`.

Лид создаётся из «Написать» (этап 7) и из `book`. Отзыв пары — только по сделке в `done`, один на сделку, окно 14 дней; отзыв гостя — только после даты свадьбы, по токену, один на подрядчика; рейтинг — взвешенное среднее с затуханием, минимум 3 отзыва до показа числа (План §18.2, §15). Антиспам: новый подрядчик ≤ 5 первых сообщений в день (План §19.4).

**Экраны с моков:** `/vendor-app`, `/vendor-app/leads/:id`, `/vendor-app/reviews`, `/vendor-app/analytics`, `/vendor-app/deals`, `/after` (отзывы).
**Готово, когда:** `POST /catalog/vendors/{id}/reviews` по сделке в `booked` → 403, в `done` → 201, повтор → 409; подрядчик с 2 отзывами в выдаче показывается как «Новый на платформе», с 3 — с числом.

**Право на отзыв — это завершённая сделка, и держит его база.** Один отзыв на сделку и один отзыв гостя на подрядчика — уникальные индексы, а не проверки: две одновременные отправки прошли бы обе. Окно 14 дней от `done_at`: позже это уже не впечатление, а сведение счётов.

**Переписка защищается предупреждением, а не запретом.** Слова из §18.2 («номер карты», «переведи на карту», «без договора») дают системное сообщение в самом чате — видят оба, остаётся в истории, не чаще раза в сутки. Сообщение доставляется: блокировка выгнала бы разговор в мессенджер, где нет ни договора, ни эскроу, ни следа для разбирательства (ERR-0075). Ссылка в ПЕРВОМ сообщении подрядчика уходит в очередь модерации — так выглядит фишинг (§19.4).

**Первое сообщение пары становится текстом заявки.** Экран заявки в кабинете показывает, с чем к подрядчику пришли; пустая карточка не говорит ничего (ERR-0074).

**У каждого срока есть счётчик нарушений.** SLA разбора жалобы — 24 часа, и `complaintsOverdue` в метриках показывает, сколько его уже нарушили (ERR-0076).

**Отзывы можно прочитать, а не только посчитать.** `GET /catalog/vendors/{id}/reviews` с фильтром по источнику: у пары договор и пометка «сделка подтверждена», у гостя — бейдж «Гость свадьбы» (§15). Без ленты карточка показывала «4,8 · 47 отзывов» и не давала узнать, за что (ERR-0069).

**Вес источника: пара 1, гость 0,5.** На свадьбе полторы сотни гостей и одна сделка — без разных весов сотня доброжелательных гостей перекрывает оценку той единственной пары, у которой был договор (ERR-0070).

**Санкции проверяются последствием, а не отметкой.** «Понижен» — это позиция в конце выдачи при любой сортировке, «заблокирован» — отсутствие в ней. Отметка в колонке без последствия выглядит как работа и ею не является (ERR-0071).

**Затухание пересчитывается ночью**, а не при появлении отзыва: величина зависит от времени, а события может не быть годами (ERR-0072).

**У подрядчика два списка, а не один.** Заявки (`/vendor/leads`) и сделки (`/vendor/deals`): у заявки нет ни суммы, ни срока брони, и показывать одно вместо другого — врать про деньги (ERR-0073).

**Рейтинг — взвешенное среднее с затуханием**, период полураспада год. До трёх отзывов число не показывается вовсе: один отзыв от знакомого — это 5,0 и первое место в выдаче. Фильтр `ratingMin` уважает то же правило — иначе выдача отсеивалась бы по цифре, которой на экране нет.

**Скрытый модератором отзыв уходит и из показа, и из рейтинга.** Наказывать подрядчика звёздами за текст, признанный недопустимым, нельзя.

**Лид рождается в двух местах** — из «Написать» и из брони — и повтор не создаёт второго: уникальный индекс `(vendor_id, wedding_id)`. Уведомления от лида нет: о сообщении подрядчик узнаёт из чата, о брони — из уведомления о сделке, третье про то же событие было бы спамом.

**Сотрудник платформы — признак `users.is_staff`, и пути, который его выдаёт, НЕТ.** «Сделай меня админом» — это повышение прав в один запрос, сколько его ни защищай. Признак ставится руками в базе. Каждый просмотр чужого проекта пишется в журнал аудита вместе с обязательной причиной.

**Документы верификации не выходят наружу никогда** — публична только галочка. Блокировка подрядчика означает «нет в выдаче», а не «есть, но с пометкой».

### Этап 9 — Эксплуатация и 152-ФЗ · 4 дня

**Пути:** нет новых.

Разворачивание на Timeweb Cloud: VPS + управляемая PostgreSQL + S3, все на площадке в РФ. Ежедневный snapshot БД с хранением 30 дней и **репетицией восстановления** (План §19.9), Sentry, rate limit 10 req/s на токен через Redis, удаление аккаунта с soft-delete 30 дней и вычисткой по крону, экспорт данных пары (JSON), статус-страница, runbook на 5 сценариев отказа.

Runbook фиксирует фактическую локацию каждого ресурса — это единственный способ поймать площадку вне РФ: по работающему приложению она не отличима.

**Готово, когда:** восстановление из вчерашнего бэкапа на чистой машине укладывается в 4 часа (RTO из плана) и проходит контрактный тест; локация VPS, БД и S3 в панели Timeweb — РФ, зафиксирована в runbook; удалённый аккаунт через 31 день не находится ни в одной таблице кроме `audit_log`; 11-й запрос за секунду получает 429.

**Репетиция восстановления — часть работы, а не пункт документа.** `scripts/restore-drill.sh` делает то же, что придётся делать в аварии: снимает копию, создаёт ЧИСТУЮ базу, разворачивает в неё дамп и сверяет число таблиц, миграций и строк. Копия, которую ни разу не разворачивали, — это файл, а не резервная копия. Первый прогон: 60 таблиц, 13 миграций, 5 секунд.

**Удаление аккаунта проверяется обходом всей базы.** Тест берёт список колонок из `information_schema`, а не из памяти, и ищет идентификатор пользователя в каждой текстовой и uuid-колонке. Через 31 день не остаётся ничего, кроме `audit_log` — он и нужен, чтобы ответить «кто и когда удалил», когда самих данных уже нет.

**Sentry шлёт только неожиданное.** `AppError` — это ответ приложения (404, 409, 422), а не поломка: если слать их, панель заполнится опечатками пользователей и настоящее падение в них потеряется. Уходят 500 и выше плюс падения фоновых задач — их никто не видит, и без отчёта они обнаруживаются по тому, что перестали приходить push. Адрес в отчёте маскируется тем же кодом, что и в логе: Sentry — чужой сервис, и токен в пути туда уехать не должен.

**Runbook фиксирует локации ресурсов таблицей с датой проверки.** Строка без даты означает «не проверено»: по работающему приложению площадка вне РФ неотличима.

### Сводка

| Этап | Дней | Путей | Накопительно |
|---|---|---|---|
| 0 Каркас | 3 | 0 | 0 |
| 1 Вход, профиль, гео | 5 | 11 | 11 |
| 2 Свадьба и команда | 5 | 9 | 20 |
| 3 Каталог и анкета | 7 | 12 | 32 |
| 4 Слоты, сделки, деньги, документы | 10 | 15 | 47 |
| 5 Гости, тайминг, логистика, альбом | 9 | 22 | 69 |
| 6 Подарки | 4 | 9 | 78 |
| 7 Чаты, день X, фоновые задачи | 8 | 9 | 87 |
| 8 Кабинет, отзывы, модерация | 9 | 16 | 103 |
| 9 Эксплуатация | 4 | 0 | 103 |
| **Итого** | **64** | **103** | |

Рост с 51 до 64 дней — цена закрытия пропусков контракта: 34 эндпоинта, которые в первой редакции были перечислены как «нужны, но отсутствуют». Они не новые требования, а то, без чего экраны из плана продукта не заработали бы; обнаружить их посреди этапа было бы дороже.

---

## 4. Миграция с моков

Фронт хранит всё в localStorage под ключами `tt_*` (Бизнес-логика §17). Каждый ключ уходит на API на конкретном этапе; до этого экран продолжает работать на моках. Переключение — фича-флаг `VITE_API_URL`: пусто — моки, задан — API.

| Ключ localStorage | Эндпоинт | Этап |
|---|---|---|
| `tt_onboarded` | `GET /weddings/{id}` (404 = не пройден) | 2 |
| `tt_lang`, `tt_theme` | `PATCH /users/me`; тема остаётся локальной — это не данные, а настройка устройства | 1 |
| `tt_city`, `tt_city_region` | `PATCH /weddings/{id}` | 2 |
| `tt_consent` | `POST /users/me/consent` | 1 |
| `tt_slots` | `GET /weddings/{id}/slots`, `book`, `cancel`, `pay`, `external` | 4 |
| `tt_fav` | `GET/PUT/DELETE /me/favorites` | 3 |
| `tt_settings` | `PATCH /users/me` (имя, push-тумблеры, тихие часы) | 1 |
| `tt_notif_read` | `POST /notifications/{id}/read` | 7 |
| `tt_guests`, `tt_rsvp` | `GET/POST/PATCH/DELETE /weddings/{id}/guests`, `POST /rsvp/{token}` | 5 |
| `tt_seating`, `tt_tables_count` | `GET/POST /weddings/{id}/tables`, `PATCH /guests/{id}` (tableId) | 5 |
| `tt_guest_rsvp` | `POST /rsvp/{guestToken}` — на устройстве гостя остаётся кэш ответа | 5 |
| `tt_tasks_done`, `tt_tasks_extra` | `GET/POST/PATCH/DELETE /weddings/{id}/tasks` | 5 |
| `tt_budget_custom` | `POST/DELETE /weddings/{id}/budget/items` | 4 |
| `tt_dayx` | `POST /weddings/{id}/timeline/shift`, `POST …/planb/activate` | 7 |
| `tt_after_stars` | `POST /catalog/vendors/{id}/reviews` | 8 |
| `tt_assistant` | чат `kind=tilly` — `GET/POST /chats/{id}/messages` | 7 |
| `tt_chat_<id>` | `GET/POST /chats/{id}/messages` | 7 |
| `tt_gifts`, `tt_my_gifts`, `tt_funds`, `tt_anti`, `tt_bought` | `/weddings/{id}/wishlist`, `/gifts/{code}/*`; `tt_bought` (маркетплейс) — вне MVP | 6 |
| `tt_buses`, `tt_hotels`, `tt_menu_poll` | `/logistics/*`, `/menu-poll*` | 5 |
| `tt_album` | `GET/POST /weddings/{id}/album`, `PATCH …/album/{photoId}` | 5 |
| `tt_dress`, `tt_dress_note`, `tt_invite_tpl`, `tt_invite_text` | `PATCH /weddings/{id}` — тема, текст приглашения, палитра дресс-кода и комментарий | 2 |
| `tt_planb` | чек-лист накануне — по факту это задачи `period='eve'`: `/tasks` | 5 |
| `tt_notes`, `tt_inspo_likes` | остаются локальными: это личные пометки одного устройства, а не данные свадьбы. Синхронизация — по запросу владельца, отдельным решением | — |
| `tt_vendor_busy` | `GET /vendor/calendar`, `POST /vendor/calendar/busy` | 3 |
| `tt_guest_reviews` | `GET/POST /weddings/{id}/guest-reviews` | 8 |

**Данные пары, которая пользовалась моками.** Решение владельца 2026-09-02: **не переносим**. Реальных пользователей не было, моки существуют для демонстрации. При первом входе с API пара начинает с квиза, локальные ключи `tt_*` стираются после успешного `POST /weddings`. Эндпоинт импорта не заводится: день работы, который выбрасывается сразу после беты.

---

## 5. Фоновые задачи

Все задачи — BullMQ на Redis. Каждая идемпотентна по ключу сущности: повторный запуск с тем же ключом — no-op. Падение — 3 повтора с экспоненциальной задержкой (1, 5, 25 мин), затем dead-letter очередь и алерт в Sentry. Расписание — `repeat` в BullMQ, а не системный cron: очередь одна, деплой один.

| Задача | Чем запускается | Что делает | Повторное срабатывание | При падении |
|---|---|---|---|---|
| **Истечение hold 72 ч** | Отложенная задача при переходе в `negotiating` с `delay = 72 ч`; ключ `hold:{dealId}` | `UPDATE deals SET state='candidate' WHERE id=$1 AND state='negotiating' AND negotiating_until <= now()`; событие в `deal_events`; push паре и подрядчику; за 12 ч до истечения — отдельная задача-напоминание | Условие в WHERE делает повтор пустым | Повтор через 1/5/25 мин; страховка — ежечасный проход по `negotiating_until < now()` |
| **Открытие чата дня X** | Отложенная задача при создании свадьбы: `opens_at = date − 1 день 09:00` по `weddings.tz`; при `PATCH` даты — задача удаляется и ставится заново, ключ `dayx-open:{weddingId}` | Снимает `opens_at`, шлёт push гостям с токеном и участникам | `opens_at IS NULL` → no-op | То же; страховка — ежечасный проход |
| **Сводка кейтерингу** | Повторяющаяся задача 09:00 ежедневно; для свадеб с `date − 14 дней = today` | Собирает персоны / блюда / аллергии / трансфер, шлёт вебхук кейтерингу или письмо; повторная правка до `date − 7` — новая версия сводки | Ключ `catering:{weddingId}:{date}` — вторая за день не отправляется | Повтор; сводка хранится, отправка отдельно |
| **Напоминания гостям (RSVP)** | Ежедневно 11:00; гости в `pending` за 3 дня до дедлайна RSVP | Push или SMS по каналу, которым слали приглашение; один раз на гостя (План §19.5) | Ключ `rsvp-remind:{guestId}` | Повтор; при исчерпании — в отчёт паре |
| **Напоминание по меню** | По кнопке «Напомнить» — `POST /menu-poll/remind` | Рассылка не выбравшим; дебаунс 30 с | Ключ `menu-remind:{weddingId}` с TTL 30 с | Повтор |
| **Переход в режим DayX** | Ежедневно 00:05 по таймзоне пары | `weddings.date = today` → флаг режима, отключение тихих часов на сутки | Идемпотентно по дате | Повтор; фронт дублирует проверку по дате локально |
| **Переход в «После свадьбы»** | Ежедневно 00:05; `date < today` | Запрос отзывов, напоминание об альбоме на +0…+7; итоги на +14; годовщина — ежегодно (План §18.5) | Ключ `after:{weddingId}:{step}` | Повтор |
| **Чистка** | Ежечасно / ежедневно | `otp_codes` просроченные, `idempotency_keys` старше 24 ч, `sessions` отозванные старше 90 дней, soft-deleted `users` старше 30 дней — полное удаление | Идемпотентно по природе | Повтор |
| **Дайджест дедлайнов** | Еженедельно, понедельник 10:00 | Один push с задачами недели — не по одной (План §18.6) | Ключ `digest:{userId}:{week}` | Повтор |

Все задачи, шлющие push, проходят через одну функцию доставки: тихие часы 22:00–09:00 по `users.tz`, лимит 3 в день вне дня X, критичные (сделки, день X) — без ограничений.

---

## 6. Безопасность и роли

Шесть ролей (Бизнес-логика §2). Проверка — один middleware на каждом пути: роль берётся из `wedding_members` для путей с `weddingId`, из токена — для остальных. Гость и гость-подрядчик — не пользователи: их аутентификация — токен в URL с ограниченным scope.

Обозначения: ✅ полный, 👁 только чтение, — нет доступа, 🔒 только свои записи.

| Группа путей | couple | helper | coordinator | vendor | guest-vendor | guest |
|---|---|---|---|---|---|---|
| `/auth/*`, `/users/me/consent` | ✅ | ✅ | ✅ | ✅ | — | — |
| `/geo/*` | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| `/weddings/{id}` GET / PATCH | ✅ / ✅ | 👁 / — | 👁 / — | — | — | — |
| `/weddings/{id}/members*`, `/invites*` | ✅ | 👁 | 👁 | — | — | — |
| `/catalog/*`, `/me/favorites*` | ✅ | ✅ | ✅ | 👁 | — | — |
| `/weddings/{id}/slots` GET | ✅ | 👁 без `price` | 👁 без `price` | — | 🔒 свой слот | — |
| `/slots/{slotId}/book`, `/cancel`, `/pay`, `/external*` | ✅ | **—** | **—** | — | — | — |
| `/weddings/{id}/budget*` | ✅ | **—** | **—** | — | — | — |
| `/weddings/{id}/guests*`, `/tables*` | ✅ | ✅ | ✅ | — | — | — |
| `/weddings/{id}/guests/{id}/invite-link` POST | ✅ | **—** | **—** | — | — | — |
| `/weddings/{id}/tasks*` | ✅ | ✅ | ✅ | — | — | — |
| `/weddings/{id}/logistics*`, `/menu-poll*` | ✅ | ✅ | ✅ | — | — | — |
| `/weddings/{id}/wishlist*` | ✅ | — | — | — | — | — |
| `/gifts/{code}/*` | — | — | — | — | — | ✅ по токену |
| `/rsvp/{token}`, `/join/{code}/*` | — | — | — | — | — | ✅ по токену |
| `/guest-vendor/{token}` | — | — | — | — | ✅ по токену | — |
| `/chats*` | ✅ | ✅ team и day | ✅ все чаты свадьбы | 🔒 свои | 🔒 чат слота | 🔒 чат дня после `opens_at` |
| `/vendor/*` | — | — | — | ✅ | — | — |
| `/catalog/vendors/{id}/reviews` POST | ✅ по сделке в `done` | — | — | — | — | — |
| `/weddings/{id}/guest-reviews` GET / POST | ✅ анонимно / — | — | — | — | — | — / ✅ по токену после даты |
| `/notifications*` | 🔒 | 🔒 | 🔒 | 🔒 | — | — |

**Правила, которые проверяются тестами, а не ревью:**

1. **helper и coordinator не видят денег.** Не только на путях бюджета: `/budget*`, `/book`, `/pay`, `/cancel` дают 403, а из ответов, которые этим ролям ОТКРЫТЫ, суммы вырезаются — `budgetTotal` в карточке свадьбы и в списке `/weddings`, `price` в слотах. Матрица закрывает пути целиком и на поля не влияет; это отдельная проверка на сборке ответа (ERR-0026). Тест ищет запрещённые подстроки в теле ответа для каждой роли.

   Туда же коды приглашений: `GET /weddings/{id}/invites` открыт помощнику на чтение, но `code` и `url` из ответа убраны. Код — не «сведения о приглашении», а сам ключ: приглашение с ролью `couple` в чужих руках это повышение прав в один клик.
2. **Ссылку-приглашение выдаёт только пара.** Список гостей ведёт вся команда, но ссылка — не строка списка, а удостоверение: кто её выдаёт, тот может обменять её сам и действовать от имени гостя — зарезервировать подарок, снять чужой резерв, залить кадр в альбом. Для пары это неизбежно (она отправитель), для помощника это лишние права. Решение владельца 2026-09-03; то же рассуждение, что в ERR-0047.
3. **API пары никогда не отдаёт `guest_token`.** Ответы для роли `couple` на путях этапа 6 и на `/guest-reviews` собираются запросами, где столбец не выбирается. Тест: тело каждого ответа проверяется на отсутствие подстрок `guest_token` и `guestToken`.
4. **Подрядчик не видит список гостей** — только агрегаты (План §13.3): в `/chats` типа team нет вложения со списком гостей; отдельного пути для гостей у роли `vendor` нет.
5. **Гость-подрядчик** получает только свой слот, свой блок тайминга и один чат. Токен — `external_invites.token`, 30 дней, отзывается при `DELETE external`.
6. **Гостевые токены** (`rsvp_token`, `invite_code`) — 128 бит случайности, сравнение constant-time, rate limit 10/мин на токен.
7. **Секреты** только в переменных окружения; в репозитории — `.env.example` без значений.

---

## 7. 152-ФЗ

| Требование | Что делается | Блокирует запуск? |
|---|---|---|
| **Хранение ПДн на территории РФ** | Timeweb Cloud, площадка Санкт-Петербург или Москва: VPS, управляемая БД и S3 — все три. Локация каждого ресурса записана в runbook и перепроверяется при переносе. Sentry — self-hosted или с маскировкой ПДн до отправки. PostHog — self-hosted (План §18.13) | **Да** |
| **Уведомление Роскомнадзора об обработке ПДн** | Подаётся владельцем до первого реального пользователя. Хостингом не закрывается | **Да** |
| **Согласие явным действием** | `consents`: версия политики, дата, IP; чекбокс на фронте не предустановлен (сделано); без записи согласия — 403 на защищённые пути | **Да** |
| **Политика и оферта как документы** | Экраны `/legal/*` существуют; тексты — черновик, ждут юриста (План ч. 17 п. 5) | **Да** — тексты, не код |
| **Удаление по запросу** | `DELETE /users/me/consent` = отзыв согласия = soft-delete на 30 дней, затем полное удаление кроном; активные сделки требуют подтверждения второй стороны (План §9.4) | **Да** |
| **Возраст 18+** | Чекбокс «мне есть 18» в согласии — поле `policy_version` покрывает версию текста, возраст — отдельный флаг в `consents` | Да — одно поле |
| **Экспорт данных** | `GET /users/me/export` → JSON со всем, что принадлежит пользователю — **нет в контракте** | Нет — nice to have (§7 Бизнес-логики) |
| **Согласие подрядчика на публикацию портфолио** | Флаг при `PUT /vendor/profile` — «права на фото и согласие снятых» | Да — одно поле |
| **Согласие гостя на публикацию фото в альбоме** | Флаг при загрузке — альбома нет в контракте | Нет — вместе с альбомом |
| **Журнал доступа поддержки** | `audit_log`: кто и когда смотрел проект пары (План §19.10) | Нет — вместе с админкой |

---

## 8. Что решено и что закрыто в контракте v0.2

Раздел был списком пропусков. Все они закрыты 2026-09-02: четыре вопроса решил владелец, остальное — механическая правка контракта, которая из этих решений следует. Контракт вырос с 69 до 103 путей и с 32 до 39 схем. История ниже нужна, чтобы через полгода не переоткрывать те же вопросы заново.

### 8.1. Решения владельца

| # | Вопрос | Решение | Почему так |
|---|---|---|---|
| 1 | Статус слота | Своего статуса у слота нет. Слот либо пуст, либо несёт `deal`; состояние живёт в `Deal.state` — шесть значений. `Slot.tileState` — производная подпись для мозаики, `readOnly` | Два независимых поля статуса всегда расходятся: сделка ушла в `cancelled`, а плитка осталась «забронировано». Одно поле разойтись не может |
| 2 | Валюта | Объект `Money { amount: копейки, currency }` у КАЖДОЙ суммы. В MVP принимается только `RUB` | Не одна валюта на свадьбу: план §19.7 описывает свадьбу за границей, где сделка в евро, а бюджет в рублях. Колонку валюты дешевле завести в пустую таблицу сейчас, чем мигрировать работающую базу потом |
| 3 | Гостевой токен | Один персональный токен на гостя во всех гостевых путях: `/rsvp/{guestToken}`, `/gifts/{guestToken}`, `/join/{guestToken}/…` | Общий код свадьбы не даёт подставить имя в приглашение и не даёт гостю снять СВОЙ резерв подарка |
| 4 | Перенос данных с моков | Не переносим. Эндпоинт импорта не заводится | Реальных пользователей не было. День работы, который выбрасывается сразу после беты |

### 8.2. Анонимность резерва: почему появилась одноразовая ссылка

Решение 3 вскрыло дыру, которой не было видно, пока токен был «кодом свадьбы». Бизнес-логика §9 обещает: **пара НИКОГДА не видит, кто зарезервировал подарок.** Но если персональный токен гостя лежит в списке гостей у пары, пара открывает `/gifts/{guestToken}` и видит блок «Мой выбор» этого гостя. Обещание держится в интерфейсе и ломается по ссылке.

Поэтому `Guest.rsvpToken` убран из контракта. Вместо него:

- `Guest.inviteUrl` — **одноразовая** ссылка `https://tili-tili.ru/i/{shareCode}`. Пара её пересылает, но сама токен не получает.
- `GET /invite/{shareCode}` — браузер гостя обменивает код на персональный `guestToken`, код в этот момент гаснет. Повторный вызов — `410`.
- `POST /weddings/{id}/guests/{guestId}/invite-link` — перевыпуск, когда гость потерял ссылку: прежний код гасится, выдаётся новый.
- Таблица `guest_invite_codes` (раздел 2), `used_at` — единственный признак «уже открыта».

Остаточный риск честно назван: пара может открыть ссылку раньше гостя. Тогда гость скажет «не работает», пара перевыпустит. Обменять код на токен молча и незаметно нельзя — `inviteUrlUsed` в списке гостей показывает, что ссылка уже сработала.

### 8.3. Механические правки, следующие из решений

| # | Что было | Что стало |
|---|---|---|
| 5 | `Chat.kind` без `day` | `enum [vendor, team, day, tilly]` + `openFrom` — чат дня X открывается в 09:00 по `Wedding.tz` |
| 6 | `Member.role` без гостевых ролей | Роли остались четырьмя — гость и свой подрядчик членами не являются. Это записано в описании схемы, чтобы следующий читатель не считал пропуском |
| 7 | `Wedding` без таймзоны | `Wedding.tz` — по ней открывается чат дня X и считаются напоминания. Не по таймзоне пользователя: пара может быть в командировке |
| 8 | `Guest` без полей RSVP+ | `diet`, `dietNote`, `menuOptionId`, `transfer`, `busId`, `hotelId` |
| 9 | `Category` без ограничения | Список зафиксирован как сид (35 записей, миграция `seed_categories`, совпадает с `CATEGORIES` во фронте). Enum намеренно не ставится: добавление категории не должно требовать выката контракта |

### 8.4. Дописанные эндпоинты (34)

Все были перечислены в первой редакции как «нужны по документам, но отсутствуют». Разложены по этапам раздела 3.

| Область | Пути | Этап |
|---|---|---|
| Профиль и сессии | `GET/PATCH/DELETE /users/me`, `GET/DELETE /users/me/sessions`, `GET /users/me/export` | 1 |
| Реферальная программа | `GET /users/me/referral`, `POST /referral/{code}/apply` | 2 |
| Консьерж и загрузка файлов | `POST /catalog/concierge`, `POST /media/upload-url` | 3 |
| Сделки и документы | `PATCH /deals/{dealId}`, `POST /deals/{dealId}/contract`, `GET /weddings/{id}/documents`, `POST …/reschedule`, `POST …/cancel` | 4 |
| Тайминг, альбом, приглашения | `GET/PUT …/timeline`, `POST …/timeline/autogen`, `GET/POST …/album`, `PATCH …/album/{photoId}`, `POST …/guests/{guestId}/invite-link`, `GET /invite/{shareCode}` | 5 |
| Подарки: управление парой | `GET/PUT …/anti-gifts`, `POST/DELETE …/funds` | 6 |
| День X и push | `POST …/timeline/shift`, `POST …/planb/activate`, `POST /users/me/push-subscriptions` | 7 |
| Жалобы, верификация, админка | `POST /complaints`, `POST /vendor/verification`, `/admin/*` (6 путей) | 8 |

WebSocket описан отдельно во вводном разделе контракта — OpenAPI 3.0 каналы не описывает. События: `message.created`, `deal.state_changed`, `timeline.shifted`, `seating.updated`, `menu.poll.updated`, `notification.created`.

### 8.5. Что осталось открытым

Ничего из того, что мешает начать этап 0. Открыты только вещи, у которых нет ответа до первых живых пользователей:

| Вопрос | Когда решать |
|---|---|
| **SMSAero**: учётная запись и ключ. До этого код из SMS уходит в лог, а не человеку | до беты; этап 1 сдан без него |
| **OAuth**: приложения во ВКонтакте, Яндексе, Google и Telegram регистрирует владелец | когда на экране входа появятся кнопки соцсетей |
| **Координаты городов**: в данных фронта их 27 из 119, `/geo/nearest` выбирает только среди них | вместе с подключением Яндекс Геокодера |
| Платёжный провайдер (ЮKassa / Тинькофф / CloudPayments) — от него зависит форма `POST …/pay` | до этапа 4; нужен договор и расчётный счёт |
| Тексты оферты и политики ПДн — сейчас помечены в приложении как черновик | до публичного запуска; нужен юрист |
| Сид категорий — 35 записей есть, но нет описаний и иконок для каталога | до этапа 3 |
| Синхронизация `tt_notes` и `tt_inspo_likes` — пока остаются локальными | по запросу владельца |

## 9. Риски

| # | Риск | Митигация | Как поймём, что сработал |
|---|---|---|---|
| 1 | **Контракт разъедется с реализацией**, и фронт начнёт получать не то, что ждёт | Типы на обеих сторонах из одного `openapi.yaml`; контрактный тест на CI: каждый путь → обработчик, каждая схема ответа валидируется против контракта на тестовых данных | Падает контрактный тест; фронт ловит ошибку разбора ответа в Sentry |
| 2 | **Гонка, которую не поймали ограничения** (например, перенос даты свадьбы при захваченной дате подрядчика) | Все инварианты — в БД (раздел 2.8); тесты гонок с двумя соединениями на каждый инвариант; `SERIALIZABLE` точечно на переносе даты | Две записи там, где ограничение обещало одну — алерт по ежедневному запросу-инварианту |
| 3 | **Фоновые задачи молча не выполняются** (Redis перезапущен, задача потеряна) | Страховочные ежечасные проходы по состоянию БД (`negotiating_until < now()`, `opens_at < now()`), не только отложенные задачи; dead-letter с алертом | Метрика «задач в dead-letter > 0»; сделка в `negotiating` старше 73 ч |
| 4 | **Утечка `guest_token` паре** через новый эндпоинт или сериализатор | Тест на отсутствие подстроки во всех ответах роли `couple`; отдельный сериализатор для гостевых сущностей без поля вообще | Тест красный; в логах ответов поле встречается |
| 5 | **Единственный разработчик выпал** на середине этапа | Каждый этап оставляет приложение работоспособным; `session-handoff.md` и `JOURNAL.md` ведутся по правилам `CLAUDE.md`; миграции только вперёд-совместимые — незавершённый этап не ломает предыдущие | Следующая сессия не может восстановить контекст по журналам за 15 минут |
| 6 | **Ресурс поднят вне РФ** — при создании выбрана площадка Амстердам или Казахстан | Локация проверяется в панели сразу после создания каждого ресурса и записывается в runbook; проверка входит в чек-лист этапа 9 и повторяется при любом переносе | По приложению — никак; ловится только сверкой runbook с панелью. Поэтому сверка — регулярная процедура, а не разовая |

Отдельно, вне топ-5, но с датой: **SMS-провайдер** (регистрация не работает без него — резервный провайдер с этапа 1), **iOS PWA push** (только 16.4+ после установки на экран — fallback на email с этапа 7), **стоимость LLM** для Тиля (лимит 50 сообщений в день и деградация на FAQ — План §19.8; в этом плане Тиль — заглушка).

---

*План покрывает 69 путей контракта, 51 день одного разработчика. Старт возможен после решений по пунктам 1, 6, 7 раздела 8.1 — они меняют форму `Slot`, `Money` и гостевой аутентификации, то есть этапы 4–6.*
