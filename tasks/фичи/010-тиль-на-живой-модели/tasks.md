# Задачи: Тиль на живой модели

**Спека:** ./spec.md · **План:** ./plan.md (одобрен 2026-09-12, В1–В4) · **Статус:** все задачи закрыты 2026-09-12
**Формат:** `- [ ] T001 [P] [US1] описание в путь/к/файлу`

Пути — от `Тили-тили/`. Каждая задача с кодом — с регрессионным тестом, красным без фикса. Коммит — явными путями.

## Фаза 1 — миграция и контракт

- [x] T001 `backend/migrations/1760200000000_tilly_usage.cjs` — таблица учёта вызовов; `down`/`up` проверены. Коммит `7d8a70e`.
- [x] T002 Контракт v0.33.0: `Chat.tilly`, 429 `tilly_daily_limit` у `POST /chats/{chatId}/messages`, `AdminMetrics.llm`; четыре генератора.

## Фаза 2 — бэкенд (US1, US2, US3)

- [x] T003 [US3] `backend/src/config.ts`, `.env.example`: `TILLY_PROVIDER|BASE_URL|API_KEY|MODEL|DAILY_LIMIT|TIMEOUT_MS|MAX_TOKENS|TEMPERATURE`
      с умолчаниями по провайдеру и `ConfigError` при неполной настройке.
- [x] T004 [US1] `backend/src/tilly/model.ts` — `TillyModel`, `OpenAiCompatibleModel` (OpenRouter / Ollama / любой совместимый), `createTillyModel`;
      тест `backend/test/tilly-client.test.ts` против локального HTTP-сервера.
- [x] T005 [US1] `backend/src/tilly/context.ts`, `prompt.ts` — контекст свадьбы без PII, системная подсказка.
- [x] T006 [US1] [US2] [US3] `backend/src/tilly/service.ts` — квота, фоновый ответ («печатает», реплика, учёт, честный отказ), `settle()`.
- [x] T007 `backend/src/routes/chats.ts`, `admin.ts`, `app.ts` — 429 по квоте, `Chat.tilly`, `AdminMetrics.llm`, `app.tilly`, подмена модели в `buildApp`.
- [x] T008 `backend/test/audit39.test.ts` — ответ модели, PII, заглушка, отказ, лимит, учёт, метрики (5, все красные на HEAD `chats.ts`); `tilly-client.test.ts` (6). Коммит `a88d15e`.

## Фаза 3 — фронт (US2, US3)

- [x] T009 [US3] `app/src/pages/Us.tsx` (`Chat`): «сегодня N из 50» и «без ИИ» у чата Тиля — по `Chat.tilly`.
- [x] T010 [US3] `app/src/pages/Admin.tsx`: карточка LLM из `AdminMetrics.llm`.
- [x] T011 Словарь (6 ключей), `audit37.test.tsx` (6, 4 красных на HEAD); после отправки счётчик перечитывается с сервера. Коммит `5b15dac` + хвост.

## Фаза 4 — сверка и записи

- [x] T012 Прогоны: бэкенд 74 · 840 | 10, фронт 47 · 748, tsc/eslint 0, сборка чистая, `init.sh` exit 0; живая проверка без провайдера: «сегодня 0 из 50 · без ИИ», заглушка по живому каналу, «сегодня 2 из 50», карточка модели в панели; `backend/README.md` «Тиль: провайдеры».
- [x] T013 Карты (`feature-010`), JOURNAL, todo, handoff, `RELEASE-BLOCKERS.md` (№27 новый, №23 частично, №22 — 33 миграции), `BACKEND-PLAN.md`, CLAUDE.md (v0.33.0), ERR-0252 (хук и `sed -i`).
