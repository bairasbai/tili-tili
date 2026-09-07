import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ChevronRight, ClipboardCheck, Flag, Search, Tags } from 'lucide-react'
import { Tile, TopBar } from '@/components/chrome'
import { AsyncState, num, ready } from '@/components/AsyncState'
import { explainError, useApi } from '@/lib/api/useApi'
import { ApiError } from '@/lib/api/client'
import { t } from '@/lib/i18n'
import { getVendor } from '@/lib/api/catalog'
import {
  getAdminCategories,
  getAdminMetrics,
  getComplaints,
  getModerationQueue,
  getWeddingForSupport,
  type WeddingSupportCard,
} from '@/lib/api/admin'

/*
 * Панель сотрудника платформы (План §19.10, экраны 63–67).
 *
 * Шесть экранов одного раздела в одном файле и одном чанке — как кабинет
 * подрядчика: сотрудников на платформе единицы, и качать этот код паре,
 * которая сюда никогда не зайдёт, незачем.
 *
 * Права проверяет сервер: на любой адрес панели посторонний получает 403, и
 * экран показывает один и тот же отказ без единой цифры. Различать «не
 * сотрудник» и «нет согласия» здесь не нужно: без согласия человек не вошёл бы
 * в приложение вовсе (R-182).
 */

/** Один и тот же отказ на всех адресах панели. Внутри функции — чтобы язык менялся. */
const denied = () => t('Раздел для сотрудников платформы')

/* ── 63. Главная панели ───────────────────────────────────────────────── */
/*
 * Дашборд и вход в разделы.
 *
 * Показатели считает сервер. Пока ответа нет — прочерк, а не ноль: «0 жалоб»
 * рядом с «Сервер недоступен» читается как «жалоб нет», и очередь стоит
 * незамеченной (R-178). Полный дашборд — фаза 5.
 */
export function AdminHome() {
  const nav = useNavigate()
  const q = useApi(() => getAdminMetrics(), [])
  const m = q.data

  /* Постороннему — отказ и ничего больше: ни показателей, ни ссылок на
     разделы, которые ему всё равно не откроются (FR-001). */
  if (q.forbidden) return (
    <div className="pb-10">
      <TopBar title={t('Платформа')} />
      <AsyncState q={q} forbiddenText={denied()} />
    </div>
  )

  return (
    <div className="pb-10">
      <TopBar title={t('Платформа')} sub={t('Панель сотрудника')} />
      <div className="px-5 mt-3">
        <AsyncState q={q} forbiddenText={denied()} />

        <div className="card p-4 grid grid-cols-3 gap-2 text-center fade-up">
          {[
            /* `?? '—'` не «ноль по умолчанию»: если сервер поля не прислал,
               показывать нечего, а ноль был бы утверждением. */
            { label: t('Анкет в очереди'), value: num(q, m?.moderationQueue ?? '—') },
            { label: t('Жалоб открыто'), value: num(q, m?.complaintsOpen ?? '—') },
            { label: t('Просрочено'), value: num(q, m?.complaintsOverdue ?? '—') },
          ].map(it => (
            <div key={it.label}>
              <b className="font-serif-d text-[22px] block">{it.value}</b>
              <span className="text-[9.5px] text-[var(--soft)] leading-tight block mt-0.5">{it.label}</span>
            </div>
          ))}
        </div>

        {/* Разделы панели. Порядок — по частоте разбора: очереди сверху,
            справочник и поддержка ниже. */}
        <div className="card px-4 py-1.5 mt-3.5">
          {[
            { icon: ClipboardCheck, tile: 'bg-[var(--sage-soft)]', to: '/admin/moderation', label: t('Модерация анкет'), sub: t('Новые анкеты: одобрить, снять с публикации, отметить проверенным') },
            { icon: Flag, tile: 'bg-[var(--rose-soft)]', to: '/admin/complaints', label: t('Жалобы'), sub: t('Нерассмотренные жалобы и санкции') },
            { icon: Tags, tile: 'bg-[var(--lav)]', to: '/admin/categories', label: t('Категории и синонимы'), sub: t('Названия, значки, порядок и словарь поиска') },
            { icon: Search, tile: 'bg-[var(--blue)]', to: '/admin/wedding', label: t('Карточка свадьбы'), sub: t('Просмотр по обращению пары — записывается в журнал') },
          ].map(it => (
            <button key={it.to} onClick={() => nav(it.to)} className="press w-full flex items-center gap-3 py-3.5 text-left border-b border-[var(--track)] last:border-none">
              <Tile icon="" tile={it.tile} size={38} />
              <span className="absolute ml-3"><it.icon size={16} className="text-[var(--ink2)]" /></span>
              <span className="flex-1 min-w-0 ml-1">
                <b className="text-[13px] font-medium block">{it.label}</b>
                <span className="text-[10.5px] text-[var(--soft)] block mt-0.5">{it.sub}</span>
              </span>
              <ChevronRight size={16} className="text-[var(--soft2)] shrink-0" />
            </button>
          ))}
        </div>

        <p className="text-[10.5px] text-[var(--soft2)] leading-relaxed mt-4">
          {t('Каждое решение записывается в журнал действий: кто, когда и что сделал. Из журнала нельзя ничего удалить.')}
        </p>
      </div>
    </div>
  )
}

/* ── 64. Очередь модерации анкет ──────────────────────────────────────── */
export function AdminModeration() {
  const nav = useNavigate()
  const q = useApi(() => getModerationQueue(), [])
  const items = q.data?.items ?? []
  return (
    <div className="pb-10">
      <TopBar back fallback="/admin" title={t('Модерация анкет')} sub={t('Опубликованные и ещё не проверенные')} />
      <div className="px-5 mt-3 space-y-2.5">
        <AsyncState q={q} forbiddenText={denied()} />
        {ready(q) && items.length === 0 && (
          <p className="text-[12.5px] text-[var(--soft)] py-6 text-center">{t('Очередь пуста — все анкеты проверены')}</p>
        )}
        {ready(q) && items.map(v => (
          <button key={v.id} onClick={() => nav(`/admin/moderation/${v.id ?? ''}`)} className="press w-full card p-4 text-left flex items-center gap-3">
            <span className="flex-1 min-w-0">
              <b className="font-serif-d text-[15px] block truncate">{v.name}</b>
              {/* Категория приходит идентификатором (`photo`), а не подписью:
                  названия живут в справочнике, и подтягивает их фаза 3. */}
              <span className="text-[10.5px] text-[var(--soft)] block mt-0.5">{v.city}</span>
            </span>
            <ChevronRight size={16} className="text-[var(--soft2)] shrink-0" />
          </button>
        ))}
      </div>
    </div>
  )
}

/* ── 64а. Анкета в очереди: решение ───────────────────────────────────── */
/*
 * Карточка читается из каталога: очередь отдаёт короткую запись без описания
 * и медиа, а модератор проверяет именно их. Заблокированной анкеты в каталоге
 * нет — экран скажет об этом словами, а не покажет пустоту.
 */
export function AdminVendorDecision() {
  const { vendorId } = useParams()
  const q = useApi(() => (vendorId ? getVendor(vendorId) : Promise.resolve(null)), [vendorId])
  const v = q.data
  return (
    <div className="pb-10">
      {/* Подзаголовка «Решение модератора» здесь пока нет: действий на экране
          тоже нет, а обещать решение без кнопок — обещание за код (R-174).
          Три действия приезжают в фазе 3. */}
      <TopBar back fallback="/admin" title={v?.name ?? t('Анкета')} />
      <div className="px-5 mt-3">
        <AsyncState q={q} forbiddenText={denied()} />
        {ready(q) && !v && (
          <p className="text-[12.5px] text-[var(--soft)] py-6 text-center leading-relaxed">{t('Анкета недоступна в каталоге')}</p>
        )}
        {ready(q) && v && (
          <div className="card p-4">
            <span className="text-[10.5px] text-[var(--soft)]">{v.city}</span>
            {v.about && <p className="text-[12.5px] text-[var(--ink2)] leading-relaxed mt-2">{v.about}</p>}
          </div>
        )}
      </div>
    </div>
  )
}

/* ── 65. Очередь жалоб ────────────────────────────────────────────────── */
/* Коды жалобы — не подписи: `no_show` на экране читается как поломка. */
const targetLabel = (kind: string | undefined) =>
  kind === 'vendor' ? t('подрядчик')
  : kind === 'review' ? t('отзыв')
  : kind === 'message' ? t('сообщение')
  : kind === 'deal' ? t('сделка')
  : ''

const reasonLabel = (category: string | undefined) =>
  category === 'fraud' ? t('мошенничество')
  : category === 'content' ? t('содержание')
  : category === 'no_show' ? t('не пришёл')
  : category === 'spam' ? t('спам')
  : ''

export function AdminComplaints() {
  const q = useApi(() => getComplaints(), [])
  const items = q.data?.items ?? []
  return (
    <div className="pb-10">
      <TopBar back fallback="/admin" title={t('Жалобы')} sub={t('Нерассмотренные, старейшие сверху')} />
      <div className="px-5 mt-3 space-y-2.5">
        <AsyncState q={q} forbiddenText={denied()} />
        {ready(q) && items.length === 0 && (
          <p className="text-[12.5px] text-[var(--soft)] py-6 text-center">{t('Нерассмотренных жалоб нет')}</p>
        )}
        {ready(q) && items.map(c => (
          <div key={c.id} className="card p-4">
            <b className="text-[13px] block">{reasonLabel(c.category)}</b>
            <span className="text-[10.5px] text-[var(--soft)] block mt-0.5">{targetLabel(c.targetKind)}</span>
            {c.text && <p className="text-[12.5px] text-[var(--ink2)] leading-relaxed mt-2">{c.text}</p>}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── 66. Категории и словарь синонимов ────────────────────────────────── */
export function AdminCategories() {
  const q = useApi(() => getAdminCategories(), [])
  const categories = q.data?.categories ?? []
  const synonyms = Object.entries(q.data?.synonyms ?? {})
  return (
    <div className="pb-10">
      <TopBar back fallback="/admin" title={t('Категории')} sub={t('Справочник и словарь поиска')} />
      <div className="px-5 mt-3 space-y-3">
        <AsyncState q={q} forbiddenText={denied()} />
        {ready(q) && (
          <>
            <div className="card px-4 py-1.5">
              {categories.map(c => (
                <div key={c.id} className="flex items-center gap-3 py-3 border-b border-[var(--track)] last:border-none">
                  <span className="text-[18px] w-7 text-center">{c.icon}</span>
                  <b className="flex-1 text-[13px] font-medium truncate">{c.title}</b>
                  <span className="text-[10.5px] text-[var(--soft2)]">{c.id}</span>
                </div>
              ))}
            </div>
            <span className="text-[10px] tracking-[.16em] uppercase text-[var(--soft)] font-semibold px-1 block">{t('Словарь синонимов')}</span>
            <div className="card px-4 py-1.5">
              {synonyms.length === 0 && (
                <p className="text-[12.5px] text-[var(--soft)] py-3">{t('Словарь пуст — поиск ищет только по названиям')}</p>
              )}
              {synonyms.map(([word, categoryId]) => (
                <div key={word} className="flex items-center gap-3 py-3 border-b border-[var(--track)] last:border-none">
                  <b className="flex-1 text-[13px] font-medium truncate">{word}</b>
                  <span className="text-[10.5px] text-[var(--soft2)]">{categoryId}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ── 67. Карточка свадьбы по обращению ────────────────────────────────── */
/*
 * Просмотр чужой свадьбы возможен только с причиной: она уходит в журнал
 * вместе с именем сотрудника. Пока причина короче пяти знаков, кнопка
 * неактивна — сервер такой запрос всё равно не примет.
 */
/** Что показывает экран после нажатия. Ошибка — текстом сервера, отказ — общим отказом панели. */
type WeddingLookup =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'error'; text: string }
  | { kind: 'forbidden' }
  | { kind: 'card'; card: WeddingSupportCard }

export function AdminWedding() {
  const [wid, setWid] = useState('')
  const [reason, setReason] = useState('')
  /* Запрос уходит только по нажатию — из обработчика кнопки, а не из
     эффекта по состоянию: подставлять чужую свадьбу на каждую набранную
     букву значит писать в журнал десяток просмотров вместо одного, а кнопка
     обязана сама делать то, что на ней написано (R-176). */
  const [look, setLook] = useState<WeddingLookup>({ kind: 'idle' })
  const valid = wid.trim().length > 0 && reason.trim().length >= 5

  const lookUp = () => void (async () => {
    setLook({ kind: 'busy' })
    try {
      const card = await getWeddingForSupport(wid.trim(), reason.trim())
      if (card) setLook({ kind: 'card', card })
      else setLook({ kind: 'error', text: t('Свадьба не найдена') })
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setLook({ kind: 'forbidden' })
      else if (e instanceof ApiError && e.status === 404) setLook({ kind: 'error', text: t('Свадьба не найдена') })
      else setLook({ kind: 'error', text: explainError(e) })
    }
  })()

  /* Отказ снимает и форму: предлагать ввести причину тому, кому раздел
     закрыт, значит обещать просмотр, которого не будет (FR-001). */
  if (look.kind === 'forbidden') return (
    <div className="pb-10">
      <TopBar back fallback="/admin" title={t('Карточка свадьбы')} />
      <p className="text-[12px] text-[var(--soft)] py-6 text-center leading-relaxed px-6">{denied()}</p>
    </div>
  )

  return (
    <div className="pb-10">
      <TopBar back fallback="/admin" title={t('Карточка свадьбы')} sub={t('Только по обращению пары')} />
      <div className="px-5 mt-3 space-y-3">
        <div className="card p-4 space-y-2.5">
          <input
            value={wid}
            onChange={e => setWid(e.target.value)}
            aria-label={t('Идентификатор свадьбы')}
            placeholder={t('Идентификатор свадьбы')}
            className="w-full h-11 px-4 rounded-full bg-[var(--bg)] text-[13px] outline-none placeholder:text-[var(--soft2)]"
          />
          <input
            value={reason}
            onChange={e => setReason(e.target.value)}
            maxLength={500}
            aria-label={t('Зачем смотрим')}
            placeholder={t('Зачем смотрим: номер обращения или его суть')}
            className="w-full h-11 px-4 rounded-full bg-[var(--bg)] text-[13px] outline-none placeholder:text-[var(--soft2)]"
          />
          <p className="text-[10.5px] text-[var(--soft)] leading-relaxed">{t('Просмотр записывается: кто, когда и зачем смотрел.')}</p>
          <button
            disabled={!valid || look.kind === 'busy'}
            onClick={lookUp}
            className="press w-full h-[46px] rounded-full grad text-[var(--on-grad)] text-[13px] font-semibold disabled:opacity-50"
          >
            {look.kind === 'busy' ? t('Открываем…') : t('Открыть карточку')}
          </button>
          {look.kind === 'error' && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{look.text}</p>}
        </div>

        {look.kind === 'card' && (
          <div className="card p-4">
            <b className="font-serif-d text-[17px] block">{look.card.title}</b>
            <span className="text-[10.5px] text-[var(--soft)] block mt-1">{[look.card.city, look.card.date, look.card.style].filter(Boolean).join(' · ')}</span>
          </div>
        )}
      </div>
    </div>
  )
}
