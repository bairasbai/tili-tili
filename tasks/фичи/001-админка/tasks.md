# Задачи: Админка — панель сотрудника платформы

**Спека:** ./spec.md · **План:** ./plan.md
**Формат:** `- [ ] T001 [P] [US1] описание в путь/к/файлу`
`[P]` — можно параллельно · `[US1]` — к какой истории

Пути — от `Тили-тили/`, кроме документов корня (`CLAUDE.md`, `JOURNAL.md`, `ERRORS.md`, `RELEASE-BLOCKERS.md`,
`session-handoff.md`, `tasks/…`). Каждая фаза заканчивается прогоном: `backend` — `tsc --noEmit`, vitest с
`TEST_DATABASE_URL`, eslint; `app` — `tsc -b`, vitest, eslint в объёме `init.sh`, `vite build` без
предупреждений. Коммит — только поимённым списком путей.

## Фаза 1 — подготовка (контракт)

- [x] T001 Контракт v0.26.0 в `Тили-тили_API_openapi.yaml` — по разделу «Контракт» плана, пункты 1–9:
      `UserProfile.isStaff` с `readOnly: true`; метод `GET` у `/admin/categories` (`AdminCategories`, `AdminCategory` с
      `sort` и `nullable` `icon`); тело `PUT /admin/categories` — `AdminCategory[]` и `synonyms` с `additionalProperties: {type: string}`;
      `ModerationVendor` (+`createdAt`, +`publishedAt`) и `ModerationVendorPage`; ответы `VendorDecision`, `ComplaintDecision`,
      `CategoriesUpdated`; `AdminMetrics`; `WeddingSupportCard` и границы `reason` 5..500; `reason ≤ 1000` с описанием
      «обязательна при reject», `note ≤ 2000`; новый `responses.Validation` (422) и ответы 401/403/404/422 у всех `/admin/*`;
      описание `Category` — `PUT`. Описания — русские, в стиле соседних путей.
- [x] T002 Генераторы бэкенда: `backend` → `pnpm run gen` (`src/contract/*.generated.ts`, `src/contract/api.generated.ts`).
- [x] T003 Типы фронта тем же пакетом из `backend`:
      `node node_modules/openapi-typescript/bin/cli.js ../Тили-тили_API_openapi.yaml -o ../app/src/lib/api/schema.ts`;
      в `app` `tsc -b` зелёный; `git diff` схемы — только админские и `isStaff` изменения.

## Фаза 2 — основа (блокирует все истории)

- [x] T004 `backend/src/routes/users.ts`: `is_staff` в выборке `ProfileRow` и `isStaff` в `toProfile()`.
- [x] T005 `backend/src/routes/admin.ts`: `GET /admin/categories` (сотрудник; `categories` по `sort, name` с полями
      `id, title, icon, sort`; `synonyms` объектом `word → category_id`).
- [x] T006 `backend/test/audit23.test.ts`: `GET /users/me` → `isStaff:false`; после `update users set is_staff = true`
      → `true`; `PATCH /users/me {isStaff:true}` → 422 и признак не меняется; `GET /admin/categories` — 403 не
      сотруднику, 200 сотруднику, круг `PUT` → `GET` сходится (включая `icon` без `null`).
- [x] T007 [P] `app/src/lib/api/admin.ts`: обёртки `getAdminMetrics`, `getModerationQueue(cursor?)`, `decideVendor(id, action, reason?)`,
      `getComplaints(cursor?)`, `decideComplaint(id, action, note?)`, `getAdminCategories`, `putAdminCategories(body)`,
      `getWeddingForSupport(id, reason)`; типы — из `schema.ts`, без локальных копий схем; query — приёмом из
      `lib/api/catalog.ts` (`api.get(\`${path}?${qs}\` as typeof path)`), `reason` через `encodeURIComponent`.
- [x] T008 [P] `app/src/App.tsx`: чанк `load.admin`, шесть маршрутов `/admin`, `/admin/moderation`, `/admin/moderation/:vendorId`,
      `/admin/complaints`, `/admin/categories`, `/admin/wedding`; `noTab` для `p.startsWith('/admin')`;
      `admin` в `SEGMENTS` deep-link-шима `app/index.html` (`shell.test.tsx` это проверяет);
      `app/src/components/chrome.tsx`: у `TopBar` необязательный `fallback` для `goBack`.
- [x] T009 `app/src/pages/Us.tsx`: `useApi(() => getMe(), [])`; пункт «Админка» (`to: '/admin'`) в карточке меню только при
      `me.data?.isStaff === true`; без ответа сервера пункта нет.
- [x] T010 `app/src/pages/Admin.tsx`: каркас — `AdminHome` с `TopBar` «Платформа», ссылками на четыре раздела и местом под
      дашборд; общий `forbiddenText` = `t('Раздел для сотрудников платформы')`; `AsyncState` у каждого запроса;
      все `TopBar back` внутри панели с `fallback="/admin"`.

**Проверка фазы:** не сотрудник открывает `/admin` — видит отказ и ничего больше; сотрудник — разделы.

## Фаза 3 — US1 Очередь модерации анкет (P1) 🎯 MVP

- [x] T011 [US1] `backend/src/routes/admin.ts`: очередь без заблокированных (`blocked_at is null`) и с `publishedAt`;
      `reject` без непустой `reason` → `422 validation_failed`, поле `reason`.
- [x] T012 [US1] `backend/test/audit23.test.ts`: заблокированный не в очереди; у элемента очереди есть `publishedAt`;
      `reject` без причины → 422, анкета осталась опубликованной; `approve` → `moderated_at`, уведомление `system`
      владельцу анкеты, строка `audit_log` `vendor.approve`; `reject` с причиной → `published_at null`, уведомление
      `critical`, строка `audit_log` с причиной в `diff`.
- [x] T013 [US1] `app/src/pages/Admin.tsx` → `AdminModeration`: список (имя, категория, город, дата публикации,
      «Верифицирован» при `verified`), «Показать ещё» по `nextCursor`, переход на деталь; пусто — только при `ready`.
- [x] T014 [US1] `app/src/pages/Admin.tsx` → `AdminVendorDecision`: `GET /catalog/vendors/{vendorId}` (описание, число
      фото/видео, пакеты); 404 → «анкета недоступна в каталоге» словами; три действия: «Одобрить», «Снять с публикации»
      (поле причины, кнопка неактивна при пустой, ≤ 1000), «Отметить верифицированным» (подпись: документы сверены вне
      приложения); `busy`/`err` под кнопками, после успеха — назад в очередь.
- [x] T015 [US1] `app/src/lib/audit23.test.tsx` по образцу `serve`/`open` из `audit17.test.tsx` (ждать исчезновения
      `route-loading`, потом слово из ответа): `/admin` и `/admin/moderation` при 403 — текст отказа, ни одного числа;
      при `DOWN` — «Сервер недоступен»; решение шлёт `{action:'reject', reason}`; кнопка снятия неактивна без причины;
      «Админка» в `/us` есть только при `isStaff:true`.

**Проверка фазы:** живой сценарий: подрядчик публикует → сотрудник снимает с причиной → каталог 404, уведомление в базе.

## Фаза 4 — US2 Очередь жалоб и санкции (P1)

- [x] T016 [US2] `backend/src/routes/admin.ts`: применимость санкции к цели (`422 validation_failed`, поле `action`):
      `vendor` — все четыре; `review` — `dismiss|warn|block`; `message|deal` — `dismiss|warn`; уведомление владельцу
      анкеты при `warn`/`downrank`/`block` по цели `vendor` (`system`, `critical` при `block`, текст заметки не уходит).
- [x] T017 [US2] `backend/test/audit23.test.ts`: `block` на `message` → 422 и жалоба остаётся `new`; `warn` на `vendor` →
      уведомление без текста заметки; `block` → `critical`; `downrank` на `review` → 422; `block` на `review` → `hidden_at`;
      строка `audit_log` `complaint.<action>` с `complaintId` в `diff`.
- [x] T018 [US2] `app/src/pages/Admin.tsx` → `AdminComplaints`: карточка жалобы (повод, тип цели, текст, дата, «просрочено»
      при возрасте > 24 ч от `useState(() => Date.now())`), ссылка на карточку подрядчика для цели `vendor`, заметка ≤ 2000,
      набор кнопок по цели (см. план), после решения — `reload()`; 404 при повторе — «уже разобрана».
- [x] T019 [US2] `app/src/lib/audit23.test.tsx`: набор кнопок по типу цели; тело `{action:'block', note}`; «просрочено» у
      жалобы старше суток и его отсутствие у свежей; 404 → текст «уже разобрана».

**Проверка фазы:** живой сценарий: жалоба пары на подрядчика → блокировка → подрядчик 404 в каталоге, уведомление, `audit_log`.

## Фаза 5 — US3 Дашборд (P2)

- [x] T020 [US3] `app/src/pages/Admin.tsx` → дашборд в `AdminHome`: девять показателей через `num(q, …)`, деньги через
      `num(q, fmt(gmv))`, города списком с пометкой «готов к запуску».
- [x] T021 [US3] `app/src/lib/audit23.test.tsx`: до ответа — прочерки, «0 ₽» не появляется; после — числа сервера, ноль как
      ноль; `FORBIDDEN_WHEN_DOWN['/admin']` в `nomocks.test.tsx`.

## Фаза 6 — US4 Категории и синонимы (P2)

- [x] T022 [US4] `backend/src/routes/admin.ts`: `PUT /admin/categories` — проверка `synonyms` по справочнику → 422 без
      изменений; запись аудита внутри транзакции.
- [x] T023 [US4] `backend/test/audit23.test.ts`: неизвестная категория в `synonyms` → 422, словарь не тронут; после успешного
      `PUT` есть строка `audit_log` `categories.update`.
- [x] T024 [US4] `app/src/pages/Admin.tsx` → `AdminCategories`: список категорий с полями название/значок/порядок и «Добавить
      категорию» (`id` латиницей ≤ 40); словарь строками «слово → категория» (`select` по категориям), добавление и удаление
      строки; «Сохранить» → свой оверлей `role="dialog"` с `useEscape` и числом строк словаря → `PUT` полным телом
      (`icon` опускается, если пуст); ошибка сервера под кнопкой; `Tile` в `chrome.tsx` переживает пустую плитку.
- [x] T025 [US4] `app/src/lib/audit23.test.tsx`: экран показывает данные `GET`; сохранение шлёт полное тело; до подтверждения
      запроса нет; Escape закрывает подтверждение без запроса.

## Фаза 7 — US5 Карточка свадьбы по запросу поддержки (P3)

- [x] T026 [US5] `app/src/pages/Admin.tsx` → `AdminWedding`: поле идентификатора, поле причины (5–500, счётчик), подпись
      «просмотр записывается: кто, когда, зачем», кнопка неактивна пока не валидно; результат — карточка полей ответа;
      404 — «свадьба не найдена».
- [x] T027 [US5] `app/src/lib/audit23.test.tsx`: кнопка неактивна при причине короче 5; запрос уходит с `reason` в строке
      запроса; карточка показывает поля.

## Фаза 8 — полировка

- [x] T028 `app/src/lib/i18n.en.ts`: блок `Object.assign(EN, {...})` со всеми новыми строками; `dictionary.test.ts` зелёный.
- [x] T029 `ROUTES` в `app/src/lib/nomocks.test.tsx`, `smoke.test.tsx`, `clickstorm.test.tsx` — шесть новых маршрутов.
- [x] T030 Карты: разделы шести маршрутов в `Тили-тили_Карта_кнопок.md` (класс, обработчик, запрос, сервер, тесты) и строки в
      `Тили-тили_Карта_экранов.md` (чтения, состояния, число элементов); §0.1 — TabBar скрыт на `/admin*`; журналы обоих файлов (R-MAP/R-BTN).
- [x] T031 Документы: `RELEASE-BLOCKERS.md` — №18 (инструменты теперь с экраном), новые пункты владельца (LLM-стоимость и
      заполненность на дашборде; просмотр сделки поддержкой; очередь верификации после одобрения); `tasks/todo.md` — хвост
      «`CHECK` на `complaints.resolution` — миграция после «да»»; `CLAUDE.md` §2 и §10 — 117 путей / 153 операции, админка
      сделана; `JOURNAL.md`; `ERRORS.md` — дефекты, найденные по ходу (500 на неизвестной категории в словаре; аудит вне
      транзакции; санкция без адресата; `synonyms` как `Record<string, never>` в типах); `session-handoff.md`.
- [x] T032 Ручная проверка в браузере против бэкенда сотрудником (`update users set is_staff = true` для одного тестового
      номера): пять экранов, решения, SC-001 (три нажатия), строки `audit_log`, `notifications`, каталог после блокировки —
      через psql; протокол — в записи `JOURNAL.md` по фиче.
- [x] T033 Тёмная тема (R-06): шесть экранов панели под `prefers-color-scheme: dark` в браузере — читаемость, ни одного
      светлого пятна; правки — только токенами в `app/src/pages/Admin.tsx`.
- [x] T034 Доступность (R-13): кнопки-значки с `aria-label`, оверлей подтверждения `role="dialog"` + `aria-modal`, фокус на
      первом поле, обход с клавиатуры всех шести экранов — `app/src/pages/Admin.tsx`.

## Зависимости

- Фаза 1 → фаза 2 → истории. Истории US1, US2, US4, US5 между собой независимы; US3 живёт на экране `AdminHome`
  из T010 и может идти параллельно с любой.
- После фазы 1 бэкенд-задачи (T004–T006, T011–T012, T016–T017, T022–T023) и фронт-задачи (T007–T010, T013–T015,
  T018–T021, T024–T027) не пересекаются по файлам — можно вести двумя исполнителями параллельно.
- **MVP = фаза 3.** После неё панель уже снимает мусор с каталога и уведомляет подрядчика; фазы 4–7 — по убыванию приоритета.
