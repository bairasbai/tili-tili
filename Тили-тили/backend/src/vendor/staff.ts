import { createHash, randomBytes } from 'node:crypto'
import type { Queryable } from '../plugins/db.js'
import { conflict, forbidden, gone, notFound, validationFailed } from '../errors.js'
import { uuidv7 } from '../ids.js'
import { lockOrderPrincipal, lockOrderWedding, type OrderActor } from '../orders/context.js'
import { boundedText, checkEntityId } from '../orders/model.js'

export type StaffRole = 'worker' | 'resource_manager'
export type StaffDutyRole = 'performer' | 'setup' | 'delivery' | 'driver' | 'kitchen' | 'rental' | 'backup'
export interface StaffScope { vendorId: string; actor: OrderActor }
export interface StaffMemberDto { id: string; vendorId: string; userId: string | null; role: StaffRole;
  state: 'invited' | 'active' | 'declined' | 'revoked'; version: string; expiresAt: string;
  acceptedAt: string | null; revokedAt: string | null }
export interface StaffInvitation extends StaffMemberDto { token: string }
export interface StaffDutyDto { id: string; vendorId: string; memberId: string; weddingId: string; dealId: string;
  programEventId: string; assignmentId: string | null; role: StaffDutyRole; label: string; version: string; revokedAt: string | null }
export interface StaffOperationalDuty extends StaffDutyDto { memberRole: StaffRole;
  event: { name: string; date: string | null; timeZone: string | null; location: string | null } }
export interface StaffDutyScope extends StaffScope { weddingId: string; dealId: string }
interface MemberRow { id: string; vendor_id: string; user_id: string | null; role: StaffRole; state: StaffMemberDto['state'];
  version: string; invite_expires_at: Date; accepted_at: Date | null; revoked_at: Date | null; expired: boolean;
  invite_target_user_id: string | null; invite_binding_known: boolean }
interface DutyRow { id: string; vendor_id: string; member_id: string; wedding_id: string; deal_id: string;
  program_event_id: string; assignment_id: string | null; role: StaffDutyRole; label: string; version: string; revoked_at: Date | null }
const memberColumns = 'id,vendor_id,user_id,role,state,version::text,invite_expires_at,accepted_at,revoked_at,invite_expires_at<=clock_timestamp() as expired,invite_target_user_id,invite_binding_known'
const dutyColumns = 'id,vendor_id,member_id,wedding_id,deal_id,program_event_id,assignment_id,role,label,version::text,revoked_at'
const duties: readonly string[] = ['performer', 'setup', 'delivery', 'driver', 'kitchen', 'rental', 'backup']
function staffRole(value: unknown): asserts value is StaffRole {
  if (value !== 'worker' && value !== 'resource_manager') throw validationFailed({ role: 'Неизвестная роль сотрудника' })
}
function version(actual: string, expected: string): void {
  if (typeof expected !== 'string' || !/^[1-9]\d{0,18}$/.test(expected)) throw validationFailed({ expectedVersion: 'Нужна точная версия' })
  if (actual !== expected) throw conflict('staff_version_conflict', 'Данные изменились — обновите состав команды')
}
function memberDto(r: MemberRow): StaffMemberDto {
  return { id: r.id, vendorId: r.vendor_id, userId: r.user_id, role: r.role, state: r.state, version: r.version,
    expiresAt: r.invite_expires_at.toISOString(), acceptedAt: r.accepted_at?.toISOString() ?? null, revokedAt: r.revoked_at?.toISOString() ?? null }
}
function dutyDto(r: DutyRow): StaffDutyDto {
  return { id: r.id, vendorId: r.vendor_id, memberId: r.member_id, weddingId: r.wedding_id, dealId: r.deal_id,
    programEventId: r.program_event_id, assignmentId: r.assignment_id, role: r.role, label: r.label, version: r.version,
    revokedAt: r.revoked_at?.toISOString() ?? null }
}
async function audit(client: Queryable, input: StaffScope, action: string, id: string, diff: object): Promise<void> {
  await client.query("insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,$2,'vendor_staff',$3,$4::jsonb)",
    [input.actor.userId, action, id, JSON.stringify(diff)])
}

/** All public operations require a transaction. Gather accounts before company locks;
 * recheck the actual company and principal after a company wait. A changed owner
 * fails closed rather than acquiring a new account lock in the reverse order. */
async function company(client: Queryable, input: StaffScope, ownerOnly: boolean, extraUsers: readonly string[] = [], write = true) {
  checkEntityId(input.vendorId, 'vendorId'); checkEntityId(input.actor.userId, 'userId'); checkEntityId(input.actor.sessionId, 'sessionId')
  boundedText(input.actor.policyVersion, 'policyVersion', 100)
  const located = (await client.query<{ user_id: string }>('select user_id from vendors where id=$1', [input.vendorId])).rows[0]
  if (!located) throw notFound('Компания недоступна')
  const ids = [...new Set([located.user_id, input.actor.userId.toLowerCase(), ...extraUsers.map(id => id.toLowerCase())])].sort()
  const accounts = (await client.query<{ id: string; deleted_at: Date | null }>(
    'select id,deleted_at from users where id=any($1::uuid[]) order by id for share', [ids])).rows
  const current = (await client.query<{ user_id: string; blocked_at: Date | null }>(
    `select user_id,blocked_at from vendors where id=$1 for ${write ? 'update' : 'share'}`, [input.vendorId])).rows[0]
  if (!current) throw notFound('Компания недоступна')
  if (current.user_id !== located.user_id) throw conflict('staff_source_changed', 'Владелец компании изменился — обновите данные')
  await lockOrderPrincipal(client, input.actor)
  const live = (id: string | null) => id !== null && accounts.some(a => a.id === id && a.deleted_at === null)
  if (current.blocked_at || !live(current.user_id)) throw notFound('Компания недоступна')
  if (ownerOnly && current.user_id !== input.actor.userId.toLowerCase()) throw forbidden('Командой управляет действующий владелец компании')
  return { ownerId: current.user_id, live }
}
async function member(client: Queryable, vendorId: string, memberId: string, write = false): Promise<MemberRow> {
  checkEntityId(memberId, 'memberId')
  const r = (await client.query<MemberRow>(`select ${memberColumns} from vendor_staff_members where vendor_id=$1 and id=$2 for ${write ? 'update' : 'share'}`, [vendorId, memberId])).rows[0]
  if (!r) throw notFound('Сотрудник не найден')
  return r
}
async function locatedMemberUser(client: Queryable, vendorId: string, memberId: string): Promise<string[]> {
  checkEntityId(memberId, 'memberId'); checkEntityId(vendorId, 'vendorId')
  const r = (await client.query<{ user_id: string | null }>('select user_id from vendor_staff_members where vendor_id=$1 and id=$2', [vendorId, memberId])).rows[0]
  return r?.user_id ? [r.user_id] : []
}
function accepted(r: MemberRow, live: (id: string | null) => boolean): void {
  if (r.state !== 'active' || !r.accepted_at || r.revoked_at || !live(r.user_id)) throw forbidden('Нужен действующий сотрудник, принявший приглашение')
}

/** Seven days is the invitation-link policy; it does not expire accepted employment. */
export async function inviteStaff(client: Queryable, input: StaffScope & { role: StaffRole; targetUserId?: string }): Promise<StaffInvitation> {
  staffRole(input.role)
  if (input.targetUserId !== undefined) checkEntityId(input.targetUserId, 'targetUserId')
  const c = await company(client, input, true, input.targetUserId ? [input.targetUserId] : [])
  if (input.targetUserId) {
    if (input.targetUserId.toLowerCase() === c.ownerId) throw validationFailed({ targetUserId: 'Владелец уже управляет своей компанией' })
    if (!c.live(input.targetUserId.toLowerCase())) throw validationFailed({ targetUserId: 'Нужен действующий аккаунт человека' })
    const exists = await client.query("select id from vendor_staff_members where vendor_id=$1 and user_id=$2 and state in ('invited','active')", [input.vendorId, input.targetUserId])
    if (exists.rowCount) throw conflict('staff_member_exists', 'У человека уже есть действующее приглашение или членство')
  }
  const token = randomBytes(32).toString('base64url'), id = uuidv7()
  const r = (await client.query<MemberRow>(`insert into vendor_staff_members(id,vendor_id,user_id,role,invite_token_hash,invite_expires_at,invited_by,invite_target_user_id,invite_binding_known)
    values($1,$2,$3,$4,$5,clock_timestamp()+interval '7 days',$6,$3,true) returning ${memberColumns}`,
  [id, input.vendorId, input.targetUserId ?? null, input.role, createHash('sha256').update(token).digest('hex'), input.actor.userId])).rows[0]!
  await audit(client, input, 'vendor.staff.invited', id, { role: input.role, targetUserId: r.user_id, version: r.version })
  return { ...memberDto(r), token }
}
async function invitation(client: Queryable, input: { token: string; actor: OrderActor }) {
  if (typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.token)) throw gone()
  const hash = createHash('sha256').update(input.token).digest('hex')
  const located = (await client.query<{ vendor_id: string }>('select vendor_id from vendor_staff_members where invite_token_hash=$1', [hash])).rows[0]
  if (!located) throw gone()
  const scope = { vendorId: located.vendor_id, actor: input.actor }, c = await company(client, scope, false)
  const r = (await client.query<MemberRow>(`select ${memberColumns} from vendor_staff_members where vendor_id=$1 and invite_token_hash=$2 for update`, [located.vendor_id, hash])).rows[0]
  if (!r || (r.user_id && r.user_id !== input.actor.userId.toLowerCase())) throw gone()
  // SET NULL on account deletion is historical cleanup, not permission to
  // reuse another person's accepted/declined invitation.
  if (r.state !== 'invited' && r.user_id === null) throw gone()
  // Immutable targeting survives erasure; unknown inherited invitations are
  // not silently reinterpreted as open links. Audit is evidence, not an ACL.
  if (r.state === 'invited' && (!r.invite_binding_known ||
    (r.invite_target_user_id !== null && r.invite_target_user_id !== input.actor.userId.toLowerCase()))) throw gone()
  if (input.actor.userId.toLowerCase() === c.ownerId) throw forbidden('Владелец не принимает приглашение в собственную команду')
  return { r, scope }
}
export async function acceptStaffInvite(client: Queryable, input: { token: string; actor: OrderActor }): Promise<StaffMemberDto> {
  const { r, scope } = await invitation(client, input)
  if (r.state === 'active') return memberDto(r) // Already stored real acceptance, not a new receipt.
  if (r.state !== 'invited' || r.expired) throw gone()
  const exists = await client.query("select id from vendor_staff_members where vendor_id=$1 and user_id=$2 and id<>$3 and state in ('invited','active')", [scope.vendorId, input.actor.userId, r.id])
  if (exists.rowCount) throw conflict('staff_member_exists', 'У человека уже есть действующее приглашение или членство')
  const next = (await client.query<MemberRow>(`update vendor_staff_members set user_id=$2,state='active',accepted_at=clock_timestamp(),accepted_session_id=$3,version=version+1 where id=$1 returning ${memberColumns}`, [r.id, input.actor.userId, input.actor.sessionId])).rows[0]!
  await audit(client, scope, 'vendor.staff.accepted', r.id, { previousVersion: r.version, version: next.version, sessionId: input.actor.sessionId, role: next.role })
  return memberDto(next)
}
export async function declineStaffInvite(client: Queryable, input: { token: string; actor: OrderActor }): Promise<StaffMemberDto> {
  const { r, scope } = await invitation(client, input)
  if (r.state === 'declined') return memberDto(r)
  if (r.state !== 'invited' || r.expired) throw gone()
  const next = (await client.query<MemberRow>(`update vendor_staff_members set user_id=$2,state='declined',version=version+1 where id=$1 returning ${memberColumns}`, [r.id, input.actor.userId])).rows[0]!
  await audit(client, scope, 'vendor.staff.declined', r.id, { previousVersion: r.version, version: next.version, sessionId: input.actor.sessionId })
  return memberDto(next)
}
export async function revokeStaff(client: Queryable, input: StaffScope & { memberId: string; expectedVersion: string }): Promise<StaffMemberDto> {
  await company(client, input, true)
  const r = await member(client, input.vendorId, input.memberId, true); version(r.version, input.expectedVersion)
  if (r.state === 'revoked') return memberDto(r)
  const next = (await client.query<MemberRow>(`update vendor_staff_members set state='revoked',revoked_at=clock_timestamp(),version=version+1 where id=$1 returning ${memberColumns}`, [r.id])).rows[0]!
  await audit(client, input, 'vendor.staff.revoked', r.id, { previousVersion: r.version, version: next.version, previousState: r.state })
  return memberDto(next)
}
export async function updateStaffRole(client: Queryable, input: StaffScope & { memberId: string; expectedVersion: string; role: StaffRole }): Promise<StaffMemberDto> {
  staffRole(input.role)
  const c = await company(client, input, true, await locatedMemberUser(client, input.vendorId, input.memberId))
  const r = await member(client, input.vendorId, input.memberId, true); accepted(r, c.live); version(r.version, input.expectedVersion)
  if (r.role === input.role) return memberDto(r)
  const next = (await client.query<MemberRow>(`update vendor_staff_members set role=$2,version=version+1 where id=$1 returning ${memberColumns}`, [r.id, input.role])).rows[0]!
  await audit(client, input, 'vendor.staff.role_changed', r.id, { previousVersion: r.version, version: next.version, previousRole: r.role, role: next.role })
  return memberDto(next)
}
export async function lockStaffMember(client: Queryable, input: StaffScope & { requiredRole?: StaffRole }): Promise<StaffMemberDto> {
  if (input.requiredRole !== undefined) staffRole(input.requiredRole)
  const c = await company(client, input, false, [], false)
  const r = (await client.query<MemberRow>(`select ${memberColumns} from vendor_staff_members where vendor_id=$1 and user_id=$2 and state='active' for share`, [input.vendorId, input.actor.userId])).rows[0]
  if (!r) throw forbidden('Нужен действующий сотрудник')
  accepted(r, c.live)
  if (input.requiredRole && input.requiredRole !== r.role) throw forbidden('Для этой операции нужна другая роль сотрудника')
  return memberDto(r)
}
export async function listStaff(client: Queryable, input: StaffScope): Promise<StaffMemberDto[]> {
  const c = await company(client, input, false, [], false)
  if (c.ownerId !== input.actor.userId.toLowerCase()) {
    const r = (await client.query<MemberRow>(`select ${memberColumns} from vendor_staff_members where vendor_id=$1 and user_id=$2 and state='active' for share`, [input.vendorId, input.actor.userId])).rows[0]
    if (!r) throw forbidden('Состав команды доступен владельцу; сотруднику — только своё членство')
    accepted(r, c.live); return [memberDto(r)]
  }
  return (await client.query<MemberRow>(`select ${memberColumns} from vendor_staff_members where vendor_id=$1 order by created_at,id for share`, [input.vendorId])).rows.map(memberDto)
}
async function dutyCompany(client: Queryable, input: StaffDutyScope, ownerOnly: boolean, memberId?: string, write = true) {
  checkEntityId(input.weddingId, 'weddingId'); checkEntityId(input.dealId, 'dealId')
  await lockOrderWedding(client, input.weddingId, write)
  const c = await company(client, input, ownerOnly, memberId ? await locatedMemberUser(client, input.vendorId, memberId) : [], write)
  const deal = await client.query(`select id from deals where id=$1 and wedding_id=$2 and vendor_id=$3 and state<>'cancelled' for ${write ? 'update' : 'share'}`, [input.dealId, input.weddingId, input.vendorId])
  if (!deal.rowCount) throw notFound('Действующий заказ компании не найден')
  return c
}
async function eventAndAssignment(client: Queryable, input: StaffDutyScope & { programEventId: string; assignmentId?: string | null }) {
  checkEntityId(input.programEventId, 'programEventId')
  const event = (await client.query<{ name: string; date: string | null; time_zone: string | null; location: string | null }>(
    'select name,date::text,time_zone,location from wedding_events where wedding_id=$1 and id=$2 for share', [input.weddingId, input.programEventId])).rows[0]
  if (!event) throw validationFailed({ programEventId: 'Нужно существующее событие этой свадьбы' })
  if (input.assignmentId !== undefined && input.assignmentId !== null) {
    checkEntityId(input.assignmentId, 'assignmentId')
    const assignment = await client.query('select id from order_assignments where wedding_id=$1 and deal_id=$2 and id=$3 and program_event_id=$4 and cancelled_at is null for share', [input.weddingId, input.dealId, input.assignmentId, input.programEventId])
    if (!assignment.rowCount) throw validationFailed({ assignmentId: 'Нужно действующее назначение этого заказа на то же событие' })
  }
  return { name: event.name, date: event.date, timeZone: event.time_zone, location: event.location }
}
export async function createStaffDuty(client: Queryable, input: StaffDutyScope & { memberId: string; programEventId: string; assignmentId?: string | null; role: StaffDutyRole; label: string }): Promise<StaffDutyDto> {
  if (!duties.includes(input.role)) throw validationFailed({ role: 'Неизвестная рабочая роль' })
  boundedText(input.label, 'label')
  const c = await dutyCompany(client, input, true, input.memberId)
  const m = await member(client, input.vendorId, input.memberId); accepted(m, c.live)
  await eventAndAssignment(client, input)
  const duplicate = await client.query('select id from vendor_staff_duties where member_id=$1 and deal_id=$2 and program_event_id=$3 and role=$4 and revoked_at is null', [m.id, input.dealId, input.programEventId, input.role])
  if (duplicate.rowCount) throw conflict('staff_duty_exists', 'На это событие уже есть действующая задача с такой ролью')
  const r = (await client.query<DutyRow>(`insert into vendor_staff_duties(id,vendor_id,member_id,wedding_id,deal_id,program_event_id,assignment_id,role,label,created_by)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning ${dutyColumns}`, [uuidv7(), input.vendorId, m.id, input.weddingId, input.dealId, input.programEventId, input.assignmentId ?? null, input.role, input.label, input.actor.userId])).rows[0]!
  await audit(client, input, 'vendor.staff.duty_created', r.id, { memberId: m.id, role: r.role, programEventId: r.program_event_id, version: r.version, operationalOnly: true })
  return dutyDto(r)
}
async function duty(client: Queryable, input: StaffDutyScope & { dutyId: string }, write = false): Promise<DutyRow> {
  checkEntityId(input.dutyId, 'dutyId')
  const r = (await client.query<DutyRow>(`select ${dutyColumns} from vendor_staff_duties where id=$1 and vendor_id=$2 and wedding_id=$3 and deal_id=$4 for ${write ? 'update' : 'share'}`, [input.dutyId, input.vendorId, input.weddingId, input.dealId])).rows[0]
  if (!r) throw notFound('Рабочая задача не найдена')
  return r
}
export async function revokeStaffDuty(client: Queryable, input: StaffDutyScope & { dutyId: string; expectedVersion: string }): Promise<StaffDutyDto> {
  await dutyCompany(client, input, true)
  const r = await duty(client, input, true); version(r.version, input.expectedVersion)
  if (r.revoked_at) return dutyDto(r)
  const next = (await client.query<DutyRow>(`update vendor_staff_duties set revoked_at=clock_timestamp(),version=version+1 where id=$1 returning ${dutyColumns}`, [r.id])).rows[0]!
  await audit(client, input, 'vendor.staff.duty_revoked', r.id, { previousVersion: r.version, version: next.version })
  return dutyDto(next)
}
/** Returns operational event facts only. Membership grants no money, guest,
 * order-terms acceptance or program acknowledgment authority. */
export async function lockStaffDuty(client: Queryable, input: StaffDutyScope & { programEventId: string; dutyId: string }): Promise<StaffOperationalDuty> {
  const c = await dutyCompany(client, input, false, undefined, false)
  const r = await duty(client, input)
  checkEntityId(input.programEventId, 'programEventId')
  if (r.revoked_at || r.program_event_id !== input.programEventId.toLowerCase()) throw notFound('Рабочая задача недоступна')
  const m = await member(client, input.vendorId, r.member_id)
  accepted(m, c.live)
  if (m.user_id !== input.actor.userId.toLowerCase()) throw notFound('Рабочая задача недоступна')
  const event = await eventAndAssignment(client, { ...input, assignmentId: r.assignment_id })
  return { ...dutyDto(r), memberRole: m.role, event }
}
