# T009: общие чтения StoreProvider · 16 октября 2026

Ограниченный этап от main `fb54327ef93233002290ec0c44f3ae613376ab13` (merged PR71), WT `wp04-t009-bootstrap-20261016`, ветка `codex/wp04-t009-bootstrap-20261016`. E=`C:/Тили-тили/.unlazy/wp04-t009-bootstrap-20261016`. Полный T009/WP остаётся OPEN; production не выполнялся. Предыдущие dirty worktrees/FAILED/аудит сохранены.

## Изменение

Четыре общие загрузки StoreProvider защищены исходной session/read областью до refresh/retry и UI/storage callbacks. Старый ответ после смены actor/sid не обновляет новую сессию; штатный refresh того же sub/sid сохранён. `usePersist.clear` удаляет ключ без повторного сохранения, generation отсекает queued writers до выхода. Общий startup promise сохраняет один GET под StrictMode, поздний membership не удаляет новую offline-копию свадьбы.

Источник: `Тили-тили/app/src/lib/store.tsx:141` (reader), `:160` (Store/session), `:209` (membership), `:298` (date), `:327` (slots), `:423` (favorites), `:454` (reset/monitor); `usePersist.ts:23` (clear/generation); `api/catalog.ts:129`, `api/weddingData.ts:53` (optional forwarding). Глобальный client, backend, финансовый протокол, контракт и зависимости не менялись. Локально декодированные claims задают область private памяти, не права на сервере.

## RED и регрессии

- Corrected real-client RED36=20PASS+16FAIL до product edits: десять held401 достигли refresh старой сессии, три late200 опубликовали старые UI данные, stale rejection менял ready→error, B bootstrap отсутствовал, late membership удалял новую offline copy. Старые11 offline/StrictMode oracles PASS. Не достигнутые replay/token assertions не объявляются отдельным наблюдением.
- Первый RED36=19PASS+17FAIL сохранён: две нечисловые ETag были fixture errors, исправлены только значения. Независимый RED review `A611AAF1…612A6` принят Root.
- Initial full2932=2918PASS+14FAIL/7unhandled выявил Consent routing и отсутствующие exports в двух старых whole-client mocks. Partial importOriginal изменил только factories; старые assertions/overrides byte-exact сохранены. Следующий full2934=2933PASS+1FAIL выявил сохранённую строку null после logout.
- Дополнительные first-login RED достигли wrong-selection. Helper RED2=1PASS+1FAIL подтвердил queued-old-second в storage при уже null DOM; добавлены clear и captured generation. Положительные controls same-value/new-session setter сохранены.
- Итоговый target123=27новых Store+2новых helper+11offline+53audit27+23Consent+3dialogs+4signout. Прежние assertions не ослаблены, offline test byte-exact. Lint-only FAILED после2936PASS сохранён и исправлен derived loading phase; свежий full-v4 прошёл все стадии.

## Приёмка

Target123PASS/0skip/types0; full-v4 frontend2936/138файлов/0skip и все6 exit0/EOF2 (frontend types/tests/lint/build, unchanged backend types/build). Все813 исходников и91FE/270BE build outputs сверены. Независимый product SOURCE-v3 `8BC7F825…450481` принят; backend full локально повторно не заявляется.

Root compiled `bootstrap-7e579d4b-40e1-4abe-ace0-49f257ce4670`:6contexts/356finished/110API cross-bound/12 просмотренных PNG, capture/page/external0. Четыре late200 после A→B сохраняют B; stale membership401 не вызывает refresh/replay, current same-session401 даёт один refresh и retry. Live DOM проверяет Store slot и обе favorite heart classes; PNG сняты во время входной анимации и служат дополнением, не design acceptance. Дата проверена как persisted value. Только controlled HTTP/compiled production assets; native authentication/ACL/БД/PWA/backend full/production этим не подтверждены.

Root qualification `ROOT-ACTUAL-QUALIFICATION.json`, SHA256 `0340002FC8AE0BC21BD0DE624E0CB24B918551E75926ADF45C190113904BD5A4`. Полный протокол — `FULL-QUALIFICATION-v4.json` SHA `2C6D76DAD085433C1F590CB40B7D13E3E765B6274AB682B95A61E7A0AE561F9A`; источник813 — `FULL-SOURCE-before-v4.json`. Final harness SOURCE-v4 `F949A3B1…104EB3B`, admission430395BB, Python6D3E/runnerA29. Независимый ACTUAL `INDEPENDENT-ACTUAL-REVIEW.md` (6564B/SHA256 `6F8DE22186DE83FBA4B30EE1BDDDE405565CE6476CCEA8C3303A3B681F106755`) принят Root4f58e9/10965c после полного прочтения; публикация — `PUBLICATION.json` после фактических PR/CI/merge/freshmain.

## Оснастка и уборка

Сохранены три старых browser FAILED: immutable receipt filename collision; reentrant request header capture/неполный health fixture; ошибочное присвоение старого системного процесса. Причины исправлены, их результаты не переименованы в PASS. Для старых cleanup с некорректным ConvertFrom-Json DateTime созданы отдельные v2 proof с DateKind String; исходные unqualified proof сохранены. Ошибки Root qualifier при попытке разобрать source/JSONC как JSON не являлись запуском браузера; после разделения bytes/hash и JSON parsing qualifier завершился exit0.

Root final OS proof:387 записанных identities/29 CPU receipts, own0/uncertain0, порты56997/61813/58113 свободны, собственный browser profile удалён. Три PID с другой birth identity оставлены нетронутыми. Новые PG/Redis не запускались. Старый системный MoNotificationUx33628 ошибочно попал в предыдущий collector по reused PPID; он не завершался и не объявляется собственным. Исправление требует точный Python root и birth>=root/parent; новый полный browser run прошёл. Все исторические FAILED/admissions/аудит/dirtytrees сохранены.

## Остаток

Другие callers без guards, Auth/private surfaces, Store mutations (включая late toggleFav rollback), manual-loss, additional legacy_day/mixed и весь T009/WP остаются OPEN. В compiled удержан401 только membership; прочие три401/ABA/StrictMode/reconnect/firstlogin доказаны unit/SOURCE. Следующий этап требует отдельного плана и meaningful RED. История policy48/SC004/прежних поставок сохранена; этот этап их заново не объявляет принятыми.
