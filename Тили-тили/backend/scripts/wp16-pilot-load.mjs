import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { availableParallelism, cpus, release, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'
import { setTimeout as wait } from 'node:timers/promises'

const mode = process.argv[2]
assert(process.argv.length === 3 && (mode === 'smoke' || mode === 'full'), 'Use smoke or full')
assert.equal(process.env.NODE_ENV, 'test', 'Use NODE_ENV=test')
const database = new URL(process.env.WP16_DATABASE_URL ?? '')
assert.equal(database.protocol, 'postgres:')
assert.equal(database.hostname, '127.0.0.1')
assert.equal(database.port, '15432')
assert.equal(database.username, 'codex_test')
assert.equal(database.password, '')
assert.match(database.pathname, new RegExp('^/tili_wp16_load_' + mode + '[0-9]*_test$'))
assert.equal(database.search + database.hash, '')

const { buildApp } = await import('../src/app.ts')
const { signAccessToken } = await import('../src/auth/tokens.ts')
const { prepareLegacyCalendarScope } = await import('../src/resources/legacy-calendar-scope.ts')
const accessSecret = randomBytes(32).toString('hex')
const policyVersion = '2026-09-02'
const app = await buildApp({
  env: 'test', databaseUrl: database.href, redisUrl: null, corsOrigins: [],
  mediaStorage: null, receiptsStorage: null, sentryDsn: null,
  smsProvider: null, smsAeroEmail: null, smsAeroKey: null, smsAeroSign: null,
  vapidPublicKey: null, vapidPrivateKey: null,
  jwtAccessSecret: accessSecret, jwtRefreshSecret: randomBytes(32).toString('hex'), policyVersion,
}, [], { tillyModel: null })
const port = 43106
const origin = 'http://127.0.0.1:' + port

const profile = { guests: 500, events: 10, tasks: 1000, performers: 50, messages: 10000 }
const teamSize = 40
const performerSessions = 10
const durationMs = (mode === 'smoke' ? 12 : 15 * 60) * 1000
const intervalMs = 1000

async function seed(db) {
  const wedding = randomUUID()
  let chat
  const team = Array.from({ length: teamSize }, () => ({ id: randomUUID(), sid: randomUUID(), taskId: randomUUID() }))
  const performers = Array.from({ length: profile.performers }, () => ({ id: randomUUID(), sid: randomUUID(), vendorId: randomUUID() }))
  const stranger = { id: randomUUID(), sid: randomUUID() }
  const extraEventIds = Array.from({ length: profile.events - 1 }, () => randomUUID())
  await db.tx(async client => {
    // Empty, dedicated DB only. The advisory lock serializes competing fixture creators.
    await client.query('select pg_advisory_xact_lock(1665800362)')
    // Bulk DATE fixtures run the calendar guard once per row. The higher
    // timeout is local to setup; measured requests retain the pool default.
    await client.query("set local statement_timeout = '180s'")
    const { rows: [identity] } = await client.query(`select current_database() as db, current_user as role,
      host(inet_server_addr()) as host, inet_server_port() as port,
      (select count(*)::int from users) as users, (select count(*)::int from weddings) as weddings`)
    assert.deepEqual(identity, { db: database.pathname.slice(1), role: 'codex_test', host: '127.0.0.1', port: 15432, users: 0, weddings: 0 })

    const accounts = [...team, ...performers, stranger]
    await client.query(`insert into users(id,phone,name)
      select id,'+1555010'||lpad(n::text,4,'0'),'Synthetic account '||n
      from unnest($1::uuid[]) with ordinality as u(id,n)`, [accounts.map(user => user.id)])
    await client.query(`insert into sessions(id,user_id,refresh_hash)
      select id,user_id,gen_random_uuid()::text from unnest($1::uuid[],$2::uuid[]) as s(id,user_id)`,
    [accounts.map(user => user.sid), accounts.map(user => user.id)])
    await client.query(`insert into consents(id,user_id,policy_version,adult)
      select gen_random_uuid(),id,$2,true from unnest($1::uuid[]) as u(id)`, [accounts.map(user => user.id), policyVersion])
    await client.query(`insert into weddings(id,owner_id,title,date,tz,invite_code)
      values($1,$2,'Synthetic load wedding','2040-06-14','Europe/Moscow',gen_random_uuid()::text)`, [wedding, team[0].id])
    await client.query(`insert into wedding_members(wedding_id,user_id,role)
      select $1,id,case when n=1 then 'couple' when n=2 then 'coordinator' else 'helper' end
      from unnest($2::uuid[]) with ordinality as u(id,n)`, [wedding, team.map(user => user.id)])
    await client.query(`insert into wedding_events(id,wedding_id,name,kind,date,time_zone)
      select id,$1,'Synthetic event '||n,'other',date '2040-06-14'+n::int,'Europe/Moscow'
      from unnest($2::uuid[]) with ordinality as e(id,n)`, [wedding, extraEventIds])
    const mainEvent = (await client.query('select id from wedding_events where wedding_id=$1 and is_main', [wedding])).rows[0]
    assert(mainEvent, 'Wedding insert must create its main event')
    const eventIds = [mainEvent.id, ...extraEventIds]

    const vendorIds = performers.map(user => user.vendorId)
    const scope = await prepareLegacyCalendarScope(client, { weddingIds: [wedding], vendorIds, personIds: performers.map(user => user.id) })
    await client.query(`insert into vendors(id,user_id,category_id,name,published_at)
      select id,user_id,'photo','Synthetic performer '||n,now()
      from unnest($1::uuid[],$2::uuid[]) with ordinality as v(id,user_id,n)`,
    [vendorIds, performers.map(user => user.id)])
    const slotIds = Array.from({ length: profile.performers }, () => randomUUID())
    await client.query(`insert into slots(id,wedding_id,category_id,label,program_event_id,sort)
      select id,$1,'photo','Synthetic position '||n,($3::uuid[])[1+((n-1)%cardinality($3::uuid[]))::int],n
      from unnest($2::uuid[]) with ordinality as s(id,n)`, [wedding, slotIds, eventIds])
    await client.query(`with created as (
      insert into deals(id,wedding_id,slot_id,vendor_id,state,price)
      select gen_random_uuid(),$1,slot_id,vendor_id,'booked',100000
      from unnest($2::uuid[],$3::uuid[]) as d(slot_id,vendor_id)
      returning id,slot_id
    ) update slots s set deal_id=d.id from created d where s.id=d.slot_id`, [wedding, slotIds, vendorIds])
    await client.query(`insert into vendor_busy_dates(vendor_id,date,source,deal_id)
      select d.vendor_id,e.date,'deal',d.id from deals d join slots s on s.id=d.slot_id
      join wedding_events e on e.id=s.program_event_id where d.wedding_id=$1`, [wedding])
    await scope.assertCurrent()

    await client.query(`with parties as (
      insert into guest_parties(id,wedding_id,invite_token)
      select gen_random_uuid(),$1,gen_random_uuid()::text from generate_series(1,$2::int/2) returning id
    ) insert into guests(id,wedding_id,name,rsvp_token,party_id,party_position)
      select gen_random_uuid(),$1,'Synthetic guest '||n,gen_random_uuid()::text,id,n
      from parties cross join generate_series(1,2) as n`, [wedding, profile.guests])
    await client.query(`insert into tasks(id,wedding_id,title,due,due_mode,assignee_id,sort)
      select coalesce(($3::uuid[])[n],gen_random_uuid()),$1,'Synthetic task '||n,'2040-06-15','fixed',
        ($4::uuid[])[1+(n-1)%cardinality($4::uuid[])],n
      from generate_series(1,$2::int) n`, [wedding, profile.tasks, team.map(user => user.taskId), team.map(user => user.id)])
    chat = (await client.query("select id from chats where wedding_id=$1 and kind='team'", [wedding])).rows[0]?.id
    assert(chat, 'Wedding insert must create its team chat')
    await client.query(`insert into messages(id,chat_id,sender_id,text,created_at)
      select gen_random_uuid(),$1,$2,'Synthetic message '||n,statement_timestamp()-(n/3)*interval '1 millisecond'
      from generate_series(1,$3::int) n`, [chat, team[0].id, profile.messages])
  })
  const actual = (await db.query(`select
    (select count(*)::int from guests where wedding_id=$1) guests,
    (select count(*)::int from wedding_events where wedding_id=$1) events,
    (select count(*)::int from tasks where wedding_id=$1) tasks,
    (select count(distinct vendor_id)::int from deals where wedding_id=$1 and state='booked') performers,
    (select count(*)::int from messages where chat_id=$2) messages`, [wedding, chat])).rows[0]
  assert.deepEqual(actual, profile)
  return { wedding, chat, team, performers, stranger }
}

async function bearer(user) {
  return 'Bearer ' + await signAccessToken(accessSecret, { sub: user.id, sid: user.sid })
}

function request(method, path, authorization, done) {
  const headers = { authorization }
  if (method === 'PATCH') headers['content-type'] = 'application/json'
  return fetch(origin + path, {
    method, headers, redirect: 'error', signal: AbortSignal.timeout(10000),
    ...(method === 'PATCH' ? { body: JSON.stringify({ done }) } : {}),
  })
}

async function json(path, authorization, expected = 200) {
  const response = await request('GET', path, authorization)
  assert.equal(response.status, expected, path.split('?')[0])
  return response.json()
}

async function chatTraversal(path, authorization) {
  const ids = new Set()
  let cursor = null
  let deepCursor = null
  let pages = 0
  do {
    const params = new URLSearchParams({ limit: '100' })
    if (cursor) params.set('cursor', cursor)
    const result = await json(path + '?' + params, authorization)
    assert.equal(result.items.length, 100)
    for (const item of result.items) {
      assert(!ids.has(item.id), 'Message pagination returned a duplicate')
      ids.add(item.id)
    }
    assert(++pages <= profile.messages / 100, 'Message pagination exceeded expected pages')
    cursor = result.nextCursor
    if (pages === 75) deepCursor = cursor
  } while (cursor)
  assert.equal(ids.size, profile.messages)
  assert(deepCursor, 'Expected an interior page cursor')
  return { deepCursor, pages }
}

const definitions = {
  guests: { method: 'GET', p95Limit: 800 },
  events: { method: 'GET', p95Limit: 800 },
  tasks: { method: 'GET', p95Limit: 800 },
  week: { method: 'GET', p95Limit: 800 },
  slots: { method: 'GET', p95Limit: 800 },
  chatLatest: { method: 'GET', p95Limit: 800 },
  chatOlder: { method: 'GET', p95Limit: 800 },
  vendorDeals: { method: 'GET', p95Limit: 800 },
  taskToggle: { method: 'PATCH', p95Limit: 1500 },
}
const teamMix = ['guests', 'tasks', 'chatLatest', 'events', 'slots', 'week', 'chatOlder', 'taskToggle']
const stats = Object.fromEntries(Object.keys(definitions).map(name => [name, { timings: [], status: {}, bytes: 0, transport: 0 }]))

function percentile(sorted, quantile) {
  return sorted.length ? Math.round(sorted[Math.ceil(sorted.length * quantile) - 1] * 10) / 10 : null
}

async function measure(fixture, paths) {
  const team = fixture.team.map(user => ({ ...user, vendor: false }))
  const sessions = [...team, ...fixture.performers.slice(0, performerSessions).map(user => ({ ...user, vendor: true }))]
  const states = await Promise.all(sessions.map(async user => ({
    user, authorization: await bearer(user), signedAt: Date.now(), completed: 0, taskDone: false,
  })))
  const started = performance.now()
  const deadline = started + durationMs
  const progress = setInterval(() => console.log('PILOT_PROGRESS', JSON.stringify({
    seconds: Math.round((performance.now() - started) / 1000),
    completed: states.reduce((total, state) => total + state.completed, 0),
  })), 60000)
  try {
    await Promise.all(states.map(async (state, index) => {
      let iteration = index
      await wait(index * (intervalMs / states.length))
      while (performance.now() < deadline) {
        if (Date.now() - state.signedAt > 300000) {
          state.authorization = await bearer(state.user)
          state.signedAt = Date.now()
        }
        const name = state.user.vendor ? 'vendorDeals' : teamMix[iteration++ % teamMix.length]
        const { method } = definitions[name]
        const path = name === 'taskToggle' ? paths.tasks + '/' + state.user.taskId : paths[name]
        const bucket = stats[name]
        const before = performance.now()
        try {
          const response = await request(method, path, state.authorization, !state.taskDone)
          const body = await response.arrayBuffer()
          bucket.status[response.status] = (bucket.status[response.status] ?? 0) + 1
          if (response.status === 200) {
            bucket.timings.push(performance.now() - before)
            bucket.bytes += body.byteLength
            if (name === 'taskToggle') state.taskDone = !state.taskDone
          }
        } catch {
          bucket.transport++
        }
        state.completed++
        const delay = intervalMs - (performance.now() - before)
        if (delay > 0 && performance.now() + delay < deadline) await wait(delay)
        else if (delay > 0) break
      }
    }))
  } finally {
    clearInterval(progress)
  }

  const summary = Object.fromEntries(Object.entries(stats).map(([name, bucket]) => {
    const sorted = bucket.timings.sort((a, b) => a - b)
    return [name, {
      status: bucket.status, transport: bucket.transport, totalBytes: bucket.bytes,
      p50Ms: percentile(sorted, .5), p95Ms: percentile(sorted, .95), maxMs: percentile(sorted, 1),
      p95Limit: definitions[name].p95Limit,
    }]
  }))
  return { seconds: Math.round((performance.now() - started) / 100) / 10, sessions: states.length, summary, states }
}

try {
  await app.ready()
  assert(app.db && !app.redis)
  const db = app.db
  const fixture = await seed(db)
  const { wedding, chat, team, performers, stranger } = fixture
  await db.query('analyze')
  await app.listen({ port, host: '127.0.0.1' })
  const weddingPath = '/weddings/' + wedding
  const chatPath = '/chats/' + chat + '/messages'
  const owner = await bearer(team[0])
  const teamMate = await bearer(team[2])
  const vendor = await bearer(performers[0])
  const outsider = await bearer(stranger)
  assert.equal((await json(weddingPath + '/guests', teamMate)).length, profile.guests)
  assert.equal((await json(weddingPath + '/events', teamMate)).length, profile.events)
  assert.equal((await json(weddingPath + '/tasks', teamMate)).length, profile.tasks)
  assert.equal((await json(weddingPath + '/slots', teamMate)).length, profile.performers)
  assert.equal((await json('/vendor/deals', vendor)).items.length, 1)
  await json(weddingPath + '/guests', outsider, 404)
  await json(chatPath, outsider, 404)
  const { deepCursor, pages } = await chatTraversal(chatPath, owner)
  const paths = {
    guests: weddingPath + '/guests', tasks: weddingPath + '/tasks', events: weddingPath + '/events',
    week: weddingPath + '/week', slots: weddingPath + '/slots', chatLatest: chatPath + '?limit=50',
    chatOlder: chatPath + '?' + new URLSearchParams({ limit: '50', cursor: deepCursor }), vendorDeals: '/vendor/deals',
  }
  assert.equal((await json(paths.chatOlder, teamMate)).items.length, 50)
  const { rows: [postgres] } = await db.query(`select current_setting('server_version') version,
    pg_database_size(current_database())::int bytes`)
  console.log('PILOT_INPUT', JSON.stringify({
    mode, durationSeconds: durationMs / 1000, intervalMs, teamSize, performerSessions, teamMix, profile, chatPages: pages,
    postgres, port, node: process.version, os: process.platform + ' ' + release(),
    cpu: cpus()[0]?.model, parallelism: availableParallelism(), ramBytes: totalmem(),
  }))
  const { states, ...result } = await measure(fixture, paths)
  const { rows } = await db.query('select id, done_at is not null as done from tasks where id=any($1::uuid[])', [team.map(user => user.taskId)])
  const observed = new Map(rows.map(row => [row.id, row.done]))
  const writesPersisted = states.filter(state => !state.user.vendor).every(state => observed.get(state.user.taskId) === state.taskDone)
  const checks = Object.values(result.summary)
  const serverErrors = checks.reduce((total, value) => total + Object.entries(value.status)
    .filter(([status]) => Number(status) >= 500).reduce((sum, [, count]) => sum + count, 0), 0)
  const passed = writesPersisted && checks.every(value => value.transport === 0
    && Object.keys(value.status).length === 1 && value.status[200] > 0 && value.p95Ms <= value.p95Limit)
  console.log('PILOT_RESULT', JSON.stringify({ ...result, writesPersisted, serverErrors, passed }))
  if (!passed) process.exitCode = 1
} finally {
  await app.close()
}
