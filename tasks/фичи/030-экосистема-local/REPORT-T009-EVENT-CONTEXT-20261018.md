# T009 R0 · Контекст мероприятия в позиции · 18 октября 2026

Состояние: локальная приёмка Root и независимый ACTUAL R0 приняты; поставка пока ожидается. Полный T009 и старые day/mixed/cancel/reschedule пути остаются OPEN. Production не затронут.

## Изменение

Раньше явно привязанная к дополнительному мероприятию позиция могла получать в интерфейсе дату и пояс основной свадьбы. Optional readonly `Slot.programEvent` теперь возвращает серверный контекст по точному wedding+event FK: id, name, kind, date, timeZone, location, isMain. Отсутствие поля сохраняет прежнюю implicit-main семантику; явные null/date-null/tz-null не маскируются основной датой. Guest-vendor DTO скрывает новое поле.

OpenAPI 0.72.7 и четыре generated файла обновлены настоящими генераторами. Store, SlotDetail, Compare, каталог и точная анкета используют выбранное мероприятие; переход из сравнения сохраняет slotId. Изменение всего контекста retire прежние действия, включая same-date/different-event identity. Явные неизвестные дата/пояс запрещают offer request/accept; чужая по дате legacy occupancy показывается как неизвестная, с сохранением фактического источника в сравнении.

Дневные writers, holds, release, reschedule, inventory и финансовая политика не изменены; `additional_event_booking_pending` сохранён. Миграций нет, существующие86 сохранены. ContractWizard/server-document/vendor reply и дополнительные legacy-day бронирования этим этапом не приняты.

Основные исходники: `backend/src/deals/repo.ts:97`, `backend/src/routes/slots.ts:469`, `app/src/lib/store.tsx:389`, `app/src/lib/slotEventContext.ts:1`, `app/src/pages/Wedding.tsx:277`, `app/src/pages/Smart.tsx:241`, `app/src/pages/Search.tsx:641` (все относительно `Тили-тили/`). Карты экранов и кнопок обновлены в той же итерации.

## Проверки

E=`C:/Тили-тили/.unlazy/wp04-t009-day-20261018`; W=`C:/Тили-тили/wp04-t009-day-20261018`. База ветки e1dafc0c817311bc31aa8a8400bf4f3c4070bd2e.

- До product: meaningful RED20=1PASS+19FAIL в трёх frozen новых suites. Поздние assertions после первого отказа не объявляются достигнутыми. Затем target20PASS; отдельная интеграционная проверка47PASS (результаты перекрываются, не суммируются).
- Current full-v3: **6480=2981 FE+3499 BE**,141/159файлов,0skip/fail. Все8 native стадий types/tests/lint/build плюс prerequisite завершились exit0/EOF2. Fresh complete source set818 совпал по paths/bytes/SHA; dist91FE/270BE. FULL-QUALIFICATION.json SHA **6AD0E80F79EC07E4EAAB342CF0429E98437B6DF3F664A665344244585D9C6CA7**; run-full-v3-e9d534eb-0ac1-44e5-9bdc-59db83326968.
- Root compiled: **9=8 UI+1 driver HTTP сценарий**,8 просмотренных PNG;363 page requests,88 page API+7 driver HTTP=95. Каждая из95 бизнес-записей сопоставлена с native wire tail по method/path/status/request JSON SHA/response SHA и multiplicity.21 injected setup request отделён от browser proof; приватный stop control plane исключён из этого wire.
- East15 июня2028/Pacific/Kiritimati и west16 июня/Pacific/Honolulu показывают свои даты/пояса; explicit main14 июня/Europe/Moscow и absent implicit main сохранены; unknown не получает main fallback. Compare→анкета сохраняет позицию; календарь и похожие/каталог запрашивают event date. Настоящий driver PATCH east на15 июля/Asia/Tokyo с If-Match виден после нового чтения; остальные event/slot rows exact.
- Ожидаемые HTTP отказы только в driver: чужой vendor non-member404/not_found и дополнительный request409/pending. Page/capture/console/external errors0. Setup409 дополнительно сохранил все105 таблиц exact. Mounted editor, positive offer acceptance, held401, guest-token compiled redaction и финансовые операции этим браузером не проверялись; соответствующие контролируемые/BE проверки не выдаются за compiled сценарии.
- COMPILED-QUALIFICATION.json SHA **F1A2D19EA6498E7E6D5092B20F75C73AC2229F0568AAC9ACF50C45DAF7A0288C**; result compiled-browser-d0f73bad-c4fb-48a9-8975-a9a5c894de21/result.json SHA5F07115DDEB9FA815AECBAF68F2A5D14D6C152A23E0FE464FA4C507B052DF80C. Fresh SOURCE: product A78646A9, harness74B99FB8; qualifier/source supporting reviews сохранены рядом.

## Сохранность и исправленные отказы

Старый full-v1 12FAIL сохранён. Исправлены две устаревшие контрактные проверки (версия и optional implicit field); остальные10 отказов restoreDrill устранены Git sh в PATH, сам restoreDrill не менялся. Все frozen новые oracles сохранены. Full-v2 REFUSED вызван повторным использованием Windows PID; collector теперь сравнивает birth прежде чтения скрытых exe/cmd чужого процесса, не завершает его. Успешный current full-v3 не переименовывает прежние FAILED/REFUSED в PASS.

До повтора обе прежние full-базы переименованы и перечитаны с прежними OID: `tili_ecosystem_full_failed_20261018_v1` и `tili_ecosystem_full_refused_20261018_v2`; все105 raw таблиц/аудит совпали. Proof: FAILED-FULL-V1-PRESERVED E6BD1515 и REFUSED-FULL-V2-PRESERVED7E495432. DROP/reset не выполнялся. Все старые raw/RED/FAILED/audit и пять dirty post-publication документов прежнего PR73 сохранены; PRIOR-DIRTY-DOCS-PRESERVED.json подтверждает exact hashes.

Отдельно сохранены отказы оснастки UTC/PID, PowerShell automatic input/R alias, idle pool admission и tuple9/10 до Playwright; их локальные причины исправлены. Два stop control-plane415 возникли из default form Content-Type, исправлены JSON{}; в95 business HTTP они не включены и не выдаются за успешные202.

## Уборка и пределы

UI own fixtures удалены адресно:104 non-audit таблицы вернулись к baseline exact; audit0→4 полностью сохранён. FE/BE штатно остановлены nonce202, nativeexit0/EOF2, оба их порта52469/52493 свободны. Chromium/profile1 закрыты штатно. PostgreSQL15432 и Redis56379 остановлены штатно после проверки владельца/отсутствия client peers; базы и аудит оставлены на диске. FINAL-OWN-CLEANUP-postqualification.json SHA **A8626DE3032D686CBDA80F2B516D87BA39093E10F7E8F91501400CA8FCE028B8**:797 recorded identities, live0/uncertain0, service listeners0. После доставки требуется ещё одна актуальная OS сверка.

Следующая фаза полного T009: versioned per-deal origin/current day authority, точные DATE holders и forward inventory, атомарные writers/cancel/main+event move, затем снятие pending guard и полная day/mixed/retry/ACL приёмка. Предварительный SOURCE-план DAY-R1-RED-PLAN.md не является реализованной схемой или приёмкой.

## Независимая приёмка и поставка

Независимый PASS_ACTUAL_R0_ONLY: R0-ACTUAL-REVIEW.md SHA164BBD378B4E5CF20783C96E08D10F91D6E6BB04135EB43BE3A3E2090D00D8BE, Root прочитал весь файл (e95a54) и принял. Source review узкой tuple correction053 выполнен после повторного launch; optional admission review9DAA остаётся историческим checkpoint, current qualification связывает последующий74B99. Доставка pending: scoped commit/push/attached PR/exact CI/ordinary merge/fresh main parents+tree и финальная OS сверка. R0-GATES.md отслеживает только этот leaf; GATES.md полного day/T009 остаётся OPEN.