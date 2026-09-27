# Выкладка — чеклист первого и каждого следующего выпуска

> Фича 014 (2026-09-13), блокеры №19–№22. Документ для того, кто выкладывает:
> что и в каком порядке включить, чем проверить. Почему так устроено —
> `BACKEND-PLAN.md`, что делать при аварии — `RUNBOOK.md`, чего ещё нет —
> `RELEASE-BLOCKERS.md`.

Состав в проде — `deploy/docker-compose.prod.yml`: `web` (nginx: статика PWA,
SPA-fallback, прокси `/api` → бэкенд, `deploy/nginx.conf`), `api` (Fastify,
`backend/Dockerfile`), `redis`. PostgreSQL — управляемая БД Timeweb; профиль
`localdb` поднимает свою только как запасной вариант. Один origin на всё:
фронт собирается без `VITE_API_URL` и ходит на `/api` того же домена — CORS не
нужен, `CORS_ORIGINS` ставится в сам домен на всякий случай.

---

## 0. Что нужно до начала

| Что | Зачем | Где |
|---|---|---|
| VPS Timeweb (площадка РФ), Docker 24+ с compose v2 | всё крутится в контейнерах | `RUNBOOK.md` §0 — записать локацию |
| Управляемая PostgreSQL 16 (РФ) | данные; строка `DATABASE_URL` | панель Timeweb |
| Домен `tili-tili.ru` → VPS, TLS | без TLS не работают Web Push и `wss://` | балансировщик Timeweb или certbot на хосте |
| **Node 22 LTS** на машине сборки, если собирать вне Docker | Node 25 ломает npm (`Exit handler never called`, ERR-0006) | `.nvmrc` в корне; в образах — `node:22-alpine` |
| Ключи внешних служб | без них соответствующие пути честно отвечают 501 | `RELEASE-BLOCKERS.md` №1–№4, №27 |

## 1. Переменные окружения — порядок включения

Файл — `Тили-тили/backend/.env` (из `.env.example`; в репозиторий не попадает,
в контейнер `api` приходит через `env_file`). В production сервер **не стартует**
без блока «обязательно» — и это намеренно (`backend/src/config.ts`).

| Шаг | Переменные | Без них |
|---|---|---|
| **обязательно** | `NODE_ENV=production`, `DATABASE_URL`, `REDIS_URL` (в compose задан), `JWT_ACCESS_SECRET` и `JWT_REFRESH_SECRET` (разные, ≥32 знаков: `openssl rand -base64 48`), `CORS_ORIGINS=https://tili-tili.ru`, `POLICY_VERSION` (дата редакции оферты — блокер №5), `TRUST_PROXY` (1 — только nginx состава; 2 — за балансировщиком Timeweb) | сервер не поднимается и говорит, чего не хватает |
| **вход** | `SMS_PROVIDER=smsaero`, `SMSAERO_EMAIL`, `SMSAERO_KEY`, `SMSAERO_SIGN` (блокер №1) | в production сервер не стартует: код входа некому отправить |
| файлы | `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` (блокер №3) | загрузка фото, документов верификации и альбома отвечает 501 `storage_not_configured`, экраны говорят это словами |
| push | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`backend/scripts/gen-vapid.mjs`, блокер №4) + тот же публичный ключ в сборку фронта (`VITE_VAPID_PUBLIC_KEY` — аргумент `web` в compose) | подписка отвечает 501 `push_not_configured`; уведомления видны в приложении |
| Тиль | `TILLY_PROVIDER=openrouter` + `TILLY_API_KEY`, или `ollama` на сервере (блокер №27; `backend/README.md` «Тиль: провайдеры») | Тиль честно отвечает «пока без ИИ» |
| наблюдение | `SENTRY_DSN` (блокер №14) | ошибки только в логе контейнера |
| пределы | `OTP_*`, `RATE_LIMIT_PER_SECOND`, `RATE_LIMIT_WINDOW_SECONDS` (окно, по умолчанию 10 с), `ALBUM_MAX_PER_GUEST`, `CONTRIBUTIONS_MAX_PER_GUEST`, `RESERVATIONS_MAX_PER_GUEST`, `COLD_OUTREACH_PER_DAY`, `WEDDING_ARCHIVE_DAYS` | значения по умолчанию из `.env.example` — менять только осознанно |

Redis включается вместе с составом и обязателен в production: без него нет
ограничителя запросов, фоновых задач (push, уборка архива и удалённых
аккаунтов, дайджесты, напоминания о брони) и живого канала между процессами.

Команды миграций ниже читают `node-pg-migrate` из `node_modules`: `npm install`/`npm ci`
в `backend` ломаются на этой связке (Node 25, ERR-0006, §0) — сначала
`corepack pnpm install --node-linker=hoisted` в `Тили-тили/backend` (`CLAUDE.md` §3).

## 2. База: миграции

```bash
cd Тили-тили/backend
# репетиция с нуля в чистой схеме той же базы — все 39 миграций, 64 таблицы, 35 категорий, проверки CHECK «проверены»
npm run migrate:fresh
# боевая схема
npm run migrate up
```

`migrate:fresh` создаёт схему `tili_fresh`, прогоняет в ней всё с нуля и
удаляет её — боевая `public` не трогается. Любая упавшая миграция — ненулевой
код, выкладка останавливается. Откат одной миграции: `npm run migrate down`.

## 3. Домен и TLS

TLS снимается **до** nginx состава: балансировщик Timeweb с сертификатом или
certbot на хосте, который проксирует 443 → `WEB_PORT` (по умолчанию 80). За
балансировщиком `TRUST_PROXY=2` (nginx + балансировщик), иначе ограничитель по
адресу видит один адрес на всех и режет всех разом.

## 4. Запуск

```bash
cd deploy
cp ../Тили-тили/backend/.env.example ../Тили-тили/backend/.env   # если ещё нет — заполнить по §1
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps                     # api — healthy (иначе см. логи)
docker compose -f docker-compose.prod.yml logs api --tail=50
```

`api` считается живым по `/health/ready` — 503, пока база или Redis
недоступны, и `web` не поднимается раньше него.

## 5. Проверка после выкладки (10 минут)

| # | Что | Ожидание |
|---|---|---|
| 1 | `curl -s https://tili-tili.ru/api/health` | `{"status":"ok",…}` |
| 2 | `curl -s -o /dev/null -w '%{http_code}' https://tili-tili.ru/api/health/ready` | `200` (`503` — база или Redis) |
| 3 | Прямой заход `https://tili-tili.ru/wedding/guests` в чистом браузере (блокер №19) | открывается приложение на этом адресе, не 404 хостинга |
| 4 | `curl -sI https://tili-tili.ru/assets/` любого файла из `index.html` | `Cache-Control: … immutable`; `curl -sI …/sw.js` → `no-cache` |
| 5 | `curl -sI https://tili-tili.ru/` | `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` — тот же набор на `/assets/…`, `/sw.js`, `/manifest.webmanifest` (ERR-0283: каждый static location несёт их сам, nginx не наследует `add_header` частично) |
| 6 | Вход по SMS с настоящего номера | код приходит; в логе `api` нет кода (он есть только без провайдера) |
| 7 | Чат: открыть переписку на двух устройствах, написать | реплика приходит без перезагрузки (WebSocket через `/api/chats/{id}/ws`; при обрыве — опрос) |
| 8 | Панель `/admin` сотрудником (`users.is_staff = true` руками в базе для первого сотрудника) | дашборд показывает показатели, не нули (R-178) |
| 9 | `RUNBOOK.md` §0 | заполнить локации ресурсов из панели Timeweb с датой |

## 6. Резервные копии и восстановление

`backend/scripts/backup.sh` — дамп базы в `BACKUP_DIR` (30 дней);
`backend/scripts/restore-drill.sh` — репетиция восстановления во временную базу.
Первую репетицию сделать до выпуска, дальше — раз в квартал (`RUNBOOK.md` §4).

## 7. Обновление

```bash
git pull
cd Тили-тили/backend && npm run migrate up && cd ../../deploy
docker compose -f docker-compose.prod.yml up -d --build
```

Миграции — до пересборки `api`: новый код ждёт новую схему, а не наоборот
(все миграции пишутся совместимыми с предыдущей версией кода на время выката).
Откат — `git checkout <прежний тег>` и та же команда; миграцию откатывать
`migrate down` только если она несовместима со старым кодом.

## 8. Чего здесь нет

Сборка вне Docker (`init.sh` в корне — определение «готово» для разработки),
мониторинг и алерты (Sentry — блокер №14; метрики хоста — панель Timeweb),
CI. Всё это — после первого выпуска.
