# T005 · загрузка фото по приглашению · 11.11.2026

Локальная ветка `codex/t005-guest-album-upload-20261111` от `24defaa` (PR93). Миграция 100 добавлена поверх схемы 99. Гость выбирает фото и даёт согласие. Сервер фиксирует выдачу за приглашением, проверяет файл и передаёт на модерацию. Для гостя видимы одобренные кадры. Пара может убрать кадр и поставить файл в очередь очистки.

Проверены типы, линт изменённых файлов, сборка, 29 клиентских тестов и 138 различных серверных проверок в двух запусках (137 прошли группой, гонка квоты повторена отдельно). Сквозной Chromium на изолированной PostgreSQL и синтетическом файловом стенде прошёл. Временные процессы, базы и сборка убраны. Протоколы в `C:/Тили-тили/.unlazy/wp01-media-activation-20261106/PLAN.md`.

Следующий шаг для публикации — точный допуск схемы 100 и реальная сохраняющая репетиция 99→100→99→100, включая отказ отката с управляемыми кадрами. Исторические приёмки 83–99 и прежние FAILED сохранить. Сверить PR92/93 и `main` перед интеграцией. В PR92/93 пересекаются только `JOURNAL.md`, `session-handoff.md`, `tasks/todo.md`.

# T005 · удаление кадра из гостевого альбома · 11.11.2026

От `main` d899799. Ветка `codex/t005-album-removal-20261111`. Пара может убрать существующий кадр через подтверждение. API возвращает 204 и проверяет текущую роль, сессию и согласие. Исходник по внешней ссылке остаётся у владельца.

Локально зелёные проверки типов, линт изменённых файлов, 61 тест на изолированной PostgreSQL, 7 клиентских тестов, сборка и Chromium. В браузере помощник видит кадр без кнопки удаления, отмена не отправляет запрос, подтверждение даёт 204, альбом остаётся пустым после перезагрузки. БД, браузер и локальные серверы остановлены, порты 15439, 43103 и 43104 свободны.

Дальше проверить CI опубликованного SHA. Следующий кодовый шаг T005 — загрузка гостем по приглашению. PR92 локального файлового стенда ведётся отдельно. Старые FAILED и аудит сохранены.

# 032-B: управляемое портфолио · 06.11.2026 · PR90, исправление full CI

Base main2b133642 (PR89); ветка codex/wp01-managed-media-20261105, PR https://github.com/bairasbai/tili-tili/pull/90, опубликованный head8e904665. W=C:/Тили-тили/wp01-managed-media-20261105, E=C:/Тили-тили/.unlazy/wp01-managed-media-20261105. Реализация/проверки/commit/push/ordinary merge разрешены без новых подтверждений. Production, старые FAILED/аудит/offline PG и чужая работа неприкосновенны.

M01–M12 реализованы: схема99/durable writers/cleanup, owner/session/consent/rights/nonce/lease fences,5-photo quota, signed POST→ClamD→Sharp→atomic ready, stable profile IDs, safe delivery/export/erase/GC, контракт0.73.0, RU/EN UI. Applied SQL1–98/pins сохранены. Down99 с любой managed metadata/debt (даже done) отказывает доDDL. T005/WP01/17 и реальные provider/Clamengine/device/operator gates OPEN; штатный MEDIA config пуст/default501, production не включён.

Приняты bounded112media/foundation/0skip, DB8 preserving2cycles/10native23514guards/13raw, fullfrontend3210/159/0skip в обеих CI,3browser workflows/38cases, sourcecontract135PASS/3explicitliveSKIP,4canonical generators, types/strictnewtests/lint/build/backendALL audit0. Собственный compiled-browserfeature13 observations и3raw YAML сохранены; tab/storage/worker/cache закрыты. Независимые SOURCE/targeted/frontend/native49/browser reviews — REVIEW.md. FEunit stderr store missing записан отдельно; его test-only причина строго не доказана, consoleclean всему frontend не объявлять.

CI история: headde278142 C05 beforeAll ожидал98 вместо99 (19skipped/0semanticfail); head89938a9 inverse candidate hash отказал доDBcreation; оба original FAILED packets в E/tmp сохраняются. Исправленная связка assertion+inverse ledger source guards прошла376/7files/0skip и оба current isolated native30+19/0skip/audit2/schema99zero-domain. Immutable originals восстановлены, guards не ослаблены.

Полный PR CI head8e904665/run42117747236 завершился4914=4882PASS+32FAIL/0skip/199files. Actual mediaManagedApi39PASS и Linux backpressure8queued/ninth503 есть; preserving/backendlint/build UNRUN. Raw original log: E/runs/github-ci90-third-backend-log-fcd12aa4-52f5-45d9-beb2-63c15742e90a/stdout.log; diagnosticZIP13462371919, full32index CI90-THIRD-FAILURES.json. Новый exact-head fullCI обязателен.

Текущая поправка только13 tests:12current table-frame asserts127→129 с обеими media таблицами (historical97/98count127 неизменен), audit14 OR/empty/global security+8regressioncases с прежним private allowlist, stage3 missingkey400→validkey501. Runtime/SQL/UI побайтово прежние. Независимый SOURCE GO freeze-v6 есть. После него изменены только эти checkpoint docs; новый source freeze связывает текущий состав с проверками.

Local первая попытка PG9:108PASS/0failedAssertions/407UNRUN,6files beforeAll отказали15432!==default55432 из-за пропущенного TILI_DISPOSABLE_PG_PORT. Это runnerSETUP, не businessRED и не wholeGO. BOUND1322 before/after совпал. PG9 exact systemID/PID/birth/command/nopeer проверены, штатный stop0 и6ownedprocessesended/15432free; DB сохраненаoffline. Первичная ошибка reader UTF8/native CP1251 PGDATA также отмечена diagnostic-only, исправлена rawhex+строгимnative decode безDDL/domainWrites.

Для повтора зарегистрирована НОВАЯ own PG10 E/services/pg-ci90-schema99-fix10-20261106, loopback15432/rolecodex_test/DBtili_ecosystem_full_20260930_test, равныеURLs и explicitTILI_DISPOSABLE_PG_PORT15432. Запускать11допущенных files;2Calendar/8failedcases остаются обязательномуLinuxCI без spoofing/сменыfixtureguards. PG10 lifecycle — PG10-RESOURCE/STOPPED.json в E; после native остановить только его, сохранитьoffline. Старые8DB в E/services/pg и PG9 не запускать/не менять. Общие5432/6379/чужиеW/MCP не трогать.

Дальше: завершить source-bound local11 и независимую ACTUAL, проверить diff/lint/source contract, commit/push в тот жеPR90, новые обеCI/fullbackend0skip/native49/audit2/schema99/Linuxbackpressure/fullpreserving13raw и3browser → independentFINAL GO → freshmain/expectedhead ordinarymerge/treecheck → E/FINAL-REPORT.md/PUBLICATION.json и корневойHANDOFF → собственнуюW/deps/build/cache/helpers/previews убрать, mandatoryFAILED/audit/native/PGoffline сохранить. GitHub строго по одному, guard перед каждым запросом, polling≥2–3мин(предпочтительно реже),403/429/rate/auth означаетstop. Глобальный checkpoint E/CONTINUE-CURRENT.md, без дополнительных агентов/подтверждений; один read-only reviewer /root/wp01_media_review.
