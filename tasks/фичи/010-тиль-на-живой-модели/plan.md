# План: Тиль на живой модели

**Спека:** `spec.md` · **Заведён:** 2026-09-12 · **Статус:** одобрен 2026-09-12 (В1–В4), в работе

## Затрагивается

Миграция `1760200000000_tilly_usage.cjs` (таблица учёта). Контракт v0.33.0: `Chat.tilly`, 429 у `POST /chats/{chatId}/messages`,
`AdminMetrics.llm`. Бэкенд: новый модуль `src/tilly/` (`model.ts` — интерфейс и OpenAI-совместимый клиент, `context.ts` — сбор
данных свадьбы без PII, `prompt.ts` — системная подсказка, `service.ts` — лимит, вызов, запись ответа и учёта, «печатает»),
`config.ts` (+ `TILLY_*`), `.env.example`, `routes/chats.ts` (ветка `tilly` → сервис; `Chat.tilly` в списке), `routes/admin.ts`
(`llm` в метриках), `app.ts` (`app.tilly`), `README.md`. Тесты `audit39.test.ts` (сервис с подставной моделью, лимит, учёт,
метрики), `tilly-client.test.ts` (протокол против локального HTTP-сервера). Фронт: `pages/Us.tsx` (`Chat` — шапка чата Тиля:
«сегодня N из 50», «без ИИ»), `pages/Admin.tsx` (карточка LLM), `lib/i18n.en.ts`, тест `audit37.test.tsx`; карты.

## Ворота инвариантов

| инвариант | как держим |
|---|---|
| §5 п. 15 не обещать за код | без провайдера — прежняя заглушка словами; отказ провайдера — «временно без ИИ»; ответ модели никогда не подписывается как факт системы |
| §5 п. 13 ноль ≠ неизвестно | «сегодня N из 50» и `live` — только из `GET /chats`; метрики LLM — из `tilly_usage`, не из «нуля по умолчанию» |
| §5 п. 11 инварианты в базе | лимит — счёт реплик по `messages` за сутки (один источник правды), учёт — строка на вызов с FK на свадьбу и чат |
| §5 п. 9 контракт — правда | v0.33.0 одним коммитом с генераторами; `audit14`/`prod5` зелёные |
| §5 п. 16 секреты — в окружении | `TILLY_API_KEY` только из `.env`; в лог не пишется; `.env.example` без значений |
| Приватность (План §18) | контекст собирается отдельным модулем из явных полей; тест утверждает: ни одного телефона/e-mail в запросе к модели |
| STOP-условия | зависимости нет (`fetch`); миграция — одобрена В3 |

## Фазы

### Фаза 1 — миграция и контракт (~30 мин)
`tilly_usage(id uuid pk, wedding_id uuid fk weddings on delete cascade, chat_id uuid fk chats on delete cascade, message_id uuid
fk messages on delete set null, provider text not null, model text not null, input_tokens int not null default 0, output_tokens
int not null default 0, latency_ms int not null, outcome text not null check in (answered, failed, stub), created_at timestamptz
default now())`, индекс `(created_at)`; `down` — drop. Контракт v0.33.0: `Chat.tilly { live, usedToday, limitPerDay }` (только у
`kind=tilly`), `POST /chats/{chatId}/messages` → 429 (`tilly_daily_limit`), `AdminMetrics.llm { since, calls, answered,
inputTokens, outputTokens }` (последние 30 дней); генераторы (4).

### Фаза 2 — бэкенд (~3 часа)
1. `config.ts`: `tilly: { provider: 'openrouter'|'ollama'|'openai'|null, baseUrl, apiKey, models: string[], dailyLimit, timeoutMs,
   maxTokens, temperature }` из `TILLY_*` с умолчаниями по провайдеру; `ConfigError` при `openrouter` без ключа, `openai` без
   адреса/модели. `.env.example` — блок с комментариями (OpenRouter, Ollama + `hermes3`, любой OpenAI-совместимый).
2. `tilly/model.ts`: `interface TillyModel { kind; model; complete(req): Promise<TillyReply> }`; `OpenAiCompatibleModel(fetch)`:
   `POST {baseUrl}/chat/completions` `{ model, models? (OpenRouter, ≥2), messages: [system, …history, user], max_tokens,
   temperature }`, заголовки `Authorization: Bearer`, для OpenRouter `HTTP-Referer: https://tili-tili.ru`, `X-Title: Тили-тили`;
   таймаут `AbortSignal.timeout`; один повтор через 2 с при 429/5xx; ответ → `choices[0].message.content` (пустой → ошибка),
   `usage.prompt_tokens/completion_tokens`, `finish_reason`. `createTillyModel(config, log)` → модель или `null` (заглушка).
3. `tilly/context.ts`: `weddingContext(db, weddingId)` → текст разделами: свадьба (дата, дней до, город, стиль, формат, гостей
   планируется, бюджет итого), гости (всего, приду/не приду/без ответа, с +1 — числа и имена без телефонов), бюджет по категориям
   (лимит/потрачено), слоты (категория → состояние: пусто / кандидат / забронирован «имя подрядчика», цена сделки — это цена
   пары, не анкеты), задачи (не сделанные со сроком, просроченные — отмечены), тайминг (блоки), план Б (есть/нет). Ни телефонов,
   ни e-mail, ни комментариев гостей, ни текстов документов.
4. `tilly/prompt.ts`: системная подсказка — персонаж и границы (План §8.9): цены — только из анкет, юридика — шаблон +
   дисклеймер, данные не менять, коротко и по делу, язык вопроса, «координатор — человек, SOS к нему»; дата «сегодня».
5. `tilly/service.ts`: `TillyService(app, model|null, config)`: `quota(weddingId, tz)` → `{ used, limit }` (реплики
   `sender_id is not null` в чате `tilly` за сутки по поясу); `answer({ chatId, weddingId, userId, text })` — фон: `typing` от
   актора `tilly` каждые 3 с; без модели — заглушка (`outcome=stub`, без вызова); с моделью — контекст + история (20, без
   заглушек/отказов) → `complete` → реплика Тиля в `messages` (`sender_id null`) → `tilly_usage` → `publish message`; ошибка →
   текст «Тиль временно без ИИ — загляните в задачи и поиск, а вопрос я сохранил» + `outcome=failed` + лог. `settle()` — ждать
   все фоновые ответы (тесты, `onClose`).
6. `routes/chats.ts`: перед сохранением реплики в `tilly` — `quota` ≥ лимит → 429 `tilly_daily_limit`; после 201 — `service.answer`
   (не ждать); в `GET /chats` у `kind=tilly` — `tilly: { live, usedToday, limitPerDay }`. `routes/admin.ts`: `llm` из `tilly_usage`.
   `app.ts`: `app.decorate('tilly', …)`, `buildApp` принимает `tillyModel` для подмены в тестах.
7. Тесты: `audit39` — (а) с подставной моделью ответ Тиля = текст модели, две реплики, `usage` строка `answered`, запрос к
   модели содержит слот/задачу/бюджет и не содержит телефон гостя; (б) без модели — заглушка и `outcome=stub`; (в) модель бросает
   → «временно без ИИ», `failed`; (г) лимит 3 (override) → 4-я реплика 429, `Chat.tilly.usedToday=3`; (д) `AdminMetrics.llm`
   считает строки; `tilly-client` — локальный `http.createServer`: тело, заголовки, `models[]`, повтор при 429, таймаут.

### Фаза 3 — фронт (~1,5 часа)
`Chat` (Us.tsx): у чата `kind=tilly` под заголовком — «сегодня N из 50» (по `Chat.tilly`), при `live=false` — «без ИИ — ответы
появятся, когда помощник заработает»; 429 — текст сервера (уже так). `Admin.tsx`: карточка «Тиль (LLM), 30 дней: вызовов N ·
ответов M · токенов K/L» — только по ответу, при отсутствии `llm` — прочерк. Словарь; `audit37.test.tsx`; карты (`feature-010`).

### Фаза 4 — сверка и записи (~40 мин)
Полные прогоны, `init.sh`, живая проверка (без провайдера: заглушка и счётчик; с провайдером — у владельца, инструкция в README),
карты, JOURNAL, todo, handoff, `RELEASE-BLOCKERS.md` (№27 ключ/локальная модель; №23 частично), `BACKEND-PLAN.md` (схема),
CLAUDE.md (контракт), ERRORS при находках.

## Решения

| № | вопрос | решение |
|---|---|---|
| В1 | Провайдер и зависимость | **OpenRouter** через OpenAI-совместимый протокол (`fetch`, без зависимости); та же дверь для локальной модели (Ollama / Hermes / любой совместимый сервер) |
| В2 | Модель по умолчанию | владелец: «смотреть другие варианты» → `openrouter/free` (маршрутизатор бесплатных); Ollama — `hermes3`; меняется `TILLY_MODEL` |
| В3 | Учёт токенов | таблица `tilly_usage` + миграция |
| В4 | Лимит и счётчик | 50/сутки на свадьбу, `Chat.tilly` со счётчиком в шапке |

## Открытые технические вопросы

- Бесплатный маршрутизатор OpenRouter может отдавать модель с «рассуждениями» (`reasoning`) — берём только `message.content`.
- Повтор при 429 провайдера — один и через 2 с: бесплатный предел 20/мин; больше повторов — очередь (Redis, №2).
- Локальная модель на сервере — инфраструктура владельца (RAM/GPU); README описывает `ollama pull hermes3` и переменные.
