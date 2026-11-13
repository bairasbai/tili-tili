import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { AsyncState, ready } from '@/components/AsyncState'
import { ApiError, newIdempotencyKey } from '@/lib/api/client'
import { appendOrderDelivery, getOrderDelivery, type OrderDeliveryWrite } from '@/lib/api/orders'
import { checkDeliveryFile, downloadDeliveryFile, removeDeliveryFile, uploadDeliveryFile } from '@/lib/api/orderDeliveryFiles'
import type { MediaActionOptions, MediaProgress } from '@/lib/api/media'
import { explainError, useApi } from '@/lib/api/useApi'
import { t } from '@/lib/i18n'
import { useLiveAccess } from '@/lib/offlineProgramHooks'
import { useLegacyActionScope, useLegacySessionKey } from '@/lib/useLegacyActionScope'
import { formatWeddingDate } from '@/lib/weddingDate'

const labels = {
  submitted: 'Результат сдан',
  changes_requested: 'Запрошены правки',
  accepted: 'Результат принят',
} as const
const fileAction = 'press card-s px-3 py-2 disabled:opacity-50'

type DeliveryProps = { dealId: string; onChanged?: (() => void) | undefined }

export function OrderDelivery({ dealId, onChanged }: DeliveryProps) {
  const key = useLegacySessionKey(dealId)
  return <OrderDeliveryDisclosure key={key} dealId={dealId} onChanged={onChanged} />
}

function OrderDeliveryDisclosure({ dealId, onChanged }: DeliveryProps) {
  const [open, setOpen] = useState(false)
  const sectionId = useId()
  return (
    <section className="card-s p-4 mt-3">
      <button type="button" className="press w-full text-left font-semibold text-sm" aria-expanded={open}
        aria-controls={sectionId} onClick={() => setOpen(value => !value)}>{t('Материалы по сделке')}</button>
      <div id={sectionId}>{open && <OrderDeliveryDetails dealId={dealId} onChanged={onChanged} />}</div>
    </section>
  )
}

function OrderDeliveryDetails({ dealId, onChanged }: DeliveryProps) {
  const capture = useLegacyActionScope(`order-delivery:${dealId}`)
  const q = useApi(() => getOrderDelivery(dealId, { assertCurrent: capture().assertCurrent }), [dealId, capture])
  const [summary, setSummary] = useState('')
  const [link, setLink] = useState('')
  const [dueOn, setDueOn] = useState('')
  const [comment, setComment] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<MediaProgress | null>(null)
  const operation = useRef<{ controller: AbortController; download: boolean } | null>(null)
  const stopDownload = useCallback(() => {
    if (!operation.current?.download) return
    operation.current.controller.abort()
    operation.current = null
    setBusy(false)
  }, [])
  useEffect(() => {
    window.addEventListener('offline', stopDownload)
    return () => { window.removeEventListener('offline', stopDownload); operation.current?.controller.abort() }
  }, [stopDownload])
  const recheck = useCallback(() => {
    stopDownload()
    if (navigator.onLine) q.reload()
  }, [q.reload, stopDownload])
  const online = useLiveAccess(recheck)
  const intent = useRef<{ payload: string; key: string } | null>(null)
  const delivery = online && ready(q) && !q.refreshing ? q.data : null
  const head = delivery?.steps[0]
  const disabled = busy || delivery === null

  async function run(action: (options: MediaActionOptions) => Promise<void>, mode?: 'refresh' | 'download') {
    if (!navigator.onLine || disabled || operation.current) return
    const session = capture(), controller = new AbortController()
    const assertCurrent = () => { session.assertCurrent(); controller.signal.throwIfAborted() }
    const current = () => session.isCurrent() && !controller.signal.aborted
    if (!current()) return
    operation.current = { controller, download: mode === 'download' }
    setBusy(true)
    setError(null)
    try {
      await action({ assertCurrent, signal: controller.signal })
    } catch (reason) {
      if (!current()) return
      setError(explainError(reason))
      if (mode !== 'refresh' && reason instanceof ApiError && [403, 404, 409, 410].includes(reason.status)) q.reload()
    } finally {
      if (operation.current?.controller === controller) operation.current = null
      if (current()) {
        if (mode === 'refresh') q.reload()
        setBusy(false)
        setProgress(null)
      }
    }
  }

  function send(body: OrderDeliveryWrite) {
    if (!delivery?.available) return
    void run(async options => {
      const payload = JSON.stringify(body)
      if (intent.current?.payload !== payload) intent.current = { payload, key: newIdempotencyKey() }
      await appendOrderDelivery(dealId, body, intent.current.key, options)
      options.assertCurrent()
      intent.current = null
      if (body.kind === 'submitted') { setSummary(''); setLink(''); setDueOn('') }
      if (body.kind === 'changes_requested') setComment('')
      q.reload()
      onChanged?.()
    })
  }

  const readyFileIds = delivery?.drafts.filter(file => file.state === 'ready').map(file => file.uploadId) ?? []
  const unchecked = (delivery?.drafts.length ?? 0) > readyFileIds.length

  return (
    <div className="mt-3 space-y-3 text-sm">
      {online ? <AsyncState q={q} forbiddenText={q.forbiddenText} />
        : <p role="status">{t('Нет связи с сервером')}</p>}
      {online && q.refreshing && <p role="status">{t('Обновляем…')}</p>}
      {delivery && <>
        {delivery.steps.length === 0 && <p>{t('Результат ещё не сдан.')}</p>}
        {delivery.steps.length > 0 && <ol className="space-y-2">
          {delivery.steps.map(step => <li key={step.revision} className="rounded-xl border border-[var(--line)] p-3">
            <p className="font-semibold">{t(labels[step.kind])}</p>
            {step.summary && <p className="break-words whitespace-pre-wrap">{step.summary}</p>}
            {step.dueOn && <p>{t('Срок сдачи')} · {formatWeddingDate(step.dueOn)}</p>}
            {step.materialUrl && <a className="underline" href={step.materialUrl} target="_blank" rel="noreferrer noopener">
              {t('Открыть материалы')}</a>}
            {step.files.length > 0 && <ul className="mt-2 flex flex-wrap gap-2">
              {step.files.map((file, index) => <li key={file.uploadId}>
                <button type="button" className={fileAction} disabled={disabled}
                  onClick={() => void run(async options => {
                    const blob = await downloadDeliveryFile({ dealId, uploadId: file.uploadId }, options)
                    options.assertCurrent()
                    const href = URL.createObjectURL(blob)
                    const anchor = document.createElement('a')
                    anchor.href = href
                    anchor.download = `material-${index + 1}.${file.contentType === 'application/pdf' ? 'pdf' : 'webp'}`
                    document.body.appendChild(anchor)
                    try { anchor.click() } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(href), 1000) }
                  }, 'download')}>{t('Скачать файл')} {index + 1} · {file.contentType === 'application/pdf' ? 'PDF' : 'WebP'}</button>
              </li>)}
            </ul>}
            {step.comment && <p className="break-words whitespace-pre-wrap">{step.comment}</p>}
            <time className="block text-xs text-[var(--soft)]" dateTime={step.createdAt}>{formatWeddingDate(step.createdAt.slice(0, 10))}</time>
          </li>)}
        </ol>}
        {delivery.available && delivery.actorRole === 'vendor' && (!head || head.kind === 'changes_requested') && (
          <form className="space-y-2" onSubmit={event => {
            event.preventDefault()
            if (!unchecked) send({ kind: 'submitted', expectedRevision: delivery.revision, summary,
              ...(link.trim() ? { materialUrl: link.trim() } : {}), dueOn, fileIds: readyFileIds })
          }}>
            <fieldset disabled={disabled} className="space-y-2">
              <label className="block">{t('Описание результата')}
                <textarea className="block w-full rounded-xl border p-2" required maxLength={1000} value={summary} onChange={event => setSummary(event.target.value)} />
              </label>
              <label className="block">{t('Ссылка на материалы')}
                <input className="block w-full rounded-xl border p-2" type="url" required={readyFileIds.length === 0}
                  maxLength={2048} value={link} onChange={event => setLink(event.target.value)} />
              </label>
              <label className="block">{t('Срок сдачи')}
                <input className="block w-full rounded-xl border p-2" type="date" required value={dueOn} onChange={event => setDueOn(event.target.value)} />
              </label>
              {delivery.drafts.length > 0 && <ul className="space-y-2">
                {delivery.drafts.map((file, index) => <li className="flex flex-wrap items-center gap-2" key={file.uploadId}>
                  <span>{file.contentType === 'application/pdf' ? 'PDF' : t('Изображение')} {index + 1} · {t(file.state === 'ready'
                    ? 'Файл проверен' : file.state === 'failed' ? 'Файл не прошёл проверку' : 'Файл ожидает проверки')}</span>
                  {file.retryable && <button type="button" className={fileAction} disabled={!delivery.uploadEnabled}
                    onClick={() => void run(async options => {
                      setProgress('scanning')
                      await checkDeliveryFile({ dealId, uploadId: file.uploadId }, options)
                    }, 'refresh')}>{t('Повторить проверку')}</button>}
                  <button type="button" className={fileAction} onClick={() => void run(async options => {
                    await removeDeliveryFile({ dealId, uploadId: file.uploadId }, options)
                  }, 'refresh')}>{t('Убрать файл из черновика')}</button>
                </li>)}
              </ul>}
              {readyFileIds.length > 0 && <p className="text-xs text-[var(--soft)]">{t('Проверенные файлы хранятся в черновике 24 часа.')}</p>}
              {delivery.uploadEnabled && delivery.drafts.length < 5 && <label className="block">
                {t('Добавить PDF или изображение до 10 МиБ')}
                <input className="block w-full" type="file" accept="application/pdf,.pdf,image/jpeg,image/png,image/webp"
                  onChange={event => {
                    const file = event.currentTarget.files?.[0]
                    event.currentTarget.value = ''
                    if (file) void run(options => uploadDeliveryFile(dealId, delivery.revision + 1, file,
                      newIdempotencyKey(), { ...options, onProgress: setProgress }), 'refresh')
                  }} />
              </label>}
              {!delivery.uploadEnabled && <p>{t('Загрузка файлов пока не подключена')}</p>}
              <button className="press grad px-4 py-2 rounded-full text-[var(--on-grad)] disabled:opacity-50" type="submit"
                disabled={unchecked}>{t('Сдать результат')}</button>
            </fieldset>
          </form>
        )}
        {delivery.available && delivery.actorRole === 'couple' && head?.kind === 'submitted' && (
          <div className="space-y-2">
            <p>{t('Открытие ссылки не означает приёмку.')}</p>
            <button className="press grad px-4 py-2 rounded-full text-[var(--on-grad)]" type="button" disabled={disabled}
              onClick={() => send({ kind: 'accepted', expectedRevision: head.revision })}>{t('Принять результат')}</button>
            <form className="space-y-2" onSubmit={event => {
              event.preventDefault()
              send({ kind: 'changes_requested', expectedRevision: head.revision, comment })
            }}>
              <label className="block">{t('Что нужно исправить')}
                <textarea className="block w-full rounded-xl border p-2" required maxLength={1000} value={comment} disabled={disabled}
                  onChange={event => setComment(event.target.value)} />
              </label>
              <button className="press card-s px-4 py-2" type="submit" disabled={disabled}>{t('Запросить правки')}</button>
            </form>
          </div>
        )}
      </>}
      {delivery && progress && <p role="status">{t(progress === 'uploading' ? 'Загружаем файл…' : 'Проверяем файл…')}</p>}
      {delivery && error && <p role="alert" className="text-[var(--rose-ink)]">{error}</p>}
    </div>
  )
}
