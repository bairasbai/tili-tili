# Задачи: Тиль на живой модели

**Спека:** ./spec.md · **План:** ./plan.md (одобрен 2026-09-12, В1–В4)
**Формат:** `- [ ] T001 [P] [US1] описание в путь/к/файлу`

Пути — от `Тили-тили/`. Каждая задача с кодом — с регрессионным тестом, красным без фикса. Коммит — явными путями.

## Фаза 1 — миграция и контракт

- [ ] T001 `backend/migrations/1760200000000_tilly_usage.cjs` — таблица учёта вызовов; `down`/`up` проверены.
- [ ] T002 Контракт v0.33.0: `Chat.tilly`, 429 `tilly_daily_limit` у `POST /chats/{chatId}/messages`, `AdminMetrics.llm`; четыре генератора.

## Фаза 2 — бэкенд (US1, US2, US3)

- [ ] T003 [US3] `backend/src/config.ts`, `.env.example`: `TILLY_PROVIDER|BASE_URL|API_KEY|MODEL|DAILY_LIMIT|TIMEOUT_MS|MAX_TOKENS|TEMPERATURE`
      с умолчаниями по провайдеру и `ConfigError` при неполной настройке.
- [ ] T004 [US1] `backend/src/tilly/model.ts` — `TillyModel`, `OpenAiCompatibleModel` (OpenRouter / Ollama / любой совместимый), `createTillyModel`;
      тест `backend/test/tilly-client.test.ts` против локального HTTP-сервера.
- [ ] T005 [US1] `backend/src/tilly/context.ts`, `prompt.ts` — контекст свадьбы без PII, системная подсказка.
- [ ] T006 [US1] [US2] [US3] `backend/src/tilly/service.ts` — квота, фоновый ответ («печатает», реплика, учёт, честный отказ), `settle()`.
- [ ] T007 `backend/src/routes/chats.ts`, `admin.ts`, `app.ts` — 429 по квоте, `Chat.tilly`, `AdminMetrics.llm`, `app.tilly`, подмена модели в `buildApp`.
- [ ] T008 `backend/test/audit39.test.ts` — ответ модели, PII, заглушка, отказ, лимит, учёт, метрики (красные до фикса).

## Фаза 3 — фронт (US2, US3)

- [ ] T009 [US3] `app/src/pages/Us.tsx` (`Chat`): «сегодня N из 50» и «без ИИ» у чата Тиля — по `Chat.tilly`.
- [ ] T010 [US3] `app/src/pages/Admin.tsx`: карточка LLM из `AdminMetrics.llm`.
- [ ] T011 Словарь, `app/src/lib/audit37.test.tsx`, смежные тесты.

## Фаза 4 — сверка и записи

- [ ] T012 Полные прогоны, `init.sh`, живая проверка без провайдера (заглушка, счётчик); инструкция владельцу в `backend/README.md`.
- [ ] T013 Карты (`feature-010`), JOURNAL, todo, handoff, `RELEASE-BLOCKERS.md` (№27, №23), `BACKEND-PLAN.md`, CLAUDE.md, ERRORS при находках.
