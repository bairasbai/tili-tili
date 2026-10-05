import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { ApiError, beginLocalSessionAction, onSessionChanged } from '@/lib/api/client'
import { importGuests } from '@/lib/api/weddingWrite'
import { explainError } from '@/lib/api/useApi'
import { t } from '@/lib/i18n'
import { plural } from '@/lib/utils'
import { NAME_MAX } from '@/lib/guestsImport'
import {
  appendImportMember, buildImportPreview, createImportDraft, IMPORT_MEMBERS_MAX,
  IMPORT_PHONE_MAX, IMPORT_ROWS_MAX, nameLegacyCompanion, prepareImport,
  reconcileImportResponse, type ExistingImportGuest, type ImportInvitationDraft,
  type ImportPreviewRow,
} from '@/lib/guestImportDraft'

const fieldClass = 'w-full min-w-0 rounded-xl bg-[var(--bg)] px-3 py-2 text-[13px]'
const actionClass = 'press rounded-xl px-3 py-2 text-[12px] font-semibold text-[var(--sage-deep)] disabled:opacity-50'

type Props = {
  weddingId: string | null
  existing?: ExistingImportGuest[]
  open: boolean
  onClose: () => void
  onImported: () => void
}

type Result = Pick<ReturnType<typeof reconcileImportResponse>, 'invitations' | 'persons' | 'skipped'>
type Attempt = { draft: ImportInvitationDraft[]; submitted: ReturnType<typeof prepareImport> }

function duplicateMessage(row: ImportPreviewRow): string {
  if (row.duplicateReason === 'family') return t('Имена повторяются внутри семьи. Уточните полные имена.')
  if (row.duplicateReason === 'batch') return t('Имя или телефон повторяются в этом импорте.')
  return t('уже в списке')
}

function FamilyEditor({ row, onChange, onRemove }: {
  row: ImportPreviewRow
  onChange: (row: ImportInvitationDraft) => void
  onRemove: () => void
}) {
  return <fieldset className="min-w-0 rounded-2xl border border-[var(--track)] p-3 space-y-2">
    <legend className="px-1 text-[12px] font-semibold">{t('Состав приглашения')} {row.sourceIndex + 1}</legend>
    <p className="text-[10px] break-words text-[var(--soft)]">{row.raw}</p>
    <label className="block text-[11px]">{t('Основной человек')}
      <input value={row.name} maxLength={NAME_MAX} className={fieldClass}
        aria-invalid={row.issues.some(issue => issue.field === 'name')}
        onChange={event => onChange({ ...row, name: event.target.value })} />
    </label>
    <p className="text-[10.5px] text-[var(--soft)]">{t('Основное имя тоже создаёт одну персону. Укажите остальных отдельно.')}</p>
    <label className="block text-[11px]">{t('Телефон основного человека')}
      <input value={row.phone} inputMode="tel" maxLength={IMPORT_PHONE_MAX} className={fieldClass}
        aria-invalid={row.issues.some(issue => issue.field === 'phone')}
        onChange={event => onChange({ ...row, phone: event.target.value })} />
    </label>
    {row.mode === 'legacy-plus-one' ? <div>
      <p className="text-[11px]">{t('Человек без указанного имени (+1)')}</p>
      <button type="button" className={actionClass} onClick={() => onChange(nameLegacyCompanion(row))}>{t('Указать имя вместо +1')}</button>
      <button type="button" className={actionClass} onClick={() => onChange({ ...row, mode: 'named' })}>{t('Убрать +1')}</button>
    </div> : <div className="space-y-2">
      {row.members.map((member, index) => <div key={member.id}>
        <label className="block text-[11px]">{t('Человек семьи')} {index + 2}
          <input value={member.name} maxLength={NAME_MAX} className={fieldClass}
            aria-invalid={row.issues.some(issue => issue.memberId === member.id)}
            onChange={event => onChange({ ...row, members: row.members.map(item => item.id === member.id ? { ...item, name: event.target.value } : item) })} />
        </label>
        <button type="button" className={actionClass} onClick={() => onChange({ ...row, members: row.members.filter(item => item.id !== member.id) })}>
          {t('Удалить человека')} {index + 2}
        </button>
      </div>)}
      <button type="button" disabled={row.members.length >= IMPORT_MEMBERS_MAX} className={actionClass}
        onClick={() => onChange(appendImportMember(row))}>{t('Добавить человека в семью')}</button>
    </div>}
    {row.issues.length > 0 && <p role="alert" className="text-[11px] text-[var(--rose-ink)]">
      {row.issues.some(issue => issue.field === 'phone') ? t('телефон не распознан') : t('Проверьте имена: от 2 до 120 символов. В приглашении не больше 10 персон.')}
    </p>}
    {row.duplicate && <p className="text-[11px] text-[var(--honey-ink)]">{duplicateMessage(row)}</p>}
    <button type="button" className={actionClass} onClick={onRemove}>{t('Убрать приглашение из импорта')}</button>
  </fieldset>
}

/** Closing retains a draft only within the same wedding and local session. */
export function GuestImportPanel(props: Props) {
  const [generation, resetSession] = useReducer((value: number) => value + 1, 0)
  useEffect(() => onSessionChanged(resetSession), [])
  // The boundary belongs to this component: callers need not remember a key.
  // Decoded token claims only scope local private data, never authorize an API call.
  return <SessionGuestImportPanel key={JSON.stringify([props.weddingId, generation])} {...props} />
}

function SessionGuestImportPanel({ weddingId, existing, open, onClose, onImported }: Props) {
  const [text, setText] = useState('')
  const [rows, setRows] = useState<ImportInvitationDraft[] | null>(null)
  const [confirmBack, setConfirmBack] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [retryAttempt, setRetryAttempt] = useState<Attempt | null>(null)
  const inFlight = useRef(false)
  const mounted = useRef(false)
  const reload = useRef(onImported)
  useEffect(() => { reload.current = onImported }, [onImported])
  const lifetime = useRef<ReturnType<typeof beginLocalSessionAction> | null>(null)
  useEffect(() => {
    mounted.current = true
    const action = beginLocalSessionAction()
    lifetime.current = action
    return () => {
      mounted.current = false
      lifetime.current = null
      action.close()
    }
  }, [])
  const isCurrent = () => {
    if (!mounted.current || !lifetime.current) return false
    try { lifetime.current.assertCurrent(); return true } catch { return false }
  }

  const pasted = useMemo(() => createImportDraft(text), [text])
  const preview = useMemo(() => buildImportPreview(rows ?? pasted, existing), [rows, pasted, existing])
  const eligible = preview.filter(row => row.issues.length === 0 && !row.duplicate)
  const estimatedPersons = eligible.reduce((sum, row) => sum + row.persons, 0)
  const displayedInvitations = retryAttempt?.submitted.invitations ?? eligible.length
  const displayedPersons = retryAttempt?.submitted.persons ?? estimatedPersons
  const clearFeedback = () => { setError(null); setResult(null) }
  const editRow = (row: ImportInvitationDraft) => {
    setRows(current => current?.map(item => item.id === row.id ? row : item) ?? null)
    clearFeedback()
  }
  const refreshList = (confirmed: boolean) => {
    // A failed reader callback cannot turn a confirmed write into a POST retry.
    try { reload.current() } catch {
      if (confirmed) setError(t('Не удалось обновить список. Откройте гостей заново; повторная отправка не нужна.'))
    }
  }
  const requestImport = async (repeat = false) => {
    if (inFlight.current || rows === null || !isCurrent() || confirmBack) return
    if (!weddingId) { setError(t('Сначала создайте свадьбу — гости живут в ней')); return }
    // An uncertain attempt is immutable. A fresh GET may now mark its rows as
    // duplicates, but retry must still send exactly the originally captured body.
    if (repeat !== (retryAttempt !== null)) return
    if (!repeat && (eligible.length === 0 || eligible.length > IMPORT_ROWS_MAX)) return
    const attempt = retryAttempt ?? { draft: rows, submitted: prepareImport(preview) }
    inFlight.current = true
    setBusy(true)
    clearFeedback()
    let confirmed = false
    try {
      const response = await importGuests(weddingId, attempt.submitted.rows)
      if (!isCurrent()) return
      const next = reconcileImportResponse(attempt.draft, attempt.submitted.rowIds, response)
      confirmed = true
      setRetryAttempt(null)
      setRows(next.remaining)
      setResult({ invitations: next.invitations, persons: next.persons, skipped: next.skipped })
      setText(next.remaining.map(row => row.raw).join('\n'))
    } catch (reason) {
      if (!isCurrent()) return
      // A 4xx rejects this request definitively. Network/timeout/5xx or an invalid
      // success body may follow a committed transaction; never invent its totals.
      const rejected = reason instanceof ApiError && reason.kind === 'http'
        && reason.status >= 400 && reason.status < 500
      // Rejection of a replay does not settle an earlier unknown transaction.
      const definitive = rejected && !repeat
      setRetryAttempt(definitive ? null : attempt)
      setError(definitive ? explainError(reason)
        : t('Не удалось подтвердить итог импорта. Сервер мог сохранить записи. Повторите ту же попытку без изменения имён; дубликаты проверит сервер.'))
    } finally {
      inFlight.current = false
      if (isCurrent()) { setBusy(false); refreshList(confirmed) }
    }
  }

  return <section hidden={!open} aria-label={t('Добавить списком')} className="px-5 mt-3">
    <div className="card p-4 space-y-3">
      <h2 className="text-[13px] font-semibold">{t('Добавить списком')}</h2>
      <fieldset disabled={busy || retryAttempt !== null} className="min-w-0 space-y-3">
        {rows === null ? <>
          <label className="block text-[12px]">{t('Список гостей')}
            <textarea value={text} onChange={event => { setText(event.target.value); clearFeedback() }} rows={5}
              placeholder={t('Каждый гость — с новой строки. В строке через запятую: имя, телефон, +1')}
              className={`${fieldClass} resize-y`} />
          </label>
          <p className="text-[11px] text-[var(--soft)]">{t('Строка — одно приглашение. Имена членов семьи можно добавить в предпросмотре.')}</p>
          {pasted.length > 0 && <ul className="text-[11px] space-y-1">
            {preview.map(row => <li key={row.id} className="break-words">{row.raw}{row.issues.length ? ` · ${t('Проверьте поля')}` : row.duplicate ? ` · ${duplicateMessage(row)}` : ''}</li>)}
          </ul>}
          <button type="button" disabled={pasted.length === 0} className={actionClass}
            onClick={() => { setRows(pasted); clearFeedback() }}>{t('Проверить и дополнить')}</button>
        </> : <>
          {preview.map(row => <FamilyEditor key={row.id} row={row} onChange={editRow}
            onRemove={() => { setRows(current => current?.filter(item => item.id !== row.id) ?? null); clearFeedback() }} />)}
          <p role="status" className="text-[12px] font-semibold">{retryAttempt ? t('Сохранённая попытка:') : t('К отправке:')} {displayedInvitations} {plural(displayedInvitations, t('приглашение'), t('приглашения'), t('приглашений'))} · {displayedPersons} {plural(displayedPersons, t('персона'), t('персоны'), t('персон'))}</p>
          <p className="text-[10.5px] text-[var(--soft)]">{t('Это предпросмотр. Итог создания покажет сервер.')}</p>
          {eligible.length > IMPORT_ROWS_MAX && <p role="alert" className="text-[11px] text-[var(--rose-ink)]">{t('За один раз — не больше 300 приглашений. Уберите часть строк из импорта.')}</p>}
          <button type="button" className={actionClass} onClick={() => setConfirmBack(true)}>{t('Вернуться к вставке')}</button>
          {confirmBack && <div role="group" aria-label={t('Сбросить правки предпросмотра?')} className="space-y-2">
            <p className="text-[11px]">{t('Правки имён и состава семьи будут потеряны. Вернуться к исходной вставке?')}</p>
            <button type="button" className={actionClass} onClick={() => { setRows(null); setConfirmBack(false); clearFeedback() }}>{t('Сбросить правки')}</button>
            <button type="button" className={actionClass} onClick={() => setConfirmBack(false)}>{t('Отмена')}</button>
          </div>}
        </>}
        {existing === undefined && <p className="text-[11px] text-[var(--soft)]">{t('Текущий список ещё не подтверждён. Дубликаты окончательно проверит сервер.')}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={actionClass} onClick={onClose}>{t('Закрыть')}</button>
          {rows !== null && <button type="button" disabled={eligible.length === 0 || eligible.length > IMPORT_ROWS_MAX || confirmBack}
            className="press rounded-full grad px-4 py-2 text-[12px] font-bold text-[var(--on-grad)] disabled:opacity-50"
            onClick={() => void requestImport()}>{t('Импортировать приглашения')}</button>}
        </div>
      </fieldset>
      {retryAttempt && <div className="space-y-2">
        <p className="text-[11px] text-[var(--soft)]">{t('До подтверждённого ответа состав попытки не меняется. Закрытие панели сохраняет его.')}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} className={actionClass}
            onClick={() => void requestImport(true)}>{t('Повторить тот же импорт')}</button>
          <button type="button" className={actionClass} onClick={onClose}>{t('Закрыть без потери попытки')}</button>
        </div>
      </div>}
      {busy && <p role="status" className="text-[12px]">{t('Добавляем…')}</p>}
      {error && <p role="alert" className="text-[11.5px] text-[var(--rose-ink)]">{error}</p>}
      {result && <div role="status" className="text-[12px] space-y-1">
        <p>{t('Создано приглашений:')} {result.invitations}</p>
        <p>{result.persons === null ? t('Число персон уточняется после обновления списка') : `${t('Создано персон:')} ${result.persons}`}</p>
        {result.skipped.map(item => <p key={item.index} className="break-words text-[var(--soft)]">{item.name} — {item.reason === 'duplicate' ? t('уже в списке') : t('Строка не принята сервером: проверьте поля')}</p>)}
      </div>}
    </div>
  </section>
}
