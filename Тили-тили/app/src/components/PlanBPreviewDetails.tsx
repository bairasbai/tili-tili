import { useId, useRef, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import type { PlanBPreview } from '@/lib/api/weddingWrite'
import { t } from '@/lib/i18n'
import { copyText } from '@/lib/utils'
import type { components } from '@/lib/api/schema'

type Props = {
  preview: PlanBPreview
  selection: string[] | null
  urgent: boolean
  disabled: boolean
  updateSelection: (ids: string[]) => void
  updateUrgent: (urgent: boolean) => void
}

export function PlanBPushStatus({ channel, className }: {
  channel: components['schemas']['PlanBPushChannel'] | undefined
  className?: string
}) {
  if (!channel || channel === 'configured') return null
  return <p role="status" className={className}>{t(channel === 'invalid_configuration'
    ? 'Настройки Web Push требуют исправления. Уведомления доступны в приложении.'
    : 'Web Push не подключён. Уведомления доступны в приложении.')}</p>
}

export function PlanBPreviewDetails({ preview, selection, urgent, disabled, updateSelection, updateUrgent }: Props) {
  const { planDetails, reserveAddress, manualGuests, inAppRecipients, alreadyActive, urgentEvent, guestPublication } = preview
  const urgencyLabel = useId(), urgencyHint = useId()
  const selected = new Set(selection)
  const messageAddress = alreadyActive ? reserveAddress : guestPublication?.publishedAddress ?? null
  return (
    <>
      <p>{reserveAddress ?? t('Резервный адрес не указан')}</p>
      {planDetails && (
        <div className="space-y-1 break-words">
          <p><b>{t('Причина')}</b> · {planDetails.reason}</p>
          <p><b>{t('Когда включать')}</b> · {planDetails.triggerCondition}</p>
          <p className="font-semibold">{t('Действия')}</p>
          <ul className="list-disc space-y-1 pl-4">
            {planDetails.actions.map(({ title, responsibleName }, index) => (
              <li key={index}>{title} · {responsibleName ?? t('Ответственный не указан')}</li>
            ))}
          </ul>
        </div>
      )}
      {!alreadyActive && (
        <fieldset disabled={disabled} className="min-w-0 space-y-1">
          <legend className="font-semibold">{t('Получат уведомление в приложении')} · {selection?.length ?? inAppRecipients.length}</legend>
          {(selection?.length ?? inAppRecipients.length) > 0 && <PlanBPushStatus channel={preview.pushChannel} />}
          {selection !== null && inAppRecipients.length > 0 && (
            <button type="button" className="press min-h-8 font-semibold underline"
              onClick={() => updateSelection(selection.length === inAppRecipients.length ? [] : inAppRecipients.flatMap(row => row.id ?? []))}>
              {t(selection.length === inAppRecipients.length ? 'Снять выбор' : 'Выбрать всех')}
            </button>
          )}
          <ul className="max-h-40 overflow-auto">
            {inAppRecipients.map(({ id, name, kind }, index) => {
              const label = `${name ?? t('Имя не указано')} · ${t(kind === 'team' ? 'Команда' : 'Подрядчик')}`
              return <li key={id ?? index}>{id && selection !== null
                ? <label className="flex min-h-9 items-center gap-2">
                  <Checkbox aria-label={label} checked={selected.has(id)} disabled={disabled} onCheckedChange={checked => {
                    updateSelection(checked === true ? [...selection, id] : selection.filter(value => value !== id))
                  }} />
                  <span>{label}</span>
                </label>
                : label}</li>
            })}
          </ul>
          {urgentEvent && inAppRecipients.length > 0 && (
            <div className="space-y-1 border-t border-[var(--line)] pt-1">
              <label className="flex min-h-9 items-center gap-2">
                <Checkbox checked={urgent} disabled={disabled || selection?.length === 0}
                  aria-labelledby={urgencyLabel} aria-describedby={urgencyHint}
                  onCheckedChange={checked => updateUrgent(checked === true)} />
                <span id={urgencyLabel}>{t('Срочное уведомление')} · {urgentEvent.name} · {urgentEvent.date}</span>
              </label>
              <p id={urgencyHint}>{t('Тихие часы пропускаются только для получателей, которые разрешили срочные уведомления.')}</p>
            </div>
          )}
        </fieldset>
      )}
      {(!alreadyActive || manualGuests.length > 0) && (
        <div>
          <p className="font-semibold">{t('Гости для ручного оповещения')} · {manualGuests.length}</p>
          {manualGuests.length > 0 && <p>{t('Автоматическое оповещение гостей недоступно.')}</p>}
          <ul className="max-h-40 overflow-auto">{manualGuests.map((name, index) => <li key={index}>{name}</li>)}</ul>
          {manualGuests.length > 0 && (alreadyActive || guestPublication) && (
            <GuestMessage key={messageAddress} address={messageAddress} isPreviousVersion={!alreadyActive} />
          )}
        </div>
      )}
    </>
  )
}

function GuestMessage({ address, isPreviousVersion }: { address: string | null; isPreviousVersion: boolean }) {
  const field = useId()
  const textArea = useRef<HTMLTextAreaElement>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'manual'>('idle')
  const message = address
    ? t('План Б включён. Новая точка сбора: {address}').replace('{address}', () => address)
    : t('План Б включён. Уточните детали у организаторов.')
  async function copyMessage() {
    setCopyState('copying')
    const copied = await copyText(message)
    const input = textArea.current
    if (!input) return
    if (!copied) {
      input.focus()
      input.select()
    }
    setCopyState(copied ? 'copied' : 'manual')
  }
  return (
    <div className="mt-2 space-y-1">
      <label htmlFor={field} className="font-semibold">
        {t(isPreviousVersion ? 'Текст для гостей по действующему Плану Б' : 'Текст для гостей')}
      </label>
      <Textarea id={field} ref={textArea} readOnly value={message} className="text-sm" />
      <button type="button" disabled={copyState === 'copying'} onClick={() => void copyMessage()} className="press min-h-9 font-semibold underline">
        {t('Скопировать текст для гостей')}
      </button>
      <p role="status">{copyState === 'copied' ? t('Скопировано')
        : copyState === 'manual' ? t('Буфер обмена недоступен. Скопируйте выделенный текст вручную.') : null}</p>
    </div>
  )
}
