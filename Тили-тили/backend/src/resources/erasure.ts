import type { Queryable } from '../plugins/db.js'
import { conflict } from '../errors.js'
import { checkEntityId } from '../orders/model.js'
import { prepareDealResourceRelease, type PreparedDealResourceRelease } from './commitments.js'

interface LocatedErasure { weddings: string[]; vendors: string[]; resources: string[] }
const sorted = (ids: string[]) => [...new Set(ids)].sort()

/** Locate before locks, then repeat after the account mutex. A new scope is
 * retried by the caller's transaction boundary; never acquire a new wedding
 * after accounts/resources and introduce the reverse booking order. */
async function locate(client:Queryable,userId:string):Promise<LocatedErasure> {
  const vendors=(await client.query<{id:string}>('select id from vendors where user_id=$1 order by id',[userId])).rows.map(r=>r.id)
  const resources=(await client.query<{id:string}>(`select id from vendor_resources
    where vendor_id=any($1::uuid[]) or person_user_id=$2 order by id`,[vendors,userId])).rows.map(r=>r.id)
  const weddings=(await client.query<{id:string}>(`select w.id from weddings w where w.owner_id=$1
    or exists(select 1 from wedding_members m where m.wedding_id=w.id and m.user_id=$1)
    or exists(select 1 from tasks t where t.wedding_id=w.id and t.assignee_id=$1)
    or exists(select 1 from notifications n join tasks t on t.id=n.task_id where t.wedding_id=w.id and n.user_id=$1)
    or exists(select 1 from deals d where d.wedding_id=w.id and d.vendor_id=any($2::uuid[]))
    or exists(select 1 from offer_requests r join slots s on s.id=r.slot_id
      where s.wedding_id=w.id and r.vendor_id=any($2::uuid[]))
    or exists(select 1 from vendor_staff_duties duty join vendor_staff_members m on m.id=duty.member_id
      where duty.wedding_id=w.id and m.user_id=$1)
    or exists(select 1 from resource_allocations a where a.wedding_id=w.id and a.resource_id=any($3::uuid[]))
    or exists(select 1 from deal_orders o join deal_resource_plan_versions p on p.id=o.resource_plan_id
      where o.wedding_id=w.id and exists(select 1 from jsonb_array_elements(p.private_snapshot->'lines') line
        where line->>'resourceId'=any(select id::text from vendor_resources where id=any($3::uuid[]))))
    order by w.id`,[userId,vendors,resources])).rows.map(r=>r.id)
  const scopeResources=(await client.query<{id:string}>(`select r.id from vendor_resources r where r.id=any($1::uuid[])
    or exists(select 1 from resource_allocations a where a.resource_id=r.id and a.wedding_id=any($2::uuid[]) and a.released_at is null)
    or exists(select 1 from deal_orders o join deal_resource_plan_versions p on p.id=o.resource_plan_id
      where o.wedding_id=any($2::uuid[]) and exists(select 1 from jsonb_array_elements(p.private_snapshot->'lines') line
        where line->>'resourceId'=r.id::text)) order by r.id`,[resources,weddings])).rows.map(r=>r.id)
  // An owned wedding may allocate another company's shared capacity. Its
  // cascade must not acquire those windows only after account deletion starts.
  return {weddings,vendors,resources:scopeResources}
}

async function lockSourceUnion(client:Queryable,weddingIds:string[],resourceIds:string[],extraAccounts:string[],companyIds:string[]) {
  const located=(await client.query<{id:string;vendor_id:string|null;person_user_id:string|null;staff_member_id:string|null;kind:string;conflict_identity:string}>(
    'select id,vendor_id,person_user_id,staff_member_id,kind,conflict_identity from vendor_resources where id=any($1::uuid[]) order by id',[resourceIds])).rows
  const staff=(await client.query<{id:string;vendor_id:string;user_id:string|null}>(
    'select id,vendor_id,user_id from vendor_staff_members where id=any($1::uuid[]) order by id',[sorted(located.flatMap(r=>r.staff_member_id?[r.staff_member_id]:[]))])).rows
  const companyOwners=(await client.query<{id:string;user_id:string}>(
    'select id,user_id from vendors where id=any($1::uuid[]) order by id',[sorted([...companyIds,...located.flatMap(r=>r.vendor_id?[r.vendor_id]:[]),...staff.map(m=>m.vendor_id)])])).rows
  const owners=(await client.query<{owner_id:string}>('select owner_id from weddings where id=any($1::uuid[])',[weddingIds])).rows
  const sourceAccounts=(await client.query<{user_id:string}>(`select user_id from wedding_members where wedding_id=any($1::uuid[])
    union select assignee_id as user_id from tasks where wedding_id=any($1::uuid[]) and assignee_id is not null
    union select n.user_id from notifications n join tasks t on t.id=n.task_id where t.wedding_id=any($1::uuid[])`,[weddingIds])).rows
  const accounts=sorted([...extraAccounts,...owners.map(w=>w.owner_id),...sourceAccounts.map(s=>s.user_id),...companyOwners.map(c=>c.user_id),...located.flatMap(r=>r.person_user_id?[r.person_user_id]:[]),...staff.flatMap(m=>m.user_id?[m.user_id]:[])])
  // Erasure later upgrades to DELETE. Taking UPDATE directly in UUID order
  // avoids two erasers holding SHARE on each other's target accounts.
  await client.query('select id from users where id=any($1::uuid[]) order by id for update',[accounts])
  await client.query('select id from vendors where id=any($1::uuid[]) order by id for update',[companyOwners.map(c=>c.id)])
  await client.query('select id from vendor_staff_members where id=any($1::uuid[]) order by id for update',[staff.map(m=>m.id)])
  const keys=[...new Map(located.map(r=>[`${r.kind}:${r.conflict_identity}`,{kind:r.kind,identity:r.conflict_identity}])).values()]
    .sort((a,b)=>a.kind.localeCompare(b.kind)||a.identity.localeCompare(b.identity))
  for(const key of keys) {
    await client.query('insert into resource_conflict_keys(kind,identity) values($1,$2) on conflict do nothing',[key.kind,key.identity])
    await client.query('select identity from resource_conflict_keys where kind=$1 and identity=$2 for update',[key.kind,key.identity])
  }
  await client.query('select id from vendor_resources where id=any($1::uuid[]) order by id for update',[resourceIds])
  await client.query('select id from resource_capacity_windows where resource_id=any($1::uuid[]) order by id for update',[resourceIds])
  const currentResources=(await client.query('select id,vendor_id,person_user_id,staff_member_id,kind,conflict_identity from vendor_resources where id=any($1::uuid[]) order by id',[resourceIds])).rows
  const currentCompanies=(await client.query('select id,user_id from vendors where id=any($1::uuid[]) order by id',[companyOwners.map(c=>c.id)])).rows
  const currentStaff=(await client.query('select id,vendor_id,user_id from vendor_staff_members where id=any($1::uuid[]) order by id',[staff.map(m=>m.id)])).rows
  if(JSON.stringify(located)!==JSON.stringify(currentResources)||JSON.stringify(companyOwners)!==JSON.stringify(currentCompanies)||JSON.stringify(staff)!==JSON.stringify(currentStaff)) {
    throw conflict('resource_erasure_scope_changed','Область удаления изменилась — повторите транзакцию удаления')
  }
  // Resource release must not acquire allocation parents only after historical N.
  await client.query('select id from resource_allocations where wedding_id=any($1::uuid[]) order by id for update',[weddingIds])
  await client.query('select id from tasks where wedding_id=any($1::uuid[]) order by id for update',[weddingIds])
  await client.query(`select n.id from notifications n where n.user_id=any($2::uuid[])
    or exists(select 1 from tasks t where t.id=n.task_id and t.wedding_id=any($1::uuid[])) order by n.id for update`,[weddingIds,extraAccounts])
}

/** Called first in actual eraseUser, before request/financial/account changes.
 * Preserves person promises in other companies; only the erased companies'
 * selected financial roots are prepared for release. */
export async function prepareUserResourceErasure(client:Queryable,userId:string):Promise<PreparedDealResourceRelease[]> {
  checkEntityId(userId,'userId')
  const located=await locate(client,userId)
  await client.query('select id from weddings where id=any($1::uuid[]) order by id for update',[located.weddings])
  // The offer version mutex precedes account/company locks in existing replies.
  await client.query('select id from offer_requests where vendor_id=any($1::uuid[]) order by id for update',[located.vendors])
  await client.query('select id from deals where wedding_id=any($1::uuid[]) order by id for update',[located.weddings])
  await client.query('select id from slots where wedding_id=any($1::uuid[]) order by id for update',[located.weddings])
  await client.query('select deal_id from deal_orders where wedding_id=any($1::uuid[]) order by deal_id for update',[located.weddings])
  await lockSourceUnion(client,located.weddings,located.resources,[userId],located.vendors)
  const pinned=await locate(client,userId)
  if(JSON.stringify(pinned)!==JSON.stringify(located))throw conflict('resource_erasure_scope_changed','Область удаления изменилась — повторите транзакцию удаления')
  const roots=(await client.query<{wedding_id:string;deal_id:string}>(`select c.wedding_id,c.deal_id from deal_resource_commitments c
    join deals d on d.wedding_id=c.wedding_id and d.id=c.deal_id
    where c.state='reserved' and d.vendor_id=any($1::uuid[]) order by c.wedding_id,c.deal_id`,[located.vendors])).rows
  const prepared:PreparedDealResourceRelease[]=[]
  for(const root of roots)prepared.push(await prepareDealResourceRelease(client,{weddingId:root.wedding_id,dealId:root.deal_id}))
  return prepared
}

/** Caller already pins the wedding eligibility row. Pin the entire union before
 * preparing individual roots, so per-deal iteration cannot reverse key order. */
export async function prepareWeddingResourceErasure(client:Queryable,weddingId:string):Promise<PreparedDealResourceRelease[]> {
  checkEntityId(weddingId,'weddingId')
  await client.query('select id from weddings where id=$1 for update',[weddingId])
  await client.query('select id from offer_requests where slot_id in(select id from slots where wedding_id=$1) order by id for update',[weddingId])
  const deals=(await client.query<{id:string;vendor_id:string|null}>('select id,vendor_id from deals where wedding_id=$1 order by id for update',[weddingId])).rows
  await client.query('select id from slots where wedding_id=$1 order by id for update',[weddingId])
  await client.query('select deal_id from deal_orders where wedding_id=$1 order by deal_id for update',[weddingId])
  const resourceIds=(await client.query<{resource_id:string}>('select distinct resource_id from resource_allocations where wedding_id=$1 and released_at is null',[weddingId])).rows.map(a=>a.resource_id)
  await lockSourceUnion(client,[weddingId],sorted(resourceIds),[],sorted(deals.flatMap(d=>d.vendor_id?[d.vendor_id]:[])))
  const roots=(await client.query<{deal_id:string}>('select deal_id from deal_resource_commitments where wedding_id=$1 and state=\'reserved\' order by deal_id',[weddingId])).rows
  const prepared:PreparedDealResourceRelease[]=[]
  for(const root of roots)prepared.push(await prepareDealResourceRelease(client,{weddingId,dealId:root.deal_id}))
  return prepared
}
