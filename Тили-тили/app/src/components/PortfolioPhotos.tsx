import { useCallback, useEffect, useRef, useState } from 'react'
import { AsyncState, ready } from './AsyncState'
import { beginLocalSessionAction, onSessionChanged } from '@/lib/api/client'
import { explainError, useApi } from '@/lib/api/useApi'
import { completePortfolioPhoto, getPortfolioPreview, getPortfolioUploads, isManagedPhotoURL, removePortfolioPhoto,
  uploadPortfolioPhoto, type MediaProgress, type MediaUpload } from '@/lib/api/media'
import { t, key } from '@/lib/i18n'

const LABELS: Record<MediaUpload['state'] | MediaProgress, string> = {
  pending: key('Ожидает загрузки'), uploading: key('Загружаем фотографию…'), scanning: key('Проверяем фотографию…'),
  processing: key('Проверяем фотографию…'), ready: key('Фотография готова'), failed: key('Проверка не завершена'),
  deleted: key('Удаление поставлено в очередь'), expired: key('Срок загрузки истёк'),
}

function PrivatePhoto({ id, assertCurrent }: { id: string; assertCurrent: () => void }) {
  const [attempt, setAttempt] = useState(0)
  const [preview, setPreview] = useState<{ id: string; attempt: number; src: string | null; error: string | null } | null>(null)
  useEffect(() => {
    let alive = true, objectURL: string | null = null
    const controller = new AbortController()
    void getPortfolioPreview(id, { assertCurrent, signal: controller.signal }).then(blob => {
      assertCurrent()
      if (!alive) return
      if (blob.type !== 'image/webp' || blob.size > 10 * 1024 * 1024) throw new Error('Unexpected preview')
      objectURL = URL.createObjectURL(blob); setPreview({ id, attempt, src: objectURL, error: null })
    }).catch(error => {
      if (!alive) return
      try { assertCurrent(); setPreview({ id, attempt, src: null, error: explainError(error) }) } catch { /* dead owner */ }
    })
    return () => { alive = false; controller.abort(); if (objectURL) URL.revokeObjectURL(objectURL) }
  }, [id, attempt, assertCurrent])
  if (!preview || preview.id !== id || preview.attempt !== attempt) return <p className="text-[11px]">{t('Загружаем предпросмотр…')}</p>
  if (preview.error) return <div className="text-[11px]">
    <p role="alert">{preview.error}</p>
    <button type="button" onClick={() => {
      try { assertCurrent() } catch { return }
      setAttempt(value => value + 1)
    }} className="press underline">{t('Повторить предпросмотр')}</button>
  </div>
  return preview.src ? <img src={preview.src} alt={t('Фотография портфолио')} className="aspect-square w-full object-cover rounded-[16px]" /> : null
}

export function PortfolioPhotos({ confirmed, confirming, onConfirmRights, legacy }: {
  confirmed: boolean; confirming: boolean; onConfirmRights: () => void; legacy: string[]
}) {
  const origin = useRef<ReturnType<typeof beginLocalSessionAction> | null>(null)
  const operation = useRef<AbortController | null>(null)
  const busyRef = useRef(false)
  const [changed, setChanged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [progress, setProgress] = useState<MediaProgress | null>(null)
  const [selected, setSelected] = useState<{ file: File; key: string; id?: string } | null>(null)
  useEffect(() => {
    const gate = beginLocalSessionAction(); origin.current = gate
    const stop = onSessionChanged(() => {
      operation.current?.abort(); setChanged(true); setSelected(null); setError(null); setNotice(null); setProgress(null); setBusy(false)
    })
    return () => { operation.current?.abort(); gate.close(); origin.current = null; stop() }
  }, [])
  const assertCurrent = useCallback(() => {
    if (!origin.current) throw new Error('Inactive portfolio')
    origin.current.assertCurrent()
  }, [])
  const uploads = useApi(() => confirmed ? getPortfolioUploads({ assertCurrent }) : Promise.resolve(null), [confirmed, assertCurrent])
  const legacyPhotos = legacy.filter(src => !isManagedPhotoURL(src, uploads.data?.items.flatMap(item => item.fileUrl ? [item.fileUrl] : []) ?? []))
  const run = async (action: (options: { assertCurrent: () => void; signal: AbortSignal }) => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    const controller = new AbortController(); operation.current = controller
    try {
      assertCurrent(); setBusy(true); setError(null); setNotice(null)
      await action({ assertCurrent, signal: controller.signal }); assertCurrent(); uploads.reload()
    } catch (e) {
      try { assertCurrent(); if (!controller.signal.aborted) { setError(explainError(e)); uploads.reload() } } catch { /* dead owner */ }
    } finally {
      try { assertCurrent(); setBusy(false); setProgress(null) } catch { /* unmounted/switched */ }
      if (operation.current === controller) operation.current = null
      busyRef.current = false
    }
  }
  const upload = (selection: NonNullable<typeof selected>) => void run(async options => {
    const result = await uploadPortfolioPhoto(selection.file, selection.key, { ...options,
      onProgress: state => { assertCurrent(); setProgress(state) },
      onIntent: id => { assertCurrent(); setSelected(current => current?.key === selection.key ? { ...current, id } : current) } })
    assertCurrent()
    if (result.state !== 'ready') throw new Error('Photo not ready')
    setSelected(null); setNotice(key('Фотография добавлена в портфолио'))
  })
  if (changed) return <p className="card p-4 text-[13px]">{t('Сессия изменилась — откройте анкету заново')}</p>
  return <section className="card p-4 space-y-3" aria-label={t('Фотографии портфолио')}>
    <h3 className="text-[13px] font-semibold">{t('Фотографии портфолио')}</h3>
    <p className="text-[11px] text-[var(--soft)]">{t('До пяти фотографий JPEG, PNG или WebP по 10 МиБ. Проверка и удаление могут занять время.')}</p>
    {!confirmed ? <div className="space-y-2">
      <p className="text-[12px]">{t('Подтверждаю права на фото и видео и согласие снятых людей на публикацию')}</p>
      <button type="button" disabled={confirming} onClick={() => {
        try { assertCurrent() } catch { return }
        onConfirmRights()
      }} className="press rounded-full px-4 py-3 grad text-[var(--on-grad)] text-[12px]">
        {t('Подтвердить права и сохранить анкету')}
      </button>
    </div> : <>
      <AsyncState q={uploads} forbiddenText={uploads.forbiddenText} />
      {ready(uploads) && uploads.data && <>
        {!uploads.data.enabled && <p className="text-[12px] text-[var(--soft)]">{t('Загрузка фотографий пока не подключена')}</p>}
        <label className={`inline-flex rounded-full px-4 py-3 grad text-[var(--on-grad)] text-[12px] focus-within:ring-2 focus-within:ring-[var(--rose)] ${busy || !uploads.data.enabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
          {t('Выбрать фотографию портфолио')}
          <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || !uploads.data.enabled} aria-label={t('Выбрать фотографию портфолио')}
          onChange={event => {
            const file = event.target.files?.[0]; event.target.value = ''
            if (!file || busyRef.current) return
            try { assertCurrent() } catch { return }
            const selection = { file, key: crypto.randomUUID() }; setSelected(selection); upload(selection)
          }} className="sr-only" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          {uploads.data.items.map(item => <div key={item.uploadId} className="rounded-[16px] border border-[var(--line)] p-2 space-y-2">
            {item.state === 'ready' && <PrivatePhoto id={item.uploadId} assertCurrent={assertCurrent} />}
            <p className="text-[11px]" role="status">{t(LABELS[item.state])}</p>
            {item.retryable && item.state !== 'pending' && <button disabled={busy} onClick={() => void run(async options => {
              setProgress('scanning'); const result = await completePortfolioPhoto(item.uploadId, options)
              options.assertCurrent(); if (result.state !== 'ready') setNotice(key('Проверка ещё не завершена — перечитайте состояние'))
            })} className="press text-[11px] underline">{t('Повторить проверку')}</button>}
            <button disabled={busy} onClick={() => void run(async options => {
              await removePortfolioPhoto(item.uploadId, options); options.assertCurrent()
              setNotice(key('Фотография скрыта, физическое удаление поставлено в очередь'))
            })} className="press text-[11px] underline">{t('Удалить фотографию')}</button>
          </div>)}
        </div>
        <button disabled={busy || uploads.refreshing} onClick={() => {
          try { assertCurrent() } catch { return }
          uploads.reload()
        }} className="press text-[12px] underline">{t('Обновить состояния загрузок')}</button>
      </>}
    </>}
    {progress && <p role="status" className="text-[12px]">{t(LABELS[progress])}</p>}
    {error && <p role="alert" className="text-[12px] text-[var(--danger)]">{error}</p>}
    {selected && error && <button disabled={busy} onClick={() => upload(selected)} className="press text-[12px] underline">{t('Повторить ту же загрузку')}</button>}
    {notice && <p role="status" className="text-[12px]">{t(notice)}</p>}
    {legacyPhotos.length > 0 && <div className="grid grid-cols-3 gap-2">
      {legacyPhotos.map(src => <img key={src} src={src} alt={t('Ранее добавленная работа')} className="aspect-square object-cover rounded-[16px]" loading="lazy" />)}
    </div>}
  </section>
}
