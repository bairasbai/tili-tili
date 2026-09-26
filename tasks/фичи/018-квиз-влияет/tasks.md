# Задачи: Ответы квиза влияют на свадьбу

**Спека:** ./spec.md · **План:** ./plan.md
**Формат:** `- [ ] T001 [P] [US1] описание в путь/к/файлу` · `[P]` — можно параллельно · `[US1]` — к какой истории

Пути — от `Тили-тили/`. Каждая задача с кодом — с тестом, красным до правки. Бэкенд — на живой базе (`TEST_DATABASE_URL`).

## Фаза 1 — подготовка

- [x] T001 Спека, план, задачи в `tasks/фичи/018-квиз-влияет/`

## Фаза 2 — основа (блокирует все истории)

- [x] T002 Красные тесты бэка на живой базе в `backend/test/feature018.test.ts`: формат → слоты и тайминг; planner → слот;
      prebooked → флаги и выполненные задачи; неверный код → 422; `DELETE …/prebooked` 204/204/403/404; бронь и свой
      подрядчик снимают отметку; перенос двигает второй день; «Имя ♥ Партнёр» после `PATCH /users/me`
- [x] T003 Контракт v0.42.0 в `Тили-тили_API_openapi.yaml`; `gen-contract`, `gen-schemas`, `gen:types`, копия в
      `app/src/lib/api/schema.ts`; сторож версии `backend/test/audit55.test.ts`
- [x] T004 Миграция `backend/migrations/1761300000000_quiz_answers_matter.cjs` (с `down`)

## Фаза 3 — US1 имена + US2 формат и «кто планирует» (P1) 🎯 MVP

- [x] T005 [US2] Шаблоны по формату и «кто планирует», `dayOffset`, `categoryId` задач в `backend/src/wedding/templates.ts`
- [x] T006 [US2] Поля тела, вставки в транзакции, `format`/`planner` в ответе в `backend/src/routes/weddings.ts`
- [x] T007 [US2] Первая дата по шаблону формата, второй день в `backend/src/wedding/reschedule.ts`
- [x] T008 [US1] Красные тесты фронта квиза в `app/src/lib/feature018.test.tsx`; шаг имён, коды, взаимоисключение,
      `PATCH /users/me` до `POST /weddings` в `app/src/pages/Quiz.tsx`, `app/src/lib/api/wedding.ts`

**Проверка фазы:** новая свадьба «Алина ♥ Тимур», у «Классики» в тайминге ЗАГС в 14:00.

## Фаза 4 — US3 «Уже забронировано» (P2)

- [x] T009 [US3] `Slot.prebooked` в `backend/src/deals/repo.ts`; `DELETE …/prebooked` и снятие отметки бронью в
      `backend/src/routes/slots.ts`
- [x] T010 [US3] Состояние `prebooked` в `app/src/lib/types.ts`, `app/src/lib/store.tsx`, `app/src/lib/api/slots.ts`
- [x] T011 [US3] Карточка `app/src/components/PrebookedSlot.tsx`; главная `app/src/pages/Home.tsx`; мозаика, счётчики и экран
      слота в `app/src/pages/Wedding.tsx`; «✓ Есть» в `app/src/pages/Search.tsx`; переводы в `app/src/lib/i18n.en.ts`

## Фаза 5 — полировка

- [x] T012 Карты `Тили-тили_Карта_экранов.md` и `Тили-тили_Карта_кнопок.md` с записью в журнал (R-MAP / R-BTN)
- [x] T013 Обход `e2e/walkthrough/flow-onboard.cjs`: два имени, «Выездная церемония», «Площадка», проверка главной
- [x] T014 `CLAUDE.md` (контракт v0.42.0, 131 путь, 176 операций), `JOURNAL.md`, `tasks/todo.md`, `session-handoff.md`
- [x] T015 `bash init.sh` с базой и Redis, покрытие изменённых строк ≥ 95 %, PR

## Зависимости

- Фаза 2 блокирует всё: без контракта и миграции нет ни типов фронта, ни колонок.
- US1 и US2 независимы между собой; US3 опирается на ту же вставку свадьбы (T006).
- **MVP = фаза 3.** После неё свадьба уже названа и собрана по формату.
