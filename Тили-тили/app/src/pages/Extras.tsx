import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Heart, Plus, Trash2, Wine, Users } from 'lucide-react'
import { fmt, rub } from '@/lib/money'
import { CATEGORY_TILE, DEFAULT_TILE } from '@/lib/categoryTiles'
import { getCategories, getFavorites } from '@/lib/api/catalog'
import { useApi, explainError } from '@/lib/api/useApi'
import { Tile, TopBar, VendorCard } from '@/components/chrome'
import { AsyncState, ready } from '@/components/AsyncState'
import { cn } from '@/lib/utils'
import { t, getI18nLang } from '@/lib/i18n'
import { useStore } from '@/lib/store'
import { createNote, deleteNote, getNotes, readLegacyNotes, LEGACY_NOTES_KEY } from '@/lib/api/notes'

/* Избранное — отложенные подрядчики (боль: «кандидаты теряются в переписках») */
export function Favorites() {
  const nav = useNavigate()
  /* Список приходит с сервера, а не собирается из мока по локальным
     идентификаторам: избранное — это данные аккаунта, и на новом телефоне
     оно должно быть тем же. */
  const favs = useApi(() => getFavorites(), [])
  const cats = useApi(() => getCategories(), [])
  const list = favs.data ?? []
  const catOf = (id?: string) => (cats.data ?? []).find(c => c.id === id)
  return (
    <div className="pb-28">
      <TopBar back title={t('Избранное')} sub={ready(favs) ? `${list.length}${t(' отложено · сравните и выберите')}` : undefined} />
      <div className="px-5 mt-3 space-y-3.5 stagger">
        {favs.loading && <p className="text-[12px] text-[var(--soft)] py-6 text-center">{t('Загружаем…')}</p>}
        {favs.error && (
          <div className="py-6 text-center">
            <p role="alert" className="text-[12px] text-[var(--rose-ink)] leading-relaxed">{favs.error}</p>
            <button onClick={() => { favs.reload(); cats.reload() }} className="press mt-3 px-5 h-[40px] rounded-full card-s text-[12px] font-semibold">{t('Повторить')}</button>
          </div>
        )}
        {list.map(v => (
          <VendorCard key={v.id} v={v}
            categoryTitle={catOf(v.categoryId)?.title}
            categoryIcon={catOf(v.categoryId)?.icon}
            tile={CATEGORY_TILE[v.categoryId ?? ''] ?? DEFAULT_TILE}
            onOpen={() => nav(`/vendor/${v.id}`)} />
        ))}
        {!favs.loading && !favs.error && list.length === 0 && (
          <div className="text-center py-14 fade-up">
            <div className="w-16 h-16 rounded-[22px] bg-[var(--rose-soft)] mx-auto flex items-center justify-center"><Heart size={26} className="text-[var(--rose-ink)]" /></div>
            <b className="text-[15px] block mt-4">{t('Пока пусто')}</b>
            <p className="text-[12px] text-[var(--soft)] mt-1.5 leading-relaxed">{t('Нажимайте ♥ на карточках подрядчиков —')}<br />{t('они соберутся здесь для сравнения')}</p>
            <button onClick={() => nav('/search')} className="press mt-5 px-6 h-[44px] rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold">{t('К каталогу')}</button>
          </div>
        )}
        {list.length >= 2 && (
          <button onClick={() => nav('/compare')} className="press w-full h-[52px] rounded-full grad text-[var(--on-grad)] font-semibold text-[13.5px]" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>
            {t('Сравнить выбранных ⇄')}
          </button>
        )}
      </div>
    </div>
  )
}

/* Заметки и идеи (боль: «референсы в трёх мессенджерах») */
/*
 * Заметки — на сервере, у свадьбы (фича 014, блокер №7): их видит и пишет вся
 * команда, смена телефона их не теряет. Раньше они жили в `localStorage`, и
 * экран честно писал «хранятся только на этом устройстве». Заметки прежней
 * версии, если они остались в хранилище, переносятся одной кнопкой — по
 * запросу на каждую, — и хранилище очищается; без нажатия ничего не уходит.
 * Без свадьбы заметок нет: они принадлежат ей, а не аккаунту.
 */
export function Notes() {
  const nav = useNavigate()
  const { weddingId } = useStore()
  const q = useApi(() => (weddingId ? getNotes(weddingId) : Promise.resolve(null)), [weddingId])
  const notes = q.data ?? []
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<'add' | 'move' | string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  /* Заметки прежней версии читаются один раз, на монтировании: хранилище — не
     состояние экрана, и перечитывать его на каждом рендере незачем. */
  const [legacy, setLegacy] = useState<string[]>(() => readLegacyNotes())

  const run = async (key: string, action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(key)
    setErr(null)
    try {
      await action()
      q.reload()
    } catch (e) {
      setErr(explainError(e))
    } finally {
      setBusy(null)
    }
  }
  const add = () => {
    const body = text.trim()
    if (!body || !weddingId) return
    void run('add', async () => { await createNote(weddingId, body); setText('') })
  }
  const remove = (id: string) => { if (weddingId) void run(id, () => deleteNote(weddingId, id)) }
  /* Перенос: по запросу на заметку, старые первыми — так они лягут в том же
     порядке, что были. Хранилище очищается только после того, как все ушли:
     оборвалось на середине — оставшиеся ждут следующего нажатия, а те, что
     уже на сервере, из списка переноса убираются. */
  const move = () => {
    if (!weddingId) return
    void run('move', async () => {
      const rest = [...legacy]
      try {
        for (const item of [...legacy].reverse()) {
          await createNote(weddingId, item)
          rest.splice(rest.indexOf(item), 1)
        }
      } finally {
        setLegacy(rest)
        try {
          if (rest.length) localStorage.setItem(LEGACY_NOTES_KEY, JSON.stringify(rest.map(t => ({ text: t }))))
          else localStorage.removeItem(LEGACY_NOTES_KEY)
        } catch { /* приватный режим */ }
      }
    })
  }
  const when = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(getI18nLang() === 'en' ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'short' }) : '')
  const legacyCaption = `${t('На этом устройстве остались заметки прежней версии:')} ${legacy.length}`

  return (
    <div className="pb-28">
      <TopBar back title={t('Заметки и идеи')} sub={t('Всё, что не хочется забыть')} />
      <div className="px-5 mt-3">
        {!weddingId ? (
          <div className="text-center py-14 fade-up">
            <b className="text-[15px] block">{t('Заметки принадлежат свадьбе')}</b>
            <p className="text-[12px] text-[var(--soft)] mt-1.5 leading-relaxed">{t('Заведите свадьбу — и записывайте идеи вместе с партнёром')}</p>
            <button onClick={() => nav('/quiz')} className="press mt-5 px-6 h-[44px] rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold">{t('Начать новую свадьбу')}</button>
          </div>
        ) : (
          <>
            <div className="card-s flex items-center gap-2.5 px-4 py-2">
              <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()}
                placeholder={t('Новая заметка…')} className="flex-1 bg-transparent outline-none text-[13.5px] py-2.5 placeholder:text-[var(--soft2)]" />
              <button onClick={add} disabled={!!busy || !text.trim()} className="press w-9 h-9 rounded-full grad text-[var(--on-grad)] flex items-center justify-center shrink-0 disabled:opacity-50" aria-label={t('Добавить')}><Plus size={16} /></button>
            </div>
            {err && <p role="alert" className="text-[11.5px] text-[var(--rose-ink)] mt-2 leading-relaxed">{err}</p>}
            {legacy.length > 0 && (
              <div className="card-s p-4 mt-3 fade-up">
                <p className="text-[12px] leading-relaxed">{legacyCaption}</p>
                <p className="text-[10.5px] text-[var(--soft)] mt-1 leading-relaxed">{t('Перенесите их к свадьбе — увидит вся команда, а телефон можно менять.')}</p>
                <button onClick={move} disabled={!!busy} className="press mt-3 h-[38px] px-5 rounded-full grad text-[var(--on-grad)] text-[11.5px] font-semibold disabled:opacity-50">
                  {busy === 'move' ? t('Переносим…') : t('Перенести на сервер')}
                </button>
              </div>
            )}
            <div className="space-y-2.5 mt-4 stagger">
              <AsyncState q={q} />
              {notes.map(n => {
                const by = `${n.authorName ?? t('без имени')} · ${when(n.createdAt)}`
                return (
                  <div key={n.id} className="card-s p-4 flex items-center gap-3 fade-up">
                    <Tile icon="📌" tile="bg-[var(--honey)]" size={40} />
                    <div className="flex-1 min-w-0">
                      <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap break-words">{n.text}</p>
                      <p className="text-[10px] text-[var(--soft2)] mt-1">{by}</p>
                    </div>
                    <button onClick={() => remove(n.id)} disabled={!!busy} className="press text-[var(--soft2)] disabled:opacity-50" aria-label={t('Удалить')}><Trash2 size={15} /></button>
                  </div>
                )
              })}
              {ready(q) && notes.length === 0 && <p className="text-center text-[12px] text-[var(--soft2)] py-10">{t('Заметок пока нет — запишите первую идею')}</p>}
              {ready(q) && <p className="text-center text-[10px] text-[var(--soft2)] pt-4">{t('Заметки видит вся команда свадьбы')}</p>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* Калькулятор алкоголя (боль жениха: «сколько брать, чтобы хватило и не переплатить») */
/*
 * Нормы — редакционные константы банкетного формата, а не расчёт Тиля: у
 * ИИ-координатора нет модели, и подписывать его именем таблицу из кода
 * значит приписывать ему то, чего он не делал (ревью D5-24, R-174).
 */
export function AlcoholCalc() {
  const [guestsN, setGuestsN] = useState(80)
  const [strong, setStrong] = useState(true)
  const drinks = [
    { name: t('Игристое'), per: 0.5, unit: t('л/чел'), bottle: 0.75, icon: '🥂' },
    { name: t('Вино'), per: 0.4, unit: t('л/чел'), bottle: 0.75, icon: '🍷' },
    ...(strong ? [{ name: t('Крепкое'), per: 0.25, unit: t('л/чел'), bottle: 0.5, icon: '🥃' }] : []),
    { name: t('Вода и соки'), per: 1.5, unit: t('л/чел'), bottle: 1.5, icon: '💧' },
  ]
  return (
    <div className="pb-28">
      <TopBar back title={t('Калькулятор алкоголя')} sub={t('Нормы банкетного формата')} />
      <div className="px-5 mt-3 space-y-3.5">
        <div className="card p-5">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium flex items-center gap-2"><Users size={15} className="text-[var(--rose-deep)]" />{t('Гостей')}</span>
            <div className="flex items-center gap-3">
              <button onClick={() => setGuestsN(g => Math.max(10, g - 10))} className="press w-9 h-9 rounded-full bg-[var(--bg)] font-bold">−</button>
              <b className="tabular text-[18px] w-10 text-center">{guestsN}</b>
              <button onClick={() => setGuestsN(g => Math.min(300, g + 10))} className="press w-9 h-9 rounded-full bg-[var(--bg)] font-bold">+</button>
            </div>
          </div>
          <div className="flex items-center justify-between mt-4">
            <span className="text-[13px] font-medium flex items-center gap-2"><Wine size={15} className="text-[var(--rose-deep)]" />{t('Крепкие напитки')}</span>
            <button onClick={() => setStrong(!strong)} className={cn('w-[46px] h-[27px] rounded-full transition-colors relative', strong ? 'grad' : 'bg-[var(--track)]')} aria-label={t('Крепкие напитки')}>
              <span className={cn('absolute top-[3px] w-[21px] h-[21px] rounded-full bg-[var(--card)] shadow transition-all', strong ? 'left-[22px]' : 'left-[3px]')} />
            </button>
          </div>
        </div>

        <div className="card px-4 py-1.5">
          {drinks.map((d, i) => {
            const litres = d.per * guestsN
            const bottles = Math.ceil(litres / d.bottle)
            return (
              <div key={d.name} className={cn('flex items-center gap-3 py-3.5', i !== drinks.length - 1 && 'border-b border-[var(--track)]')}>
                <span className="text-[22px]">{d.icon}</span>
                <div className="flex-1">
                  <b className="text-[13px]">{d.name}</b>
                  <p className="text-[10px] text-[var(--soft)]">{d.per} {d.unit}</p>
                </div>
                <b className="font-serif-d text-[16px] text-[var(--rose-deep)] tabular">{bottles} {t('бут.')}</b>
              </div>
            )
          })}
        </div>

        <div className="card-s p-4 text-[11.5px] text-[var(--ink2)] leading-relaxed">
          ✦ <b>{t('Совет:')}</b> {t('закладывайте +10% запаса. Для усадьбы уточните пробковый сбор — иногда выгоднее закупаться самим. Берите с чеком: невскрытое часто принимают обратно.')}
        </div>

        <div className="card p-4 flex justify-between items-center">
          <span className="text-[12.5px] text-[var(--soft)]">{t('Ориентир по бюджету')}</span>
          {/* 750/500 — рубли на гостя, а `fmt` печатает копейки: без `rub()`
              80 гостей давали «600 ₽» вместо «60 000 ₽» (ревью D5-06,
              правило `money.ts`: литерал в рублях оборачивается в rub()). */}
          <b className="font-serif-d text-[18px] tabular">{fmt(rub(guestsN * (strong ? 750 : 500)))}</b>
        </div>
      </div>
    </div>
  )
}
