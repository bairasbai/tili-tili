import { useId, useRef, useState } from 'react'
import type { components } from '@/lib/api/schema'
import { t } from '@/lib/i18n'

type Member = { user?: { id?: string; name?: string | null }; role?: string }
export interface TaskPlanningValue {
  assigneeId: string; due: string; dueMode: 'relative' | 'fixed'
  reminderDaysBefore?: number | null; reminderTime?: string
}
interface FieldsProps {
  value: TaskPlanningValue
  onChange: (value: TaskPlanningValue) => void
  members: Member[]
  membersReady: boolean
  hasWeddingDate: boolean
  disabled?: boolean
}

/** Одна форма только для чек-листа; черновик не пишет в API на каждый ввод цифры даты. */
export function TaskPlanningFields({ value, onChange, members, membersReady, hasWeddingDate, disabled = false }: FieldsProps) {
  const id = useId()
  const eligible = members.filter(m => m.user?.id && ['couple', 'helper', 'coordinator'].includes(m.role ?? ''))
  const missingAssignee = value.assigneeId && !eligible.some(m => m.user?.id === value.assigneeId)
  const canRemind = !!value.assigneeId && (!!value.due || (value.dueMode === 'relative' && hasWeddingDate))
  const update = (patch: Partial<TaskPlanningValue>) => {
    const next = { ...value, ...patch }
    if (!next.assigneeId || (!next.due && next.dueMode === 'fixed')) next.reminderDaysBefore = null
    onChange(next)
  }
  return <div className="grid grid-cols-1 gap-2.5 mt-2.5">
    <label htmlFor={`${id}-assignee`} className="text-[11px] text-[var(--soft)]">{t('Ответственный')}</label>
    <select id={`${id}-assignee`} value={value.assigneeId} disabled={disabled || !membersReady}
      onChange={e => update({ assigneeId: e.target.value })}
      className="w-full bg-[var(--bg)] rounded-xl px-3 py-3 text-[12px] outline-none disabled:opacity-50">
      <option value="">{t('Без ответственного')}</option>
      {missingAssignee && <option value={value.assigneeId}>{t('Участник недоступен')}</option>}
      {eligible.map(m => <option key={m.user!.id} value={m.user!.id}>{m.user!.name || t('Участник')}</option>)}
    </select>
    {!membersReady && <p className="text-[11px] text-[var(--soft)]">{t('Команда не загружена — назначение не изменится')}</p>}
    <label htmlFor={`${id}-due`} className="text-[11px] text-[var(--soft)]">{t('Дата выполнения')}</label>
    <input id={`${id}-due`} type="date" value={value.due} disabled={disabled} onChange={e => update({
      due: e.target.value,
      // Снятие даты — явное отсутствие срока, не просьба вернуть шаблон при переносе.
      ...(!e.target.value || !value.due ? { dueMode: 'fixed' as const } : {}),
    })} className="w-full bg-[var(--bg)] rounded-xl px-3 py-3 text-[12px] outline-none disabled:opacity-50" />
    <label htmlFor={`${id}-mode`} className="text-[11px] text-[var(--soft)]">{t('Поведение при переносе свадьбы')}</label>
    <select id={`${id}-mode`} value={value.dueMode} disabled={disabled}
      onChange={e => update({ dueMode: e.target.value as TaskPlanningValue['dueMode'] })}
      className="w-full bg-[var(--bg)] rounded-xl px-3 py-3 text-[12px] outline-none disabled:opacity-50">
      <option value="fixed">{t('Фиксированная дата')}</option>
      <option value="relative" disabled={!!value.due && !hasWeddingDate}>{t('Следует за свадьбой')}</option>
    </select>
    <p className="text-[10.5px] text-[var(--soft)]">{value.dueMode === 'fixed'
      ? t('Фиксированный срок не меняется при переносе свадьбы')
      : t('Без точной даты срок рассчитывается по выбранному периоду')}</p>
    <label className="flex items-center gap-2 text-[12px] mt-2">
      <input type="checkbox" checked={value.reminderDaysBefore != null} disabled={disabled || !canRemind}
        onChange={e => update({ reminderDaysBefore: e.target.checked ? 1 : null, reminderTime: value.reminderTime ?? '09:00' })} />
      {t('Напомнить ответственному')}
    </label>
    {!canRemind && <p className="text-[11px] text-[var(--soft)]">{t('Для напоминания нужны срок и ответственный')}</p>}
    {value.reminderDaysBefore != null && <>
      <label htmlFor={`${id}-reminder-days`} className="text-[11px] text-[var(--soft)]">{t('За сколько дней до срока')}</label>
      <select id={`${id}-reminder-days`} value={value.reminderDaysBefore} disabled={disabled}
        onChange={e => update({ reminderDaysBefore: Number(e.target.value) })}
        className="w-full bg-[var(--bg)] rounded-xl px-3 py-3 text-[12px] outline-none disabled:opacity-50">
        {Array.from({ length: 31 }, (_, days) => <option key={days} value={days}>{days === 0 ? t('В день срока') : `${days} ${t('дн. до срока')}`}</option>)}
      </select>
      <label htmlFor={`${id}-reminder-time`} className="text-[11px] text-[var(--soft)]">{t('Время напоминания')}</label>
      <input id={`${id}-reminder-time`} type="time" required value={value.reminderTime ?? '09:00'} disabled={disabled}
        onChange={e => update({ reminderTime: e.target.value })}
        className="w-full bg-[var(--bg)] rounded-xl px-3 py-3 text-[12px] outline-none disabled:opacity-50" />
      <p className="text-[10.5px] text-[var(--soft)]">{t('По часовому поясу ответственного; тихие часы и настройка уведомлений учитываются')}</p>
    </>}
  </div>
}

interface EditorProps extends Omit<FieldsProps, 'value' | 'onChange'> {
  task: components['schemas']['Task']
  onSave: (patch: components['schemas']['TaskPatch']) => Promise<boolean>
  onCancel: () => void
}
export function TaskPlanningEditor({ task, onSave, onCancel, ...props }: EditorProps) {
  const [value, setValue] = useState<TaskPlanningValue>({
    assigneeId: task.assignee?.userId ?? '', due: task.due ?? '', dueMode: task.dueMode ?? 'relative',
    reminderDaysBefore: task.reminderDaysBefore ?? null, reminderTime: task.reminderTime ?? '09:00',
  })
  const saving = useRef(false)
  const save = async () => {
    if (saving.current || props.disabled || (value.reminderDaysBefore != null && !value.reminderTime)) return
    saving.current = true
    try {
      const patch: components['schemas']['TaskPatch'] = {
        ...(props.membersReady ? { assigneeId: value.assigneeId || null } : {}),
        dueMode: value.dueMode,
        ...((value.reminderDaysBefore ?? null) !== (task.reminderDaysBefore ?? null)
          ? { reminderDaysBefore: value.reminderDaysBefore ?? null } : {}),
        ...(value.reminderTime !== (task.reminderTime ?? '09:00') ? { reminderTime: value.reminderTime } : {}),
        // Пустая relative означает «вернуть срок из периода», не explicit null.
        ...(value.due ? { due: value.due } : value.dueMode === 'fixed' ? { due: null } : {}),
      }
      if (await onSave(patch)) onCancel()
    } finally { saving.current = false }
  }
  return <div role="group" aria-label={t('Планирование задачи')} className="mt-2">
    <TaskPlanningFields value={value} onChange={setValue} {...props} />
    <div className="flex gap-3 mt-3">
      <button disabled={props.disabled || (value.reminderDaysBefore != null && !value.reminderTime)} onClick={() => void save()} className="press text-[11px] font-bold px-3 py-2 rounded-full bg-[var(--sage-soft)] text-[var(--sage-ink)] disabled:opacity-50">{t('Сохранить планирование')}</button>
      <button disabled={props.disabled} onClick={onCancel} className="press text-[11px] px-3 py-2 text-[var(--soft)]">{t('Отмена')}</button>
    </div>
  </div>
}
