import { randomInt, randomUUID } from 'node:crypto'
import { Agent } from 'node:https'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import webpush from 'web-push'
import { loadConfig } from '../src/config.js'
import { createDb, type Db } from '../src/plugins/db.js'
import * as preflight from '../src/notify/preflight.js'
import { sendDuePushes, PUSH_LEASE_MS, PUSH_MAX_ATTEMPTS, PUSH_TIMEOUT_MS, PUSH_PASS_BUDGET_MS } from '../src/notify/push.js'

const DATABASE = process.env.TEST_DATABASE_URL
const keys = webpush.generateVAPIDKeys()
const config = { ...loadConfig({ NODE_ENV: 'test' }), vapidPublicKey: keys.publicKey,
  vapidPrivateKey: keys.privateKey, vapidSubject: 'mailto:delivery-test@example.com' }

describe.skipIf(!DATABASE)('durable subscription delivery (real PostgreSQL, mocked provider)', () => {
  let db: Db
  const users: string[] = []
  const send = () => vi.mocked(webpush.sendNotification)
  const ownCalls = (id: string) => send().mock.calls.filter(([, payload]) =>
    JSON.parse(String(payload)).data.notificationId === id)

  beforeAll(async () => { db = createDb(DATABASE!); expect(await db.ping()).toBe(true) })
  beforeEach(() => { vi.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201, body: '', headers: {} }) })
  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (users.length) await db.query('delete from users where id=any($1::uuid[])', [users.splice(0)])
  })
  afterAll(async () => { await db?.close() })

  async function fixture(count = 1) {
    const user = randomUUID(); users.push(user)
    await db.query("insert into users(id,phone,tz) values($1,$2,'UTC')", [user, `+1555${randomInt(1_000_000_000, 9_999_999_999)}`])
    await db.query("insert into notification_prefs(user_id,quiet_from,quiet_to) values($1,'00:00','00:00')", [user])
    const id = randomUUID()
    await db.query(`insert into notifications(id,user_id,kind,title,body,link,deliver_after)
      values($1,$2,'system','Wedding update','Only this notice','/wedding/dayx',now()-interval '1 minute')`, [id, user])
    const subscriptions: string[] = []
    for (let i = 0; i < count; i++) {
      const sub = randomUUID(); subscriptions.push(sub)
      await db.query('insert into push_subscriptions(id,user_id,endpoint,keys) values($1,$2,$3,$4)',
        [sub, user, `https://push.example.invalid/${sub}`, JSON.stringify({ p256dh: 'test', auth: 'test' })])
    }
    return { user, id, subscriptions }
  }
  const rows = async (id: string) => (await db.query<{
    status: string; attempts: number; provider_accepted_at: Date | null; lease_token: string | null;
    lease_until: Date | null; last_error: string | null; next_attempt_at: Date; subscription_id: string
  }>('select * from notification_push_deliveries where notification_id=$1 order by subscription_id', [id])).rows
  const settled = async (id: string) => (await db.query<{ pushed_at: Date | null; cancelled_at: Date | null }>(
    'select pushed_at,cancelled_at from notifications where id=$1', [id])).rows[0]!
  const retryNow = async (id: string) => db.query(`update notification_push_deliveries
    set next_attempt_at=now()-interval '1 second' where notification_id=$1 and status='retry_wait'`, [id])
  function failQueryOnce(predicate: (sql: string, values?: readonly unknown[]) => boolean): Db {
    let failed = false
    return { ...db, async query<T extends pg.QueryResultRow>(sql: string, values?: readonly unknown[]) {
      if (!failed && predicate(sql, values)) { failed = true; throw new Error('controlled database failure') }
      return db.query<T>(sql, values)
    } }
  }
  async function taskFixture() {
    const f = await fixture()
    const wedding = randomUUID(), task = randomUUID()
    await db.query("update users set tz='UTC' where id=$1", [f.user])
    await db.query("insert into weddings(id,owner_id,title,tz,invite_code) values($1,$2,'Delivery test','UTC',$3)", [wedding, f.user, randomUUID()])
    await db.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [wedding, f.user])
    await db.query(`insert into tasks(id,wedding_id,title,assignee_id,due,reminder_days_before)
      values($1,$2,'Confirm the venue',$3,current_date+1,1)`, [task, wedding, f.user])
    await db.query(`update notifications set kind='task',task_id=$2,task_version=0,
      task_event='assignment',expires_at=now()+interval '1 day' where id=$1`, [f.id, task])
    return { ...f, wedding, task }
  }
  function onFirstRead(id: string, action: () => Promise<unknown>): Db {
    let acted = false
    return { ...db, async query<T extends pg.QueryResultRow>(sql: string, values?: readonly unknown[]) {
      if (!acted && sql.includes('select n.title,n.body') && values?.[0]===id) { acted = true; await action() }
      return db.query<T>(sql, values)
    } }
  }

  it('accepts once per subscription, retains inbox and stable identity, with timeout shorter than lease', async () => {
    const f = await fixture(2)
    await sendDuePushes(db, config); await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(2)
    expect((await rows(f.id)).map(r => r.status)).toEqual(['provider_accepted', 'provider_accepted'])
    expect((await rows(f.id)).every(r => r.attempts===1 && r.provider_accepted_at && !r.lease_token && !r.lease_until)).toBe(true)
    expect((await settled(f.id)).pushed_at).not.toBeNull()
    const call = ownCalls(f.id)[0]!
    expect(JSON.parse(String(call[1]))).toEqual({ title: 'Wedding update', body: 'Only this notice',
      data: { link: '/wedding/dayx', notificationId: f.id } })
    expect(call[2]?.timeout).toBe(PUSH_TIMEOUT_MS)
    expect(PUSH_TIMEOUT_MS).toBeLessThan(PUSH_LEASE_MS)
    expect(call[2]?.TTL).toBeGreaterThan(0)
    expect(call[2]?.TTL).toBeLessThanOrEqual(86_400)
  })

  it('temporary network failure stays retryable without marking acceptance and recovers on later pass', async () => {
    const f = await fixture()
    send().mockRejectedValue(new Error('network with secret endpoint must not be persisted'))
    await sendDuePushes(db, config)
    const failed = (await rows(f.id))[0]!
    expect(failed.status).toBe('retry_wait'); expect(failed.attempts).toBe(1)
    expect(failed.provider_accepted_at).toBeNull(); expect(failed.last_error).toBe('transport_failure')
    expect(failed.next_attempt_at.getTime()).toBeGreaterThan(Date.now()+45_000)
    expect((await settled(f.id)).pushed_at).toBeNull()
    await sendDuePushes(db, config); expect(ownCalls(f.id)).toHaveLength(1)
    await retryNow(f.id); send().mockResolvedValue({ statusCode: 201, body: '', headers: {} })
    await sendDuePushes(db, config)
    expect((await rows(f.id))[0]?.status).toBe('provider_accepted')
    expect((await rows(f.id))[0]?.attempts).toBe(2)
    expect(ownCalls(f.id).map(c => JSON.parse(String(c[1])).data.notificationId)).toEqual([f.id, f.id])
  })

  it.each([408, 429, 503])('HTTP %s is retried within the bound', async statusCode => {
    const f = await fixture(); send().mockRejectedValue({ statusCode })
    await sendDuePushes(db, config)
    expect((await rows(f.id))[0]?.status).toBe('retry_wait')
    expect((await rows(f.id))[0]?.last_error).toBe(`http_${statusCode}`)
  })

  it('stops at five failed attempts, retaining notice and subscription', async () => {
    const f = await fixture(); send().mockRejectedValue({ statusCode: 503 })
    for (let i = 0; i < PUSH_MAX_ATTEMPTS; i++) { await retryNow(f.id); await sendDuePushes(db, config) }
    await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(PUSH_MAX_ATTEMPTS)
    expect((await rows(f.id))[0]?.status).toBe('permanent_failure')
    expect((await rows(f.id))[0]?.provider_accepted_at).toBeNull()
    expect((await settled(f.id)).pushed_at).not.toBeNull()
    expect((await db.query('select id from push_subscriptions where user_id=$1', [f.user])).rowCount).toBe(1)
  })

  it.each([404, 410])('HTTP %s removes only the gone subscription and preserves delivery history', async statusCode => {
    const f = await fixture(2); const gone = f.subscriptions[0]!
    send().mockImplementation(async subscription => {
      if (subscription.endpoint.endsWith(gone)) throw { statusCode }
      return { statusCode: 201, body: '', headers: {} }
    })
    const result = await sendDuePushes(db, config)
    expect(result.dropped).toBeGreaterThanOrEqual(1)
    const history = await rows(f.id)
    expect(history.find(r => r.subscription_id===gone)?.status).toBe('permanent_failure')
    expect(history.find(r => r.subscription_id!==gone)?.status).toBe('provider_accepted')
    expect((await db.query('select id from push_subscriptions where id=$1', [gone])).rowCount).toBe(0)
    await sendDuePushes(db, config); expect(ownCalls(f.id)).toHaveLength(2)
  })

  it('permanent payload refusal does not delete a still-existing subscription or fake acceptance', async () => {
    const f = await fixture(); send().mockRejectedValue({ statusCode: 413 })
    await sendDuePushes(db, config); await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(1)
    expect((await rows(f.id))[0]?.status).toBe('permanent_failure')
    expect((await rows(f.id))[0]?.provider_accepted_at).toBeNull()
    expect((await db.query('select id from push_subscriptions where user_id=$1', [f.user])).rowCount).toBe(1)
  })

  it('gone response racing subscription reassignment does not delete or cancel the new owner’s queue', async () => {
    const f = await fixture(); const other = await fixture(0)
    send().mockImplementationOnce(async () => {
      await db.query('update push_subscriptions set user_id=$2 where id=$1', [f.subscriptions[0], other.user])
      await db.query('update notifications set pushed_at=null where id=$1', [other.id])
      await db.query(`insert into notification_push_deliveries(notification_id,subscription_id)
        values($1,$2)`, [other.id, f.subscriptions[0]])
      throw { statusCode: 410 }
    })
    // One outbound attempt, so the new owner's queued row can be inspected.
    await sendDuePushes(db, config, 1)
    expect((await db.query('select user_id from push_subscriptions where id=$1', [f.subscriptions[0]])).rows[0]?.user_id).toBe(other.user)
    expect((await rows(other.id))[0]?.status).toBe('queued')
    await sendDuePushes(db, config)
    expect((await rows(other.id))[0]?.status).toBe('provider_accepted')
    expect(ownCalls(other.id)).toHaveLength(1)
  })

  it.each([201, 410, 503])('late HTTP %s result cannot overwrite a newer lease or remove its subscription', async statusCode => {
    const f = await fixture(), replacement = randomUUID(), additional = randomUUID()
    await db.query(`insert into notifications(id,user_id,kind,title,body,deliver_after)
      values($1,$2,'system','Future','Future notice',now()+interval '10 minutes')`, [additional, f.user])
    await db.query('insert into notification_push_deliveries(notification_id,subscription_id) values($1,$2)', [additional, f.subscriptions[0]])
    send().mockImplementationOnce(async () => {
      await db.query(`update notification_push_deliveries set lease_token=$2,attempts=2,
        lease_until=now()+interval '1 minute' where notification_id=$1`, [f.id, replacement])
      if (statusCode!==201) throw { statusCode }
      return { statusCode, body: '', headers: {} }
    })
    const outcome = await sendDuePushes(db, config, 1)
    expect(outcome.sent).toBe(statusCode===201 ? 1 : 0) // Successful calls, not persisted/device acceptance.
    expect(outcome.dropped).toBe(0)
    expect((await rows(f.id))[0]).toMatchObject({ status: 'claimed', lease_token: replacement, attempts: 2,
      provider_accepted_at: null, last_error: null })
    expect((await rows(additional))[0]?.status).toBe('queued')
    expect((await db.query('select id from push_subscriptions where id=$1', [f.subscriptions[0]])).rowCount).toBe(1)
    expect((await settled(f.id)).pushed_at).toBeNull()
  })

  it('expired lease with unchanged token cannot authorize a late gone cleanup', async () => {
    const f = await fixture()
    send().mockImplementationOnce(async () => {
      await db.query("update notification_push_deliveries set lease_until=now()-interval '1 second' where notification_id=$1", [f.id])
      throw { statusCode: 410 }
    })
    const outcome = await sendDuePushes(db, config, 1)
    expect(outcome.dropped).toBe(0)
    expect((await rows(f.id))[0]?.status).toBe('claimed')
    expect((await db.query('select id from push_subscriptions where id=$1', [f.subscriptions[0]])).rowCount).toBe(1)
    expect((await settled(f.id)).pushed_at).toBeNull()
  })

  it('gone cleanup database failure rolls back terminal transition and keeps the claim recoverable', async () => {
    const f = await fixture(); send().mockRejectedValue({ statusCode: 410 })
    const faulty: Db = { ...db, tx<T>(action: (client: Queryable) => Promise<T>): Promise<T> {
      return db.tx(client => action({ async query<R extends pg.QueryResultRow>(sql: string, values?: readonly unknown[]) {
        if (/^\s*delete\s+from\s+push_subscriptions\b/i.test(sql) && /\bwhere\b/i.test(sql) && values?.[0]===f.id) throw new Error('Controlled gone cleanup failure')
        return client.query<R>(sql, values)
      } }))
    } }
    await expect(sendDuePushes(faulty, config)).rejects.toThrow('Controlled gone cleanup failure')
    expect((await rows(f.id))[0]).toMatchObject({ status: 'claimed', last_error: null, provider_accepted_at: null })
    expect((await db.query('select id from push_subscriptions where id=$1', [f.subscriptions[0]])).rowCount).toBe(1)
    expect((await settled(f.id)).pushed_at).toBeNull()
  })

  it('recovers an expired pre-send lease, but will not take a live lease', async () => {
    const f = await fixture()
    await db.query(`insert into notification_push_deliveries(notification_id,subscription_id,status,attempts,lease_token,lease_until)
      values($1,$2,'claimed',1,$3,now()+interval '1 minute')`, [f.id, f.subscriptions[0], randomUUID()])
    await sendDuePushes(db, config); expect(ownCalls(f.id)).toHaveLength(0)
    await db.query(`update notification_push_deliveries set lease_until=now()-interval '1 second' where notification_id=$1`, [f.id])
    await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(1)
    expect((await rows(f.id))[0]?.attempts).toBe(2)
    expect((await rows(f.id))[0]?.status).toBe('provider_accepted')
  })

  it('final crashed lease exhausts safely without a sixth call', async () => {
    const f = await fixture()
    await db.query(`insert into notification_push_deliveries(notification_id,subscription_id,status,attempts,lease_token,lease_until)
      values($1,$2,'claimed',5,$3,now()-interval '1 second')`, [f.id, f.subscriptions[0], randomUUID()])
    await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(0)
    expect((await rows(f.id))[0]?.status).toBe('permanent_failure')
    expect((await rows(f.id))[0]?.last_error).toBe('attempt_limit')
  })

  it('concurrent workers share claims without duplicate sends', async () => {
    const f = await fixture(3)
    await Promise.all([sendDuePushes(db, config), sendDuePushes(db, config), sendDuePushes(db, config)])
    expect(ownCalls(f.id)).toHaveLength(3)
    expect((await rows(f.id)).every(r => r.status==='provider_accepted' && r.attempts===1)).toBe(true)
  })

  it('does not lease another subscription while the first provider call is pending', async () => {
    const f = await fixture(2)
    let enter!: () => void, complete!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const pending = new Promise<void>(resolve => { complete = resolve })
    send().mockImplementationOnce(async () => { enter(); await pending; return { statusCode: 201, body: '', headers: {} } })
    const worker = sendDuePushes(db, config)
    try {
      await Promise.race([entered, worker])
      expect((await rows(f.id)).map(r => r.status).sort()).toEqual(['claimed', 'queued'])
      expect((await settled(f.id)).pushed_at).toBeNull()
    } finally { complete(); await worker }
    expect(ownCalls(f.id)).toHaveLength(2)
  })

  it('claims exactly one under a nested-loop plan even with many subscriptions', async () => {
    const f = await fixture(12)
    const nested: Db = { ...db, async query<T extends pg.QueryResultRow>(sql: string, values?: readonly unknown[]) {
      if (!sql.includes('returning d.notification_id')) return db.query<T>(sql, values)
      return db.tx(async client => {
        await client.query('set local enable_hashjoin=off')
        await client.query('set local enable_mergejoin=off')
        await client.query('set local enable_material=off')
        return client.query<T>(sql, values)
      })
    } }
    let enter!: () => void, complete!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const pending = new Promise<void>(resolve => { complete = resolve })
    send().mockImplementationOnce(async () => { enter(); await pending; return { statusCode: 201, body: '', headers: {} } })
    const worker = sendDuePushes(nested, config)
    try {
      await Promise.race([entered, worker])
      const snapshot = await rows(f.id)
      expect(snapshot.filter(r => r.status==='claimed')).toHaveLength(1)
      expect(snapshot.filter(r => r.status==='queued')).toHaveLength(11)
    } finally { complete(); await worker }
    expect(ownCalls(f.id)).toHaveLength(12)
    expect((await rows(f.id)).every(r => r.status==='provider_accepted' && r.attempts===1)).toBe(true)
  })

  it('pass budget yields with remaining subscriptions queued and never leased', async () => {
    const f = await fixture(8)
    let elapsed = 0
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
    send().mockImplementation(async () => {
      elapsed += PUSH_PASS_BUDGET_MS/2
      return { statusCode: 201, body: '', headers: {} }
    })
    await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(2)
    const snapshot = await rows(f.id)
    expect(snapshot.filter(r => r.status==='provider_accepted')).toHaveLength(2)
    expect(snapshot.filter(r => r.status==='queued' && r.attempts===0 && !r.lease_token)).toHaveLength(6)
    expect(snapshot.some(r => r.status==='claimed')).toBe(false)
    expect((await settled(f.id)).pushed_at).toBeNull()
    vi.mocked(performance.now).mockRestore()
    send().mockResolvedValue({ statusCode: 201, body: '', headers: {} })
    await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(8)
  })

  it('budget expiring after claim releases it unsent for another pass', async () => {
    const f = await fixture()
    let elapsed = 0
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
    const slowRead = onFirstRead(f.id, async () => { elapsed = PUSH_PASS_BUDGET_MS })
    await sendDuePushes(slowRead, config)
    expect(ownCalls(f.id)).toHaveLength(0)
    expect((await rows(f.id))[0]).toMatchObject({ status: 'queued', attempts: 0, lease_token: null })
    expect((await settled(f.id)).pushed_at).toBeNull()
  })

  it('preflight deferral is re-read, queued without spending an attempt, and never handed off', async () => {
    const f = await fixture()
    const guard = vi.spyOn(preflight, 'notificationPushReady').mockImplementation(async (client: Queryable, notificationId: string) => {
      await client.query("update notifications set deliver_after=now()+interval '1 hour' where id=$1", [notificationId])
      return false
    })
    await sendDuePushes(db, config)
    expect(guard).toHaveBeenCalledWith(db, f.id)
    expect(ownCalls(f.id)).toHaveLength(0)
    expect((await rows(f.id))[0]).toMatchObject({ status: 'queued', attempts: 0, lease_token: null })
    expect((await settled(f.id)).pushed_at).toBeNull()
  })

  it('preflight suppression remains in inbox without pretending provider acceptance', async () => {
    const f = await fixture()
    vi.spyOn(preflight, 'notificationPushReady').mockResolvedValue(false)
    await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(0)
    expect((await rows(f.id))[0]).toMatchObject({ status: 'cancelled', attempts: 0, provider_accepted_at: null })
    expect((await settled(f.id)).cancelled_at).toBeNull()
  })

  it.each(['inbox_only', 'processed'])('explicit %s notice is never initialized even without legacy timestamp', async disposition => {
    const f = await fixture()
    await db.query('update notifications set push_disposition=$2,pushed_at=null where id=$1', [f.id, disposition])
    await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(0)
    expect(await rows(f.id)).toHaveLength(0)
    expect((await settled(f.id)).pushed_at).toBeNull()
    expect((await db.query('select push_disposition from notifications where id=$1', [f.id])).rows[0]?.push_disposition).toBe(disposition)
  })

  it('actual preflight notices current channel opt-out, retains inbox and cancels unsent attempt', async () => {
    const f = await fixture()
    await db.query("update notifications set kind='chat' where id=$1", [f.id])
    await db.query('update notification_prefs set chats=false where user_id=$1', [f.user])
    await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(0)
    expect((await rows(f.id))[0]).toMatchObject({ status: 'cancelled', attempts: 0, provider_accepted_at: null })
    expect((await settled(f.id)).cancelled_at).toBeNull()
    expect((await db.query('select push_disposition from notifications where id=$1', [f.id])).rows[0]?.push_disposition).toBe('inbox_only')
  })

  it('absolute deadline aborts the disposable agent even if a provider promise never settles', async () => {
    const f = await fixture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let enter!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const destroy = vi.spyOn(Agent.prototype, 'destroy')
    send().mockImplementationOnce(async () => { enter(); return new Promise(() => {}) })
    const worker = sendDuePushes(db, config)
    await Promise.race([entered, worker])
    await vi.advanceTimersByTimeAsync(PUSH_TIMEOUT_MS)
    await worker
    expect(destroy).toHaveBeenCalled()
    expect((await rows(f.id))[0]?.status).toBe('retry_wait')
    expect((await rows(f.id))[0]?.provider_accepted_at).toBeNull()
    expect(ownCalls(f.id)).toHaveLength(1)
  })

  it('pre-send database failure leaves the claim recoverable without a provider call', async () => {
    const f = await fixture()
    const faulty = failQueryOnce((sql, values) => sql.includes('select n.title,n.body') && values?.[0]===f.id)
    await expect(sendDuePushes(faulty, config)).rejects.toThrow('controlled database failure')
    expect(ownCalls(f.id)).toHaveLength(0)
    expect((await rows(f.id))[0]?.status).toBe('claimed')
    expect((await settled(f.id)).pushed_at).toBeNull()
    await db.query("update notification_push_deliveries set lease_until=now()-interval '1 second' where notification_id=$1", [f.id])
    await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(1)
    expect((await rows(f.id))[0]?.status).toBe('provider_accepted')
  })

  it('known provider acceptance with failed persistence is ambiguous until lease recovery, not a fake transport failure', async () => {
    const f = await fixture()
    const faulty = failQueryOnce((sql, values) => sql.includes('provider_accepted_at=case') && values?.[0]===f.id)
    await expect(sendDuePushes(faulty, config)).rejects.toThrow('controlled database failure')
    expect(ownCalls(f.id)).toHaveLength(1)
    const pending = (await rows(f.id))[0]!
    expect(pending.status).toBe('claimed'); expect(pending.provider_accepted_at).toBeNull()
    expect(pending.last_error).toBeNull(); expect((await settled(f.id)).pushed_at).toBeNull()
    await db.query("update notification_push_deliveries set lease_until=now()-interval '1 second' where notification_id=$1", [f.id])
    await sendDuePushes(db, config)
    // Two submissions are possible in this crash window: no exactly-once promise.
    expect(ownCalls(f.id)).toHaveLength(2)
    expect(ownCalls(f.id).map(c => JSON.parse(String(c[1])).data.notificationId)).toEqual([f.id, f.id])
    expect((await rows(f.id))[0]?.status).toBe('provider_accepted')
  })

  it('cancellation after handoff cannot undo acceptance or cause another send', async () => {
    const f = await fixture()
    send().mockImplementationOnce(async () => {
      await db.query('update notifications set cancelled_at=now() where id=$1', [f.id])
      return { statusCode: 201, body: '', headers: {} }
    })
    await sendDuePushes(db, config); await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(1)
    expect((await rows(f.id))[0]?.status).toBe('provider_accepted')
    expect((await settled(f.id)).cancelled_at).not.toBeNull()
  })

  it('task completion after claim prevents provider I/O', async () => {
    const f = await taskFixture()
    const changing = onFirstRead(f.id, () => db.query('update tasks set done_at=now() where id=$1', [f.task]))
    await sendDuePushes(changing, config)
    expect(ownCalls(f.id)).toHaveLength(0)
    expect((await rows(f.id))[0]?.status).toBe('cancelled')
    expect((await settled(f.id)).cancelled_at).not.toBeNull()
  })

  it('task channel opt-out after claim prevents provider I/O', async () => {
    const f = await taskFixture()
    const changing = onFirstRead(f.id, () => db.query('update notification_prefs set tasks=false where user_id=$1', [f.user]))
    await sendDuePushes(changing, config)
    expect(ownCalls(f.id)).toHaveLength(0)
    expect((await rows(f.id))[0]?.status).toBe('cancelled')
    expect((await rows(f.id))[0]?.attempts).toBe(0)
  })

  it('quiet-hour edit after claim releases unsent task without burning attempts and later resumes once', async () => {
    const f = await taskFixture()
    const changing = onFirstRead(f.id, () => db.query(`update notification_prefs set
      quiet_from=(now() at time zone 'UTC'-interval '1 minute')::time,
      quiet_to=(now() at time zone 'UTC'+interval '10 minutes')::time where user_id=$1`, [f.user]))
    await sendDuePushes(changing, config)
    expect(ownCalls(f.id)).toHaveLength(0)
    expect((await rows(f.id))[0]?.status).toBe('queued')
    expect((await rows(f.id))[0]?.attempts).toBe(0)
    expect((await settled(f.id)).pushed_at).toBeNull()
    await sendDuePushes(db, config); expect(ownCalls(f.id)).toHaveLength(0)
    await db.query("update notification_prefs set quiet_from='00:00',quiet_to='00:00' where user_id=$1", [f.user])
    await db.query('update notifications set deliver_after=now() where id=$1', [f.id])
    await db.query('update notification_push_deliveries set next_attempt_at=now() where notification_id=$1', [f.id])
    await sendDuePushes(db, config); await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(1)
    expect((await rows(f.id))[0]?.status).toBe('provider_accepted')
    expect((await rows(f.id))[0]?.attempts).toBe(1)
  })

  it('cancellation between attempts stops retry, preserving inbox history', async () => {
    const f = await fixture(); send().mockRejectedValue({ statusCode: 503 })
    await sendDuePushes(db, config)
    await db.query('update notifications set cancelled_at=now() where id=$1', [f.id])
    await retryNow(f.id); await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(1)
    expect((await rows(f.id))[0]?.status).toBe('cancelled')
    expect((await settled(f.id)).cancelled_at).not.toBeNull()
  })

  it('subscription ownership changes prevent later retry to the new account', async () => {
    const f = await fixture(); const other = await fixture(0)
    send().mockRejectedValue({ statusCode: 503 }); await sendDuePushes(db, config)
    await db.query('update push_subscriptions set user_id=$2 where id=$1', [f.subscriptions[0], other.user])
    await retryNow(f.id); await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(1)
    expect((await rows(f.id))[0]?.status).toBe('cancelled')
  })

  it('deleted account and removed subscription suppress queued retries', async () => {
    const f = await fixture(2); send().mockRejectedValue({ statusCode: 503 })
    await sendDuePushes(db, config)
    await db.query('delete from push_subscriptions where id=$1', [f.subscriptions[0]])
    await db.query('update users set deleted_at=now() where id=$1', [f.user])
    await retryNow(f.id); await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(2)
    expect((await rows(f.id)).every(r => r.status==='cancelled')).toBe(true)
  })

  it('expiry stops retry without deleting the inbox notice', async () => {
    const f = await fixture(); send().mockRejectedValue({ statusCode: 503 }); await sendDuePushes(db, config)
    await db.query("update notifications set deliver_after=now()-interval '25 hours' where id=$1", [f.id])
    await retryNow(f.id); await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(1)
    expect((await rows(f.id))[0]?.status).toBe('expired')
    expect((await settled(f.id)).pushed_at).not.toBeNull()
  })

  it.each(['age', 'task_deadline'])('expiry by %s between claim and ready is expired rather than cancelled', async source => {
    const f = source==='task_deadline' ? await taskFixture() : await fixture()
    const expiring = onFirstRead(f.id, () => db.query(source==='age'
      ? "update notifications set deliver_after=now()-interval '25 hours' where id=$1"
      : "update notifications set expires_at=now()-interval '1 second' where id=$1", [f.id]))
    const outcome = await sendDuePushes(expiring, config)
    expect(outcome.expired).toBeGreaterThanOrEqual(1)
    expect(ownCalls(f.id)).toHaveLength(0)
    expect((await rows(f.id))[0]).toMatchObject({ status: 'expired', last_error: 'push_window_expired', attempts: 0 })
    expect((await settled(f.id)).pushed_at).not.toBeNull()
  })

  it('new expired notice and no-subscription notice settle without provider acceptance', async () => {
    const f = await fixture(); const none = await fixture(0)
    await db.query("update notifications set deliver_after=now()-interval '25 hours' where id=$1", [f.id])
    await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(0); expect(ownCalls(none.id)).toHaveLength(0)
    expect(await rows(f.id)).toHaveLength(0); expect(await rows(none.id)).toHaveLength(0)
    expect((await settled(f.id)).pushed_at).not.toBeNull()
    expect((await settled(none.id)).pushed_at).not.toBeNull()
  })

  it('without VAPID retains pending notices and creates no delivery attempts', async () => {
    const f = await fixture()
    expect(await sendDuePushes(db, { ...config, vapidPrivateKey: null })).toEqual({ sent: 0, dropped: 0, expired: 0 })
    expect(await rows(f.id)).toHaveLength(0); expect((await settled(f.id)).pushed_at).toBeNull()
    expect(ownCalls(f.id)).toHaveLength(0)
  })
})
