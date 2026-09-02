# План разработки бэкенда «Тили-тили» — end-to-end

> Составлен 2026-09-02 по контракту `Тили-тили/Тили-тили_API_openapi.yaml` (69 путей, 89 операций, 32 схемы), документам «Бизнес-логика и бэкенд», «План приложения» (ч. 12–20), `CLAUDE.md`, `ERRORS.md` и фактической форме данных фронтенда (`app/src/lib/`).
>
> Источник правды по API — openapi.yaml. Где текстовые документы с ним расходятся — вынесено в раздел 8, а не решено молча.
>
> Решения владельца от 2026-09-02 приняты как данность: деньги в копейках + ISO 4217; сделка в шести состояниях; 35 категорий; согласие на ПДн явным действием; данные в РФ.

---

## 1. Выбор стека

**Node.js 22 LTS + TypeScript + Fastify 5, PostgreSQL 16, Redis 7, BullMQ, S3-совместимое хранилище. Хостинг — Timeweb Cloud, площадка в РФ (решение владельца 2026-09-02).**

Почему Node, а не Python:

1. **Один язык на обе стороны.** Фронтенд — TypeScript. Типы запросов и ответов генерируются из openapi.yaml один раз (`openapi-typescript`) и подключаются и к клиенту, и к серверу. С Python это два независимых слоя типов, которые расходятся первыми.
2. **Fastify валидирует JSON Schema из коробки** — это тот же формат, что в openapi. Схема из контракта становится валидатором запроса без переписывания.
3. **Команда — один человек, работающий с ИИ-ассистентом.** Второй язык — второй набор инструментов, линтеров, тестовых раннеров и грабель окружения (см. ERR-0006: npm на этой машине уже сломан, pnpm работает). Одна экосистема — одна точка боли.
4. **BullMQ на Redis** закрывает фоновые задачи (hold 72 ч, открытие чата дня X, рассылки) с повторами, задержками и dead-letter без отдельного брокера.

**Цена разворота.** Бизнес-логика по этому плану живёт в трёх местах: SQL-схема с ограничениями, миграции и тонкий HTTP-слой. Схема и миграции — чистый SQL, переезжают в FastAPI без изменений. Контракт — тоже. Переписать придётся обработчики и фоновые задачи: при 69 путях это 2–3 недели одного разработчика. Терпимо, потому что самое дорогое — данные и инварианты — не привязано к языку.

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

PostgreSQL 16, одна схема `public`, миграции — `node-pg-migrate`, только вперёд-совместимые (expand → migrate → contract, План §19.9). Деньги — `bigint` в копейках, поле `currency char(3)` рядом. Время — `timestamptz`. Идентификаторы — `uuid` (v7, сортируемые).

Обозначения: **PK** — первичный ключ, **FK** — внешний ключ, **UQ** — уникальность, **IDX** — индекс.

### 2.1. Пользователи и доступ

| Таблица | Поля | Ключи и ограничения |
|---|---|---|
| `users` | id uuid, phone text, email text, name text, lang char(2), theme text, tz text, created_at, deleted_at | PK id · UQ phone · UQ email (nullable) · IDX deleted_at — soft-delete на 30 дней (§19.1) |
| `otp_codes` | phone text, code_hash text, expires_at, attempts int, created_at | PK (phone, created_at) · IDX expires_at — чистка по крону |
| `sessions` | id uuid, user_id, refresh_hash text, device text, created_at, revoked_at | PK id · FK user_id · IDX (user_id, revoked_at) — экран «Сессии и устройства» |
| `consents` | id uuid, user_id, policy_version text, given_at, ip inet, withdrawn_at | PK id · FK user_id · IDX (user_id, withdrawn_at) — подтверждение по 152-ФЗ, запись не удаляется |
| `notification_prefs` | user_id, tasks bool, chats bool, deals bool, tips bool, quiet_from time, quiet_to time | PK user_id · FK user_id |
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
| `vendors` | id uuid, user_id, category_id, city_id, name text, about text, price_from bigint, currency, years int, photo_url text, published_at, moderated_at, verified_at, rating numeric(2,1), reviews_count int, created_at | PK id · FK user_id · FK category_id · FK city_id · IDX (category_id, city_id, published_at) — выдача · IDX user_id |
| `vendor_packages` | id uuid, vendor_id, name text, price bigint, currency, items jsonb, sort int | PK id · FK vendor_id · IDX vendor_id |
| `vendor_media` | id uuid, vendor_id, kind text, url text, duration_s int, sort int | PK id · FK vendor_id · CHECK kind IN (photo, video) · CHECK duration_s ≤ 180 |
| `vendor_busy_dates` | vendor_id, date date, source text, deal_id uuid | **PK (vendor_id, date)** — единственная строка на дату; source IN (manual, deal) |
| `favorites` | user_id, vendor_id, created_at | PK (user_id, vendor_id) |

### 2.4. Команда, сделки, деньги

| Таблица | Поля | Ключи и ограничения |
|---|---|---|
| `slots` | id uuid, wedding_id, category_id, label text, sort int, deal_id uuid, created_at | PK id · FK wedding_id · FK category_id · IDX wedding_id · UQ deal_id (nullable) — один слот = одна сделка |
| `deals` | id uuid, wedding_id, slot_id, vendor_id (nullable), external_name text, external_phone text, state text, price bigint, currency, negotiating_until timestamptz, booked_at, done_at, cancelled_at, cancel_reason text, created_at | PK id · FK wedding_id · FK slot_id · FK vendor_id · CHECK state IN (candidate, contacted, negotiating, booked, paid_deposit, done, cancelled) · CHECK (vendor_id IS NOT NULL) OR (external_name IS NOT NULL) · IDX (wedding_id, state) · IDX negotiating_until WHERE state='negotiating' — истечение hold |
| `deal_events` | id uuid, deal_id, from_state, to_state, actor_id, note text, at | PK id · FK deal_id · IDX (deal_id, at) — история сделки на экране |
| `payments` | id uuid, deal_id, kind text, amount bigint, currency, status text, provider_ref text, created_at | PK id · FK deal_id · CHECK kind IN (deposit, balance, refund) · IDX deal_id |
| `idempotency_keys` | key text, user_id, route text, request_hash text, status int, body jsonb, created_at | **PK key** · IDX created_at — чистка через 24 ч |
| `budget_items` | id uuid, wedding_id, title text, category_id, amount bigint, limit_amount bigint, currency, created_at | PK id · FK wedding_id · IDX wedding_id — только ручные статьи; суммы по сделкам считаются на лету (§3.1: производные не хранить) |
| `leads` | id uuid, vendor_id, wedding_id, message text, state text, hold_until, created_at | PK id · FK vendor_id · FK wedding_id · CHECK state IN (new, replied, hold, declined, won) · IDX (vendor_id, state) |

### 2.5. Гости и день X

| Таблица | Поля | Ключи и ограничения |
|---|---|---|
| `guests` | id uuid, wedding_id, name text, phone text, rsvp text, plus_one bool, group_name text, diet text, transfer bool, table_id, menu_option_id, rsvp_token text, created_at | PK id · FK wedding_id · FK table_id · UQ rsvp_token · CHECK rsvp IN (yes, no, pending) · IDX (wedding_id, rsvp) |
| `tables` | id uuid, wedding_id, number int, capacity int | PK id · FK wedding_id · UQ (wedding_id, number) |
| `tasks` | id uuid, wedding_id, title text, period text, due date, source text, done_at | PK id · FK wedding_id · CHECK source IN (system, user, ai) · IDX (wedding_id, done_at) |
| `timeline_events` | id uuid, wedding_id, name text, location text, starts_at, ends_at, who text, icon text, sort int | PK id · FK wedding_id · IDX (wedding_id, sort) |
| `timeline_shifts` | id uuid, wedding_id, minutes int, actor_id, at | PK id · FK wedding_id — «+15 мин» дня X, накопительно |
| `bus_routes` | id uuid, wedding_id, name text, pickup text, departs time, seats int, taken int | PK id · FK wedding_id · **CHECK taken BETWEEN 0 AND seats** |
| `bus_bookings` | bus_id, guest_id, created_at | **PK (bus_id, guest_id)** · FK оба |
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
| `chats` | id uuid, wedding_id, kind text, vendor_id, opens_at timestamptz, created_at | PK id · FK wedding_id · CHECK kind IN (vendor, team, day, tilly) · UQ (wedding_id, vendor_id) WHERE kind='vendor' |
| `chat_members` | chat_id, user_id, last_read_at | PK (chat_id, user_id) |
| `messages` | id uuid, chat_id, sender_id, text text, attachments jsonb, created_at | PK id · FK chat_id · IDX (chat_id, created_at) |
| `reviews` | id uuid, vendor_id, wedding_id, deal_id, source text, guest_token text, stars smallint, text text, reply text, created_at, moderated_at | PK id · FK vendor_id · CHECK source IN (couple, guest) · CHECK stars BETWEEN 1 AND 5 · **UQ deal_id** (отзыв пары — один на сделку) · **UQ (guest_token, vendor_id)** (отзыв гостя — один на подрядчика) |
| `notifications` | id uuid, user_id, kind text, title text, body text, link text, read_at, created_at | PK id · FK user_id · IDX (user_id, read_at, created_at) |
| `documents` | id uuid, deal_id, template_code text, version int, fields jsonb, file_url text, status text | PK id · FK deal_id · CHECK status IN (draft, sent, signed) |
| `complaints` | id uuid, reporter_id, target_kind text, target_id uuid, category text, text text, status text, created_at | PK id · IDX (status, created_at) — очередь модерации |
| `audit_log` | id bigint, actor_id, action text, entity text, entity_id uuid, diff jsonb, at | PK id · IDX (entity, entity_id) · **только INSERT**: роли приложения нет прав на UPDATE/DELETE (План §12.4) |

### 2.8. Ограничения, исключающие гонки

Каждая гонка снята не кодом, а базой. Код лишь переводит ошибку ограничения в HTTP 409.

| Гонка | Что гарантирует | Как именно |
|---|---|---|
| **Двойное бронирование даты подрядчика** | `vendor_busy_dates` PK (vendor_id, date) | Переход сделки в `booked` и INSERT в `vendor_busy_dates` — в одной транзакции. Вторая пара получает `unique_violation` → откат → 409. Ручная отметка «занято» подрядчиком — та же таблица, source = manual. Двух строк на дату не бывает в принципе (План §18.3). |
| **Двойной резерв подарка** | `gift_reservations` PK gift_id | Резерв — INSERT, не UPDATE флага. Второй INSERT падает. Снятие резерва — DELETE только `WHERE guest_token = $1` (чужой резерв снять нельзя). Пара читает `EXISTS(SELECT 1 FROM gift_reservations WHERE gift_id=…)` — токен в ответ не попадает. |
| **Переполнение автобуса** | CHECK `taken ≤ seats` + PK (bus_id, guest_id) | `UPDATE bus_routes SET taken = taken + 1 WHERE id = $1 AND taken < seats RETURNING id` в одной транзакции с INSERT в `bus_bookings`. Ноль строк — 409. CHECK — страховка от любого обходного пути. Гость не запишется дважды из-за PK. |
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

Репозиторий `backend/` рядом с `app/`, Fastify + TypeScript, PostgreSQL и Redis в `docker-compose`, миграции, генерация типов из `openapi.yaml`, валидация запросов по схемам контракта, единый формат ошибок `{ error: { code, message } }`, пагинация `limit/cursor`, `GET /health`, CI: типы + тесты + контрактный тест (каждый путь контракта имеет обработчик или явно помечен «не реализован» с кодом 501).

**Пути контракта:** нет.
**Экраны с моков:** нет.
**Готово, когда:** `curl /health` → 200; `pnpm test` зелёный; контрактный тест перечисляет 69 путей и 69 раз получает 501 или 200 — ни одного 404.

### Этап 1 — Вход, согласие, профиль, гео · 4 дня

**Пути (7):** `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/oauth/{provider}`, `/users/me/consent`, `/geo/cities`, `/geo/nearest`.

OTP по SMS: основной провайдер SMSAero, резервный — с автопереключением (План ч. 17 п. 4). JWT access 15 мин + refresh 30 дней с ротацией; таблица `sessions`. Согласие пишется с версией документа, датой и IP. Гео — таблица `cities` из `app/src/lib/cities.ts` + `pg_trgm`; Яндекс Геокодер — позже (Карта экранов §0.2.1).

**Экраны с моков:** `/auth`, `/legal/*`, `/settings` (сессии, язык), `CityPicker`.
**Готово, когда:** сценарий «телефон → код → токены → refresh → выход со всех устройств» проходит интеграционным тестом; регистрация без `POST /users/me/consent` возвращает 403 на любой защищённый путь; `GET /geo/cities?q=сиб` отдаёт «Сибай» первым.

### Этап 2 — Свадьба и команда · 4 дня

**Пути (7):** `/weddings`, `/weddings/{weddingId}`, `/weddings/{weddingId}/members`, `/weddings/{weddingId}/members/{userId}`, `/weddings/{weddingId}/invites`, `/invites/{code}`, `/invites/{code}/accept`.

Создание свадьбы из квиза: 12 слотов, 12 системных задач, 5 категорий бюджета, шаблон тайминга. Роли и одноразовые ссылки на 7 дней. Матрица доступа из раздела 6 включается здесь и покрывает все последующие этапы.

**Экраны с моков:** `/quiz` (создание), `/home` (карточка свадьбы), `/us`, `/us/team`, `/join/:code`.
**Готово, когда:** helper с валидным токеном получает 403 на `GET /weddings/{id}/budget`; ссылка-приглашение принимается ровно один раз (второй `accept` → 409); тест на 6 ролей × 7 путей этапа зелёный.

### Этап 3 — Каталог и анкета подрядчика · 6 дней

**Пути (10):** `/catalog/categories`, `/catalog/vendors`, `/catalog/vendors/{vendorId}`, `/catalog/vendors/{vendorId}/availability`, `/me/favorites`, `/me/favorites/{vendorId}`, `/vendor/profile`, `/vendor/profile/publish`, `/vendor/calendar`, `/vendor/calendar/busy`.

Фильтры выдачи: категория, город, «свободен на дату» (через `vendor_busy_dates`), цена, рейтинг, видео. Ротация новичков: 10 % выдачи — анкеты без отзывов (План §19.2). Автопубликация + пост-модерация: `published_at` ставится сразу, `moderated_at` — модератором. Медиа: presigned upload в S3, серверная проверка длительности видео ≤ 180 с — без эндпоинта в контракте (раздел 8).

**Экраны с моков:** `/search`, `/search/:catId`, `/vendor/:id`, `/favorites`, `/compare`, `/vendor-app/profile`, календарь в `/vendor-app`.
**Готово, когда:** `GET /catalog/vendors?category=photo&date=2027-06-14` не возвращает подрядчика с этой датой в `vendor_busy_dates`; выдача из 20 анкет содержит ≥ 2 без отзывов; `PUT /vendor/profile` с видео 200 с отклоняется.

### Этап 4 — Слоты, сделки, деньги · 8 дней

**Пути (10):** `/weddings/{weddingId}/slots`, `/weddings/{weddingId}/slots/{slotId}/book`, `/weddings/{weddingId}/slots/{slotId}/cancel`, `/weddings/{weddingId}/slots/{slotId}/pay`, `/weddings/{weddingId}/slots/{slotId}/external`, `/weddings/{weddingId}/slots/{slotId}/external/invite`, `/guest-vendor/{token}`, `/weddings/{weddingId}/budget`, `/weddings/{weddingId}/budget/items`, `/weddings/{weddingId}/budget/items/{itemId}`.

Самый нагруженный этап. Машина состояний сделки в шести состояниях с журналом `deal_events`; переход в `booked` захватывает дату в `vendor_busy_dates` в той же транзакции; hold 72 ч — `negotiating_until`, истечение — фоновая задача (раздел 5). Оплаты — только статусы, без эквайринга (План §3.2: платежи вне MVP): `pay` создаёт запись `payments` со статусом `recorded`, деньги ходят между парой и подрядчиком напрямую. Идемпотентность на `book`, `pay`, `cancel`. Бюджет — единый расчёт по образцу `app/src/lib/budget.ts`: обязательства из сделок + ручные статьи, ничего не хранится производного.

**Экраны с моков:** `/wedding`, `/wedding/slot/:id`, `/deal`, `/wedding/budget`, счётчики на `/home`.
**Готово, когда:** две параллельные транзакции `book` на одну дату одного подрядчика — ровно одна успешна, вторая 409 (тест с двумя соединениями); повтор `pay` с тем же `Idempotency-Key` не создаёт вторую запись в `payments`; `GET /budget` после `cancel` уменьшает `spent` на цену сделки без ручного пересчёта.

### Этап 5 — Гости, RSVP, рассадка, логистика, меню, чек-лист · 7 дней

**Пути (16):** `/weddings/{weddingId}/guests`, `/weddings/{weddingId}/guests/{guestId}`, `/weddings/{weddingId}/tables`, `/rsvp/{guestToken}`, `/weddings/{weddingId}/tasks`, `/weddings/{weddingId}/tasks/{taskId}`, `/weddings/{weddingId}/logistics/buses`, `/weddings/{weddingId}/logistics/buses/{busId}`, `/weddings/{weddingId}/logistics/hotels`, `/weddings/{weddingId}/logistics/hotels/{hotelId}`, `/weddings/{weddingId}/logistics/notify-pickup`, `/join/{code}/shuttle`, `/join/{code}/hotels`, `/weddings/{weddingId}/menu-poll`, `/weddings/{weddingId}/menu-poll/remind`, `/join/{code}/menu-vote`.

Гость работает по токену без аккаунта. Атомарные места в автобусе и номере. Счётчики персон — как во фронте: запись с «+1» — двое. Рассылки — через очередь с дебаунсом 30 с (План §13.4). Автосводка кейтерингу — фоновая задача (раздел 5).

**Экраны с моков:** `/wedding/guests`, `/wedding/seating`, `/wedding/checklist`, `/wedding/logistics`, `/wedding/catering`, `/invite` (RSVP), `/wedding/invites`.
**Готово, когда:** 21 параллельная запись в автобус на 20 мест — ровно 20 успешных; повтор `menu-vote` тем же гостем меняет голос, а сумма голосов не растёт; `notify-pickup` дважды за 30 с — одна рассылка.

### Этап 6 — Подарки и фонды · 3 дня

**Пути (6):** `/weddings/{weddingId}/wishlist`, `/weddings/{weddingId}/wishlist/{giftId}`, `/gifts/{code}`, `/gifts/{code}/{giftId}/reserve`, `/gifts/{code}/{giftId}/fund`, `/gifts/{code}/funds/{fundId}`.

Анонимность — правило номер один (§9): ответ паре собирается запросом, который физически не читает `guest_token`. Складчина закрывает подарок при `funded ≥ price`. Маркетплейс «купить в приложении» и выплата фондов паре — вне MVP (платежи).

**Экраны с моков:** `/wedding/wishlist`, `/gifts`.
**Готово, когда:** два параллельных `reserve` — один 200, второй 409; тело любого ответа для роли `couple` не содержит подстроки `guest_token` (проверяется тестом на всех путях этапа); `DELETE reserve` чужим токеном → 403.

### Этап 7 — Чаты, уведомления, фоновые задачи · 7 дней

**Пути (6):** `/chats`, `/chats/{chatId}/messages`, `/chats/{chatId}/typing`, `/chats/vendor/{vendorId}`, `/notifications`, `/notifications/{id}/read`.

Realtime — WebSocket на том же Fastify (`@fastify/websocket`), fallback — поллинг раз в 30 с (§13.4). Чат команды создаётся при второй сделке в `booked` (План §8.5). Чат дня X создаётся сразу, `opens_at = date − 1 день, 09:00` по `weddings.tz`, до открытия — 423 Locked. Push: Web Push (VAPID) с тихими часами и лимитом 3 в день вне дня X (План §18.6). Здесь же — вся очередь BullMQ из раздела 5.

**Экраны с моков:** `/us/chats`, `/us/chats/:id`, `/notifications`, `/dayx` (чат и статусы), `/assistant` (заглушка `tilly` без LLM — ответ «временно без ИИ», План §19.8).
**Готово, когда:** сообщение доставляется второму соединению WebSocket < 1 с в тесте; `POST /chats/{day}/messages` до `opens_at` → 423, после — 200; при `quiet_from=22:00` push в 23:00 не отправляется, а откладывается на 09:00.

### Этап 8 — Кабинет подрядчика и отзывы · 5 дней

**Пути (7):** `/vendor/leads`, `/vendor/leads/{leadId}`, `/vendor/reviews`, `/vendor/reviews/{reviewId}/reply`, `/vendor/analytics`, `/catalog/vendors/{vendorId}/reviews`, `/weddings/{weddingId}/guest-reviews`.

Лид создаётся из «Написать» (этап 7) и из `book`. Отзыв пары — только по сделке в `done`, один на сделку, окно 14 дней; отзыв гостя — только после даты свадьбы, по токену, один на подрядчика; рейтинг — взвешенное среднее с затуханием, минимум 3 отзыва до показа числа (План §18.2, §15). Антиспам: новый подрядчик ≤ 5 первых сообщений в день (План §19.4).

**Экраны с моков:** `/vendor-app`, `/vendor-app/leads/:id`, `/vendor-app/reviews`, `/vendor-app/analytics`, `/vendor-app/deals`, `/after` (отзывы).
**Готово, когда:** `POST /catalog/vendors/{id}/reviews` по сделке в `booked` → 403, в `done` → 201, повтор → 409; подрядчик с 2 отзывами в выдаче показывается как «Новый на платформе», с 3 — с числом.

### Этап 9 — Эксплуатация и 152-ФЗ · 4 дня

**Пути:** нет новых.

Разворачивание на Timeweb Cloud: VPS + управляемая PostgreSQL + S3, все на площадке в РФ. Ежедневный snapshot БД с хранением 30 дней и **репетицией восстановления** (План §19.9), Sentry, rate limit 10 req/s на токен через Redis, удаление аккаунта с soft-delete 30 дней и вычисткой по крону, экспорт данных пары (JSON), статус-страница, runbook на 5 сценариев отказа.

Runbook фиксирует фактическую локацию каждого ресурса — это единственный способ поймать площадку вне РФ: по работающему приложению она не отличима.

**Готово, когда:** восстановление из вчерашнего бэкапа на чистой машине укладывается в 4 часа (RTO из плана) и проходит контрактный тест; локация VPS, БД и S3 в панели Timeweb — РФ, зафиксирована в runbook; удалённый аккаунт через 31 день не находится ни в одной таблице кроме `audit_log`; 11-й запрос за секунду получает 429.

### Сводка

| Этап | Дней | Путей | Накопительно |
|---|---|---|---|
| 0 Каркас | 3 | 0 | 0 |
| 1 Вход и гео | 4 | 7 | 7 |
| 2 Свадьба и команда | 4 | 7 | 14 |
| 3 Каталог и анкета | 6 | 10 | 24 |
| 4 Слоты, сделки, деньги | 8 | 10 | 34 |
| 5 Гости и день | 7 | 16 | 50 |
| 6 Подарки | 3 | 6 | 56 |
| 7 Чаты и задачи | 7 | 6 | 62 |
| 8 Кабинет и отзывы | 5 | 7 | 69 |
| 9 Эксплуатация | 4 | 0 | 69 |
| **Итого** | **51** | **69** | |

---

## 4. Миграция с моков

Фронт хранит всё в localStorage под ключами `tt_*` (Бизнес-логика §17). Каждый ключ уходит на API на конкретном этапе; до этого экран продолжает работать на моках. Переключение — фича-флаг `VITE_API_URL`: пусто — моки, задан — API.

| Ключ localStorage | Эндпоинт | Этап |
|---|---|---|
| `tt_onboarded` | `GET /weddings/{id}` (404 = не пройден) | 2 |
| `tt_lang`, `tt_theme` | профиль пользователя — **нет в контракте** (раздел 8); тема остаётся локальной | 1 |
| `tt_city`, `tt_city_region` | `PATCH /weddings/{id}` | 2 |
| `tt_consent` | `POST /users/me/consent` | 1 |
| `tt_slots` | `GET /weddings/{id}/slots`, `book`, `cancel`, `pay`, `external` | 4 |
| `tt_fav` | `GET/PUT/DELETE /me/favorites` | 3 |
| `tt_settings` | push-тумблеры и тихие часы — **нет в контракте** (раздел 8) | 7 |
| `tt_notif_read` | `POST /notifications/{id}/read` | 7 |
| `tt_guests`, `tt_rsvp` | `GET/POST/PATCH/DELETE /weddings/{id}/guests`, `POST /rsvp/{token}` | 5 |
| `tt_seating`, `tt_tables_count` | `GET/POST /weddings/{id}/tables`, `PATCH /guests/{id}` (tableId) | 5 |
| `tt_guest_rsvp` | `POST /rsvp/{guestToken}` — на устройстве гостя остаётся кэш ответа | 5 |
| `tt_tasks_done`, `tt_tasks_extra` | `GET/POST/PATCH/DELETE /weddings/{id}/tasks` | 5 |
| `tt_budget_custom` | `POST/DELETE /weddings/{id}/budget/items` | 4 |
| `tt_dayx` | сдвиг тайминга — **нет в контракте** (раздел 8) | 7 |
| `tt_after_stars` | `POST /catalog/vendors/{id}/reviews` | 8 |
| `tt_assistant` | чат `kind=tilly` — `GET/POST /chats/{id}/messages` | 7 |
| `tt_chat_<id>` | `GET/POST /chats/{id}/messages` | 7 |
| `tt_gifts`, `tt_my_gifts`, `tt_funds`, `tt_anti`, `tt_bought` | `/weddings/{id}/wishlist`, `/gifts/{code}/*`; `tt_bought` (маркетплейс) — вне MVP | 6 |
| `tt_buses`, `tt_hotels`, `tt_menu_poll` | `/logistics/*`, `/menu-poll*` | 5 |
| `tt_album` | альбом — **нет в контракте** (раздел 8) | — |
| `tt_dress`, `tt_dress_note`, `tt_invite_tpl`, `tt_invite_text` | `PATCH /weddings/{id}` (inviteThemeId, inviteText); палитра дресс-кода — **нет в контракте** | 2 |
| `tt_planb` | чек-лист накануне — по факту это задачи `period='eve'`: `/tasks` | 5 |
| `tt_notes`, `tt_inspo_likes` | заметки и лайки вдохновения — **нет в контракте** (раздел 8) | — |
| `tt_vendor_busy` | `GET /vendor/calendar`, `POST /vendor/calendar/busy` | 3 |
| `tt_guest_reviews` | `GET/POST /weddings/{id}/guest-reviews` | 8 |

**Данные пары, которая пользовалась моками.** Реальных пользователей у приложения пока не было — моки существуют для демонстрации. Поэтому миграция данных из localStorage на сервер **не делается**: при первом входе с API пара начинает с квиза, локальные ключи `tt_*` стираются после успешного `POST /weddings`. Если владелец решит сохранять локальные данные тестировщиков беты — это отдельный одноразовый `POST /weddings/import` с телом из localStorage, которого в контракте нет (раздел 8).

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

1. **helper и coordinator не видят денег.** Любой ответ на `/weddings/{id}/slots` для этих ролей проходит через сериализатор без полей `price`, `statusLabel` с суммой; `/budget*`, `/book`, `/pay`, `/cancel` — 403. Тест: для каждой из двух ролей 10 путей × ожидание 403 или отсутствие поля.
2. **API пары никогда не отдаёт `guest_token`.** Ответы для роли `couple` на путях этапа 6 и на `/guest-reviews` собираются запросами, где столбец не выбирается. Тест: тело каждого ответа проверяется на отсутствие подстрок `guest_token` и `guestToken`.
3. **Подрядчик не видит список гостей** — только агрегаты (План §13.3): в `/chats` типа team нет вложения со списком гостей; отдельного пути для гостей у роли `vendor` нет.
4. **Гость-подрядчик** получает только свой слот, свой блок тайминга и один чат. Токен — `external_invites.token`, 30 дней, отзывается при `DELETE external`.
5. **Гостевые токены** (`rsvp_token`, `invite_code`) — 128 бит случайности, сравнение constant-time, rate limit 10/мин на токен.
6. **Секреты** только в переменных окружения; в репозитории — `.env.example` без значений.

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

## 8. Чего в контракте не хватает

Ничего из этого не дописано — только перечислено. Каждый пункт — либо решение владельца, либо правка контракта после его решения.

### 8.1. Расхождения контракта с документами и кодом

| # | Где | Что |
|---|---|---|
| 1 | `Slot.status` enum `{free, hold, booked, paid}` | Не совпадает ни с шестью состояниями `DealState` (решение владельца), ни с фронтом (`empty/candidate/hold/booked`). Нужно одно: слот отдаёт `dealId` + `deal.state`, а `status` — производная для мозаики. **Требует решения владельца: считать `DealState` единственным источником и перевести `Slot`?** |
| 2 | `Chat.kind` enum `{vendor, team, tilly}` | Нет `day` — чата дня X, который есть во фронте и в §3.11. Есть `tilly` — ИИ-ассистент, которого нет в остальных документах как чата. |
| 3 | `Member.role` enum `{couple, helper, coordinator, vendor}` | Нет `guest-vendor` и `guest` (Бизнес-логика §2). Они не члены свадьбы — верно, но роли для матрицы доступа нужны хотя бы в описании. |
| 4 | `Wedding` без `tz` | Открытие чата дня X «в 09:00 по местному» невозможно без таймзоны свадьбы. |
| 5 | `Guest` без `diet`, `transfer`, `menuOptionId`, `busId` | RSVP+ (§10 п. 3), опрос меню (§12.2) и трансфер (§12.1) описаны, поля в схеме гостя отсутствуют. |
| 6 | `Money` без валюты на объектах | Решение владельца — «копейки + код валюты», но `currency` нет ни в одной схеме. Либо поле на каждом денежном объекте, либо `currency` на уровне свадьбы. **Требует решения владельца.** |
| 7 | Два разных гостевых токена | `/rsvp/{guestToken}` — токен гостя, `/join/{code}`, `/gifts/{code}` — код свадьбы. §9 говорит об анонимной сессии гостя по ссылке приглашения. Нужно определить: один код на свадьбу с выдачей анонимного токена при первом открытии, или персональный токен на гостя с самого начала. **Требует решения владельца.** |
| 8 | Категории | В контракте `Category` без ограничения, в коде 35 — сид-данные нужно зафиксировать в контракте как enum или в отдельном справочном файле. |

### 8.2. Эндпоинты, которых нет, но которые нужны по документам

| # | Эндпоинт | Зачем | Источник |
|---|---|---|---|
| 9 | `GET/PATCH /users/me` | имя, язык, тема, таймзона, push-тумблеры, тихие часы — экран `/settings` | §3.1, `tt_settings` |
| 10 | `DELETE /users/me` | удаление аккаунта отдельно от отзыва согласия; сейчас это склеено в `DELETE /users/me/consent` | §7, План §19.1 |
| 11 | `GET /users/me/sessions`, `DELETE /users/me/sessions/{id}` | экран «Сессии и устройства» | Карта экранов §5.2 |
| 12 | `GET/PUT /weddings/{id}/timeline`, `POST …/timeline/shift`, `POST …/timeline/autogen` | тайминг дня, «+15 мин» в DayX, автоплан | §3.9, План ч. 13 |
| 13 | `POST /weddings/{id}/planb/activate` | план Б одной кнопкой с рассылкой | §13.1, План §18.7 |
| 14 | `PATCH /deals/{id}` (переходы `contacted`, `negotiating`, `done`) | контракт знает только `book/cancel/pay`; четыре из шести состояний недостижимы через API | решение владельца №6 |
| 15 | `POST /deals/{id}/contract`, `GET /weddings/{id}/documents` | генерация договора, список подписанных | §3.10, План §8.7 |
| 16 | `POST /media/upload-url` | presigned upload фото и видео анкет, альбома | План ч. 13 |
| 17 | `GET/POST /weddings/{id}/album`, `PATCH …/album/{id}` | фотоальбом гостей, модерация | §10 п. 4 |
| 18 | `POST /users/me/push-subscriptions` | регистрация Web Push | План §12.1 |
| 19 | WebSocket `/ws` — описание канала и событий | контракт описывает только REST и `/typing` как fallback | §3.11, §13.4 |
| 20 | `POST /complaints` | жалобы из чата, на отзыв, на анкету | План §18.2, §19.4 |
| 21 | `POST /vendor/verification` | подача паспорта / ИП на сверку | План §18.2 |
| 22 | `GET /users/me/referral`, `POST /referral/{code}/apply` | реферальная программа | §3.15 |
| 23 | `GET/PUT /weddings/{id}/anti-gifts`, `POST/DELETE …/funds` | анти-вишлист и управление фондами парой — в контракте только чтение через `/wishlist` | §10 п. 1–2 |
| 24 | `POST /weddings/{id}/cancel`, `POST /weddings/{id}/reschedule` | отмена свадьбы с подтверждением обоих, перенос даты с проверкой команды | План §9.4, §19.1 |
| 25 | `POST /catalog/concierge` | консьерж-заявка при пустой выдаче | План §18.12, §19.2 |
| 26 | `/admin/*` — очередь модерации, жалобы, категории, метрики, read-only просмотр | админка целиком | План §19.10 |
| 27 | `GET /users/me/export` | экспорт данных | §7 |
| 28 | `POST /weddings/import` | перенос данных из localStorage — только если владелец решит сохранять данные бета-тестировщиков | раздел 4 |

**Требуют решения владельца (собрано):** пункты 1, 6, 7 из 8.1 и вопрос о `POST /weddings/import` из раздела 4. Остальное — механическая правка контракта после этих решений, оценка 2 дня, входит в этап 0 как «контракт v0.2».

---

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
