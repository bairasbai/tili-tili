# Задачи: Ответы квиза влияют на свадьбу

**Спека:** ./spec.md · **План:** ./plan.md
**Формат:** `- [ ] T001 [P] [US1] описание в путь/к/файлу` · `[P]` — можно параллельно · `[US1]` — к какой истории

Пути — от `Тили-тили/`. Каждая задача с кодом — с тестом, красным до правки. Бэкенд — на живой базе (`TEST_DATABASE_URL`).

## Фаза 1 — подготовка

- [x] T001 Спека, план, задачи в `tasks/фичи/018-квиз-влияет/`

## Фаза 2 — основа (блокирует все истории)

- [x] T002 Красные тесты бэка на живой базе в `backend/test/quizAnswers.test.ts`: формат → слоты и тайминг; planner → слот;
      prebooked → флаги и выполненные задачи; неверный код → 422; `DELETE …/prebooked` 204/204/403/404; бронь и свой
      подрядчик снимают отметку; перенос двигает второй день; «Имя ♥ Партнёр» после `PATCH /users/me`
- [x] T003 Контракт v0.42.0 в `Тили-тили_API_openapi.yaml`; `gen-contract`, `gen-schemas`, `gen:types`, копия в
      `app/src/lib/api/schema.ts`; сторож версии `backend/test/audit55.test.ts`
- [x] T004 Миграция `backend/migrations/1761300000000_quiz_answers_matter.cjs` (с `down`)

## Фаза 3 — US1 имена + US2 формат и «кто планирует» (P1) 🎯 MVP

- [x] T005 [US2] Шаблоны по формату и «кто планирует», `dayOffset`, `categoryId` задач в `backend/src/wedding/templates.ts`
- [x] T006 [US2] Поля тела, вставки в транзакции, `format`/`planner` в ответе в `backend/src/routes/weddings.ts`
- [x] T007 [US2] Первая дата по шаблону формата, второй день в `backend/src/wedding/reschedule.ts`
- [x] T008 [US1] Красные тесты фронта квиза в `app/src/lib/quizAnswers.test.tsx`; шаг имён, коды, взаимоисключение,
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

## Фаза 6 — Тиль (решение владельца после первого ревью, «почини Тиль», 2026-09-26)

- [x] T016 Красные тесты Т9 (подсказки §3.14: отметка не открыта, карта блоков всех форматов, слоты выездной церемонии,
      «Ужин» на площадке) и Т10 (контекст называет отметку) в `backend/test/quizAnswers.test.ts`; `audit47` Т1 сверяет
      ключи карты с шаблонами всех форматов
- [x] T017 [US3] Отметка не открыта и карта блоков в `backend/src/wedding/tips.ts`; строка отметки в
      `backend/src/tilly/context.ts`; описание `GET …/tips` и `Slot.prebooked` в контракте (v0.42.0 — версия этого же PR),
      перегенерация
- [x] T018 `bash init.sh` с базой и Redis, покрытие изменённых строк ≥ 95 %, живой обход, пуш

## Фаза 7 — ревью PR (независимый ревьюер, 2026-09-26: блокеров нет, находки D-01…D-12)

- [x] T019 Красные тесты фронта: К3 «вариант выбрали, а потом «Пропустить вопрос»» (D-03), П2 — подсказки перечитаны
      после «Нет, ещё ищем» (D-09), EN — заголовок экрана слота с отметкой (D-06), П3 — помощник и координатор (D-11)
      в `app/src/lib/quizAnswers.test.tsx`, `app/src/lib/quizAnswers.en.test.tsx`
- [x] T020 `skip` в `app/src/pages/Quiz.tsx`; `prebookedKey` подсказок в `app/src/pages/Home.tsx` и
      `app/src/pages/Wedding.tsx`; `t(s.label)` в `SlotView`; тест Т9 «старая свадьба со слотом церемонии» в
      `backend/test/quizAnswers.test.ts`; обоснование «Ужина» в `backend/src/wedding/tips.ts`; процедура порядка миграций
      с веткой 017 в комментарии `backend/migrations/1761300000000_quiz_answers_matter.cjs` (D-12)
- [x] T021 Карты экранов и кнопок (журналы), `ERRORS.md` (ERR-0311), спека (допущения, FR-018, вопросы владельцу),
      план Р6, `JOURNAL.md`, `tasks/todo.md` (D-02, D-05, D-07, D-08 — задачами), `session-handoff.md`
- [x] T023 Взаимная блокировка брони слота, найденная прогоном с покрытием (ERR-0312): `lockFreeSlot` в обеих дверях
      `backend/src/routes/slots.ts`, тест `backend/test/audit4.test.ts` с заданным чередованием, поправка `BACKEND-PLAN.md`
- [x] T022 `bash init.sh` с базой и Redis, покрытие изменённых строк, пуш, CI

## Зависимости

- Фаза 2 блокирует всё: без контракта и миграции нет ни типов фронта, ни колонок.
- US1 и US2 независимы между собой; US3 опирается на ту же вставку свадьбы (T006).
- **MVP = фаза 3.** После неё свадьба уже названа и собрана по формату.
