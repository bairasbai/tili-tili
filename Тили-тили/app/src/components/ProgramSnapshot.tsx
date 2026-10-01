import { useEffect, useRef, useState } from 'react'
import { Check, RefreshCw } from 'lucide-react'
import { ApiError } from '@/lib/api/client'
import type { VendorProgram, VendorProgramAck } from '@/lib/api/vendor'
import { explainError } from '@/lib/api/useApi'
import { getI18nLang, t } from '@/lib/i18n'

function moment(iso: string | null, zone: string | null): string {
  if (!iso) return t('Время не задано')
  try {
    if (!zone) throw new RangeError('Unknown zone')
    const date = new Date(iso), locale = getI18nLang() === 'en' ? 'en-GB' : 'ru-RU'
    return `${date.toLocaleDateString(locale, { timeZone: zone })} · ${new Intl.DateTimeFormat(locale, { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit', ...(date.getMilliseconds() ? { fractionalSecondDigits: 3 as const } : {}) }).format(date)}`
  } catch { return `${t('Часовой пояс неизвестен')} · ${iso}` }
}

export function ProgramSnapshot({ program, etag, reload, acknowledge, onRefused, offlineSavedAt, reloadDisabled = false }: {
  program: VendorProgram
  etag: string | null
  reload: () => void
  acknowledge: (readToken: string, etag: string) => Promise<VendorProgramAck>
  onRefused?: (error: ApiError) => void
  offlineSavedAt?: string
  reloadDisabled?: boolean
}) {
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [receipt, setReceipt] = useState<VendorProgramAck | null>(null)
  const inFlight = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (offlineSavedAt || !program.expiresAt || program.acknowledgedAt || receipt) return
    const timer = window.setTimeout(() => { setInvalid(true); setError(t('Срок просмотра истёк — откройте программу заново')) }, Math.max(0, Date.parse(program.expiresAt) - Date.now()))
    return () => window.clearTimeout(timer)
  }, [offlineSavedAt, program.expiresAt, program.acknowledgedAt, receipt])
  const ack = async () => {
    if (offlineSavedAt || !checked || inFlight.current || invalid || !program.readToken || etag !== `"${program.sourceVersion}"`) return
    inFlight.current = true; setBusy(true); setError(null)
    try {
      const result = await acknowledge(program.readToken, etag)
      if (!alive.current) return
      if (result.sourceVersion !== program.sourceVersion) { setInvalid(true); setError(t('Версия ответа не совпадает — откройте программу заново')); return }
      setReceipt(result)
    } catch (e) {
      if (!alive.current) return
      const refused = e instanceof ApiError && e.kind === 'http' && e.status >= 400 && e.status < 500
      if (refused) setInvalid(true)
      if (e instanceof ApiError && [401, 403, 404, 410].includes(e.status)) onRefused?.(e)
      setError(e instanceof ApiError && e.status === 409 ? t('Программа изменилась или просмотр истёк — откройте её заново') : explainError(e))
    } finally { inFlight.current = false; if (alive.current) setBusy(false) }
  }
  const acknowledgedAt = receipt?.acknowledgedAt ?? program.acknowledgedAt
  const proofMissing = etag !== `"${program.sourceVersion}"` || !program.readToken || !program.expiresAt
  return <section aria-label={t('Разрешённая программа')} className="break-words">
    {offlineSavedAt && <p role="status" className="text-xs leading-relaxed border-b border-[var(--line)] pb-3 mb-3">{t('Офлайн-копия')} · {new Date(offlineSavedAt).toLocaleString(getI18nLang() === 'en' ? 'en-GB' : 'ru-RU')}. {t('Актуальность и доступ не проверены.')}</p>}
    {error && <p role="alert" className="text-sm text-[var(--rose-ink)] mb-3">{error}</p>}
    {!invalid && <>
      <h1 className="text-lg font-semibold">{program.wedding}</h1>
      <p className="text-xs text-[var(--soft)] mt-1">{t('Версия программы:')} {program.sourceVersion}</p>
      <p className="text-xs text-[var(--soft)] mt-1">{t('Изменено:')} {program.updatedAt ?? t('Неизвестно')}</p>
      {program.blocks.length === 0 && <p className="text-sm mt-4">{t('Назначенных блоков нет')}</p>}
      <ol className="divide-y divide-[var(--line)] mt-3">
        {program.blocks.map(block => <li key={block.id} className="py-4">
          <h2 className="text-sm font-semibold">{block.name}</h2>
          <p className="text-xs text-[var(--soft)] mt-1">{block.event.name} · {block.event.date ?? t('Дата не назначена')} · {block.event.timeZone ?? t('Часовой пояс неизвестен')}</p>
          <dl className="text-xs mt-2 space-y-1">
            <div><dt className="inline font-semibold">{t('Начало:')} </dt><dd className="inline">{moment(block.startsAt, block.event.timeZone)}</dd></div>
            <div><dt className="inline font-semibold">{t('Окончание:')} </dt><dd className="inline">{block.endsAt ? moment(block.endsAt, block.event.timeZone) : t('Окончание неизвестно')}</dd></div>
            <div><dt className="inline font-semibold">{t('Место:')} </dt><dd className="inline">{block.location ?? block.event.location ?? t('Неизвестно')}</dd></div>
            <div><dt className="inline font-semibold">{t('Роль:')} </dt><dd className="inline">{block.roles.map(role => t(role === 'responsible' ? 'Ответственный' : 'Участник')).join(', ')}</dd></div>
            <div><dt className="inline font-semibold">{t('Длительность:')} </dt><dd className="inline">{block.durationMinutes === null ? t('Длительность неизвестна') : `${block.durationMinutes} ${t('мин')}`}</dd></div>
            <div><dt className="inline font-semibold">{t('Переезд:')} </dt><dd className="inline">{block.travelMinutes} {t('мин')} · {t('Запас:')} {block.bufferMinutes} {t('мин')}</dd></div>
          </dl>
          {block.fixed && <p className="text-xs mt-2">{t('Фиксированное начало')}</p>}
          {block.outdoor && <p className="text-xs mt-1">{t('На открытом воздухе')}</p>}
          {block.dependsOn.length > 0 && <p className="text-xs mt-1">{t('После блоков:')} {block.dependsOn.map(id => program.blocks.find(b => b.id === id)?.name ?? t('Неизвестно')).join(', ')}</p>}
        </li>)}
      </ol>
      {acknowledgedAt ? <p role="status" className="text-sm flex items-start gap-2 mt-4"><Check size={18} className="shrink-0" /><span>{t(offlineSavedAt ? 'Подтверждено в сохранённом снимке' : 'Версия подтверждена')} · {acknowledgedAt}</span></p> : !offlineSavedAt && program.requiresAcknowledgment && <div className="border-t border-[var(--line)] pt-4 mt-3">
        {proofMissing && <p role="alert" className="text-sm">{t('Данные просмотра неполные — откройте программу заново')}</p>}
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={checked} disabled={busy || proofMissing} onChange={e => setChecked(e.target.checked)} className="h-5 w-5 shrink-0 mt-0.5" /><span>{t('Я ознакомился с этой версией программы')}</span></label>
        <button onClick={() => void ack()} disabled={!checked || busy || proofMissing} className="press w-full min-h-11 border border-[var(--line)] rounded-lg text-sm font-semibold px-3 py-2 mt-3 disabled:opacity-40">{busy ? t('Секунду…') : error ? t('Повторить подтверждение') : t('Подтвердить ознакомление')}</button>
      </div>}
    </>}
    <button onClick={reload} disabled={busy || reloadDisabled} className="press flex items-center gap-2 min-h-11 mt-3 text-sm disabled:opacity-40"><RefreshCw size={16} />{t('Открыть заново')}</button>
  </section>
}
