import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Check, ChevronRight, Copy, Crown, Heart, Link2, QrCode, Shield, Users, X } from 'lucide-react'
import { Tile, TopBar } from '@/components/chrome'
import { useStore } from '@/lib/store'
import { cn, copyText } from '@/lib/utils'
import { t } from '@/lib/i18n'
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

/* Одноразовый код приглашения. Вынесен из компонента: Math.random() в теле
   компонента линтер справедливо считает нечистым вызовом рендера. */
function makeInviteCode(roleId: string): string {
  const prefix = roleId === 'partner' ? 'ПАРА' : roleId === 'helper' ? 'ДРУГ' : roleId === 'coordinator' ? 'КООРД' : 'ПОДР'
  return `ТИЛИ-${prefix}-${Math.floor(1000 + Math.random() * 9000)}`
}

export function Team() {
  const nav = useNavigate()
  const { city } = useStore()
  const [invite, setInvite] = useState<typeof ROLES[number] | null>(null)
  const [inviteCode, setInviteCode] = useState('')
  const [copied, setCopied] = useState(false)
  const [revoked, setRevoked] = useState<number[]>([])
  useEscape(() => setInvite(null), invite !== null)
  /* Код выпускается в обработчике открытия шторки, а не в рендере — иначе он
     менялся бы при каждой перерисовке, и кнопки копировали разные ссылки. */
  const openInvite = (r: typeof ROLES[number]) => {
    setInviteCode(makeInviteCode(r.id))
    setInvite(r)
  }
  const members = [
    { n: t('Алина (вы)'), role: t('Пара · создатель'), icon: '👰', tile: 'bg-[var(--rose-soft)]', online: true },
    { n: t('Тимур'), role: t('Пара · приглашён'), icon: '🤵', tile: 'bg-[var(--blue)]', online: false },
    { n: t('Алсу'), role: t('Координатор · главная в день X'), icon: '🎖', tile: 'bg-[var(--honey)]', online: true },
  ]
  const invites = [
    { code: t('ТИЛИ-ДРУГ-3310'), role: t('Помощник'), left: t('6 дней') },
    { code: t('ТИЛИ-КООРД-5520'), role: t('Координатор'), left: t('5 дней') },
    { code: t('ТИЛИ-ФОТО-0917'), role: t('Подрядчик · Елена Смирнова'), left: t('2 дня') },
  ]
  const copy = (text: string) => { copyText(text); setCopied(true); setTimeout(() => setCopied(false), 1800) }
  const url = (code: string) => `tili-tili.ru/join/${code}`

  return (
    <div className="pb-28">
      <TopBar back title={t('Наша команда')} sub={`${t('единое пространство · ')}${city}`} />
      <div className="px-5 mt-3 space-y-3.5">
        {/* Кто уже внутри */}
        <div className="card px-4 py-1.5">
          {members.map((m, k) => (
            <div key={m.n} className={cn('flex items-center gap-3 py-3.5', k !== members.length - 1 && 'border-b border-[var(--track)]')}>
              <div className="relative">
                <Tile icon={m.icon} tile={m.tile} size={42} />
                {m.online && <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-[#A9BCA0] border-2 border-white" />}
              </div>
              <div className="flex-1">
                <b className="text-[13px]">{m.n}</b>
                <p className="text-[10px] text-[var(--soft)]">{m.role}{m.online ? ' · онлайн' : ''}</p>
              </div>
              <Crown size={14} className="text-[var(--gold-soft)]" />
            </div>
          ))}
        </div>
        <p className="text-[10.5px] text-[var(--soft)] px-1 leading-relaxed">{t('💡 Все правки синхронизируются мгновенно: Тимур добавит расход — вы увидите его в бюджете сразу.')}</p>

        {/* Пригласить */}
        <div className="flex justify-between items-baseline px-1 mt-2">
          <h2 className="font-serif-d text-[18px]">{t('Пригласить')}</h2>
        </div>
        <div className="space-y-2.5">
          {ROLES.map(r => (
            <button key={r.id} onClick={() => openInvite(r)} className="press w-full card p-4 flex items-center gap-3.5 text-left">
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
          <span className="text-[10px] text-[var(--soft)]">{invites.length - revoked.length} {t('действуют')}</span>
        </div>
        <div className="card px-4 py-1.5">
          {invites.map((iv, k) => !revoked.includes(k) && (
            <div key={iv.code} className={cn('flex items-center gap-3 py-3.5 fade-up', k !== invites.length - 1 && 'border-b border-[var(--track)]')}>
              <Link2 size={15} className="text-[var(--sage-deep)] shrink-0" />
              <div className="flex-1 min-w-0">
                <b className="text-[12.5px] tabular">{iv.code}</b>
                <p className="text-[10px] text-[var(--soft)]">{iv.role} · истекает через {iv.left}</p>
              </div>
              <button onClick={() => copy(url(iv.code))} className="press text-[10.5px] font-bold text-[var(--sage-deep)]">{copied ? '✓' : t('Копия')}</button>
              <button onClick={() => setRevoked(r => [...r, k])} className="press text-[var(--soft)]"><X size={14} /></button>
            </div>
          ))}
        </div>

        <div className="card-s px-4 py-3 flex gap-2.5">
          <Shield size={15} className="text-[var(--sage-deep)] shrink-0 mt-0.5" />
          <p className="text-[11px] text-[var(--ink2)] leading-relaxed"><b>{t('Безопасность:')}</b> {t('каждая ссылка одноразовая и живёт 7 дней. Отозвать можно в один тап — человек сразу потеряет доступ.')}</p>
        </div>
      </div>

      {/* Шторка приглашения */}
      {invite && (
        <div role="dialog" aria-modal="true" aria-label={t('Пригласить в команду')} className="fixed inset-0 z-50 bg-black/40 flex items-end justify-center" onClick={() => setInvite(null)}>
          <div className="w-full max-w-[430px] bg-[var(--bg)] rounded-t-[32px] p-6 pb-[max(28px,env(safe-area-inset-bottom))] fade-up" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3">
              <Tile icon={invite.icon} tile={invite.tile} size={46} />
              <div className="flex-1">
                <b className="font-serif-d text-[19px]">{t('Пригласить:')}{invite.name}</b>
                <p className="text-[10.5px] text-[var(--soft)]">{t('ссылка одноразовая · живёт 7 дней')}</p>
              </div>
              <button onClick={() => setInvite(null)} className="press w-9 h-9 rounded-full bg-[var(--card)] flex items-center justify-center"><X size={15} /></button>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-4">
              {invite.rights.map(r => (
                <span key={r} className="text-[10px] font-semibold px-2.5 py-1.5 rounded-full bg-[var(--card)] text-[var(--ink2)] flex items-center gap-1"><Check size={10} className="text-[var(--sage-deep)]" />{r}</span>
              ))}
            </div>
            <div className="card-s p-4 mt-4 flex items-center gap-3">
              <QrCode size={40} className="text-[var(--ink)] shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-bold tabular truncate">{url(inviteCode)}</p>
                <p className="text-[9.5px] text-[var(--soft)]">{t('отправьте ссылку или покажите QR')}</p>
              </div>
              <button onClick={() => copy(url(inviteCode))} className="press w-10 h-10 rounded-full grad text-white flex items-center justify-center shrink-0">{copied ? <Check size={15} /> : <Copy size={15} />}</button>
            </div>
            <button onClick={() => { copy(url(inviteCode)); setInvite(null) }} className="press w-full h-[52px] rounded-full grad text-white font-semibold text-[14px] mt-4" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>
              {copied ? t('✓ Скопировано!') : t('Скопировать ссылку')}
            </button>
            <button onClick={() => nav('/us/chats')} className="press w-full h-[48px] rounded-full bg-[var(--card)] font-semibold text-[13px] mt-2" style={{ boxShadow: 'var(--shadow)' }}>{t('Отправить в чат')}</button>
          </div>
        </div>
      )}
    </div>
  )
}

/* Принятие приглашения: /join/:code */
export function Join() {
  const nav = useNavigate()
  const { code } = useParams()
  const { finishOnboarding } = useStore()
  const [joined, setJoined] = useState(false)
  const isPartner = (code ?? '').includes('ПАРА')
  const role = isPartner ? ROLES[0] : (code ?? '').includes('ПОДР') ? ROLES[2] : ROLES[1]

  if (joined) return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center fade-up">
      <div className="w-[92px] h-[92px] rounded-full grad flex items-center justify-center text-white pop" style={{ boxShadow: '0 20px 44px -14px rgba(201,138,138,.6)' }}><Heart size={36} fill="#fff" /></div>
      <h1 className="font-serif-d text-[28px] mt-7">{t('Вы в команде!')}</h1>
      <p className="text-[13px] text-[var(--soft)] mt-3 font-light leading-relaxed">
        {isPartner ? 'Теперь у вас с Алиной одна общая свадьба: бюджет, команда, гости — всё синхронизировано.' : t('Алина и Тимур добавили вас в пространство свадьбы. Организуем вместе!')}
      </p>
      <button onClick={() => { finishOnboarding(); nav('/home') }} className="press w-full h-[54px] rounded-full grad text-white font-semibold text-[14px] mt-8" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>{t('Открыть нашу свадьбу ✨')}</button>
    </div>
  )

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center">
      <Tile icon={role.icon} tile={role.tile} size={72} />
      <h1 className="font-serif-d text-[26px] mt-6">{t('Алина и Тимур')}<br />{t('приглашают вас')}</h1>
      <p className="text-[12.5px] text-[var(--soft)] mt-2">{t('как')} <b className="text-[var(--rose-deep)]">{role.name.toLowerCase()}</b>{t('· свадьба 14 июня 2027')}</p>
      <div className="card p-4 mt-6 w-full text-left">
        <span className="text-[10px] tracking-[.16em] uppercase text-[var(--soft)] font-semibold">{t('Вам будет доступно')}</span>
        <div className="mt-2.5 space-y-1.5">
          {role.rights.map(r => <p key={r} className="text-[12px] text-[var(--ink2)] flex items-center gap-2"><Check size={12} className="text-[var(--sage-deep)]" />{r}</p>)}
        </div>
      </div>
      <button onClick={() => setJoined(true)} className="press w-full h-[54px] rounded-full grad text-white font-semibold text-[14px] mt-5" style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>{t('Принять приглашение')}</button>
      <p className="text-[10px] text-[var(--soft2)] mt-4 flex items-center gap-1.5"><Users size={11} />{t('код')} {code}{t('· одноразовый')}</p>
    </div>
  )
}
