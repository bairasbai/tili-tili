# Claude: продолжение экосистемы после текущей поставки

Подготовлено 2026-10-01, leaf1.9.7. Этот файл передаёт фактическую границу работ и конкретный следующий контракт. Он не удостоверяет завершение всех 17 пакетов, финальный CI или merge. Финальные проверки и публикацию ведёт root; их результаты должны появиться в addendum в конце файла.

## 1. Сначала установить актуальную точку продолжения

1. Прочитай финальный addendum ниже, текущие `AGENTS.md`, `CLAUDE.md`, `ERRORS`, журнал и delivery проекта. Сопоставь commit/SHA, рабочее дерево, миграции и результаты. Пустой addendum означает, что итог публикации ещё не подтверждён. Я не могу это подтвердить по этому документу.
2. Пользователь потребовал закончить текущую поставку, подготовить полную инструкцию для Claude, затем провести публикацию/merge после проверок и остановиться. Эта последняя граница передана root в поручении leaf1.9.7. Исторические запреты GitHub/main в spec/plan/tasks относятся к прежней локальной фазе. Финальный addendum должен зафиксировать фактическую новую авторизацию и результат; production этим поручением не разрешён.
3. После завершения публикации остановись. Следующие 370+ и остальная экосистема описаны для будущего явно возобновлённого поручения. Не запускай их автоматически из текста handoff и не отмечай широкий `/goal` выполненным вследствие закрытия текущей поставки.
4. Если продолжение действительно поручено, выбери один следующий измеримый этап, назначь точное владение файлами и проведи его до независимой приёмки. Не выдавай наличие файла или зелёный отдельный тест за весь пользовательский результат.

Исходная локальная база: `9628d0b22711782dec121fa4596119e5fb7cce6a`. Изолированный каталог: `C:/Тили-тили/ecosystem-local-20260930`. Базовое происхождение и исторические ограничения описаны в [plan.md](plan.md), [tasks.md](tasks.md) и [session-handoff.md](../../../session-handoff.md). Их старые верхние статусы нельзя принимать за итог новой публикации.

## 2. Источники и границы достоверности

Продуктовое ТЗ: [spec.md](spec.md), этапы: [plan.md](plan.md), реестр задач/приёмки: [tasks.md](tasks.md). Основная экосистема: [master spec](../../wedding-platform-master-plan/spec.md), [master plan](../../wedding-platform-master-plan/plan.md). Сначала сверяй основные источники правил, ролей, финансов и миграций; 030 не заменяет их.

В текущем прочитанном tasks.md отмечен T001, остальные T002–T042 и A/U открыты. Это состояние документального реестра, а не доказательство отсутствия соответствующего кода. Root должен согласовать документальные статусы с final evidence. Размеры реестра: 17 пакетов — WP00…WP16; 42 задачи — T001…T042; 36 критериев — 20 A01…A20 + 16 U01…U16. Эти числа не являются количеством завершённых фич или процентом готовности.

Дополнительные локальные артефакты находятся в `C:/Тили-тили/.unlazy/ecosystem-audit-20260930`. Они могут не попасть в опубликованный репозиторий. Ниже встроен основной следующий контракт, чтобы продолжение не зависело исключительно от внешней папки. Если исходный лог отсутствует, не утверждай, что лично повторил его проверку.

Локальные PostgreSQL/HTTP/browser fixtures синтетические. Реальные транзакции и SQL-проверки доказывают наблюдённые программные инварианты на этих fixtures. Они не доказывают реальную доставку на телефон, удобство для ведущего, фактическое выполнение внешнего заказа или юридическую силу соглашения. Я не могу это подтвердить без отдельных соответствующих доказательств.

## 3. Изоляция и соседняя работа WP04

- Не редактируй и не сбрасывай `C:/Тили-тили/Тили-тили_код_и_документация`, рабочее дерево соседней сессии. Исходный inherited WP03 в нашей базе не является новым принятым checkpoint соседней WP04.
- Перед зависимым изменением получи конкретный WP04 checkpoint: commit/hash, manifest, canonical event/person contracts, source ownership и фактические проверки. Согласование с той сессией пользователь разрешил ранее. Не импортируй её изменения автоматически и не дублируй event/person модель.
- Root единолично интегрирует общий OpenAPI, generated, номера миграций, общие документы, инфраструктуру, shared writers и Git. Агенты меняют только закреплённые файлы; независимый тестировщик не корректирует реализацию ради теста.
- Shared PostgreSQL на loopback15432 обслуживает также соседнюю работу: его процесс/data directory не останавливать, не пересоздавать и не удалять. Для собственных тестов требуется отдельное проверенное disposable имя БД. Redis DB12 был нашим, DB13 соседним; actual configuration проверяется заново перед запуском.
- Не занимай её dev3000/3001. Наши dev8091/8092 управлялись root; проверь процессы до старта. Actual-PG/full/migration drills запускает один владелец последовательно; dev-сервер не работает одновременно с full suite на том же наборе fixtures.
- Не публикуй environment secrets, fixture tokens, пароли, raw session files или приватные HTTP заголовки вместе с evidence.

Источник порядка интеграции и конфликтующих областей: [plan: isolation](plan.md). Особенно осторожно с `routes/day.ts`, `Smart.tsx`, timeline/program/ack/history/offline и источниками event identity: это совместные зависимости WP03/WP04.

## 4. Что уже имеется в коде: сохранять как основу

| Область | Фактическая основа и источник | Граница |
|---|---|---|
| Внимание пары | `essential`, `coordinator`, `detailed`, version conflict, current membership и fallback при недоступном координаторе: [attention.ts](../../../Тили-тили/backend/src/wedding/attention.ts) | Выбор существующего coordinator membership не доказывает весь будущий workflow приглашения/acceptance/handoff/backup |
| Тихие уведомления | In-app запись сохраняется при отключённом push; generic critical/day-X не обходят quiet; quota и inbox_only: [notify.ts](../../../Тили-тили/backend/src/notify/notify.ts#L21) | Общая адресная маршрутизация всех scoped duties и конкретная emergency policy не закрыты одним notify |
| Отправка push | Durable subscription attempts, lease/recovery, expiry, bounded retry и `provider_accepted`: [push.ts](../../../Тили-тили/backend/src/notify/push.ts#L45), [preflight.ts](../../../Тили-тили/backend/src/notify/preflight.ts) | Provider accepted не означает delivered или прочитано человеком; внешняя capability проверяется отдельно |
| Заказ | Один финансовый deal, structured/legacy reader, типизированные части, assignments, versions: [orders/model.ts](../../../Тили-тили/backend/src/orders/model.ts) | Не вся логистика/исполнение/финансовое завершение уже построены |
| Условия | Current material schema1/schema2, publish/read/accept, токен exact user/session/policy/digest: [terms.ts](../../../Тили-тили/backend/src/orders/terms.ts), [terms-token.ts](../../../Тили-тили/backend/src/orders/terms-token.ts) | Старое согласие не разрешает новую цену, другой смысл условий или календарное усыновление legacy брони |
| Ресурсы | Explicit `legacy_day`/`resources`, person/equipment/capacity и versioned plan: [policy.ts](../../../Тили-тили/backend/src/resources/policy.ts), [resource-plan.ts](../../../Тили-тили/backend/src/orders/resource-plan.ts) | Legacy DATE/ledgerless obligations остаются консервативными blockers; finite calendar ещё не реализован |
| Реальная бронь ресурсов | Commit/replace/release, immutable version/member/allocation/head, actual exclusion/counter/proof: [commitments.ts](../../../Тили-тили/backend/src/resources/commitments.ts) и migrations365–369 | Сохранённый план и принятые условия сами по себе не дают reserved. Same-root adoption старой booked/paid брони пока отсутствует |
| UI | Явные preparation/plan/commitment действия: [Search.tsx](../../../Тили-тили/app/src/pages/Search.tsx), [OrderResourcePlan.tsx](../../../Тили-тили/app/src/components/OrderResourcePlan.tsx), [OrderResourceCommitments.tsx](../../../Тили-тили/app/src/components/OrderResourceCommitments.tsx) | Нет автоматического read/accept/commit и обязательных периодических отчётов в этих действиях; это не human-pilot приёмка всего приложения |

Не отменяй safety вследствие переключения компании обратно в `legacy_day`: actual live allocations продолжают защищаться. `legacy_used` — сохранённая неизвестная исходная нагрузка окна, а не свободная сумма для произвольного списания. Разные части одного заказа не создают дополнительные финансовые корни. Согласованная версия отличается от текущего черновика.

## 5. Завершённая ограниченная атомарная замена legacy исполнителя

Дверь: `POST /weddings/:weddingId/slots/:slotId/replace`, [route](../../../Тили-тили/backend/src/routes/slots.ts#L209), [domain](../../../Тили-тили/backend/src/deals/replace.ts#L56), [SDK](../../../Тили-тили/app/src/lib/api/slots.ts#L84). В Search замена идёт одной командой, а не отдельными cancel и book: [Search](../../../Тили-тили/app/src/pages/Search.tsx#L797).

Вход фиксирует `expectedSelectedDealId`, `expectedSelectedDealState`, новый `vendorId`, необязательный actual `packageId`, положительный Money RUB в копейках, `expectedPolicyRevision` и Idempotency-Key. Principal/session/current policy поступают с сервера. Допустимый старый financial state: candidate/contacted/negotiating/booked/paid_deposit. Нужны actual выбранный slot, known wedding DATE, другой опубликованный доступный catalog vendor и точная текущая категория нового vendor, совпадающая со slot.

Одна caller TX проверяет и запирает wedding/current actor → offer-request mutexes → старые deal/slot/order/commitment head → полную известную историческую company/account union → accounts перед companies/policies; после ожиданий повторяет current auth, selected root/state, actual owner/category/policy и live allocation checks. Новые обнаруженные владельцы не запираются в обратном порядке: changed scope даёт bounded conflict. Предварительная проверка чужого DATE предотвращает известный A→B/B→A цикл; actual unique key продолжает защищать новую гонку.

После проверок вызываются существующие `cancelDeal`, затем `lockBookingContext`/`bookVendor` в той же TX. Старая оплаченная история и payment facts сохраняются; это отмена старого корня и один новый booked корень, а не возврат денег и не перенос старого согласия. Любой отказ/SQL failure возвращает целиком прежнюю бронь. Shared DATE другого holder и чужие даты сохраняются по существующим правилам hold/release.

Замена старого reserved/live-resource корня, старой компании в resources или нового resources vendor отказывается `resource_booking_required`; для них нужен отдельный согласованный resource workflow. Prebooked slot/stale selection — `resource_order_slot_changed`; state/source — `resource_order_source_changed`; stale owner union — `resource_source_changed`; policy revision — `order_version_conflict`; busy DATE — `date_taken`; отсутствующая DATE — `booking_date_required`; same vendor или wrong new category — 422 `validation_failed` с `vendorId`. Missing/stale package проверяет существующий booking kernel, включая `unknown_package`.

**Совместимость категорий:** исторический `bookVendor` допускает cross-category компанию в старом booking пути. Попытка усилить общий старый kernel дала регрессии и была отменена root. Строгая проверка категории остаётся только в новой atomic replace двери. Не возвращай guard в общий kernel без отдельного решения по поддерживаемой multi-service модели и её тестам.

Frozen replacement domain на подготовке: 140 строк, SHA256 `2d6028ceb65cd6a3d7602b015ac0ac6d38952219efce664dca4a5885c693c672`. Изменение этого файла после checkpoint требует новой фактической приёмки. Контракт: `C:/Тили-тили/.unlazy/ecosystem-audit-20260930/atomic-legacy-replacement-contract.md`.

## 6. Подтверждённые checkpoints и ещё не подтверждённый итог

| Проверка | Наблюдённый результат | Проверяемый источник |
|---|---|---|
| Independent atomic registered HTTP/PG | 73 passed, 1 file; checkpoint содержит 24 observed waits | `atomic-legacy-final-compat-passed73.log`, summary и PG_WAITS; `backend/test/atomicLegacyReplacement.test.ts` |
| Atomic + legacy compatibility | 395 passed, 11 files; scoped backend suite | `atomic-and-legacy-compatibility-passed395.log`, строки9–10 |
| Текущий focused UI | 139 passed, 3 files; 63 + 18 + 58 = 139 | `ui-atomic_uuid_fixed.log`, строки5–6; SearchResourceBooking/SearchAtomicReplacement/shortlist019 tests |
| Реальный local browser refusal | Actual HTTP409; whole scoped booking snapshot identical; original business fixtures identical | `atomic-replacement-refusal-oracle.json`, source actual-local-http-server-capture |
| Реальный local browser success | Actual HTTP200; retained payment facts1, history retained, legitimate cancellation + one new root; foreign dates/original fixtures identical | `atomic-replacement-success-oracle.json`, source actual-local-http-server-capture |

Все названные logs/oracles находятся в `C:/Тили-тили/.unlazy/ecosystem-audit-20260930`. Browser auth/session renewal и GET analytics исключались из отказного business snapshot явно; это не обещание идентичности каждой строки всей БД. Screenshots: `atomic-browser-refusal.jpg`, `atomic-browser-success.jpg`, `atomic-success-ru-320.png`, `atomic-success-ru-390.png`, `atomic-success-ru-480.png`.

73 и 395 — пересекающиеся checkpoints, складывать их в независимое число покрытий нельзя. 139 относится к focused UI, не ко всем frontend tests. Исторические full/drill цифры из session-handoff не заменяют последнюю проверку текущих исходников. На момент подготовки этого файла fresh13 drill, полный init/integration и CI ещё не подтверждены; merge не подтверждён. Root заполняет addendum после фактического результата. Наличие старого failure log также нельзя скрывать или объявлять успехом.

## 7. Следующий этап 370: минимальный durable inventory, только дизайн

Портативный полный дизайн сохранён рядом: [finite-calendar-design.md](finite-calendar-design.md). Исторический первый аудит: [Аудит_сценариев_свадьбы_2026-09-30.md](Аудит_сценариев_свадьбы_2026-09-30.md). Исходный внешний дизайн: `C:/Тили-тили/.unlazy/ecosystem-audit-20260930/finite-calendar-design.md`, 244 строки, SHA256 `16b3c873aa484520d383b0f96bc9f915881f9249bd6ce7eae2545f301570e0e5`. В нём41 source anchors. Это preparation-only: миграция370, новые exports/DTO, proof и новые availability outcomes этим документом не реализованы.

Перед новым поручением root сверяет и резервирует actual migration inventory: номера176370…176374 ниже предложены, а не гарантированно свободны. Существующие365–369/down не редактировать. Следующий coherent stageA370 должен включить lifecycle freshness вместе с inventory, сохранив старую conservative booking boundary.

Предлагаемое точное владение:

- migration agent: только новый `backend/migrations/1763700000000_legacy_calendar_sources.cjs`;
- model agent: только новый `backend/src/resources/legacy-source.ts`;
- independent test agent: только новый `backend/test/legacyCalendarSources.test.ts`;
- root: existing writer/lifecycle integration, HTTP/OpenAPI/generated, номера/общие документы и последовательный actual-PG запуск.

Добавить `vendor_busy_dates.id UUID NOT NULL UNIQUE` со stable identity и `source_revision BIGINT>0`. Сохранить старый `(vendor_id,date)` PK и все vendor/date/source/deal_id/created_at значения. DELETE/reinsert того же дня получает новую identity. Содержательный UPDATE vendor/date/source/deal pointer увеличивает revision; одинаковый no-op не увеличивает. Identity/created_at immutable. Это техническая идентификация, не timezone или доказательство работы человека.

Ровно четыре inventory таблицы370:

| Таблица | Минимальное назначение |
|---|---|
| `legacy_calendar_sources` | Stable source UUID; app_day/app_root/manual_day/orphan_day/live_negotiation; immutable origin vendor identity, nullable current FK/wedding, actual day/root identity, initial raw snapshot/source revision |
| `legacy_calendar_versions` | Immutable canonical full original/source/group snapshot, digest, fingerprint, monotone revision/ancestry, captured_by/time; platform backfill captured_by NULL |
| `legacy_calendar_version_holders` | Exact full protected wedding/deal group, scoped version/source FK, holder fingerprint и исходные slot/event/category/order/economic facts |
| `legacy_calendar_heads` | Inventory revision и current inventory version; rev0/NULL до capture; exact next-version ancestry |

В370 не создавать future bounds/activation/adoption/personspan tables, proposed/effective fields, party receipts или новые free/reserved состояния. DTO `state:'unresolved'` описывает отсутствие доказательства; inventory head не должен превращаться в скрытый будущий effect head.

Полная protected group определяется настоящими hold/release правилами [repo.ts](../../../Тили-тили/backend/src/deals/repo.ts#L191): несколько booked/paid/done корней общей DATE, правило done root с собственной другой DATE, все ledgerless booked/paid/done roots. Не ограничиваться `b.deal_id`. Orphan, несовместимый vendor/wedding/state, mixed scope или неизвестная группа остаются unknown; не назначать им текущую wedding DATE. Negotiation expiry не является временем конца услуги.

Backfill/runtime используют один SQL inventory material builder, например `legacy_calendar_inventory_material(source_id)`, со стабильной сортировкой, UUID/string money/revisions и документированной timestamp precision. Если canonical encoding — actual `jsonb::text`, domain читает именно эти bytes/digest; это отдельный inventory encoding, не замена JavaScript terms canonicalization. Не строить дублирующую SQL/JS сериализацию ради будущих возможностей.

Новые bounded exports: `loadLegacyCalendarInventory(client,{vendorId,actor})` read-only/current owner; `captureLegacyCalendarSource(client,{vendorId,actor,sourceId,expectedSourceRevision,expectedInventoryRevision})` одна caller TX; `locateLegacyCalendarInventoryScope` internal actual sorted union, не authority token. Capture pins полный financial union до account/company, re-locates после ожиданий, current principal/session/consent/owner, scope expansion → `legacy_source_scope_changed`409, identical capture → no-op. Current source revision и immutable inventory revision различаются.

Discovery/freshness включают новые/удалённые/transferred/recreated DATE, new holder, selected root/slot, relevant order/plan и vendor/source changes. Hooks не дают consent и не освобождают исчезнувший источник. Старый immutable snapshot сохраняется; operational deletion требует actual lifecycle trace, иначе historical source unknown. Exact current material проверяется независимо от hooks. Не брать новый wedding/account/company после позднего source-head lock.

App history удаляется только legitimate whole-wedding cascade; чужие manual/person/company обещания сохраняются. Nullable current vendor/author FK не стирает immutable technical identity. Immutable delete guard имеет узкое whole-scope исключение; proof scoped FKs остаются NO ACTION/deferred по конкретной нужде, resource/window RESTRICT сохраняется. Down отказывается при собственной captured evidence; empty down/up и populated forward — разные gates.

StageA actual-PG acceptance: stable UUID/revision/no-op; populated исходные DATE/createdAt/money/payments/baseline bytes сохранены; full shared group/done-other-day/ledgerless/orphan/mixed scope; real blocking wait с new holder/owner/principal/session/consent change → stale/409; DELETE/reinsert old snapshot retained/new identity; direct SQL immutable/orphan-version/head negatives; legitimate whole-wedding cascade; manual не получает fake wedding; down refusal после evidence; старые365–369 negatives сохраняются. Independent fixture/test результат нужен до реализации следующего эффекта.

Если inventory UI действительно нужен этому этапу, GET остаётся read-only, capture — явный owner POST с exact revisions/Idempotency-Key/current replay auth. Текст результата «источник сохранён, границы не согласованы», а не «свободен». Не рекламировать370 как finite calendar.

## 8. 371: согласованные конечные границы и общая защита занятости

После принятого370, одной coherent поставкой сделать отдельные immutable bounds proposals/holders/receipts/spans/person scope/effect heads/resolution events и common occupancy origin guards. Owner proposal не сужает ни одно app promise. Для каждого актуального protected holder нужны новые реальные distinct customer+performer user/session, deliberate read+accept exact new purpose и явная activation полной группы. Old schema1/2 receipt или `order-terms-read` token нельзя использовать повторно.

Dedicated read token: `calendar-bounds-read` purpose/typ/audience/key namespace, exact source/inventory/bounds version/digest, own wedding/deal/current user/session/policy. Activate пересчитывает actual full group и material под окончательными locks; один missing/stale holder сохраняет весь старый blocker. Manual source owner может описать свои actual external границы, но orphan `source='deal'` не становится app-consented на основании owner claim. Нужны восстановленные реальные app parties или verified terminal trace; иначе unknown.

Время вводится явно: IANA zone, local endpoints и offset-bearing UTC, проверенный roundtrip. Ambiguous local time требует actual выбранный offset, nonexistent local time отказывается. Whole local day — обе реальные местные полуночи DATE и next DATE, а не `+24h`. Не угадывать Moscow/browser/current wedding zone по старой DATE. Полный engagement содержит preparation/travel/handover/return/remaining output scope; неполные/empty границы не дают свободу. Done/past financial state сам не снимает будущую аренду/результат.

Company overlay недостаточен для людей между студиями. Person conflict использует actual stable account identity, уже известные current/historical staff/resource/duty links и conservative guard при неизвестном legacy staffing. Создание нового member/person/resource должно входить в тот же guard, иначе новый ресурс обойдёт обещание. Полностью незаписанную внешнюю связь человека с компанией восстановить из кода невозможно; A02 ограничивается actual известными identities и проверенными guards. Declared complete staffing остаётся авторским заявлением, а не выдуманным историческим назначением.

Common occupancy index защищает commitment mirrors, finite legacy person barriers и будущие manual exclusive origins. Существующие реальные legacy overlaps сохраняются как конфликтующие barriers; нельзя удалить один ради установки exclusion. Новый exclusive writer под stable key проверяет все legacy barriers. Mirror equality на actual COMMIT; company span не превращается в произвольный capacity debit. Public DTO не раскрывает чужие wedding/deal/person/receipt IDs или деньги; helper/coordinator не получают право party consent.

Acceptance включает every-holder real proof/old-token negatives, DST-short/long days, midnight/touching `[)`/overlap, one party/same session/stale digest/revoke-after-wait, cross-company identity/new membership bypass, preserved recorded conflicts, strict proposed≠effective UI, current replay и отсутствие автоматических подписей/периодических отчётов. Until this full gate keep old conservative boundary.

## 9. 372: принятие ресурсов старым финансовым корнем

Только после371 добавить dedicated schema3 purpose `adopt-legacy-calendar` и `order-legacy-adoption-read` token. Server-built terms содержат original DATE/source identity/revision/full-group fingerprint, exact holder/effective bounds digest и current private resource plan/economics. Старые schema1/2 и обычный booking verifier сохраняют прежний смысл.

Adoption допускает actual same selected vendor/root booked/paid_deposit, empty ledgerless commitment rev0, current resources policy/revision, nonempty exact plan, proposed=agreed schema3 и два новых distinct party receipts. Не сбрасывать корень в candidate, не создавать новый deal/booked event/lead won, не менять price/package/bookedAt/payment/history. Один actual adopt version1/member/allocation/head/resolution TX. Shared group: проверенная subset/full conversion, exact remaining finite barriers, unknown holder refuses; aggregate demand и любой halfway failure дают whole rollback. Original DATE/snapshot не удаляются глобально.

Нужны forward extensions, сохраняющие все старые negative controls:

- 365: отдельный action `adopt`, exact empty-head/source proof; scoped immutable adoption proof с preallocated intended commitment version ID и deferred scoped FK. Intent без actual effect/ancestry на COMMIT отказывается.
- 366: отдельная booked/paid adoption branch schema3/source/bounds/two parties; ordinary commit остаётся candidate/contacted/negotiating, replace booked/paid. Не расширять обычный commit до prebooked states.
- 367: explicit per-table RECORD branches и полный head/member/live-count/mirror/adoption-resolution COMMIT guard. Не возвращать generic `NEW` field access для несовпадающих таблиц.
- 368: только новые конкретно названные scoped deferred history FKs; сохранить прежние четыре и resource/window RESTRICT. Не делать unlimited cascade ради одного теста.
- 369: adopt не releases existing allocations. Не добавлять его как arbitrary release reason и не создавать generic calendar_free обход. Replace/release доказывают next scoped version/current membership.

`legacy_used` unchanged: невозможно вывести из исторической нагрузки, какая часть равна adopted quantity. Capacity exhaustion с консервативным double counting честнее неподтверждённого списания; baseline-transfer требует отдельного доказанного контракта.

## 10. 373 и 374: manual origins и новый согласованный перенос

373 функционально зависит от371 common barriers; unrelated manual entry не требует adoption клиента из372. Root последовательно интегрирует shared DDL/counters и сохраняет372 guards, если они уже установлены. Реальные external_order/maintenance/personal_unavailable entries имеют owner/version/source/release reason. Никакого fictitious deal/terms/customer receipt. Новый overlapping manual intention отказывается; импорт существующего фактического конфликта сохраняет обе promises через reconciliation.

Capacity formula после373: `used = legacy_used + SUM(live resource_allocations.quantity) + SUM(live manual_resource_occupancy.quantity)`. Mirror не прибавляется второй раз. Actual bigint delta/deferred equality, immutable baseline после любой origin history, last-unit race и lowering-below-used refusal. Manual release не может освобождать app allocation. Revoking member/retiring resource не освобождает уже данное обещание. Сроки legal retention не выдумывать.

374 — явный exact-purpose proposal всех affected root/group/plan/old-new explicit IANA/UTC, включая будущие done rental/output и unknown scope. Все требуемые новые parties согласуют exact revision; новая availability проверяется; только atomic all-scope success меняет resource periods/wedding/event/program. Unknown/incomplete/busy/stale → прежние periods/program/date/money полностью сохраняются. Пока этого gate нет, current resource reschedule refusal сохраняется; date-delta/Moscow fallback не переносит accepted UTC promises.

## 11. Остальной пользовательский результат остаётся отдельной работой

Не обещай «идеальную экосистему» после календаря. При возобновлении сверяй actual implementation/evidence для каждого A/U; выбери необходимые пробелы по следующей последовательности из plan, сохранив соседнюю WP04:

| Блок | Необходимый результат и критерии |
|---|---|
| Events/person/assignments | Canonical WP04 event/person, несколько category assignments; individual second-event refusal/menu/trips, scoped invitations и capacity; A03/A08, T008–T010 |
| Заказ по услуге | Все35 категорий имеют только применимые typed parts/brief fields. Supply цветочного магазина, timed photographer, equipment rental, deliverable album и appointment не получают одинаковые обязательные отчёты; T013/T014 |
| Реальные сотрудники | Scoped duty/contact/resource, invitation/acceptance/handoff/backup, current revocation, privacy; T015/A18. Existing attention choice не заменяет actual accepted duty |
| Условия/исполнение | Significant new scope/price/deadline требует fresh agreement; arrival/ready/coordinator observation/read отличны; handed over/received/reviewed/accepted по применимости; A05–A07/U11–U13, T016–T018 |
| Спокойный DayX | Applicable tasks, current actionable recipient, reserved couple decisions, same-obligation coalescing, departure fallback; concrete PlanB place/actions/owners/contacts/manual channel; atomic task init; A11–A13/U06–U15, T019–T024 |
| Деньги/вещи | Count financial root once; correction/refund promised/received/disputed/partial; narrow cancelled-wedding settlement без operation resurrection; rental returns/deposit/handoff; A04/A06/A15/A16, T025–T028 |
| Логистика/конец | Individual trips/directions/last-seat races, rooms/occupants/stay dates, current diet privacy, last selected event explicit timezone; celebration end отдельно от output/return/refund closure; A09–A11/A17, T029–T032 |
| Offline/release | WP03 principal/version/cache/revoke evidence, role negatives, full init/generators/lint/types/build/migration/browser, export/erase scope; A18/A19, T033–T039 |
| Настоящая эксплуатация | Actual provider capability/outage, files+DB restore, physical iOS/Android poor network, human host/photo/couple/coordinator pilot; A20/U16, T040–T042 |

35 категорий указаны в spec.md и `backend/migrations/data/categories.json`; число не означает35 готовых индивидуальных workflows. Composable fields выбираются по actual agreed service, а не только category name. Не создавать фичи ради категории без измеримого сценария отказа/исправления/удобства.

Продуктовая приёмка спокойствия: нормальная программа ведущего должна требовать0 обязательных периодических отчётов; подробный режим пары не добавляет их подрядчику. Режим меняет внимание/routing, а не права. Отсутствие подтверждения — unknown. Только существенные selected checkpoints, explicit решения и current incident направляются actual ответственному. Десять правок одной обязанности могут coalesce в одно актуальное notice, но отдельные денежные решения/инциденты не смешиваются. Эти требования spec U01–U16 нуждаются в actual role scenario и human pilot, а не обещании по названию режима.

## 12. Порядок исполнения и проверки будущего этапа

1. Requirements/source pass: прочитай exact current files/источники ошибок; выпиши observable outcome, known legacy и no-change invariants. Проверь соседние claims и номера; никаких shared edits без root integration.
2. Contract pass: root сначала согласует exact DTO/OpenAPI/states/purpose/error/replay/ownership, migration forward/down/cascade. Запускай штатные `gen:contract`, `gen:schemas`, `gen:types` из actual backend package.json, generated вручную не редактировать.
3. Implementation pass: locks/after-wait auth/current material, existing writer parity, counters/lifecycle/cascade; независимый test agent реализует реальные зарегистрированные HTTP/PG сценарии. Не фабрикуй положительные SQL receipts. Failure injection выполняется на реальном client/TX; mock TX не заменяет rollback proof.
4. Quality pass: current types/lint/build/focused tests, scoped exact snapshots, actual waits через `pg_blocking_pids`, empty drill и populated forward, SQL negative commit guards, RU/EN320/390/480 browser/current ACL/lost response. Root затем один запускает full `bash init.sh` на своей isolated configuration, фиксирует failures/skips и resulting hashes.
5. После last source change повтори затронутые checks; старый full SHA не переносится на новый code. UI lost-response использует same key+body/fresh authorized projection; не второй финансовый command/automatic acceptance.

Не изменяй existing migrations365–369. Для каждого forward fix сохраняй independent original negatives. Current capacity/exclusion/proof/cascade работает в actual PostgreSQL; tsc и unit tests не доказывают DB COMMIT. Инвариант SQL proof не означает невозможность фабрикации privileged DBA или доказательство фактического чтения живым человеком.

Для GitHub: сначала локальный diff/status/history. Перед обращением проверь `node ~/.claude/hooks/github-api-guard.js --status`; при ПАУЗА GitHub не трогай. Запросы по одному, без watch/быстрого polling; 403/429/rate-limit/abuse/bad credentials — остановить запросы и сообщить владельцу. Не публикуй массовые артефакты. Успешно созданный PR прикрепляется в Codex task; эта операция выполняется root, а не документальным leaf.

## 13. Финальный addendum root — пока не заполнен

Статус на подготовке: **PENDING**. Root заполняет по actual завершению; до этого не считать full/init/CI/merge подтверждёнными.

- Последняя точная авторизация пользователя и граница завершения: PENDING.
- Final branch / commit / source manifest SHA, clean/remaining diff: PENDING.
- Final isolated full init/backend/frontend/contract/types/lint/build: PENDING, exact logs/results/skips.
- Fresh13/populated migration drill и actual resulting version inventory: PENDING.
- Final UI/browser/source-hash соответствие и unresolved blockers: PENDING.
- GitHub guard status, фактические CI checks/PR URL/merge commit либо конкретный отказ: PENDING.
- Соседний WP04 checkpoint принят/не принят, его сохранённые scopes: PENDING.
- Production: этим handoff не разрешён; никакой production completion не заявлен.
- После текущей поставки: остановка; 370+ и широкий WP00–WP16 результат остаются будущим поручением с открытыми критериями.


## 14. Практическое воспроизведение текущих проверок

Репозиторий требует Node>=22 и pnpm10.34.5 в CI. Здесь локальный Node25.9.0 уже использован, зависимости существуют; без отдельного поручения их не переустанавливать. В новом checkout следуй закреплённым lockfile и .github/workflows/ci.yml, не npm install/ci. Generated формируются из актуального общего OpenAPI:

```powershell
# Из Тили-тили/backend, после согласованного изменения общего контракта
node scripts/gen-contract.mjs
node scripts/gen-schemas.mjs
node node_modules/openapi-typescript/bin/cli.js ../Тили-тили_API_openapi.yaml -o src/contract/api.generated.ts
```

Для локального full на существующей собственной базе (только после проверки live identity/изолированности; никакой production URL):

```powershell
$env:TILI_DISPOSABLE_PG_PORT='15432'
$env:DATABASE_URL='postgres://codex_test@127.0.0.1:15432/tili_ecosystem_full_20260930_test'
$env:TEST_DATABASE_URL=$env:DATABASE_URL
$env:TEST_REDIS_URL='redis://127.0.0.1:6379/12'
& 'C:/Program Files/Git/bin/bash.exe' init.sh
```

Не запускай full без DB: skipped integration не является приёмкой. Guarded tests требуют точные разрешённые имена, codex_test/no-password/loopback, и фактический inet_server_port15432. Переназначение URL само по себе не заменяет эту проверку. На Linux CI отдельный PostgreSQL контейнер работает с host network и listen_addresses127.0.0.1, чтобы фактический inet_server_addr тоже был loopback; bridge port mapping этому требованию не соответствует. Посмотри актуальный workflow, не делай database-wide cleanup, не ослабляй guards ради green.

Внешний локальный harness `C:/Тили-тили/.unlazy/ecosystem-audit-20260930/verify.mjs` оборачивает эти команды, фиксирует stdout/stderr и exit. Его `full TAG` всегда использует exact fullDB, TAG только именует лог. Повторное имя лога перезаписывается: сначала сохраняй предыдущий либо используй новый TAG. Не копируй частный harness как будто это обязательный portable runtime проекта.

Миграции: существующие300–369 уже применены к собственным testDB; все21 файла неизменяемы. Для новой пустой собственной тестовой базы `node node_modules/node-pg-migrate/bin/node-pg-migrate.js -m migrations up`, только с проверенным отдельным DATABASE_URL. Retained fullDB не удалять/пересоздавать. Если после интеграции обнаружена старая ещё не применённая опубликованная migration250, root обязан отдельно проверить её additive-only DDL и сохранение existing rows, явно задокументировать нативное out-of-order применение; не исправлять journal вручную.

Preserving rehearsal — `node scripts/ecosystem-migration-drill.mjs` из backend с одинаковыми DATABASE_URL/TEST_DATABASE_URL, TILI_DISPOSABLE_PG_PORT15432 и разрешённой НОВОЙ пустой exact drillDB. Fresh10–13 уже заняты историческими доказательствами. Новый reviewed exact namespace надо добавить только в безопасную allowlist/harness; отсутствие свободного имени не оправдывает DROP/удаление истории. Обычный init не создаёт БД и не включает drill; CI выполняет его отдельным шагом. Нельзя запускать actual-PG/full/drill параллельно; свои8091/8092 перед full остановлены, чужие3000/3001 не трогать.

Локальный stage_final до последнего исправления: frontend1835passed/98files; backend2753passed/1failed из2754, exit1. Failure относится к taskReminders: один bounded worker pass не гарантировал обработку своего push за предыдущей общей очередью. Исправлен только тест: ограниченное число настоящих проходов, exact own notice payload внутри data.notificationId, обязательные cancelled/attempts0/providerAcceptedNULL и inbox_only. Current focused taskReminders+ecosystemDelivery73/73 passed; final full/CI пока проверяются отдельно. Никакой прежний failure не превращён в full success. Источник: stage-final-full-before-queue-failure.log и server-full.log (сохранить перед следующим перезаписыванием).
