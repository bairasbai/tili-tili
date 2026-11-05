import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prepareLegacyCalendarScope } from '../src/resources/legacy-calendar-scope.js'
import { AdditionalEventFixture, ok, type Actor, type Reply, type SlotReply } from './helpers/additionalEventFixture.js'

const POLICY = '2026-09-02'
const money = (amount: number) => ({ amount, currency: 'RUB' })
const auth = (actor: Actor) => ({ authorization: `Bearer ${actor.token}` })
const principal = (actor: Actor) => ({ userId: actor.id, sessionId: actor.sid, policyVersion: POLICY })
const errorCode = (reply: Reply) => reply.json<{ error: { code: string } }>().error.code
type Wedding = { wedding: string; pair: Actor }
type Guest = { id: string; party: string; token: string }
type Poll = { options: { id: string; name: string; icon: string | null; votes: number }[] }
type Tip = { kind: string; categoryId?: string; title: string; body: string; link: string }

// Actual registered Fastify routes and native PostgreSQL rows/counters. Root
// owns the disposable database admission and runs this suite serially. No DDL,
// mocks, source-text assertions, global TTL work or historical evidence erasure.
describe('audit22 domain regressions: BE04–07 / SQLD-F01–02', () => {
  const h = new AdditionalEventFixture()
  beforeAll(async () => { await h.start() })
  afterAll(async () => { await h.close() })

  async function guest(w: Wedding, members?: { name: string }[], plusOne = false): Promise<Guest> {
    const created = ok<{ id: string }>(await h.call('A22_GUEST_CREATE', w.pair, { method: 'POST',
      url: `/weddings/${w.wedding}/guests`, payload: { name: 'Алексей audit22', plusOne, ...(members ? { members } : {}) } }), 201)
    const link = ok<{ url: string }>(await h.call('A22_GUEST_LINK', w.pair, { method: 'POST',
      url: `/weddings/${w.wedding}/guests/${created.id}/invite-link` }))
    const code = link.url.split('/').pop(); assert(code)
    const opened = await h.app.inject({ method: 'GET', url: `/invite/${code}` })
    expect(opened.statusCode, opened.body).toBe(200)
    const party = (await h.db.query<{ party_id: string }>('select party_id from guests where id=$1', [created.id])).rows[0]!
    return { id: created.id, party: party.party_id, token: opened.json<{ guestToken: string }>().guestToken }
  }
  async function gift(w: Wedding, amount = 100) {
    return ok<{ id: string; funded: { amount: number } }>(await h.call('A22_GIFT_CREATE', w.pair, { method: 'POST',
      url: `/weddings/${w.wedding}/wishlist`, payload: { name: 'Складчина audit22', price: money(amount), group: true } }), 201)
  }
  function contribute(g: Guest, id: string, amount: number, key: string) {
    return h.app.inject({ method: 'POST', url: `/gifts/${g.token}/${id}/fund`,
      headers: { 'idempotency-key': key }, payload: { amount: money(amount) } })
  }
  async function contributionState(id: string) {
    return (await h.db.query<{ funded: string; rows: string; sum: string }>(`select g.funded::text,
      (select count(*)::text from gift_contributions c where c.gift_id=g.id) rows,
      (select coalesce(sum(amount),0)::text from gift_contributions c where c.gift_id=g.id) sum
      from gifts g where g.id=$1`, [id])).rows[0]
  }

  it('BE04 final contribution retry with the same key returns success and keeps one native effect', async () => {
    const w = await h.fixture(), g = await guest(w), item = await gift(w), key = randomUUID()
    const first = await contribute(g, item.id, 100, key)
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json()).toMatchObject({ id: item.id, funded: money(100), reserved: true })
    const retry = await contribute(g, item.id, 100, key)
    expect(retry.statusCode, retry.body).toBe(200)
    expect(retry.json()).toEqual(first.json())
    expect(await contributionState(item.id)).toEqual({ funded: '100', rows: '1', sum: '100' })
    const another = await contribute(g, item.id, 1, randomUUID())
    expect(another.statusCode).toBe(409); expect(errorCode(another)).toBe('gift_closed')
    expect(await contributionState(item.id)).toEqual({ funded: '100', rows: '1', sum: '100' })
  })

  it('BE04 a saved closing key still rejects another amount/target and malformed amounts', async () => {
    const w = await h.fixture(), g = await guest(w), item = await gift(w), other = await gift(w, 200), key = randomUUID()
    expect((await contribute(g, item.id, 100, key)).statusCode).toBe(200)
    for (const [id, amount] of [[item.id, 99], [other.id, 100]] as const) {
      const refused = await contribute(g, id, amount, key)
      expect(refused.statusCode, refused.body).toBe(409)
      expect(errorCode(refused)).toBe('idempotency_key_reused')
    }
    const invalid = await contribute(g, item.id, 0, key)
    expect(invalid.statusCode).toBe(422)
    expect(await contributionState(item.id)).toEqual({ funded: '100', rows: '1', sum: '100' })
    expect(await contributionState(other.id)).toEqual({ funded: '0', rows: '0', sum: '0' })
  })

  it('BE04 partial same-key control remains successful without a second contribution', async () => {
    const w = await h.fixture(), g = await guest(w), item = await gift(w), key = randomUUID()
    const first = await contribute(g, item.id, 50, key), retry = await contribute(g, item.id, 50, key)
    expect(first.statusCode, first.body).toBe(200); expect(retry.statusCode, retry.body).toBe(200)
    expect(retry.json()).toEqual(first.json())
    expect(await contributionState(item.id)).toEqual({ funded: '50', rows: '1', sum: '50' })
  })

  it('BE05 PUT an existing like stays204 at the cap while the501st distinct story is refused', async () => {
    const actor = await h.actor(), url = '/inspiration/likes/audit22-existing'
    const first = await h.app.inject({ method: 'PUT', url, headers: auth(actor) })
    expect(first.statusCode, first.body).toBe(204)
    await h.db.query(`insert into inspiration_likes(user_id,story_id)
      select $1,'audit22-seed-'||n::text from generate_series(1,499) n`, [actor.id])
    const retry = await h.app.inject({ method: 'PUT', url, headers: auth(actor) })
    expect(retry.statusCode, retry.body).toBe(204)
    const added = await h.app.inject({ method: 'PUT', url: '/inspiration/likes/audit22-new', headers: auth(actor) })
    expect(added.statusCode, added.body).toBe(429); expect(errorCode(added)).toBe('likes_limit')
    const listed = await h.app.inject({ method: 'GET', url: '/inspiration/likes', headers: auth(actor) })
    expect(listed.statusCode, listed.body).toBe(200)
    expect(listed.json<{ storyIds: string[] }>().storyIds).toHaveLength(500)
    expect((await h.db.query("select story_id from inspiration_likes where user_id=$1 and story_id in ('audit22-existing','audit22-new')", [actor.id])).rows)
      .toEqual([{ story_id: 'audit22-existing' }])
  })

  async function people(party: string) {
    return (await h.db.query<{ id: string; name: string; is_placeholder: boolean; rsvp: string }>(
      'select id,name,is_placeholder,rsvp from guests where party_id=$1 order by party_position', [party])).rows
  }
  it('BE06 legacy plusOne=true reuses the named second person and preserves individual RSVP', async () => {
    const w = await h.fixture(), g = await guest(w, [{ name: 'Мария — отдельный человек' }]), before = await people(g.party)
    expect(before).toHaveLength(2); expect(before[1]!.is_placeholder).toBe(false)
    const reply = await h.app.inject({ method: 'POST', url: `/rsvp/${g.token}`, payload: { status: 'yes', plusOne: true } })
    expect(reply.statusCode, reply.body).toBe(200)
    expect(await people(g.party)).toEqual([{ ...before[0]!, rsvp: 'yes' }, before[1]!])
    const repeat = await h.app.inject({ method: 'POST', url: `/rsvp/${g.token}`, payload: { status: 'yes', plusOne: true } })
    expect(repeat.statusCode, repeat.body).toBe(200)
    expect(await people(g.party)).toHaveLength(2)
  })
  it('BE06 legacy plusOne=false preserves a named human and their separately confirmed RSVP', async () => {
    const w = await h.fixture(), g = await guest(w, [{ name: 'Мария — отдельный человек' }]), before = await people(g.party)
    const named = before[1]!
    const answered = await h.app.inject({ method: 'POST', url: `/rsvp/${g.token}`,
      payload: { members: [{ guestId: named.id, status: 'yes' }] } })
    expect(answered.statusCode, answered.body).toBe(200)
    const reply = await h.app.inject({ method: 'POST', url: `/rsvp/${g.token}`, payload: { status: 'yes', plusOne: false } })
    expect(reply.statusCode, reply.body).toBe(200)
    expect(await people(g.party)).toEqual([{ ...before[0]!, rsvp: 'yes' }, { ...named, rsvp: 'yes' }])
  })
  it('BE06 a generated placeholder can still be added once and removed explicitly', async () => {
    const w = await h.fixture(), g = await guest(w)
    for (let n = 0; n < 2; n++) {
      const reply = await h.app.inject({ method: 'POST', url: `/rsvp/${g.token}`, payload: { status: 'yes', plusOne: true } })
      expect(reply.statusCode, reply.body).toBe(200)
      const current = await people(g.party); expect(current).toHaveLength(2); expect(current[1]!.is_placeholder).toBe(true)
    }
    const reply = await h.app.inject({ method: 'POST', url: `/rsvp/${g.token}`, payload: { status: 'yes', plusOne: false } })
    expect(reply.statusCode, reply.body).toBe(200)
    expect((await people(g.party)).map(p => p.id)).toEqual([g.id])
  })

  it('BE07 saving retained dishes returns their native votes, ignores submitted totals and drops removed votes', async () => {
    const w = await h.fixture(), a = await guest(w), b = await guest(w), url = `/weddings/${w.wedding}/menu-poll`
    const initial = ok<Poll>(await h.call('A22_MENU_INITIAL', w.pair, { method: 'PUT', url,
      payload: { options: [{ name: 'Рыба' }, { name: 'Мясо' }] } }))
    const [fish, meat] = initial.options; assert(fish && meat)
    for (const [person, option] of [[a, fish], [b, meat]] as const) {
      const voted = await h.app.inject({ method: 'POST', url: `/join/${person.token}/menu-vote`, payload: { optionId: option.id } })
      expect(voted.statusCode, voted.body).toBe(200)
    }
    const before = ok<Poll>(await h.call('A22_MENU_BEFORE', w.pair, { method: 'GET', url }))
    expect(before.options.map(o => o.votes)).toEqual([1, 1])
    const saved = ok<Poll>(await h.call('A22_MENU_SAVE', w.pair, { method: 'PUT', url,
      payload: { options: [{ id: fish.id, name: 'Рыба запечённая', votes: 999 }, { name: 'Салат', votes: 999 }] } }))
    expect(saved.options.find(o => o.id === fish.id)).toMatchObject({ name: 'Рыба запечённая', votes: 1 })
    expect(saved.options.find(o => o.id !== fish.id)).toMatchObject({ name: 'Салат', votes: 0 })
    expect(ok<Poll>(await h.call('A22_MENU_AFTER', w.pair, { method: 'GET', url })).options).toEqual(saved.options)
    expect((await h.db.query('select guest_id,option_id from menu_votes where guest_id=any($1::uuid[]) order by guest_id', [[a.id, b.id]])).rows)
      .toEqual([{ guest_id: a.id, option_id: fish.id }])
  })

  it('SQLD-F01 actual owner also in couple accepts as performer and the other partner as customer', async () => {
    const f = await h.fixture(), booked = ok<SlotReply>(await h.book(f)); assert(booked.deal)
    const deal = booked.deal.id
    await h.db.tx(async client => {
      await prepareLegacyCalendarScope(client, { weddingIds: [f.wedding], extraAccountIds: [f.company.actor.id], actor: principal(f.pair) })
      await client.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [f.wedding, f.company.actor.id])
    })
    const list = await h.call('A22_MOVE_ETAG', f.pair, { method: 'GET', url: `/weddings/${f.wedding}/events` })
    ok(list); assert(typeof list.headers.etag === 'string')
    const base = `/weddings/${f.wedding}/events/${f.event.id}/move-proposals`
    const proposal = ok<{ id: string; digest: string }>(await h.call('A22_MOVE_PROPOSE', f.pair, { method: 'POST', url: base,
      key: randomUUID(), headers: { 'if-match': list.headers.etag },
      payload: { date: f.event.date!, timeZone: f.event.timeZone!, location: 'Новое согласованное место audit22' } }), 201)
    const root = `/deals/${deal}/event-moves/${proposal.id}`
    type Root = { digest: string; readToken: string; receipts: { party: string; userId: string; sessionId: string }[] }
    let customerToken = ''
    for (const [actor, party] of [[f.pair, 'customer'], [f.company.actor, 'performer']] as const) {
      const read = ok<Root>(await h.call('A22_MOVE_READ', actor, { method: 'GET', url: root }))
      if (party === 'customer') customerToken = read.readToken
      const accepted = ok<Root>(await h.call('A22_MOVE_ACCEPT', actor, { method: 'POST', url: root + '/accept', key: randomUUID(),
        payload: { digest: read.digest, readToken: read.readToken } }))
      expect(accepted.receipts).toContainEqual(expect.objectContaining({ party, userId: actor.id, sessionId: actor.sid }))
    }
    const state = ok<Root>(await h.call('A22_MOVE_RECEIPTS', f.pair, { method: 'GET', url: root }))
    expect(state.receipts).toHaveLength(2)
    expect(new Set(state.receipts.map(r => r.userId)).size).toBe(2)
    const borrowed = await h.call('A22_MOVE_BORROWED_READ', f.company.actor, { method: 'POST', url: root + '/accept', key: randomUUID(),
      payload: { digest: state.digest, readToken: customerToken } })
    expect(borrowed.statusCode, borrowed.body).toBe(422)
    const applied = await h.call('A22_MOVE_APPLY', f.pair, { method: 'POST', url: base + `/${proposal.id}/apply`, key: randomUUID(), payload: { digest: proposal.digest } })
    expect(applied.statusCode, applied.body).toBe(200)
    expect((await h.db.query('select location from wedding_events where id=$1', [f.event.id])).rows)
      .toEqual([{ location: 'Новое согласованное место audit22' }])
    expect((await h.db.query('select party,user_id from event_move_receipts where proposal_id=$1 order by party', [proposal.id])).rows)
      .toEqual([{ party: 'customer', user_id: f.pair.id }, { party: 'performer', user_id: f.company.actor.id }])
  })

  async function nearWedding() {
    const pair = await h.actor()
    const date = (await h.db.query<{ main: string; extra: string }>(`select (current_date+30)::text main,(current_date+31)::text extra`)).rows[0]!
    const city = (await h.db.query<{ id: string; name: string; region: string }>(`select c.id,c.name,c.region from cities c
      where c.tz is not null and not exists(select 1 from vendors v join cities vc on vc.id=v.city_id
        where v.category_id='photo' and v.published_at is not null and vc.name=c.name)
      order by c.id limit 1`)).rows[0]
    assert(city)
    const created = ok<{ id: string }>(await h.call('A22_TIPS_WEDDING', pair, { method: 'POST', url: '/weddings',
      payload: { partnerName: 'Audit22', date: date.main, city: { name: city.name, region: city.region } } }), 201)
    // Each hints case gets a city without earlier published photo fixtures,
    // including this suite's still-live resources company. Never clear catalog.
    expect((await h.db.query('select city_id from weddings where id=$1', [created.id])).rows).toEqual([{ city_id: city.id }])
    return { wedding: created.id, pair, date, city }
  }
  async function companyIn(city: { id: string }) {
    const company = await h.company()
    await h.db.tx(async client => {
      await prepareLegacyCalendarScope(client, { vendorIds: [company.id], actor: principal(company.actor) })
      await client.query('update vendors set city_id=$2 where id=$1', [company.id, city.id])
    })
    return company
  }
  async function tips(w: Wedding) {
    return ok<{ items: Tip[] }>(await h.call('A22_TIPS_READ', w.pair, { method: 'GET', url: `/weddings/${w.wedding}/tips` })).items
  }
  it('SQLD-F02 additional position uses its own date and labels candidate counts without a free promise', async () => {
    const w = await nearWedding(), company = await companyIn(w.city)
    const event = await h.event(w.wedding, w.pair, w.date.extra, 'Asia/Novosibirsk')
    const slot = await h.slot(w.wedding, w.pair, event)
    const positions = ok<{ id: string; label: string; categoryId: string }[]>(await h.call('A22_TIPS_SLOTS', w.pair,
      { method: 'GET', url: `/weddings/${w.wedding}/slots` }))
    const extra = positions.find(s => s.id === slot), main = positions.find(s => s.categoryId === 'photo' && s.id !== slot)
    assert(extra && main)
    await h.db.tx(async client => {
      await prepareLegacyCalendarScope(client, { vendorIds: [company.id], actor: principal(company.actor) })
      await client.query("insert into vendor_busy_dates(id,vendor_id,date,source) values($1,$2,$3,'manual')", [randomUUID(), company.id, w.date.extra])
    })
    const actual = (await tips(w)).filter(t => t.kind === 'deficit' && t.categoryId === 'photo')
    const mainTip = actual.find(t => t.title.includes(main.label)), extraTip = actual.find(t => t.title.includes(extra.label))
    expect(mainTip).toBeDefined(); expect(extraTip).toBeDefined()
    expect(mainTip!.title).toContain(': 1'); expect(extraTip!.title).toContain(': 0')
    expect(actual.map(t => t.title).join(' ')).not.toMatch(/свободн/i)
    expect(extraTip!.body).toMatch(/подтверд|соглас/i)
  })
  it('SQLD-F02 resource companies and an undated event do not produce a numerical availability claim', async () => {
    const w = await nearWedding(), company = await companyIn(w.city)
    ok(await h.call('A22_TIPS_RESOURCE', company.actor, { method: 'POST', url: `/vendors/${company.id}/resources`, key: randomUUID(),
      payload: { kind: 'equipment', label: 'Ресурс требует точного интервала audit22' } }))
    ok(await h.call('A22_TIPS_POLICY', company.actor, { method: 'PATCH', url: `/vendors/${company.id}/availability-policy`, key: randomUUID(),
      payload: { mode: 'resources', expectedRevision: '0' } }))
    const event = await h.event(w.wedding, w.pair, null, 'Asia/Novosibirsk')
    await h.slot(w.wedding, w.pair, event)
    const actual = (await tips(w)).filter(t => t.kind === 'deficit' && t.categoryId === 'photo')
    // No exact resource/time material was selected. Omitting the availability
    // tip is valid; a generic confirmation tip must avoid false numeric facts.
    for (const tip of actual) {
      expect(tip.title).not.toMatch(/свободн|:\s*\d/i)
      expect(tip.body).toMatch(/подтверд|соглас|дат|врем/i)
    }
  })

  it('SQLD-F02 candidate horizon follows the event local calendar at the eight-month boundary', async () => {
    const w = await nearWedding()
    // The two real IANA clocks are26 hours apart, so at least one local DATE
    // differs from the DB session DATE. Select an actual boundary fixture,
    // without mocking Date/PG clock or changing session/global time settings.
    const edge = (await h.db.query<{ zone: string; service_date: string; own_today: string; db_today: string;
      own_months: number; db_months: number }>(`with clock as materialized (
        select current_timestamp stamp,current_date db_today
      ), zones as (
        select zone,(c.stamp at time zone zone)::date own_today,c.db_today
        from clock c cross join (values ('Pacific/Kiritimati'),('Etc/GMT+12')) z(zone)
      ), days as (
        select (c.db_today+interval '8 months')::date+n service_date from clock c cross join generate_series(-35,35) n
      ), candidates as (
        select z.*,d.service_date,
          (extract(year from age(d.service_date,z.own_today))*12+extract(month from age(d.service_date,z.own_today)))::int own_months,
          (extract(year from age(d.service_date,z.db_today))*12+extract(month from age(d.service_date,z.db_today)))::int db_months
        from zones z cross join days d
      ) select zone,service_date::text,own_today::text,db_today::text,own_months,db_months from candidates
      where (own_months<8)<>(db_months<8) order by zone,service_date limit 1`)).rows[0]
    assert(edge, 'A real own-TZ/DB-calendar horizon boundary must exist')
    expect(edge.own_today).not.toBe(edge.db_today)
    expect(edge.own_months < 8).not.toBe(edge.db_months < 8)
    const event = await h.event(w.wedding, w.pair, edge.service_date, edge.zone)
    await h.slot(w.wedding, w.pair, event)
    const extra = (await tips(w)).filter(t => t.kind === 'deficit' && t.categoryId === 'photo'
      && t.title.includes('Synthetic independent additional photo'))
    expect(extra.length, JSON.stringify(edge)).toBe(edge.own_months < 8 ? 1 : 0)
  })

  it('SQLD-F02 candidate search retains the additional slot instead of reopening its primary category position', async () => {
    const w = await nearWedding(), event = await h.event(w.wedding, w.pair, w.date.extra, 'Asia/Novosibirsk')
    const slot = await h.slot(w.wedding, w.pair, event)
    const extra = (await tips(w)).find(t => t.kind === 'deficit' && t.categoryId === 'photo'
      && t.title.includes('Synthetic independent additional photo'))
    assert(extra, 'Expected the empty additional position candidate hint')
    const destination = new URL(extra.link, 'https://synthetic.invalid')
    expect(destination.pathname).toBe('/search/photo')
    // Search already admits explicit slotId and fails closed on a foreign or
    // missing selected position; omission otherwise selects the primary slot.
    expect(destination.searchParams.getAll('slotId')).toEqual([slot])
  })
})
