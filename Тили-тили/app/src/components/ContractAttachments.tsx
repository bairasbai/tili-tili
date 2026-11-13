import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { AsyncState, ready } from '@/components/AsyncState'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { ApiError, newIdempotencyKey } from '@/lib/api/client'
import { checkContractAttachment, downloadContractAttachment, getContractVersions, recordContractAgreement, removeContractAttachment, uploadContractAttachment } from '@/lib/api/contractAttachments'
import type { MediaActionOptions, MediaProgress, MediaUpload } from '@/lib/api/media'
import { explainError, useApi } from '@/lib/api/useApi'
import { getI18nLang, t } from '@/lib/i18n'
import { useLegacyActionScope, useLegacySessionKey } from '@/lib/useLegacyActionScope'
import { formatWeddingDate } from '@/lib/weddingDate'

const actionClass = 'press min-h-11 px-3 rounded-lg border border-[var(--line)] text-[12px] disabled:opacity-50'

export function ContractAttachments({ dealId, documentId, weddingId, initiallyOpen = false }: {
  dealId: string; documentId?: string; weddingId?: string; initiallyOpen?: boolean
}) {
  const scope = useLegacySessionKey(JSON.stringify([dealId, documentId, weddingId]))
  return <AttachmentDetails key={JSON.stringify([scope, initiallyOpen])} scope={scope} dealId={dealId} documentId={documentId}
    weddingId={weddingId} initiallyOpen={initiallyOpen} />
}

function AttachmentDetails({ initiallyOpen, ...props }: { scope: string; dealId: string; documentId?: string; weddingId?: string; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer py-2.5 text-[12px] font-semibold">{t('Редакции и согласование')}</summary>
    {open && <AttachmentList {...props} />}
  </details>
}

function AttachmentList({ scope, dealId, documentId, weddingId }: { scope: string; dealId: string; documentId?: string; weddingId?: string }) {
  const origin = useLegacyActionScope(scope, weddingId)
  const q = useApi(async () => getContractVersions(dealId, { assertCurrent: origin().assertCurrent }), [dealId, origin])
  const operation = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<MediaProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => () => operation.current?.abort(), [])

  async function run(action: (options: MediaActionOptions) => Promise<void>, refresh = true) {
    if (operation.current) return
    const session = origin(), controller = new AbortController()
    const assertCurrent = () => {
      session.assertCurrent()
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    }
    operation.current = controller
    try {
      assertCurrent(); setBusy(true); setError(null)
      await action({ assertCurrent, signal: controller.signal })
      assertCurrent()
    } catch (err) {
      if (session.isCurrent() && !controller.signal.aborted) setError(explainError(err))
    } finally {
      if (session.isCurrent() && !controller.signal.aborted) {
        if (refresh) q.reload()
        setBusy(false); setProgress(null)
      }
      operation.current = null
    }
  }

  function assertReady(result: MediaUpload) {
    if (result.state !== 'ready') throw new ApiError('http', 409, 'media_processing_pending', 'Проверка ещё не завершена — перечитайте состояние')
  }

  const versions = q.data?.versions.filter(version => !documentId || version.id === documentId) ?? []
  const disabled = busy || q.refreshing
  const locale = getI18nLang() === 'en' ? 'en-GB' : 'ru-RU'

  return <div className="space-y-2 pb-1">
    <AsyncState q={q} />
    {ready(q) && q.data && <>
      {q.data.archived && <p className="text-[11px] text-[var(--soft)]">{t('Договор в архиве доступен только для просмотра')}</p>}
      {versions.length > 0 && !q.data.archived && <Link to={{ pathname: `${documentId ? '/deal' : '/vendor-app/deals'}/${encodeURIComponent(dealId)}/terms`,
        search: documentId ? '?' + new URLSearchParams({ document: documentId }).toString() : '' }}
        className="press inline-flex min-h-11 items-center text-[12px] font-semibold underline">{t('История условий сделки')}</Link>}
      {versions.length > 0 && <p className="text-[11px] text-[var(--soft)]">{t('Прикреплённый PDF доступен сторонам сделки. Электронная подпись и юридическая проверка в сервисе отсутствуют.')}</p>}
      {versions.length === 0 && <p className="text-[11px] text-[var(--soft)]">{t('Редакций договора пока нет')}</p>}
      {versions.map(version => {
        const target = { dealId, documentId: version.id }
        const attachment = version.attachment
        const agreement = version.agreement
        const terms = agreement?.terms
        const proposed = Boolean(agreement?.proposedAt)
        const agreementAction = agreement?.canPropose ? 'propose' : agreement?.canAgree ? 'agree' : null
        const agreementLabel = agreementAction === 'propose' ? 'Предложить редакцию' : 'Согласовать редакцию'
        const uploadId = attachment?.uploadId ?? version.pendingUploadId
        return <div key={version.id} className="space-y-1 border-t border-[var(--line)] pt-2">
          <p className="text-[12px] font-semibold">{t('Редакция')} {version.version}</p>
          {agreement && <>
            <p className="text-[11px] text-[var(--soft)]">{proposed
              ? `${t('Редакцию предложила пара')} · ${new Date(agreement.proposedAt!).toLocaleString(locale)}`
              : t('Редакция ещё не предложена')}</p>
            {terms && <dl className="space-y-1 text-[11px]">
              {terms.customerName && <div><dt className="inline">{t('Заказчик:')}</dt> <dd className="inline">{terms.customerName}</dd></div>}
              {terms.performerName && <div><dt className="inline">{t('Исполнитель:')}</dt> <dd className="inline">{terms.performerName}</dd></div>}
              <div><dt className="inline">{t('Условия договора')}</dt> <dd className="inline">{[terms.city, terms.date && formatWeddingDate(terms.date),
                terms.price && new Intl.NumberFormat(locale, { style: 'currency', currency: terms.price.currency }).format(terms.price.amount / 100)]
                .filter(Boolean).join(' · ') || t('уточняется')}</dd></div>
            </dl>}
            {proposed && <ul className="space-y-1 text-[11px]">
              <li>{t('Пара')} · {agreement.coupleAt ? `${t('Согласовано')} ${new Date(agreement.coupleAt).toLocaleString(locale)}` : t('Ожидается согласование')}</li>
              <li>{t('Подрядчик')} · {agreement.vendorAt ? `${t('Согласовано')} ${new Date(agreement.vendorAt).toLocaleString(locale)}` : t('Ожидается согласование')}</li>
            </ul>}
            {agreementAction && <AlertDialog>
              <AlertDialogTrigger asChild><button type="button" className={actionClass} disabled={disabled}>{t(agreementLabel)}</button></AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogTitle>{t(agreementLabel)} · {version.version}</AlertDialogTitle>
                <AlertDialogDescription>{t('Действие относится к этой редакции и её вложению. Согласие фиксируется в приложении. Электронная подпись оформляется отдельно.')}</AlertDialogDescription>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('Назад')}</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void run(async options => {
                    await recordContractAgreement(target, agreementAction, attachment?.uploadId ?? null, options)
                  })}>{t(agreementLabel)}</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>}
          </>}
          {attachment && <>
            <p className="text-[11px] text-[var(--soft)]">
              {attachment.authorName || t(attachment.authorSide === 'couple' ? 'Пара' : 'Подрядчик')} · {new Date(attachment.attachedAt).toLocaleString(locale)}
            </p>
            <button type="button" className={actionClass} disabled={disabled} onClick={() => void run(async options => {
              const blob = await downloadContractAttachment({ ...target, uploadId: attachment.uploadId }, options)
              options.assertCurrent()
              const href = URL.createObjectURL(blob)
              const link = document.createElement('a'); link.href = href; link.download = 'contract.pdf'
              document.body.appendChild(link)
              try { link.click() } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(href), 1000) }
            }, false)}>{t('Скачать PDF')}</button>
          </>}
          {version.pendingUploadId && !attachment && <button type="button" className={actionClass} disabled={disabled || !q.data?.uploadEnabled}
            onClick={() => void run(async options => {
              setProgress('scanning')
              assertReady(await checkContractAttachment({ ...target, uploadId: version.pendingUploadId! }, options))
            })}>{t('Повторить проверку')}</button>}
          {uploadId && (attachment?.canRemove || !attachment) && <AlertDialog>
            <AlertDialogTrigger asChild><button type="button" className={actionClass} disabled={disabled}>
              {t(attachment ? 'Убрать вложение' : 'Отменить загрузку')}
            </button></AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogTitle>{t(attachment ? 'Убрать вложение?' : 'Отменить загрузку?')}</AlertDialogTitle>
              <AlertDialogDescription>{t('Доступ к файлу закроется. Удаление из хранилища будет поставлено в очередь.')}</AlertDialogDescription>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('Назад')}</AlertDialogCancel>
                <AlertDialogAction onClick={() => void run(async options => { await removeContractAttachment({ ...target, uploadId }, options) })}>
                  {t(attachment ? 'Убрать вложение' : 'Отменить загрузку')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>}
          {!uploadId && version.uploadInProgress && <p className="text-[11px] text-[var(--soft)]">{t('Другая сторона уже начала загрузку')}</p>}
          {!proposed && !uploadId && !version.uploadInProgress && q.data?.uploadEnabled && <label className={`${actionClass} inline-flex items-center cursor-pointer focus-within:ring-2 focus-within:ring-[var(--rose)]`}>
            {t('Прикрепить PDF до 10 МиБ')}
            <input className="sr-only" type="file" accept="application/pdf,.pdf" disabled={disabled} onChange={event => {
              const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''
              if (!file) return
              void run(async options => {
                assertReady(await uploadContractAttachment(target, file, newIdempotencyKey(), { ...options, onProgress: setProgress }))
              })
            }} />
          </label>}
          {!proposed && !uploadId && !version.uploadInProgress && !q.data?.uploadEnabled && !q.data?.archived && <p className="text-[11px] text-[var(--soft)]">{t('Загрузка файлов пока не подключена')}</p>}
        </div>
      })}
    </>}
    {progress && <p role="status" className="text-[11px]">{t(progress === 'uploading' ? 'Загружаем PDF…' : 'Проверяем PDF…')}</p>}
    {error && <p role="alert" className="text-[11px] text-[var(--rose-ink)]">{error}</p>}
  </div>
}
