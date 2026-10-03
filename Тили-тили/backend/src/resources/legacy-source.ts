import type { Queryable } from '../plugins/db.js'
import { conflict, forbidden, notFound, validationFailed } from '../errors.js'
import { isUuid } from '../ids.js'
import { lockOrderPrincipal, type OrderActor } from '../orders/context.js'
import { objectValues } from '../orders/model.js'

/**
 * 030/370: технический инвентарь прежнего календаря (DATE-строки и корни без
 * ресурсной книги) — чтение, захват владельцем и область замков.
 *
 * Модуль ничего не решает за владельца и никому не разрешает дату: «источник
 * сохранён» не значит «границы согласованы», а `state` всегда `'unresolved'`.
 * Граница брони (`legacyBoundary`), политика, каталог и перенос свадьбы этим
 * модулем не затронуты — инвентарь ни на одно их решение не влияет.
 *
 * Материал источника строит один SQL-построитель
 * `legacy_calendar_inventory_material(source)`. Его канон — `jsonb::text`, а
 * отпечаток — SHA-256 этих байтов; оба считает база. TypeScript здесь ничего
 * не сериализует и не хеширует: вторая копия кодировки разошлась бы с первой
 * на первой же новой колонке. Свежесть не хранится — это сравнение отпечатка
 * текущего материала с отпечатком версии головы, поэтому у чужих транзакций
 * нет записей в инвентарь и нет обратного порядка замков.
 *
 * Все функции работают в транзакции вызывающего (`Queryable` — клиент `tx`).
 */

export type CalendarSourceKind = 'app_day' | 'app_root' | 'manual_day' | 'orphan_day' | 'live_negotiation'
export type CalendarFreshness = 'current' | 'stale' | 'unavailable'
type ScopeCompleteness = 'complete' | 'unknown'
type UnavailableReason = 'orphan' | 'mixed_scope' | 'source_changed'

export interface InventoryInput { vendorId: string; actor: OrderActor }
export interface CaptureInventoryInput extends InventoryInput {
  sourceId: string; expectedSourceRevision: string; expectedInventoryRevision: string
}
export interface LegacyInventorySourceDto {
  sourceId: string; kind: CalendarSourceKind; originDate: string | null; sourceRevision: string
  inventoryRevision: string; state: 'unresolved'; freshness: CalendarFreshness
  scopeCompleteness: ScopeCompleteness; currentInventoryVersionId: string | null; holderCount: number
  unavailableReason: UnavailableReason | null
}
export interface LegacyInventoryView { vendorId: string; sources: LegacyInventorySourceDto[] }
/** Внутренняя область замков и сверки: не токен права и не разрешение на действие. */
export interface ServerLocatedInventoryScope {
  sourceId: string; kind: CalendarSourceKind; vendorId: string; weddingIds: string[]
  dealIds: string[]; slotIds: string[]; dayIds: string[]; accountIds: string[]
}

const OWNER_ONLY = 'Инвентарём календаря распоряжается владелец компании'
const INT8_MAX = 9223372036854775807n
const REVISION_RE = /^(0|[1-9]\d{0,18})$/

/** Точный состав ключей: лишний ключ — такой же отказ, как недостающий. */
function exactKeys(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  const value = objectValues(input, 'inventory')
  const keys = Object.keys(value)
  if (keys.length !== allowed.length || keys.some(key => !allowed.includes(key))) {
    throw validationFailed({ inventory: 'Нужен точный состав полей запроса' })
  }
  return value
}
function entityId(value: unknown, field: string): string {
  if (!isUuid(value)) throw validationFailed({ [field]: 'Нужен идентификатор' })
  return value.toLowerCase()
}
function actorOf(value: unknown): OrderActor {
  const actor = objectValues(value, 'actor')
  const keys = Object.keys(actor)
  if (keys.length !== 3 || keys.some(key => !['userId', 'sessionId', 'policyVersion'].includes(key)) ||
    !isUuid(actor.userId) || !isUuid(actor.sessionId) ||
    typeof actor.policyVersion !== 'string' || !actor.policyVersion || actor.policyVersion.length > 100) {
    throw validationFailed({ actor: 'Нужна действующая сторона, сессия и версия согласия' })
  }
  return { userId: actor.userId.toLowerCase(), sessionId: actor.sessionId.toLowerCase(), policyVersion: actor.policyVersion }
}
function revisionOf(value: unknown, field: string): string {
  if (typeof value !== 'string' || !REVISION_RE.test(value) || BigInt(value) > INT8_MAX) {
    throw validationFailed({ [field]: 'Нужна точная ревизия' })
  }
  return value
}

interface ProjectionRow {
  source_id: string; kind: CalendarSourceKind; origin_date: string | null; source_revision: string
  inventory_revision: string; current_version_id: string | null; freshness: CalendarFreshness
  scope_completeness: ScopeCompleteness; holder_count: number; unavailable_reason: UnavailableReason | null
}

/**
 * Проекция источников одним SQL-запросом: «есть ли источник сейчас», материал и
 * отпечаток текущего материала считает база. Не присутствует — `unavailable`;
 * голова ревизии 0 — `stale`; отпечаток совпал с отпечатком версии головы —
 * `current`, иначе `stale`. Полнота и число держателей берутся из материала,
 * пока источник присутствует. `where` — фиксированный текст этого файла, не ввод.
 */
async function project(client: Queryable, where: 'vendor' | 'source', id: string): Promise<LegacyInventorySourceDto[]> {
  const predicate = where === 'vendor' ? 's.vendor_id = $1' : 's.id = $1'
  const rows = (await client.query<ProjectionRow>(`
    select s.id::text as source_id, s.kind, s.origin->>'date' as origin_date,
      case when s.day_id is null then '0'
        else coalesce((select b.source_revision::text from vendor_busy_dates b where b.id = s.day_id), '0') end as source_revision,
      h.revision::text as inventory_revision, h.current_version_id::text as current_version_id,
      case when not p.present then 'unavailable'
        when h.revision = 0 then 'stale'
        when encode(pg_catalog.sha256(convert_to(m.mat::text, 'UTF8')), 'hex') = v.digest then 'current'
        else 'stale' end as freshness,
      case when p.present then m.mat->>'completeness' else 'unknown' end as scope_completeness,
      case when p.present then jsonb_array_length(m.mat->'holders') else 0 end as holder_count,
      case when not p.present then 'source_changed' else m.mat->>'reason' end as unavailable_reason
    from legacy_calendar_sources s
    join legacy_calendar_heads h on h.source_id = s.id
    left join legacy_calendar_versions v on v.id = h.current_version_id
    cross join lateral (select legacy_calendar_present(s) as present) p
    cross join lateral (select legacy_calendar_inventory_material(s) as mat) m
    where ${predicate}
    order by s.discovered_at, s.id`, [id])).rows
  return rows.map(r => ({
    sourceId: r.source_id, kind: r.kind, originDate: r.origin_date, sourceRevision: r.source_revision,
    inventoryRevision: r.inventory_revision, state: 'unresolved' as const, freshness: r.freshness,
    scopeCompleteness: r.scope_completeness, currentInventoryVersionId: r.current_version_id,
    holderCount: r.holder_count, unavailableReason: r.unavailable_reason,
  }))
}

interface LocatedInventory { scope: ServerLocatedInventoryScope; lockDealIds: string[] }
interface LocateRow {
  source_id: string; kind: CalendarSourceKind; vendor_id: string; wedding_ids: string[]; deal_ids: string[]
  slot_ids: string[]; day_ids: string[]; account_ids: string[]; lock_deal_ids: string[]
}

/**
 * Область источника без замков, одним запросом (один снимок), всё отсортировано.
 *
 * Дни: свадьбы — источника и указателя; сделки — указатель плюс все сделки
 * компании в этих свадьбах (любого состояния); дни — строка источника плюс
 * строки `'deal'` этих сделок. Корни: сделка — сам корень, дни — его строки.
 * Слоты — слоты найденных сделок; аккаунт — владелец компании.
 *
 * `lockDealIds` — подмножество для замков чтения: указатель/корень и закреплённые
 * сделки компании. Мягкие брони не берём: их массово снимает расписание, и
 * замок на них встал бы поперёк его порядка; на материал они не влияют.
 */
async function locate(client: Queryable, vendorId: string, sourceId: string): Promise<LocatedInventory> {
  const row = (await client.query<LocateRow>(`
    with src as (
      select s.id, s.kind, s.vendor_id, s.wedding_id, s.day_id, s.root_deal_id
        from legacy_calendar_sources s where s.id = $2 and s.vendor_id = $1
    ), day as (
      select b.id, b.deal_id from vendor_busy_dates b where b.id = (select day_id from src)
    ), anchor as (
      select coalesce((select deal_id from day), (select root_deal_id from src)) as deal_id
    ), weds as (
      select wedding_id as id from src where wedding_id is not null
      union
      select d.wedding_id from deals d where d.id = (select deal_id from anchor)
    ), deal_ids as (
      select deal_id as id from anchor where deal_id is not null
      union
      select d.id from deals d
       where (select day_id from src) is not null
         and d.vendor_id = (select vendor_id from src) and d.wedding_id in (select id from weds)
    ), day_ids as (
      select id from day
      union
      select b.id from vendor_busy_dates b where b.source = 'deal' and b.deal_id in (select id from deal_ids)
    ), slot_ids as (
      select d.slot_id as id from deals d where d.id in (select id from deal_ids)
    ), lock_deals as (
      select d.id from deals d
       where d.id = (select deal_id from anchor)
          or (d.id in (select id from deal_ids) and d.vendor_id = (select vendor_id from src)
              and d.state in ('booked', 'paid_deposit', 'done'))
    )
    select s.id::text as source_id, s.kind, s.vendor_id::text as vendor_id,
      coalesce((select array_agg(id::text order by id) from weds), '{}') as wedding_ids,
      coalesce((select array_agg(id::text order by id) from deal_ids), '{}') as deal_ids,
      coalesce((select array_agg(id::text order by id) from slot_ids), '{}') as slot_ids,
      coalesce((select array_agg(id::text order by id) from day_ids), '{}') as day_ids,
      coalesce((select array_agg(v.user_id::text order by v.user_id) from vendors v where v.id = s.vendor_id), '{}') as account_ids,
      coalesce((select array_agg(id::text order by id) from lock_deals), '{}') as lock_deal_ids
    from src s`, [vendorId, sourceId])).rows[0]
  if (!row) throw notFound('Источник не найден')
  return {
    scope: { sourceId: row.source_id, kind: row.kind, vendorId: row.vendor_id, weddingIds: row.wedding_ids,
      dealIds: row.deal_ids, slotIds: row.slot_ids, dayIds: row.day_ids, accountIds: row.account_ids },
    lockDealIds: row.lock_deal_ids,
  }
}

/**
 * Владелец и компания под замками: заказные замки принципала (аккаунт, сессия,
 * согласие), затем аккаунты области и сама компания. Компания, которой нет,
 * заблокирована или чей владелец удалён, — 404; сменившийся владелец — 403.
 */
async function pinOwner(client: Queryable, vendorId: string, actor: OrderActor, accountIds: readonly string[]): Promise<void> {
  await lockOrderPrincipal(client, actor)
  await client.query('select id from users where id = any($1::uuid[]) order by id for share', [accountIds])
  const company = (await client.query<{ user_id: string; blocked_at: Date | null; owner_deleted: boolean }>(
    `select v.user_id, v.blocked_at, u.deleted_at is not null as owner_deleted
       from vendors v left join users u on u.id = v.user_id
      where v.id = $1 for share of v`, [vendorId])).rows[0]
  if (!company || company.blocked_at !== null || company.owner_deleted) throw notFound('Компания недоступна')
  if (company.user_id !== actor.userId) throw forbidden(OWNER_ONLY)
}

/** Чтение ничего не пишет: только замки на принципала и компанию, затем проекция. */
export async function loadLegacyCalendarInventory(client: Queryable, input: InventoryInput): Promise<LegacyInventoryView> {
  const value = exactKeys(input, ['vendorId', 'actor'])
  const vendorId = entityId(value.vendorId, 'vendorId'), actor = actorOf(value.actor)
  const located = (await client.query<{ user_id: string }>('select user_id from vendors where id = $1', [vendorId])).rows[0]
  if (!located) throw notFound('Компания недоступна')
  if (located.user_id !== actor.userId) throw forbidden(OWNER_ONLY)
  await pinOwner(client, vendorId, actor, [located.user_id])
  return { vendorId, sources: await project(client, 'vendor', vendorId) }
}

/** Область источника для будущих замков других этапов; без замков и без права. */
export async function locateLegacyCalendarInventoryScope(
  client: Queryable, input: { vendorId: string; sourceId: string },
): Promise<ServerLocatedInventoryScope> {
  const value = exactKeys(input, ['vendorId', 'sourceId'])
  return (await locate(client, entityId(value.vendorId, 'vendorId'), entityId(value.sourceId, 'sourceId'))).scope
}

/**
 * Замки чтения на закреплённый финансовый состав: сделки, их слоты, заказы и
 * книги брони. Порядок тот же, что у стирания и ресурсной брони.
 */
async function lockFinancialUnion(client: Queryable, dealIds: readonly string[]): Promise<void> {
  if (!dealIds.length) return
  await client.query('select id from deals where id = any($1::uuid[]) order by id for share', [dealIds])
  await client.query(`select s.id from slots s where s.id in (select d.slot_id from deals d where d.id = any($1::uuid[]))
    order by s.id for share of s`, [dealIds])
  await client.query('select deal_id from deal_orders where deal_id = any($1::uuid[]) order by deal_id for share', [dealIds])
  await client.query('select deal_id from deal_resource_commitments where deal_id = any($1::uuid[]) order by deal_id for share', [dealIds])
}

/**
 * Захват источника владельцем компании: новая версия инвентаря, если материал
 * изменился, иначе тот же результат без записи. Порядок замков:
 * ключи → область без замков → свадьбы → закреплённые сделки, слоты, заказы,
 * книги → принципал → аккаунт владельца → компания → дни → голова → повторная
 * область → сверка ревизий → запись → проекция. После головы новых свадеб,
 * аккаунтов и компаний не берётся.
 */
export async function captureLegacyCalendarSource(client: Queryable, input: CaptureInventoryInput): Promise<LegacyInventorySourceDto> {
  const value = exactKeys(input, ['vendorId', 'actor', 'sourceId', 'expectedSourceRevision', 'expectedInventoryRevision'])
  const vendorId = entityId(value.vendorId, 'vendorId'), sourceId = entityId(value.sourceId, 'sourceId'), actor = actorOf(value.actor)
  const expectedSourceRevision = revisionOf(value.expectedSourceRevision, 'expectedSourceRevision')
  const expectedInventoryRevision = revisionOf(value.expectedInventoryRevision, 'expectedInventoryRevision')

  const located = await locate(client, vendorId, sourceId)
  const [ownerId] = located.scope.accountIds
  if (!ownerId) throw notFound('Компания недоступна')
  if (ownerId !== actor.userId) throw forbidden(OWNER_ONLY)

  await client.query('select id from weddings where id = any($1::uuid[]) order by id for update', [located.scope.weddingIds])
  await lockFinancialUnion(client, located.lockDealIds)
  await pinOwner(client, vendorId, actor, located.scope.accountIds)
  await client.query('select id from vendor_busy_dates where id = any($1::uuid[]) order by id for share', [located.scope.dayIds])
  const head = (await client.query('select source_id from legacy_calendar_heads where source_id = $1 for update', [sourceId])).rows[0]
  if (!head) throw notFound('Источник не найден')

  // Область сверяется целиком; кроме того, ни одна сделка, которую теперь надо
  // было бы закрепить, не должна оказаться вне уже взятых замков: сузившийся
  // набор безопасен (замок лишний), расширившийся — нет, и новых замков после
  // головы не берётся.
  const relocated = await locate(client, vendorId, sourceId)
  if (JSON.stringify(relocated.scope) !== JSON.stringify(located.scope) ||
    relocated.lockDealIds.some(id => !located.lockDealIds.includes(id))) {
    throw conflict('legacy_source_scope_changed', 'Состав источника изменился — обновите данные')
  }
  const before = (await project(client, 'source', sourceId))[0]
  if (!before) throw notFound('Источник не найден')
  if (before.freshness === 'unavailable') throw conflict('legacy_source_unavailable', 'Источник больше не доступен')
  if (before.sourceRevision !== expectedSourceRevision) throw conflict('legacy_source_changed', 'Источник изменился — обновите данные')
  if (before.inventoryRevision !== expectedInventoryRevision) {
    throw conflict('legacy_inventory_version_conflict', 'Версия инвентаря изменилась — обновите данные')
  }

  const appended = (await client.query<{ version_id: string; revision: string; created: boolean }>(
    "select version_id::text as version_id, revision, created from legacy_calendar_append_version($1, $2, 'owner_capture')",
    [sourceId, actor.userId])).rows[0]!
  if (appended.created) {
    await client.query("insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,'legacy_calendar.captured','legacy_calendar_source',$2,$3::jsonb)",
      [actor.userId, sourceId, JSON.stringify({ beforeRevision: before.inventoryRevision, revision: appended.revision, versionId: appended.version_id })])
  }
  const after = (await project(client, 'source', sourceId))[0]
  if (!after) throw notFound('Источник не найден')
  return after
}
