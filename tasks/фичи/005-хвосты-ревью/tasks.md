# Задачи: Хвосты ревью старого кода

**Спека:** ./spec.md · **План:** ./plan.md (одобрен 2026-09-11, В1–В8)
**Формат:** `- [ ] T001 [P] [US1] описание в путь/к/файлу`

Пути — от `Тили-тили/`, кроме документов корня. Каждая задача с кодом — с регрессионным тестом, красным без фикса
(доказательство подменой `git show HEAD:<путь>` + `cmp`). Прогоны по файлу — во время работы; полные наборы — перед
коммитом фазы, бэкенд и фронт не одновременно (R-177). Коммит — только явными путями.

## Фаза 1 — миграции (US1, FR-001…FR-006 + колонка для FR-009)

Файлы `backend/migrations/17592…`–`17599…`, каждая обратима. Данные дев-базы проверены 2026-09-11 (`dbcheck.cjs`):
4 маршрута автобуса переполнены по персонам (места 1, гость с +1) и 2 жалобы с неприменимой санкцией — обе
`CHECK` ставятся `NOT VALID` (новые строки проверяются, старые — как есть, `VALIDATE CONSTRAINT` после уборки владельцем);
86 внешних чатов без сделки в слоте — удаляются в `up` (недостижимы кодом: чат заводится сделкой); 26 слотов с
несколькими своими подрядчиками — история делится по сделкам по `created_at`; 77 гостевых отзывов без гостя —
`guest_id` пуст, ключ `guest_token` остаётся.

- [ ] T001 `1759200000000_chat_by_deal.cjs`: `chats.deal_id uuid references deals on delete cascade`; заполнение по
      `deals` слота (текущая или последняя своя сделка), новые чаты для прежних сделок слота + перенос их сообщений по
      `created_at`; удаление внешних чатов без сделки; `CHECK chats_deal_only_for_external ((kind='external') = (deal_id is not null))`;
      уникальный индекс `(deal_id) where kind='external'`; старый `(wedding_id, slot_id)` снимается. `down` — обратно.
- [ ] T002 `1759300000000_bus_seats_by_persons.cjs`: `bus_seat_counter()` считает `1 + plus_one::int` гостя; триггер
      `guests_plus_one_seats` (`AFTER UPDATE OF plus_one`) пересчитывает `taken` маршрута гостя; `bus_taken_bounded`
      пересоздаётся `NOT VALID` после пересчёта `taken = Σ(1 + plus_one)`.
- [ ] T003 `1759400000000_review_by_guest.cjs`: `reviews.guest_id uuid references guests on delete set null`, заполнение
      по `guests.rsvp_token = reviews.guest_token`, уникальный индекс `(guest_id, vendor_id) where guest_id is not null`,
      старый `(guest_token, vendor_id)` снимается; `CHECK reviews_key_matches_source` без изменений.
- [ ] T004 `1759500000000_deal_package.cjs`: `deals.package_id uuid references vendor_packages on delete set null`.
- [ ] T005 `1759600000000_complaint_resolution_by_target.cjs`: `CHECK` по цели (`vendor`: dismiss/warn/downrank/block;
      `review`: dismiss/warn/block; `message`/`deal`: dismiss/warn) — `NOT VALID`.
- [ ] T006 `1759700000000_verification_constraints.cjs`: `CHECK (file_url is null or file_url like 'https://%')`;
      уникальный индекс `vendor_verifications(vendor_id) where status='pending'`.
- [ ] T007 `1759800000000_couple_reviews_count.cjs`: `vendors.couple_reviews_count integer not null default 0`,
      заполнение по `reviews` (`source='couple' and hidden_at is null`), индекс.
- [ ] T008 `backend/test/audit32.test.ts` (живая база): каждое правило ломается прямым SQL и получает отказ
      (`23505`/`23514`), триггер автобуса считает персоны при вставке, удалении и смене `plus_one`.
- [ ] T009 `npm run migrate up` на локальной базе; `down`/`up` последней миграции — ради обратимости; отчёт в handoff.

## Фаза 2 — код под схему (US1)

- [ ] T010 [US1] `backend/src/routes/slots.ts`: чат заводится на СДЕЛКУ (`deal_id` + `slot_id`) в `POST …/external`;
      `externalChatId(dealId)`; `inviteByToken` отдаёт `deal_id` текущей сделки слота (`slots.deal_id`; пусто → 410);
      фильтр «не старше сделки» из ERR-0219 снимается. `backend/src/routes/chats.ts`: `external_name` и признак
      `closed` по `c.deal_id` (сделка `cancelled`); `backend/src/chats/access.ts`: `deal_id` в `CHAT_COLUMNS`.
      Тесты: `audit32` — А → Б в одном слоте через все три двери отмены: два чата, Б не видит реплик А.
- [ ] T011 [US1] `backend/src/routes/day.ts` (`POST /join/{t}/shuttle`, `DELETE`): ранняя 409 `bus_full` по персонам
      остаётся; `23514` от `bus_taken_bounded` → 409 `bus_full`. `backend/src/routes/guests.ts` (`PATCH …/guests/{id}`)
      и `PATCH /join/{t}` (смена `plus_one` у гостя в автобусе): `23514` → 409 `bus_full` с текстом про +1.
      Тест: 20 мест, 19 гостей с +1 → `taken` 38, двадцатый — 409.
- [ ] T012 [US1] `backend/src/routes/reviews.ts` (`POST /weddings/{id}/guest-reviews`): `guest_id` из гостя по токену,
      `on conflict (guest_id, vendor_id) where guest_id is not null`; `backend/src/routes/guests.ts`: перенос токена
      в отзывах при перевыпуске (ERR-0234) снимается. `backend/src/jobs/index.ts`: стирание аккаунтов/уборка — с учётом
      `on delete set null`. Тест: отзыв → перевыпуск ссылки → второй отзыв тем же гостем → 409/тот же.
- [ ] T013 [US1] `backend/src/routes/slots.ts` (`POST …/book` с `packageId`): бронь пишет `package_id`; `toDeal`
      отдаёт `packageName` (контракт, фаза 4). Тест: бронь по пакету → сделка помнит пакет; удалённый пакет → `null`.
- [ ] T014 `backend/src/routes/admin.ts`: комментарий «правило в обработчике, а не в CHECK» обновить — CHECK есть;
      `backend/src/routes/vendorCabinet.ts`: `23505` на второй `pending` → 409 `verification_pending` (гонка двух нажатий).
      Тесты: `audit32`.

## Фаза 3 — вход и лимиты (US2, US3; FR-007, FR-008)

- [ ] T015 [US2] `backend/src/routes/auth.ts` (`POST /auth/verify`): пользователь с `deleted_at` в окне 30 дней —
      `update users set deleted_at = null … where id and deleted_at > now() - interval '30 days'`, запись
      `user.restored` в `audit_log`, ответ обычный; если согласие отозвано (`consent_withdrawn_at`/нет актуального
      согласия) — `consentRequired: true` в ответе, как у нового; старше 30 дней строка уже стёрта уборкой — новый
      аккаунт как сейчас. Контракт: описание `POST /auth/verify` (фаза 4). Тест: удалить → войти → данные на месте,
      `audit_log` содержит `user.restored`, refresh больше не 401.
- [ ] T016 [US3] `backend/src/routes/auth.ts` (`POST /auth/otp`) + `backend/src/config.ts`: лимиты по `otp_codes` —
      пара `(phone, ip)` 3/час (`OTP_MAX_PER_PHONE_IP_HOUR`), номер 10/час (`OTP_MAX_PER_PHONE_HOUR`) и 30/сутки
      (`OTP_MAX_PER_PHONE_DAY`); прежний лимит «номер 5/час» становится потолком «номер+IP»; `Retry-After` во всех 429
      с кодом `too_many_requests`; `.env.example` — новые переменные. Тесты (`audit32`, `otpMax*` через `buildApp`):
      четвёртый код с того же адреса — 429, с другого адреса — 200; одиннадцатый с разных адресов — 429; неверные
      попытки чужого адреса не гасят код жертвы дольше минуты (существующее поведение — закрепить).
- [ ] T017 `app/src/pages/Account.tsx`: 429 на «Получить код» — таймер уже читает `Retry-After`; проверить текст
      «Слишком много запросов — попробуйте через N с» (ключ есть). Тест фронта при необходимости.

## Фаза 4 — рейтинг (US4; FR-009)

- [ ] T018 [US4] `backend/src/reviews/rating.ts`: `recomputeRating` пишет и `couple_reviews_count`; `publicRating(rating,
      reviewsCount, coupleReviewsCount)` — порог по парам. `backend/src/routes/catalog.ts`: `SHOWN_RATING` и фильтр
      `ratingMin` по `v.couple_reviews_count >= MIN_REVIEWS_TO_SHOW`; `backend/src/routes/vendorCabinet.ts` и анкета —
      `reviewsCount` как было, `rating` по новому порогу. Тест: три гостевых отзыва → `rating: null` в каталоге и анкете;
      три отзыва пар → число, гостевой входит в среднее.

## Фаза 5 — контракт v0.29.0 и экраны (US5; FR-010, FR-011)

- [ ] T019 Контракт `Тили-тили_API_openapi.yaml` → v0.29.0 одной правкой: `GuestHotels.myHotelId` (nullable);
      `WeddingPublic.tz`; `Guest.comment` (nullable, только паре — описание); `Message.system: boolean`;
      `TimelineShiftResult.guestsAffected` (integer, сколько гостей касается) при сохранении `notifiedGuests`;
      `VendorProfile.blocked: boolean`; `GET /users/me/push-subscriptions` → список `{ endpoint, createdAt }`;
      тела `202` у `POST …/guests/remind` и `POST …/menu-poll/remind` (`{ queued: integer }` — что реально
      делается); `POST /vendor/leads/{leadId}` — описание `text`; `Deal.packageName` (nullable);
      `Chat.closed: boolean` (свой подрядчик убран); `VendorCabinetMoney.shortfall` (недоплата по `done`);
      `PATCH`/`DELETE /weddings/{weddingId}/tables/{tableId}` (переименовать/удалить, гости — «без стола»);
      `POST /weddings` — 409 `wedding_exists`; `POST /auth/verify` — описание восстановления; `POST /auth/otp` —
      429 с `Retry-After` и коды. Генераторы: `gen-contract`, `gen-schemas`, `api.generated.ts`, `app/.../schema.ts`.
      `audit14` (коды объявлены) зелёный.
- [ ] T020 Бэкенд под контракт: `day.ts` (`GET /join/{t}/hotels` → `myHotelId`; `GET /join/{t}/team` → `tz`),
      `guests.ts` (`comment` паре; телефон гостя — только паре, остальным `hasPhone`; `POST …/guests/remind` — только
      паре, 403 остальным; `PATCH`/`DELETE …/tables/{id}` с переносом гостей на `table_id = null`), `chats.ts`
      (`system` у записей без отправителя в чатах команды/дня; `closed`), `dayx.ts` (`guestsAffected = result.guests`),
      `vendorCabinet.ts` (`blocked` в анкете; `shortfall`), `users.ts` (`GET /users/me/push-subscriptions`),
      `weddings.ts` (`POST /weddings` → 409 `wedding_exists`, если у пары есть живая свадьба — не архив, не отмена).
      Тесты `audit32`/`audit33`: по одному на поле и на правило прав.
- [ ] T021 Фронт под контракт: `app/src/lib/api/*` (обёртки), `app/src/pages/Invite.tsx` (`myHotelId` — «Вы здесь»,
      «свадьба прошла» по `tz`), `Wedding.tsx`/`Tools.tsx` (комментарий гостя в списке пары; таблица столов —
      переименовать/удалить с подтверждением; «Документы» — выбор сделки, если `?deal=` нет), `Us.tsx`
      (системная запись по `system`; закрытый чат своего подрядчика с подписью «подрядчик убран»), `Smart.tsx`
      (`guestsAffected` в тосте сдвига), `VendorApp.tsx` (`blocked` — плашка «Анкета заблокирована модератором», публикация
      закрыта; «недоплата по завершённым» строкой), `Account.tsx` (список push-подписок из `GET`), `Quiz.tsx`/стор
      (409 `wedding_exists` → текст и переход к своей свадьбе), словарь `i18n.en.ts`, тесты `audit32.test.tsx`.
- [ ] T022 Карты кнопок и экранов — генераторы + строка журнала `feature-005`; `Тили-тили_Бизнес-логика_и_бэкенд.md`
      §17 — новые колонки; `BACKEND-PLAN.md` — схема.

## Фаза 6 — уборка и записи (FR-012)

- [ ] T023 `git rm backend/scripts/gen-templates.mjs`; `backend/src/wedding/templates.generated.ts` →
      `templates.ts` (`git mv`), шапка «не править руками» снята, импорты обновлены; `backend/test/stage2` —
      категории шаблонов ⊂ справочника (если ещё нет).
- [ ] T024 `ERRORS.md` (ERR-0246… по найденному), `JOURNAL.md`, `tasks/todo.md`, `session-handoff.md`,
      `RELEASE-BLOCKERS.md` (№22 — миграции на пустой базе; `VALIDATE CONSTRAINT` двух `NOT VALID`), `CLAUDE.md` §10 п. 5.
- [ ] T025 `bash init.sh` exit 0; полные прогоны обоих наборов; коммиты по фазам явными путями.
