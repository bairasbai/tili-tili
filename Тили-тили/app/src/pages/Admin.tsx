import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'
import { ChevronRight, ClipboardCheck, ConciergeBell, Flag, Plus, Search, ShieldCheck, Tags, Trash2 } from 'lucide-react'
import { Tile, TopBar } from '@/components/chrome'
import { AsyncState, num, ready } from '@/components/AsyncState'
import { explainError, useApi } from '@/lib/api/useApi'
import { ApiError } from '@/lib/api/client'
import { getI18nLang, t } from '@/lib/i18n'
import { fmt } from '@/lib/money'
import { plural } from '@/lib/utils'
import { useEscape } from '@/lib/useEscape'
import { getCategories, getVendor } from '@/lib/api/catalog'
import { getMe } from '@/lib/api/auth'
import {
  decideComplaint,
  decideConcierge,
  decideVendor,
  decideVerification,
  getAdminCategories,
  getAdminMetrics,
  getComplaints,
  getConcierge,
  getModerationQueue,
  getVerification,
  getVerifications,
  getWeddingDealsForSupport, getWeddingForSupport,
  putAdminCategories,
  type AdminCategory,
  type SupportDeal, type WeddingSupportCard,
} from '@/lib/api/admin'

/*
 * Панель сотрудника платформы (План §19.10, экраны 63–67).
 *
 * Шесть экранов одного раздела в одном файле и одном чанке — как кабинет
 * подрядчика: сотрудников на платформе единицы, и качать этот код паре,
 * которая сюда никогда не зайдёт, незачем.
 *
 * Права проверяет сервер: на любой адрес `/admin/*` посторонний получает 403, и
 * экран показывает один и тот же отказ без единой цифры. Различать «не
 * сотрудник» и «нет согласия» здесь не нужно: без согласия человек не вошёл бы
 * в приложение вовсе (R-182).
 *
 * Исключение — решение по анкете: её карточку отдаёт публичный каталог, и 403
 * там не наступает. Этот экран спрашивает право сам, отдельным запросом.
 */

/** Один и тот же отказ на всех адресах панели. Внутри функции — чтобы язык менялся. */
const denied = () => t('Раздел для сотрудников платформы')

/** Локаль дат — по языку интерфейса, а не «ru-RU» навсегда (R-12). */
const dateLocale = () => (getI18nLang() === 'en' ? 'en-GB' : 'ru-RU')

/** Дата с сервера словами. Пусто — значит сервер её не прислал, и выдумывать нечего. */
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat(dateLocale(), { day: 'numeric', month: 'long', year: 'numeric' }).format(d)
}

/** То же с часами: у жалобы важен не только день — срок разбора считается в часах. */
function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat(dateLocale(), { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(d)
}

/* ── 63. Главная панели ───────────────────────────────────────────────── */
/*
 * Дашборд и вход в разделы.
 *
 * Показатели считает сервер. Пока ответа нет — прочерк, а не ноль: «0 жалоб»
 * рядом с «Сервер недоступен» читается как «жалоб нет», и очередь стоит
 * незамеченной (R-178). Ноль ПОСЛЕ ответа — это ноль, его и показываем.
 */
export function AdminHome() {
  const nav = useNavigate()
  const q = useApi(() => getAdminMetrics(), [])
  const m = q.data
  const cities = m?.cities ?? []

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

        {/* Платформа: сколько всего людей и анкет. Три плитки — ровно один
            ряд, без хвоста из одной клетки. */}
        <div className="card p-4 grid grid-cols-3 gap-2 text-center fade-up">
          {[
            /* `?? '—'` не «ноль по умолчанию»: если сервер поля не прислал,
               показывать нечего, а ноль был бы утверждением. */
            { label: t('Аккаунтов'), value: num(q, m?.users ?? '—') },
            { label: t('Свадеб'), value: num(q, m?.weddings ?? '—') },
            { label: t('Анкет в каталоге'), value: num(q, m?.vendorsPublished ?? '—') },
          ].map(it => (
            <div key={it.label}>
              <b className="font-serif-d text-[22px] block tabular">{it.value}</b>
              <span className="text-[9.5px] text-[var(--soft)] leading-tight block mt-0.5">{it.label}</span>
            </div>
          ))}
        </div>

        {/* Очереди: то, что ждёт разбора прямо сейчас. Четыре плитки 2×2 — в
            ряду по три четвёртая висела бы одна. */}
        <div className="card p-4 grid grid-cols-2 gap-2 text-center mt-2.5">
          {[
            { label: t('Анкет в очереди'), value: num(q, m?.moderationQueue ?? '—') },
            { label: t('Заявок на верификацию'), value: num(q, m?.verificationQueue ?? '—') },
            { label: t('Жалоб открыто'), value: num(q, m?.complaintsOpen ?? '—') },
            { label: t('Просрочено'), value: num(q, m?.complaintsOverdue ?? '—') },
          ].map(it => (
            <div key={it.label}>
              <b className="font-serif-d text-[20px] block tabular">{it.value}</b>
              <span className="text-[9.5px] text-[var(--soft)] leading-tight block mt-0.5">{it.label}</span>
            </div>
          ))}
        </div>

        {/* Сделки и оборот — рядом: это один вопрос «сколько платформа
            провела», и разносить их по разным углам незачем. */}
        <div className="card p-4 grid grid-cols-2 gap-2 text-center mt-2.5">
          {[
            { label: t('Сделок'), value: num(q, m?.deals ?? '—') },
            { label: t('Оборот'), value: num(q, m?.gmv?.amount != null ? fmt(m.gmv.amount) : '—') },
          ].map(it => (
            <div key={it.label}>
              <b className="font-serif-d text-[20px] block tabular">{it.value}</b>
              <span className="text-[9.5px] text-[var(--soft)] leading-tight block mt-0.5">{it.label}</span>
            </div>
          ))}
        </div>

        {/* Заполненность опубликованных анкет (фича 012, План §19.10 п. 4): доля
            заполненных из четырёх полей подрядчика — описание, телефон, цена «от»,
            пакет; считает сервер по тому же набору, что «Анкет в каталоге».
            До ответа — прочерки без цифр (R-178). */}
        <div className="card p-4 mt-2.5">
          <span className="text-[10px] tracking-[.16em] uppercase text-[var(--soft)] font-semibold block mb-2">{t('Заполненность анкет')}</span>
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              { label: t('средняя'), value: num(q, m?.profiles?.averagePercent != null ? `${m.profiles.averagePercent}%` : '—') },
              { label: t('полных анкет'), value: num(q, m?.profiles?.complete ?? '—') },
              { label: t('опубликовано'), value: num(q, m?.profiles?.published ?? '—') },
            ].map(it => (
              <div key={it.label}>
                <b className="font-serif-d text-[18px] block tabular">{it.value}</b>
                <span className="text-[9.5px] text-[var(--soft)] leading-tight block mt-0.5">{it.label}</span>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-[var(--soft)] mt-2 leading-relaxed">{t('Заполненность — описание, телефон, цена «от» и хотя бы один пакет; фото не считаются до подключения хранилища')}</p>
        </div>

        {/* Тиль и модель за 30 дней (фича 010): вызовы, ответы модели, токены —
            из учёта `tilly_usage`, только по ответу сервера. Стоимость в рублях
            сервер не считает (цены провайдеров разные) — и экран не выдумывает. */}
        <div className="card p-4 mt-2.5">
          <span className="text-[10px] tracking-[.16em] uppercase text-[var(--soft)] font-semibold block mb-2">{t('Тиль · модель за последний месяц')}</span>
          <div className="grid grid-cols-4 gap-2 text-center">
            {[
              { label: t('Вызовов'), value: num(q, m?.llm?.calls ?? '—') },
              { label: t('Ответов модели'), value: num(q, m?.llm?.answered ?? '—') },
              { label: t('Токенов на вход'), value: num(q, m?.llm?.inputTokens != null ? m.llm.inputTokens.toLocaleString('ru-RU') : '—') },
              { label: t('Токенов на выход'), value: num(q, m?.llm?.outputTokens != null ? m.llm.outputTokens.toLocaleString('ru-RU') : '—') },
            ].map(it => (
              <div key={it.label}>
                <b className="font-serif-d text-[18px] block tabular">{it.value}</b>
                <span className="text-[9.5px] text-[var(--soft)] leading-tight block mt-0.5">{it.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Города — только по ответу сервера: пустой список без ответа читался
            бы как «платформы нет ни в одном городе». */}
        {ready(q) && (
          <>
            <span className="text-[10px] tracking-[.16em] uppercase text-[var(--soft)] font-semibold px-1 block mt-4 mb-2">{t('Города')}</span>
            <div className="card px-4 py-1.5">
              {cities.length === 0 && (
                <p className="text-[12.5px] text-[var(--soft)] py-3">{t('Городов с анкетами пока нет')}</p>
              )}
              {cities.map(c => (
                <div key={c.city} className="flex items-center gap-2.5 py-3 border-b border-[var(--track)] last:border-none">
                  <b className="flex-1 text-[13px] font-medium truncate">{c.city}</b>
                  {c.launchReady && (
                    <span className="text-[9px] font-bold px-2 py-1 rounded-full bg-[var(--sage-soft)] text-[var(--sage-ink)]">{t('готов к запуску')}</span>
                  )}
                  {c.vendors != null && (
                    <span className="text-[10.5px] text-[var(--soft2)] tabular shrink-0">
                      {c.vendors} {plural(c.vendors, t('анкета'), t('анкеты'), t('анкет'))}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {/* Разделы панели. Порядок — по частоте разбора: очереди сверху,
            справочник и поддержка ниже. */}
        <div className="card px-4 py-1.5 mt-3.5">
          {[
            { icon: ClipboardCheck, tile: 'bg-[var(--sage-soft)]', to: '/admin/moderation', label: t('Модерация анкет'), sub: t('Новые анкеты: одобрить, снять с публикации, отметить проверенным') },
            { icon: ShieldCheck, tile: 'bg-[var(--honey)]', to: '/admin/verifications', label: t('Верификация'), sub: t('Заявки на проверку документов: подтвердить или отклонить с причиной') },
            { icon: Flag, tile: 'bg-[var(--rose-soft)]', to: '/admin/complaints', label: t('Жалобы'), sub: t('Нерассмотренные жалобы и санкции') },
            { icon: ConciergeBell, tile: 'bg-[var(--peach)]', to: '/admin/concierge', label: t('Консьерж'), sub: t('Заявки «подобрать вручную»: позвонить паре, отметить подобранное') },
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
/*
 * Страницы копятся, а не сменяют друг друга: «Показать ещё» не должна уносить
 * с экрана то, что модератор уже просмотрел глазами.
 */
type QueuePage = Awaited<ReturnType<typeof getModerationQueue>>

export function AdminModeration() {
  const nav = useNavigate()
  const q = useApi(() => getModerationQueue(), [])
  /* Названия категорий живут в справочнике каталога: очередь отдаёт `photo`,
     а модератор читает «Фотограф». Отдельный запрос со своими состояниями —
     отказ на нём не должен выглядеть как пустая очередь. */
  const cats = useApi(() => getCategories(), [])
  const [pages, setPages] = useState<QueuePage[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const items = [...(q.data?.items ?? []), ...pages.flatMap(p => p.items ?? [])]
  const next = pages.length ? (pages[pages.length - 1]?.nextCursor ?? null) : (q.data?.nextCursor ?? null)
  /* Неизвестная категория показывается своим идентификатором: он пришёл с
     сервера, и это честнее пустого места. */
  const catTitle = (id: string | undefined) => (cats.data ?? []).find(c => c.id === id)?.title ?? id ?? ''

  const more = () => void (async () => {
    if (!next) return
    setBusy(true)
    setErr(null)
    try {
      const page = await getModerationQueue(next)
      setPages(p => [...p, page])
    }
    catch (e) { setErr(explainError(e)) }
    finally { setBusy(false) }
  })()

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
              <span className="text-[10.5px] text-[var(--soft)] block mt-0.5">
                {[catTitle(v.categoryId), v.city, fmtDate(v.publishedAt)].filter(Boolean).join(' · ')}
              </span>
              {v.verified && (
                <span className="inline-block text-[9px] font-bold px-2 py-1 rounded-full bg-[var(--sage-soft)] text-[var(--sage-ink)] mt-1.5">{t('Верифицирован')}</span>
              )}
            </span>
            <ChevronRight size={16} className="text-[var(--soft2)] shrink-0" />
          </button>
        ))}
        {err && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{err}</p>}
        {/* Сервер сказал, что есть ещё, — значит очередь на экране неполная,
            и человек должен это видеть. */}
        {ready(q) && next && (
          <div className="text-center pt-1">
            <button disabled={busy} onClick={more} className="press px-5 h-[40px] rounded-full card-s text-[12px] font-semibold disabled:opacity-50">
              {busy ? t('Загружаем…') : t('Показать ещё')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/* ── 64а. Анкета в очереди: решение ───────────────────────────────────── */
/*
 * Карточка читается из каталога: очередь отдаёт короткую запись без описания
 * и медиа, а модератор проверяет именно их.
 *
 * Условие живой анкеты у сервера и у каталога одно и то же: опубликована и не
 * заблокирована. Поэтому 404 у карточки — это не «карточка не пришла», а
 * «решать нечего»: тот же запрос сервер отклонит с 409. Три кнопки в этом
 * состоянии обещали бы решение, которого не будет (R-176), — их и нет.
 */
export function AdminVendorDecision() {
  const nav = useNavigate()
  const { vendorId } = useParams()
  /* Право здесь спрашивает экран, а не сервер: карточку отдаёт публичный
     `GET /catalog/vendors/{id}`, 403 на нём не наступает, и посторонний по
     прямой ссылке видел бы три модераторские кнопки. Остальные адреса панели
     ходят в `/admin/*` и получают отказ сами. */
  const me = useApi(() => getMe(), [])
  const isStaff = me.data?.isStaff === true
  const q = useApi(async () => {
    if (!vendorId) return null
    try { return await getVendor(vendorId) }
    /* 404 здесь — не поломка, а состояние анкеты: она уже вне каталога. */
    catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e }
  }, [vendorId])
  const v = q.data
  /* Медиа считаем только по тому, что сервер прислал: поля нет — сказать
     «0 фотографий» значит утверждать за него (R-178). */
  const media = v?.media ?? null
  const photos = media ? media.filter(x => x.kind === 'photo').length : null
  const videos = media ? media.filter(x => x.kind === 'video').length : null
  const packages = v?.packages ?? []
  /* Анкета вне каталога — то же условие, по которому сервер отвечает 409.
     Пока карточка грузится или не дошла, состояние неизвестно, и решения
     остаются: сеть упала — это про сеть, а не про анкету. */
  const gone = ready(q) && !v

  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const decide = (action: 'approve' | 'reject' | 'verify') => void (async () => {
    if (!vendorId) return
    setBusy(true)
    setErr(null)
    try {
      await decideVendor(vendorId, action, action === 'reject' ? reason.trim() : undefined)
      nav('/admin/moderation')
    } catch (e) {
      /* 422 называет поле: текст сервера про причину точнее общего «не прошёл проверку». */
      setErr((e instanceof ApiError && e.field('reason')) || explainError(e))
    }
    finally { setBusy(false) }
  })()

  /* Пока право не подтверждено — ни карточки, ни решений, ни имени анкеты:
     тот же пустой экран с отказом, что и на прочих адресах панели. */
  if (!ready(me) || !isStaff) return (
    <div className="pb-10">
      <TopBar back fallback="/admin/moderation" title={t('Анкета')} sub={t('Решение модератора')} />
      <div className="px-5 mt-3">
        <AsyncState q={me} forbiddenText={denied()} />
        {ready(me) && (
          <p className="text-[12px] text-[var(--soft)] py-6 text-center leading-relaxed px-6">{denied()}</p>
        )}
      </div>
    </div>
  )

  return (
    <div className="pb-10">
      {/* «Назад» ведёт в очередь, а не на главную панели: при прямом заходе по
          ссылке истории нет, и без fallback человек вылетал бы из раздела. */}
      <TopBar back fallback="/admin/moderation" title={v?.name ?? t('Анкета')} sub={t('Решение модератора')} />
      <div className="px-5 mt-3 space-y-3">
        <AsyncState q={q} forbiddenText={denied()} />
        {gone && (
          <p className="text-[12.5px] text-[var(--soft)] py-4 text-center leading-relaxed">
            {t('Анкета вне каталога — снята или заблокирована. Решения по ней не принимаются.')}
          </p>
        )}
        {ready(q) && v && (
          <div className="card p-4">
            <span className="text-[10.5px] text-[var(--soft)]">{v.city}</span>
            {v.about && <p className="text-[12.5px] text-[var(--ink2)] leading-relaxed mt-2">{v.about}</p>}
            {photos !== null && videos !== null && (
              <p className="text-[11px] text-[var(--soft)] mt-2.5">
                {photos} {plural(photos, t('фотография'), t('фотографии'), t('фотографий'))} · {videos} {plural(videos, t('ролик'), t('ролика'), t('роликов'))}
              </p>
            )}
            {packages.length > 0 && (
              <div className="mt-3 pt-3 border-t border-[var(--track)] space-y-2">
                {packages.map((p, i) => (
                  <div key={p.id ?? `${p.name ?? ''}${i}`} className="flex items-baseline justify-between gap-3">
                    <span className="text-[12px] text-[var(--ink2)] min-w-0 truncate">{p.name}</span>
                    {p.price?.amount != null && (
                      <b className="text-[12px] text-[var(--rose-ink)] font-semibold shrink-0 tabular">{fmt(p.price.amount)}</b>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Гонка остаётся: карточка была, а решение не прошло — сервер
            ответит 409, и его текст встанет под кнопками. */}
        {!q.loading && !q.forbidden && !gone && (
          <div className="card p-4 space-y-2.5">
            <button
              disabled={busy}
              onClick={() => decide('approve')}
              className="press w-full h-[46px] rounded-full bg-[var(--sage-soft)] text-[var(--sage-ink)] text-[13px] font-semibold disabled:opacity-50"
            >
              {t('Одобрить')}
            </button>

            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              maxLength={1000}
              rows={3}
              aria-label={t('Причина снятия с публикации')}
              placeholder={t('Причина снятия — уйдёт подрядчику в уведомлении')}
              className="w-full px-4 py-3 rounded-[18px] bg-[var(--bg)] text-[12.5px] outline-none resize-none placeholder:text-[var(--soft2)]"
            />
            <button
              disabled={busy || !reason.trim()}
              onClick={() => decide('reject')}
              className="press w-full h-[46px] rounded-full bg-[var(--rose-soft)] text-[var(--rose-ink)] text-[13px] font-semibold disabled:opacity-50"
            >
              {t('Снять с публикации')}
            </button>

            <button
              disabled={busy}
              onClick={() => decide('verify')}
              className="press w-full h-[46px] rounded-full card-s text-[13px] font-semibold disabled:opacity-50"
            >
              {t('Отметить верифицированным')}
            </button>
            {/* Загрузки документов в приложении нет — и обещать её тут нечем
                (R-174). Сотрудник подтверждает то, что сверил вне приложения. */}
            <p className="text-[10.5px] text-[var(--soft)] leading-relaxed">
              {t('Документы сверяются вне приложения — загрузка ещё не подключена. Галочка появится в каталоге сразу.')}
            </p>
            {err && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{err}</p>}
          </div>
        )}
      </div>
    </div>
  )
}

/* ── 64б. Очередь заявок на верификацию ───────────────────────────────── */
/*
 * Заявки на проверку документов (фича 002).
 *
 * Очередь и очередь модерации — разные списки: анкета уходит из модерации
 * после решения по публикации, а документы ждут своей сверки и после этого.
 * Раньше заявка терялась вместе с анкетой, и подрядчик оставался без галочки
 * навсегда (`RELEASE-BLOCKERS.md` №25).
 *
 * Ни ссылки на документ, ни ИНН в списке нет: их отдаёт только карточка, и
 * каждое её открытие пишется в журнал. Список знает лишь `hasFile` — есть ли
 * что открывать.
 */

/** Вид документа словами: `ip` на экране читается как поломка, а не как «ИП». */
const kindLabel = (kind: string | undefined) =>
  kind === 'passport' ? t('физлицо')
  : kind === 'ip' ? t('ИП')
  : kind === 'company' ? t('компания')
  : ''

type VerificationPage = Awaited<ReturnType<typeof getVerifications>>

export function AdminVerifications() {
  const nav = useNavigate()
  const loc = useLocation()
  const q = useApi(() => getVerifications(), [])
  const [pages, setPages] = useState<VerificationPage[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const items = [...(q.data?.items ?? []), ...pages.flatMap(p => p.items ?? [])]
  const next = pages.length ? (pages[pages.length - 1]?.nextCursor ?? null) : (q.data?.nextCursor ?? null)
  /* Карточка ушла из-под сотрудника: заявку разобрал кто-то другой. Признак
     переносится маршрутом, а текст собирается здесь — в состоянии живёт
     русский ключ, а не перевод (R-07).
     Читаем его один раз, при монтировании: дальше он живёт в локальном
     состоянии, а из записи истории снимается (эффект ниже). */
  const [conflict] = useState(() => (loc.state as { conflict?: unknown } | null)?.conflict === true)

  /*
   * Извещение одноразовое.
   *
   * Признак остаётся в записи истории, и без этой чистки он всплывает при
   * каждом возврате на адрес очереди: сотрудник открыл следующую заявку,
   * вернулся «назад» — и снова читает про опоздание, которого во второй раз
   * не было. То же и после F5: роутер восстанавливает состояние записи.
   * Индикатор, который «горит всегда», состоянием не является (R-180).
   */
  useEffect(() => {
    if (loc.state != null) nav(loc.pathname, { replace: true, state: null })
  }, [loc.state, loc.pathname, nav])

  const more = () => void (async () => {
    if (!next) return
    setBusy(true)
    setErr(null)
    try {
      const page = await getVerifications(next)
      setPages(p => [...p, page])
    }
    catch (e) { setErr(explainError(e)) }
    finally { setBusy(false) }
  })()

  return (
    <div className="pb-10">
      <TopBar back fallback="/admin" title={t('Верификация')} sub={t('Заявки на проверку документов, старейшие сверху')} />
      <div className="px-5 mt-3 space-y-2.5">
        <AsyncState q={q} forbiddenText={denied()} />
        {conflict && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{t('Заявка уже разобрана')}</p>}
        {/* Пусто — только после ответа: «Заявок нет» рядом с лежащим сервером
            читается как «разбирать нечего», и документы стоят непроверенными. */}
        {ready(q) && items.length === 0 && (
          <p className="text-[12.5px] text-[var(--soft)] py-6 text-center">{t('Заявок нет')}</p>
        )}
        {ready(q) && items.map(r => (
          <button key={r.id} onClick={() => nav(`/admin/verifications/${r.id ?? ''}`)} className="press w-full card p-4 text-left flex items-center gap-3">
            <span className="flex-1 min-w-0">
              <b className="font-serif-d text-[15px] block truncate">{r.vendorName}</b>
              <span className="text-[10.5px] text-[var(--soft)] block mt-0.5">
                {[kindLabel(r.kind), fmtDate(r.createdAt)].filter(Boolean).join(' · ')}
              </span>
              {/* Пустая заявка видна из очереди: её открывают, чтобы отклонить,
                  а не чтобы искать документ, которого нет. */}
              {r.hasFile === false && (
                <span className="inline-block text-[9px] font-bold px-2 py-1 rounded-full bg-[var(--rose-soft)] text-[var(--rose-ink)] mt-1.5">{t('документ не приложен')}</span>
              )}
            </span>
            <ChevronRight size={16} className="text-[var(--soft2)] shrink-0" />
          </button>
        ))}
        {err && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{err}</p>}
        {ready(q) && next && (
          <div className="text-center pt-1">
            <button disabled={busy} onClick={more} className="press px-5 h-[40px] rounded-full card-s text-[12px] font-semibold disabled:opacity-50">
              {busy ? t('Загружаем…') : t('Показать ещё')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/* ── 64в. Заявка на верификацию: решение по документам ────────────────── */
/*
 * Карточка — единственное место, где ссылка на документ и ИНН выходят наружу,
 * и каждое её открытие сервер пишет в журнал.
 *
 * Слова на кнопках — «Подтвердить документы» и «Отклонить документы», а не
 * «Одобрить» и «Снять с публикации»: это решение про документы, а не про
 * анкету. Отклонение документов анкету не трогает.
 */

/*
 * Ссылкой ведём только по https.
 *
 * Адрес документа приходит из заявки, а заявку заполняет подрядчик — схему
 * выбирает тоже он. `javascript:` в `href` это чужой код, который выполнится
 * по нажатию сотрудника, уже вошедшего в панель; `http:` — тот же документ,
 * увезённый по открытому каналу. Серверная проверка формата эту не заменяет:
 * заявки, поданные по прежним правилам, лежат в базе как есть.
 */
const HTTPS_DOC = /^https:\/\//

export function AdminVerification() {
  const nav = useNavigate()
  const { requestId } = useParams()
  const q = useApi(async () => {
    if (!requestId) return null
    try { return await getVerification(requestId) }
    /* 404 — не поломка: заявки с таким адресом нет. */
    catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e }
  }, [requestId])
  const r = q.data
  const missing = ready(q) && !r
  /* Заявку уже разобрали — сервер ответит 409 на любое решение. Кнопки в этом
     состоянии обещали бы то, чего не будет (R-176). Статуса нет — состояние
     неизвестно, и решения остаются. */
  const decided = !!r && r.status != null && r.status !== 'pending'

  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const decide = (action: 'approve' | 'reject') => void (async () => {
    if (!requestId) return
    setBusy(true)
    setErr(null)
    try {
      await decideVerification(requestId, action, action === 'reject' ? reason.trim() : undefined)
      nav('/admin/verifications')
    } catch (e) {
      /* Двое сотрудников открыли одну заявку: второй должен увидеть, что
         опоздал. Карточки уже нет — сообщение уезжает вместе с ним в очередь,
         иначе он вернулся бы туда молча и решил, что нажатие не сработало. */
      if (e instanceof ApiError && e.status === 409) nav('/admin/verifications', { state: { conflict: true } })
      /* 422 называет поле: текст сервера про причину точнее общего отказа. */
      else setErr((e instanceof ApiError && e.field('reason')) || explainError(e))
    } finally { setBusy(false) }
  })()

  return (
    <div className="pb-10">
      <TopBar back fallback="/admin/verifications" title={r?.vendorName ?? t('Заявка на верификацию')} sub={t('Решение по документам')} />
      <div className="px-5 mt-3 space-y-3">
        <AsyncState q={q} forbiddenText={denied()} />
        {missing && (
          <p className="text-[12.5px] text-[var(--soft)] py-4 text-center leading-relaxed">{t('Заявка на верификацию не найдена')}</p>
        )}
        {ready(q) && r && (
          <div className="card p-4 space-y-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[12.5px] text-[var(--ink2)]">{kindLabel(r.kind)}</span>
              <span className="text-[10.5px] text-[var(--soft)] shrink-0">{fmtDate(r.createdAt)}</span>
            </div>
            <p className="text-[12.5px] text-[var(--ink2)]">
              {r.inn ? `${t('ИНН')} ${r.inn}` : t('ИНН не указан')}
            </p>
            {/* Ссылка ведёт в хранилище и открывается отдельно от приложения:
                документ — чужой файл, а не экран панели. Схему проверяем
                здесь (см. `HTTPS_DOC`): недопустимый адрес называется словами
                и ссылкой не становится. */}
            {!r.fileUrl ? (
              <p className="text-[12px] text-[var(--rose-ink)]">{t('Документ не приложен')}</p>
            ) : HTTPS_DOC.test(r.fileUrl) ? (
              <a
                href={r.fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t('Открыть документ в новой вкладке')}
                className="press inline-block text-[12px] font-bold text-[var(--sage-deep)]"
              >
                {t('Открыть документ ↗')}
              </a>
            ) : (
              <p className="text-[12px] text-[var(--rose-ink)]">{t('Ссылка на документ недопустима — не https')}</p>
            )}
          </div>
        )}

        {ready(q) && r && (
          <div className="card p-4">
            {r.vendorPublished && r.vendorId ? (
              <button onClick={() => nav(`/admin/moderation/${r.vendorId ?? ''}`)} className="press text-[12px] font-bold text-[var(--sage-deep)]">{t('Открыть анкету →')}</button>
            ) : (
              <p className="text-[11.5px] text-[var(--soft)] leading-relaxed">{t('Анкета не опубликована — решение по документам это не задерживает')}</p>
            )}
          </div>
        )}

        {ready(q) && r && decided && (
          <p role="alert" className="text-[12.5px] text-[var(--soft)] py-2 text-center leading-relaxed">{t('Заявка уже разобрана')}</p>
        )}

        {ready(q) && r && !decided && (
          <div className="card p-4 space-y-2.5">
            <button
              disabled={busy}
              onClick={() => decide('approve')}
              className="press w-full h-[46px] rounded-full bg-[var(--sage-soft)] text-[var(--sage-ink)] text-[13px] font-semibold disabled:opacity-50"
            >
              {t('Подтвердить документы')}
            </button>

            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              maxLength={1000}
              rows={3}
              aria-label={t('Причина отказа по документам')}
              placeholder={t('Причина отказа — уйдёт подрядчику в уведомлении')}
              className="w-full px-4 py-3 rounded-[18px] bg-[var(--bg)] text-[12.5px] outline-none resize-none placeholder:text-[var(--soft2)]"
            />
            <button
              disabled={busy || !reason.trim()}
              onClick={() => decide('reject')}
              className="press w-full h-[46px] rounded-full bg-[var(--rose-soft)] text-[var(--rose-ink)] text-[13px] font-semibold disabled:opacity-50"
            >
              {t('Отклонить документы')}
            </button>
            <p className="text-[10.5px] text-[var(--soft)] leading-relaxed">
              {t('Отказ по документам анкету не трогает: снятие с публикации — другое решение и другой экран.')}
            </p>
            {err && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{err}</p>}
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

type ComplaintAction = 'dismiss' | 'warn' | 'downrank' | 'block'
type ComplaintPage = Awaited<ReturnType<typeof getComplaints>>

/**
 * Санкции, применимые к цели жалобы.
 *
 * Набор задан сервером (план, «Хранение»): неприменимую он отвергает с 422.
 * Экран поэтому и не предлагает того, чего не будет: «Заблокировать»
 * сообщение, которое ничем не блокируется, — это ложь на кнопке (R-176).
 */
function actionsFor(kind: string | undefined): Array<[ComplaintAction, string]> {
  const base: Array<[ComplaintAction, string]> = [['dismiss', t('Отклонить')], ['warn', t('Предупредить')]]
  if (kind === 'vendor') return [...base, ['downrank', t('Понизить в выдаче')], ['block', t('Заблокировать')]]
  if (kind === 'review') return [...base, ['block', t('Скрыть отзыв')]]
  return base
}

/** Срок разбора — сутки (§18.2). Старше — жалоба просрочена. */
const OVERDUE_MS = 24 * 60 * 60 * 1000

export function AdminComplaints() {
  const nav = useNavigate()
  const q = useApi(() => getComplaints(), [])
  /* Время снимаем один раз: `Date.now()` в теле компонента запрещён (R-04),
     и пометка «просрочено» не должна мигать между перерисовками. */
  const [now] = useState(() => Date.now())
  const [pages, setPages] = useState<ComplaintPage[]>([])
  const [note, setNote] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const items = [...(q.data?.items ?? []), ...pages.flatMap(p => p.items ?? [])]
  const next = pages.length ? (pages[pages.length - 1]?.nextCursor ?? null) : (q.data?.nextCursor ?? null)
  const overdue = (iso: string | undefined) => !!iso && now - Date.parse(iso) > OVERDUE_MS

  const reload = () => { setPages([]); q.reload() }

  const decide = (id: string, action: ComplaintAction) => void (async () => {
    setBusy(id)
    setErr(null)
    try {
      await decideComplaint(id, action, note[id]?.trim() || undefined)
      reload()
    } catch (e) {
      /* Двое модераторов открыли одну жалобу: второй должен увидеть, что
         опоздал, а не молча получить «ошибку сервера». */
      if (e instanceof ApiError && e.status === 404) { setErr(t('Жалоба уже разобрана')); reload() }
      else setErr(explainError(e))
    } finally { setBusy(null) }
  })()

  const more = () => void (async () => {
    if (!next) return
    setBusy('more')
    setErr(null)
    try {
      const page = await getComplaints(next)
      setPages(p => [...p, page])
    }
    catch (e) { setErr(explainError(e)) }
    finally { setBusy(null) }
  })()

  return (
    <div className="pb-10">
      <TopBar back fallback="/admin" title={t('Жалобы')} sub={t('Нерассмотренные, старейшие сверху')} />
      <div className="px-5 mt-3 space-y-2.5">
        <AsyncState q={q} forbiddenText={denied()} />
        {ready(q) && items.length === 0 && (
          <p className="text-[12.5px] text-[var(--soft)] py-6 text-center">{t('Нерассмотренных жалоб нет')}</p>
        )}
        {err && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{err}</p>}
        {ready(q) && items.map(c => {
          const id = c.id ?? ''
          return (
            <div key={id} className="card p-4">
              <div className="flex items-start gap-2">
                <b className="text-[13px] flex-1">{reasonLabel(c.category)}</b>
                {overdue(c.createdAt) && (
                  <span className="text-[9px] font-bold px-2 py-1 rounded-full bg-[var(--rose-soft)] text-[var(--rose-ink)] shrink-0">{t('просрочено')}</span>
                )}
              </div>
              <span className="text-[10.5px] text-[var(--soft)] block mt-0.5">
                {[targetLabel(c.targetKind), fmtDateTime(c.createdAt)].filter(Boolean).join(' · ')}
              </span>
              {c.text && <p className="text-[12.5px] text-[var(--ink2)] leading-relaxed mt-2">{c.text}</p>}

              {/* Жалоба на подрядчика разбирается по его анкете: без неё
                  решение принимается вслепую. */}
              {c.targetKind === 'vendor' && c.targetId && (
                <button onClick={() => nav(`/admin/moderation/${c.targetId ?? ''}`)} className="press text-[11px] font-bold text-[var(--sage-deep)] mt-2.5">{t('Открыть анкету →')}</button>
              )}

              <textarea
                value={note[id] ?? ''}
                onChange={e => setNote(n => ({ ...n, [id]: e.target.value }))}
                maxLength={2000}
                rows={2}
                aria-label={t('Заметка сотрудника')}
                placeholder={t('Заметка: остаётся в журнале, нарушителю не уходит')}
                className="w-full px-4 py-2.5 rounded-[18px] bg-[var(--bg)] text-[12px] outline-none resize-none mt-2.5 placeholder:text-[var(--soft2)]"
              />

              <div className="grid grid-cols-2 gap-2 mt-2.5">
                {actionsFor(c.targetKind).map(([action, label]) => (
                  <button
                    key={action}
                    disabled={busy === id}
                    onClick={() => decide(id, action)}
                    className="press h-10 rounded-full card-s text-[11.5px] font-semibold disabled:opacity-50"
                  >
                    {label}
                  </button>
                ))}
              </div>
              {(c.targetKind === 'message' || c.targetKind === 'deal') && (
                <p className="text-[10.5px] text-[var(--soft)] leading-relaxed mt-2">
                  {t('Иных санкций к сообщениям и сделкам сервер не применяет: их нельзя понизить в выдаче или заблокировать.')}
                </p>
              )}
            </div>
          )
        })}
        {ready(q) && next && (
          <div className="text-center pt-1">
            <button disabled={busy === 'more'} onClick={more} className="press px-5 h-[40px] rounded-full card-s text-[12px] font-semibold disabled:opacity-50">
              {busy === 'more' ? t('Загружаем…') : t('Показать ещё')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/* ── 65а. Очередь заявок консьержу (ревью 015, V5) ───────────────────── */
/*
 * Заявки «подобрать вручную» из поиска (План §18.12) копились на сервере
 * со статусом `new`, и разобрать их было неоткуда. Здесь — открытые,
 * старейшие сверху: паре обещаны сутки, и срок считается от подачи.
 * Телефон — в карточке, сотрудник звонит по нему; «Подобрано» шлёт паре
 * уведомление. Страницы копятся, как у жалоб.
 */
type ConciergePage = Awaited<ReturnType<typeof getConcierge>>
type ConciergeStatus = 'in_progress' | 'done' | 'cancelled'

const conciergeStatusLabel = (status: string | undefined) =>
  status === 'in_progress' ? t('в работе') : status === 'new' ? t('новая') : ''

export function AdminConcierge() {
  const q = useApi(() => getConcierge(), [])
  const [now] = useState(() => Date.now())
  const [pages, setPages] = useState<ConciergePage[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const items = [...(q.data?.items ?? []), ...pages.flatMap(p => p.items ?? [])]
  const next = pages.length ? (pages[pages.length - 1]?.nextCursor ?? null) : (q.data?.nextCursor ?? null)
  const overdue = (iso: string | undefined) => !!iso && now - Date.parse(iso) > OVERDUE_MS

  const reload = () => { setPages([]); q.reload() }

  const decide = (id: string, status: ConciergeStatus) => void (async () => {
    setBusy(id)
    setErr(null)
    try {
      await decideConcierge(id, status)
      reload()
    } catch (e) {
      /* Двое сотрудников взяли одну заявку: второй видит, что опоздал. */
      if (e instanceof ApiError && (e.status === 409 || e.status === 404)) { setErr(t('Заявка уже закрыта')); reload() }
      else setErr(explainError(e))
    } finally { setBusy(null) }
  })()

  const more = () => void (async () => {
    if (!next) return
    setBusy('more')
    setErr(null)
    try {
      const page = await getConcierge(next)
      setPages(p => [...p, page])
    }
    catch (e) { setErr(explainError(e)) }
    finally { setBusy(null) }
  })()

  return (
    <div className="pb-10">
      <TopBar back fallback="/admin" title={t('Консьерж')} sub={t('Открытые заявки, старейшие сверху')} />
      <div className="px-5 mt-3 space-y-2.5">
        <AsyncState q={q} forbiddenText={denied()} />
        {ready(q) && items.length === 0 && (
          <p className="text-[12.5px] text-[var(--soft)] py-6 text-center">{t('Открытых заявок нет')}</p>
        )}
        {err && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{err}</p>}
        {ready(q) && items.map(r => {
          const id = r.id ?? ''
          return (
            <div key={id} className="card p-4">
              <div className="flex items-start gap-2">
                <b className="text-[13px] flex-1">{r.categoryName ?? r.categoryId}</b>
                {overdue(r.createdAt) && (
                  <span className="text-[9px] font-bold px-2 py-1 rounded-full bg-[var(--rose-soft)] text-[var(--rose-ink)] shrink-0">{t('просрочено')}</span>
                )}
                <span className="text-[9px] font-bold px-2 py-1 rounded-full bg-[var(--sage-soft)] text-[var(--sage-ink)] shrink-0">{conciergeStatusLabel(r.status)}</span>
              </div>
              <span className="text-[10.5px] text-[var(--soft)] block mt-0.5">
                {[r.city, r.budget?.amount != null ? `${t('до')} ${fmt(r.budget.amount)}` : null, fmtDateTime(r.createdAt)].filter(Boolean).join(' · ')}
              </span>
              {r.comment && <p className="text-[12.5px] text-[var(--ink2)] leading-relaxed mt-2">{r.comment}</p>}

              {/* Кому звонить: пара попросила связаться — номер здесь по делу,
                  и чтение очереди сервер пишет в журнал. */}
              <div className="flex items-center gap-3 mt-2.5">
                <p className="text-[12.5px] flex-1 min-w-0 truncate">{r.name ? `${r.name} · ` : ''}<b className="tabular">{r.phone}</b></p>
                {r.phone && (
                  <a href={`tel:${r.phone}`} className="press shrink-0 px-4 h-[34px] rounded-full grad text-[var(--on-grad)] text-[11px] font-semibold flex items-center">{t('Позвонить')}</a>
                )}
              </div>

              <div className="grid grid-cols-3 gap-2 mt-2.5">
                {([
                  ['in_progress', t('В работу')],
                  ['done', t('Подобрано')],
                  ['cancelled', t('Снять')],
                ] as Array<[ConciergeStatus, string]>).filter(([status]) => !(status === 'in_progress' && r.status === 'in_progress')).map(([status, label]) => (
                  <button
                    key={status}
                    disabled={busy === id}
                    onClick={() => decide(id, status)}
                    className="press h-10 rounded-full card-s text-[11.5px] font-semibold disabled:opacity-50"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
        {ready(q) && next && (
          <div className="text-center pt-1">
            <button disabled={busy === 'more'} onClick={more} className="press px-5 h-[40px] rounded-full card-s text-[12px] font-semibold disabled:opacity-50">
              {busy === 'more' ? t('Загружаем…') : t('Показать ещё')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/* ── 66. Категории и словарь синонимов ────────────────────────────────── */
/*
 * Экран правит КОПИЮ ответа сервера, а `PUT` заменяет справочник целиком:
 * словарь, которого нет в теле, исчезает. Поэтому тело собирается от всего
 * прочитанного, а не от того, что человек успел тронуть, — и поэтому перед
 * отправкой экран называет число строк, которое уйдёт.
 */
/**
 * Строка словаря.
 *
 * `key` — не данные, а тождество строки на экране: строки различались номером
 * в списке, и после удаления строки из середины React оставлял тот же узел под
 * соседним значением — курсор стоит в поле, а слово в нём другое.
 */
type SynRow = { key: number; word: string; categoryId: string }
/**
 * Черновик справочника.
 *
 * `version` лежит здесь, а не отдельным состоянием: это отпечаток того
 * содержимого, с которого начата правка, и меняться он обязан ровно вместе с
 * ним. Разъедься они — сохранение уходило бы с версией от прошлого ответа и
 * либо получало отказ на ровном месте, либо (что хуже) проходило поверх чужой
 * правки. Поля нет — сервер сохраняет без проверки (FR-006).
 */
type CategoriesDraft = { categories: AdminCategory[]; synonyms: SynRow[]; version?: string }

/** Идентификатор новой категории: латиница, цифры, дефис, подчёркивание. */
const CATEGORY_ID = /^[a-z0-9_-]{1,40}$/

/** Подтверждение замены словаря. Свой оверлей: `window.confirm` в проекте не используется. */
function ConfirmSave({ words, busy, onCancel, onConfirm }: { words: number; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  useEscape(onCancel)
  return (
    <div role="dialog" aria-modal="true" aria-label={t('Сохранение справочника')} className="fixed inset-0 z-50 bg-black/40 flex items-end justify-center" onClick={onCancel}>
      <div className="w-full max-w-[430px] bg-[var(--bg)] rounded-t-[32px] p-6 pb-[max(28px,env(safe-area-inset-bottom))] fade-up" onClick={e => e.stopPropagation()}>
        <b className="font-serif-d text-[20px] block">{t('Сохранить справочник?')}</b>
        <p className="text-[12px] text-[var(--soft)] leading-relaxed mt-2">
          {t('Словарь синонимов заменится целиком: на сервере останутся только строки с этого экрана.')}
        </p>
        <p className="text-[12.5px] text-[var(--ink2)] mt-2">
          {t('Уйдёт строк словаря:')} {words}
        </p>
        <div className="flex gap-2.5 mt-4">
          <button onClick={onCancel} className="press flex-1 h-[46px] rounded-full card-s text-[12.5px] font-semibold">{t('Отмена')}</button>
          <button autoFocus disabled={busy} onClick={onConfirm} className="press flex-1 h-[46px] rounded-full grad text-[var(--on-grad)] text-[12.5px] font-semibold disabled:opacity-50">
            {busy ? t('Сохраняем…') : t('Сохранить')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function AdminCategories() {
  const q = useApi(() => getAdminCategories(), [])
  const [draft, setDraft] = useState<CategoriesDraft | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /* Сервер называет виноватое слово (`synonyms.<слово>` в `error.fields`):
     подпись встаёт под той строкой, а не в общий текст внизу экрана. */
  const [rowErr, setRowErr] = useState<Record<string, string>>({})
  /* Справочник изменили, пока его правили (409 `categories_stale`). Отдельный
     признак, а не разбор текста ошибки: перечитывать предлагается только там,
     где это и правда лечит, — на 422 и на лежащей сети перечитывание лишь
     выбросит правки. */
  const [stale, setStale] = useState(false)
  /* Счётчик тождеств строк словаря. Растёт при загрузке и при добавлении —
     в эффекте и в обработчике, но не в теле компонента (R-04). */
  const nextKey = useRef(0)

  /* Копия снимается с ответа: пришёл новый ответ (в том числе после
     сохранения и после «Перечитать») — на экране снова то, что лежит на
     сервере, вместе с его версией. */
  useEffect(() => {
    if (!q.data) return
    setDraft({
      categories: (q.data.categories ?? []).map(c => ({ ...c })),
      synonyms: Object.entries(q.data.synonyms ?? {}).map(([word, categoryId]) => ({ key: nextKey.current++, word, categoryId })),
      version: q.data.version,
    })
  }, [q.data])

  const categories = draft?.categories ?? []
  const synonyms = draft?.synonyms ?? []
  /* Идентификатор правится только у новой категории: у существующей это ключ,
     на который ссылаются анкеты и слоты. */
  const known = new Set((q.data?.categories ?? []).map(c => c.id))

  /*
   * Ключ словаря на сервере — слово в нижнем регистре. «Тамада» и «тамада» —
   * одна строка: вторая молча съедала первую, а диалог перед этим обещал
   * отправить обе. Считаем повторы по тому же ключу, каким собирается тело.
   */
  const synKey = (word: string) => word.trim().toLowerCase()
  const synBody = Object.fromEntries(synonyms.map(s => [synKey(s.word), s.categoryId]))
  const repeats = new Set(
    synonyms.map(s => synKey(s.word)).filter((k, i, all) => k !== '' && all.indexOf(k) !== i),
  )

  const editCategory = (i: number, patch: Partial<AdminCategory>) =>
    setDraft(d => d && { ...d, categories: d.categories.map((c, j) => (j === i ? { ...c, ...patch } : c)) })
  const editSynonym = (i: number, patch: Partial<SynRow>) =>
    setDraft(d => d && { ...d, synonyms: d.synonyms.map((s, j) => (j === i ? { ...s, ...patch } : s)) })

  const addCategory = () =>
    setDraft(d => d && {
      ...d,
      /* Номер — следующий за самым большим, а не длина списка: в справочнике
         с пропусками новая категория садилась на занятое место в мозаике. */
      categories: [...d.categories, { id: '', title: '', icon: '', sort: d.categories.reduce((max, c) => Math.max(max, c.sort ?? 0), 0) + 1 }],
    })
  const addSynonym = () => {
    /* Номер берём до обновления состояния: обновляющая функция может быть
       вызвана дважды, и два вызова дали бы строке два разных тождества. */
    const key = nextKey.current++
    setDraft(d => d && { ...d, synonyms: [...d.synonyms, { key, word: '', categoryId: d.categories[0]?.id ?? '' }] })
  }
  const dropSynonym = (i: number) =>
    setDraft(d => d && { ...d, synonyms: d.synonyms.filter((_, j) => j !== i) })

  const badId = categories.some(c => !known.has(c.id) && !CATEGORY_ID.test(c.id))
  const duplicateId = new Set(categories.map(c => c.id)).size !== categories.length
  const badTitle = categories.some(c => !c.title.trim())
  /* Порядок в мозаике — целое: дробь поле пропускало, а сервер отвечал 422
     без указания поля, и человек не знал, что именно чинить. */
  const badSort = categories.some(c => c.sort != null && !Number.isInteger(c.sort))
  const badWord = synonyms.some(s => !s.word.trim() || !s.categoryId)
  const invalid = badId || duplicateId || badTitle || badSort || badWord || repeats.size > 0

  const save = () => void (async () => {
    if (!draft) return
    setBusy(true)
    setErr(null)
    setRowErr({})
    setStale(false)
    try {
      await putAdminCategories({
        /* Версия — от ответа, с которого начата правка. Ответ без неё
           (сохранение не из панели, старый сервер) уходит без поля: правило
           не должно ломать тех, кто о нём не знает (FR-006). */
        ...(draft.version ? { version: draft.version } : {}),
        categories: draft.categories.map(c => ({
          id: c.id.trim(),
          title: c.title.trim(),
          ...(c.sort != null ? { sort: c.sort } : {}),
          /* Значок уходит всегда: строка — поставить, `null` — стереть (R-17,
             фича 014, A9). Раньше пустое поле не отправлялось, сервер
             подставлял прежний значок, и стереть его было нельзя ничем. */
          icon: c.icon?.trim() ? c.icon.trim() : null,
        })),
        synonyms: synBody,
      })
      setConfirm(false)
      q.reload()
    } catch (e) {
      /* Сервер называет поле, на котором споткнулся (422 с `fields`), — его
         текст и показываем: «ошибка проверки» без слова не чинится. */
      setConfirm(false)
      setErr(explainError(e))
      if (e instanceof ApiError) {
        const bad: Record<string, string> = {}
        for (const [key, text] of Object.entries(e.fields)) {
          if (key.startsWith('synonyms.')) bad[key.slice('synonyms.'.length)] = text
        }
        setRowErr(bad)
        /* Справочник изменили, пока сотрудник его правил: на сервере не
           изменилось ничего, и починить это можно только перечитыванием —
           повтор того же тела получит тот же отказ. */
        setStale(e.status === 409 && e.code === 'categories_stale')
      }
    } finally { setBusy(false) }
  })()

  /*
   * Перечитать справочник поверх своих правок.
   *
   * Ответ заменит черновик через тот же эффект, что и при первой загрузке, —
   * вместе с версией. Несохранённые правки при этом пропадают, поэтому так и
   * написано на кнопке: слияния правок двух сотрудников тут нет.
   */
  const reread = () => {
    setErr(null)
    setRowErr({})
    setStale(false)
    q.reload()
  }

  return (
    <div className="pb-10">
      <TopBar back fallback="/admin" title={t('Категории')} sub={t('Справочник и словарь поиска')} />
      <div className="px-5 mt-3 space-y-3">
        <AsyncState q={q} forbiddenText={denied()} />
        {ready(q) && draft && (
          <>
            <div className="card px-4 py-1.5">
              {categories.map((c, i) => (
                <div key={known.has(c.id) ? c.id : `new-${i}`} className="flex flex-wrap items-center gap-2 py-2.5 border-b border-[var(--track)] last:border-none">
                  <input
                    value={c.icon ?? ''}
                    onChange={e => editCategory(i, { icon: e.target.value })}
                    maxLength={16}
                    aria-label={t('Значок категории')}
                    className="w-9 h-9 text-center rounded-[12px] bg-[var(--bg)] text-[16px] outline-none shrink-0"
                  />
                  <span className="flex-1 min-w-0">
                    <input
                      value={c.title}
                      onChange={e => editCategory(i, { title: e.target.value })}
                      maxLength={100}
                      aria-label={t('Название категории')}
                      placeholder={t('Название категории')}
                      className="w-full h-9 px-3 rounded-full bg-[var(--bg)] text-[12.5px] outline-none placeholder:text-[var(--soft2)]"
                    />
                    {known.has(c.id) ? (
                      <span className="text-[9.5px] text-[var(--soft2)] block mt-1 px-3">{c.id}</span>
                    ) : (
                      <input
                        value={c.id}
                        onChange={e => editCategory(i, { id: e.target.value.trim().toLowerCase() })}
                        maxLength={40}
                        aria-label={t('Идентификатор категории')}
                        placeholder={t('Идентификатор латиницей')}
                        className="w-full h-9 px-3 rounded-full bg-[var(--bg)] text-[11.5px] outline-none mt-1 placeholder:text-[var(--soft2)]"
                      />
                    )}
                  </span>
                  <input
                    type="number"
                    step={1}
                    value={c.sort ?? ''}
                    onChange={e => editCategory(i, { sort: e.target.value === '' ? undefined : Number(e.target.value) })}
                    aria-label={t('Порядок в мозаике')}
                    className="w-12 h-9 text-center rounded-full bg-[var(--bg)] text-[12px] outline-none shrink-0"
                  />
                  {c.sort != null && !Number.isInteger(c.sort) && (
                    <p className="basis-full text-[11px] text-[var(--rose-ink)] pl-3 -mt-1">{t('порядок — целое число')}</p>
                  )}
                </div>
              ))}
            </div>
            {/* Удаления категорий нет и не будет: на них ссылаются анкеты и
                слоты, и исчезнувшая категория — осиротевшая мозаика. */}
            <button onClick={addCategory} className="press w-full card-s h-11 text-[12px] font-semibold flex items-center justify-center gap-1.5">
              <Plus size={14} /> {t('Добавить категорию')}
            </button>

            <span className="text-[10px] tracking-[.16em] uppercase text-[var(--soft)] font-semibold px-1 block pt-1">{t('Словарь синонимов')}</span>
            <div className="card px-4 py-1.5">
              {synonyms.length === 0 && (
                <p className="text-[12.5px] text-[var(--soft)] py-3">{t('Словарь пуст — поиск ищет только по названиям')}</p>
              )}
              {synonyms.map((s, i) => (
                <div key={s.key} className="flex flex-wrap items-center gap-2 py-2.5 border-b border-[var(--track)] last:border-none">
                  <input
                    value={s.word}
                    onChange={e => editSynonym(i, { word: e.target.value })}
                    maxLength={40}
                    aria-label={t('Слово поиска')}
                    placeholder={t('тамада')}
                    className="flex-1 min-w-0 h-9 px-3 rounded-full bg-[var(--bg)] text-[12.5px] outline-none placeholder:text-[var(--soft2)]"
                  />
                  <select
                    value={s.categoryId}
                    onChange={e => editSynonym(i, { categoryId: e.target.value })}
                    aria-label={t('Категория слова')}
                    className="h-9 px-2 rounded-full bg-[var(--bg)] text-[11.5px] outline-none max-w-[42%]"
                  >
                    {categories.map(c => <option key={c.id} value={c.id}>{c.title || c.id}</option>)}
                  </select>
                  <button onClick={() => dropSynonym(i)} aria-label={t('Удалить слово')} className="press w-8 h-8 rounded-full bg-[var(--bg)] flex items-center justify-center shrink-0">
                    <Trash2 size={14} className="text-[var(--soft)]" />
                  </button>
                  {repeats.has(synKey(s.word)) && (
                    <p className="basis-full text-[11px] text-[var(--rose-ink)] pl-3 -mt-1">{t('повторяется')}</p>
                  )}
                  {rowErr[synKey(s.word)] && (
                    <p role="alert" className="basis-full text-[11px] text-[var(--rose-ink)] pl-3 -mt-1">{rowErr[synKey(s.word)]}</p>
                  )}
                </div>
              ))}
            </div>
            <button onClick={addSynonym} className="press w-full card-s h-11 text-[12px] font-semibold flex items-center justify-center gap-1.5">
              <Plus size={14} /> {t('Добавить слово')}
            </button>

            {/* Общий текст — только про то, что в нём названо: у повтора слова
                и дробного порядка своя подпись под строкой, и объяснять их
                чужими словами значит послать чинить не то. */}
            {(badId || duplicateId || badTitle || badWord) && (
              <p className="text-[11.5px] text-[var(--soft)] leading-relaxed px-1">
                {t('Проверьте поля: у категории нужны название и идентификатор латиницей (до 40 знаков), в словаре — слово и категория.')}
              </p>
            )}
            <button
              disabled={invalid || busy}
              onClick={() => setConfirm(true)}
              className="press w-full h-[50px] rounded-full grad text-[var(--on-grad)] text-[13px] font-semibold disabled:opacity-50"
            >
              {t('Сохранить')}
            </button>
            {err && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{err}</p>}
            {/* Кнопка появляется только под отказом по версии: она выбрасывает
                несохранённые правки, и предлагать её после 422 или упавшей
                сети значило бы предлагать потерять их зря. Что правки
                заменятся — сказано на самой кнопке, до нажатия (FR-003). */}
            {stale && (
              <button onClick={reread} className="press w-full h-[46px] rounded-full card-s text-[12.5px] font-semibold">
                {t('Перечитать — несохранённые правки заменятся')}
              </button>
            )}
          </>
        )}
      </div>
      {/* Число в диалоге — размер собранного тела, а не длина черновика:
          обещать надо ровно то, что уйдёт на сервер. */}
      {confirm && (
        <ConfirmSave words={Object.keys(synBody).length} busy={busy} onCancel={() => setConfirm(false)} onConfirm={save} />
      )}
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

/** Сделки свадьбы на карточке (фича 013): грузятся отдельной кнопкой — отдельная строка журнала. */
type DealsLookup =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'error'; text: string }
  | { kind: 'list'; items: SupportDeal[] }

/** Состояние сделки словами — те же слова, что у пары на мозаике. */
const DEAL_STATE_RU: Record<string, string> = {
  candidate: 'не связывались',
  contacted: 'связались',
  negotiating: 'мягкая бронь',
  booked: 'забронирован',
  paid_deposit: 'внесён аванс',
  done: 'выполнено',
  cancelled: 'отменено',
}
const DEAL_BY_RU: Record<string, string> = { couple: 'пара', vendor: 'подрядчик', system: 'система' }

/** Границы причины из контракта: короче пяти знаков сервер не принимает. */
const REASON_MIN = 5
const REASON_MAX = 500

export function AdminWedding() {
  const [wid, setWid] = useState('')
  const [reason, setReason] = useState('')
  /* Запрос уходит только по нажатию — из обработчика кнопки, а не из
     эффекта по состоянию: подставлять чужую свадьбу на каждую набранную
     букву значит писать в журнал десяток просмотров вместо одного, а кнопка
     обязана сама делать то, что на ней написано (R-176). */
  const [look, setLook] = useState<WeddingLookup>({ kind: 'idle' })
  const [deals, setDeals] = useState<DealsLookup>({ kind: 'idle' })
  const valid = wid.trim().length > 0 && reason.trim().length >= REASON_MIN

  const lookUp = () => void (async () => {
    setLook({ kind: 'busy' })
    /* Новая карточка — сделки прошлой свадьбы на экране не остаются. */
    setDeals({ kind: 'idle' })
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

  /* Сделки — отдельной кнопкой с той же причиной (фича 013, решение владельца
     «сделки без чатов»): каждое чтение чужих денег — своя строка журнала, и
     нажимает её сотрудник сам, а не экран за него. */
  const showDeals = (weddingId: string) => void (async () => {
    setDeals({ kind: 'busy' })
    try {
      const page = await getWeddingDealsForSupport(weddingId, reason.trim())
      setDeals({ kind: 'list', items: page?.items ?? [] })
    } catch (e) { setDeals({ kind: 'error', text: explainError(e) }) }
  })()

  /* Отказ снимает и форму: предлагать ввести причину тому, кому раздел
     закрыт, значит обещать просмотр, которого не будет (FR-001). */
  if (look.kind === 'forbidden') return (
    <div className="pb-10">
      <TopBar back fallback="/admin" title={t('Карточка свадьбы')} />
      <p className="text-[12px] text-[var(--soft)] py-6 text-center leading-relaxed px-6">{denied()}</p>
    </div>
  )

  const card = look.kind === 'card' ? look.card : null

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
            maxLength={REASON_MAX}
            aria-label={t('Зачем смотрим')}
            placeholder={t('Зачем смотрим: номер обращения или его суть')}
            className="w-full h-11 px-4 rounded-full bg-[var(--bg)] text-[13px] outline-none placeholder:text-[var(--soft2)]"
          />
          {/* Счётчик показывает обе границы сразу: «слишком коротко» без числа
              человек читает как «поле сломалось». */}
          <p className="text-[10px] text-[var(--soft2)] text-right tabular">{reason.length}/{REASON_MAX}</p>
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

        {card && (
          <div className="card p-4">
            <b className="font-serif-d text-[17px] block">{card.title}</b>
            <span className="text-[10.5px] text-[var(--soft)] block mt-1">
              {[card.city, fmtDate(card.date), card.style].filter(Boolean).join(' · ')}
            </span>
            <div className="mt-3 pt-3 border-t border-[var(--track)] space-y-1.5">
              {card.guestsPlanned != null && (
                <p className="text-[11.5px] text-[var(--ink2)]">
                  {t('Гостей по плану:')} {card.guestsPlanned}
                </p>
              )}
              {card.createdAt && (
                <p className="text-[11.5px] text-[var(--ink2)]">
                  {t('Заведена:')} {fmtDate(card.createdAt)}
                </p>
              )}
              {/* Ни гостей, ни переписки: для разбора обращения этого достаточно,
                  а лишнее здесь — чужая свадьба на экране. Сделки — ниже, по
                  кнопке и с записью в журнал (фича 013). */}
              <p className="text-[10.5px] text-[var(--soft2)] leading-relaxed pt-1">{t('Список гостей и переписка поддержке не показываются. Сделки — по кнопке ниже, каждый просмотр записывается.')}</p>
            </div>
          </div>
        )}

        {card && (
          <div className="card p-4 space-y-2.5">
            {deals.kind === 'list' ? (
              <>
                <b className="text-[13px] block">{t('Сделки')} · {deals.items.length}</b>
                {deals.items.length === 0 && <p className="text-[12px] text-[var(--soft)]">{t('Сделок у свадьбы нет')}</p>}
                {deals.items.map(d => {
                  const last = d.events[d.events.length - 1]
                  /* Имя и пометка — одной строкой: свой подрядчик пары помечается словами, у анкеты каталога пометки нет. */
                  const who = `${d.vendorName ?? d.externalName ?? t('без имени')}${d.externalName ? ` (${t('свой подрядчик')})` : ''}`
                  return (
                    <div key={d.id} className="pt-2.5 border-t border-[var(--track)] first:border-none first:pt-0">
                      <p className="text-[12.5px]">
                        <b>{d.slotLabel}</b> · {who}
                      </p>
                      <p className="text-[11.5px] text-[var(--ink2)] mt-0.5 tabular">
                        {t(DEAL_STATE_RU[d.state] ?? d.state)}
                        {d.price ? ` · ${fmt(d.price.amount)}` : ` · ${t('цена не названа')}`}
                        {` · ${t('оплачено')} ${fmt(d.paid.amount)}`}
                      </p>
                      {last && (
                        <p className="text-[10.5px] text-[var(--soft)] mt-0.5">
                          {fmtDate(last.at)} · {t(DEAL_BY_RU[last.by] ?? last.by)} → {t(DEAL_STATE_RU[last.toState] ?? last.toState)}{last.note ? ` · ${last.note}` : ''}
                        </p>
                      )}
                    </div>
                  )
                })}
              </>
            ) : (
              <>
                <p className="text-[10.5px] text-[var(--soft)] leading-relaxed">{t('Сделки свадьбы: подрядчики, состояния, цены и оплаты — без переписки и телефонов. Просмотр записывается с той же причиной.')}</p>
                {deals.kind === 'error' && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{deals.text}</p>}
                <button
                  disabled={deals.kind === 'busy'}
                  onClick={() => showDeals(card.id ?? wid.trim())}
                  className="press w-full h-[42px] rounded-full card-s text-[12.5px] font-semibold disabled:opacity-50"
                >
                  {deals.kind === 'busy' ? t('Открываем…') : t('Показать сделки')}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
