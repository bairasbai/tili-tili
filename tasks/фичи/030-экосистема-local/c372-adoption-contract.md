# Контракт этапа 372 · same-root adoption · 31 октября 2026

Статус: **frozen** после построчной сверки с кодом 31 октября 2026. База: fresh main `3041d2c` (merge PR82, тот же день).
W=`C:/Тили-тили/wp04-t009-adoption-20261031`, ветка `codex/wp04-t009-adoption-20261031`,
E=`C:/Тили-тили/.unlazy/wp04-t009-adoption-20261031`. Production запрещён. 373/374 и полный
T009 остаются OPEN и этим этапом не открываются.

## Authority

- [finite-calendar-design.md](finite-calendar-design.md) — раздел «372: same financial root
  adoption and preserving SQL extensions» (строки 167–201) и матрица угроз (строки 235–242).
- [CLAUDE-CONTINUE.md](CLAUDE-CONTINUE.md) — раздел 9 «372: принятие ресурсов старым
  финансовым корнем».
- Принятые предшественники: 370 inventory (исторически), полный 371 (PR81, main 8b8fa295),
  приёмка активации inventory/2 (PR82, main 3041d2c).

## Scope этапа

Принятие (adoption) ресурсов **тем же финансовым корнем**: booked/paid_deposit корень принимает
свой актуальный план по свежим schema3 условиям; финансовые строки/история/платежи сохраняются
byte-exact, добавляется только новое commitment/resolution-доказательство. Без нового deal,
без сброса в candidate, без перезаписи price/package/bookedAt/paid/date.

1. **Schema3 purpose `adopt-legacy-calendar`**: server-built material = существующая точная
   экономика/parts/events/resourcePlan + `legacyTransition` (purpose, sourceId,
   sourceVersionId, sourceFingerprint, fullGroupFingerprint, holderFingerprint,
   effectiveBoundsVersionId, effectiveBoundsDigest, originalDay, disposition
   `replace_this_holder_company_barrier_with_this_resource_plan`, retainedHolderCount,
   bounds). Не замена schema2 глобально.
2. **JWT `order-legacy-adoption-read`** — отдельный purpose/typ/audience/key namespace с
   source/bounds version+digest поверх текущих claims; `order-terms-read` неизменен. Старый
   read-токен не является доказательством adoption.
3. **Exports**: `adoptLegacyOrderResources(client, CommitResourceInput & {sourceId,
   sourceVersionId, expectedSourceFingerprint, expectedSourceHeadRevision,
   effectiveBoundsVersionId})` — один holder, только когда остальной scope источника resolved
   и план не конфликтует с удержанными барьерами других holders;
   `adoptLegacyResourceGroup(client, {actor, expectedSourceHeadRevision, sourceId, holders})` —
   атомарная subset/full группа: проверка schema3-доказательства каждого корня, один раз lock
   отсортированного union, aggregate demand/conflicts, whole rollback при halfway failure.
4. **SQL forward extensions** (миграция **1763930000000**, зарезервирована Root для этого
   этапа; 94 применённые миграции immutable), каждая со старыми negative controls:
   - 365: CHECK action += `adopt`; `protect_resource_commitment_version()` — adopt требует
     пустой head revision0 + exact scoped legacy proof; immutable
     `legacy_calendar_adoption_proofs(...)` с UNIQUE (wedding_id, deal_id,
     commitment_version_id), preallocated commitment_version_id, deferred scoped FK; orphan
     intent отказывается и не меняет состояние календаря.
   - 366: отдельная booked/paid ветка adoption (schema3/source/bounds/две distinct стороны);
     обычный commit остаётся candidate/contacted/negotiating.
   - 367: explicit per-table RECORD branches; COMMIT guard доказывает adoption resolution
     ancestry и exact occupancy mirrors; старые orphan/empty-head/wrong-member/live-count/
     released-head контролы сохраняются.
   - 368: только новые явно названные scoped deferred history FK; прежние четыре и
     resource/window RESTRICT сохраняются.
   - 369: adopt НЕ освобождает существующие allocations и не становится release reason;
     generic `calendar_free` обход не создаётся.
5. **`legacy_used` byte-for-byte неизменен**: консервативный double counting остаётся,
   capacity-exhausted — честный отказ; baseline-transfer — отдельный доказанный контракт.
6. **Идемпотентность**: scope `orders.resources.adopt` / `orders.resources.adopt-group`;
   replay возвращает stored operation identity + свежую авторизованную текущую проекцию;
   никакого повторного финансового действия.
7. **Граница**: 373 manual origins и 374 reschedule не входят; `verifyAgreedOrderTermsForBooking()`
   сохраняет обычное поведение, schema3 выбирается только по фактическому server adoption draft,
   никогда по caller `snapshot.schemaVersion`.

## Критерии приёмки (до реализации — meaningful RED)

- Positives: одиночный adopt booked и paid_deposit корня; group adoption subset и full;
  remaining finite holders продолжают защищать свои spans; original DATE/snapshot сохранены.
- Negatives: schema2/fake transition, неверный source/group/root, changed slot/state/policy/
  owner, оставшийся unknown holder, done/cancelled, недостаточная capacity, старый
  `order-terms-read` токен, caller-заданный schemaVersion, halfway SQL failure → полный
  rollback всех head/allocation/mirror/source, orphan proof intent.
- Direct SQL: immutable/orphan-version/ancestry/wrong-receipt negatives на COMMIT.
- Idempotency: same-key retry после потери ответа, без второй операции.
- Старые регрессии: полный backend gate (parallel+serial), drill, FE gate; сохранение всех
  прежних negative controls 365–369/370/371.
- C04/C05 — CI-шагом (local-профиль пинит 2026-10-03, как зафиксировано в GATES.md PR82).

## Техническое уточнение F2 · 3 ноября 2026

После настоящего adoption допустима обычная, отдельно согласованная schema2-замена оборудования **без изменения календарного смысла**. Это уточняет существующую native-операцию replace; перенос даты/времени374 и смена людей этим не открываются.

SQL прослеживает scoped immutable ancestry от текущей версии до revision1/adopt, точного proof и resolution. Для нового origin allocation применяется тот же строгий ancestry; незавершённая ветка/версия без текущего head по-прежнему отвергается прежними deferred graph guards на COMMIT.

Для календарно-нейтральной замены сравниваются исходный immutable plan из adoption proof и новый актуальный plan той же компании. Размер, порядок, набор ключей и все значения строк совпадают буквально; **только** у equipment могут различаться resourceId/conflictIdentity/label. Person/capacity строки, количества, окна, part/assignment/event/version, time zone, base/occupied intervals и подготовка/дорога остаются точными. Current order.version равен source_order_version нового плана и original order.version + разница plan revisions: постороннее изменение заказа не маскируется.

Только при этой проверке старый legacy frame использует исходные immutable holder.order и calendarInputs.plan. Все остальные финансовые/DATE/slot/principal/person-scope/parts/policy/context/retained-holder поля остаются текущими. Обычные order/resource-plan/terms API читают **новый** план; для replace обязательны реальные новые schema2 согласия и прежние native availability/COMMIT проверки. Это не разрешение игнорировать текущие источники или освобождать невыбранные барьеры.

Приёмка: реальная equipment substitution с новым allocation; неизменные DATE/деньги/old proof; same-plan replace ancestry; отрицательные time/person/capacity/order edits; orphan/fork/pending-origin COMMIT refusal; aggregate capacity и поздний SQL fault всей группы.

## Не входит

373 granular manual occupancy, 374 resource moves, baseline-transfer capacity, UI этапа
372 (если появится — отдельный явный scope с read/adopt дверями из design L141).

## План этапа

1. Разведка кода (этот документ): migrations 365–369 и 1763920000000 существуют, `adopt` в
   коде отсутствует; точки расширения: `resources/commitments.ts`, `orders/terms.ts`,
   `routes/legacyCalendar.ts`, `resources/legacy-calendar.ts`.
2. Freeze контракта после сверки с кодом → meaningful RED → минимальная реализация → целевые
   проверки → полный гейт → PR/CI/обычный merge по общему правилу публикации.

## Сверка с кодом (подтверждено построчно 31.10.2026)

- `backend/src/resources/commitments.ts` (369 строк): `reserve()` — единый путь
  commit/replace; initial commit жёстко требует `state in (candidate,contacted,negotiating)`
  + head not_reserved (~строка 235) → adopt не выражается флагом reserve, нужен отдельный
  export. `legacyBoundary()` (~строка 137) вызывает SQL
  `legacy_calendar_bounds_assert_boundary(vendorId, dealId, lines, initialWitness)`.
  CHECK action в БД: `('commit','replace','release')`.
- `backend/src/orders/terms.ts` (221 строка): snapshot schemaVersion 1|2 (строка 106);
  `verifyAgreedOrderTermsForBooking` (строка 201) требует schemaVersion=2 и proposed=agreed;
  receipts — customer+performer, distinct user/session. schema3 не ломает этот путь.
- `backend/src/orders/terms-token.ts` (43 строки): JWT HS256, typ/purpose/aud
  `order-terms-read`, ключевой namespace `tili-order-terms-read\n<secret>`, TTL 600 —
  образец для `order-legacy-adoption-read` с собственным namespace.
- `backend/src/resources/calendar-bounds-token.ts` (124 строки): второй образец purpose
  (`calendar-bounds-read`) с dataObject/compactVerify дисциплиной.
- Миграция `1763920000000_legacy_calendar_bounds.cjs` (1825 строк, прочитана целиком):
  - `legacy_calendar_resolution_events.action` CHECK (строка 150):
    activate/holder_cancelled/source_unavailable/source_stale/superseded/
    negotiation_committed — `adopt` отсутствует, расширяется здесь.
  - `legacy_calendar_bounds_assert_boundary` (~строка 1005): для каждого present source
    вендора (и person-ассоциированных вендоров) требует current_effect freshness='current'
    и state<>'unresolved' (`unresolved_legacy_obligations`/`legacy_person_scope_unknown`);
    barrier-overlap по `resource_occupancy` с carve-out только для own initial
    live_negotiation. Adopted-holder исключение — через release его barrier-линий новым
    resolution action.
  - `legacy_calendar_bounds_release_valid` (~строка 1322): reasons только
    superseded/negotiation_committed/holder_cancelled — adopt-ветка добавляется сюда
    (release legacy_person линий данного holder), НЕ в release_reason allocations (369).
  - `legacy_calendar_bounds_prepare_initial_commit` + `initial_preconditions` +
    `assert_initial` (~строки 1150–1240): witnesses только для pending candidate/
    contacted/negotiating, schemaVersion=2 — adopt использует параллельную механику для
    booked/paid_deposit со schema3.
  - `protect_legacy_calendar_bounds_history` (~строка 1245): resolution insert-ветки по
    action; `adopt` получает свою ветку с доказательством exact scoped proof.
  - `OWN_FUNCTIONS` (строки 52–80) и down с preserving-refusal — новая миграция
    1763930000000 повторяет этот стиль (own functions list, down с отказом при evidence).
- `backend/src/resources/legacy-calendar.ts` (611 строк): owner/holder seat, readToken
  подпись в `readLegacyCalendarBounds`, accept с verify claims, activate → SQL
  `legacy_calendar_bounds_activate`; `legacy-calendar-scope.ts` (245 строк):
  `prepareLegacyCalendarScope` + assertCurrent дисциплина; `legacy-bounds-time.ts`
  (121 строка): строгий парсер span.
- `backend/src/routes/legacyCalendar.ts` (153 строки): паттерн идемпотентности
  `idempotency_keys` + ReplayGuard (fingerprint/versions/head/receiptPrincipals) —
  adopt-маршруты повторяют его со scopes `orders.resources.adopt(-group)`.
- Миграции 176365–176369: подтверждены ранее (365 таблицы+триггеры protect, 366
  check_resource_commitment_proof, 367 per-table RECORD create-or-replace, 368 четыре
  deferred FK, 369 release proof только с matching next version).
