import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ChevronLeft, Send, Settings, Globe, Bell, Shield, ShieldCheck, LogOut, FileText, LifeBuoy, Store, PartyPopper, GitCompareArrows } from 'lucide-react'
import { Tile, TopBar } from '@/components/chrome'
import { AsyncState, ready } from '@/components/AsyncState'
import { useStore } from '@/lib/store'
import { cn, copyText, goBack } from '@/lib/utils'
import { getI18nLang, t, reloadToRoot } from '@/lib/i18n'
import { explainError, useApi } from '@/lib/api/useApi'
import { api, ApiError, url } from '@/lib/api/client'
import { getChats, getMessages, openChatSocket, sendMessage, sendTyping } from '@/lib/api/chats'
import { getWedding } from '@/lib/api/weddingData'
import { applyReferralCode, getMe, getReferral, signOutEverywhere } from '@/lib/api/auth'
import { DatePicker } from '@/components/DatePicker'
import { formatWeddingDate } from '@/lib/weddingDate'

/* «Мы» — профиль пары */
export function Us() {
  const { lang, setLang, weddingDate, setWeddingDate, weddingId, forgetSession } = useStore()
  /* Своя свадьба, а не «Алина Козлова & Тимур Волков» из моков: имя, город и
     площадка хранятся у неё. Экран профиля показывал чужую пару каждому. */
  const wq = useApi(() => weddingId ? getWedding(weddingId) : Promise.resolve(null), [weddingId])
  const wedding = wq.data
  const [dateErr, setDateErr] = useState<string | null>(null)
  const nav = useNavigate()
  const [copied, setCopied] = useState(false)
  const [datePicker, setDatePicker] = useState(false)
  /* Реферальный код — свой, а не написанный в разметке. */
  const ref = useApi(() => getReferral(), [])
  /*
   * Чужой код (ревью D1-22). Экран показывал свой код и «приглашено: 0», а
   * ввести код, по которому пришёл, было негде — `POST /referral/{code}/apply`
   * не звал никто, и счётчик у всех навсегда оставался нулём.
   */
  const [refCode, setRefCode] = useState<string | null>(null)
  const [refBusy, setRefBusy] = useState(false)
  const [refDone, setRefDone] = useState(false)
  const [refErr, setRefErr] = useState<string | null>(null)
  const applyCode = async () => {
    const code = (refCode ?? '').trim().toUpperCase()
    if (!code || refBusy) return
    setRefBusy(true); setRefErr(null)
    try {
      await applyReferralCode(code)
      setRefDone(true)
      setRefCode(null)
      ref.reload()
    } catch (e) { setRefErr(explainError(e)) } finally { setRefBusy(false) }
  }
  /* Выход — тот же, что «Выйти со всех устройств» в настройках (D1-20/D4-05):
     кнопка была `nav('/auth')` без единого запроса и без очистки устройства.
     После очистки устройства — память стора (RF-01): переход на вход не
     перезагружает страницу, и без сброса мозаика с телефонами подрядчиков
     открывалась «Назад» без токена. */
  const [leaving, setLeaving] = useState(false)
  const signOut = async () => {
    if (leaving) return
    setLeaving(true)
    await signOutEverywhere()
    forgetSession()
    nav('/auth')
  }
  /* Признак сотрудника приходит в своём профиле. Пробный запрос в саму панель
     сюда не годится: код `forbidden` не отличает «не сотрудник» от «нет
     согласия», и меню ходило бы в админку при каждом открытии экрана. */
  const me = useApi(() => getMe(), [])
  // Время в теле компонента запрещено (R-04) — снимаем один раз.
  const [today] = useState(() => new Date())
  const copy = (text: string, cb: () => void) => {
    copyText(text)
    cb()
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="pb-28">
      <TopBar title={t('Мы')} sub={t('Профиль пары и настройки')} />
      <div className="px-5 mt-3">
        <div className="card p-5 text-center fade-up">
          {/* Буквы — из названия своей свадьбы. «А» и «Т» стояли константами
              и не менялись ни у кого. */}
          <div className="flex justify-center -space-x-3.5">
            {(wedding?.title ?? '').split(/[&♥+]/).slice(0, 2).map((part, i) => (
              <div key={i} className={cn('w-16 h-16 rounded-full text-[var(--on-grad)] font-serif-d text-[26px] flex items-center justify-center border-4 border-white', i === 0 ? 'bg-[var(--rose)]' : 'bg-[var(--sage)]')}>
                {part.trim()[0] ?? '·'}
              </div>
            ))}
          </div>
          <b className="font-serif-d text-[20px] block mt-3">{wedding?.title ?? t('Ваша свадьба')}</b>
          {/* Отказ на своей свадьбе раньше не показывался: карточка молча
              стояла с «Ваша свадьба» вместо названия. */}
          {wq.error && <p role="alert" className="text-[11px] text-[var(--rose-ink)] mt-1 leading-relaxed">{wq.error}</p>}
          <button onClick={() => setDatePicker(true)} className="press text-[11.5px] text-[var(--soft)] mt-1 underline decoration-dotted underline-offset-4">
            {[weddingDate ? formatWeddingDate(weddingDate) : t('Выбрать дату свадьбы'), wedding?.city?.name].filter(Boolean).join(' · ')}
          </button>
          <button onClick={() => nav('/us/team')} className="press mt-4 px-5 h-[42px] rounded-full bg-[var(--bg)] text-[12px] font-semibold text-[var(--rose-deep)]">
            {t('+ Пригласить в команду (партнёр, помощники, подрядчики)')}
          </button>
        </div>

        {/* Код выдаёт сервер. Здесь стояло «ТИЛИ-АЛИНА · приглашено: 2» —
            код выдуманной пары, который кнопка «Копировать» клала человеку в
            буфер обмена. Своего кода он при этом не узнавал никогда. */}
        <div className="card p-5 mt-4 relative overflow-hidden">
          <div className="absolute -right-8 -top-8 w-28 h-28 rounded-full bg-[var(--rose-soft)] opacity-70" />
          <span className="text-[10px] tracking-[.18em] uppercase text-[var(--rose-deep)] font-semibold relative">{t('Реферальная программа')}</span>
          {/* «3 000 ₽ на премиум-функции» обещало начисление, которого нет
              (`/referral/{code}/apply` только записывает, кто кого привёл), и
              функции, которых нет: приложение бесплатно целиком. «Пока не
              начисляются» тоже обещало — начисления в коде нет (R-174). */}
          <p className="text-[12px] text-[var(--ink2)] mt-2 leading-relaxed relative">{t('Пригласите пару по своему коду: когда она введёт его здесь, счётчик вырастет. Бонусов за приглашения нет — приложение бесплатно.')}</p>
          {ready(ref) && ref.data?.code ? (
            <div className="flex items-center gap-2.5 mt-3.5 relative">
              <div className="flex-1 card-s px-4 py-3 flex items-center justify-between">
                <b className="text-[13px] tracking-[.12em]">{ref.data.code}</b>
                <span className="text-[9.5px] text-[var(--soft)]">{t('приглашено:')} {ref.data.invited ?? 0}</span>
              </div>
              <button onClick={() => copy(ref.data!.code!, () => setCopied(true))} className="press h-[44px] px-5 rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold">{copied ? t('✓ Скопировано') : t('Копировать')}</button>
            </div>
          ) : (
            <p className="text-[11px] text-[var(--soft)] mt-3.5 relative">{t('Код появится, когда сервер его выдаст.')}</p>
          )}
          {/* Чужой код: один раз на аккаунт, отказ — словами сервера (D1-22). */}
          {refDone ? (
            <p className="text-[11px] text-[var(--sage-deep)] mt-3 relative">{t('Код применён')}</p>
          ) : refCode === null ? (
            <button onClick={() => setRefCode('')} className="press text-[11.5px] font-semibold text-[var(--rose-deep)] mt-3 relative">{t('У меня есть код')}</button>
          ) : (
            <div className="flex items-center gap-2.5 mt-3 relative">
              <input value={refCode} onChange={e => setRefCode(e.target.value)} onKeyDown={e => e.key === 'Enter' && void applyCode()} autoFocus
                placeholder="ТИЛИ-ИМЯ" className="flex-1 card-s px-4 py-3 text-[13px] tracking-[.12em] outline-none placeholder:text-[var(--soft2)]" />
              <button onClick={() => void applyCode()} disabled={refBusy || !refCode.trim()} className="press h-[44px] px-5 rounded-full card-s text-[12px] font-semibold disabled:opacity-40">{refBusy ? t('Секунду…') : t('Применить')}</button>
            </div>
          )}
          {refErr && <p role="alert" className="text-[11px] text-[var(--rose-ink)] mt-2 relative">{refErr}</p>}
        </div>

        <div className="card px-4 py-1.5 mt-4">
          {[
            { icon: Settings, label: t('Настройки'), tile: 'bg-[var(--peach)]', to: '/settings' },
            /* Подпись «22:00–09:00» отсюда убрана: она никогда не
               рисовалась (поле `badge` не читается), а тихие часы теперь
               настраиваются и могут быть выключены. */
            { icon: Bell, label: t('Уведомления и тихие часы'), tile: 'bg-[var(--honey)]', to: '/settings' },
            { icon: LifeBuoy, label: t('Поддержка и FAQ'), tile: 'bg-[var(--rose-soft)]', to: '/support' },
            { icon: FileText, label: t('Оферта и конфиденциальность'), tile: 'bg-[var(--blue)]', to: '/legal/offer' },
            { icon: Shield, label: t('Сессии и устройства'), tile: 'bg-[var(--sage-soft)]', to: '/settings' },
          ].map(it => (
            <button key={it.label} onClick={() => nav(it.to)} className="press w-full flex items-center gap-3 py-3.5 text-left border-b border-[var(--track)] last:border-none">
              <Tile icon="" tile={it.tile} size={38} />
              <span className="absolute ml-3"><it.icon size={16} className="text-[var(--ink2)]" /></span>
              <span className="flex-1 text-[13px] font-medium ml-1">{it.label}</span>
            </button>
          ))}
          <div className="flex items-center gap-3 py-3.5">
            <Tile icon="" tile="bg-[var(--lav)]" size={38} />
            <span className="absolute ml-3"><Globe size={16} className="text-[var(--ink2)]" /></span>
            <span className="flex-1 text-[13px] font-medium ml-1">{t('Язык интерфейса')}</span>
            <div className="flex bg-[var(--bg)] rounded-full p-1">
              {(['ru', 'en'] as const).map(l => (
                <button key={l} onClick={() => { if (l !== lang) { setLang(l); reloadToRoot() } }} className={cn('press px-3.5 py-1.5 rounded-full text-[11px] font-bold uppercase', lang === l ? 'grad text-[var(--on-grad)]' : 'text-[var(--soft)]')}>{l}</button>
              ))}
            </div>
          </div>
        </div>

        <div className="card px-4 py-1.5 mt-3.5">
          {[
            { icon: GitCompareArrows, label: t('Сравнение подрядчиков'), tile: 'bg-[var(--lav)]', to: '/compare' },
            { icon: Bell, label: t('Избранное'), tile: 'bg-[var(--rose-soft)]', to: '/favorites' },
            { icon: FileText, label: t('Заметки и идеи'), tile: 'bg-[var(--peach)]', to: '/notes' },
            { icon: PartyPopper, label: t('После свадьбы'), tile: 'bg-[var(--honey)]', to: '/after' },
            /* Плашка «демо» снята: кабинет настоящий, и всё, что там нажимается,
               меняет данные. Пара, у которой анкеты нет, увидит там честное
               «Анкеты ещё нет» и предложение её завести — это вторая роль, а
               не витрина. */
            { icon: Store, label: t('Кабинет подрядчика'), tile: 'bg-[var(--sage-soft)]', to: '/vendor-app' },
            /* Панель платформы — только сотруднику и только по ответу сервера.
               Пока ответа нет, пункта нет вовсе: показывать его всем и ловить
               403 на входе значит обещать раздел, которого у человека не будет. */
            ...(me.data?.isStaff === true
              ? [{ icon: ShieldCheck, label: t('Админка'), tile: 'bg-[var(--blue)]', to: '/admin' }]
              : []),
          ].map(it => (
            <button key={it.label} onClick={() => nav(it.to)} className="press w-full flex items-center gap-3 py-3.5 text-left border-b border-[var(--track)] last:border-none">
              <Tile icon="" tile={it.tile} size={38} />
              <span className="absolute ml-3"><it.icon size={16} className="text-[var(--ink2)]" /></span>
              <span className="flex-1 text-[13px] font-medium ml-1">{it.label}</span>
            </button>
          ))}
        </div>

        <button onClick={() => void signOut()} disabled={leaving} className="press w-full card-s mt-4 py-4 text-[13px] font-semibold text-[var(--rose-deep)] flex items-center justify-center gap-2 disabled:opacity-50">
          <LogOut size={15} /> {leaving ? t('Секунду…') : t('Выйти из аккаунта')}
        </button>
        <p className="text-center text-[10px] text-[var(--soft2)] mt-4">{t('Тили-тили v0.1 · MVP · сделано с любовью в Уфе')}</p>
      </div>

      {datePicker && (
        <DatePicker
          value={weddingDate}
          now={today}
          /* Перенос уходит на сервер и может не пройти: дата бывает занята у
             забронированной команды (409). Пока ответа нет, шторку не
             закрываем, а отказ показываем словами. */
          onPick={(iso) => void (async () => {
            setDateErr(null)
            try { await setWeddingDate(iso); setDatePicker(false) } catch (e) { setDateErr(explainError(e)) }
          })()}
          error={dateErr}
          onClose={() => setDatePicker(false)}
        />
      )}
    </div>
  )
}

/*
 * Список чатов.
 *
 * Прежний список был витриной: «Елена Смирнова · Отправила вам договор»,
 * «Артём Краснов · Аванс получил», «Чат дня X · откроется 13 июня» — одни и
 * те же пять строк у каждого, кто открывал экран. Теперь чаты приходят с
 * сервера: у пары — подрядчики, команда и день X, у подрядчика — его пары.
 */
export function Chats() {
  const nav = useNavigate()
  const [q, setQ] = useState('')
  /* «Сейчас» для сравнения со сроком открытия чата дня X — не в отрисовке
     (D4-22), а вместе с опросом: снятое один раз при монтировании оно
     держало «Откроется 14 июня 09:00» и после девяти, пока экран не
     перемонтируют (RF-05, R-171). */
  const [now, setNow] = useState(() => Date.now())
  /* Список тоже перечитывается сам. Живого канала у него нет — он не про
     конкретный чат, — но человек, оставивший экран открытым, иначе не увидит
     ни новой реплики, ни значка непрочитанного, пока не уйдёт и не вернётся. */
  const list = useApi(() => getChats(), [])
  /* Опрос — через `reload()`, а не через счётчик в зависимостях: смена
     зависимостей для `useApi` — «другой запрос», список пустел с «Загружаем…»
     каждые полминуты (тот же класс, что RF-02 на дне X). */
  const reloadList = useRef(list.reload)
  useEffect(() => { reloadList.current = list.reload })
  useEffect(() => {
    const poll = window.setInterval(() => { setNow(Date.now()); reloadList.current() }, 30_000)
    return () => window.clearInterval(poll)
  }, [])
  const chats = list.data ?? []
  const shown = chats.filter(c =>
    (c.title ?? '').toLowerCase().includes(q.toLowerCase()) ||
    (c.lastMessage ?? '').toLowerCase().includes(q.toLowerCase()))

  return (
    <div className="pb-28">
      <TopBar back title={t('Чаты')} sub={t('Подрядчики · команда · день X')} />
      <AsyncState q={list} />
      <div className="px-5 mt-3">
        <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder={t('Поиск по чатам…')} className="w-full card-s px-4 py-3 text-[13px] outline-none placeholder:text-[var(--soft2)]" />
      </div>
      {!chats.length && ready(list) && (
        <p className="px-5 mt-4 text-[12.5px] text-[var(--soft)] leading-relaxed">
          {t('Чатов пока нет. Они появляются, когда вы пишете подрядчику из каталога или собираете команду свадьбы.')}
        </p>
      )}
      <div className="px-5 mt-3 space-y-2.5 stagger">
        {shown.map(c => (
          <button key={c.id} onClick={() => nav(`/us/chats/${c.id}`)} className="press w-full card-s p-3.5 flex items-center gap-3 text-left fade-up">
            <Tile icon={CHAT_ICON[c.kind ?? ''] ?? '💬'} tile={CHAT_TILE[c.kind ?? ''] ?? 'bg-[var(--track)]'} size={48} />
            <div className="flex-1 min-w-0">
              <div className="flex justify-between items-baseline gap-2">
                <b className="text-[13.5px] truncate">{c.title}</b>
                {/* Чат убранного своего подрядчика: читать можно, писать некому
                    (`Chat.closed`, фича 005) — строка говорит это до открытия. */}
                {c.closed && <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-[var(--track)] text-[var(--track-ink)] shrink-0">{t('закрыт')}</span>}
              </div>
              {/* Чат дня X до срока закрыт — вместо реплики говорим, когда он
                  откроется. Пустая строка читалась бы как «сообщений нет». */}
              <p className="text-[11.5px] text-[var(--soft)] truncate mt-0.5">
                {c.kind === 'day' && c.openFrom && new Date(c.openFrom).getTime() > now
                  ? `${t('Откроется')} ${new Date(c.openFrom).toLocaleString(getI18nLang() === 'en' ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`
                  : c.lastMessage || t('Сообщений пока нет')}
              </p>
            </div>
            {!!c.unread && <span className="w-5 h-5 rounded-full grad text-[var(--on-grad)] text-[10px] font-bold flex items-center justify-center shrink-0">{c.unread}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

const CHAT_ICON: Record<string, string> = {
  vendor: '💼', external: '🤝', team: '💍', crew: '🛠', day: '🥂', tilly: '✦',
}

const CHAT_TILE: Record<string, string> = {
  vendor: 'bg-[var(--rose-soft)]',
  external: 'bg-[var(--peach)]',
  team: 'bg-[var(--sage-soft)]',
  crew: 'bg-[var(--lav)]',
  day: 'bg-[var(--honey)]',
  tilly: 'bg-[var(--blue)]',
}

/*
 * Диалог.
 *
 * Раньше собеседник был таймером: через 1,6 секунды после отправки экран сам
 * дописывал «Отлично, принято! Отвечу подробно чуть позже сегодня 🙌». Человек
 * видел ответ, которого никто не писал, и ждал того, чего не будет.
 *
 * Теперь история и отправка идут на сервер, а доставка — двумя путями. Живой
 * канал отдаёт событие сразу; если его нет (Redis не поднят, сеть режет
 * соединение, вкладка в фоне) — опрос раз в 30 секунд, штатный запасной путь
 * §13.4. Оба пути делают одно и то же: перечитывают хвост истории.
 */
/*
 * Системную запись (предупреждение платформы о выводе сделки мимо договора,
 * сдвиг тайминга, перенос даты) сервер помечает `Message.system` (контракт
 * v0.29.0, фича 005). До этого экран узнавал её по тексту — держал копию
 * серверного `PAYOUT_WARNING` и сверял слово в слово (D4-15); любая другая
 * системная запись рисовалась репликой «участник вышел».
 */

type MessagesPage = NonNullable<Awaited<ReturnType<typeof getMessages>>>
type Message = NonNullable<MessagesPage['items']>[number]
/** Страница старше курсора: та же выборка, что и хвост, но «до» указанной точки (D4-09). */
const getMessagesBefore = (chatId: string, cursor: string) =>
  api.get(`${url('/chats/{chatId}/messages', { chatId })}?cursor=${encodeURIComponent(cursor)}&limit=50` as '/chats/{chatId}/messages')

/*
 * Всё, что экран уже видел в этом чате, по идентификатору: хвост при каждом
 * перечитывании и дочитанные страницы. Один общий склад, а не «хвост плюс
 * старые страницы»: хвост — последние 50, и когда приходят новые реплики,
 * прежние выпадают из него; без склада между хвостом и дочитанным появлялась
 * бы дыра. `next`: `undefined` — ещё не листали, курсор берётся из хвоста;
 * `null` — дочитано до начала. Привязано к чату, чтобы не пережить его смену.
 */
type History = { chatId: string; byId: Record<string, Message>; next: string | null | undefined }
const NO_HISTORY: History = { chatId: '', byId: {}, next: undefined }

/** Хронологический порядок: сервер отдаёт свежие первыми, в переписке последняя реплика внизу. */
const bySentAt = (a: Message, b: Message) =>
  (a.sentAt ?? '').localeCompare(b.sentAt ?? '') || (a.id ?? '').localeCompare(b.id ?? '')

export function Chat() {
  const { id } = useParams()
  const nav = useNavigate()
  const chatId = id ?? ''
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [peerTyping, setPeerTyping] = useState(false)
  const [live, setLive] = useState(false)

  const chats = useApi(() => getChats(), [])
  /* Чат ищем среди своих: чужой идентификатор в адресе не должен открывать
     пустую переписку с работающим полем ввода. */
  const chat = (chats.data ?? []).find(c => c.id === chatId)
  const missing = !!chatId && ready(chats) && !chat
  /*
   * Хвост истории — последние 50. 423 здесь не отказ, а расписание: чат дня X
   * до срока закрыт (D4-11). Раньше расписанием считалась ЛЮБАЯ ошибка
   * истории у чата дня — и в день свадьбы при обрыве сети пара читала
   * «откроется 13 июня 09:00» (прошедшую дату) вместо «нет связи».
   */
  const [historyState, setHistory] = useState<History>(NO_HISTORY)
  const history = historyState.chatId === chatId ? historyState : NO_HISTORY
  /** Положить страницу на склад; `next` меняется только у страниц, прочитанных курсором. */
  const remember = (items: Message[], next?: string | null) => setHistory(prev => {
    const base = prev.chatId === chatId ? prev : NO_HISTORY
    const byId = { ...base.byId }
    for (const m of items) if (m.id) byId[m.id] = m
    return { chatId, byId, next: next === undefined ? base.next : next }
  })
  const q = useApi<MessagesPage | { locked: true } | null>(
    () => chatId
      ? getMessages(chatId)
        .then(page => { remember(page?.items ?? []); return page })
        .catch((e: unknown) => {
          if (e instanceof ApiError && e.status === 423) return { locked: true as const }
          throw e
        })
      : Promise.resolve(null),
    [chatId],
  )
  /* Перечитывание хвоста — `reload()`: по событию сокета, по опросу и после
     отправки данные остаются на экране, «Загружаем…» сверху не мигает. */
  const reloadTail = useRef(q.reload)
  useEffect(() => { reloadTail.current = q.reload })
  const tail = q.data && 'items' in q.data ? q.data : null
  const locked = !!q.data && 'locked' in q.data
  /*
   * Старые страницы — курсором, а не ростом `limit` (D4-09): сервер режет
   * `limit` до 100, и кнопка «раньше» после второго нажатия ничего не меняла,
   * а сообщения старше сотого прочитать было нельзя. Дописываем сверху.
   */
  const [moreBusy, setMoreBusy] = useState(false)
  const [moreErr, setMoreErr] = useState<string | null>(null)
  const nextCursor = history.next === undefined ? (tail?.nextCursor ?? null) : history.next
  const loadEarlier = async () => {
    if (!nextCursor || moreBusy) return
    setMoreBusy(true); setMoreErr(null)
    try {
      const page = await getMessagesBefore(chatId, nextCursor)
      remember(page?.items ?? [], page?.nextCursor ?? null)
    } catch (e) { setMoreErr(explainError(e)) } finally { setMoreBusy(false) }
  }
  /* Хвост добавляем и здесь: его ответ и запись на склад приходят одной
     пачкой, но полагаться на порядок обновлений состояния незачем. */
  const merged: Record<string, Message> = { ...history.byId }
  for (const m of tail?.items ?? []) if (m.id) merged[m.id] = m
  const messages = Object.values(merged).sort(bySentAt)

  const me = useApi(() => getMe(), [])
  const myId = me.data?.id
  /* Для обработчика канала: он создаётся один раз на чат, а свой идентификатор
     приходит позже. */
  const myIdRef = useRef<string | undefined>(undefined)
  myIdRef.current = myId

  /* Живой канал и опрос — один механизм: оба просто просят перечитать хвост.
     Опрос не выключается при живом канале нарочно: обрыв соединения проходит
     молча, и без опроса чат тихо застывает. */
  useEffect(() => {
    if (!chatId) return
    const close = openChatSocket(
      chatId,
      e => {
        if (e.type === 'message') reloadTail.current()
        /* Хаб доставляет событие и его автору (D4-08): без сравнения три точки
           «печатает» появлялись под собственным полем ввода при каждом
           нажатии клавиши. Пока свой идентификатор неизвестен — не показываем:
           утверждать «собеседник печатает», не зная, кто это, нельзя. */
        if (e.type === 'typing' && myIdRef.current && e.actorId !== myIdRef.current) {
          setPeerTyping(true)
          window.setTimeout(() => setPeerTyping(false), 4000)
        }
      },
      /* Состояние канала сообщает он сам. Раньше экран выводил его из
         пришедшего события и больше не менял: сокет закрывался вместе с
         истечением токена, а подпись до конца сеанса обещала «связь живая». */
      setLive,
    )
    const poll = window.setInterval(() => reloadTail.current(), 30_000)
    return () => { close(); window.clearInterval(poll) }
  }, [chatId])

  /* Прокрутка к последней реплике: без неё новое сообщение приходит за край
     экрана, и человек видит старую переписку, считая, что ничего не пришло. */
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /* Прыгаем вниз на новую реплику, а не на любое изменение списка: подгрузка
     старых сообщений добавляет их сверху, и прыжок вниз отбросил бы человека
     от того места, куда он поднялся. */
  const lastId = messages[messages.length - 1]?.id
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lastId, peerTyping])

  /* «Печатает…» уходит не на каждую букву: событие живёт секунды, а запросов
     на каждый символ было бы столько же, сколько нажатий. */
  const typingSentAt = useRef(0)
  const onType = (value: string) => {
    setText(value)
    const now = Date.now()
    if (value.trim() && now - typingSentAt.current > 3000) {
      typingSentAt.current = now
      void sendTyping(chatId).catch(() => undefined)
    }
  }

  const send = () => void (async () => {
    const body = text.trim()
    if (!body || sending) return
    setSending(true)
    setErr(null)
    try {
      await sendMessage(chatId, body)
      setText('')
      reloadTail.current()
    } catch (e) { setErr(explainError(e)) } finally { setSending(false) }
  })()

  /* Два состояния, которые не являются поломкой и требуют своих слов.
     Чат дня X до срока закрыт (423, см. `locked` выше) — это расписание, а не
     отказ. Чат исполнителей пара не читает вовсе (403): его ведёт координатор
     без неё (решение владельца 2026-09-03), и общий текст «у вашей роли нет
     доступа» здесь врёт — роль как раз её. */
  const closedToMe = q.forbidden
  /* Свой подрядчик убран — сделка отменена, чат закрыт (`Chat.closed`,
     контракт v0.29.0): переписка остаётся паре для чтения, писать некому.
     Поле ввода закрыто заранее — иначе первое же слово получало бы 409
     `chat_closed` (фича 005). Список пришёл без чата, а сервер всё же
     отказал — его текст показывается словами, как любой отказ отправки. */
  const closedChat = !!chat?.closed

  if (!chatId || missing) return (
    <div className="pb-28">
      <TopBar back title={t('Чат')} />
      <p className="px-5 mt-6 text-[13px] text-[var(--soft)]">{t('Такого чата у вас нет')}</p>
    </div>
  )

  return (
    <div className="h-dvh flex flex-col">
      <div className="glass-tab border-t-0 border-b px-4 pt-6 pb-3 flex items-center gap-3 z-10">
        <button onClick={() => goBack(n => nav(n), (to, o) => nav(to, o), '/us/chats')} className="press w-9 h-9 rounded-full bg-[var(--card)] flex items-center justify-center" style={{ boxShadow: 'var(--shadow)' }} aria-label={t('Назад')}>
          <ChevronLeft size={17} />
        </button>
        <Tile icon={CHAT_ICON[chat?.kind ?? ''] ?? '💬'} tile={CHAT_TILE[chat?.kind ?? ''] ?? 'bg-[var(--track)]'} size={38} />
        <div className="flex-1 min-w-0">
          <b className="text-[14px] block truncate">{chat?.title ?? t('Чат')}</b>
          {/* Раньше здесь стояло «● онлайн · сделка: фотограф, 14.06» — у всех
              и всегда. Кто в сети, сервер не сообщает; вместо выдумки говорим
              то, что знаем: доходят ли события живым каналом. */}
          <span className="text-[10px] text-[var(--soft)]">{live ? t('связь живая') : t('обновление раз в 30 секунд')}</span>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-2.5">
        {closedToMe ? (
          <p className="text-center text-[12.5px] text-[var(--soft)] px-6 mt-6 leading-relaxed">
            {chat?.kind === 'crew'
              ? t('Эту переписку ведёт координатор с подрядчиками — без вас. Вы видите, что она есть, но не читаете её.')
              : t('Эта переписка закрыта для вашей роли.')}
          </p>
        ) : locked ? (
          <p className="text-center text-[12.5px] text-[var(--soft)] px-6 mt-6 leading-relaxed">
            {chat?.openFrom
              ? `${t('Чат дня свадьбы откроется')} ${new Date(chat.openFrom).toLocaleString(getI18nLang() === 'en' ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`
              : t('Чат дня свадьбы ещё закрыт')}
          </p>
        ) : (
          <>
            <AsyncState q={q} />
            {/* Сервер сказал, что есть ещё — значит история не начинается
                здесь, и человек должен это видеть. Следующая страница — по
                курсору последней прочитанной (D4-09). */}
            {nextCursor && (
              <div className="text-center">
                <button onClick={() => void loadEarlier()} disabled={moreBusy} className="press text-[11px] font-semibold text-[var(--soft)] bg-[var(--card)] px-4 py-2 rounded-full disabled:opacity-50" style={{ boxShadow: 'var(--shadow)' }}>
                  {moreBusy ? t('Загружаем…') : t('Показать сообщения раньше')}
                </button>
              </div>
            )}
            {moreErr && <p role="alert" className="text-center text-[11px] text-[var(--rose-ink)]">{moreErr}</p>}
            {!messages.length && ready(q) && (
              <p className="text-center text-[12px] text-[var(--soft)] py-6">{t('Сообщений пока нет — напишите первым')}</p>
            )}
            {messages.map(m => {
              const mine = !!myId && m.senderId === myId
              /* Системная запись — по признаку сервера, не по тексту: «⚠ Заеду
                 за тортом в 12» читалось как предупреждение платформы, а сдвиг
                 тайминга рисовался репликой ушедшего (D4-15, фича 005).
                 Показывать её пузырём собеседника нельзя: пара прочтёт как
                 слова подрядчика. Пустой отправитель у остальных значит
                 разное (так написано в контракте): у своего подрядчика — это
                 он сам, аккаунта у него нет; у Тиль — сама Тиль; в остальных —
                 человек, чей аккаунт стёрт: `messages.sender_id` обнуляется
                 при удалении пользователя. */
              const system = m.system === true
              const anonymous = !system && m.senderId === null && chat?.kind !== 'external' && chat?.kind !== 'tilly'
              if (system) return (
                <p key={m.id} className="text-center text-[11px] text-[var(--soft)] leading-relaxed px-6 py-2">
                  ⚠ {m.text}
                </p>
              )
              return (
                <div key={m.id} className={cn('flex fade-up', mine ? 'justify-end' : 'justify-start')}>
                  <div className={cn('max-w-[78%] px-4 py-3 text-[13px] leading-relaxed',
                    mine ? 'grad text-[var(--on-grad)] rounded-br-[6px]' : 'card rounded-bl-[6px] text-[var(--ink)]')}
                    style={{ borderRadius: 18 }}>
                    {anonymous && <span className="block text-[9.5px] text-[var(--soft)] mb-1">{t('Участник вышел')}</span>}
                    {/* Предупреждение о выводе сделки мимо платформы (§18.2)
                        приходит отдельным системным сообщением от сервера — его
                        видят обе стороны, и рисовать его на пузыре не нужно. */}
                    {m.text}
                    <span className={cn('block text-[9px] mt-1 text-right', mine ? 'text-white/70' : 'text-[var(--soft)]')}>
                      {m.sentAt ? new Date(m.sentAt).toLocaleTimeString(getI18nLang() === 'en' ? 'en-GB' : 'ru-RU', { hour: '2-digit', minute: '2-digit' }) : ''}
                    </span>
                  </div>
                </div>
              )
            })}
            {peerTyping && (
              <div className="flex justify-start fade-up">
                <div className="card rounded-[18px] px-4 py-3 flex gap-1">
                  {[0, 1, 2].map(d => <span key={d} className="w-1.5 h-1.5 rounded-full bg-[var(--rose)] animate-bounce" style={{ animationDelay: `${d * 0.15}s` }} />)}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {err && <p role="alert" className="px-5 pb-2 text-[12px] text-[var(--rose-ink)]">{err}</p>}
      {closedChat ? (
        <p className="glass-tab border-t-0 border-b-0 px-5 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] text-center text-[11.5px] text-[var(--soft)] leading-relaxed">
          {t('Подрядчик убран — переписка осталась для чтения, писать больше некому')}
        </p>
      ) : !locked && !closedToMe && (
        <div className="glass-tab border-t-0 border-b-0 px-4 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] flex gap-2.5">
          {/* Кнопки вложения нет: она добавляла строку «📷 Референс_букета.jpg ·
              2,4 МБ» в переписку, хотя файл никуда не уходил. Вложения появятся
              вместе с файловым хранилищем. */}
          <input value={text} onChange={e => onType(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()}
            placeholder={t('Сообщение…')} className="flex-1 bg-[var(--card)] rounded-full px-5 h-[48px] text-[13.5px] outline-none placeholder:text-[var(--soft2)]" style={{ boxShadow: 'var(--shadow)' }} />
          <button disabled={sending || !text.trim()} onClick={send} className="press w-[48px] h-[48px] rounded-full grad text-[var(--on-grad)] flex items-center justify-center shrink-0 disabled:opacity-40" aria-label={t('Отправить')}><Send size={17} /></button>
        </div>
      )}
    </div>
  )
}
