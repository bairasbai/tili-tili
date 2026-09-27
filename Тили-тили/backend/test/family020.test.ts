import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

interface User { id: string; token: string; phone: string }
interface Wedding extends User { weddingId: string }
interface Person {
  id: string
  partyId: string
  primary: boolean
  name: string
  status: 'yes' | 'no' | 'pending'
  tableId?: string | null
  busId?: string | null
  hotelId?: string | null
}

describe.skipIf(!live)('020: family invitation = one party, many persons', () => {
  let app: FastifyInstance
  let seq = 0
  const run = String(randomInt(100000, 999999))
  const ip = `198.18.${randomInt(0,255)}.${randomInt(1,254)}`
  const auth = (token: string) => ({ authorization: `Bearer ${token}` })

  beforeAll(async () => {
    app = await buildApp({
      env: 'test',
      databaseUrl: DB ?? null,
      redisUrl: null,
      corsOrigins: [],
      jwtAccessSecret: SECRET_A,
      jwtRefreshSecret: SECRET_R,
      policyVersion: '2026-09-02',
      otpMaxPerHourTotal: 1_000_000,
      otpMaxPerIpHour: 1_000_000,
    })
    await app.ready()
  })

  afterAll(async () => { await app?.close() })

  const nextPhone = () => `+7998${run}${String(++seq).padStart(2,'0')}`

  async function code(phone: string) {
    const { rows } = await app.db!.query<{ code_hash: string }>(
      'select code_hash from otp_codes where phone=$1 order by created_at desc limit 1', [phone],
    )
    for (let i=0;i<10000;i++) {
      const c=String(i).padStart(4,'0')
      if (hashCode(SECRET_R, phone, c) === rows[0]!.code_hash) return c
    }
    throw new Error('otp not found')
  }

  async function user(): Promise<User> {
    const phone=nextPhone()
    expect((await app.inject({method:'POST',url:'/auth/otp',payload:{phone},remoteAddress:ip})).statusCode).toBe(200)
    const v=await app.inject({method:'POST',url:'/auth/otp/verify',payload:{phone,code:await code(phone)}})
    expect(v.statusCode,v.body).toBe(200)
    const body=v.json()
    const token=body.accessToken as string
    expect((await app.inject({
      method:'POST',url:'/users/me/consent',headers:auth(token),payload:{policyVersion:'2026-09-02'},
    })).statusCode).toBe(201)
    return { id: body.user.id, token, phone }
  }

  async function wedding(): Promise<Wedding> {
    const u=await user()
    const w=await app.inject({
      method:'POST',url:'/weddings',headers:auth(u.token),
      payload:{partnerName:'Партнёр',date:'2027-06-14',city:{name:'Казань',region:'Татарстан'}},
    })
    expect(w.statusCode,w.body).toBe(201)
    return {...u,weddingId:w.json().id}
  }

  async function family(w: Wedding, names=['Анна','Иван']) {
    const r=await app.inject({
      method:'POST',url:`/weddings/${w.weddingId}/guests`,headers:auth(w.token),
      payload:{name:names[0],phone:nextPhone(),persons:names.slice(1).map(name=>({name}))},
    })
    expect(r.statusCode,r.body).toBe(201)
    const list=await app.inject({method:'GET',url:`/weddings/${w.weddingId}/guests`,headers:auth(w.token)})
    expect(list.statusCode,list.body).toBe(200)
    const all=list.json() as Person[]
    const primary=all.find(g=>g.name===names[0])!
    const members=all.filter(g=>g.partyId===primary.partyId)
    expect(members.map(g=>g.name)).toEqual(names)
    expect(members.filter(g=>g.primary)).toHaveLength(1)
    for (const p of members) expect((p as unknown as {plusOne?:unknown}).plusOne).toBeUndefined()
    return { primary, members }
  }

  async function tokenFor(w: Wedding, guestId: string) {
    const link=await app.inject({
      method:'POST',url:`/weddings/${w.weddingId}/guests/${guestId}/invite-link`,headers:auth(w.token),
    })
    expect(link.statusCode,link.body).toBe(200)
    const codePart=String(link.json().url).split('/').pop()!
    const redeem=await app.inject({method:'GET',url:`/invite/${codePart}`})
    expect(redeem.statusCode,redeem.body).toBe(200)
    return redeem.json() as {guestToken:string;guestName:string;persons:Person[]}
  }

  it('T001/T013 creates one family party with multiple real persons and one link', async () => {
    const w=await wedding()
    const f=await family(w)
    const invite=await tokenFor(w,f.primary.id)
    expect(invite.persons.map(p=>p.name)).toEqual(['Анна','Иван'])
    expect(invite.guestName).toBe('Анна')
    const parties=await app.db!.query<{n:string}>('select count(*)::text n from guest_parties where id=$1',[f.primary.partyId])
    expect(Number(parties.rows[0]!.n)).toBe(1)
  })

  it('T002 legacy plusOne input becomes a second person, not a multiplier flag', async () => {
    const w=await wedding()
    const r=await app.inject({
      method:'POST',url:`/weddings/${w.weddingId}/guests`,headers:auth(w.token),
      payload:{name:'Мария',plusOne:true},
    })
    expect(r.statusCode,r.body).toBe(201)
    const list=(await app.inject({method:'GET',url:`/weddings/${w.weddingId}/guests`,headers:auth(w.token)})).json() as Person[]
    const primary=list.find(p=>p.name==='Мария')!
    const party=list.filter(p=>p.partyId===primary.partyId)
    expect(party).toHaveLength(2)
    expect(party.some(p=>p.name==='Спутник/спутница')).toBe(true)
    const cols=await app.db!.query<{column_name:string}>(
      "select column_name from information_schema.columns where table_schema='public' and table_name='guests' and column_name in ('plus_one','rsvp_token')",
    )
    expect(cols.rows).toEqual([])
  })

  it('T007 family token answers persons independently and rejects foreign personId', async () => {
    const w=await wedding()
    const a=await family(w,['Олег','Лена'])
    const b=await family(w,['Чужой'])
    const invite=await tokenFor(w,a.primary.id)
    const r=await app.inject({
      method:'POST',url:`/rsvp/${invite.guestToken}`,
      payload:{persons:[
        {id:a.members[0]!.id,status:'yes',diet:'vegan',transfer:'need'},
        {id:a.members[1]!.id,status:'no'},
      ]},
    })
    expect(r.statusCode,r.body).toBe(200)
    const page=await app.inject({method:'GET',url:`/rsvp/${invite.guestToken}`})
    expect(page.statusCode,page.body).toBe(200)
    expect(page.json().persons).toEqual(expect.arrayContaining([
      expect.objectContaining({id:a.members[0]!.id,status:'yes',diet:'vegan',transfer:'need'}),
      expect.objectContaining({id:a.members[1]!.id,status:'no'}),
    ]))
    const foreign=await app.inject({
      method:'POST',url:`/rsvp/${invite.guestToken}`,
      payload:{persons:[{id:b.primary.id,status:'yes'}]},
    })
    expect(foreign.statusCode).toBe(404)
  })

  it('T008/T009 bus and menu are person-level and cannot use another family person', async () => {
    const w=await wedding()
    const a=await family(w,['А','Б'])
    const b=await family(w,['В'])
    const invite=await tokenFor(w,a.primary.id)

    const bus=await app.inject({
      method:'POST',url:`/weddings/${w.weddingId}/logistics/buses`,headers:auth(w.token),
      payload:{name:'Автобус',seats:2},
    })
    expect(bus.statusCode,bus.body).toBe(201)
    const busId=bus.json().id as string

    const poll=await app.inject({
      method:'PUT',url:`/weddings/${w.weddingId}/menu-poll`,headers:auth(w.token),
      payload:{question:'Горячее?',options:[{name:'Рыба'},{name:'Мясо'}]},
    })
    expect(poll.statusCode,poll.body).toBe(200)
    const options=poll.json().options as {id:string;name:string}[]

    for (let i=0;i<a.members.length;i++) {
      const p=a.members[i]!
      const sh=await app.inject({method:'POST',url:`/join/${invite.guestToken}/shuttle`,payload:{personId:p.id,busId}})
      expect(sh.statusCode,sh.body).toBe(200)
      const mv=await app.inject({method:'POST',url:`/join/${invite.guestToken}/menu-vote`,payload:{personId:p.id,optionId:options[i]!.id}})
      expect(mv.statusCode,mv.body).toBe(200)
    }

    const routes=await app.inject({method:'GET',url:`/join/${invite.guestToken}/shuttle`})
    expect(routes.json().bookings).toEqual(expect.arrayContaining(a.members.map(p=>({personId:p.id,busId}))))
    const menu=await app.inject({method:'GET',url:`/join/${invite.guestToken}/menu-vote`})
    expect(menu.json().votes).toEqual(expect.arrayContaining([
      {personId:a.members[0]!.id,optionId:options[0]!.id},
      {personId:a.members[1]!.id,optionId:options[1]!.id},
    ]))
    expect(routes.json().routes.find((x:{id:string})=>x.id===busId).taken).toBe(2)

    const foreign=await app.inject({method:'POST',url:`/join/${invite.guestToken}/shuttle`,payload:{personId:b.primary.id,busId}})
    expect(foreign.statusCode).toBe(404)
  })

  it('T003/T011 hotel is party-level: two persons still occupy one room and switching stays one', async () => {
    const w=await wedding()
    const f=await family(w,['Саша','Миша'])
    const invite=await tokenFor(w,f.primary.id)
    const make=async(name:string)=>{
      const r=await app.inject({
        method:'POST',url:`/weddings/${w.weddingId}/logistics/hotels`,headers:auth(w.token),
        payload:{name,rooms:2},
      })
      expect(r.statusCode,r.body).toBe(201)
      return r.json().id as string
    }
    const h1=await make('H1'), h2=await make('H2')
    expect((await app.inject({method:'POST',url:`/join/${invite.guestToken}/hotels`,payload:{hotelId:h1}})).statusCode).toBe(200)
    let q=await app.db!.query<{booked:number}>('select booked from hotel_blocks where id=$1',[h1])
    expect(q.rows[0]!.booked).toBe(1)
    expect((await app.inject({method:'POST',url:`/join/${invite.guestToken}/hotels`,payload:{hotelId:h1}})).json().alreadyBooked).toBe(true)
    expect((await app.inject({method:'POST',url:`/join/${invite.guestToken}/hotels`,payload:{hotelId:h2}})).statusCode).toBe(200)
    const counts=await app.db!.query<{id:string;booked:number}>('select id,booked from hotel_blocks where id=any($1::uuid[]) order by id',[[h1,h2]])
    expect(counts.rows.map(x=>x.booked).sort()).toEqual([0,1])
  })

  it('T010 seating counts each person once; capacity 2 rejects third person', async () => {
    const w=await wedding()
    const f=await family(w,['1','2','3'])
    const table=await app.inject({
      method:'POST',url:`/weddings/${w.weddingId}/tables`,headers:auth(w.token),payload:{name:'A',capacity:2},
    })
    expect(table.statusCode,table.body).toBe(201)
    for(const p of f.members.slice(0,2)) {
      const r=await app.inject({
        method:'PATCH',url:`/weddings/${w.weddingId}/guests/${p.id}`,headers:auth(w.token),payload:{tableId:table.json().id},
      })
      expect(r.statusCode,r.body).toBe(200)
    }
    const third=await app.inject({
      method:'PATCH',url:`/weddings/${w.weddingId}/guests/${f.members[2]!.id}`,headers:auth(w.token),payload:{tableId:table.json().id},
    })
    expect(third.statusCode).toBe(409)
    expect(third.json().error.code).toBe('table_full')
  })

  it('T011 one person saying no does not release family hotel while another still attends', async () => {
    const w=await wedding()
    const f=await family(w,['Ева','Макс'])
    const invite=await tokenFor(w,f.primary.id)
    const hotel=await app.inject({
      method:'POST',url:`/weddings/${w.weddingId}/logistics/hotels`,headers:auth(w.token),payload:{name:'H',rooms:1},
    })
    const hotelId=hotel.json().id as string
    await app.inject({method:'POST',url:`/join/${invite.guestToken}/hotels`,payload:{hotelId}})
    const ans=await app.inject({
      method:'POST',url:`/rsvp/${invite.guestToken}`,
      payload:{persons:[
        {id:f.members[0]!.id,status:'yes'},
        {id:f.members[1]!.id,status:'no'},
      ]},
    })
    expect(ans.statusCode,ans.body).toBe(200)
    expect((await app.db!.query('select 1 from hotel_bookings where party_id=$1',[f.primary.partyId])).rowCount).toBe(1)
    const allNo=await app.inject({
      method:'POST',url:`/rsvp/${invite.guestToken}`,
      payload:{persons:[
        {id:f.members[0]!.id,status:'no'},
        {id:f.members[1]!.id,status:'no'},
      ]},
    })
    expect(allNo.statusCode,allNo.body).toBe(200)
    expect((await app.db!.query('select 1 from hotel_bookings where party_id=$1',[f.primary.partyId])).rowCount).toBe(0)
  })
})
