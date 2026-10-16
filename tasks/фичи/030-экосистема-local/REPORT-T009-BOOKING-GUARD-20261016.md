# T009 · дата старой брони и удаление компании · 16 октября 2026

Локальная приёмка завершена: полный прогон6245=2751frontend+3494backend, все8стадий exit0/0skip, preserving migration drill и compiled UI/native. Независимый итоговый ACTUAL принят без блокеров: INDEPENDENT-ACTUAL-REVIEW.md, SHA256 3C50090D221773071373A192C2D024FA8A0CE43DFD0DAA0403144162A59AE5EE. Публикация учитывается отдельно ниже. Полный T009/WP, additional legacy_day, providers/PWA/production не приняты.

Исходный main de2130b5c1cfe22f7a90548e09ec07e2fe245dd7 повторно fetched e489ed; отдельный worktree wp04-t009-legacy-20261016, branch codex/wp04-t009-legacy-20261016. Предыдущие4+7dirtydocs/FAILED/audit и старый retained cluster не менялись. E=C:/Тили-тили/.unlazy/wp04-t009-legacy-20261016.

## Исправление первой брони

После публичной подготовки resource-order для дополнительного мероприятия и смены policy resources→legacy_day PATCH первого booked/paid_deposit/done мог удержать weddings.date основного дня. ActualRED37=34PASS+3FAILED доказал HTTP200/mainhold2027-06-14 для event2027-06-15; исходный FAILED сохранён.

Из assertLegacyBookingSlotReady выделена прежняя event-only проверка: backend/src/deals/book.ts:111. PATCH вызывает её до цены/history/state: backend/src/routes/deals.ts:215. Она допускает собственное structured назначение основного дня; прежний guard незаполненного слота сохраняется у старых callers. NULL legacy fallback/financial protocol/date resolver не менялись, дополнительный legacy_day не открыт. Native45 включает9from×to отказов, combinedprice/samekey retry и2main positives: test/orderLegacyIntegration.test.ts:185/206/225.

## Исправление каскада

Первый full сохранён как FAILED: frontend2751PASS, backend3478PASS+2FAILED/3480/0skip. Отдельный resource suite дал88PASS+2FAILED/90. eraseUser отклонялся FK vendor_resources_staff_member_id_fkey. Native rollback39864e опроверг отсрочку только staff FK/четырёхresource FK и удаление только staff: соседний vendor FK тоже проверял промежуточное состояние.

Новая1763840000000_resource_source_erasure.cjs меняет ровно8FK vendor_resources/vendor_staff_members на DEFERRABLE INITIALLY DEFERRED. Все ON DELETE/UPDATE actions, имена/identity guards/ресурсы/история/деньги/аудит сохранены. Реальный COMMIT ошибочного staff FK по-прежнему даёт23503 и полностью откатывается. Down сохраняет данные и возвращает прежнее время проверки; прежний cascade failure при нём может вернуться. Regression94resource покрывает eraseUser/directvendor/directuser, owner/worker person/equipment/capacity, чужую компанию/shared worker и realCOMMIT: test/resourceCommitments.test.ts:782/821.

Strict C04/C05 CI admission и worker обновлены до точного86 с frozen migration SHA7AD0E2BCB420BA2350B587282E62EE6E95DD1CA4F59B59BDC20077B5573490D4. Historical83/85/seed pins сохранены, unknown tails запрещены. Worker имеет только literal85→86; новый inverse восстанавливает все4исходных файла побайтно. Actual isolatedCI49 принимается только по будущему CI, не по full.

## Проверки и сырые доказательства

- Target167/167=94resource+45booking+28admission, types0/0skip: integrated-target-c73b6798-850c-4590-b704-b518d7a9e2a6, fc3ee8/f337ee. SOURCE review исправленного current86 worker798EE60C.
- Full checks-full-b227051e-668e-4ef6-96d8-81790c8a8c22, outerfull-v2-launch-98da2edd-c579-4718-a7de-73295125a588, 4dae76/fb55ec:2751/133frontendfiles+3494/158backendfiles,0failed/pending/todo; types/lint/build обеихчастей0/EOF2/noForce. Source806beforeafter exact; actual build admission fecddd: backend270/frontend91 exact. ROOT-ACTUAL-QUALIFICATION.json.
- Preserving migration-drill-launch-2a5464a4-cfb5-4e17-825e-e24b10c5bb5d exit0: прежние SQL/guarded-down проверки сохранены; новый цикл3up/3repeat/2down, final86,8FK. Полные данные/аудит/определённые каталоги/OID сохранены. Runtime sequence counters в rollback drill не объявляются transactional. SCHEMA-DRILL-ACTUAL-REVIEW35BE691C подтверждает оснастку; автор миграции не принимал свои product assertions independently.
- Schema-up5e8d29 меняет только один journal row в двух новых ownDB:104остальные таблицы raw-exact, включая130/13942audit. Новая browserDB создана отдельно pinned dump85→nativeCLI86, audit0; старые target/full/drill не использовались для restore.

## Compiled UI/native

compiled-e272fce7-0cce-4680-b524-2d085c38afdc, fecddd/68e021 exit0/EOF2: три реальные кнопки PATCH409→200→409. Дополнительный день оба раза additional_event_booking_pending,105native tables exact, receipt отсутствует; основной NULLlegacy day booked с прежним selectedstructuredroot/assignment, единственный hold2027-06-14, money rows без изменений. Повторный отказ сохранил основную бронь целиком.

115/115browser requests finished,3originalPNG с bytes/SHA/dimensions просмотрены Root;2точных ожидаемых409console,0page/external/captureerrors. Pythonpre-exit cleanupVerified=false/preExitAllowed=true не подменён успехом: NodepostPythonverifiedtrue/remainingOwn[] и отдельныйRootfinalOS закрыли оставшийся parent console. Privatefixture с токенами удалён; raw wire/private snapshots локальны и в commit не входят.

Backend работал development с настоящими JWT/session/consent/business guards, frontend — Vite productionassets. Redis limiter/jobs/providers/productionruntime этим UIсценарием не принимались; их отсутствие явно указано runtime-mode.json/result.json.

Fixture cleanup104nonAudit exact,7preCleanupaudit rows сохранены целиком. Protected before/after: target/full/drill все105fingerprints и2sequence counters exact; audit130/28122/0. Все13942raw audit до миграции остаются в full28122. Полная fullDB не восстанавливалась к initialclean: её тестовые состояния и аудит сохранены на диске.

## Уборка и передача

Redis4400/56379 штатно остановлен4795ad; PG43864/15432 штатно остановлен8890f9. Fresh final-processes-a26fbe87-92b9-4309-b8ef-9f9a48833a8c:460unique recordedPID, ownremaining0,15432/56379/56941/56953free, activeprofiles0. Семь identity records относятся к6повторноиспользованнымPID10188/36156/42180/42700/44468/5788 с другой датой рождения; они не завершались.10188 имеет путь Codex CUA runtime; владельцы остальных не установлены. Причина оставить — это другие identities, не принадлежащие записанным процессам задачи. Все4ownDB/кластер/audit остаются на диске.

Открыты: полный additional legacy_day resolver/hold/release/reschedule; frontend session fences requestOffers/acceptOffer/Weddingcancel/vendorreply (E/FRONTEND-SOURCE-MAP.md); вся mixed/прочаяT009/WPприёмка. Контрактv0.72.6, dependencies и frontendcode не менялись. Следующий шаг этой поставки: scopedcommit/PR/CI→ordinarymerge/freshremoteproof; публикация фиксируется E/PUBLICATION.json. Production не разрешён.
