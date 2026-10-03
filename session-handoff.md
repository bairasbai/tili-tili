# Точка передачи · Codex, 2026-10-03

## Действующее поручение

Полный /goal WP00–WP16 активен. Пользователь поручил продолжить Claude, реализовать весь объём end-to-end, проверять сценарии, обновлять документы после этапов, делать отдельные feature-коммиты, push и merge в main, распределять задачи агентам. Старое поручение остановиться после узкой поставки заменено этим поручением. Production требует отдельной авторизации.

GitHub: перед работой `node C:/Users/Bayra/.claude/hooks/github-api-guard.js --status`. Запросы строго последовательны. CI читать не чаще раза в 2–3 минуты; без watch. При 403/429/rate limit/abuse/Bad credentials остановиться и сообщить владельцу.

## Репозитории и опубликованный оркестратор

Рабочий clone: C:/Тили-тили/ecosystem-local-20260930, ветка `codex/030-380-inventory-completion`, создана из актуального Claude `de414fa`. Исходный checkout C:/Тили-тили/Тили-тили_код_и_документация на `bde3e40` сохранён. Последний fetch: Claude всё ещё `de414fa`, main `a18695b5f8f8849029d0112c2abc606c9c94ba9e`. Inventory-ветка пока не интегрировала main35. PR32 Claude остаётся draft/open; новый inventory PR ещё не создан.

Собственный skill `tili-orchestrate` основан на harnessmachine/codex-orchestrate@`e44c06e5738a5ea9007ff01ab894df97e89217e8`, MIT LICENSE сохранена. Пять файлов установлены в C:/Users/Bayra/.codex/skills/tili-orchestrate, при установке сверены SHA256. Source/test agents и свежий reviewer выполнили реальную offline fixture; root повторил106 тестов без пропусков. DB/browser/delivery этой fixture не покрыты.

Пакет `.agents/skills/tili-orchestrate` опубликован отдельным коммитом `635c9f6`: [PR35](https://github.com/bairasbai/tili-tili/pull/35), семь проверок SUCCESS, merge `a18695b`. Изолированный Git worktree C:/Тили-тили/tili-orchestrate-publish-20261003. App create_worktree не смог определить репозиторий в cwd, поэтому использован обычный Git worktree. Global discovery установленного skill проверить в новом диалоге.

## Текущая поставка 380+381

Принятая граница StageA/D2: inventory/domain read/capture, все DTO unresolved. HTTP/OpenAPI/UI, конечные интервалы, согласия, adoption и освобождение booking boundary относятся к следующим371–374. Код `legacy-source.ts` реализован Claude и проверен root.

Подтверждённые исправления380: ancestry до head0 return; полнота holders каждой версии; SQL NULL origin refusal; raw wedding/manual cascade deadlock40P01; fixture cleanup сохраняет UUID удалённых пользователей. После native fullDB наката380 заморожена:
`7b8257fb62e3ac8490a06aa15cb721f88a438a44d84d65df0c6296fba3ca1c33`.

Позднее reviewer обнаружил repoint D1(W1)→D2(W2), после DELETE W1 живой день терял app_day. Forward381 создаёт новый W2 source/head rev0 без переноса старых bytes/consent; early company union охватывает retained days. Чужая свадьба закрепляется KEY SHARE NOWAIT:55P03 откатывает всю операцию. Backfill только добавляет missing sources/heads. Накат требует остановленных писателей.381 заморожена:
`f0c96680c13c6bc4fe7ea4a0434c4c7bd6c3670b818e2e5583981becc23cf9c6`.
Все возможные deadlock/online DDL этим не доказаны.

## Проверенная локальная приёмка

- Targeted381:68 inventory +6 audit53 =74 passed. Новые meaningful red до381:3 failed/71 passed. Логи `vitest-codex381-{before-recovery-pinned,after-recovery}.log`.
- Native381 upgrade inventory/full сохранил прежние строки102 таблиц. Evidence `.unlazy/codex-inventory-20261003/{inventory381,full381}-{before,after}.json`.380 ранее сохранила98 старых таблиц. Wx migration scripts не повторять.
- Final fresh drill20:24 собственных миграции through381;128 SQL =12+9+23+7+17+30+12+18 отказов;19 CLI =16+1+1+1. Actual mixed manual/cascade в обоих порядках наблюдали pg_blocking_pids; обе транзакции commit. Populated370→380→381, gap recovery, repeat/no-op, empty down/up, exact populated-down refusal прошли.
- Drill script SHA `59136f3fa4588f1841958d00bd858cf2d1e97fa620c8bf6e93323b9ef15132fd`; migration manifest SHA `0191bc4b55322171737280c8c402b287171a66283ea5f6d2b6e87f42d8786117`. Источник `drill-codex381-drill20.log`.
- Test-only vendorStaff actor исправляет случайный phone conflict атомарным INSERT ON CONFLICT retry до8 попыток; security assertions неизменны. Single-file62/62, `vitest-codex381-staff-fixture.log`.
- Финальный полный init.sh завершился: фронт112 файлов/2105 тестов, бэкенд146 файлов/3135 тестов, без пропусков. Типы, линт всего дерева и обе сборки прошли; exit0, `TZ_FULL_PASSED tag=codex381-final`, `full-codex381-final.log`.
- Все680 source/config/test/migration файлов совпали с manifest до полного прогона.
- Read-only oracles `verify-evidence.mjs targeted|drill|full` прошли и сверили текущие hashes с наблюдёнными логами. Generated contract не имеет содержательных изменений; повтор штатного gensync прошёл.

Правильный SHA before-full manifest: `1884fcef05806fe203a5dec219f6f772c9c15faaead842973c9bec9d3e43475a`. Сам JSON: `.unlazy/codex-inventory-20261003/codex381-final-source.json`.

Неуспехи сохранены: full380 UNKNOWN read stage4 (причину I/O я не могу подтвердить; одиночный повтор25/25); full381 users_phone_key в fixture до security assertion (после узкого исправления финальный full прошёл); drill19 SQL42601 alias day (исправлен на day_id, новый fresh20 прошёл). Они не считаются успешной приёмкой.

Логи: C:/Тили-тили/.unlazy/tz-full-20261002/logs. PG16 loopback127.0.0.1:15432, principal codex_test; Redis/Memurai6379 DB12 для full. Shared DB/Redis/browser/server/drill запускает только root последовательно. Full процесс78167 уже завершён, повторять его не нужно.

DB inventory/full/drill17–20 сохранены. Старые inventory базы переименованы в inv380before/inv380nullbefore/inv380cascadebefore, не удалены. Fresh-only drill не запускать на populated DB.

## Дальнейшие действия

1. Gates `.unlazy/codex-inventory-20261003/GATES.md`: --status, --approve точных read-only oracles; G5 остаётся pending до документации/feature delivery/green exact-head CI/main. Локальный full подтверждён, удалённый CI пока нет.
2. Сделать отдельный test-fixture commit и inventory feature commit только по явным paths. Product source после successful full не менять без новых проверок. Generated вручную не редактировать.
3. Перед merge main35 сохранить собственный untracked `.agents/skills/tili-orchestrate` в проверенный workspace backup: incoming tracked package мешает merge. JOURNAL сохраняет Claude, inventory root и skill entries. Не использовать force/global safe.directory и не трогать исходный checkout.
4. Push своей ветки, create/attach draft PR, прочитать CI редко и последовательно, ready/merge только с успешными проверками текущего head. PR32 Claude сохраняется. Затем финальные docs/gates и продолжение371–374; goal не завершать на этом этапе.

`c382-bounds-contract.md` — draft,382 ещё не reserved/implemented. Независимое ревью выявило восемь требований до реализации; bounded doc agent уточняет completeness, successor membership, negotiation exception, association freshness, locks, retention, closure и точные DDL/DTO. Полный сценарный объём сохранён; ни один finite effect не активировать без всех нужных proofs/barriers.

Полный реестр пробелов: [CONTINUATION-AUDIT](tasks/wedding-platform-master-plan/CONTINUATION-AUDIT-20261003.md). Локальный отчёт: [REPORT-INVENTORY](tasks/фичи/030-экосистема-local/REPORT-INVENTORY-20261003.md). Все WP/FR/SC/NFR/A/U, где нет отдельной приёмки, остаются открытыми.

Pending owner input: WP11 (ранее отложенные тарифы, provider/prices/entitlements) и manual/external person-block retention после company erase. Async questions уже отправлены; ответа нет. Не выдумывать policy/согласие, продолжать независимую работу. Провайдеры, физические устройства и human pilot требуют реальных входных данных; текущие проверки их не подтверждают.
