# 370 — контракт (драйвер, rev 1, 2026-10-02)

Этап 030/370: технический инвентарь прежнего календаря (DATE-строки и корни без ресурсной книги), обнаружение, свежесть.
Источники: 030 `CLAUDE-CONTINUE.md` §7, `finite-calendar-design.md` (§370, «Stage A»); код: `deals/repo.ts` (hold L191, release/HOLDER
L242–270), `wedding/reschedule.ts` L122–145, `resources/commitments.ts` (`legacyBoundary` L135), `resources/policy.ts`. База: main
ПОСЛЕ слияния T012 (миграции ≤1763700000000, OpenAPI 0.70.0). Ни одного A/U 370 не закрывает: задел для 030-T011/T012 (A01/A02).

## Решения драйвера (технические, записать в JOURNAL)
- D1. Одна миграция `1763800000000_legacy_calendar_sources.cjs`; `1763810000000` — только forward-фикс после наката на полную БД (D12).
- D2. **Нет HTTP/OpenAPI/UI в 370.** До 371 у владельца нет действия, которое что-то меняет; экран без пути решения — шум и риск прочтения
  как «календарь»; все пункты Stage A — уровня БД/домена; OpenAPI 0.70.0/generated не трогаем. Дверь `GET /vendor/legacy-calendar/sources`
  + `POST …/{sourceId}/capture` (Idempotency-Key, точные ревизии, текст «источник сохранён, границы не согласованы», никогда «свободен»)
  — в 371 вместе с предложениями границ. В 370 захват — экспорт домена, его вызывают тесты.
- D3. Обнаружение — триггерами БД на `vendor_busy_dates` и `deals`, а не правками TS-писателей: ловит все пути (бронь, PATCH, перенос,
  замена, ручной день, сырой SQL); новый замок — только KEY SHARE на уже удерживаемую писателем свадьбу (бронь FOR SHARE; PATCH,
  перенос, `reserve` FOR UPDATE) или компанию (ручной день FOR UPDATE). Файлы `src/**`, кроме нового модуля, не меняются.
- D4. Свежесть не хранится, а вычисляется: digest текущего материала против digest версии головы. Нет записей в чужих транзакциях →
  нет обратного порядка замков; хук не может дать согласие или «освободить» источник.
- D5. Один SQL-построитель `legacy_calendar_inventory_material(source)`; канон = `jsonb::text`, digest = SHA-256 этих байтов — оба
  считает SQL; TS не сериализует и не хеширует. `canonicalTermsJson` (условия заказа) не используется.
- D6. Владение историей: `app_day`/`app_root`/`live_negotiation` — история свадьбы (FK weddings CASCADE); `manual_day`/`orphan_day` —
  история компании (FK `company_id`→vendors CASCADE). `vendor_id` источника — идентичность без FK (как `vendor_id` в истории брони 365).
- D7. Строка дня: `id`, `created_at`, `vendor_id`, `date`, `source` неизменны (писатели их не правят — grep); меняется только указатель
  `deal_id` (release, перенос, FK SET NULL) → `source_revision+1`, тот же указатель — без роста. Строже дизайна: нет переклассификации.
- D8. Миграция делает платформенный захват (версия 1, `captured_by NULL`, `migration_backfill`) всех найденных источников — только тогда
  видна до-370 группа. Найденные позже живут с головой rev0 до явного захвата владельцем.
- D9. Корень, держащий день, — и держатель `app_day`, и (без ресурсной книги) отдельный `app_root`: обе идентичности сохраняются;
  «уникальных обязательств» 370 не считает. `live_negotiation` — durable-источник; «жив ли» — по часам при чтении, без записи.
- D10. `sourceRevision`: у дня — `vendor_busy_dates.source_revision`, пока строка есть, иначе '0'; у корней всегда '0' (счётчика у сделки
  нет, свежесть — только digest). `inventoryRevision` — ревизия головы. Чтение и захват — только текущий владелец компании.
- D11. Граница брони (`legacyBoundary`, `assertLegacyDateBookingAllowed`), политика, каталог, перенос — без изменений; инвентарь ни на
  одно решение не влияет; DTO `state` всегда `'unresolved'`.
- D12. down отказывает при любой строке любой из 4 таблиц (каждый источник хранит неизменяемый исходный снимок).

## Модель (миграция, стиль 365: `pgm.sql`, стражи `23514`)
1. `vendor_busy_dates`: `add column id uuid not null default gen_random_uuid()`, `source_revision bigint not null default 1 check>0`;
   `constraint vendor_busy_dates_identity unique(id)`; индекс `vendor_busy_dates_deal_link(deal_id) where deal_id is not null`.
   PK `(vendor_id,date)`, CHECK, FK и все значения — как были.
2. `legacy_calendar_sources`: `id uuid pk default gen_random_uuid()`; `kind` check in (`app_day`,`app_root`,`manual_day`,`orphan_day`,
   `live_negotiation`); `vendor_id uuid not null` (без FK); `wedding_id`→weddings on delete cascade; `company_id`→vendors on delete
   cascade; `day_id uuid`, `root_deal_id uuid` (без FK); `origin jsonb not null` (object); `discovered_by` in (`migration`,`writer`);
   `discovered_at timestamptz default clock_timestamp()`. CHECK: дни ⇔ `day_id` есть, `root_deal_id` NULL; корни — наоборот; app-виды
   ⇔ `wedding_id` есть, `company_id` NULL; manual/orphan ⇔ `company_id=vendor_id`, `wedding_id` NULL. `unique(day_id,kind)`,
   `unique(root_deal_id,kind)`; индексы `vendor_id`, `wedding_id`, `company_id`.
3. `legacy_calendar_versions`: `id uuid pk`; `source_id`→sources cascade; `revision bigint check>0`; `previous_version_id`; `canonical text`;
   `digest text`; `capture_kind` in (`migration_backfill`,`owner_capture`); `captured_by`→users on delete set null; `captured_at`;
   `unique(source_id,revision)`, `unique(source_id,id)`; FK `(source_id,previous_version_id)` deferrable initially deferred; CHECK
   `(revision=1)=(previous_version_id is null)`, `digest=encode(sha256(convert_to(canonical,'UTF8')),'hex')`,
   `canonical::jsonb::text=canonical`, `capture_kind<>'migration_backfill' or captured_by is null`.
4. `legacy_calendar_version_holders`: `source_id, version_id, wedding_id, deal_id` not null; `snapshot jsonb` (object); `fingerprint`
   = sha256(`snapshot::text`); `pk(version_id,wedding_id,deal_id)`; FK `(source_id,version_id)`→versions cascade; без FK на deals/weddings.
5. `legacy_calendar_heads`: `source_id pk`→sources cascade; `revision bigint default 0 check>=0`; `current_version_id`; CHECK
   `(revision=0)=(current_version_id is null)`; FK `(source_id,current_version_id)`→versions deferrable initially deferred.
   Колонки `currency` нигде нет (audit52 ждёт ровно 17 денежных таблиц).
6. Стражи (тексты фиксированы, тесты сверяют подстроку):
   - sources INSERT: `origin = legacy_calendar_origin(kind,day_id,root_deal_id)` (не NULL), vendor/wedding/company = фактическим, класс:
     manual_day⇔`source='manual'`; orphan_day⇔`'deal'`∧`deal_id` NULL; app_day⇔`'deal'`∧`deal_id` есть (свадьба = свадьба сделки);
     app_root⇔vendor есть ∧ COMMITTED ∧ нет головы брони revision>0; live_negotiation⇔`negotiating` — «legacy calendar source must
     match its actual operational origin». UPDATE — «legacy calendar source is immutable». DELETE (и у heads/versions/holders) — только
     если своей свадьбы/компании (родителя) уже нет: «legacy calendar history can only be erased with its wedding or company».
   - versions INSERT: голова `for update`; `revision=head+1`, `previous=head.current` («inventory version requires next exact head
     revision»); `canonical = material(source)::text` («inventory version must equal current material»); `migration_backfill` ⇒ rev 1 ∧
     `discovered_by='migration'`; `owner_capture` ⇒ `captured_by` = текущий `vendors.user_id` («inventory capture author must be the
     current company owner»). UPDATE — только `captured_by` X→NULL, когда X стёрт; иначе «inventory evidence is immutable».
   - holders INSERT: `snapshot` = элемент `holders` канона своей версии с теми же wedding/deal («inventory holder must match captured
     material»); UPDATE — «inventory evidence is immutable».
   - heads: INSERT только rev0/NULL; UPDATE: source неизменен, `revision=OLD+1`, версия `current` той же source с этой ревизией и
     `previous=OLD.current` («inventory head must advance by one exact revision»).
   - отложенный `check_legacy_calendar_inventory()` (constraint trigger на INSERT sources/versions/holders, INSERT/UPDATE heads; строк
     уже нет — пропуск): у источника есть голова; версия в цепочке предков головы («orphan inventory version»); число holders = длине `holders` канона
     («inventory version holders incomplete»).
   - `vendor_busy_dates` BEFORE INSERT: `source_revision=1` («source revision is maintained by the database»), `id` не встречался в
     sources («operational day identity cannot be reused»); BEFORE UPDATE: id/created_at/vendor_id/date/source неизменны
     («operational day identity is immutable»), `NEW.source_revision=OLD`, смена `deal_id` → +1.
7. Обнаружение (D3): AFTER INSERT `vendor_busy_dates` → `legacy_calendar_discover` по классу строки; AFTER UPDATE OF `deal_id` с
   не-NULL на NULL при `source='deal'` → `orphan_day` (осиротевший при каскаде день не остаётся без источника). AFTER INSERT OR UPDATE
   OF state,vendor_id на `deals` (vendor есть): вход в COMMITTED (или INSERT в нём) без головы брони revision>0 → `app_root`; вход в
   `negotiating` → `live_negotiation`. `discover` = insert source `on conflict (…,kind) do nothing` + голова rev0; существующие строки
   инвентаря не трогаются.
8. Накат: колонки → таблицы/функции/стражи → источники для каждой строки дня, каждого корня (vendor есть, COMMITTED, без книги), каждой
   `negotiating`-сделки с vendor → головы rev0 → `legacy_calendar_append_version(id,NULL,'migration_backfill')` для всех → триггеры на
   `vendor_busy_dates`/`deals`. Тотальность: orphan, чужой указатель, отменённая сделка, нет `deal_orders` — накат не роняют.
9. down: при строке в любой из 4 таблиц — `raise 'legacy calendar inventory evidence exists; use a preserving forward migration'`;
   иначе drop триггеров → holders, heads, versions, sources → функций → индекса/ограничения/колонок `vendor_busy_dates`.

## Материал (единый построитель), кодировка `legacy-calendar-inventory/1`
- Ключи: `encoding, sourceId, kind, vendorId, completeness ('complete'|'unknown'), reason (null|'orphan'|'mixed_scope'|'source_changed'),
  holders[]` (по weddingId, dealId). Дни: `day {id,vendorId,date,source,dealId,createdAt,sourceRevision}|null`, `pointer {dealId,
  weddingId,vendorId,state}|null`. Корни: `root` (holder|null); live_negotiation ещё `negotiation {negotiatingUntil,weddingArchived,
  weddingCancelled}`. holder = `{weddingId,dealId,vendorId,state,createdAt,bookedAt,doneAt,weddingDate, slot{id,categoryId,
  programEventId,selected}, order{version,resourcePlanRevision,resourcePlanId}|null, economics{price,currency,packageId},
  commitmentRevision, ownDays[]}` (ownDays — строки `'deal'` с этим `deal_id`).
- Правила: manual_day — строка есть → complete/[]; orphan_day → unknown/orphan/[]; app_day: нет строки → source_changed; `dealId` NULL →
  orphan; vendor указателя≠V ∨ state∉COMMITTED ∨ свадьба≠свадьбе источника → mixed_scope/[]; иначе complete, holders = сделки d свадьбы
  с `d.vendor_id=V`, COMMITTED и (d = указатель ∨ `state<>'done'` ∨ нет другой строки `'deal'` с `deal_id=d.id`) — ровно HOLDER из
  `releaseVendorDate` плюс указатель; корни с книгой не исключаются. app_root: сделка есть ∧ vendor=V ∧ COMMITTED ∧
  `commitmentRevision='0'` ∧ та же свадьба → [root], иначе source_changed/[]; live_negotiation — то же с `negotiating`.
- Кодировка: деньги/ревизии/версии — строки; дата `to_char(d,'YYYY-MM-DD')`; время `to_char(t at time zone 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`; UUID нижним регистром; массивы с `order by`. Не входят: платежи, имена/телефоны, названия/состав
  пакетов, свободный текст. Байты не зависят от TimeZone/DateStyle сессии.
- `legacy_calendar_present(source)`: дни — строка есть; app_root — complete; live_negotiation — complete ∧ `negotiating_until >
  clock_timestamp()` ∧ свадьба не в архиве/не отменена (= условия `legacyBoundary`).
- `legacy_calendar_append_version(source, captured_by, kind) → (version_id, revision, created)`: голова `for update`; канон = канону
  версии головы → no-op; иначе версия (rev+1, previous, digest в SQL) + holders из `material->'holders'` + UPDATE головы. Один путь
  для наката и захвата.

## Экспорт `backend/src/resources/legacy-source.ts` (одна транзакция вызывающего, точные ключи)
```ts
type CalendarSourceKind = 'app_day'|'app_root'|'manual_day'|'orphan_day'|'live_negotiation'
type CalendarFreshness = 'current'|'stale'|'unavailable'
interface InventoryInput { vendorId: string; actor: OrderActor }            // {userId,sessionId,policyVersion}
interface CaptureInventoryInput extends InventoryInput { sourceId: string; expectedSourceRevision: string; expectedInventoryRevision: string }
interface LegacyInventorySourceDto { sourceId: string; kind: CalendarSourceKind; originDate: string|null; sourceRevision: string
  inventoryRevision: string; state: 'unresolved'; freshness: CalendarFreshness; scopeCompleteness: 'complete'|'unknown'
  currentInventoryVersionId: string|null; holderCount: number; unavailableReason: 'orphan'|'mixed_scope'|'source_changed'|null }
interface LegacyInventoryView { vendorId: string; sources: LegacyInventorySourceDto[] }
interface ServerLocatedInventoryScope { sourceId: string; kind: CalendarSourceKind; vendorId: string; weddingIds: string[]
  dealIds: string[]; slotIds: string[]; dayIds: string[]; accountIds: string[] }   // внутреннее, не токен права
loadLegacyCalendarInventory(client, input: InventoryInput): Promise<LegacyInventoryView>
captureLegacyCalendarSource(client, input: CaptureInventoryInput): Promise<LegacyInventorySourceDto>
locateLegacyCalendarInventoryScope(client, input: { vendorId: string; sourceId: string }): Promise<ServerLocatedInventoryScope>
```
- Проекция (один SQL-запрос, digest из SQL): !present → `unavailable`; голова rev0 → `stale`; digest материала = digest версии головы →
  `current`; иначе `stale`. `scopeCompleteness`/`holderCount` — из материала, если present, иначе 'unknown'/0; `unavailableReason` =
  !present ? 'source_changed' : reason; `originDate` = `origin.date`|null; порядок `discovered_at, id`.
- `locate` (без замков, всё отсортировано): дни — `weddingIds` {свадьба источника, свадьба указателя}, `dealIds` {указатель} ∪ все
  сделки V в них (любого состояния), `dayIds` {строка} ∪ строки `'deal'` этих сделок; корни — `dealIds=[root]`, `dayIds` строки
  корня; `slotIds` — слоты `dealIds`; `accountIds` = [`vendors.user_id` V].
- `load` (ничего не пишет): ключи → `vendors.user_id` без замка = actor, иначе 403 → `lockOrderPrincipal` → users FOR SHARE [actor] →
  vendors FOR SHARE (нет / blocked / владелец удалён → 404; владелец сменился → 403) → проекция.
- `capture`, порядок замков: 1) ключи, UUID, ревизии `^(0|[1-9]\d{0,18})$` ≤ int8; 2) `located=locate()`: нет источника/чужой V → 404,
  владелец ≠ actor → 403; 3) weddings FOR UPDATE; 4) FOR SHARE: указатель/корень и COMMITTED-сделки V (не мягкие брони — иначе
  дедлок с массовым истечением jobs L321; на материал они не влияют) → их slots → deal_orders → deal_resource_commitments;
  5) `lockOrderPrincipal`; 6) users FOR SHARE [owner=actor]; 7) vendors FOR SHARE (как load); 8) `vendor_busy_dates` FOR SHARE (dayIds);
  9) голова FOR UPDATE; 10) `locate()` ≠ `located` → 409 `legacy_source_scope_changed`; 11) !present → 409 `legacy_source_unavailable`;
  `expectedSourceRevision`≠ → 409 `legacy_source_changed`; `expectedInventoryRevision`≠ → 409 `legacy_inventory_version_conflict`;
  12) `append(source, actor, 'owner_capture')`; при `created` — `audit_log('legacy_calendar.captured','legacy_calendar_source',
  {beforeRevision,revision,versionId})`; 13) проекция. После головы — ни новых свадеб, ни аккаунтов, ни компаний.

## Писатели и покрытие (TS не меняется)
`holdVendorDate` (book L284, PATCH deals L302, reschedule L157) — INSERT дня → app_day; `releaseVendorDate` — DELETE (→ unavailable)
или указатель (+1 → stale); `POST /vendor/calendar/busy` — manual INSERT/DELETE; reschedule — указатель на done, DELETE, новый день
(новая идентичность); `bookVendor` (INSERT `booked`) и PATCH deals (→negotiating/→COMMITTED) → live_negotiation/app_root; `reserve()`
пишет голову брони ДО `state='booked'` → app_root нет; payments booked→paid — не обнаружение; `cancelDeal` → корень unavailable;
истечение мягкой брони (repo L141, jobs L321) — по часам; purge/`eraseUser` удаляют строки дней до свадьбы → app-история уходит
каскадом свадьбы, manual/orphan — каскадом компании; стирание исполнителя (`vendor_id→NULL`) → его корни source_changed. Прочее
(заказ, план, слот, цена, пакет, книга брони) видно как stale через материал.

## Ошибки (домен; в OpenAPI — в 371)
422 `validation_failed` {inventory|vendorId|sourceId|actor|expectedSourceRevision|expectedInventoryRevision}; 401 (аккаунт удалён,
сессия завершена); 403 `forbidden` (нет согласия; «Инвентарём календаря распоряжается владелец компании»); 404 `not_found` («Источник
не найден», «Компания недоступна»); 409 `legacy_source_scope_changed`, `legacy_source_unavailable`, `legacy_source_changed`,
`legacy_inventory_version_conflict`. SQL: 23514 стражи, 23505 дубль идентичности, 23503 scoped FK (в т.ч. на COMMIT).

## HTTP / OpenAPI / UI — нет (D2). Ни маршрутов, ни схем, ни generated, ни экранов/карт/i18n; браузерного гейта нет.

## Тесты Stage A → `backend/test/legacyCalendarSources.test.ts`
Реальный PG, guard БД `tili_ecosystem_{inventory|full}_20260930_test`, реальные TX, свидетели `pg_blocking_pids` — в afterAll, уборка каскадами.
| Stage A (§7) | Тест |
|---|---|
| стабильный UUID/revision/no-op | T01 «идентичность дня»: uuid+rev1; указатель +1; `set source=source`/тот же указатель — без роста; смена id/vendor/date/source/created_at, явная revision, повтор удалённого id → 23514 |
| обнаружение у настоящих писателей | T02: бронь, PATCH →negotiating/→booked, ручной день, cancelDeal, перенос свадьбы, `reserve()` (нет app_root), истечение по часам |
| группа / done-other-day / ledgerless / orphan / mixed; manual без свадьбы | T03: общий день двух корней + done без строки; done со своей строкой — только в своей; корень без даты → свой app_root; orphan → unknown/orphan; чужой указатель → mixed_scope; manual — wedding NULL, holders 0; захват: holders = ожидаемым, канон = материалу |
| реальное ожидание → 409/stale | T04: новый держатель → `scope_changed`; перенос указателя → `legacy_source_changed`; смена владельца → `scope_changed`; отзыв сессии → 401; согласия → 403; удаление аккаунта → 401; двойной захват → один `legacy_inventory_version_conflict`; голова/версии/holders не меняются; прежняя версия → stale |
| DELETE/reinsert | T05: захват → отмена → unavailable, байты/digest версии прежние; повторная бронь той же даты → новая идентичность; захват unavailable → 409 |
| прямой SQL | T06: ≥10 отрицаний из Модели.6, каждое в своей TX, отложенные — на COMMIT |
| законный каскад свадьбы | T07: purge и `eraseUser` (владелец без наследника) удаляют только app-историю своей свадьбы; manual/orphan и чужие свадьбы целы; DELETE при живой свадьбе → 23514 |
| деньги/байты; нет нового free | T08: deals/payments/budget/`legacy_used`/строки дней байт-в-байт до/после захвата; граница, `assertLegacyDateBookingAllowed`, политика, занятость каталога — те же |
| identical capture no-op | T09: повтор → та же ревизия, нет строк и audit; после изменения → rev+1 с previous |
| чтение и права | T10: load ничего не пишет; current→stale→unavailable; resource_manager/чужой владелец → 403, blocked → 404, сессия → 401; 422 (лишний ключ, не UUID, '01', '-1', >int8) |
| полнота | T11: present-источники вендора = {строки дней} ∪ {COMMITTED-корни без книги} ∪ {живые мягкие брони} — независимым SQL по условиям `legacyBoundary` (не по счётчикам политики: там `committedDeals` включает и корни с книгой) |
| кодировка | T12: байты одинаковы при разных TimeZone/DateStyle; digest совпадает с SHA-256 из Node; числа — строки |
| populated forward, down после evidence, старые 365–369 | репетиция (ниже) + полный `init.sh` |

## Репетиция `backend/scripts/ecosystem-migration-drill.mjs` и serial
- `LATEST=1763800000000`, `PRE_INVENTORY=1763700000000`, `expectedOwn` += `1763800000000_legacy_calendar_sources`; `DATABASES` += два
  следующих свободных имени (ожидаемо drill17/18 — сверить после слияния T012); `assertNoBusinessData` += 4 таблицы.
- Пустые циклы проходят через 370: clean-фикстура не оставляет строк инвентаря (app — каскадом свадьбы, осиротевший день — каскадом
  компании); down/up восстанавливает схему точно.
- Populated: шаг «361→369» и его повтор — до `PRE_INVENTORY` (T012-проверка down по цепочке и `eraseCurrentVendorFixture` — до 370,
  без правок). В конце `inventoryForwardFixture(f)` под схемой 1763700000000: компания V2, свадьба W2: день r1 общий для booked Da и
  paid Db, done Dc со своей строкой r2 (другая дата), done Dd без строки; ledgerless booked Dl в W3 без даты; negotiating Dn; manual
  r3; orphan r4; mixed r5 (строка V2 → сделка другой компании); платежи у Db; `legacy_used>0`. Затем `up LATEST`: прежние строки по
  старой раскладке колонок неизменны; у дней разные id и rev '1'; источники ровно по правилу наката, головы/версии rev1,
  `captured_by NULL`, `digest=sha256(canonical)`, `canonical=material()::text`; holders: r1→{Da,Db,Dd}, r2→{Da,Db,Dc,Dd}, r3/r4/r5→∅
  (complete/orphan/mixed_scope), Dl→{Dl}, Dn→{Dn}; повтор up — снимок идентичен; scope `inventory` — ≥14 SQL-отрицаний (точный
  счётчик); exact-file down `1763800000000_legacy_calendar_sources` → отказ (+1 atomicDownCount); каскады: дни W2 + W2 → только
  app-история W2, удаление V2 → только manual/orphan V2. Прежние счётчики (98 + T012) сохраняются; итог — «синтетика, не согласие».
- `vitest.serial.json` += `test/legacyCalendarSources.test.ts` (audit53: `pg_stat_activity` + `pg_blocking_pids(`). Больше ничего.

## Разбиение (leaf)
Ветка `feature/030-370-legacy-inventory` от main после слияния T012 (до него — поверх ветки T012 с rebase). Драйвер до fan-out
создаёт `tili_ecosystem_inventory_20260930_test` (пустая → все миграции) и пустые drill17/18.
| Leaf | Что | OWNS (от `Тили-тили_код_и_документация/`) | Needs | Tier / модель |
|---|---|---|---|---|
| 1.3.1 | миграция + модуль + репетиция | `Тили-тили/backend/migrations/1763800000000_legacy_calendar_sources.cjs`, `Тили-тили/backend/src/resources/legacy-source.ts`, `Тили-тили/backend/scripts/ecosystem-migration-drill.mjs` | T012 в main | judgment / sonnet |
| 1.3.2 | независимые тесты: пишет по контракту параллельно с 1.3.1, реализацию не правит, падения — отчётом | `Тили-тили/backend/test/legacyCalendarSources.test.ts`, `Тили-тили/backend/vitest.serial.json` | прогон после 1.3.1 | judgment / sonnet |
| 1.3.3 | документы | `tasks/фичи/030-экосистема-local/{tasks.md,plan.md}` (строки 370), `JOURNAL.md`, `session-handoff.md`, `tasks/todo.md`, `Тили-тили/Тили-тили_Бизнес-логика_и_бэкенд.md` (§17: 4 таблицы, владение/удаление) | 1.3.1+1.3.2 VERIFIED | mechanical / haiku |
| node-1.3 | драйвер: накат на полную БД ПОСЛЕДНИМ, `bash init.sh`, drill18, opus-ревью, PR | — | 1.3.1–1.3.3 | opus |
Прогоны с БД строго по очереди: 1.3.1 (drill17; tsc/eslint; незащищённые сьюты на inventory-БД: stage3 stage4 audit4 audit4b audit22
audit26 audit28 audit29 audit47 audit51 audit52 audit53 accept019 offers019 booking019 shortlist019 orderLegacyIntegration orderTerms
orderCancellationAccess jobs) → 1.3.2 (свой файл там же) → драйвер (полная БД: 16 защищённых сьютов + full).

## Риски и чек-лист независимого Opus-ревьюера
1. Замки триггеров: каждый путь обнаружения уже держит свадьбу (`lockBookingContext` book.ts L71 FOR SHARE; PATCH deals L193,
   reschedule L42, `lockOrderContext` — FOR UPDATE); у app-источников нет FK на vendors; существующие строки инвентаря не блокируются.
2. Группа = HOLDER (`repo.ts` L248–256) + указатель; перенос на done (reschedule L122–145); корни с книгой в группе дня; r2 содержит
   текущие корни свадьбы — консервативная область, а не доказательство работы в этот день.
3. Кодировка: независимость от сессии, числа строками, `canonical::jsonb::text=canonical`, digest только из SQL.
4. Накат на грязной полной БД: тотальность, индекс `deal_link`, время; после наката туда — только forward-фикс 1763810000000.
5. Каскады: purge/eraseUser/сырые DELETE проходят; DELETE-страж пускает только исчезнувшую свадьбу/компанию; отложенные FK; SET NULL.
6. Поведение не изменилось: дифф строго в OWNS; граница/политика/каталог/перенос — тот же код; отрицания 365–369 и T012 в репетиции;
   полный init зелёный. Неизменяемость строки дня (D7) строже дизайна — подтвердить grep'ом.
7. Будущее: смена построителя в 371 сделает все источники stale — версия кодировки обязательна. Приватность: без платежей/имён/
   телефонов/пакетов; UUID исполнителя в чужих свадьбах сохраняется (как в 365).

## Чего 370 НЕ делает (это 371+)
Нет таблиц/полей границ, предложений, активации, принятия, person scope, spans, receipts, resource_occupancy, manual occupancy; нет
proposed/effective и состояний free/finite/reserved; нет новых purpose/токенов/schema3; нет HTTP/OpenAPI/UI; нет правок существующих
TS-писателей, `legacyBoundary`, счётчиков политики, каталога, переноса, `legacy_used`. Вопросов владельцу нет: развилки технические (D1–D12).


## Примечание передачи Codex, 2026-10-03

### Уточнения после проверок текущей реализации

Два отложенных инварианта проверяются на каждую версию: первая версия при голове rev0 также обязана войти в цепочку головы; промежуточная версия не может потерять holders, даже если следующая полная версия создана в той же транзакции. Условие допустимости origin — `ok IS TRUE`, включая отказ при SQL NULL (external root без vendor не принадлежит компании).

D3 уточнён для прямого удаления свадьбы: BEFORE DELETE закрепляет KEY SHARE фактических компаний её deal-days, отсортированных по UUID, до каскадного изменения дня. Прежняя формулировка «только уже удерживаемая компания» была недостаточна для raw cascade: actual `pg_blocking_pids`/COMMIT показал deadlock `40P01` с manual writer (company → day против day → company). Штатные purge/eraseUser заранее удаляют deal-days; существующие TS-писатели не изменены. Этот pin не создаёт согласия, границ или освобождения занятости.

Проверяемые регрессии находятся в `backend/test/legacyCalendarSources.test.ts`, T06/T07; логи до исправления сохранены как `vitest-codex380-before-guard.log`, `vitest-codex380-before-nullguard.log`, `vitest-codex380-before-cascade.log` в `.unlazy/tz-full-20261002/logs/`. Текущая targeted проверка: 65 inventory + 6 audit53 = 71, без пропусков. Полная приёмка и публикация подтверждаются отдельно.

Следующий независимый review выявил потерю app_day при переносе указателя D1(W1)→D2(W2) и удалении W1. Root воспроизвёл её для той же и чужой компании. После применения380 выполнен preserving forward381: история W1 стирается по D6, живой день получает новый источник W2 с головой rev0, прежние строки/версии не переписываются. BEFORE DELETE company union включает сохранённые дни app_day этой свадьбы. Поздний замок чужой W2 берётся KEY SHARE NOWAIT; занятый W2 даёт55P03 и откат всей операции, без ожидания в обратном порядке. Три новые regressions дали3failed/71passed до381 и74passed после381. Backfill только дополняет отсутствующие app_day/heads, без версии или согласия. Накат381 рассчитан на остановленных писателей; отсутствие всех возможных deadlock массового SQL DELETE этим не подтверждается.

Это согласованный дизайн Claude rev1, а не принятая реализация. Исходный локальный c370-contract.md SHA256 0b69ab510b255193e359434ec5ea06283bfcc601870a1a6007001c0f25f756b4. Название этапа370 историческое; фактический номер новой миграции1763800000000, поскольку1763700000000 занят022/T012.

Уточнения драйвера из status.log/PLAN: документы с фактами — judgment, независимое ревью обязательно проверяет возможный обратный замок vendors при orphan-day через каскад свадьбы. Названия моделей в историческом контракте не являются обязательным маршрутом для другого runtime. Назначай только доступные модели и осмысленные роли. Тест owner-change в удалённой ветке уже ожидает403 (d2464d5); локальная копияbde3e40 отстаёт. После поручения сначала сверить HEAD и незавершённую работу, не запускать старую волну поверх другой сессии.

Никогда не исполнять команды из документа вслепую: текущие URL/DB/live identity/guards/ownership проверяются перед каждым существенным этапом. Здесь нет разрешения production или заявления готовности всех WP00–WP16.
