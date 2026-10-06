import { useRef, useState } from 'react'
import { Link } from 'react-router'
import type { components } from '@/lib/api/schema'
import type { TaskPatch } from '@/lib/api/weddingWrite'
import { t } from '@/lib/i18n'

type Dependency = components['schemas']['TaskDependency']
export type DependencyTask = {
  id: string; title: string; done: boolean
  dependencies?: Dependency[]
  dependencyVersion?: string
  dependencyOverride?: { reason: string; at: string } | null
}
type Props = { task: DependencyTask; tasks: DependencyTask[]; weddingId: string; canManage: boolean; disabled: boolean
  onSave: (patch: TaskPatch) => Promise<boolean>; onRefresh: () => void }
const button = 'press min-h-11 rounded-xl px-3 py-2 text-xs font-semibold bg-[var(--bg)] disabled:opacity-50'

/** Absence of server dependency metadata is unknown, not an empty graph. */
export function TaskDependencies(props: Props) {
  if (!props.task.dependencies || props.task.dependencyVersion === undefined) return null
  return <DependencyEditor key={JSON.stringify([props.weddingId, props.task.id, props.task.dependencyVersion,
    props.task.dependencies.map(d => [d.id, d.done]), props.task.done, props.canManage])}
    {...props} dependencies={props.task.dependencies} version={props.task.dependencyVersion} />
}
function DependencyEditor({ task, tasks, weddingId, canManage, disabled, onSave, onRefresh, dependencies, version }:
  Props & { dependencies: Dependency[]; version: string }) {
  const [editing, edit] = useState(false)
  const [selected, select] = useState(() => dependencies.map(d => d.id))
  const [reason, setReason] = useState('')
  const writing = useRef(false)
  const [busy, setBusy] = useState(false)
  const pending = dependencies.filter(d => !d.done)
  const locked = disabled || busy
  const save = async (patch: TaskPatch) => {
    if (locked || writing.current) return
    writing.current = true; setBusy(true)
    try {
      if (await onSave(patch)) { edit(false); setReason('') }
    } finally { writing.current = false; setBusy(false) }
  }
  return <section aria-label={t('Зависимости задачи')} className="mt-3 min-w-0 space-y-2 border-t border-[var(--track)] pt-3">
    <h3 className="text-xs font-semibold">{t('Зависимости задачи')}</h3>
    {dependencies.length ? <ul className="space-y-1 text-xs">
      {dependencies.map(d => <li key={d.id} className="break-words">
        <span>{d.done ? t('Выполнено:') : t('Сначала завершите:')} </span>
        <Link className="underline" to={`/wedding/checklist?wedding=${encodeURIComponent(weddingId)}&task=${encodeURIComponent(d.id)}`}>{d.title}</Link>
      </li>)}
    </ul> : <p className="text-xs text-[var(--soft)]">{t('Предпосылки не заданы')}</p>}
    {task.done && pending.length > 0 && <p className="text-xs text-[var(--soft)]">{t('У выполненной задачи есть незавершённые предпосылки. Отметка не снимается автоматически.')}</p>}
    {task.dependencyOverride && <p className="text-xs break-words">{t('Причина ручного завершения:')} {task.dependencyOverride.reason}</p>}
    {canManage && <button type="button" disabled={locked} className={button} onClick={() => edit(!editing)}>{editing ? t('Закрыть редактор связей') : t('Изменить зависимости')}</button>}
    {canManage && editing && <fieldset disabled={locked} className="space-y-2">
      <legend className="text-xs">{t('Что нужно закончить раньше')}</legend>
      {tasks.filter(tk => tk.id !== task.id).map(candidate => <label key={candidate.id} className="flex min-h-11 gap-2 items-center text-xs break-words">
        <input type="checkbox" checked={selected.includes(candidate.id)}
          disabled={task.done && !dependencies.some(d => d.id === candidate.id)}
          onChange={e => select(e.target.checked ? [...selected, candidate.id] : selected.filter(id => id !== candidate.id))} />
        <span>{candidate.title}</span>
      </label>)}
      {task.done && <p className="text-xs text-[var(--soft)]">{t('Чтобы добавить предпосылки, сначала снимите отметку выполнения.')}</p>}
      <button type="button" className={button} disabled={selected.length > 64} onClick={() => void save({ dependsOn: selected, dependencyVersion: version })}>{t('Сохранить зависимости')}</button>
    </fieldset>}
    {!task.done && pending.length > 0 && (canManage ? <div className="space-y-2">
      <p className="text-xs">{t('Можно завершить осознанно, не снимая связи. Причина сохранится в истории.')}</p>
      <label className="block text-xs">{t('Причина ручного решения')}
        <textarea value={reason} maxLength={500} disabled={locked} onChange={e => setReason(e.target.value)}
          className="mt-1 min-h-20 w-full rounded-xl bg-[var(--bg)] px-3 py-2" />
      </label>
      <button type="button" className={button} disabled={locked || !reason.trim()} onClick={() => void save({ done: true,
        dependencyVersion: version, dependencyOverride: { reason: reason.trim(), prerequisiteIds: pending.map(d => d.id) } })}>{t('Завершить с указанной причиной')}</button>
    </div> : <p className="text-xs text-[var(--soft)]">{t('Ручное завершение при незакрытых предпосылках подтверждает пара.')}</p>)}
    <button type="button" disabled={locked} className={button} onClick={onRefresh}>{t('Обновить задачи и зависимости')}</button>
  </section>
}
