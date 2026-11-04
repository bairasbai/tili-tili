import { Puck, type Config, type Data } from '@puckeditor/core'
import '@puckeditor/core/no-external.css'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import '@/lib/invitationEditor.css'
import { t, getI18nLang } from '@/lib/i18n'
import { invitationPhoto, type InvitationDesign } from '@/lib/invitationDesign'
import { invitationPuckRu } from '@/lib/invitationPuckRu'
import { InvitationBlock } from './InvitationBlocks'

type Block = InvitationDesign['content'][number]
type Props = { [K in Block['type']]: Omit<Extract<Block, { type: K }>['props'], 'id'> }
function PhotoField({ value, onChange, disabled, onPending }: { value: string; onChange: (value: string) => void; disabled: boolean; onPending: (id: string, pending: boolean) => void }) {
  const [error, setError] = useState(false), [busy, setBusy] = useState(false)
  const id = useId(), notify = useRef(onPending); notify.current = onPending
  const active = useRef({ mounted: true, disabled, sequence: 0, pending: new Set<string>() })
  if (active.current.disabled !== disabled) { active.current.disabled = disabled; active.current.sequence++ }
  useEffect(() => { const reader = active.current; reader.mounted = true; return () => { reader.mounted = false; reader.sequence++; for (const key of reader.pending) notify.current(key, false); reader.pending.clear() } }, [])
  useEffect(() => { setBusy(false) }, [disabled])
  async function load(file?: File) {
    if (!file || disabled) return
    const sequence = ++active.current.sequence
    const pendingId = `${id}:${sequence}`; active.current.pending.add(pendingId); notify.current(pendingId, true)
    setBusy(true); setError(false)
    const current = () => active.current.mounted && !active.current.disabled && active.current.sequence === sequence
    try { const image = await invitationPhoto(file); if (current()) onChange(image) }
    catch { if (current()) setError(true) }
    finally { active.current.pending.delete(pendingId); notify.current(pendingId, false); if (active.current.mounted && active.current.sequence === sequence) setBusy(false) }
  }
  return <div className="space-y-2"><label className="block text-sm">{t('Выбрать фото')}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled || busy} onChange={event => void load(event.target.files?.[0])} className="mt-2 block w-full" /></label>
    {busy && <p role="status">{t('Готовим фото…')}</p>}{value && <img src={value} alt="" className="max-h-32 max-w-full" />}
    {error && <p role="alert">{t('Фото не подходит. Выбери PNG, JPEG или WebP поменьше.')}</p>}
  </div>
}
export default function InvitationPuckEditor({ design, onChange, disabled, onPhotoPending }: { design: InvitationDesign; onChange: (value: InvitationDesign) => void; disabled: boolean; onPhotoPending: (id: string, pending: boolean) => void }) {
  const language = getI18nLang()
  // Pending-photo updates rerender the parent. Stable field renderers keep its
  // in-flight raster decode mounted instead of silently discarding the result.
  const { config, dictionary } = useMemo<{ config: Config<Props>; dictionary: Record<string, string> }>(() => ({ config: { root: { fields: {}, render: ({ children }) => <div className="p-4 space-y-5 bg-[var(--bg)] text-[var(--ink)]">{children}</div> }, components: {
    Text: { label: t('Текст'), fields: { heading: { type: 'text', label: t('Заголовок') }, body: { type: 'textarea', label: t('Текст') } }, defaultProps: { heading: t('Ждём вас!'), body: '' }, render: ({ heading, body }) => <InvitationBlock block={{ type: 'Text', props: { id: 'preview', heading, body } }} /> },
    Photo: { label: t('Фото'), fields: { image: { type: 'custom', label: t('Фото'), render: ({ value, onChange, readOnly }) => <PhotoField value={value} onChange={onChange} onPending={onPhotoPending} disabled={disabled || !!readOnly} /> }, caption: { type: 'textarea', label: t('Подпись к фото') } }, defaultProps: { image: '', caption: '' }, render: ({ image, caption }) => <InvitationBlock block={{ type: 'Photo', props: { id: 'preview', image, caption } }} /> },
    Program: { label: t('Программа свадьбы'), fields: { items: { type: 'array', label: t('События'), max: 24, defaultItemProps: { time: '14:00', label: '' }, getItemSummary: item => `${item.time} ${item.label}`, arrayFields: { time: { type: 'text', label: t('Начало') }, label: { type: 'text', label: t('Название') } } } }, defaultProps: { items: [{ time: '14:00', label: t('Церемония') }] }, render: ({ items }) => <InvitationBlock block={{ type: 'Program', props: { id: 'preview', items } }} /> },
    Place: { label: t('Место'), fields: { name: { type: 'text', label: t('Название') }, address: { type: 'textarea', label: t('Адрес') } }, defaultProps: { name: '', address: '' }, render: ({ name, address }) => <InvitationBlock block={{ type: 'Place', props: { id: 'preview', name, address } }} /> },
  } }, dictionary: language === 'ru' ? invitationPuckRu : { 'header-publish': 'Save draft' } }), [disabled, onPhotoPending, language])
  const data = useMemo<Data<Props>>(() => ({ root: {}, content: design.content }), [design.content])
  return <div className="invitation-editor max-w-full overflow-hidden rounded-2xl border border-[var(--line)]">
    <Puck config={config} data={data} height={640} iframe={{ enabled: false }} dictionary={dictionary}
      permissions={{ edit: !disabled, drag: !disabled, insert: !disabled, duplicate: !disabled, delete: !disabled }}
      onChange={value => { if (!disabled) onChange({ schemaVersion: 1, content: value.content }) }}
      overrides={{ header: () => <p className="p-3 text-sm bg-[var(--card)] text-[var(--ink)]">{t('Перетаскивай блоки и меняй текст. Сохранение — под редактором.')}</p> }}
      viewports={[{ width: 375, height: 'auto', label: t('Телефон') }]} />
  </div>
}
