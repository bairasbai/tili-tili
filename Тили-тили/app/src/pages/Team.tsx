import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Check, ChevronRight, Copy, Crown, Heart, Link2, Shield, Users, X } from 'lucide-react'
import { Tile, TopBar } from '@/components/chrome'
import { useStore } from '@/lib/store'
import { cn, copyText } from '@/lib/utils'
import { t } from '@/lib/i18n'
import { api, ApiError, url } from '@/lib/api/client'
import { findMyWedding } from '@/lib/api/wedding'
import { useEscape } from '@/lib/useEscape'

/* «Наша команда» — единое пространство свадьбы: роли и приглашения.
 * Бэкенд-модель: Wedding 1—n Member(userId, role: couple|helper|vendor|guest, joinedAt).
 * Приглашение: POST /weddings/:id/invites { role } → { code, url, expiresAt: now+7d }.
 * Принятие: POST /invites/:code/accept { userId } → member создан, код погашен (одноразовый). */
const ROLES = [
  { id: 'partner', icon: '💞', tile: 'bg-[var(--rose-soft)]', name: t('Партнёр'), desc: t('Полный доступ: бюджет, сделки, документы, команда — всё как у вас.'), rights: [t('Бюджет и сделки'), t('Команда и документы'), t('Гости и приглашения'), t('Чек-лист и тайминг')] },
  { id: 'helper', icon: '🤝', tile: 'bg-[var(--sage-soft)]', name: t('Помощник'), desc: t('Свидетель, мама, подруга. Организация без финансов.'), rights: [t('Чек-лист и тайминг'), t('Гости и рассадка'), t('Заметки'), t('Без бюджета и сделок')] },
  { id: 'coordinator', icon: '🎖', tile: 'bg-[var(--honey)]', name: t('Координатор'), desc: t('Главный по дню X: командует подрядчиками в чате команды, правит тайминг. Финансы — только у пары.'), rights: [t('Тайминг и план Б'), t('Чаты с подрядчиками'), t('Чек-лист и гости'), t('Без бюджета и оплат')] },
  { id: 'vendor', icon: '📸', tile: 'bg-[var(--blue)]', name: t('Подрядчик'), desc: t('Видит только свои сделки, чаты с вами и вашу дату в календаре.'), rights: [t('Свои сделки'), t('Чат с парой'), t('Календарь даты')] },
] as const

/*
 * Код приглашения выпускает сервер, а не браузер.
 *
 * Раньше он собирался здесь из `Math.random()`. По этому коду человек входит
 * в чужую свадьбу — видит бюджет, гостей, договоры, — то есть это выдача
 * удостоверения, а не украшение. `Math.random()` предсказуем: в V8 это
 * xorshift128+ с общим состоянием на процесс, и по нескольким выданным кодам
 * следующие вычисляются. Ровно эта дыра закрывалась на сервере (ERR-0114),
 * закрывать её там и оставлять здесь — бессмысленно.
 *
 * Роли на экране и в контракте названы по-разному: «партнёр» в интерфейсе —
 * это `couple` на сервере, вторая половина пары с полным доступом.
 */
const SERVER_ROLE = { partner: 'couple', helper: 'helper', coordinator: 'coordinator', vendor: 'vendor' } as const

type Member = { user?: { id?: string; name?: string }; role?: string }
type Invite = { code?: string; url?: string; role?: string; label?: string | null; expiresAt?: string; used?: boolean }

const ROLE_NAME: Record<string, string> = {
  couple: t('Пара'), helper: t('Помощник'), coordinator: t('Координатор'), vendor: t('Подрядчик'),
}
const ROLE_TILE: Record<string, string> = {
  couple: 'bg-[var(--rose-soft)]', helper: 'bg-[var(--sage-soft)]',
  coordinator: 'bg-[var(--honey)]', vendor: 'bg-[var(--blue)]',
}
const ROLE_ICON: Record<string, string> = { couple: '💞', helper: '🤝', coordinator: '🎖', vendor: '📸' }

/** «через 6 дней» из даты истечения: срок ссылки — семь дней (контракт). */
function daysLeft(iso?: string): string {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  if (Number.isNaN(ms) || ms <= 0) return t('истекла')
  return `${Math.ceil(ms / 86_400_000)} ${t('дн.')}`
}

export function Team() {
  const nav = useNavigate()
  const { city, weddingId } = useStore()
  const [invite, setInvite] = useState<typeof ROLES[number] | null>(null)
  const [inviteCode, setInviteCode] = useState('')
  const [copied, setCopied] = useState(false)
  const [members, setMembers] = useState<Member[]>([])
  /* Список пришёл. Без этого «Пока только вы» стояло и тогда, когда состав
     неизвестен: пустой массив до ответа и пустой массив после — разные вещи. */
  const [loaded, setLoaded] = useState(false)
  const [invites, setInvites] = useState<Invite[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /* Закрыли до ответа — значит, открывать уже нечего (см. `openInvite`). */
  const cancelled = useRef(false)
  const closeInvite = () => { cancelled.current = true; setInvite(null) }
  useEscape(closeInvite, true)

  const explain = (e: unknown) => e instanceof ApiError
    ? (e.isDown ? t('Сервер недоступен. Попробуйте позже') : e.message)
    : t('Что-то пошло не так')

  const load = useCallback(async () => {
    if (!weddingId) return
    try {
      const [m, iv] = await Promise.all([
        api.get(url('/weddings/{weddingId}/members', { weddingId })),
        api.get(url('/weddings/{weddingId}/invites', { weddingId })),
      ])
      setMembers(m ?? [])
      setInvites(iv ?? [])
      setLoaded(true)
    } catch (e) { setErr(explain(e)) }
  }, [weddingId])

  useEffect(() => { void load() }, [load])

  /*
   * Код выпускает сервер: шторка открывается уже с готовым кодом, а не с
   * придуманным на клиенте. Пока запрос идёт, кнопка занята.
   *
   * Если человек успел нажать Escape, пока код выпускался, шторку не
   * открываем: поздний ответ выталкивал её обратно поверх экрана, который
   * человек только что закрыл. Ссылка при этом создана и видна в списке
   * активных — отменять выпуск задним числом было бы хуже.
   */
  const openInvite = async (r: typeof ROLES[number]) => {
    if (!weddingId || busy) return
    setBusy(true); setErr(null)
    cancelled.current = false
    try {
      const created = await api.post(url('/weddings/{weddingId}/invites', { weddingId }), {
        role: SERVER_ROLE[r.id], label: r.name,
      })
      void load()
      if (cancelled.current) return
      setInviteCode(created?.code ?? '')
      setInvite(r)
    } catch (e) { setErr(explain(e)) } finally { setBusy(false) }
  }

  const revoke = async (code?: string) => {
    if (!code) return
    try { await api.delete(url('/invites/{code}', { code })) } catch (e) { setErr(explain(e)); return }
    setInvites(list => list.filter(x => x.code !== code))
  }

  const copy = (text: string) => { copyText(text); setCopied(true); setTimeout(() => setCopied(false), 1800) }
  const inviteUrl = (code: string) => `tili-tili.ru/join/${code}`

  return (
    <div className="pb-28">
      <TopBar back title={t('Наша команда')} sub={`${t('единое пространство · ')}${city}`} />
      <div className="px-5 mt-3 space-y-3.5">
        {err && <p role="alert" className="text-[12px] text-[var(--rose-ink)] leading-relaxed px-1">{err}</p>}
        {/* Без свадьбы приглашать некуда. Молчащая кнопка хуже объяснения:
            человек жмёт и не понимает, почему ничего не происходит (R-05). */}
        {!weddingId && (
          <p className="text-[12px] text-[var(--soft)] leading-relaxed px-1">
            {t('Сначала создайте свадьбу — пройдите короткий опрос, и команду можно будет собирать.')}
          </p>
        )}
        {/* Кто уже внутри */}
        <div className="card px-4 py-1.5">
          {/* Утверждение о составе команды — только когда состав известен.
              При отказе сервера «Пока только вы» врало бы о том, что
              помощников нет. */}
          {!loaded && !err && weddingId && (
            <p className="text-[11.5px] text-[var(--soft)] py-4 text-center">{t('Загружаем…')}</p>
          )}
          {loaded && members.length === 0 && (
            <p className="text-[11.5px] text-[var(--soft)] py-4 text-center">{t('Пока только вы. Пригласите тех, кто планирует вместе с вами.')}</p>
          )}
          {members.map((m, k) => (
            <div key={m.user?.id ?? k} className={cn('flex items-center gap-3 py-3.5', k !== members.length - 1 && 'border-b border-[var(--track)]')}>
              <Tile icon={ROLE_ICON[m.role ?? 'helper'] ?? '🤝'} tile={ROLE_TILE[m.role ?? 'helper'] ?? 'bg-[var(--sage-soft)]'} size={42} />
              <div className="flex-1">
                <b className="text-[13px]">{m.user?.name ?? t('Без имени')}</b>
                <p className="text-[10px] text-[var(--soft)]">{ROLE_NAME[m.role ?? ''] ?? m.role}</p>
              </div>
              {m.role === 'couple' && <Crown size={14} className="text-[var(--gold-soft)]" />}
            </div>
          ))}
        </div>
        {/* Раньше в примере стоял «Тимур» — имя из моков, а не из этой
            команды. Правило то же, что и на карточке пары: чужого имени на
            своём экране быть не должно. */}
        {/* «Мгновенно» обещало живой канал, которого у бюджета нет: данные
            общие на сервере и перечитываются при открытии экрана. */}
        <p className="text-[10.5px] text-[var(--soft)] px-1 leading-relaxed">{t('💡 Данные общие: расход, добавленный любым из команды, виден всем при следующем открытии бюджета.')}</p>

        {/* Пригласить */}
        <div className="flex justify-between items-baseline px-1 mt-2">
          <h2 className="font-serif-d text-[18px]">{t('Пригласить')}</h2>
        </div>
        <div className="space-y-2.5">
          {ROLES.map(r => (
            <button key={r.id} onClick={() => void openInvite(r)} disabled={!weddingId || busy} className={cn('press w-full card p-4 flex items-center gap-3.5 text-left', (!weddingId || busy) && 'opacity-40')}>
              <Tile icon={r.icon} tile={r.tile} size={46} />
              <div className="flex-1">
                <b className="text-[14px]">{r.name}</b>
                <p className="text-[10.5px] text-[var(--soft)] mt-0.5 leading-snug">{r.desc}</p>
              </div>
              <ChevronRight size={16} className="text-[var(--soft)]" />
            </button>
          ))}
        </div>

        {/* Активные приглашения */}
        <div className="flex justify-between items-baseline px-1 mt-2">
          <h2 className="font-serif-d text-[18px]">{t('Активные ссылки')}</h2>
          {/* Число и «ссылок нет» — только по пришедшему списку: то же
              правило, что для состава команды выше. */}
          <span className="text-[10px] text-[var(--soft)]">{loaded ? `${invites.filter(x => !x.used).length} ${t('действуют')}` : '—'}</span>
        </div>
        <div className="card px-4 py-1.5">
          {loaded && invites.length === 0 && (
            <p className="text-[11.5px] text-[var(--soft)] py-4 text-center">{t('Активных ссылок нет.')}</p>
          )}
          {invites.map((iv, k) => (
            <div key={iv.code ?? k} className={cn('flex items-center gap-3 py-3.5 fade-up', k !== invites.length - 1 && 'border-b border-[var(--track)]')}>
              <Link2 size={15} className="text-[var(--sage-deep)] shrink-0" />
              <div className="flex-1 min-w-0">
                <b className="text-[12.5px] tabular">{iv.code}</b>
                <p className="text-[10px] text-[var(--soft)]">{ROLE_NAME[iv.role ?? ''] ?? iv.role} · {daysLeft(iv.expiresAt)}</p>
              </div>
              <button onClick={() => copy(iv.url ?? inviteUrl(iv.code ?? ''))} className="press text-[10.5px] font-bold text-[var(--sage-deep)]">{copied ? '✓' : t('Копия')}</button>
              <button onClick={() => void revoke(iv.code)} className="press text-[var(--soft)]" aria-label={t('Отозвать ссылку')}><X size={14} /></button>
            </div>
          ))}
        </div>

        <div className="card-s px-4 py-3 flex gap-2.5">
          <Shield size={15} className="text-[var(--sage-deep)] shrink-0 mt-0.5" />
          {/* Отзыв гасит ссылку, а не участника: пути «убрать из команды» в
              контракте нет (RELEASE-BLOCKERS), и обещать «потеряет доступ»
              тому, кто уже вошёл, нельзя. */}
          <p className="text-[11px] text-[var(--ink2)] leading-relaxed"><b>{t('Безопасность:')}</b> {t('каждая ссылка одноразовая и живёт 7 дней. Отозвать можно в один тап — ссылка перестанет открываться.')}</p>
        </div>
      </div>

      {/* Шторка приглашения */}
      {invite && (
        <div role="dialog" aria-modal="true" aria-label={t('Пригласить в команду')} className="fixed inset-0 z-50 bg-black/40 flex items-end justify-center" onClick={closeInvite}>
          <div className="w-full max-w-[430px] bg-[var(--bg)] rounded-t-[32px] p-6 pb-[max(28px,env(safe-area-inset-bottom))] fade-up" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3">
              <Tile icon={invite.icon} tile={invite.tile} size={46} />
              <div className="flex-1">
                <b className="font-serif-d text-[19px]">{t('Пригласить:')}{invite.name}</b>
                <p className="text-[10.5px] text-[var(--soft)]">{t('ссылка одноразовая · живёт 7 дней')}</p>
              </div>
              <button onClick={closeInvite} className="press w-9 h-9 rounded-full bg-[var(--card)] flex items-center justify-center"><X size={15} /></button>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-4">
              {invite.rights.map(r => (
                <span key={r} className="text-[10px] font-semibold px-2.5 py-1.5 rounded-full bg-[var(--card)] text-[var(--ink2)] flex items-center gap-1"><Check size={10} className="text-[var(--sage-deep)]" />{r}</span>
              ))}
            </div>
            {/* Значок QR отсюда убран вместе с обещанием «покажите QR»:
                это была иконка, а не код — показывать было нечего.
                Генератора QR в приложении нет (тот же случай, что в альбоме
                и в приглашениях). */}
            <div className="card-s p-4 mt-4 flex items-center gap-3">
              <Link2 size={22} className="text-[var(--ink2)] shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-bold tabular truncate">{inviteUrl(inviteCode)}</p>
                <p className="text-[9.5px] text-[var(--soft)]">{t('одноразовая ссылка — отправьте её лично')}</p>
              </div>
              <button onClick={() => copy(inviteUrl(inviteCode))} className="press w-10 h-10 rounded-full grad text-[var(--on-grad)] flex items-center justify-center shrink-0">{copied ? <Check size={15} /> : <Copy size={15} />}</button>
            </div>
            <button onClick={() => { copy(inviteUrl(inviteCode)); setInvite(null) }} className="press w-full h-[52px] rounded-full grad text-[var(--on-grad)] font-semibold text-[14px] mt-4" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>
              {copied ? t('✓ Скопировано!') : t('Скопировать ссылку')}
            </button>
            {/* Кнопка называлась «Отправить в чат» и просто открывала список
                чатов: ссылка оставалась здесь, отправлять было нечего.
                Теперь она кладёт ссылку в буфер и ведёт туда, где её вставить. */}
            <button onClick={() => { copy(inviteUrl(inviteCode)); nav('/us/chats') }} className="press w-full h-[48px] rounded-full bg-[var(--card)] font-semibold text-[13px] mt-2" style={{ boxShadow: 'var(--shadow)' }}>{t('Скопировать и открыть чаты')}</button>
          </div>
        </div>
      )}
    </div>
  )
}

/* Принятие приглашения: /join/:code */
/* Роль на экране приглашения выводится из ответа сервера, а не из строки кода:
   код читаемый, но он подсказка человеку, а не источник прав. */
const ROLE_CARD: Record<string, typeof ROLES[number]> = {
  couple: ROLES[0], helper: ROLES[1], coordinator: ROLES[2], vendor: ROLES[3],
}

export function Join() {
  const nav = useNavigate()
  const { code } = useParams()
  const { finishOnboarding, setWeddingId } = useStore()
  const [joined, setJoined] = useState(false)
  const [preview, setPreview] = useState<{ role?: string; weddingTitle?: string; inviterName?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  /* Что за приглашение — спрашиваем сервер. Раньше роль угадывалась по
     подстроке в коде, а имена пары и дата были нарисованы в разметке: экран
     показывал «Алина и Тимур · 14 июня 2027» кому угодно по любой ссылке. */
  useEffect(() => {
    if (!code) return
    let alive = true
    void api.get(url('/invites/{code}', { code }))
      .then(p => { if (alive) setPreview(p ?? null) })
      .catch(e => {
        if (!alive) return
        setErr(e instanceof ApiError
          ? (e.status === 410 ? t('Ссылка истекла или отозвана') : e.isDown ? t('Сервер недоступен. Попробуйте позже') : e.message)
          : t('Что-то пошло не так'))
      })
    return () => { alive = false }
  }, [code])

  const accept = async () => {
    if (!code || busy) return
    setBusy(true); setErr(null)
    try {
      await api.post(url('/invites/{code}/accept', { code }))
      /* Свадьба у приглашённого появляется только сейчас: до принятия он в
         ней не состоит, и `GET /weddings` вернул бы пусто. */
      const id = await findMyWedding()
      if (id) setWeddingId(id)
      setJoined(true)
    } catch (e) {
      setErr(e instanceof ApiError
        ? (e.status === 401 ? t('Сначала войдите — код придёт по SMS') : e.isDown ? t('Сервер недоступен. Попробуйте позже') : e.message)
        : t('Что-то пошло не так'))
    } finally { setBusy(false) }
  }

  const isPartner = preview?.role === 'couple'
  const role = ROLE_CARD[preview?.role ?? 'helper'] ?? ROLES[1]

  if (joined) return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center fade-up">
      <div className="w-[92px] h-[92px] rounded-full grad flex items-center justify-center text-[var(--on-grad)] pop" style={{ boxShadow: '0 20px 44px -14px rgba(201,138,138,.6)' }}><Heart size={36} fill="#fff" /></div>
      <h1 className="font-serif-d text-[28px] mt-7">{t('Вы в команде!')}</h1>
      <p className="text-[13px] text-[var(--soft)] mt-3 font-light leading-relaxed">
        {/* Имя приглашающего и название свадьбы приходят с сервера вместе с
            превью приглашения. Раньше здесь у всех стояли «Алина» и «Алина и
            Тимур» — и строка партнёра вдобавок не переводилась. */}
        {isPartner
          ? t('Теперь свадьба у вас общая: бюджет, команда, гости — всё синхронизировано.')
          : `${preview?.inviterName ?? t('Пара')} ${t('добавил(а) вас в пространство свадьбы. Организуем вместе!')}`}
      </p>
      <button onClick={() => { finishOnboarding(); nav('/home') }} className="press w-full h-[54px] rounded-full grad text-[var(--on-grad)] font-semibold text-[14px] mt-8" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>{t('Открыть нашу свадьбу ✨')}</button>
    </div>
  )

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center">
      <Tile icon={role.icon} tile={role.tile} size={72} />
      {/* Без ответа сервера имени свадьбы нет — не склеиваем заглушку с
          «приглашают вас», иначе выходит «Вас приглашают приглашают вас». */}
      <h1 className="font-serif-d text-[26px] mt-6">
        {preview?.weddingTitle ? <>{preview.weddingTitle}<br />{t('приглашают вас')}</> : t('Приглашение')}
      </h1>
      {preview && <p className="text-[12.5px] text-[var(--soft)] mt-2">{t('как')} <b className="text-[var(--rose-ink)]">{role.name.toLowerCase()}</b></p>}
      {err && <p role="alert" className="text-[12px] text-[var(--rose-ink)] mt-3 leading-relaxed">{err}</p>}
      <div className="card p-4 mt-6 w-full text-left">
        <span className="text-[10px] tracking-[.16em] uppercase text-[var(--soft)] font-semibold">{t('Вам будет доступно')}</span>
        <div className="mt-2.5 space-y-1.5">
          {role.rights.map(r => <p key={r} className="text-[12px] text-[var(--ink2)] flex items-center gap-2"><Check size={12} className="text-[var(--sage-deep)]" />{r}</p>)}
        </div>
      </div>
      <button onClick={() => void accept()} disabled={busy || !preview} className={cn('press w-full h-[54px] rounded-full grad text-[var(--on-grad)] font-semibold text-[14px] mt-5', (busy || !preview) && 'opacity-40')} style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>{busy ? t('Секунду…') : t('Принять приглашение')}</button>
      {/* Тупика быть не должно: приглашение не открылось — человек всё равно
          должен куда-то уйти, а не остаться на экране с одной серой кнопкой. */}
      {!preview && (
        <button onClick={() => nav('/')} className="press w-full text-center text-[12px] text-[var(--soft)] mt-4">{t('Открыть приложение')}</button>
      )}
      <p className="text-[10px] text-[var(--soft2)] mt-4 flex items-center gap-1.5"><Users size={11} />{t('код')} {code}{t('· одноразовый')}</p>
    </div>
  )
}
