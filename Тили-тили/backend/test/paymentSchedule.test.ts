import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import { CONTRACT_SCHEMAS, ref, type ContractSchemaName } from '../src/contract/schemas.generated.js'
/* Уборка архива — табличная задача (проходит по всем свадьбам): поэтому файл в серийной
 * группе `vitest.serial.json`, этого требует сторож audit53. Там же по одному идёт и подмена
 * триггера на общей `audit_log` в тесте отказа аудита (ревью 018, C-10/M-15, P-08). */
import { eraseUser, purgeArchivedWeddings } from '../src/jobs/index.js'

const DB = process.env.TEST_DATABASE_URL
const SECRET = 'a'.repeat(48)
const money = (amount: number) => ({ amount, currency: 'RUB' })
/** Наименьший PNG для подтверждения оплаты (018-B): сигнатура и один байт. */
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
type Money = { amount: number; currency: string }
interface Stage {
  id: string; dealId: string; title: string; due: string; version: number; status: string; overdue: boolean
  amount: Money; paid: Money; allocated: Money; remaining: Money; cancelReason: string | null
}
interface PaymentView { id: string; installmentId: string | null; version: number; amount: Money | null; kind: string }

/** Отказ — это статус и код: 409 здесь дают десять разных причин, и статус один их не различает (ревью 018, C-04). */
function expectError(res: { statusCode: number; body: string }, status: number, code: string) {
  expect(res.statusCode, res.body).toBe(status)
  expect((JSON.parse(res.body) as { error?: { code?: string } }).error?.code, res.body).toBe(code)
}

/**
 * Ответ сервера по схеме контракта — тем же AJV, что у Fastify, но без приведения типов,
 * срезания лишних полей и подстановки умолчаний: иначе расхождение с контрактом прячется.
 * `null` — ответ по схеме, иначе текст отказа валидатора с путём до поля.
 */
async function contractViolation(name: ContractSchemaName, body: unknown): Promise<string | null> {
  const probe = Fastify({
    logger: false,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false, allErrors: true } },
  })
  probe.addSchema(CONTRACT_SCHEMAS)
  probe.post('/probe', { schema: { body: ref(name) } }, async () => ({ ok: true }))
  try {
    await probe.ready()
    const res = await probe.inject({ method: 'POST', url: '/probe', payload: body as object })
    return res.statusCode === 200 ? null : res.body
  } finally {
    await probe.close()
  }
}

describe.skipIf(!DB)('018-A: график платежей — деньги, права и версии', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildApp({ env: 'test', databaseUrl: DB ?? null, redisUrl: null,
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'b'.repeat(48), policyVersion: '2026-09-02' })
    await app.ready()
  })
  afterAll(async () => { await app?.close() })
  async function user() {
    const id = randomUUID(), sid = randomUUID()
    await app.db!.query('insert into users(id,phone,name) values($1,$2,$3)', [id,'+79'+randomInt(100000000,999999999),'Payment test'])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sid,id,randomUUID()])
    await app.db!.query("insert into consents(id,user_id,policy_version,adult) values($1,$2,'2026-09-02',true)", [randomUUID(),id])
    return { id, token: await signAccessToken(SECRET, { sub:id, sid }) }
  }
  async function setup(price = 1000000) {
    const owner = await user(), id = randomUUID(), slotId = randomUUID(), dealId = randomUUID()
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,budget_total,invite_code) values($1,$2,'Payment test','2027-06-14','Asia/Yekaterinburg',5000000,$3)", [id,owner.id,randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [id,owner.id])
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Фотограф')", [slotId,id])
    await app.db!.query("insert into deals(id,wedding_id,slot_id,external_name,state,price,booked_at) values($1,$2,$3,'Фотограф','booked',$4,now())", [dealId,id,slotId,price])
    await app.db!.query('update slots set deal_id=$2 where id=$1',[slotId,dealId])
    return { id, owner, slotId, dealId }
  }
  type W = Awaited<ReturnType<typeof setup>>
  const headers = (w: W, key = randomUUID()) => ({ authorization:'Bearer '+w.owner.token, 'idempotency-key':key })
  const create = (w: W, body: Record<string, unknown> = {}, key = randomUUID()) => app.inject({ method:'POST', url:`/weddings/${w.id}/payment-schedule`, headers:headers(w,key), payload:{dealId:w.dealId,title:'Аванс',due:'2027-05-01',amount:money(400000),...body} })
  const read = (w: W, query = '?from=2027-01-01&to=2027-12-31') => app.inject({method:'GET',url:`/weddings/${w.id}/payment-schedule${query}`,headers:headers(w)})
  const edit = (w: W, id: string, body: Record<string, unknown>) => app.inject({method:'PATCH',url:`/weddings/${w.id}/payment-schedule/${id}`,headers:headers(w),payload:body})
  const pay = (w: W, id: string, amount: number, version = 1, key = randomUUID()) => app.inject({method:'POST',url:`/weddings/${w.id}/payment-schedule/${id}/pay`,headers:headers(w,key),payload:{amount:money(amount),version}})

  it('создаёт этап, не увеличивая обязательства и не создавая оплату', async () => {
    const w = await setup()
    const res = await create(w)
    expect(res.statusCode,res.body).toBe(201)
    expect(res.json()).toMatchObject({title:'Аванс',due:'2027-05-01',amount:money(400000),paid:money(0),version:1,status:'pending'})
    expect((await read(w)).json().summary).toMatchObject({committed:money(1000000),recorded:money(0),remaining:money(1000000)})
    expect((await app.db!.query('select id from payments where deal_id=$1',[w.dealId])).rowCount).toBe(0)
  })
  it('частичная оплата и повтор ключа дают одну запись, старый слот видит те же деньги', async () => {
    const w = await setup(), stage = await create(w), key = randomUUID()
    expect(stage.statusCode).toBe(201)
    const a = await pay(w,stage.json().id,100000,1,key)
    const b = await pay(w,stage.json().id,100000,1,key)
    expect(a.statusCode,a.body).toBe(200);expect(b.statusCode,b.body).toBe(200)
    expect(a.json()).toMatchObject({paid:money(100000),remaining:money(300000),status:'partial'})
    expect((await app.db!.query('select id from payments where deal_id=$1',[w.dealId])).rowCount).toBe(1)
    const slot = await app.inject({method:'GET',url:`/weddings/${w.id}/slots`,headers:headers(w)})
    expect(slot.statusCode,slot.body).toBe(200)
    expect(slot.json().find((x: {id:string})=>x.id===w.slotId).deal.paid).toEqual(money(100000))
    const budget = await app.inject({method:'GET',url:`/weddings/${w.id}/budget`,headers:headers(w)})
    expect(budget.json().spent).toEqual(money(1000000))
  })
  it('не принимает чужую сделку и не раскрывает деньги helper/coordinator', async () => {
    const a = await setup(), b = await setup()
    expectError(await create(a,{dealId:b.dealId}),404,'not_found')
    for (const role of ['helper','coordinator','vendor']) {
      const u = await user()
      await app.db!.query('insert into wedding_members(wedding_id,user_id,role) values($1,$2,$3)',[a.id,u.id,role])
      const other = {...a,owner:u}
      expectError(await read(other),403,'forbidden')
      expectError(await create(other),403,'forbidden')
    }
  })
  it('не молча перезаписывает устаревшую версию этапа', async () => {
    const w = await setup(), stage = await create(w)
    expect(stage.statusCode).toBe(201)
    const id = stage.json().id
    expect((await edit(w,id,{version:1,title:'Задаток'})).statusCode).toBe(200)
    const stale = await edit(w,id,{version:1,title:'Старый черновик'})
    expectError(stale,409,'stale_payment_plan')
    expect((await read(w)).json().items[0].title).toBe('Задаток')
  })
  it('отмена оплаченного этапа не создаёт возврат и не теряет историю', async () => {
    const w = await setup(), stage = await create(w)
    expect(stage.statusCode).toBe(201)
    const id = stage.json().id
    const paid = await pay(w,id,100000)
    expect(paid.statusCode).toBe(200)
    expect((await edit(w,id,{version:paid.json().version,cancelled:true})).statusCode).toBe(200)
    const result = (await read(w,'?from=2027-01-01&to=2027-12-31&includeCancelled=true')).json()
    expect(result.items[0]).toMatchObject({status:'cancelled',paid:money(100000)})
    expect(result.summary.recorded).toEqual(money(100000))
    expect((await app.db!.query("select id from payments where deal_id=$1 and kind='refund'",[w.dealId])).rowCount).toBe(0)
  })
  it.each(['2027-02-30','2027-13-01'])('не допускает некалендарную дату %s', async due => {
    /* Некалендарную дату в теле отсекает схема (`format: date`) раньше обработчика —
     * отсюда validation_failed с полем due, а не bad_date из текста контракта. */
    const w = await setup(), res = await create(w,{due})
    expectError(res,422,'validation_failed')
    expect(res.json().error.fields).toHaveProperty('due')
  })
  const link = (w: W, paymentId: string, installmentId: string | null, version = 1) => app.inject({method:'PATCH',url:`/weddings/${w.id}/payments/${paymentId}/plan`,headers:headers(w),payload:{version,installmentId}})
  const oldPay = (w: W, amount: number) => app.inject({method:'POST',url:`/weddings/${w.id}/slots/${w.slotId}/pay`,headers:headers(w),payload:{amount:money(amount)}})
  const paymentId = async (w: W) => (await app.db!.query<{id:string}>('select id from payments where deal_id=$1 order by created_at',[w.dealId])).rows[0]!.id
  /** Старая кнопка слота без суммы — отметка всего остатка сделки одной строкой, без этапа. */
  const oldPayRest = (w: W) => app.inject({method:'POST',url:`/weddings/${w.id}/slots/${w.slotId}/pay`,headers:headers(w),payload:{}})
  const bearer = (token: string) => ({ authorization: 'Bearer ' + token })
  /** «Сегодня» свадьбы со сдвигом в днях — тем же выражением, что `financialToday` на сервере (R-310). */
  const weddingDay = async (w: W, shift: number) => (await app.db!.query<{ day: string }>(
    "select ((now() at time zone coalesce(tz,'Europe/Moscow'))::date + $2::int)::text as day from weddings where id=$1",
    [w.id, shift])).rows[0]!.day
  const stageOf = (items: Stage[], id: string) => items.find(i => i.id === id)
  /**
   * Сделка на 1 000 000 с двумя этапами: 400 000 со сроком десять дней назад по «сегодня»
   * свадьбы и 600 000 через двадцать дней. Окно графика накрывает оба срока.
   */
  async function pastAndFuture(w: W) {
    const [past, future, from, to] = await Promise.all([-10, 20, -30, 60].map(n => weddingDay(w, n)))
    const first = await create(w, { title: 'Аванс', due: past, amount: money(400000) })
    const second = await create(w, { title: 'Остаток', due: future, amount: money(600000) })
    expect(first.statusCode, first.body).toBe(201)
    expect(second.statusCode, second.body).toBe(201)
    const window = `?from=${from}&to=${to}`
    // Предпосылка: пока денег нет, первый этап и правда просрочен — иначе тесту нечего доказывать.
    const before = (await read(w, window)).json()
    expect(stageOf(before.items, first.json().id)).toMatchObject({ status: 'pending', overdue: true, remaining: money(400000) })
    expect(stageOf(before.items, second.json().id)).toMatchObject({ status: 'pending', overdue: false, remaining: money(600000) })
    return { a: first.json() as Stage, b: second.json() as Stage, window }
  }
  /** Сколько строк графика и оплат у сделки — состояние базы, а не ответ сервера. */
  const financeRows = async (w: W) => (await app.db!.query<{ installments: number; payments: number }>(
    `select (select count(*)::int from payment_installments where deal_id=$1) as installments,
            (select count(*)::int from payments where deal_id=$1) as payments`, [w.dealId])).rows[0]!
  /**
   * Финансовая история сделки: этап с оплатой и привязанным возвратом, отметка без этапа,
   * отменённый этап с оплатой на нём — всё, во что упираются триггеры версий при каскаде.
   */
  async function financeHistory(w: W) {
    const a = (await create(w)).json() as Stage
    expect((await pay(w, a.id, 100000)).statusCode).toBe(200)
    await app.db!.query("insert into payments(id,deal_id,kind,amount,status,installment_id) values($1,$2,'refund',10000,'recorded',$3)",
      [randomUUID(), w.dealId, a.id])
    expect((await oldPay(w, 50000)).statusCode).toBe(200)
    const b = (await create(w, { title: 'Отменённый этап', due: '2027-06-01', amount: money(100000) })).json() as Stage
    const paidB = await pay(w, b.id, 20000)
    expect(paidB.statusCode, paidB.body).toBe(200)
    const cancelB = await edit(w, b.id, { version: paidB.json().version, cancelled: true })
    expect(cancelB.statusCode, cancelB.body).toBe(200)
    expect(await financeRows(w)).toEqual({ installments: 2, payments: 4 })
    return { a, b }
  }
  /**
   * Дождаться, пока чужой запрос встанет в очередь за замком транзакции `pid`.
   * Ожидание — факт из pg_stat_activity, а не таймер: таймер не знает, дошёл ли запрос
   * до замка, и при медленном старте тест проходил при любом порядке замков (ревью 018, C-11).
   */
  async function blockedBy(pid: number, timeoutMs = 5000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const { rows } = await app.db!.query<{ query: string }>(
        "select query from pg_stat_activity where wait_event_type='Lock' and $1=any(pg_blocking_pids(pid))", [pid])
      if (rows.length > 0) return rows.map(r => r.query)
      if (Date.now() > deadline) throw new Error(`за замком транзакции ${pid} никто не встал за ${timeoutMs} мс`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  it('привязывает прежнюю оплату без второй записи и позволяет снять привязку', async () => {
    const w=await setup(), stage=(await create(w)).json()
    expect((await oldPay(w,100000)).statusCode).toBe(200)
    const id=await paymentId(w)
    expect((await read(w)).json().summary.unallocated).toEqual(money(100000))
    const result=await link(w,id,stage.id)
    expect(result.statusCode,result.body).toBe(200)
    const state=(await read(w)).json()
    expect(state.items[0].paid).toEqual(money(100000))
    expect(state.summary.unallocated).toEqual(money(0))
    expect(state.payments).toHaveLength(1)
    expect((await link(w,id,null,result.json().version)).statusCode).toBe(200)
    expect((await read(w)).json().items[0].paid).toEqual(money(0))
  })
  it('не привязывает сумму к другому подрядчику и отклоняет устаревшую привязку', async () => {
    const w=await setup(), other=await setup(), a=(await create(w)).json(), b=(await create(other)).json()
    await oldPay(w,100000)
    const id=await paymentId(w)
    expectError(await link(w,id,b.id),404,'not_found')
    expect((await link(w,id,a.id)).statusCode).toBe(200)
    expectError(await link(w,id,null,1),409,'stale_payment_plan')
    expect((await read(w)).json().items[0].paid).toEqual(money(100000))
  })
  it('две оплаты из одной версии не проходят обе и не превышают остаток', async () => {
    const w=await setup(), stage=(await create(w)).json()
    const results=await Promise.all([pay(w,stage.id,300000),pay(w,stage.id,300000)])
    expect(results.map(r=>r.statusCode).sort()).toEqual([200,409])
    // Вторая ждёт замок сделки и видит уже новую версию этапа.
    expectError(results.find(r=>r.statusCode===409)!,409,'stale_payment_plan')
    expect((await read(w)).json().summary.recorded).toEqual(money(300000))
  })
  it('старый и новый способы оплаты используют один предел цены сделки', async () => {
    const w=await setup(1000000), stage=(await create(w,{amount:money(1000000)})).json()
    const results=await Promise.all([pay(w,stage.id,700000),oldPay(w,700000)])
    expect(results.map(r=>r.statusCode).sort()).toEqual([200,409])
    // В любом порядке проигравший упирается в цену сделки, а не в версию этапа.
    expectError(results.find(r=>r.statusCode===409)!,409,'overpay')
    expect((await read(w)).json().summary.recorded).toEqual(money(700000))
  })
  it('не повторяет оплату при другом теле с прежним ключом', async () => {
    const w=await setup(), stage=(await create(w)).json(), key=randomUUID()
    const first=await pay(w,stage.id,100000,1,key)
    expect(first.statusCode,first.body).toBe(200)
    /* Версия — актуальная, после первой оплаты. С устаревшей 409 дала бы сверка версии
     * (stale_payment_plan), и тест был зелёным и без сверки ключа (ревью 018, C-03). */
    const version=first.json().version
    expectError(await pay(w,stage.id,200000,version,key),409,'idempotency_key_reused')
    expect((await read(w)).json().payments).toHaveLength(1)
    // То же тело с новым ключом проходит: отказ выше дал только ключ.
    const fresh=await pay(w,stage.id,200000,version)
    expect(fresh.statusCode,fresh.body).toBe(200)
    expect((await read(w)).json().payments).toHaveLength(2)
  })
  it.each([0,-1,1.5,Number.MAX_SAFE_INTEGER+1])('отклоняет невалидную сумму %s без записей', async amount=>{
    const w=await setup();expectError(await create(w,{amount:money(amount)}),422,'validation_failed')
    expect((await read(w)).json().items).toHaveLength(0)
  })
  it('отклоняет чужую валюту, пустое название и превышение цены',async()=>{
    const w=await setup()
    expectError(await create(w,{amount:{amount:100,currency:'USD'}}),422,'validation_failed')
    expectError(await create(w,{title:'  '}),422,'validation_failed')
    expectError(await create(w,{amount:money(1000001)}),409,'plan_over_price')
    await create(w,{amount:money(800000)})
    expectError(await create(w,{amount:money(300000)}),409,'plan_over_price')
  })
  it('не скрывает изменение суммы внутри отмены и не уменьшает ниже оплаченного',async()=>{
    const w=await setup(), stage=(await create(w)).json(), paid=(await pay(w,stage.id,100000)).json()
    expectError(await edit(w,stage.id,{version:paid.version,amount:money(99999)}),409,'plan_below_paid')
    expectError(await edit(w,stage.id,{version:paid.version,cancelled:true,amount:money(1)}),422,'validation_failed')
    expect((await read(w)).json().items[0].amount).toEqual(money(400000))
  })
  it('возврат уменьшает итог, отменённая отметка не считается, версии обновляются',async()=>{
    const w=await setup(), stage=(await create(w)).json()
    await pay(w,stage.id,300000)
    await app.db!.query("insert into payments(id,deal_id,kind,amount,status,installment_id) values($1,$2,'refund',100000,'recorded',$3)",[randomUUID(),w.dealId,stage.id])
    const data=(await read(w)).json()
    expect(data.items[0]).toMatchObject({paid:money(200000),remaining:money(200000),version:3})
    expect(data.summary.recorded).toEqual(money(200000))
    await app.db!.query("update payments set status='cancelled' where deal_id=$1 and kind='refund'",[w.dealId])
    expect((await read(w)).json().items[0]).toMatchObject({paid:money(300000),version:4})
  })
  it('отмена сделки снимает планы, но удержанные деньги остаются в истории',async()=>{
    const w=await setup(), stage=(await create(w)).json()
    await pay(w,stage.id,100000)
    const cancel=await app.inject({method:'PATCH',url:`/deals/${w.dealId}`,headers:headers(w),payload:{state:'cancelled'}})
    expect(cancel.statusCode,cancel.body).toBe(200)
    const state=(await read(w,'?from=2027-01-01&to=2027-12-31&includeCancelled=true')).json()
    expect(state.items[0].status).toBe('cancelled')
    expect(state.summary.committed).toEqual(money(0))
    expect(state.summary.inactiveDealRecorded).toEqual(money(100000))
    expect(state.payments).toHaveLength(1)
    // Версия актуальная — отказ даёт отменённая сделка, а не устаревший экран.
    expectError(await pay(w,stage.id,1,state.items[0].version),409,'not_booked')
  })
  it('перенос свадьбы не сдвигает согласованные даты платежей',async()=>{
    const w=await setup();await create(w)
    const moved=await app.inject({method:'PATCH',url:`/weddings/${w.id}`,headers:headers(w),payload:{date:'2027-07-20'}})
    expect(moved.statusCode,moved.body).toBe(200)
    expect((await read(w)).json().items[0].due).toBe('2027-05-01')
  })
  it('снижение цены требует явной сверки плана, старая версия недействительна',async()=>{
    const w=await setup(), stage=(await create(w,{amount:money(900000)})).json()
    const price=await app.inject({method:'PATCH',url:`/deals/${w.dealId}`,headers:headers(w),payload:{price:money(700000)}})
    expect(price.statusCode,price.body).toBe(200)
    const data=(await read(w)).json()
    expect(data.deals[0].needsReview).toBe(true)
    expectError(await edit(w,stage.id,{version:1,amount:money(700000)}),409,'stale_payment_plan')
    expect((await edit(w,stage.id,{version:data.items[0].version,amount:money(700000)})).statusCode).toBe(200)
    expect((await read(w)).json().deals[0].needsReview).toBe(false)
  })
  it('отдельно фильтрует окно, просрочки и отменённые этапы',async()=>{
    const w=await setup()
    /* Даты — от «сегодня» свадьбы тем же выражением, что у сервера (R-310), а не от часов
     * машины в UTC и не от 2027 года: итог не зависит ни от дня, ни от часа запуска.
     * Отменённый этап лежит в окне — иначе умолчание includeCancelled=false не проверено (ревью 018, C-12). */
    const [past,from,due,to]=await Promise.all([-5,10,20,30].map(n=>weddingDay(w,n)))
    const overdue=await create(w,{title:'Просрочено',due:past})
    expect(overdue.statusCode,overdue.body).toBe(201)
    const planned=await create(w,{title:'План',due})
    expect(planned.statusCode,planned.body).toBe(201)
    const dropped=await create(w,{title:'Отменён',due,amount:money(100000)})
    expect(dropped.statusCode,dropped.body).toBe(201)
    const cancel=await edit(w,dropped.json().id,{version:1,cancelled:true})
    expect(cancel.statusCode,cancel.body).toBe(200)
    const titles=async(query:string)=>{
      const res=await read(w,`?from=${from}&to=${to}${query}`)
      expect(res.statusCode,res.body).toBe(200)
      return (res.json().items as Stage[]).map(i=>i.title).sort()
    }
    expect(await titles('&includeOverdue=false')).toEqual(['План'])
    // Умолчание: просрочку вне окна показывает, отменённые — нет.
    expect(await titles('')).toEqual(['План','Просрочено'])
    expect(await titles('&includeCancelled=true')).toEqual(['Отменён','План','Просрочено'])
    expect(await titles('&includeCancelled=true&includeOverdue=false')).toEqual(['Отменён','План'])
    const data=(await read(w,`?from=${from}&to=${to}`)).json()
    expect(data.range).toMatchObject({from,to,includeOverdue:true,includeCancelled:false})
    expect(stageOf(data.items,overdue.json().id)).toMatchObject({overdue:true,remaining:money(400000)})
    expect(stageOf(data.items,planned.json().id)).toMatchObject({overdue:false,remaining:money(400000)})
    // «К оплате в окне» — только срок в окне; просрочка — своей суммой (M-09).
    expect(data.dueInWindow).toEqual(money(400000))
    expect(data.overdueRemaining).toEqual(money(400000))
    expectError(await read(w,'?from=2027-05-02&to=2027-05-01'),422,'bad_payment_range')
    expectError(await read(w,'?from=2027-01-01&to=2029-01-01'),422,'bad_payment_range')
  })
  it('CSV различает планы и оплаты, нейтрализует формулы и закрыт чужому',async()=>{
    const w=await setup();await create(w,{title:'=HYPERLINK("bad")'})
    await oldPay(w,100000)
    const csv=await app.inject({method:'GET',url:`/weddings/${w.id}/payment-schedule/export`,headers:headers(w)})
    expect(csv.statusCode,csv.body).toBe(200)
    expect(csv.json().records).toBe(2)
    expect(csv.json().csv).toContain('"plan"')
    expect(csv.json().csv).toContain('"payment"')
    expect(csv.json().csv).toContain("'=HYPERLINK")
    const other=await user()
    expectError(await app.inject({method:'GET',url:`/weddings/${w.id}/payment-schedule/export`,headers:{authorization:'Bearer '+other.token}}),404,'not_found')
  })
  it('CSV сохраняет возврат числом со знаком минус, не текстом формулы',async()=>{
    const w=await setup();await oldPay(w,100000)
    await app.db!.query("insert into payments(id,deal_id,kind,amount,status) values($1,$2,'refund',25000,'recorded')",[randomUUID(),w.dealId])
    const result=await app.inject({method:'GET',url:`/weddings/${w.id}/payment-schedule/export`,headers:headers(w)})
    expect(result.statusCode,result.body).toBe(200)
    expect(result.json().csv).toContain('"-25000";"RUB"')
    expect(result.json().csv).not.toContain("'-25000")
  })
  it('удалённая или отменённая свадьба не принимает финансовые изменения',async()=>{
    const w=await setup(), stage=(await create(w)).json()
    await app.db!.query('update weddings set cancelled_at=now() where id=$1',[w.id])
    expect((await read(w)).json().readOnly).toBe(true)
    expectError(await pay(w,stage.id,1),409,'wedding_cancelled')
    expectError(await create(w),409,'wedding_cancelled')
    await app.db!.query('update weddings set archived_at=now() where id=$1',[w.id])
    expectError(await read(w),404,'not_found')
  })
  it('отказ аудита откатывает оплату и не оставляет ложную отметку',async()=>{
    const w=await setup(), stage=(await create(w)).json(), fn='plan_fault_'+randomUUID().replaceAll('-','')
    /* DDL на общей audit_log: CREATE TRIGGER берёт SHARE ROW EXCLUSIVE, DROP — ACCESS EXCLUSIVE;
     * оба ждут открытые транзакции соседей и останавливают запись их журнала. Поэтому файл
     * в серийной группе (соседей нет), а каждая команда — с lock_timeout: чужой зависший
     * замок даёт понятный отказ, а не таймаут всего теста (ревью 018, C-10/M-15). */
    const ddl=(sql:string)=>app.db!.tx(async tx=>{await tx.query("set local lock_timeout='5s'");await tx.query(sql)})
    await ddl(`create function ${fn}() returns trigger language plpgsql as $$ begin
      if new.actor_id='${w.owner.id}' and new.action='payment.recorded' then raise exception 'injected audit failure'; end if; return new; end $$`)
    await ddl(`create trigger ${fn} before insert on audit_log for each row execute function ${fn}()`)
    try {
      expect((await pay(w,stage.id,100000)).statusCode).toBe(500)
      expect((await read(w)).json().payments).toHaveLength(0)
      expect((await read(w)).json().items[0].version).toBe(1)
    } finally {
      await ddl(`drop trigger ${fn} on audit_log; drop function ${fn}()`)
    }
  })
  it('бюджет и Тиль используют тот же итог оплат, не сумму этапов',async()=>{
    const {weddingContext}=await import('../src/tilly/context.js')
    const w=await setup(), stage=(await create(w)).json();await pay(w,stage.id,100000)
    const budget=(await app.inject({method:'GET',url:`/weddings/${w.id}/budget`,headers:headers(w)})).json()
    expect(budget.paymentSummary).toEqual((await read(w)).json().summary)
    const context=await weddingContext(app.db!,w.id)
    expect(context.text).toContain('Отмечено оплат за вычетом возвратов 1 000 ₽')
    // Цены сделок — часть итога обязательств, а не второе «обязательства» рядом (ревью 018, M-08).
    expect(context.text).toContain('это часть итога выше, не прибавляй')
  })

  it('берёт замок свадьбы раньше пользователя: перенос и удаление аккаунта не образуют новый deadlock',async()=>{
    const w=await setup(), stage=(await create(w)).json()
    let startPayment: Promise<Awaited<ReturnType<typeof pay>>> | undefined
    await app.db!.tx(async tx=>{
      await tx.query('select id from weddings where id=$1 for update',[w.id])
      const {rows}=await tx.query<{pid:number}>('select pg_backend_pid() as pid')
      startPayment=pay(w,stage.id,100000)
      /* Оплата обязана реально стоять за замком свадьбы, прежде чем берём пользователя.
       * Бери она пользователя первой, её замок уже держал бы строку users, и запрос ниже
       * упёрся бы в lock_timeout — тест красный при неверном порядке, а не «как повезёт» (C-11). */
      const waiting=await blockedBy(rows[0]!.pid)
      expect(waiting.join('\n')).toContain('from weddings')
      await tx.query("set local lock_timeout='800ms'")
      await tx.query('select id from users where id=$1 for update',[w.owner.id])
    })
    const res=await startPayment!
    expect(res.statusCode,res.body).toBe(200)
  })

  /* ── Ревью 018-A: деньги сделки на этапах (M-01) ─────────────────────── */
  it('M-01: весь остаток старой кнопкой закрывает оба этапа — просрочки нет, одну отметку не разнести', async () => {
    const w = await setup(), { a, b, window } = await pastAndFuture(w)
    const paid = await oldPayRest(w)
    expect(paid.statusCode, paid.body).toBe(200)
    const data = (await read(w, window)).json()
    expect(stageOf(data.items, a.id)).toMatchObject({ status: 'covered', paid: money(0), allocated: money(400000), remaining: money(0), overdue: false })
    expect(stageOf(data.items, b.id)).toMatchObject({ status: 'covered', paid: money(0), allocated: money(600000), remaining: money(0), overdue: false })
    expect(data.dueInWindow).toEqual(money(0))
    expect(data.overdueRemaining).toEqual(money(0))
    expect(data.summary.remaining).toEqual(money(0))
    const payments = data.payments as PaymentView[]
    expect(payments).toHaveLength(1)
    expect(payments[0]).toMatchObject({ amount: money(1000000), installmentId: null })
    // Отметка целиком не помещается ни в один этап: привязка — отказ с кодом, а не молчаливое разнесение.
    for (const stage of [a, b]) expectError(await link(w, payments[0]!.id, stage.id, payments[0]!.version), 409, 'installment_overpay')
    expect(((await read(w, window)).json().payments as PaymentView[])[0]!.installmentId).toBeNull()
  })

  it('M-01: половина цены старой кнопкой — первый этап покрыт, второй частично, остатки сходятся со сделкой', async () => {
    const w = await setup(), { a, b, window } = await pastAndFuture(w)
    expect((await oldPay(w, 500000)).statusCode).toBe(200)
    const data = (await read(w, window)).json()
    expect(stageOf(data.items, a.id)).toMatchObject({ status: 'covered', allocated: money(400000), remaining: money(0), overdue: false })
    expect(stageOf(data.items, b.id)).toMatchObject({ status: 'partial', allocated: money(100000), remaining: money(500000), overdue: false })
    const remaining = (data.items as Stage[]).reduce((sum, i) => sum + i.remaining.amount, 0)
    expect(remaining).toBe(500000)
    expect(data.deals[0].remaining).toEqual(money(remaining))
    expect(data.summary.remaining).toEqual(money(remaining))
    expect(data.dueInWindow).toEqual(money(500000))
    expect(data.overdueRemaining).toEqual(money(0))
  })

  it('M-01: ответы графика с покрытым этапом — по схемам контракта', async () => {
    const w = await setup(), { a, b, window } = await pastAndFuture(w)
    expect((await oldPay(w, 500000)).statusCode).toBe(200)
    const schedule = await read(w, window)
    expect(schedule.statusCode, schedule.body).toBe(200)
    expect((schedule.json().allInstallments as { status: string }[]).map(i => i.status)).toEqual(['covered', 'partial'])
    expect.soft(await contractViolation('PaymentSchedule', schedule.json())).toBeNull()
    const renamed = await edit(w, a.id, { version: a.version, title: 'Аванс по договору' })
    expect(renamed.statusCode, renamed.body).toBe(200)
    expect(renamed.json().status).toBe('covered')
    expect.soft(await contractViolation('PaymentInstallment', renamed.json())).toBeNull()
    const linked = await link(w, await paymentId(w), b.id)
    expect(linked.statusCode, linked.body).toBe(200)
    expect.soft(await contractViolation('PaymentRecord', linked.json())).toBeNull()
    const csv = await app.inject({ method: 'GET', url: `/weddings/${w.id}/payment-schedule/export`, headers: headers(w) })
    expect(csv.statusCode, csv.body).toBe(200)
    expect.soft(await contractViolation('PaymentHistoryExport', csv.json())).toBeNull()
  })

  /* ── Коды отказов (C-04) ─────────────────────────────────────────────── */
  it('C-04: оплата этапа сверх его суммы, но в пределах цены — 409 installment_overpay, записи нет', async () => {
    const w = await setup(), stage = (await create(w)).json()
    expectError(await pay(w, stage.id, 400001), 409, 'installment_overpay')
    expect(await financeRows(w)).toEqual({ installments: 1, payments: 0 })
  })

  it('C-04: правка, поднимающая сумму этапов выше цены, — 409 plan_over_price, сумма прежняя', async () => {
    const w = await setup(), stage = (await create(w)).json()
    expect((await create(w, { title: 'Остаток', due: '2027-06-01', amount: money(600000) })).statusCode).toBe(201)
    expectError(await edit(w, stage.id, { version: 1, amount: money(400001) }), 409, 'plan_over_price')
    expect(stageOf((await read(w)).json().items, stage.id)).toMatchObject({ amount: money(400000), version: 1 })
  })

  it('C-04/M-11: предел 500 — только активные этапы: 500 активных — 409 payment_plan_limit, 500 отменённых — 201', async () => {
    const full = await setup(), freed = await setup()
    const fill = (w: W, cancelled: boolean) => app.db!.query(
      `insert into payment_installments(id,deal_id,title,amount,due,cancelled_at)
       select gen_random_uuid(),$1,'Этап '||g,1,'2027-05-01'::date,case when $2 then now() end from generate_series(1,500) g`,
      [w.dealId, cancelled])
    await fill(full, false)
    await fill(freed, true)
    expectError(await create(full), 409, 'payment_plan_limit')
    expect((await financeRows(full)).installments).toBe(500)
    // Отменённые этапы — история, а не занятые места: сделку они не запирают.
    const created = await create(freed)
    expect(created.statusCode, created.body).toBe(201)
    expect((await financeRows(freed)).installments).toBe(501)
  })

  it('C-04: отменённую отметку не привязать — 409 payment_cancelled', async () => {
    const w = await setup(), stage = (await create(w)).json()
    expect((await oldPay(w, 100000)).statusCode).toBe(200)
    const pid = await paymentId(w)
    await app.db!.query("update payments set status='cancelled' where id=$1", [pid])
    // Смена статуса подняла версию привязки триггером — берём актуальную, чтобы отказ дал статус, а не версия.
    const { rows } = await app.db!.query<{ plan_version: number }>('select plan_version from payments where id=$1', [pid])
    expectError(await link(w, pid, stage.id, rows[0]!.plan_version), 409, 'payment_cancelled')
    const after = await app.db!.query<{ installment_id: string | null }>('select installment_id from payments where id=$1', [pid])
    expect(after.rows[0]!.installment_id).toBeNull()
  })

  it('C-04: без Idempotency-Key ни одна запись графика не выполняется — 400 idempotency_key_required', async () => {
    const w = await setup(), stage = (await create(w)).json()
    expect((await oldPay(w, 100000)).statusCode).toBe(200)
    const pid = await paymentId(w)
    const requests = [
      { method: 'POST', url: `/weddings/${w.id}/payment-schedule`, payload: { dealId: w.dealId, title: 'Без ключа', due: '2027-06-01', amount: money(1000) } },
      { method: 'PATCH', url: `/weddings/${w.id}/payment-schedule/${stage.id}`, payload: { version: 1, title: 'Без ключа' } },
      { method: 'POST', url: `/weddings/${w.id}/payment-schedule/${stage.id}/pay`, payload: { version: 1, amount: money(1000) } },
      { method: 'PATCH', url: `/weddings/${w.id}/payments/${pid}/plan`, payload: { version: 1, installmentId: stage.id } },
    ] as const
    for (const request of requests) {
      expectError(await app.inject({ ...request, headers: bearer(w.owner.token) }), 400, 'idempotency_key_required')
    }
    const data = (await read(w)).json()
    expect(data.items).toHaveLength(1)
    expect(data.items[0]).toMatchObject({ title: 'Аванс', version: 1, paid: money(0) })
    expect(data.payments).toHaveLength(1)
    expect(data.payments[0].installmentId).toBeNull()
  })

  /* ── Возврат на этапе (M-04) ─────────────────────────────────────────── */
  it('M-04: снятие возврата, после которого оплаты этапа превысят его сумму, — 409 installment_overpay', async () => {
    const w = await setup(), stage = (await create(w)).json()
    expect((await pay(w, stage.id, 400000)).statusCode).toBe(200)
    const refundId = randomUUID()
    await app.db!.query("insert into payments(id,deal_id,kind,amount,status,installment_id) values($1,$2,'refund',100000,'recorded',$3)",
      [refundId, w.dealId, stage.id])
    const refunded = stageOf((await read(w)).json().items, stage.id)!
    expect(refunded.paid).toEqual(money(300000))
    const topUp = await pay(w, stage.id, 100000, refunded.version)
    expect(topUp.statusCode, topUp.body).toBe(200)
    const before = stageOf((await read(w)).json().items, stage.id)!
    expect(before.paid).toEqual(money(400000))
    // Без возврата нетто этапа — 500 000 при сумме 400 000.
    expectError(await link(w, refundId, null, 1), 409, 'installment_overpay')
    const after = stageOf((await read(w)).json().items, stage.id)!
    expect(after).toMatchObject({ paid: money(400000), version: before.version })
    const refund = await app.db!.query<{ installment_id: string | null }>('select installment_id from payments where id=$1', [refundId])
    expect(refund.rows[0]!.installment_id).toBe(stage.id)
  })

  /* ── Срок и период (M-11, C-18) ──────────────────────────────────────── */
  it.each(['0100-01-01', '1999-12-31', '2101-01-01'])('M-11: срок %s вне 2000–2100 — 422 bad_date при создании и при правке', async due => {
    const w = await setup()
    expectError(await create(w, { due }), 422, 'bad_date')
    const stage = (await create(w)).json()
    expectError(await edit(w, stage.id, { version: 1, due }), 422, 'bad_date')
    expect(((await read(w)).json().items as Stage[]).map(i => [i.id, i.due, i.version])).toEqual([[stage.id, '2027-05-01', 1]])
  })

  it('M-11: края диапазона сроков — 2000-01-01 и 2100-12-31 — принимаются', async () => {
    const w = await setup()
    for (const due of ['2000-01-01', '2100-12-31']) {
      const res = await create(w, { due, amount: money(100000) })
      expect(res.statusCode, res.body).toBe(201)
      expect(res.json().due).toBe(due)
    }
  })

  it('C-18: период графика — до 366 календарных дней включительно, и в високосном году тоже', async () => {
    const w = await setup()
    for (const [from, to] of [['2027-01-01', '2028-01-01'], ['2028-01-01', '2028-12-31']]) {
      const res = await read(w, `?from=${from}&to=${to}`)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().range).toMatchObject({ from, to })
    }
    for (const [from, to] of [['2027-01-01', '2028-01-02'], ['2028-01-01', '2029-01-01']]) {
      expectError(await read(w, `?from=${from}&to=${to}`), 422, 'bad_payment_range')
    }
  })

  /* ── Матрица ролей по всем шести операциям (P-04) ───────────────────── */
  it('P-04: шесть операций графика — только паре своей свадьбы: роли 403, чужая пара 404, без входа 401', async () => {
    const w = await setup(), stranger = await setup(), stage = (await create(w)).json()
    expect((await oldPay(w, 100000)).statusCode).toBe(200)
    const pid = await paymentId(w)
    const version = async (sql: string, id: string) => (await app.db!.query<{ v: number }>(sql, [id])).rows[0]!.v
    const stageVersion = () => version('select version as v from payment_installments where id=$1', stage.id)
    const paymentVersion = () => version('select plan_version as v from payments where id=$1', pid)
    /* Тела валидны на момент вызова: без проверки роли каждый запрос прошёл бы —
     * это и доказывает контрольный проход пары в конце. */
    const ops: { name: string; method: 'GET' | 'POST' | 'PATCH'; url: string; body?: () => Promise<object>; ok: number }[] = [
      { name: 'GET график', method: 'GET', url: `/weddings/${w.id}/payment-schedule?from=2027-01-01&to=2027-12-31`, ok: 200 },
      { name: 'POST этап', method: 'POST', url: `/weddings/${w.id}/payment-schedule`,
        body: async () => ({ dealId: w.dealId, title: 'Остаток', due: '2027-06-01', amount: money(100000) }), ok: 201 },
      { name: 'PATCH этап', method: 'PATCH', url: `/weddings/${w.id}/payment-schedule/${stage.id}`,
        body: async () => ({ version: await stageVersion(), title: 'Задаток' }), ok: 200 },
      { name: 'POST оплата этапа', method: 'POST', url: `/weddings/${w.id}/payment-schedule/${stage.id}/pay`,
        body: async () => ({ version: await stageVersion(), amount: money(1000) }), ok: 200 },
      { name: 'GET выгрузка CSV', method: 'GET', url: `/weddings/${w.id}/payment-schedule/export`, ok: 200 },
      { name: 'PATCH привязка оплаты', method: 'PATCH', url: `/weddings/${w.id}/payments/${pid}/plan`,
        body: async () => ({ version: await paymentVersion(), installmentId: stage.id }), ok: 200 },
    ]
    const call = async (op: (typeof ops)[number], auth: Record<string, string>) => app.inject({
      method: op.method, url: op.url, headers: { ...auth, 'idempotency-key': randomUUID() },
      ...(op.body ? { payload: await op.body() } : {}),
    })
    const outsiders: { who: string; id: string | null; auth: Record<string, string>; status: number; code: string }[] = []
    for (const role of ['helper', 'coordinator', 'vendor']) {
      const u = await user()
      await app.db!.query('insert into wedding_members(wedding_id,user_id,role) values($1,$2,$3)', [w.id, u.id, role])
      outsiders.push({ who: role, id: u.id, auth: bearer(u.token), status: 403, code: 'forbidden' })
    }
    outsiders.push({ who: 'пара чужой свадьбы', id: stranger.owner.id, auth: bearer(stranger.owner.token), status: 404, code: 'not_found' })
    outsiders.push({ who: 'без токена', id: null, auth: {}, status: 401, code: 'unauthorized' })
    for (const caller of outsiders) {
      for (const op of ops) {
        const res = await call(op, caller.auth)
        const code = (JSON.parse(res.body) as { error?: { code?: string } }).error?.code
        expect([caller.who, op.name, res.statusCode, code]).toEqual([caller.who, op.name, caller.status, caller.code])
      }
    }
    // Отказы ничего не записали: ни этапа, ни правки, ни оплаты, ни привязки, ни строки журнала.
    expect((await app.db!.query('select title,version from payment_installments where deal_id=$1', [w.dealId])).rows)
      .toEqual([{ title: 'Аванс', version: 1 }])
    expect((await app.db!.query('select installment_id from payments where deal_id=$1', [w.dealId])).rows).toEqual([{ installment_id: null }])
    const ids = outsiders.map(o => o.id).filter((id): id is string => id !== null)
    expect((await app.db!.query('select 1 from audit_log where actor_id=any($1)', [ids])).rowCount).toBe(0)
    // Контроль: те же запросы от пары проходят — отказы выше дала роль, а не форма запроса.
    for (const op of ops) {
      const res = await call(op, bearer(w.owner.token))
      expect([op.name, res.statusCode], res.body).toEqual([op.name, op.ok])
    }
  })

  /* ── Журнал (M-03, M-05) ─────────────────────────────────────────────── */
  it('M-03: журнал этапа — без названия и причины отмены, сущность payment_installment', async () => {
    const w = await setup(), stage = (await create(w, { title: 'Личное название' })).json()
    const renamed = await edit(w, stage.id, { version: 1, title: 'Секретный этап' })
    expect(renamed.statusCode, renamed.body).toBe(200)
    const cancelled = await edit(w, stage.id, { version: renamed.json().version, cancelled: true, reason: 'Тайная причина' })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
    // Сам этап причину помнит — её не пишет только журнал, переживающий стирание аккаунта.
    expect(cancelled.json()).toMatchObject({ status: 'cancelled', cancelReason: 'Тайная причина' })
    const { rows } = await app.db!.query<{ action: string; entity: string; actor_id: string; diff: Record<string, unknown>; text: string }>(
      'select action,entity,actor_id,diff,diff::text as text from audit_log where entity_id=$1 order by id', [stage.id])
    expect(rows.map(r => [r.action, r.entity, r.actor_id])).toEqual([
      ['payment_plan.created', 'payment_installment', w.owner.id],
      ['payment_plan.updated', 'payment_installment', w.owner.id],
      ['payment_plan.cancelled', 'payment_installment', w.owner.id],
    ])
    for (const row of rows) {
      for (const secret of ['Личное название', 'Секретный этап', 'Тайная причина']) {
        expect(row.text).not.toContain(secret)
        expect(JSON.stringify(row.diff)).not.toContain(secret)
      }
    }
    expect(rows[1]!.diff).toMatchObject({ previousVersion: 1, changed: ['title'] })
    expect(rows[2]!.diff).toMatchObject({ previousVersion: renamed.json().version, changed: ['reason'] })
  })

  it('M-05: оплата старой кнопкой слота пишет payment.recorded с сущностью payment, как и новая дверь', async () => {
    const w = await setup(), stage = (await create(w)).json()
    expect((await oldPay(w, 250000)).statusCode).toBe(200)
    const slotPayment = await paymentId(w)
    const journal = async (id: string) => (await app.db!.query('select action,entity,actor_id,diff from audit_log where entity_id=$1 order by id', [id])).rows
    expect(await journal(slotPayment)).toEqual([{ action: 'payment.recorded', entity: 'payment', actor_id: w.owner.id,
      diff: { dealId: w.dealId, installmentId: null, paymentMethod:'other', visibility:'private', amountKnown:true, paidOn:null, version:1, amount:250000 } }])
    // Новая дверь и привязка — та же сущность payment (P-07).
    expect((await pay(w, stage.id, 100000)).statusCode).toBe(200)
    const stagePayment = (await app.db!.query<{ id: string }>('select id from payments where installment_id=$1', [stage.id])).rows[0]!.id
    expect(await journal(stagePayment)).toEqual([{ action: 'payment.recorded', entity: 'payment', actor_id: w.owner.id,
      diff: { dealId: w.dealId, installmentId: stage.id, paymentMethod:'other', visibility:'private', amountKnown:true, paidOn:null, version:1, amount:100000 } }])
    expect((await link(w, slotPayment, stage.id)).statusCode).toBe(200)
    expect((await journal(slotPayment)).map(r => [r.action, r.entity, r.diff])).toEqual([
      ['payment.recorded', 'payment', { dealId: w.dealId, installmentId: null, paymentMethod:'other', visibility:'private', amountKnown:true, paidOn:null, version:1, amount:250000 }],
      ['payment.plan_linked', 'payment', { from: null, to: stage.id }],
    ])
  })


  /* ── Feature 021: способы оплаты, неполная сумма и vendor isolation ───── */

  const pay021 = (w: W, id: string, body: Record<string, unknown>, key = randomUUID()) =>
    app.inject({method:'POST',url:`/weddings/${w.id}/payment-schedule/${id}/pay`,
      headers:headers(w,key),payload:body})

  async function catalogVendor(name: string) {
    const account=await user(), vendorId=randomUUID()
    await app.db!.query(`insert into vendors(id,user_id,category_id,name,published_at)
      values($1,$2,'photo',$3,now())`,[vendorId,account.id,name])
    return {account,vendorId}
  }

  async function attachVendor(w: W, vendorId: string) {
    await app.db!.query('update deals set vendor_id=$2,external_name=null where id=$1',[w.dealId,vendorId])
  }

  it.each(['cash','bank_transfer','card','other'])('021: %s сохраняется на конкретной оплате и не меняет математику', async paymentMethod => {
    const w=await setup(), stage=(await create(w)).json()
    const res=await pay021(w,stage.id,{version:1,amount:money(150000),paymentMethod,visibility:'private',paidOn:'2027-06-18'})
    expect(res.statusCode,res.body).toBe(200)
    expect(res.json()).toMatchObject({paid:money(150000),remaining:money(250000),status:'partial'})
    const row=(await app.db!.query('select amount::text as amount,payment_method,visibility,amount_known,paid_on::text as paid_on from payments where deal_id=$1',[w.dealId])).rows[0]
    expect(row).toEqual({amount:'150000',payment_method:paymentMethod,visibility:'private',amount_known:true,paid_on:'2027-06-18'})
  })

  it('021: неизвестная сумма — NULL, не 0, не гасит долг и помечает агрегаты неполными', async () => {
    const w=await setup(), stage=(await create(w)).json()
    expect((await pay(w,stage.id,100000)).statusCode).toBe(200)
    const current=(await read(w)).json().items[0]
    const res=await pay021(w,stage.id,{version:current.version,amountKnown:false,paymentMethod:'cash',visibility:'private',paidOn:'2027-06-18'})
    expect(res.statusCode,res.body).toBe(200)
    expect(res.json()).toMatchObject({paid:money(100000),remaining:money(300000),unknownAmountPayments:1})
    const data=(await read(w)).json()
    expect(data.summary).toMatchObject({recorded:money(100000),remaining:money(900000),unknownAmountPayments:1,amountIncomplete:true})
    const unknown=(await app.db!.query('select amount,amount_known from payments where deal_id=$1 and not amount_known',[w.dealId])).rows[0]
    expect(unknown).toEqual({amount:null,amount_known:false})
  })

  it('021: idempotency держит cash, transfer и unknown amount одной строкой на retry', async () => {
    for(const body of [
      {amount:money(10000),paymentMethod:'cash',visibility:'private',paidOn:'2027-06-18'},
      {amount:money(10000),paymentMethod:'bank_transfer',visibility:'private',paidOn:'2027-06-18'},
      {amountKnown:false,paymentMethod:'cash',visibility:'private',paidOn:'2027-06-18'},
    ]) {
      const w=await setup(), stage=(await create(w)).json(), key=randomUUID()
      const first=await pay021(w,stage.id,{version:1,...body},key)
      const replay=await pay021(w,stage.id,{version:1,...body},key)
      expect(first.statusCode,first.body).toBe(200); expect(replay.statusCode,replay.body).toBe(200)
      expect((await app.db!.query('select id from payments where deal_id=$1',[w.dealId])).rowCount).toBe(1)
    }
  })

  it('021: два устройства не могут одновременно переплатить остаток этапа', async () => {
    const w=await setup(20000), stage=(await create(w,{amount:money(20000)})).json()
    const [a,b]=await Promise.all([
      pay021(w,stage.id,{version:1,amount:money(20000),paymentMethod:'cash',visibility:'private',paidOn:'2027-06-18'}),
      pay021(w,stage.id,{version:1,amount:money(20000),paymentMethod:'card',visibility:'private',paidOn:'2027-06-18'}),
    ])
    expect([a.statusCode,b.statusCode].sort()).toEqual([200,409])
    expect((await app.db!.query<{total:string}>('select coalesce(sum(amount),0)::text as total from payments where deal_id=$1',[w.dealId])).rows[0]!.total).toBe('20000')
  })

  it('021: vendor видит только visibility=vendor своей сделки; private/finance_members не текут в список и агрегаты', async () => {
    const a=await setup(), b=await setup(), va=await catalogVendor('Vendor A'), vb=await catalogVendor('Vendor B')
    await attachVendor(a,va.vendorId); await attachVendor(b,vb.vendorId)
    const sa=(await create(a)).json(), sb=(await create(b)).json()
    let version=1
    for(const payment of [
      {amount:money(30000),paymentMethod:'cash',visibility:'private'},
      {amount:money(20000),paymentMethod:'card',visibility:'finance_members'},
      {amount:money(10000),paymentMethod:'bank_transfer',visibility:'vendor'},
    ]) {
      const res=await pay021(a,sa.id,{version,...payment,paidOn:'2027-06-18'})
      expect(res.statusCode,res.body).toBe(200); version=res.json().version
    }
    expect((await pay021(b,sb.id,{version:1,amount:money(150000),paymentMethod:'bank_transfer',visibility:'vendor',paidOn:'2027-06-18'})).statusCode).toBe(200)

    const own=await app.inject({method:'GET',url:`/vendor/deals/${a.dealId}/payments`,headers:bearer(va.account.token)})
    expect(own.statusCode,own.body).toBe(200)
    expect(own.json()).toHaveLength(1)
    expect(own.json()[0]).toMatchObject({dealId:a.dealId,amount:money(10000),paymentMethod:'bank_transfer',visibility:'vendor'})

    const deals=await app.inject({method:'GET',url:'/vendor/deals',headers:bearer(va.account.token)})
    expect(deals.statusCode,deals.body).toBe(200)
    const item=deals.json().items.find((x:{id:string})=>x.id===a.dealId)
    expect(item.paid).toEqual(money(10000))
    expect(deals.json().expected.amount).toBe(990000)

    const foreign=await app.inject({method:'GET',url:`/vendor/deals/${b.dealId}/payments`,headers:bearer(va.account.token)})
    expectError(foreign,404,'not_found')
    const enumerated=await app.inject({method:'GET',url:`/vendor/deals/${randomUUID()}/payments`,headers:bearer(va.account.token)})
    expectError(enumerated,404,'not_found')
  })

  it('021: vendor receipt content требует свою сделку + vendor-visible payment + receipt id', async () => {
    const a=await setup(), b=await setup(), va=await catalogVendor('Receipt A'), vb=await catalogVendor('Receipt B')
    await attachVendor(a,va.vendorId); await attachVendor(b,vb.vendorId)
    const sa=(await create(a)).json(), sb=(await create(b)).json()
    expect((await pay021(a,sa.id,{version:1,amount:money(10000),paymentMethod:'cash',visibility:'private',paidOn:'2027-06-18'})).statusCode).toBe(200)
    expect((await pay021(b,sb.id,{version:1,amount:money(10000),paymentMethod:'cash',visibility:'vendor',paidOn:'2027-06-18'})).statusCode).toBe(200)
    const pa=(await app.db!.query<{id:string}>('select id from payments where deal_id=$1',[a.dealId])).rows[0]!.id
    const pb=(await app.db!.query<{id:string}>('select id from payments where deal_id=$1',[b.dealId])).rows[0]!.id
    const ra=randomUUID(), rb=randomUUID()
    await app.db!.query(`insert into payment_receipts(id,wedding_id,payment_id,filename,mime_type,size_bytes,content,uploaded_by)
      values($1,$2,$3,'a.png','image/png',$4,$5,$6),($7,$8,$9,'b.png','image/png',$4,$5,$10)`,
      [ra,a.id,pa,PNG.length,PNG,a.owner.id,rb,b.id,pb,b.owner.id])
    const url=(deal:string,payment:string,receipt:string)=>`/vendor/deals/${deal}/payments/${payment}/receipts/${receipt}/content`
    expectError(await app.inject({method:'GET',url:url(a.dealId,pa,ra),headers:bearer(va.account.token)}),404,'not_found')
    expectError(await app.inject({method:'GET',url:url(b.dealId,pb,rb),headers:bearer(va.account.token)}),404,'not_found')
    const own=await app.inject({method:'GET',url:url(b.dealId,pb,rb),headers:bearer(vb.account.token)})
    expect(own.statusCode,own.body).toBe(200)
    expect(own.json().contentBase64).toBe(PNG.toString('base64'))
  })

  it('021: архив скрывает vendor payment endpoints, deleted vendor user не авторизуется', async () => {
    const w=await setup(), v=await catalogVendor('Archived vendor'); await attachVendor(w,v.vendorId)
    const stage=(await create(w)).json()
    expect((await pay021(w,stage.id,{version:1,amount:money(10000),paymentMethod:'cash',visibility:'vendor',paidOn:'2027-06-18'})).statusCode).toBe(200)
    await app.db!.query('update weddings set archived_at=now() where id=$1',[w.id])
    expectError(await app.inject({method:'GET',url:`/vendor/deals/${w.dealId}/payments`,headers:bearer(v.account.token)}),404,'not_found')
    await app.db!.query('update users set deleted_at=now() where id=$1',[v.account.id])
    expect((await app.inject({method:'GET',url:`/vendor/deals/${w.dealId}/payments`,headers:bearer(v.account.token)})).statusCode).toBe(401)
  })


  /* ── Выгрузка 152-ФЗ (P-02) ──────────────────────────────────────────── */
  it('P-02: выгрузка своих данных — у пары этапы графика и привязка оплат, у помощника денег нет', async () => {
    const w = await setup(), helper = await user(), title = 'Этап выгрузки ' + randomUUID()
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')", [w.id, helper.id])
    const stage = (await create(w, { title })).json()
    expect((await pay(w, stage.id, 100000)).statusCode).toBe(200)
    const pid = (await app.db!.query<{ id: string }>('select id from payments where installment_id=$1', [stage.id])).rows[0]!.id
    const exportOf = async (token: string) => {
      const res = await app.inject({ method: 'GET', url: '/users/me/export', headers: bearer(token) })
      expect(res.statusCode, res.body).toBe(200)
      return res.json()
    }
    const couple = await exportOf(w.owner.token)
    expect(couple.paymentInstallments).toEqual([expect.objectContaining({
      id: stage.id, deal_id: w.dealId, wedding_id: w.id, title, amount: '400000', due: '2027-05-01', cancelled_at: null, cancel_reason: null })])
    expect(couple.payments).toEqual([expect.objectContaining({ id: pid, deal_id: w.dealId, installment_id: stage.id, amount: '100000', payment_method:'other', visibility:'private', amount_known:true })])
    const assistant = await exportOf(helper.token)
    expect(assistant.paymentInstallments).toEqual([])
    expect(assistant.payments).toEqual([])
    expect(JSON.stringify(assistant)).not.toContain(title)
  })

  /* ── Уборка архива и стирание аккаунта (P-08) ────────────────────────── */
  it('P-08: этап с оплатами и возвратом не мешает уборке отменённой свадьбы', async () => {
    const w = await setup()
    await financeHistory(w)
    // Архив старше любого чужого в базе: уборка берёт по сто свадеб, старшие первыми.
    await app.db!.query("update weddings set cancelled_at=now()-interval '20000 days',archived_at=now()-interval '20000 days' where id=$1", [w.id])
    await purgeArchivedWeddings(app)
    // Уборка глотает ошибку свадьбы в лог — доказательство только состояние базы (R-226).
    expect((await app.db!.query('select 1 from weddings where id=$1', [w.id])).rowCount).toBe(0)
    expect(await financeRows(w)).toEqual({ installments: 0, payments: 0 })
    expect((await app.db!.query("select 1 from audit_log where action='wedding.purged' and entity_id=$1", [w.id])).rowCount).toBe(1)
  })

  it('P-08: стирание аккаунта уносит свадьбу без наследника вместе с этапами и оплатами', async () => {
    const w = await setup()
    await financeHistory(w)
    await app.db!.tx(client => eraseUser(client, w.owner.id))
    expect((await app.db!.query('select 1 from users where id=$1', [w.owner.id])).rowCount).toBe(0)
    expect((await app.db!.query('select 1 from weddings where id=$1', [w.id])).rowCount).toBe(0)
    expect(await financeRows(w)).toEqual({ installments: 0, payments: 0 })
  })

  it('P-08: при стирании одного партнёра этапы и оплаты остаются второму нетронутыми', async () => {
    const w = await setup(), partner = await user()
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [w.id, partner.id])
    await financeHistory(w)
    const query = '?from=2027-01-01&to=2027-12-31&includeCancelled=true'
    const before = (await read(w, query)).json()
    await app.db!.tx(client => eraseUser(client, w.owner.id))
    expect((await app.db!.query('select 1 from users where id=$1', [w.owner.id])).rowCount).toBe(0)
    const heir = { ...w, owner: partner }
    const after = await read(heir, query)
    expect(after.statusCode, after.body).toBe(200)
    expect(after.json().items).toEqual(before.items)
    expect(after.json().payments).toEqual(before.payments)
    expect(after.json().summary).toEqual(before.summary)
  })

  /* Найдено по пути (018-B): подтверждение оплаты помнит загрузившего ссылкой на users без
   * ON DELETE, и eraseUser её не обнуляет — стирание партнёра, чья свадьба остаётся второму,
   * падает на внешнем ключе, и аккаунт не стирается никогда. Файл кладётся SQL, как его
   * оставила бы загрузка: сама загрузка выключена, пока владелец не включит хранилище. */
  it('P-08: подтверждение к оплате не мешает стиранию партнёра, чью свадьбу наследует второй', async () => {
    const w = await setup(), partner = await user()
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [w.id, partner.id])
    const { a } = await financeHistory(w)
    const pid = (await app.db!.query<{ id: string }>("select id from payments where installment_id=$1 and kind<>'refund'", [a.id])).rows[0]!.id
    await app.db!.query(`insert into payment_receipts(id,wedding_id,payment_id,filename,mime_type,size_bytes,content,uploaded_by)
      values($1,$2,$3,'чек.png','image/png',$4,$5,$6)`, [randomUUID(), w.id, pid, PNG.length, PNG, w.owner.id])
    await app.db!.tx(client => eraseUser(client, w.owner.id))
    expect((await app.db!.query('select 1 from users where id=$1', [w.owner.id])).rowCount).toBe(0)
    expect(await financeRows(w)).toEqual({ installments: 2, payments: 4 })
  })

  /* ── Ревью 018: «оплачено по этапу» держит база (инвариант 11, M-02/C-07) ── */
  it('M-02: сумму привязанных отметок ведёт триггер, CHECK держит её в [0; сумма этапа] для любого писателя', async () => {
    const w = await setup(), stage = (await create(w)).json() as { id: string }
    const paidOf = async () => (await app.db!.query<{ paid: string }>('select paid::text as paid from payment_installments where id=$1', [stage.id])).rows[0]!.paid
    expect((await pay(w, stage.id, 100000)).statusCode).toBe(200)
    expect(await paidOf()).toBe('100000')
    const pid = await paymentId(w)
    /* Писатель без `lockDeal` и без проверок кода — прямой SQL, как будущая дверь или правка данных.
     * До фикса база принимала переплату этапа молча. Транзакция откатывается в любом случае. */
    const direct = async (sql: string, params: unknown[]) => {
      const sentinel = new Error('rollback')
      let code: string | undefined, constraint: string | undefined
      try {
        await app.db!.tx(async client => {
          try { await client.query(sql, params) } catch (e) { code = (e as { code?: string }).code; constraint = (e as { constraint?: string }).constraint }
          throw sentinel
        })
      } catch (e) { if (e !== sentinel) throw e }
      return { code, constraint }
    }
    expect(await direct('update payments set amount=500000 where id=$1', [pid])).toEqual({ code: '23514', constraint: 'payment_installments_paid_range' })
    expect(await direct(`insert into payments(id,deal_id,kind,amount,status,installment_id) values($1,$2,'refund',200000,'recorded',$3)`,
      [randomUUID(), w.dealId, stage.id])).toEqual({ code: '23514', constraint: 'payment_installments_paid_range' })
    expect(await paidOf()).toBe('100000')
    // Отменённая отметка из суммы уходит — и из колонки тоже.
    await app.db!.query("update payments set status='cancelled' where id=$1", [pid])
    expect(await paidOf()).toBe('0')
  })
})
