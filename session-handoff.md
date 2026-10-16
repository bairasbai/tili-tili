# WP04 · отдельная позиция мероприятия · 16 октября 2026

Ветка `codex/wp04-event-positions-20261016`, worktree `C:/Тили-тили/wp04-event-positions-20261016`, база main `d98b30bb06c16f66fc99347bb2fa179bae15a027` после merged PR67. Реализация и документы пока не закоммичены; push/PR/CI этой ветки ещё не выполнялись. Production запрещён. Полные A03/SC004/WP не приняты, WholeWP0/17. Старые FAILED сохраняются.

## Реализация

Контракт0.72.6: couple-only POST `/weddings/{weddingId}/slots/additional` с category/event/label и обязательным Idempotency-Key. Wedding lock, текущие права/сессия/согласие после ожидания, финальный JWT, точный replay/path/body hash, cap100. Legacy category-only POST сохранён, cap учтён также в legacy/shortlist INSERT. Создание позиции не создаёт заказ или деньги.

Форма команды, exact slotId через каталог/анкету/optional candidate PUT до resource-order. Explicit invalid/foreign/duplicate/mixed query отказывается без fallback. Options.assertCurrent передан затронутым wrappers/private reads/store для внутреннего401 refresh/retry; глобальный клиент и финансовые протоколы не менялись. Генерация от YAML выполнена; миграции/dependencies/locks прежние. Карты экранов/кнопок и их журналы обновлены.

## Фактическая приёмка

Evidence `C:/Тили-тили/.unlazy/wp04-event-positions-20261016` (E).

- Native38/38/0skip,18actualPGwaits, stricttypes/lint0;104nonAudit JSONrowvalues exact,39prior+24new audit retained. FocusedFE201/201 и audit4820/20 actual0. Эти числа не добавлять к full.
- Full `E/stand-v2/checks-full-5a5880ff-31ac-4bb9-b785-5f55530eb334`: actualouter0, все8стадий exit0;2691frontend+3468backend=6159passed/0failed/0skip. Все803source hashes актуальны;8receipts/16raw streams проверены Root, independent FULL ACTUAL прочитан. CI49/rehearsals этим не принимаются.
- Отдельный full-data-readbackc02e4e2f остаётся FAILED/verifiedfalse:82/104таблицы отличаются, fullDB с legacy fixtures/users2156/weddings1329/audit12160 сохранена. Принадлежность всех82различий не классифицирована. Не называть этот proof очисткой.
- Fresh compiled browser `E/browser-db/browser-96ead4c5-d62e-4990-a7ce-bfeafb942cd5`, exec88644 actualouter0: создание201 → exact catalogue/vendor/candidatePUT200/resource-order200 → secondcouple.241/241finished,external/console/page errors0,3originalPNG просмотрены Root. Native primary unchanged/две позиции/один candidate order/no payments/dayholds; builds before-after exact,803sources current.
- Browser cleanup104table count+SHA baselineexact; priorAuditExact+2newownretained подтверждены выполненными guards+exit0, raw audit-after не сохранён. Python UI result ограничен preexit, cleanupVerified=false. Node post-Python freshCIM/EOF/code0 проверил9children inclconhost; Rootafterouter все12IDs absent/profile0/ports50392,50393free. Root live snapshot поздний/не liveproof. SOURCE reviewedpins8A363E44/BA4E2514;17+15CPU controls отдельно отproducttests. Independent browser ACTUAL A08E956EDAAF439E53F9BC12CD7A7D5C56C27F72856CCC4287018BC8CB8E86F5 прочитан Root полностью: PASS только этого сценария, включая361buildfiles/803currentpins; raw audit/primary/payment ограничения сохранены.

Все ранние FAILED сохранены: target37/38 timestamporacle,FE199/201 readiness,EPERMдоtests,full2690/2691 sharedResponsefixture,full3454/3468 contractdescription+ownlocale/PATH,missingdefaultheadless1200,installedChrome2Kasperskyrequests/2consoleerrors. Не ослаблены assertions/AVнастройки/сетевые исключения. Текущий cachedheadless1181 — cachelabel, engineversion не подтверждена.

## Ресурсы и уборка

Root владел PG35508/15432, Redis2732/56379 и browserNode32248/Python34180. Все остановлены штатно/безforce; `E/stand-v2/stand-cleanup.json`, `E/redis-cleanup.json`, browser/root-os-after-v1.json verifiedtrue. `E/final-processes.json`:53recordedPID absent,0ownalive/0reuse,4portsfree. Старый C-cluster32972 тоже остановлен. Оставленных собственных процессов нет; чужие5432/6379/MCP/другие сессии не трогали.

TEMP каталоги `tili-wp04-event-positions-20261016`, `tili-wp04-event-positions-20261016-icu-v2`, `tili-wp04-event-positions-20261016-redis` сохранены с данными/аудитом. Это файлы, не живые службы. BrowserDB allocations85миграций отделена от fullDB. Не запускать старый init/не удалять audit.

## Один следующий шаг

Сделать scoped commit и разрешённую публикацию этой ветки в bairasbai/tili-tili: push → PR → CI exactSHA → ordinarymerge/freshmain proof. Локальные SOURCE/ACTUAL/diff/docs проверены; E/GATES отражает ограниченную приёмку и delivery state. Перед каждым GitHub-доступом guard status; API строго последовательно, CI не чаще2–3мин,403/429/auth/rate/пауза — стоп. При фактическом auto-review refusal не обходить: сохранить отказ и запросить конкретное недостающее разрешение. Новых служб/полного прогона для правок только документов не требуется.

После поставки следующий продуктовый этап — полный публичный ресурсный A03 двух мероприятий с двумя участниками пары и компанией; этот browser доказывает создание/выбор/подготовку одной дополнительной позиции, не весь сценарий. Детали и границы: `tasks/фичи/030-экосистема-local/REPORT-EVENT-POSITIONS-20261016.md`.
