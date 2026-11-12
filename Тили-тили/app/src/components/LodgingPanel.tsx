import { useState, type FormEvent } from 'react'
import { AsyncState } from '@/components/AsyncState'
import {
  deleteLodgingPlacement, deleteLodgingRoom, getLodging, putLodgingPlacement, putLodgingRoom,
  type LodgingPlacementWrite, type LodgingRoomWrite, type LodgingSource,
} from '@/lib/api/lodging'
import { explainError, useApi } from '@/lib/api/useApi'
import { t } from '@/lib/i18n'
import { lodgingSourceLabel } from '@/lib/lodging'

const input = 'block w-full min-h-10 mt-1 rounded-xl bg-[var(--bg)] px-3 text-[13px]'
const label = 'block text-[12px] font-medium'
const action = 'press px-3 min-h-9 rounded-full bg-[var(--bg)] text-[12px] font-semibold disabled:opacity-50'

type Editor =
  | { kind: 'room'; id: string; draft: LodgingRoomWrite }
  | { kind: 'placement'; id: string; draft: LodgingPlacementWrite }

export function LodgingPanel({ weddingId, hotelIds, onRoomsChanged }: { weddingId: string; hotelIds: string; onRoomsChanged: () => void }) {
  const q = useApi(() => getLodging(weddingId), [weddingId, hotelIds])
  const [editor, setEditor] = useState<Editor | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [writing, setWriting] = useState(false)
  const busy = writing || q.refreshing || !!q.error || q.forbidden
  const [error, setError] = useState<string | null>(null)

  const start = (next: Editor) => {
    setError(null)
    setConfirm(null)
    setEditor(next)
    requestAnimationFrame(() => document.getElementById('lodging-edit')?.focus())
  }

  const write = async (perform: () => Promise<unknown>, roomChanged: boolean) => {
    if (busy) return
    setWriting(true)
    setError(null)
    try {
      await perform()
      setEditor(null)
      setConfirm(null)
      q.reload()
      if (roomChanged) onRoomsChanged()
    } catch (cause) {
      setError(explainError(cause))
    } finally {
      setWriting(false)
    }
  }

  const data = q.data
  if (!data) return <AsyncState q={q} />
  const room = editor?.kind === 'room' ? editor : null
  const placement = editor?.kind === 'placement' ? editor : null
  const updateRoom = (fields: Partial<LodgingRoomWrite>) => {
    if (room) setEditor({ ...room, draft: { ...room.draft, ...fields } })
  }
  const updatePlacement = (fields: Partial<LodgingPlacementWrite>) => {
    if (placement) setEditor({ ...placement, draft: { ...placement.draft, ...fields } })
  }
  const save = (event: FormEvent) => {
    event.preventDefault()
    if (room) void write(() => putLodgingRoom(weddingId, room.id, room.draft), true)
    if (placement) void write(() => putLodgingPlacement(weddingId, placement.id, placement.draft), false)
  }
  const requestDelete = (id: string, perform: () => Promise<unknown>, roomChanged: boolean) => {
    if (confirm === id) void write(perform, roomChanged)
    else setConfirm(id)
  }

  return (
    <section className="card p-4 space-y-4" aria-label={t('План размещения')}>
      <AsyncState q={q} />
      <p className="text-[11px] text-[var(--soft)]">{t('План размещения не подтверждает оплату гостиницы.')}</p>
      {!data.hotels.length && <p className="text-[12px]">{t('Сначала добавьте отельный блок.')}</p>}
      {error && <div className="space-y-1">
        <p role="alert" className="text-[12px] text-[var(--rose-deep)]">{error}</p>
        <button className={action} disabled={busy} onClick={() => { q.reload(); setEditor(null); setError(null); setConfirm(null) }}>
          {t('Обновить план размещения')}
        </button>
      </div>}
      {editor && <form id="lodging-edit" tabIndex={-1} className="space-y-3 border border-[var(--line)] rounded-xl p-3" onSubmit={save}>
        <fieldset className="space-y-3 min-w-0" disabled={busy}>
          <legend className="text-[13px] font-semibold">{room ? t('Номер в отеле') : t('Размещение гостя')}</legend>
          {room && <>
            <label className={label}>{t('Номер или название комнаты')}
              <input required maxLength={120} className={input} value={room.draft.label} onChange={e => updateRoom({ label: e.target.value })} />
            </label>
            <label className={label}>{t('Вместимость номера')}
              <input required type="number" min={1} max={500} className={input} value={room.draft.capacity || ''}
                onChange={e => updateRoom({ capacity: e.target.valueAsNumber })} />
            </label>
            {room.draft.version === 0 && <label className={label}>{t('Семейная заявка')}
              <select aria-label={t('Семейная заявка')} className={input} value={room.draft.legacyPartyId ?? ''}
                onChange={e => updateRoom({ legacyPartyId: e.target.value || undefined })}>
                <option value="">{t('Без семейной заявки')}</option>
                {data.requests.filter(request => request.hotelId === room.draft.hotelId).map(request =>
                  <option key={request.partyId} value={request.partyId}>{request.label}</option>)}
              </select>
            </label>}
          </>}
          {placement && <>
            <label className={label}>{t('Номер в отеле')}
              <select aria-label={t('Номер в отеле')} className={input} value={placement.draft.roomId} onChange={e => updatePlacement({ roomId: e.target.value })}>
                {data.rooms.map(r => <option key={r.id} value={r.id}>{data.hotels.find(h => h.id === r.hotelId)?.name} · {r.label}</option>)}
              </select>
            </label>
            <label className={label}>{t('Гость')}
              <select required aria-label={t('Гость')} className={input} value={placement.draft.guestId} onChange={e => updatePlacement({ guestId: e.target.value })}>
                <option value="">{t('Выберите гостя')}</option>
                {data.guests.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className={label}>{t('Дата заезда')}
                <input required type="date" className={input} value={placement.draft.checkIn}
                  onChange={e => updatePlacement({ checkIn: e.target.value })} />
              </label>
              <label className={label}>{t('Дата выезда')}
                <input required type="date" className={input} value={placement.draft.checkOut}
                  onChange={e => updatePlacement({ checkOut: e.target.value })} />
              </label>
            </div>
            <label className={label}>{t('Ответственный')}
              <select aria-label={t('Ответственный')} className={input} value={placement.draft.responsibleId ?? ''}
                onChange={e => updatePlacement({ responsibleId: e.target.value || null })}>
                <option value="">{t('Без ответственного')}</option>
                {data.team.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
            <label className={label}>{t('Источник подтверждения')}
              <select aria-label={t('Источник подтверждения')} className={input} value={placement.draft.source} onChange={e => updatePlacement({ source: e.target.value as LodgingSource })}>
                {(['organizer', 'guest', 'hotel'] as const).map(source => <option key={source} value={source}>{lodgingSourceLabel(source)}</option>)}
              </select>
            </label>
          </>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={action}>{room ? t('Сохранить номер') : t('Сохранить размещение')}</button>
            <button type="button" className={action} onClick={() => { setEditor(null); setError(null) }}>{t('Отмена')}</button>
          </div>
        </fieldset>
      </form>}
      {data.hotels.map(h => (
        <div key={h.id} className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[13px] font-semibold">{h.name} <span className="font-normal text-[var(--soft)]">· {h.used}/{h.rooms} {t('номеров')}</span></h3>
            <button className={action} disabled={busy} onClick={() => start({
              kind: 'room', id: crypto.randomUUID(), draft: { hotelId: h.id, label: '', capacity: 1, version: 0 },
            })}>{t('Добавить номер')}</button>
          </div>
          {data.rooms.filter(r => r.hotelId === h.id).map(r => (
            <article key={r.id} className="rounded-xl border border-[var(--line)] px-3 py-2 space-y-2">
              <h4 className="text-[13px] font-semibold">{r.label} <span className="font-normal text-[var(--soft)]">· {t('Вместимость')} {r.capacity}</span></h4>
              <div className="flex flex-wrap gap-2">
                <button className={action} disabled={busy || !data.guests.length} onClick={() => start({
                  kind: 'placement', id: crypto.randomUUID(), draft: { version: 0, roomId: r.id, guestId: '', checkIn: '',
                    checkOut: '', responsibleId: null, source: 'organizer' },
                })}>{t('Разместить гостя')}</button>
                <button className={action} disabled={busy} onClick={() => start({
                  kind: 'room', id: r.id, draft: { hotelId: r.hotelId, label: r.label, capacity: r.capacity, version: r.version },
                })}>{t('Изменить номер')}</button>
                <button className={action} disabled={busy} onClick={() =>
                  requestDelete(r.id, () => deleteLodgingRoom(weddingId, r.id, r.version), true)}>
                  {confirm === r.id ? t('Подтвердить удаление') : t('Удалить номер')}
                </button>
              </div>
              {data.placements.filter(p => p.roomId === r.id).map(p => (
                <div key={p.id} className="border-t border-[var(--line)] pt-2 space-y-1">
                  <p className="text-[12px] font-semibold">{p.guestName} · {p.checkIn} — {p.checkOut}</p>
                  <p className="text-[11px] text-[var(--soft)]">
                    {lodgingSourceLabel(p.source)}{p.responsibleId && ` · ${data.team.find(m => m.id === p.responsibleId)?.label ?? ''}`}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button className={action} disabled={busy} onClick={() => start({ kind: 'placement', id: p.id, draft: {
                      version: p.version, roomId: p.roomId, guestId: p.guestId, checkIn: p.checkIn, checkOut: p.checkOut,
                      responsibleId: p.responsibleId, source: p.source,
                    } })}>{t('Изменить размещение')}</button>
                    <button className={action} disabled={busy} onClick={() =>
                      requestDelete(p.id, () => deleteLodgingPlacement(weddingId, p.id, p.version), false)}>
                      {confirm === p.id ? t('Подтвердить удаление') : t('Убрать размещение')}
                    </button>
                  </div>
                </div>
              ))}
            </article>
          ))}
        </div>
      ))}
    </section>
  )
}
