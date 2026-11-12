import { useId } from 'react'
import { t } from '@/lib/i18n'
import { shortWeddingDate } from '@/lib/weddingDate'

interface WeddingOption {
  id?: string
  title?: string
  date?: string | null
}

export function WeddingPicker({ weddings, weddingId, onSelect }: {
  weddings: WeddingOption[]; weddingId: string | null; onSelect: (id: string) => void
}) {
  const labelId = useId()
  const choices = weddings.filter((wedding): wedding is WeddingOption & { id: string } => Boolean(wedding.id))
  const selected = choices.some(wedding => wedding.id === weddingId) ? weddingId : ''
  if (!choices.length || (choices.length === 1 && selected)) return null

  return <label className="block text-sm font-semibold" htmlFor={labelId}>
    {t('Выбранная свадьба')}
    <select id={labelId} aria-label={t('Выбранная свадьба')} value={selected ?? ''} onChange={event => {
      if (choices.some(wedding => wedding.id === event.target.value)) onSelect(event.target.value)
    }} className="block min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--card)] px-3 text-sm">
      {!selected && <option value="" disabled>{t('Выберите свадьбу')}</option>}
      {choices.map(wedding => <option key={wedding.id} value={wedding.id}>
        {[wedding.title || t('Свадьба'), wedding.date ? shortWeddingDate(wedding.date) : null].filter(Boolean).join(' · ')}
      </option>)}
    </select>
  </label>
}
