import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { AsyncState, ready } from '@/components/AsyncState'
import { TopBar } from '@/components/chrome'
import { getMe } from '@/lib/api/auth'
import { ApiError, isAuthorized } from '@/lib/api/client'
import { getOrder } from '@/lib/api/orders'
import { getVendorProfile } from '@/lib/api/vendor'
import { answerVendorStaffInvitation, createOrderStaffDuty, getOrderStaffDuties, getOwnStaffDuties,
  getVendorStaff, inviteVendorStaff, reassignOrderStaffDuty, revokeOrderStaffDuty, revokeVendorStaff, updateVendorStaffRole,
  type VendorStaffDutyRole, type VendorStaffInvitation, type VendorStaffRole } from '@/lib/api/vendorStaff'
import { explainError, useApi } from '@/lib/api/useApi'
import { appRoot, t } from '@/lib/i18n'
import { useLegacyActionScope, useLegacySessionKey, type LegacyAction } from '@/lib/useLegacyActionScope'
import { copyText } from '@/lib/utils'
import { shortWeddingDate } from '@/lib/weddingDate'

const button = 'press min-h-11 rounded-xl bg-[var(--sage-soft)] px-4 py-2 text-sm font-semibold disabled:opacity-50'
const field = 'min-h-11 w-full rounded-xl border border-[var(--line)] bg-transparent px-3 py-2 text-sm'
const tokenFormat = /^[A-Za-z0-9_-]{43}$/
const userIdFormat = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const staffRoles: Record<VendorStaffRole, string> = { worker: 'Исполнитель', resource_manager: 'Ответственный за ресурсы' }
const dutyRoles: Record<VendorStaffDutyRole, string> = {
  performer: 'Исполнение', setup: 'Монтаж', delivery: 'Доставка', driver: 'Транспорт',
  kitchen: 'Кухня', rental: 'Аренда', backup: 'Подмена',
}
const states = { invited: 'Приглашён', active: 'В команде', declined: 'Отклонил приглашение', revoked: 'Доступ отозван' }

function useStaffAction(capture: () => LegacyAction, reload: () => void) {
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') reload() }
    window.addEventListener('focus', reload)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.removeEventListener('focus', reload)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [reload])
  async function run<T>(action: (origin: LegacyAction) => Promise<T>, done?: (result: T) => void) {
    if (pending.current) return
    const origin = capture()
    pending.current = true
    setBusy(true)
    setError('')
    try {
      const result = await action(origin)
      if (origin.isCurrent()) {
        done?.(result)
        reload()
      }
    } catch (cause) {
      if (origin.isCurrent()) {
        setError(explainError(cause))
        if (cause instanceof ApiError && [403, 404, 409].includes(cause.status)) reload()
      }
    } finally {
      pending.current = false
      if (origin.isCurrent()) setBusy(false)
    }
  }
  return { busy, error, run }
}

export function VendorTeam() {
  const scope = useLegacySessionKey('vendor-team')
  return <TeamPage key={scope} scope={scope} />
}

function TeamPage({ scope }: { scope: string }) {
  const capture = useLegacyActionScope(scope)
  const profile = useApi(() => getVendorProfile(capture()), [capture])
  return <div className="pb-28">
    <TopBar back title={t('Команда подрядчика')} fallback="/vendor-app" />
    <div className="space-y-3 px-5">
      <AsyncState q={profile} />
      {ready(profile) && profile.data?.id && <TeamBoard key={profile.data.id} scope={scope} vendorId={profile.data.id} />}
    </div>
  </div>
}

function TeamBoard({ scope, vendorId }: { scope: string; vendorId: string }) {
  const capture = useLegacyActionScope(scope)
  const q = useApi(() => getVendorStaff(vendorId, capture()), [vendorId, capture])
  const { busy, error, run } = useStaffAction(capture, q.reload)
  const [target, setTarget] = useState('')
  const [role, setRole] = useState<VendorStaffRole>('worker')
  const [invitation, setInvitation] = useState<VendorStaffInvitation | null>(null)
  const [remove, setRemove] = useState<string | null>(null)
  const waiting = busy || q.refreshing
  const link = invitation ? new URL(appRoot() + 'staff-duties#' + invitation.token, window.location.origin).href : ''
  function invite(event: FormEvent) {
    event.preventDefault()
    const targetUserId = target.trim()
    if (!userIdFormat.test(targetUserId)) return
    void run(origin => inviteVendorStaff(vendorId, { targetUserId, role }, origin), result => {
      setInvitation(result)
      setTarget('')
    })
  }
  return <>
    <AsyncState q={q} forbiddenText={t('Командой управляет владелец компании')} />
    {error && <p role="alert" className="card p-3 text-sm">{error}</p>}
    {ready(q) && <>
      <form onSubmit={invite} className="card space-y-3 p-4">
        <label className="block text-sm">{t('Код сотрудника')}
          <input className={field} value={target} onChange={e => setTarget(e.target.value)} required autoComplete="off" spellCheck={false} />
        </label>
        <label className="block text-sm">{t('Роль сотрудника')}
          <select className={field} value={role} onChange={e => setRole(e.target.value as VendorStaffRole)}>
            {Object.entries(staffRoles).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
          </select>
        </label>
        <button className={button} disabled={waiting || !userIdFormat.test(target.trim())}>{t('Создать приглашение')}</button>
      </form>
      {link && <div className="card space-y-2 p-4">
        <input className={field} aria-label={t('Ссылка для сотрудника')} value={link} readOnly onFocus={e => e.target.select()} />
        <button type="button" className={button} onClick={() => copyText(link)}>{t('Скопировать ссылку')}</button>
      </div>}
      {q.data?.map(member => <article key={member.id} className="card space-y-2 p-4">
        <p className="text-sm font-semibold">{t(states[member.state])}</p>
        {member.userId && <p className="break-all text-xs">{member.userId}</p>}
        {member.state === 'active' && <label className="block text-sm">{t('Роль в команде')}
          <select className={field} value={member.role} disabled={waiting}
            onChange={e => { const next = e.target.value as VendorStaffRole; void run(origin => updateVendorStaffRole(member, next, origin)) }}>
            {Object.entries(staffRoles).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
          </select>
        </label>}
        {(member.state === 'active' || member.state === 'invited') && (
          remove === member.id ? <div className="flex flex-wrap gap-2">
            <button type="button" className={button} disabled={waiting} onClick={() => void run(
              origin => revokeVendorStaff(member, origin), () => {
                if (invitation?.id === member.id) setInvitation(null)
                setRemove(null)
              })}>{t('Подтвердить отзыв доступа')}</button>
            <button type="button" className={button} onClick={() => setRemove(null)}>{t('Отмена')}</button>
          </div> : <button type="button" className={button} disabled={waiting} onClick={() => setRemove(member.id)}>{t('Отозвать доступ')}</button>
        )}
      </article>)}
    </>}
  </>
}

export function StaffDuties() {
  const location = useLocation()
  const token = location.hash.slice(1)
  const code = tokenFormat.test(token) ? token : ''
  const scope = useLegacySessionKey(JSON.stringify([location.key, code]))
  if (!isAuthorized()) return <div className="space-y-4 pb-12">
    <TopBar back title={t('Мои рабочие назначения')} />
    <div className="px-5"><Link className={button} to="/auth" replace state={{ vendorStaffCode: code }}>{t('Войти')}</Link></div>
  </div>
  return <StaffDutiesBoard key={scope} scope={scope} code={code} />
}

function StaffDutiesBoard({ scope, code }: { scope: string; code: string }) {
  const navigate = useNavigate()
  const capture = useLegacyActionScope(scope)
  const [after, setAfter] = useState<string | null>(null)
  const [showCode, setShowCode] = useState(false)
  const q = useApi(() => getOwnStaffDuties(after, capture()), [after, capture])
  const me = useApi(() => showCode ? getMe(capture()) : Promise.resolve(null), [showCode, capture])
  const { busy, error, run } = useStaffAction(capture, q.reload)
  return <div className="pb-12">
    <TopBar back title={t('Мои рабочие назначения')} />
    <div className="space-y-3 px-5">
      <div className="card space-y-2 p-4">
        <button type="button" className={button} aria-expanded={showCode} onClick={() => setShowCode(show => !show)}>
          {t('Мой код сотрудника')}
        </button>
        {showCode && <>
          <AsyncState q={me} />
          {me.data?.id && <input readOnly className={field} aria-label={t('Код сотрудника')} value={me.data.id} onFocus={e => e.target.select()} />}
          {me.data?.id && <button type="button" className={button} onClick={() => copyText(me.data!.id!)}>{t('Скопировать код сотрудника')}</button>}
        </>}
      </div>
      {code && <section aria-label={t('Приглашение в команду')} className="card flex flex-wrap gap-2 p-4">
        {[true, false].map(accept => <button key={String(accept)} type="button" className={button} disabled={busy}
          onClick={() => void run(origin => answerVendorStaffInvitation(code, accept, origin), () => navigate('/staff-duties', { replace: true }))}>
          {t(accept ? 'Принять приглашение' : 'Отклонить приглашение')}
        </button>)}
      </section>}
      {error && <p role="alert" className="card p-3 text-sm">{error}</p>}
      <AsyncState q={q} />
      {ready(q) && !q.refreshing && q.data && <>
        {!q.data.items.length && <p className="text-sm">{t('Действующих рабочих назначений пока нет')}</p>}
        {q.data.items.map(duty => <article key={duty.id} className="card space-y-2 p-4">
          <h2 className="break-words font-semibold">{duty.label}</h2>
          <p className="text-sm">{t(dutyRoles[duty.role])} · {duty.event.name}</p>
          <p className="text-sm">{[duty.event.date && shortWeddingDate(duty.event.date), duty.event.timeZone, duty.event.location].filter(Boolean).join(' · ')}</p>
        </article>)}
        {q.data.nextAfter && <button type="button" className={button} onClick={() => setAfter(q.data!.nextAfter)}>{t('Следующие назначения')}</button>}
        {after && <button type="button" className={button} onClick={() => setAfter(null)}>{t('К первым назначениям')}</button>}
      </>}
    </div>
  </div>
}

type EventOption = { id: string; name: string }

export function OrderStaffDuties({ dealId, event }: { dealId: string; event?: EventOption | null }) {
  const [open, setOpen] = useState(false)
  const scope = useLegacySessionKey(dealId)
  return <section className="card p-4">
    <button type="button" className={button} aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {t('Назначения сотрудников')}
    </button>
    {open && <OrderDutyBoard key={scope} scope={scope} dealId={dealId} event={event} />}
  </section>
}

function OrderDutyBoard({ scope, dealId, event }: { scope: string; dealId: string; event?: EventOption | null }) {
  const capture = useLegacyActionScope(scope)
  const q = useApi(async () => {
    const origin = capture()
    const [profile, order, duties] = await Promise.all([getVendorProfile(origin), getOrder(dealId, origin), getOrderStaffDuties(dealId, origin)])
    if (!profile?.id) throw new Error('Company profile missing')
    const staff = await getVendorStaff(profile.id, origin)
    return { order, duties, staff }
  }, [dealId, capture])
  const { busy, error, run } = useStaffAction(capture, q.reload)
  const [person, setPerson] = useState('')
  const [assignment, setAssignment] = useState('')
  const fieldId = useId()
  const [role, setRole] = useState<VendorStaffDutyRole>('performer')
  const [label, setLabel] = useState('')
  const [remove, setRemove] = useState<string | null>(null)
  const [transfer, setTransfer] = useState<{ dutyId: string; memberId: string } | null>(null)
  const liveStaff = q.data?.staff.filter(member => member.state === 'active') ?? []
  const assignments = q.data?.order.assignments.filter(item => !item.cancelledAt) ?? []
  const selected = assignments.find(item => item.id === assignment)
  const programEventId = selected?.programEventId ?? (assignment === 'primary' ? event?.id : undefined)
  const waiting = busy || q.refreshing
  const canAssign = !!programEventId && !!label.trim() && liveStaff.some(member => member.id === person)
  function assign(e: FormEvent) {
    e.preventDefault()
    if (!canAssign || !programEventId) return
    void run(origin => createOrderStaffDuty(dealId, {
      memberId: person, programEventId, assignmentId: selected?.id ?? null, role, label: label.trim(),
    }, origin), () => setLabel(''))
  }

  return <div className="mt-3 space-y-3">
    <AsyncState q={q} forbiddenText={t('Назначения ведёт владелец компании')} />
    {error && <p role="alert" className="text-sm">{error}</p>}
    {ready(q) && q.data && <>
      {!liveStaff.length && <Link className="block text-sm underline" to="/vendor-app/staff">{t('Пригласить сотрудника в команду')}</Link>}
      {liveStaff.length > 0 && <form onSubmit={assign} className="space-y-3">
        <div>
          <label className="block text-sm" htmlFor={fieldId + '-member'}>{t('Сотрудник')}</label>
          <select id={fieldId + '-member'} className={field} value={person} onChange={e => setPerson(e.target.value)} required>
            <option value="">{t('Выберите сотрудника')}</option>
            {liveStaff.map(member => <option key={member.id} value={member.id}>{member.userId}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm" htmlFor={fieldId + '-event'}>{t('Мероприятие для назначения')}</label>
          <select id={fieldId + '-event'} className={field} value={assignment} onChange={e => setAssignment(e.target.value)} required>
            <option value="">{t('Выберите мероприятие')}</option>
            {event && !assignments.some(item => item.programEventId === event.id) && <option value="primary">{event.name}</option>}
            {assignments.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </div>
        <label className="block text-sm">{t('Рабочая роль')}
          <select className={field} value={role} onChange={e => setRole(e.target.value as VendorStaffDutyRole)}>
            {Object.entries(dutyRoles).map(([value, name]) => <option key={value} value={value}>{t(name)}</option>)}
          </select>
        </label>
        <label className="block text-sm">{t('Что сделать')}
          <input className={field} value={label} onChange={e => setLabel(e.target.value)} required maxLength={200} />
        </label>
        <button className={button} disabled={waiting || !canAssign}>{t('Назначить сотрудника')}</button>
      </form>}
      {q.data.duties.map(duty => {
        const assignee = q.data!.staff.find(member => member.id === duty.memberId)
        const replacements = liveStaff.filter(member => member.id !== duty.memberId)
        const assignmentLive = duty.assignmentId === null || assignments.some(item => item.id === duty.assignmentId)
        return <article key={duty.id} className="space-y-2 rounded-xl border border-[var(--line)] p-3">
          <h3 className="break-words text-sm font-semibold">{duty.label}</h3>
          <p className="break-all text-xs">{assignee?.userId ?? '—'} · {t(dutyRoles[duty.role])}</p>
          {duty.revokedAt ? <p className="text-sm">{t('Назначение закрыто')}</p> : <>
            {!assignmentLive ? <p className="text-sm">{t('Назначение на мероприятие отменено')}</p> :
              assignee?.state !== 'active' && <p className="text-sm">{t('Нужно переназначить задачу')}</p>}
            {remove === duty.id ? <div className="flex flex-wrap gap-2">
              <button type="button" className={button} disabled={waiting}
                onClick={() => void run(origin => revokeOrderStaffDuty(duty, origin), () => setRemove(null))}>{t('Подтвердить снятие назначения')}</button>
              <button type="button" className={button} onClick={() => setRemove(null)}>{t('Отмена')}</button>
            </div> : transfer?.dutyId === duty.id && assignmentLive ? <form className="space-y-2" onSubmit={e => {
              e.preventDefault()
              if (!waiting && replacements.some(member => member.id === transfer.memberId)) {
                void run(origin => reassignOrderStaffDuty(duty, transfer.memberId, origin), () => setTransfer(null))
              }
            }}>
              <label className="block text-sm">{t('Новый сотрудник')}
                <select className={field} value={transfer.memberId} required onChange={e => setTransfer({ dutyId: duty.id, memberId: e.target.value })}>
                  <option value="">{t('Выберите сотрудника')}</option>
                  {replacements.map(member => <option key={member.id} value={member.id}>{member.userId}</option>)}
                </select>
              </label>
              <button className={button} disabled={waiting || !replacements.some(member => member.id === transfer.memberId)}>{t('Подтвердить переназначение')}</button>
              <button type="button" className={button} onClick={() => setTransfer(null)}>{t('Отмена')}</button>
            </form> : <div className="flex flex-wrap gap-2">
              {assignmentLive && replacements.length > 0 && <button type="button" className={button} disabled={waiting}
                onClick={() => { setRemove(null); setTransfer({ dutyId: duty.id, memberId: '' }) }}>{t('Переназначить')}</button>}
              <button type="button" className={button} disabled={waiting}
                onClick={() => { setTransfer(null); setRemove(duty.id) }}>{t('Снять назначение')}</button>
            </div>}
          </>}
        </article>
      })}
    </>}
  </div>
}
