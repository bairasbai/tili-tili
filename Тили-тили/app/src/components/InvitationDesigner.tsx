import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { t } from '@/lib/i18n'
import { useApi } from '@/lib/api/useApi'
import { getInvitationDesign, saveInvitationDesign, publishInvitationDesign } from '@/lib/api/invitationDesign'
import { ApiError } from '@/lib/api/client'
import { parseInvitationDesign, type InvitationDesign } from '@/lib/invitationDesign'
import { useLegacyActionScope, useLegacySessionKey } from '@/lib/useLegacyActionScope'
import { AsyncState, ready } from '@/components/AsyncState'
import { InvitationBlocks } from './InvitationBlocks'

const Editor = lazy(() => import('./InvitationPuckEditor'))
type Snapshot = Awaited<ReturnType<typeof getInvitationDesign>>
export function InvitationDesigner(props: { weddingId: string; legacyText: string; canEdit: boolean }) {
  const sessionKey = useLegacySessionKey(props.weddingId)
  return <DesignerSession key={`${props.weddingId}:${sessionKey}`} {...props} sessionKey={sessionKey} />
}
function DesignerSession({ weddingId, legacyText, canEdit, sessionKey }: { weddingId: string; legacyText: string; canEdit: boolean; sessionKey: string }) {
  const query = useApi(() => getInvitationDesign(weddingId), [weddingId])
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const current = snapshot ?? query.data
  const [draft, setDraft] = useState<InvitationDesign | null>(null)
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [conflict, setConflict] = useState(false), [editorRevision, setEditorRevision] = useState(0)
  const captureAccess = useLegacyActionScope(sessionKey, weddingId)
  const permission = useRef({ canEdit, revision: 0 })
  if (permission.current.canEdit !== canEdit) permission.current = { canEdit, revision: permission.current.revision + 1 }
  const alive = useRef(true), operation = useRef<object | null>(null), editRevision = useRef(0)
  const [photosPending, setPhotosPending] = useState<ReadonlySet<string>>(() => new Set())
  const pendingPhotos = useRef(new Set<string>())
  const photoPending = useCallback((id: string, pending: boolean) => {
    if (!alive.current) return
    if (pendingPhotos.current.has(id) === pending) return
    if (pending) pendingPhotos.current.add(id); else pendingPhotos.current.delete(id)
    setPhotosPending(new Set(pendingPhotos.current))
  }, [])
  useEffect(() => { alive.current = true; return () => { alive.current = false; operation.current = null } }, [])
  const seed: InvitationDesign = current && current.data.version !== '0' ? current.data.draft : { schemaVersion: 1, content: [{ type: 'Text', props: { id: 'greeting', heading: t('Ждём вас!'), body: legacyText } }] }
  const shown = draft ?? seed
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(current?.data.draft)
  async function write(publish: boolean) {
    if (!current?.etag || !canEdit || operation.current || conflict || query.refreshing || pendingPhotos.current.size > 0) return
    let access: ReturnType<typeof captureAccess>
    try { access = captureAccess() } catch { return }
    const request = {}, permissionRevision = permission.current.revision, revision = editRevision.current
    const isCurrent = () => alive.current && operation.current === request && access.isCurrent() && permission.current.canEdit && permission.current.revision === permissionRevision
    operation.current = request; setBusy(true); setError('')
    try {
      if (publish && dirty) throw new Error('Save draft first')
      const result = publish ? await publishInvitationDesign(weddingId, current.etag) : await saveInvitationDesign(weddingId, parseInvitationDesign(shown), current.etag)
      if (!isCurrent()) return
      setSnapshot(result)
      if (editRevision.current === revision) { setDraft(null); setEditorRevision(value => value + 1) }
    } catch (error) {
      if (!isCurrent()) return
      if (error instanceof ApiError && error.status === 409) { setConflict(true); setError(t('Приглашение уже изменено — обновите страницу')) }
      else setError(t('Не удалось сохранить приглашение. Проверьте поля и повторите.'))
    } finally { if (operation.current === request) { operation.current = null; if (alive.current) setBusy(false) } }
  }
  return <section className="card mt-5 p-4 space-y-4">
    <h2 className="font-serif-d text-xl">{t('Конструктор приглашения')}</h2>
    <p className="text-[12px] text-[var(--soft)]">{t('Сначала сохрани черновик, затем опубликуй. Гости увидят только опубликованную версию.')}</p>
    <AsyncState q={query} />
    {ready(query) && current && <>
      <p className="text-[12px]">{current.data.published ? t('Приглашение опубликовано') : t('Гостям пока видно прежнее оформление')}</p>
      {canEdit && <button type="button" disabled={busy} className="press card-s px-4 py-3" onClick={() => setOpen(value => !value)}>{open ? t('Закрыть редактор') : t('Открыть редактор')}</button>}
      {open && canEdit && <Suspense fallback={<p>{t('Загружаем…')}</p>}><Editor key={`${editorRevision}:${canEdit}`} design={shown} disabled={busy || conflict || query.refreshing} onPhotoPending={photoPending} onChange={value => { editRevision.current++; setDraft(value); setError('') }} /></Suspense>}
      {open && canEdit && <div className="flex flex-wrap gap-3">
        <button type="button" disabled={busy || conflict || query.refreshing || !current.etag || photosPending.size > 0} className="press card-s px-4 py-3 disabled:opacity-50" onClick={() => void write(false)}>{busy ? t('Сохраняем…') : t('Сохранить черновик')}</button>
        <button type="button" disabled={busy || conflict || dirty || !current.etag || !current.data.draft.content.length || query.refreshing || photosPending.size > 0} className="press grad text-[var(--on-grad)] rounded-full px-4 py-3 disabled:opacity-50" onClick={() => void write(true)}>{t('Опубликовать приглашение')}</button>
      </div>}
      {error && <p role="alert" className="text-[var(--rose-ink)] text-[12px]">{error}</p>}
      {conflict && <><p className="text-[12px]">{t('Твой черновик сохранён на экране. Обновление покажет серверную версию; заново перенеси нужные изменения.')}</p><button type="button" className="press card-s px-4 py-3" onClick={() => { if (!window.confirm(t('Заменить черновик на экране серверной версией?'))) return; setSnapshot(null); setDraft(null); setConflict(false); setError(''); setEditorRevision(value => value + 1); query.reload() }}>{t('Обновить')}</button></>}
      <h3 className="text-sm font-semibold">{t('Опубликованная версия')}</h3>
      {current.data.published ? <InvitationBlocks design={current.data.published} /> : <p className="text-[12px] text-[var(--soft)]">{t('Пока пусто')}</p>}
    </>}
  </section>
}
