import { useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { AsyncState, ready } from '@/components/AsyncState'
import { TopBar } from '@/components/chrome'
import { ApiError } from '@/lib/api/client'
import { getItemHistory, getItemSets, putWeddingItem, type WeddingItem, type WeddingItemKit, type WeddingItemList, type WeddingItemWrite } from '@/lib/api/itemSets'
import { explainError, noWedding, useApi } from '@/lib/api/useApi'
import { getI18nLang, key, t } from '@/lib/i18n'
import { useLiveAccess } from '@/lib/offlineProgramHooks'
import { useStore } from '@/lib/store'
import { useLegacyActionScope, useLegacySessionKey } from '@/lib/useLegacyActionScope'

const kitLabels: Record<WeddingItemKit, string> = {
  bride_morning: key('Утро невесты'), groom_morning: key('Утро жениха'), ceremony: key('Церемония'),
  venue: key('Площадка'), emergency: key('Экстренный набор'),
}
const inputClass = 'block w-full rounded-xl bg-[var(--bg)] px-3 py-2 text-sm text-[var(--ink)]'
type Draft = WeddingItemWrite & { id: string }
const draftOf = (item: WeddingItem): Draft => ({
  id: item.id, version: item.version, title: item.title, kit: item.kit, holderId: item.holderId,
  delivererId: item.delivererId, purchaseId: item.purchaseId, archived: item.archived,
})

export default function WeddingItemSets() {
  const { weddingId } = useStore()
  const session = useLegacySessionKey(weddingId ?? '')
  return <ItemSetScreen key={session} weddingId={weddingId} />
}

function ItemSetScreen({ weddingId }: { weddingId: string | null }) {
  const q = useApi(() => weddingId ? getItemSets(weddingId) : noWedding(), [weddingId])
  const online = useLiveAccess(q.reload)
  const list = online && ready(q) && !q.refreshing ? q.data : null
  const begin = useLegacyActionScope(weddingId ?? '', weddingId)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [history, setHistory] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)

  const edit = (item?: WeddingItem) => {
    setError(null)
    setConflict(false)
    setDraft(item
      ? draftOf(item)
      : { id: crypto.randomUUID(), version: 0, title: '', kit: 'ceremony', archived: false })
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!weddingId || !list || list.readOnly || !draft || busy || conflict || q.refreshing) return
    const action = begin()
    setBusy(true)
    setError(null)
    try {
      const { id, ...body } = draft
      await putWeddingItem(weddingId, id, body, action.assertCurrent)
      action.assertCurrent()
      setDraft(null)
      setHistory(null)
      q.reload()
    } catch (cause) {
      if (action.isCurrent()) {
        setError(explainError(cause))
        if (cause instanceof ApiError && cause.code === 'stale_wedding_item') {
          setConflict(true)
        }
      }
    } finally {
      if (action.isCurrent()) setBusy(false)
    }
  }

  const loadLatest = async () => {
    if (!weddingId || !list || list.readOnly || !draft || busy) return
    const action = begin()
    setBusy(true)
    setError(null)
    try {
      const latest = await getItemSets(weddingId)
      action.assertCurrent()
      const item = latest.items.find(item => item.id === draft.id)
      setDraft(item && !latest.readOnly ? draftOf(item) : null)
      setConflict(false)
      q.reload()
    } catch (cause) {
      if (action.isCurrent()) {
        setError(explainError(cause))
        if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
          setDraft(null)
          setConflict(false)
          q.reload()
        }
      }
    } finally {
      if (action.isCurrent()) setBusy(false)
    }
  }

  return <div className="pb-28">
    <TopBar title={t('Наборы вещей')} back />
    <div className="px-5 mt-3 space-y-4">
      {!online ? <p role="status">{t('Нет связи с сервером')}</p>
        : q.refreshing ? <p role="status">{t('Проверяем доступ…')}</p>
        : <AsyncState q={q} forbiddenText={t('Наборы вещей доступны паре.')} />}
      {list && error && <p role="alert" className="text-sm text-[var(--rose-ink)]">{error}</p>}
      {list && !list.readOnly && !draft && <button onClick={() => edit()}
        className="press grad rounded-xl px-4 py-2.5 font-semibold text-[var(--on-grad)]">{t('Добавить вещь')}</button>}
      {draft && list && !list.readOnly && <>
        {conflict && <div className="card p-4 text-sm">
          <p role="status">{t('Черновик остался в форме. Загрузка актуальной версии заменит введённые данные.')}</p>
          <button type="button" disabled={busy} onClick={() => void loadLatest()} className="press mt-2 rounded-xl bg-[var(--bg)] px-3 py-2">
            {t('Загрузить актуальную версию')}
          </button>
        </div>}
        <ItemEditor draft={draft} list={list} busy={busy} saveBlocked={conflict || q.refreshing} setDraft={value => {
          if (!value) { setConflict(false); setError(null); q.reload() }
          setDraft(value)
        }} save={save} />
      </>}
      {list?.readOnly && <p className="text-sm text-[var(--soft)]">{t('Свадьба отменена — история доступна только для чтения')}</p>}
      {list && !list.items.length && !draft && <p className="text-sm text-[var(--soft)]">{t('Вещей пока нет')}</p>}
      {list?.kits.map(kit => {
        const items = list.items.filter(item => item.kit === kit)
        return items.length > 0 && <section key={kit} aria-label={t(kitLabels[kit])} className="space-y-2">
          <h2 className="font-bold">{t(kitLabels[kit])}</h2>
          {items.map(item => <article key={item.id} className="card p-4 space-y-2">
            <h3 className="font-semibold break-words">{item.title}</h3>
            {item.archived && <p className="text-sm text-[var(--soft)]">{t('В архиве')}</p>}
            <People item={item} />
            {item.purchaseId && <p className="text-sm"><Link className="underline" to={'/wedding/purchases?purchase=' + item.purchaseId}>{t('Открыть связанную покупку или аренду')}</Link></p>}
            {!!item.possiblePurchases?.length && <div className="text-sm">
              <p>{t('Возможное совпадение с покупкой или арендой')}</p>
              <ul className="list-disc pl-5">{item.possiblePurchases.map(purchase => <li key={purchase.id}>
                <Link className="underline break-words" to={'/wedding/purchases?purchase=' + purchase.id}>{purchase.label}</Link>
              </li>)}</ul>
            </div>}
            <div className="flex flex-wrap gap-2 text-sm">
              {!list.readOnly && <button disabled={busy || !!draft} onClick={() => edit(item)}
                aria-label={t('Изменить вещь') + ' · ' + item.title}
                className="press rounded-lg bg-[var(--bg)] px-3 py-2">{t('Изменить вещь')}</button>}
              <button aria-expanded={history === item.id} onClick={() => setHistory(history === item.id ? null : item.id)}
                className="press rounded-lg bg-[var(--bg)] px-3 py-2">{t('История вещи')}</button>
            </div>
            {weddingId && history === item.id && <ItemHistory weddingId={weddingId} itemId={item.id} />}
          </article>)}
        </section>
      })}
    </div>
  </div>
}

function People({ item }: { item: WeddingItem }) {
  return <dl className="grid grid-cols-2 gap-2 text-sm">
    <div><dt>{t('У кого хранится')}</dt><dd>{item.holderName ?? t('Не назначено')}</dd></div>
    <div><dt>{t('Кто привезёт')}</dt><dd>{item.delivererName ?? t('Не назначено')}</dd></div>
  </dl>
}

function ItemEditor({ draft, list, busy, saveBlocked, setDraft, save }: {
  draft: Draft; list: WeddingItemList; busy: boolean; saveBlocked: boolean; setDraft: (value: Draft | null) => void; save: (event: FormEvent) => void
}) {
  const formId = useId()
  const choices = [
    { field: 'holderId', label: key('У кого хранится'), options: list.members },
    { field: 'delivererId', label: key('Кто привезёт'), options: list.members },
    { field: 'purchaseId', label: key('Связанная покупка или аренда'), options: list.purchases },
  ] as const
  return <form onSubmit={save} className="card p-4">
    <fieldset disabled={busy} className="grid sm:grid-cols-2 gap-3">
      <label className="text-sm">{t('Название вещи')}<input className={inputClass} required maxLength={160} value={draft.title}
        onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
      <div className="text-sm">
        <label htmlFor={formId + '-kit'}>{t('Набор')}</label>
        <select id={formId + '-kit'} className={inputClass} value={draft.kit}
          onChange={event => setDraft({ ...draft, kit: event.target.value as WeddingItemKit })}>
          {list.kits.map(kit => <option key={kit} value={kit}>{t(kitLabels[kit])}</option>)}
        </select>
      </div>
      {choices.map(({ field, label, options }) => <div key={field} className="text-sm">
        <label htmlFor={formId + '-' + field}>{t(label)}</label>
        <select id={formId + '-' + field} className={inputClass} value={draft[field] ?? ''}
          onChange={event => setDraft({ ...draft, [field]: event.target.value || null })}>
          <option value="">{t('Не выбрано')}</option>
          {draft[field] && !options.some(option => option.id === draft[field]) &&
            <option value={draft[field]}>{t('Текущий выбор недоступен')}</option>}
          {options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </div>)}
      {draft.version > 0 && <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={draft.archived} onChange={event => setDraft({ ...draft, archived: event.target.checked })} />
        {t('В архиве')}
      </label>}
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <button type="submit" disabled={saveBlocked} className="press grad rounded-xl px-4 py-2 font-semibold text-[var(--on-grad)] disabled:opacity-50">{t('Сохранить')}</button>
        <button type="button" onClick={() => setDraft(null)} className="press rounded-xl bg-[var(--bg)] px-4 py-2">{t('Отмена')}</button>
      </div>
    </fieldset>
  </form>
}

function ItemHistory({ weddingId, itemId }: { weddingId: string; itemId: string }) {
  const q = useApi(() => getItemHistory(weddingId, itemId), [weddingId, itemId])
  const data = ready(q) ? q.data : null
  const format = new Intl.DateTimeFormat(getI18nLang() === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })
  return <div className="mt-2 border-t border-[var(--line)] pt-2">
    <AsyncState q={q} />
    {data && <ol className="space-y-2">{data.items.map(item => <li key={item.version} className="rounded-lg bg-[var(--bg)] p-2 text-sm">
      <p><time dateTime={item.recordedAt}>{format.format(new Date(item.recordedAt))}</time>{item.actorName && ' · ' + item.actorName}</p>
      <p>{item.title} · {t(kitLabels[item.kit])}{item.archived && ' · ' + t('В архиве')}</p>
      <People item={item} />
    </li>)}</ol>}
  </div>
}
