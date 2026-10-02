import { createHash } from 'node:crypto'
import type { Queryable } from '../plugins/db.js'
import { conflict, forbidden, notFound, validationFailed } from '../errors.js'
import { uuidv7 } from '../ids.js'
import { knownTimeZone } from '../notify/quiet.js'
import type { ResourceKind } from '../resources/model.js'
import { lockOrderContext } from './context.js'
import { boundedText, checkEntityId, checkVersion, lockDraftOrder, objectValues, recordOrderChange,
  sameJson, validatePartDetails, type OrderInput, type OrderWriteInput } from './model.js'

export interface ResourcePlanLineInput { partId: string; resourceId: string; capacityWindowId: string | null;
  quantity: number; startsAt: string; endsAt: string; timeZone: string; setupMinutes: number; teardownMinutes: number;
  travelBeforeMinutes: number; travelAfterMinutes: number }
export interface PublicPlanLine { partId: string; assignmentId: string | null; programEventId: string | null;
  label: string; kind: ResourceKind; quantity: number; unit: string | null; startsAt: string; endsAt: string; timeZone: string;
  setupMinutes: number; teardownMinutes: number; travelBeforeMinutes: number; travelAfterMinutes: number;
  occupiedStartsAt: string; occupiedEndsAt: string; window: { startsAt: string; endsAt: string } | null }
export interface PublicResourcePlan { planRevisionId: string; revision: string; lines: PublicPlanLine[] }
export interface ResourcePlanView { orderVersion: string; revision: string; canEdit: boolean; reservation: 'not_reserved'|'reserved'|'released';
  current: PublicResourcePlan | null; editorLines: ResourcePlanLineInput[] | null;
  source: 'current' | 'invalid' | 'unavailable'; history: PublicResourcePlan[] }
type Source = ResourcePlanView['source']
interface PrivateLine extends PublicPlanLine { resourceId: string; conflictIdentity: string; capacityWindowId: string | null;
  partVersion: string; assignmentVersion: string | null }
interface Snapshot { schemaVersion: 1; lines: PrivateLine[] }
interface Head { version: string; resource_plan_revision: string; resource_plan_id: string | null }
interface Revision { id: string; wedding_id: string; deal_id: string; vendor_id: string; version: string;
  source_order_version: string; private_payload: string; private_snapshot: unknown; private_digest: string; public_snapshot: unknown }
interface ResourceRow { id: string; vendor_id: string | null; kind: ResourceKind; label: string; capacity_unit: string | null;
  conflict_identity: string; person_user_id: string | null; staff_member_id: string | null; retired_at: Date | null }
const inputKeys = ['partId','resourceId','capacityWindowId','quantity','startsAt','endsAt','timeZone',
  'setupMinutes','teardownMinutes','travelBeforeMinutes','travelAfterMinutes'] as const
const publicKeys = ['partId','assignmentId','programEventId','label','kind','quantity','unit','startsAt','endsAt','timeZone',
  'setupMinutes','teardownMinutes','travelBeforeMinutes','travelAfterMinutes','occupiedStartsAt','occupiedEndsAt','window'] as const
const privateKeys = [...publicKeys,'resourceId','conflictIdentity','capacityWindowId','partVersion','assignmentVersion']
const digest = (s: string) => createHash('sha256').update(s,'utf8').digest('hex')
const invalid = (message: string) => validationFailed({ resourcePlan: message })
class MaterialError extends Error {
  constructor(readonly source: Exclude<Source,'current'>, message: string) { super(message) }
}
function fail(source: Exclude<Source,'current'>, message: string): never { throw new MaterialError(source,message) }
function exact(value: unknown, keys: readonly string[], field: string): Record<string,unknown> {
  const object = objectValues(value,field)
  if (Reflect.ownKeys(object).length !== keys.length || keys.some(k => !Object.hasOwn(object,k))) throw invalid('Нужен полный состав полей')
  return object
}
/** Local canonical encoder deliberately does not import the terms module. */
function canonical(value: unknown): string {
  const path = new Set<object>()
  function encode(v: unknown, depth: number): string {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v)
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v)
    if (!v || typeof v !== 'object' || depth > 30 || path.has(v)) throw invalid('Недопустимый источник плана')
    path.add(v)
    try {
      if (Array.isArray(v)) {
        const items: string[] = []
        for (let i=0;i<v.length;i++) {
          const d=Object.getOwnPropertyDescriptor(v,i)
          if (!d || !('value' in d)) throw invalid('Недопустимый источник плана')
          items.push(encode(d.value,depth+1))
        }
        return '['+items.join(',')+']'
      }
      const o=objectValues(v,'resourcePlan')
      return '{'+Object.keys(o).sort().map(k=>JSON.stringify(k)+':'+encode(o[k],depth+1)).join(',')+'}'
    } finally { path.delete(v) }
  }
  return encode(value,0)
}
function normalize(value: unknown): ResourcePlanLineInput {
  const o=exact(value,inputKeys,'lines')
  checkEntityId(o.partId,'partId');checkEntityId(o.resourceId,'resourceId')
  if(o.capacityWindowId!==null)checkEntityId(o.capacityWindowId,'capacityWindowId')
  if(typeof o.quantity!=='number'||!Number.isSafeInteger(o.quantity)||o.quantity<1||o.quantity>2147483647)throw invalid('Нужно положительное целое количество')
  boundedText(o.timeZone,'timeZone',100)
  if(knownTimeZone(o.timeZone)!==o.timeZone)throw invalid('Нужен действительный часовой пояс')
  for(const key of ['setupMinutes','teardownMinutes','travelBeforeMinutes','travelAfterMinutes'] as const)
    if(typeof o[key]!=='number'||!Number.isSafeInteger(o[key])||o[key]<0||o[key]>1440)throw invalid('Буферы должны быть целыми минутами от 0 до 1440')
  validatePartDetails('supply',{windowStartsAt:o.startsAt,windowEndsAt:o.endsAt})
  if(typeof o.startsAt!=='string'||typeof o.endsAt!=='string')throw invalid('Нужен явный конечный интервал')
  const startsAt=new Date(o.startsAt).toISOString(),endsAt=new Date(o.endsAt).toISOString()
  return {partId:o.partId.toLowerCase(),resourceId:o.resourceId.toLowerCase(),capacityWindowId:o.capacityWindowId===null?null:o.capacityWindowId.toLowerCase(),
    quantity:o.quantity,startsAt,endsAt,timeZone:o.timeZone,setupMinutes:o.setupMinutes as number,teardownMinutes:o.teardownMinutes as number,
    travelBeforeMinutes:o.travelBeforeMinutes as number,travelAfterMinutes:o.travelAfterMinutes as number}
}
function occupied(line: ResourcePlanLineInput) {
  const a=Date.parse(line.startsAt)-(line.setupMinutes+line.travelBeforeMinutes)*60000
  const b=Date.parse(line.endsAt)+(line.teardownMinutes+line.travelAfterMinutes)*60000
  if(!Number.isFinite(a)||!Number.isFinite(b)||a>=b||!Number.isFinite(new Date(a).getTime())||!Number.isFinite(new Date(b).getTime()))throw invalid('Буферы выходят за конечный диапазон дат')
  return {occupiedStartsAt:new Date(a).toISOString(),occupiedEndsAt:new Date(b).toISOString()}
}
function inputs(value: unknown): ResourcePlanLineInput[] {
  if(!Array.isArray(value)||value.length>100)throw invalid('Допустимо до 100 строк')
  const lines=value.map(normalize),seen=new Set<string>()
  for(const line of lines){const key=canonical(line);if(seen.has(key))throw invalid('Повтор одинаковой строки');seen.add(key);occupied(line)}
  return lines
}
function editor(line: PrivateLine): ResourcePlanLineInput {
  return {partId:line.partId,resourceId:line.resourceId,capacityWindowId:line.capacityWindowId,quantity:line.quantity,
    startsAt:line.startsAt,endsAt:line.endsAt,timeZone:line.timeZone,setupMinutes:line.setupMinutes,teardownMinutes:line.teardownMinutes,
    travelBeforeMinutes:line.travelBeforeMinutes,travelAfterMinutes:line.travelAfterMinutes}
}
function publicLine(line: PrivateLine): PublicPlanLine {
  return {partId:line.partId,assignmentId:line.assignmentId,programEventId:line.programEventId,label:line.label,kind:line.kind,
    quantity:line.quantity,unit:line.unit,startsAt:line.startsAt,endsAt:line.endsAt,timeZone:line.timeZone,
    setupMinutes:line.setupMinutes,teardownMinutes:line.teardownMinutes,travelBeforeMinutes:line.travelBeforeMinutes,travelAfterMinutes:line.travelAfterMinutes,
    occupiedStartsAt:line.occupiedStartsAt,occupiedEndsAt:line.occupiedEndsAt,window:line.window===null?null:{startsAt:line.window.startsAt,endsAt:line.window.endsAt}}
}
function decode(row: Revision): {snapshot:Snapshot;plan:PublicResourcePlan}|null {
  try {
    checkEntityId(row.id,'id');checkEntityId(row.vendor_id,'vendorId')
    if(!/^[1-9]\d{0,18}$/.test(row.version)||!/^[1-9]\d{0,18}$/.test(row.source_order_version))return null
    const s=exact(row.private_snapshot,['schemaVersion','lines'],'privateSnapshot')
    if(s.schemaVersion!==1||!Array.isArray(s.lines)||s.lines.length>100)return null
    const lines:PrivateLine[]=s.lines.map(value=>{
      const p=exact(value,privateKeys,'privateLine')
      const line=normalize(Object.fromEntries(inputKeys.map(k=>[k,p[k]])))
      if(!['person','equipment','capacity'].includes(p.kind as string))throw invalid('Неизвестный вид ресурса')
      if(p.assignmentId!==null)checkEntityId(p.assignmentId,'assignmentId')
      if(p.programEventId!==null)checkEntityId(p.programEventId,'programEventId')
      if((p.assignmentId===null)!==(p.programEventId===null)||(p.assignmentId===null)!==(p.assignmentVersion===null))throw invalid('Недопустимое назначение')
      if(typeof p.partVersion!=='string'||!/^[1-9]\d{0,18}$/.test(p.partVersion)||
        (p.assignmentVersion!==null&&(typeof p.assignmentVersion!=='string'||!/^[1-9]\d{0,18}$/.test(p.assignmentVersion))))throw invalid('Недопустимая версия источника')
      checkEntityId(p.conflictIdentity,'conflictIdentity');boundedText(p.label,'label')
      if(p.kind==='capacity'){boundedText(p.unit,'unit',80);if(line.capacityWindowId===null||p.window===null)throw invalid('Нужно окно мощности')}
      else if(line.quantity!==1||line.capacityWindowId!==null||p.window!==null||p.unit!==null)throw invalid('Личный ресурс и оборудование имеют количество один')
      let window:PrivateLine['window']=null
      if(p.window!==null){const w=exact(p.window,['startsAt','endsAt'],'window');validatePartDetails('supply',{windowStartsAt:w.startsAt,windowEndsAt:w.endsAt})
        if(typeof w.startsAt!=='string'||typeof w.endsAt!=='string')throw invalid('Недопустимое окно')
        window={startsAt:new Date(w.startsAt).toISOString(),endsAt:new Date(w.endsAt).toISOString()}}
      const span=occupied(line)
      if(p.occupiedStartsAt!==span.occupiedStartsAt||p.occupiedEndsAt!==span.occupiedEndsAt||
        (window&&(Date.parse(window.startsAt)>Date.parse(span.occupiedStartsAt)||Date.parse(window.endsAt)<Date.parse(span.occupiedEndsAt))))throw invalid('Недопустимый занятый интервал')
      return {...line,assignmentId:p.assignmentId as string|null,programEventId:p.programEventId as string|null,label:p.label,kind:p.kind as ResourceKind,
        unit:p.unit as string|null,...span,window,conflictIdentity:p.conflictIdentity,partVersion:p.partVersion,assignmentVersion:p.assignmentVersion as string|null}
    })
    const snapshot:Snapshot={schemaVersion:1,lines},payload=canonical(snapshot)
    if(payload!==row.private_payload||digest(payload)!==row.private_digest||!sameJson(snapshot,row.private_snapshot))return null
    inputs(lines.map(editor)) // Includes duplicate semantic-line detection.
    const plan:PublicResourcePlan={planRevisionId:row.id,revision:row.version,lines:lines.map(publicLine)}
    return sameJson(plan,row.public_snapshot)?{snapshot,plan}:null
  } catch {return null}
}
async function head(client:Queryable,input:Pick<OrderInput,'weddingId'|'dealId'>,lock=false):Promise<Head> {
  const h=(await client.query<Head>(`select version::text,resource_plan_revision::text,resource_plan_id from deal_orders
    where wedding_id=$1 and deal_id=$2${lock?' for share':''}`,[input.weddingId,input.dealId])).rows[0]
  if(!h)throw notFound('Заказ не найден');return h
}
const revisionColumns='id,wedding_id,deal_id,vendor_id,version::text,source_order_version::text,private_payload,private_snapshot,private_digest,public_snapshot'
async function current(client:Queryable,input:Pick<OrderInput,'weddingId'|'dealId'>,h:Head) {
  if(h.resource_plan_id===null)return null
  return (await client.query<Revision>(`select ${revisionColumns} from deal_resource_plan_versions where wedding_id=$1 and deal_id=$2 and id=$3`,
    [input.weddingId,input.dealId,h.resource_plan_id])).rows[0]??null
}

/** All locks use the caller's transaction; the wedding/order head is already pinned. */
async function material(client:Queryable,input:Pick<OrderInput,'weddingId'|'dealId'>,vendorId:string,lines:ResourcePlanLineInput[],historical=false,expectedOwner?:string):Promise<Snapshot> {
  const root=(await client.query<{slot_id:string;category_id:string;vendor_id:string|null}>(`select d.slot_id,s.category_id,d.vendor_id from deals d join slots s on s.id=d.slot_id and s.wedding_id=d.wedding_id
    where d.wedding_id=$1 and d.id=$2`,[input.weddingId,input.dealId])).rows[0]
  if(!root||root.vendor_id!==vendorId)fail('invalid','Исполнитель или финансовый корень изменился')
  const partIds=[...new Set(lines.map(l=>l.partId))].sort()
  const parts=(await client.query<{id:string;kind:string;version:string;assignment_id:string|null;cancelled_at:Date|null}>(
    'select id,kind,version::text,assignment_id,cancelled_at from order_parts where wedding_id=$1 and deal_id=$2 and id=any($3::uuid[]) order by id for share',
    [input.weddingId,input.dealId,partIds])).rows
  if(parts.length!==partIds.length||parts.some(p=>p.cancelled_at!==null))fail('invalid','Нужны действующие части этого заказа')
  const assignmentIds=[...new Set(parts.flatMap(p=>p.assignment_id?[p.assignment_id]:[]))].sort()
  const assignments=(await client.query<{id:string;slot_id:string;program_event_id:string;version:string;cancelled_at:Date|null}>(
    'select id,slot_id,program_event_id,version::text,cancelled_at from order_assignments where wedding_id=$1 and deal_id=$2 and id=any($3::uuid[]) order by id for share',
    [input.weddingId,input.dealId,assignmentIds])).rows
  const slots=(await client.query<{id:string;category_id:string;program_event_id:string|null;deal_id:string|null}>(
    'select id,category_id,program_event_id,deal_id from slots where wedding_id=$1 and id=any($2::uuid[]) order by id for share',[input.weddingId,assignments.map(a=>a.slot_id)])).rows
  const events=(await client.query<{id:string}>('select id from wedding_events where wedding_id=$1 and id=any($2::uuid[]) order by id for share',
    [input.weddingId,assignments.map(a=>a.program_event_id)])).rows
  if(assignments.length!==assignmentIds.length||assignments.some(a=>{
    const s=slots.find(s=>s.id===a.slot_id)
    return a.cancelled_at!==null||!s||!events.some(e=>e.id===a.program_event_id)||s.category_id!==root.category_id||
      (s.deal_id!==null&&s.deal_id!==input.dealId.toLowerCase())||(s.program_event_id!==null&&s.program_event_id!==a.program_event_id)||
      (s.id!==root.slot_id&&(s.deal_id!==null||s.program_event_id===null))
  })||parts.some(p=>p.kind!=='deliverable'&&p.assignment_id===null))fail('invalid','Назначение или мероприятие больше не соответствует заказу')
  const zoneNames=[...new Set(lines.map(l=>l.timeZone))]
  const zones=(await client.query<{name:string}>('select name from pg_timezone_names where name=any($1::text[])',[zoneNames])).rows
  if(zoneNames.some(name=>!zones.some(z=>z.name===name)))fail('invalid','Часовой пояс не поддерживается базой')
  const resourceIds=[...new Set(lines.map(l=>l.resourceId))].sort()
  const located=(await client.query<ResourceRow>('select id,vendor_id,kind,label,capacity_unit,conflict_identity,person_user_id,staff_member_id,retired_at from vendor_resources where id=any($1::uuid[])',[resourceIds])).rows
  for(const id of resourceIds){const r=located.find(r=>r.id===id)
    if(!r)fail(historical?'unavailable':'invalid','Ресурс недоступен')
    if(r.vendor_id===null)fail('unavailable','Источник ресурса удалён')
    if(r.vendor_id!==vendorId)fail('invalid','Ресурс принадлежит другой компании')}
  const company=(await client.query<{user_id:string}>('select user_id from vendors where id=$1',[vendorId])).rows[0]
  if(!company)fail('unavailable','Компания недоступна')
  const accountIds=[...new Set([company.user_id,...located.flatMap(r=>r.person_user_id?[r.person_user_id]:[])])].sort()
  const accounts=(await client.query<{id:string;deleted_at:Date|null}>('select id,deleted_at from users where id=any($1::uuid[]) order by id for share',[accountIds])).rows
  const vendor=(await client.query<{user_id:string;blocked_at:Date|null}>('select user_id,blocked_at from vendors where id=$1 for share',[vendorId])).rows[0]
  if(!vendor)fail('unavailable','Компания недоступна')
  if(expectedOwner!==undefined&&vendor.user_id!==expectedOwner)throw forbidden('План ресурсов изменяет действующий владелец компании')
  if(vendor.user_id!==company.user_id)fail('invalid','Владелец компании изменился')
  const live=(id:string|null)=>id!==null&&accounts.some(a=>a.id===id&&a.deleted_at===null)
  if(vendor.blocked_at!==null||!live(vendor.user_id))fail('unavailable','Компания недоступна')
  const memberIds=[...new Set(located.flatMap(r=>r.staff_member_id?[r.staff_member_id]:[]))].sort()
  const members=(await client.query<{id:string;vendor_id:string;user_id:string|null;state:string;accepted_at:Date|null;revoked_at:Date|null}>(
    'select id,vendor_id,user_id,state,accepted_at,revoked_at from vendor_staff_members where id=any($1::uuid[]) order by id for share',[memberIds])).rows
  const resources=(await client.query<ResourceRow>('select id,vendor_id,kind,label,capacity_unit,conflict_identity,person_user_id,staff_member_id,retired_at from vendor_resources where id=any($1::uuid[]) order by id for share',[resourceIds])).rows
  const windowIds=[...new Set(lines.flatMap(l=>l.capacityWindowId?[l.capacityWindowId]:[]))].sort()
  const windows=(await client.query<{id:string;resource_id:string;starts_at:Date;ends_at:Date}>(
    'select id,resource_id,starts_at,ends_at from resource_capacity_windows where id=any($1::uuid[]) order by id for share',[windowIds])).rows
  return {schemaVersion:1,lines:lines.map(line=>{
    const r=resources.find(r=>r.id===line.resourceId),prior=located.find(r=>r.id===line.resourceId)!,p=parts.find(p=>p.id===line.partId)!
    if(!r||r.vendor_id===null||r.retired_at!==null)fail('unavailable','Ресурс недоступен')
    if(r.vendor_id!==vendorId||r.kind!==prior.kind||r.conflict_identity!==prior.conflict_identity)fail('invalid','Источник ресурса изменился')
    if(r.person_user_id!==prior.person_user_id||r.staff_member_id!==prior.staff_member_id){
      if(r.person_user_id===null||r.staff_member_id===null)fail('unavailable','Участие человека недоступно')
      fail('invalid','Личность ресурса изменилась')}
    boundedText(r.label,'label')
    if(r.kind==='person'){
      const m=members.find(m=>m.id===r.staff_member_id)
      if(!live(r.person_user_id)||r.conflict_identity!==r.person_user_id||
        (r.staff_member_id===null?r.person_user_id!==vendor.user_id:!m||m.vendor_id!==vendorId||m.user_id!==r.person_user_id||m.state!=='active'||m.accepted_at===null||m.revoked_at!==null))fail('unavailable','Нужно действующее участие человека в компании')
    }
    let window:PrivateLine['window']=null
    if(r.kind==='capacity'){
      boundedText(r.capacity_unit,'capacityUnit',80)
      const w=windows.find(w=>w.id===line.capacityWindowId)
      if(!w||w.resource_id!==r.id)fail('invalid','Нужно окно мощности выбранного ресурса')
      window={startsAt:w.starts_at.toISOString(),endsAt:w.ends_at.toISOString()}
      const span=occupied(line)
      if(Date.parse(window.startsAt)>Date.parse(span.occupiedStartsAt)||Date.parse(window.endsAt)<Date.parse(span.occupiedEndsAt))fail('invalid','Окно должно покрывать работу и все буферы')
    }else if(line.quantity!==1||line.capacityWindowId!==null)fail('invalid','Личный ресурс и оборудование имеют количество один без окна мощности')
    const a=p.assignment_id===null?null:assignments.find(a=>a.id===p.assignment_id)!
    return {...line,assignmentId:a?.id??null,programEventId:a?.program_event_id??null,label:r.label,kind:r.kind,unit:r.capacity_unit,
      ...occupied(line),window,conflictIdentity:r.conflict_identity,partVersion:p.version,assignmentVersion:a?.version??null}
  })}
}

export async function readResourcePlanSource(client:Queryable,input:Pick<OrderInput,'weddingId'|'dealId'> & {vendorId:string|null}):Promise<{plan:PublicResourcePlan|null;source:Source}> {
  const h=await head(client,input),row=await current(client,input,h)
  if(!row)return {plan:null,source:h.resource_plan_id===null&&h.resource_plan_revision==='0'?'current':'invalid'}
  const decoded=decode(row)
  if(!decoded||row.version!==h.resource_plan_revision||BigInt(row.source_order_version)>BigInt(h.version))return{plan:null,source:'invalid'}
  if(input.vendorId===null)return{plan:decoded.plan,source:'unavailable'}
  if(row.vendor_id!==input.vendorId.toLowerCase())return{plan:decoded.plan,source:'invalid'}
  try {
    const actual=await material(client,input,input.vendorId.toLowerCase(),decoded.snapshot.lines.map(editor),true)
    return {plan:decoded.plan,source:sameJson(actual,decoded.snapshot)?'current':'invalid'}
  }catch(error){
    if(error instanceof MaterialError)return{plan:decoded.plan,source:error.source}
    if(typeof error==='object'&&error!==null&&'statusCode' in error&&error.statusCode===422)return{plan:decoded.plan,source:'invalid'}
    throw error
  }
}
async function view(client:Queryable,input:OrderInput,allowEdit:boolean):Promise<ResourcePlanView> {
  const h=await head(client,input),scope=await inputWithVendor(client,input),state=await readResourcePlanSource(client,scope),rows=await client.query<Revision>(
    `select ${revisionColumns} from deal_resource_plan_versions where wedding_id=$1 and deal_id=$2 order by version desc`,[input.weddingId,input.dealId])
  // An owner can also be a couple member. Party selection is not company ownership.
  // Actor account is already pinned by the order context. No further material
  // or person locks are acquired after this final company projection.
  const owner=scope.vendorId===null?null:(await client.query<{user_id:string;blocked_at:Date|null}>(
    'select user_id,blocked_at from vendors where id=$1 for share',[scope.vendorId])).rows[0]
  const canEdit=allowEdit&&owner?.user_id===input.actor.userId.toLowerCase()&&owner.blocked_at===null
  const selected=rows.rows.find(r=>r.id===h.resource_plan_id),decoded=selected?decode(selected):null
  // Reservation describes this exact draft revision. A newer draft does not
  // release an older promise; that promise has its own commitment projection.
  const commitment=(await client.query<{state:'reserved'|'released';plan_revision_id:string}>(`select c.state,v.plan_revision_id
    from deal_resource_commitments c join deal_resource_commitment_versions v on v.id=c.current_version_id
      and v.wedding_id=c.wedding_id and v.deal_id=c.deal_id
    where c.wedding_id=$1 and c.deal_id=$2 and c.state in ('reserved','released')`,[input.weddingId,input.dealId])).rows[0]
  const reservation=commitment?.plan_revision_id===h.resource_plan_id?commitment.state:'not_reserved'
  return {orderVersion:h.version,revision:h.resource_plan_revision,canEdit,reservation,current:state.plan,source:state.source,
    editorLines:canEdit?(selected?.vendor_id===scope.vendorId?decoded?.snapshot.lines.map(editor)??[]:[]):null,
    history:rows.rows.flatMap(row=>{const d=decode(row);return d?[d.plan]:[]})}
}
// Kept separate from public input: company scope comes from the actual financial root.
async function inputWithVendor(client:Queryable,input:OrderInput):Promise<Pick<OrderInput,'weddingId'|'dealId'> & {vendorId:string|null}> {
  const r=(await client.query<{vendor_id:string|null}>('select vendor_id from deals where wedding_id=$1 and id=$2',[input.weddingId,input.dealId])).rows[0]
  if(!r)throw notFound('Заказ не найден');return{weddingId:input.weddingId,dealId:input.dealId,vendorId:r.vendor_id}
}
export async function loadOrderResourcePlan(client:Queryable,input:OrderInput):Promise<ResourcePlanView> {
  checkEntityId(input.weddingId,'weddingId');checkEntityId(input.dealId,'dealId')
  const context=await lockOrderContext(client,input.weddingId,input.dealId,input.actor,false)
  await head(client,input,true)
  return view(client,input,context.state!=='cancelled')
}
export async function saveOrderResourcePlan(client:Queryable,input:OrderWriteInput & {expectedPlanRevision:string;lines:ResourcePlanLineInput[]}):Promise<ResourcePlanView> {
  exact(input,['weddingId','dealId','actor','expectedVersion','expectedPlanRevision','lines'],'resourcePlan')
  const lines=inputs(input.lines),context=await lockDraftOrder(client,input)
  if(context.vendorId===null)throw forbidden('План ресурсов изменяет действующий владелец компании')
  const owner=(await client.query<{user_id:string}>('select user_id from vendors where id=$1',[context.vendorId])).rows[0]
  if(owner?.user_id!==input.actor.userId.toLowerCase())throw forbidden('План ресурсов изменяет действующий владелец компании')
  const h=await head(client,input)
  checkVersion(h.resource_plan_revision,input.expectedPlanRevision,'expectedPlanRevision',true)
  let snapshot:Snapshot
  try{snapshot=await material(client,input,context.vendorId,lines,false,input.actor.userId.toLowerCase())}catch(error){
    if(error instanceof MaterialError){if(error.source==='unavailable')throw conflict('resource_plan_unavailable',error.message);throw invalid(error.message)}
    throw error
  }
  const row=await current(client,input,h),before=row?decode(row):null
  if((h.resource_plan_revision==='0'&&snapshot.lines.length===0)||(before&&sameJson(before.snapshot,snapshot)))return view(client,input,true)
  const id=uuidv7(),revision=(BigInt(h.resource_plan_revision)+1n).toString(),payload=canonical(snapshot)
  const plan:PublicResourcePlan={planRevisionId:id,revision,lines:snapshot.lines.map(publicLine)}
  await client.query(`insert into deal_resource_plan_versions(id,wedding_id,deal_id,vendor_id,version,source_order_version,private_payload,private_snapshot,private_digest,public_snapshot,created_by)
    values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11)`,[id,input.weddingId,input.dealId,context.vendorId,revision,
    (BigInt(h.version)+1n).toString(),payload,JSON.stringify(snapshot),digest(payload),JSON.stringify(plan),input.actor.userId])
  await recordOrderChange(client,input,'order.resource_plan_changed',id,{id,revision})
  return view(client,input,true)
}

/** Server-only allocation input. It is never included in a public order view.
 * The caller pins the order head, then locks the union of old/new live sources
 * before verifying current terms. This inspection validates historical bytes;
 * it deliberately does not claim that a resource is currently available. */
export type BookingResourcePlanLine = PrivateLine
export async function inspectOrderResourcePlanForBooking(client:Queryable,
  input:Pick<OrderInput,'weddingId'|'dealId'> & {vendorId:string}):Promise<{
    planRevisionId:string;revision:string;sourceOrderVersion:string;lines:BookingResourcePlanLine[]
  }> {
  checkEntityId(input.weddingId,'weddingId');checkEntityId(input.dealId,'dealId');checkEntityId(input.vendorId,'vendorId')
  const h=await head(client,input),row=await current(client,input,h),decoded=row?decode(row):null
  if(!row||!decoded||row.vendor_id!==input.vendorId.toLowerCase()||row.version!==h.resource_plan_revision||
    BigInt(row.source_order_version)>BigInt(h.version))throw conflict('resource_plan_invalid','Нужен действительный сохранённый план ресурсов этого заказа')
  return {planRevisionId:row.id,revision:row.version,sourceOrderVersion:row.source_order_version,lines:decoded.snapshot.lines}
}
