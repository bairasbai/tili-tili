import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { components } from '../src/contract/api.generated.js'

const DB = process.env.TEST_DATABASE_URL
const POLICY = '2026-09-02'
const SECRET = 'a'.repeat(48)
type Contract = components['schemas']
type Actor = { id: string; token: string }

describe.skipIf(!DB)('FR007: согласования пары', () => {
  let app: FastifyInstance
  const users: string[] = [], weddings: string[] = []

  beforeAll(async () => {
    app = await buildApp({ env: 'test', databaseUrl: DB!, redisUrl: null, corsOrigins: [],
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'b'.repeat(48), policyVersion: POLICY })
    await app.ready()
  })
  afterAll(async () => {
    try {
      await app?.db?.query('delete from weddings where id=any($1::uuid[])', [weddings])
      await app?.db?.query('delete from users where id=any($1::uuid[])', [users])
    } finally { await app?.close() }
  })

  async function actor(name: string): Promise<Actor> {
    const id = randomUUID(), sid = randomUUID()
    await app.db!.query('insert into users(id,phone,name) values($1,$2,$3)',
      [id, `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`, name])
    users.push(id)
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sid, id, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), id, POLICY])
    return { id, token: await signAccessToken(SECRET, { sub: id, sid }) }
  }

  async function fixture() {
    const [author, partner, third, helper, outsider] = await Promise.all(
      ['Автор', 'Партнёр', 'Третий', 'Помощник', 'Посторонний'].map(actor))
    const id = randomUUID()
    await app.db!.query('insert into weddings(id,owner_id,title,invite_code) values($1,$2,$3,$4)', [id, author.id, 'FR007 fixture', id])
    weddings.push(id)
    await app.db!.query(`insert into wedding_members(wedding_id,user_id,role)
      values($1,$2,'couple'),($1,$3,'couple'),($1,$4,'couple'),($1,$5,'helper')`, [id, author.id, partner.id, third.id, helper.id])
    return { id, author, partner, third, helper, outsider }
  }

  function call(actor: Actor, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
    return app.inject({ method, url, payload, headers: { authorization: `Bearer ${actor.token}` } })
  }
  const path = (weddingId: string) => `/weddings/${weddingId}/decisions`
  async function read(actor: Actor, url: string) {
    const reply = await call(actor, 'GET', url)
    expect(reply.statusCode, reply.body).toBe(200)
    expect(reply.headers['cache-control']).toBe('no-store')
    return reply.json<Contract['CoupleDecisionBoard']>()
  }

  it('ограничивает доступ двумя выбранными участниками и сохраняет действующую редакцию', async () => {
    const { id, author, partner, third, helper, outsider } = await fixture()
    const url = path(id)
    const body = { requestId: randomUUID(), partnerId: partner.id, title: 'Зал', proposal: 'Выбрать светлый зал' }
    expect((await call(helper, 'GET', url)).statusCode).toBe(403)
    expect((await call(outsider, 'GET', url)).statusCode).toBe(404)
    expect((await call(author, 'POST', url, { ...body, partnerId: helper.id })).statusCode).toBe(422)
    const created = await call(author, 'POST', url, body)
    expect(created.statusCode, created.body).toBe(201)
    const decision = created.json<Contract['CoupleDecision']>()
    expect(decision).toMatchObject({ title: body.title, proposal: { version: 1, text: body.proposal,
      myResponse: null, partnerResponse: null }, effective: null })
    expect((await call(author, 'POST', url, { ...body, partnerId: partner.id.toUpperCase() })).json<Contract['CoupleDecision']>().id).toBe(decision.id)
    expect((await call(author, 'POST', url, { ...body, proposal: 'Другое предложение' })).statusCode).toBe(409)
    const response = `${url}/${decision.id}/response`, proposal = `${url}/${decision.id}/proposal`
    const approve = { version: 1, response: 'approved' }
    expect((await read(third, url)).items).toEqual([])
    expect((await call(third, 'PUT', response, approve)).statusCode).toBe(404)
    const replies = await Promise.all([call(author, 'PUT', response, approve), call(partner, 'PUT', response, approve)])
    expect(replies.map(reply => reply.statusCode), replies.map(reply => reply.body).join('\n')).toEqual([200, 200])
    const approved = (await read(partner, url)).items[0]!
    expect(approved).toMatchObject({ proposal: { myResponse: 'approved', partnerResponse: 'approved' }, effective: { version: 1, text: body.proposal } })
    expect((await call(author, 'PUT', response, approve)).statusCode).toBe(200)
    expect((await call(author, 'PUT', response, { ...approve, response: 'rejected' })).statusCode).toBe(409)

    const newProposal = { expectedVersion: 1, proposal: 'Выбрать зал с террасой' }
    const amended = await call(author, 'PUT', proposal, newProposal)
    expect(amended.statusCode, amended.body).toBe(200)
    expect((await call(author, 'PUT', proposal, newProposal)).statusCode).toBe(200)
    expect((await call(partner, 'PUT', response, approve)).statusCode).toBe(409)
    expect((await call(partner, 'PUT', response, { version: 2, response: 'rejected' })).statusCode).toBe(200)
    expect((await read(author, url)).items[0]).toMatchObject({ proposal: { version: 2, text: newProposal.proposal,
      myResponse: null, partnerResponse: 'rejected' }, effective: { version: 1, text: body.proposal } })

    const normal = await call(helper, 'POST', `/weddings/${id}/tasks`, { title: 'Обычная задача', period: '3' })
    expect(normal.statusCode, normal.body).toBe(201)
  })

  it('сериализует смену редакции и отзывает право партнёра после выхода из пары', async () => {
    const { id, author, partner } = await fixture()
    const url = path(id)
    const created = await call(author, 'POST', url, { requestId: randomUUID(), partnerId: partner.id, title: 'Транспорт', proposal: 'Автобус' })
    expect(created.statusCode, created.body).toBe(201)
    const { id: decisionId } = created.json<Contract['CoupleDecision']>()
    const revision = `${url}/${decisionId}/proposal`
    const results = await Promise.all([
      call(author, 'PUT', revision, { expectedVersion: 1, proposal: 'Поезд' }),
      call(partner, 'PUT', revision, { expectedVersion: 1, proposal: 'Такси' }),
    ])
    expect(results.map(reply => reply.statusCode).sort()).toEqual([200, 409])
    await app.db!.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [id, partner.id])
    expect((await call(partner, 'GET', url)).statusCode).toBe(404)
    expect((await read(author, url)).items[0]).toMatchObject({ partnerAvailable: false, proposal: { version: 2 } })
    expect((await call(author, 'PUT', `${url}/${decisionId}/response`, { version: 2, response: 'approved' })).statusCode).toBe(409)
  })
})
