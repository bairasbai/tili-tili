import { useId } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import type { PlanBPreview } from '@/lib/api/weddingWrite'
import { t } from '@/lib/i18n'
import { copyText } from '@/lib/utils'

type Props = {
  preview: PlanBPreview
  selection: string[] | null
  disabled: boolean
  updateSelection: (ids: string[]) => void
}

export function PlanBPreviewDetails({ preview, selection, disabled, updateSelection }: Props) {
  const { planDetails, reserveAddress, manualGuests, inAppRecipients, alreadyActive } = preview
  const selected = new Set(selection)
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
        </fieldset>
      )}
      {(!alreadyActive || manualGuests.length > 0) && (
        <div>
          <p className="font-semibold">{t('Гости для ручного оповещения')} · {manualGuests.length}</p>
          {manualGuests.length > 0 && <p>{t('Автоматическое оповещение гостей недоступно.')}</p>}
          <ul className="max-h-40 overflow-auto">{manualGuests.map((name, index) => <li key={index}>{name}</li>)}</ul>
          {alreadyActive && <GuestMessage address={reserveAddress} />}
        </div>
      )}
    </>
  )
}

function GuestMessage({ address }: { address: string | null }) {
  const field = useId()
  const message = address
    ? t('План Б включён. Новая точка сбора: {address}').replace('{address}', () => address)
    : t('План Б включён. Уточните детали у организаторов.')
  return (
    <div className="mt-2 space-y-1">
      <label htmlFor={field} className="font-semibold">{t('Текст для гостей')}</label>
      <Textarea id={field} readOnly value={message} className="text-sm" />
      <button type="button" onClick={() => copyText(message)} className="press min-h-9 font-semibold underline">
        {t('Скопировать текст для гостей')}
      </button>
    </div>
  )
}
