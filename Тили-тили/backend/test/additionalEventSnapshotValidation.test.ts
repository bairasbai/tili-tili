import assert from 'node:assert/strict'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AdditionalEventFixture, EVENT_DATE, EVENT_TZ, ok, type Case, type SlotReply } from './helpers/additionalEventFixture.js'

// Independent structural requirements. No migration module, production validator
// implementation or constructor output is used as the expected boolean oracle.
const TOP = ['schemaVersion', 'weddingId', 'programVersion', 'wedding', 'event', 'otherEvents', 'slots', 'roots', 'eventObligations', 'physical']
const OBLIGATIONS = ['timeline_events', 'vendor_staff_duties', 'guest_event_invitations', 'event_guest_participation',
  'event_rsvp_requests', 'offer_requests', 'offers', 'external_invites', 'external_program_acknowledgments',
  'vendor_program_acknowledgments', 'timeline_assignments', 'timeline_dependencies']
const PHYSICAL = ['vendors', 'days', 'groups', 'heads', 'known', 'candidates', 'outside', 'facts']
const DOMAIN = ['deals', 'deal_orders', 'order_assignments', 'order_parts', 'deal_events', 'payments', 'payment_installments',
  'payment_corrections', 'payment_installment_edits', 'deal_terms_versions', 'deal_terms_receipts', 'deal_resource_plan_versions',
  'deal_resource_commitments', 'deal_resource_commitment_versions', 'deal_resource_commitment_members', 'resource_allocations',
  'payment_receipts', 'vendor', 'policy', 'vendor_live_allocations', 'vendor_staff_duties']
type Obj = Record<string, unknown>
const emit = (phase: string, value: unknown) => process.stdout.write(`ADDITIONAL_SNAPSHOT_${phase} ${JSON.stringify(value)}\n`)
const object = (value: unknown): Obj => {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Obj
}
const array = (value: unknown): unknown[] => { assert(Array.isArray(value)); return value }
const keys = (value: unknown, expected: readonly string[]) => expect(Object.keys(object(value)).sort()).toEqual([...expected].sort())
const emptyArrays = (names: readonly string[]) => Object.fromEntries(names.map(name => [name, []]))
function independentEmpty(): Obj {
  const wedding = '96000000-0000-4000-8000-000000000001'
  return { schemaVersion: 1, weddingId: wedding, programVersion: '0', wedding: {},
    event: { id: '96000000-0000-4000-8000-000000000002', wedding_id: wedding,
      is_main: false, date: EVENT_DATE, time_zone: EVENT_TZ, location: null, rsvp_deadline: null },
    otherEvents: [], slots: [], roots: [], eventObligations: emptyArrays(OBLIGATIONS), physical: emptyArrays(PHYSICAL) }
}

describe.sequential('native event move snapshot structural validation', () => {
  const h = new AdditionalEventFixture()
  let known: { fixture: Case; deal: string; material: Obj } | undefined
  beforeAll(() => h.start())
  afterAll(() => h.close())

  async function validate(label: string, value: unknown, sqlNull = false): Promise<boolean> {
    try {
      const rows = (await h.db.query<{ valid: boolean }>('select event_move_snapshot_valid($1::jsonb) valid',
        [sqlNull ? null : JSON.stringify(value)])).rows
      expect(rows).toHaveLength(1); expect(typeof rows[0]!.valid).toBe('boolean')
      emit('VALIDATION', { label, sqlNull, value, valid: rows[0]!.valid }); return rows[0]!.valid
    } catch (error) {
      const native = error as { code?: string; constraint?: string; message?: string }
      emit('NATIVE_ERROR', { label, sqlNull, code: native.code ?? null, constraint: native.constraint ?? null, message: native.message ?? null })
      throw error
    }
  }
  async function reject(label: string, original: Obj, change: (copy: Obj) => void): Promise<void> {
    const copy = structuredClone(original); change(copy)
    expect(await validate(label, copy), label).toBe(false)
  }
  async function booked() {
    if (known) return known
    const fixture = await h.fixture(), reply = ok<SlotReply>(await h.book(fixture))
    assert(reply.deal)
    const deal = reply.deal.id, current = await h.scope(fixture, deal)
    expect(current).toHaveLength(1)
    expect(current[0]).toMatchObject({ deal_id: deal, event_id: fixture.event.id, performer_kind: 'catalog',
      vendor_id: fixture.company.id, binding_state: 'active', service_date: EVENT_DATE, time_zone: EVENT_TZ,
      exact_head: true, matches_current: true })
    // These direct facts predate the constructor observation and independently
    // establish that this is the one tracked own known-price selected root.
    const facts = (await h.db.query(`select d.id,d.wedding_id,d.slot_id,d.vendor_id,d.state,d.price::text,
      s.deal_id selected,s.program_event_id,e.date::text,e.time_zone,e.is_main
      from deals d join slots s on s.id=d.slot_id and s.wedding_id=d.wedding_id
      join wedding_events e on e.wedding_id=d.wedding_id and e.id=s.program_event_id
      where d.id=$1 and d.wedding_id=$2`, [deal, fixture.wedding])).rows
    expect(facts).toEqual([{ id: deal, wedding_id: fixture.wedding, slot_id: fixture.slot, vendor_id: fixture.company.id,
      state: 'booked', price: '2468000', selected: deal, program_event_id: fixture.event.id,
      date: EVENT_DATE, time_zone: EVENT_TZ, is_main: false }])
    const material = object((await h.db.query<{ material: unknown }>(
      'select event_move_source_snapshot($1,$2) material', [fixture.wedding, fixture.event.id])).rows[0]!.material)
    keys(material, TOP); keys(material.eventObligations, OBLIGATIONS); keys(material.physical, PHYSICAL)
    expect(material.weddingId).toBe(fixture.wedding)
    expect(object(material.event)).toMatchObject({ id: fixture.event.id, wedding_id: fixture.wedding,
      is_main: false, date: EVENT_DATE, time_zone: EVENT_TZ })
    const roots = array(material.roots); expect(roots).toHaveLength(1)
    const root = object(roots[0]); keys(root, ['dealId', 'domain', 'day']); expect(root.dealId).toBe(deal)
    keys(root.domain, DOMAIN); keys(root.day, ['heads', 'versions'])
    expect(array(object(root.domain).deals)).toHaveLength(1)
    expect(array(object(root.domain).deal_orders)).toHaveLength(1)
    expect(array(object(root.day).heads)).toHaveLength(1)
    expect(array(object(material.physical).known).some(row => object(row).id === current[0]!.id)).toBe(true)
    known = { fixture, deal, material }; emit('GENUINE_CONSTRUCTOR_FACTS', { facts, current, material }); return known
  }
  function firstRoot(value: Obj) { const roots = array(value.roots); assert(roots.length); return object(roots[0]) }

  it('S0 meaningful RED: independent closed empty-root structure must return TRUE rather than native22P02', async () => {
    const value = independentEmpty()
    keys(value, TOP); keys(value.eventObligations, OBLIGATIONS); keys(value.physical, PHYSICAL)
    expect(await validate('INDEPENDENT_EMPTY_VALID', value)).toBe(true)
    // Shape-valid empty roots do not make an actual affected move scope.
    const rows = (await h.db.query<{ supported: boolean }>('select event_move_scope_supported($1::jsonb) supported', [JSON.stringify(value)])).rows
    expect(rows).toEqual([{ supported: false }])
  })
  it('S1 genuine public tracked booked root constructor is structurally valid and supported', async () => {
    const value = await booked()
    expect(await validate('GENUINE_BOOKED_VALID', value.material)).toBe(true)
    expect((await h.db.query<{ supported: boolean }>('select event_move_scope_supported($1::jsonb) supported',
      [JSON.stringify(value.material)])).rows).toEqual([{ supported: true }])
  })
  it('S2 top and event required identity/type fields refuse missing, NULL or extra keys', async () => {
    const value = independentEmpty()
    await reject('TOP_EXTRA', value, copy => { copy.unreviewed = [] })
    await reject('TOP_MISSING_WEDDING', value, copy => { delete copy.weddingId })
    await reject('TOP_NULL_SCHEMA', value, copy => { copy.schemaVersion = null })
    await reject('TOP_STRING_SCHEMA', value, copy => { copy.schemaVersion = '1' })
    await reject('EVENT_MISSING_MAIN', value, copy => { delete object(copy.event).is_main })
    await reject('EVENT_NULL_MAIN', value, copy => { object(copy.event).is_main = null })
    await reject('EVENT_OTHER_WEDDING', value, copy => { object(copy.event).wedding_id = '96000000-0000-4000-8000-000000000003' })
  })
  it('S3 obligation object is closed and every obligation value is an array', async () => {
    const value = independentEmpty()
    await reject('OBLIGATION_EXTRA', value, copy => { object(copy.eventObligations).unreviewed = [] })
    await reject('OBLIGATION_MISSING', value, copy => { delete object(copy.eventObligations).offer_requests })
    await reject('OBLIGATION_OBJECT', value, copy => { object(copy.eventObligations).offers = {} })
    await reject('OBLIGATION_NULL', value, copy => { object(copy.eventObligations).offers = null })
  })
  it('S4 physical object is closed and every physical value is an array', async () => {
    const value = independentEmpty()
    await reject('PHYSICAL_EXTRA', value, copy => { object(copy.physical).unreviewed = [] })
    await reject('PHYSICAL_MISSING', value, copy => { delete object(copy.physical).days })
    await reject('PHYSICAL_OBJECT', value, copy => { object(copy.physical).known = {} })
    await reject('PHYSICAL_NULL', value, copy => { object(copy.physical).known = null })
  })
  it('S5 genuine root domain requires closed array recordsets and exactly one deal/order', async () => {
    const { material } = await booked()
    await reject('DOMAIN_EXTRA', material, copy => { object(firstRoot(copy).domain).unreviewed = [] })
    await reject('DOMAIN_MISSING', material, copy => { delete object(firstRoot(copy).domain).payments })
    await reject('DOMAIN_NON_ARRAY', material, copy => { object(firstRoot(copy).domain).payments = {} })
    await reject('DOMAIN_NON_OBJECT_ENTRY', material, copy => { object(firstRoot(copy).domain).payments = [1] })
    await reject('DOMAIN_MISSING_DEAL', material, copy => { object(firstRoot(copy).domain).deals = [] })
    await reject('DOMAIN_MISSING_ORDER', material, copy => { object(firstRoot(copy).domain).deal_orders = [] })
  })
  it('S6 genuine root/day requires closed keys, array heads/versions and distinct root identities', async () => {
    const { material } = await booked()
    await reject('DAY_EXTRA', material, copy => { object(firstRoot(copy).day).unreviewed = [] })
    await reject('DAY_MISSING', material, copy => { delete object(firstRoot(copy).day).heads })
    await reject('DAY_NON_ARRAY', material, copy => { object(firstRoot(copy).day).heads = {} })
    await reject('DAY_NULL', material, copy => { object(firstRoot(copy).day).versions = null })
    await reject('ROOT_DUPLICATE', material, copy => { const roots = array(copy.roots); roots.push(structuredClone(roots[0])) })
    await reject('ROOT_MISSING_ID', material, copy => { delete firstRoot(copy).dealId })
  })
  it('S7 SQL NULL, JSON null/scalars/array and a missing required object are explicit FALSE', async () => {
    expect(await validate('SQL_NULL', null, true)).toBe(false)
    for (const value of [null, false, 1, 'not-an-object', []]) expect(await validate('JSON_NON_OBJECT', value)).toBe(false)
    await reject('TOP_MISSING_OBJECT', independentEmpty(), copy => { delete copy.wedding })
  })
})
