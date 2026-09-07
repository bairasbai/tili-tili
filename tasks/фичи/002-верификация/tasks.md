# Задачи: Очередь заявок на верификацию подрядчиков

**Спека:** ./spec.md · **План:** ./plan.md
**Формат:** `- [ ] T001 [P] [US1] описание в путь/к/файлу`
`[P]` — можно параллельно · `[US1]` — к какой истории

Пути — от `Тили-тили/`, кроме документов корня. Каждая фаза заканчивается прогоном (`backend`: tsc, vitest с
`TEST_DATABASE_URL`, eslint; `app`: tsc -b, vitest, eslint в объёме `init.sh`, `vite build` без предупреждений).
Коммит — только поимённым списком путей.

## Фаза 1 — подготовка (контракт)

- [x] T001 **Общая для фич 002–004** правка контракта v0.27.0 в `Тили-тили_API_openapi.yaml` (сверка X01: три фичи правят один
      файл, генераторы гоняются один раз здесь; в 003 и 004 задача T001 — ссылка сюда): (002) `GET /admin/verifications`
      (`VerificationPage`, `VerificationItem`), `GET /admin/verifications/{requestId}` (`VerificationRequest` с `vendorPublished`),
      `POST /admin/verifications/{requestId}` (`VerificationDecision`, 409 `verification_not_pending`; описание: `approve` заявки —
      «документы сверены», в отличие от `approve` анкеты — «анкета проверена»), `GET /vendor/verification` (`VerificationStatus`,
      **403** без анкеты — так отвечает `myVendorId`), `AdminMetrics.verificationQueue`, описание `reject` у решения по анкете;
      (003) `CancelResult`, 403/404 у `POST /weddings/{weddingId}/cancel`, описание про `done` и срок архива; (004)
      `AdminCategories.version`, `version?` в теле `PUT /admin/categories`, `CategoriesUpdated.version`, 409 у `PUT`. Ответы
      401/403/404/409/422 ссылками. Русские описания. Путей станет 119, операций 157 — сверить по шапке `paths.generated.ts`.
- [x] T002 Генераторы (один раз на три фичи): `backend` → `node scripts/gen-contract.mjs && node scripts/gen-schemas.mjs && node node_modules/openapi-typescript/bin/cli.js ../Тили-тили_API_openapi.yaml -o src/contract/api.generated.ts`;
      фронт — `node node_modules/openapi-typescript/bin/cli.js ../Тили-тили_API_openapi.yaml -o ../app/src/lib/api/schema.ts` (из `backend`;
      `pnpm run gen` на этой машине не работает — ERR в `session-handoff.md`).

## Фаза 2 — основа

- [x] T003 `backend/src/routes/admin.ts`: константа `VERIFICATION_QUEUE_FROM`; `GET /admin/verifications` с курсором `(created_at, id)`;
      `GET /admin/verifications/{requestId}` с `audit` `verification.view` до ответа; показатель `verificationQueue` в `/admin/metrics`.
- [x] T004 [P] `app/src/lib/api/admin.ts`: `getVerifications(cursor?)`, `getVerification(id)`, `decideVerification(id, action, reason?)`;
      `app/src/lib/api/vendor.ts`: `getVerificationStatus()`.
- [x] T005 [P] `app/src/App.tsx`: маршруты `/admin/verifications`, `/admin/verifications/:requestId` (чанк `load.admin`);
      `ROUTES` в `app/src/lib/nomocks.test.tsx`, `smoke.test.tsx`, `clickstorm.test.tsx`; `FORBIDDEN_WHEN_DOWN`.

## Фаза 3 — US1 Сотрудник разбирает заявку (P1) 🎯 MVP

- [x] T006 [US1] `backend/src/routes/admin.ts`: `POST /admin/verifications/{requestId}` — `for update`, 409 не `pending`, 422 без причины
      при `reject`, `approve` → `approved` + `vendors.verified_at = coalesce(verified_at, now())`, `reject` → `rejected`; аудит в
      транзакции; уведомление владельцу после фиксации (`system`, `link: '/vendor-app/verification'`, `critical: false`), сбой — в лог;
      при `approve` уведомление «Вы проверены» только если галочки до этого не было (иначе второе «Вы проверены» после `verify`
      анкеты — сверка V05); при `reject` — «Документы не подтверждены» + причина.
- [x] T007 [US1] `backend/src/routes/admin.ts`: решение `reject` по анкете больше не переводит `vendor_verifications` в `rejected`
      (ветка убирается; `verify` оставляет `approved`).
- [x] T008 [US1] `backend/test/audit25.test.ts`: очередь — 403 постороннему, только `pending`, старейшая первой, без `fileUrl`/`inn`
      в списке; карточка — `fileUrl`/`inn` есть, строка `audit_log` `verification.view`; `approve` → статус, `verified_at`,
      уведомление «Вы проверены», аудит; `reject` без причины → 422; с причиной → `rejected`, `verified_at` пуст, анкета
      как была, уведомление с причиной; повтор → 409; `reject` анкеты не трогает заявку; заявка удалённого пользователя
      не в очереди; метрика = длине очереди. Каждый тест красный без своей правки.
- [x] T009 [US1] `app/src/pages/Admin.tsx` → `AdminVerifications`: `useApi` + `AsyncState forbiddenText={denied()}`; пусто — только при
      `ready` («Заявок нет»); список (имя подрядчика, вид документа словами, дата подачи, «документ не приложен» при `hasFile: false`),
      «Показать ещё», переход на карточку; раздел на главной панели; `TopBar back fallback="/admin"`.
- [x] T010 [US1] `app/src/pages/Admin.tsx` → `AdminVerification`: `useApi` + `AsyncState` (403 — отказ без карточки; 404 — «заявка не
      найдена»); карточка (вид, ИНН, ссылка на документ как внешняя ссылка `target="_blank" rel="noopener"` с `aria-label`, либо
      «документ не приложен»; дата подачи; «Открыть анкету →» на `/admin/moderation/{vendorId}` только при `vendorPublished`, иначе
      слова «анкета не опубликована — решение по документам это не задерживает»); кнопки **«Подтвердить документы»** (`approve`) и
      **«Отклонить документы»** (`reject`, поле причины `textarea` ≤ 1000, неактивна без причины) — не «Одобрить», чтобы не путать с
      решением по анкете (сверка V04); `busy`/`err`; 409 → «Заявка уже разобрана» и назад в очередь; после успеха — назад в
      очередь; `TopBar back fallback="/admin/verifications"`; проверка `isStaff` через `GET /users/me` не нужна — карточку
      отдаёт путь панели (403 сам). Клавиатура: фокус на поле причины после нажатия «Отклонить документы» не нужен — кнопка
      обычная; `role="alert"` у ошибок.
- [x] T011 [US1] `app/src/lib/audit24.test.tsx` (образец `serve`/`open` из `audit23.test.tsx`): 403 — отказ и ни одной цифры;
      пустая очередь — «Заявок нет» только после ответа; список показывает подрядчика, вид и дату; карточка — ссылка с
      `target="_blank"`, «Отклонить документы» неактивна без причины, тело `{action:'reject', reason}`; «Подтвердить документы»
      шлёт `{action:'approve'}`; 409 → текст «уже разобрана»; `vendorPublished: false` → перехода на анкету нет.

**Проверка фазы:** живой сценарий через API + панель: заявка → карточка → одобрение → галочка в каталоге, строки базы.

## Фаза 4 — US2 Подрядчик видит статус (P1)

- [x] T012 [US2] `backend/src/routes/vendorCabinet.ts`: `GET /vendor/verification` — последняя заявка владельца анкеты; без анкеты —
      403 через `myVendorId` (как остальные пути кабинета; сверка V01).
- [x] T013 [US2] `backend/test/audit25.test.ts`: `none` → после подачи `pending` с `submittedAt` → после решения `approved`/`rejected`
      с `checkedAt`; ответ без `fileUrl`/`inn`; чужой подрядчик статус не видит (только свой).
- [x] T014 [US2] `app/src/pages/VendorApp.tsx` → `VendorVerification`: `useApi(getVerificationStatus)`; состояния: `pending` — «Заявка на
      проверке с <дата>», `rejected` — «Отклонена <дата>. Причина — в уведомлениях» и переход на `/notifications`, `approved` —
      как «Вы проверены»; `none` — текущий экран; выбор «Кто вы» остаётся при `none`.
- [x] T015 [US2] `app/src/lib/audit24.test.tsx`: три статуса на экране подрядчика; без ответа сервера — ни одного статуса.

## Фаза 5 — US3 Дашборд (P2)

- [x] T016 [US3] `app/src/pages/Admin.tsx` → `AdminHome`: показатель «Заявок на верификацию» через `num()` — в карточке очередей
      рядом с «Анкет в очереди» (сетка 3×N без рваной строки: перестроить показатели в две карточки — платформа: аккаунты,
      свадьбы, анкеты в каталоге; очереди: анкеты, заявки, жалобы, просрочено — 2×2); раздел «Верификация» → `/admin/verifications`.
- [x] T017 [US3] `app/src/lib/audit24.test.tsx`: показатель до ответа — прочерк, после — число.

## Фаза 6 — полировка

- [x] T018 `app/src/lib/i18n.en.ts` — новые строки; `dictionary.test.ts` зелёный.
- [ ] T019 Карты: `Тили-тили_Карта_кнопок.md`, `Тили-тили_Карта_экранов.md` — два новых маршрута, изменённый экран подрядчика; журналы.
- [ ] T020 Документы: `RELEASE-BLOCKERS.md` №25 — закрыт (с датой); `CLAUDE.md` §2 — числа путей/операций/схем по шапке
      `paths.generated.ts` после генератора (ожидание: 119 / 157);
      `tasks/todo.md` — хвост «частичный уникальный индекс на pending»; `JOURNAL.md`; `ERRORS.md` — если найдены дефекты;
      `session-handoff.md`.
- [ ] T021 Живая проверка сотрудником: заявка через API (`POST /vendor/verification` от подрядчика `+79170007777` или нового),
      очередь, карточка, решение — `audit_log`, `notifications`, `vendors.verified_at`, экран подрядчика; тёмная тема двух экранов.
- [ ] T022 Доступность и состояния (FR-011, сверка V02): у обоих экранов — загрузка/ошибка/отказ/пусто через `AsyncState`,
      `aria-label` у внешней ссылки и кнопок-значков, `role="alert"` у ошибок, обход с клавиатуры; проверить в браузере.

## Зависимости

- Фаза 1 → 2 → 3; US2 (фаза 4) зависит только от фазы 1; US3 — от T003.
- Параллельно: бэкенд-задачи (T003, T006–T008, T012–T013) и фронт-задачи (T004–T005, T009–T011, T014–T017) — разные файлы.
- **MVP = фаза 3.**
