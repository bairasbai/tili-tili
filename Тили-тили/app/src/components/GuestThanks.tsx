import { useId, useRef, useState } from 'react'
import { AsyncState, ready } from '@/components/AsyncState'
import { ApiError } from '@/lib/api/client'
import { confirmGuestThanks, getThanksRecipients, previewGuestThanks, type ThanksPreview, type ThanksReceipt } from '@/lib/api/thanks'
import { explainError, useApi } from '@/lib/api/useApi'
import { t } from '@/lib/i18n'
import { useLegacyActionScope, useLegacySessionKey } from '@/lib/useLegacyActionScope'

const primary = 'press grad rounded-full px-4 py-2 font-semibold text-[var(--on-grad)] disabled:opacity-50'
const recipientText = (recipient: ThanksPreview['recipients'][number]) => {
  const names = recipient.guestNames.join(', ')
  return names === recipient.label ? names : recipient.label + ' · ' + names
}

export function GuestThanks({ weddingId }: { weddingId: string }) {
  const key = useLegacySessionKey(weddingId)
  return <GuestThanksDisclosure key={key} weddingId={weddingId} />
}

function GuestThanksDisclosure({ weddingId }: { weddingId: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return <section className="card-s p-4 mt-4 text-sm">
    <button type="button" className="press w-full text-left font-semibold" aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(value => !value)}>{t('Поблагодарить гостей')}</button>
    <div id={id}>{open && <ThanksForm weddingId={weddingId} />}</div>
  </section>
}

function ThanksForm({ weddingId }: { weddingId: string }) {
  const capture = useLegacyActionScope('guest-thanks', weddingId)
  const q = useApi(() => getThanksRecipients(weddingId, capture()), [weddingId, capture])
  const [selection, setSelection] = useState<string[]>([])
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<ThanksPreview | null>(null)
  const [receipt, setReceipt] = useState<ThanksReceipt | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const recipients = q.data?.recipients ?? []
  const selected = selection.filter(id => recipients.some(recipient => recipient.partyId === id))
  const disabled = busy || q.refreshing

  async function run(action: (scope: ReturnType<typeof capture>) => Promise<void>) {
    if (disabled || pending.current) return
    const scope = capture()
    if (!scope.isCurrent()) return
    pending.current = true
    setBusy(true)
    setError(null)
    try { await action(scope) }
    catch (reason) {
      if (!scope.isCurrent()) return
      setError(explainError(reason))
      if (reason instanceof ApiError && [401, 403, 404, 409].includes(reason.status)) {
        setPreview(null)
        q.reload()
      }
    } finally {
      pending.current = false
      if (scope.isCurrent()) setBusy(false)
    }
  }

  return <div className="mt-3 space-y-3">
    <AsyncState q={q} />
    {receipt && <p role="status">{t('Благодарность размещена')} · {t('Приглашений')}: {receipt.recipientCount}</p>}
    {ready(q) && q.data && (preview ? (
      <div className="space-y-3">
        <h3 className="font-semibold">{t('Проверьте текст и приглашения')}</h3>
        <p className="break-words whitespace-pre-wrap">{preview.text}</p>
        <ul className="list-disc pl-5">
          {preview.recipients.map(recipient => <li key={recipient.partyId}>{recipientText(recipient)}</li>)}
        </ul>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={primary} disabled={disabled} onClick={() => void run(async scope => {
            const result = await confirmGuestThanks(weddingId, { text: preview.text,
              partyIds: preview.recipients.map(recipient => recipient.partyId), previewToken: preview.previewToken }, scope)
            scope.assertCurrent()
            setReceipt(result); setPreview(null); setText(''); setSelection([])
          })}>{t('Подтвердить и разместить')}</button>
          <button type="button" className="press card-s px-3 py-2" disabled={disabled}
            onClick={() => setPreview(null)}>{t('Изменить текст или получателей')}</button>
        </div>
      </div>
    ) : recipients.length === 0 ? <p>{t('Приглашений для благодарности пока нет')}</p> : (
      <form className="space-y-3" onSubmit={event => {
        event.preventDefault()
        if (!text.trim() || !selected.length) return
        void run(async scope => {
          const result = await previewGuestThanks(weddingId, { text, partyIds: selected }, scope)
          scope.assertCurrent()
          setPreview(result)
        })
      }}>
        <fieldset disabled={disabled} className="space-y-2">
          <legend className="font-semibold">{t('Выберите приглашения')}</legend>
          <div className="max-h-56 overflow-y-auto">
            {recipients.map(recipient => (
              <label key={recipient.partyId} className="flex items-start gap-2 py-1.5">
                <input type="checkbox" className="mt-1" checked={selected.includes(recipient.partyId)}
                  disabled={selected.length >= 500 && !selected.includes(recipient.partyId)}
                  onChange={event => {
                    const checked = event.target.checked
                    setSelection(checked ? [...selected, recipient.partyId] : selected.filter(id => id !== recipient.partyId))
                  }} />
                <span>{recipientText(recipient)}</span>
              </label>
            ))}
          </div>
          <label className="block font-semibold">{t('Текст благодарности')}
            <textarea value={text} onChange={event => setText(event.target.value)} required maxLength={2000}
              className="block w-full rounded-xl border border-[var(--line)] p-2 font-normal" rows={4} />
          </label>
        </fieldset>
        <button type="submit" className={primary} disabled={disabled || !selected.length || !text.trim()}>{t('Предпросмотр благодарности')}</button>
      </form>
    ))}
    {error && <p role="alert" className="text-[var(--rose-ink)]">{error}</p>}
  </div>
}
