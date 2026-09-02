import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ChevronLeft, Send, Settings, Globe, Bell, Shield, LogOut, FileText, ImagePlus, LifeBuoy, Store, PartyPopper, GitCompareArrows } from 'lucide-react'
import { chats, chatMessages, couple } from '@/lib/data'
import { Tile, TopBar } from '@/components/chrome'
import { useStore } from '@/lib/store'
import { usePersist } from '@/lib/usePersist'
import { cn, copyText, goBack } from '@/lib/utils'
import { t, reloadToRoot } from '@/lib/i18n'

/* «Мы» — профиль пары */
export function Us() {
  const { lang, setLang } = useStore()
  const nav = useNavigate()
  const [copied, setCopied] = useState(false)
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
          <div className="flex justify-center -space-x-3.5">
            <div className="w-16 h-16 rounded-full bg-[#C98A8A] text-white font-serif-d text-[26px] flex items-center justify-center border-4 border-white">{t('А')}</div>
            <div className="w-16 h-16 rounded-full bg-[#A9BCA0] text-white font-serif-d text-[26px] flex items-center justify-center border-4 border-white">{t('Т')}</div>
          </div>
          <b className="font-serif-d text-[20px] block mt-3">{couple.full}</b>
          <p className="text-[11.5px] text-[var(--soft)] mt-1">{couple.date} · {couple.city} · {couple.venue}</p>
          <button onClick={() => nav('/us/team')} className="press mt-4 px-5 h-[42px] rounded-full bg-[var(--bg)] text-[12px] font-semibold text-[var(--rose-deep)]">
            {t('+ Пригласить в команду (партнёр, помощники, подрядчики)')}
          </button>
        </div>

        <div className="card p-5 mt-4 relative overflow-hidden">
          <div className="absolute -right-8 -top-8 w-28 h-28 rounded-full bg-[var(--rose-soft)] opacity-70" />
          <span className="text-[10px] tracking-[.18em] uppercase text-[var(--rose-deep)] font-semibold relative">{t('Реферальная программа')}</span>
          <p className="text-[12px] text-[var(--ink2)] mt-2 leading-relaxed relative">{t('Пригласите пару — оба получите')}<b>3 000 ₽</b>{t('на премиум-функции после её первой сделки.')}</p>
          <div className="flex items-center gap-2.5 mt-3.5 relative">
            <div className="flex-1 card-s px-4 py-3 flex items-center justify-between">
              <b className="text-[13px] tracking-[.12em]">{t('ТИЛИ-АЛИНА')}</b>
              <span className="text-[9.5px] text-[var(--soft)]">{t('приглашено: 2')}</span>
            </div>
            <button onClick={() => copy(t('ТИЛИ-АЛИНА'), () => setCopied(true))} className="press h-[44px] px-5 rounded-full grad text-white text-[12px] font-semibold">{copied ? t('✓ Скопировано') : t('Копировать')}</button>
          </div>
        </div>

        <div className="card px-4 py-1.5 mt-4">
          {[
            { icon: Settings, label: t('Настройки'), tile: 'bg-[var(--peach)]', to: '/settings' },
            { icon: Bell, label: t('Уведомления и тихие часы'), tile: 'bg-[var(--honey)]', badge: '22:00–09:00', to: '/settings' },
            { icon: LifeBuoy, label: t('Поддержка и FAQ'), tile: 'bg-[var(--rose-soft)]', to: '/support' },
            { icon: FileText, label: t('Оферта и конфиденциальность'), tile: 'bg-[var(--blue)]', to: '/support' },
            { icon: Shield, label: t('Сессии и устройства'), tile: 'bg-[var(--sage-soft)]', to: '/settings' },
          ].map(it => (
            <button key={it.label} onClick={() => nav(it.to)} className="press w-full flex items-center gap-3 py-3.5 text-left border-b border-[var(--track)] last:border-none">
              <Tile icon="" tile={it.tile} size={38} />
              <span className="absolute ml-3"><it.icon size={16} className="text-[var(--ink2)]" /></span>
              <span className="flex-1 text-[13px] font-medium ml-1">{it.label}</span>
              {it.badge && <span className="text-[9.5px] text-[var(--soft)]">{it.badge}</span>}
            </button>
          ))}
          <div className="flex items-center gap-3 py-3.5">
            <Tile icon="" tile="bg-[var(--lav)]" size={38} />
            <span className="absolute ml-3"><Globe size={16} className="text-[var(--ink2)]" /></span>
            <span className="flex-1 text-[13px] font-medium ml-1">{t('Язык интерфейса')}</span>
            <div className="flex bg-[var(--bg)] rounded-full p-1">
              {(['ru', 'en'] as const).map(l => (
                <button key={l} onClick={() => { if (l !== lang) { setLang(l); reloadToRoot() } }} className={cn('press px-3.5 py-1.5 rounded-full text-[11px] font-bold uppercase', lang === l ? 'grad text-white' : 'text-[var(--soft)]')}>{l}</button>
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
            { icon: Store, label: t('Кабинет подрядчика'), tile: 'bg-[var(--sage-soft)]', badge: t('демо'), to: '/vendor-app' },
          ].map(it => (
            <button key={it.label} onClick={() => nav(it.to)} className="press w-full flex items-center gap-3 py-3.5 text-left border-b border-[var(--track)] last:border-none">
              <Tile icon="" tile={it.tile} size={38} />
              <span className="absolute ml-3"><it.icon size={16} className="text-[var(--ink2)]" /></span>
              <span className="flex-1 text-[13px] font-medium ml-1">{it.label}</span>
              {it.badge && <span className="text-[9.5px] text-[var(--soft)]">{it.badge}</span>}
            </button>
          ))}
        </div>

        <button onClick={() => nav('/auth')} className="press w-full card-s mt-4 py-4 text-[13px] font-semibold text-[var(--rose-deep)] flex items-center justify-center gap-2">
          <LogOut size={15} /> {t('Выйти из аккаунта')}
        </button>
        <p className="text-center text-[10px] text-[var(--soft2)] mt-4">{t('Тили-тили v0.1 · MVP · сделано с любовью в Уфе')}</p>
      </div>
    </div>
  )
}

/* Список чатов */
export function Chats() {
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const shown = chats.filter(c => c.name.toLowerCase().includes(q.toLowerCase()) || c.last.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="pb-28">
      <TopBar back title={t('Чаты')} sub={t('Подрядчики · команда · день X')} />
      <div className="px-5 mt-3">
        <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder={t('Поиск по чатам…')} className="w-full card-s px-4 py-3 text-[13px] outline-none placeholder:text-[var(--soft2)]" />
      </div>
      <div className="px-5 mt-3 space-y-2.5 stagger">
        {shown.map(c => (
          <button key={c.id} onClick={() => nav(`/us/chats/${c.id}`)} className="press w-full card-s p-3.5 flex items-center gap-3 text-left fade-up">
            <Tile icon={c.icon} tile={c.tile} size={48} />
            <div className="flex-1 min-w-0">
              <div className="flex justify-between items-baseline gap-2">
                <b className="text-[13.5px] truncate">{c.name}</b>
                <span className="text-[10px] text-[var(--soft)] shrink-0">{c.time}</span>
              </div>
              <p className="text-[11.5px] text-[var(--soft)] truncate mt-0.5">{c.last}</p>
            </div>
            {c.unread > 0 && <span className="w-5 h-5 rounded-full grad text-white text-[10px] font-bold flex items-center justify-center shrink-0">{c.unread}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

/* Диалог */
export function Chat() {
  const { id } = useParams()
  const nav = useNavigate()
  const chat = chats.find(c => c.id === id) ?? chats[0]
  const [msgs, setMsgs] = usePersist(`tt_chat_${id}`, chatMessages)
  const [text, setText] = useState('')
  const [typing, setTyping] = useState(false)
  const send = () => {
    if (!text.trim()) return
    setMsgs(m => [...m, { id: `m${m.length + 1}`, me: false, text: text.trim(), time: t('сейчас') }])
    setText('')
    setTyping(true)
    setTimeout(() => {
      setMsgs(m => [...m, { id: `m${m.length + 1}`, me: true, text: t('Отлично, принято! Отвечу подробно чуть позже сегодня 🙌'), time: t('сейчас') }])
      setTyping(false)
    }, 1600)
  }
  return (
    <div className="h-dvh flex flex-col">
      <div className="glass-tab border-t-0 border-b px-4 pt-6 pb-3 flex items-center gap-3 z-10">
        <button onClick={() => goBack(n => nav(n), (to, o) => nav(to, o), '/us/chats')} className="press w-9 h-9 rounded-full bg-[var(--card)] flex items-center justify-center" style={{ boxShadow: 'var(--shadow)' }} aria-label={t('Назад')}>
          <ChevronLeft size={17} />
        </button>
        <Tile icon={chat.icon} tile={chat.tile} size={38} />
        <div className="flex-1 min-w-0">
          <b className="text-[14px] block truncate">{chat.name}</b>
          <span className="text-[10px] text-[var(--sage-deep)]">{t('● онлайн · сделка: фотограф, 14.06')}</span>
        </div>
        <button onClick={() => setMsgs(m => [...m, { id: `m${m.length + 1}`, me: false, text: t('📷 Референс_букета.jpg · 2,4 МБ'), time: t('сейчас') }])} className="press w-9 h-9 rounded-full bg-[var(--card)] flex items-center justify-center" style={{ boxShadow: 'var(--shadow)' }} aria-label={t('Вложение')}><ImagePlus size={16} /></button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2.5">
        <div className="text-center"><button onClick={() => nav('/deal')} className="press text-[9.5px] text-[var(--soft)] bg-[var(--card)] px-3 py-1.5 rounded-full" style={{ boxShadow: 'var(--shadow)' }}>{t('Сделка: Фотограф · 85 000 ₽ · забронировано →')}</button></div>
        {msgs.map(m => (
          <div key={m.id} className={cn('flex fade-up', m.me ? 'justify-start' : 'justify-end')}>
            <div className={cn('max-w-[78%] px-4 py-3 text-[13px] leading-relaxed',
              m.me ? 'card rounded-br-[6px] text-[var(--ink)]' : 'grad text-white rounded-bl-[6px]')}
              style={{ borderRadius: 18 }}>
              {m.text}
              <span className={cn('block text-[9px] mt-1 text-right', m.me ? 'text-[var(--soft)]' : 'text-white/70')}>{m.time}</span>
            </div>
          </div>
        ))}
        {typing && (
          <div className="flex justify-start fade-up">
            <div className="card rounded-[18px] px-4 py-3 flex gap-1">
              {[0, 1, 2].map(d => <span key={d} className="w-1.5 h-1.5 rounded-full bg-[#C98A8A] animate-bounce" style={{ animationDelay: `${d * 0.15}s` }} />)}
            </div>
          </div>
        )}
      </div>

      <div className="glass-tab border-t-0 border-b-0 px-4 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] flex gap-2.5">
        <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()}
          placeholder={t('Сообщение…')} className="flex-1 bg-[var(--card)] rounded-full px-5 h-[48px] text-[13.5px] outline-none placeholder:text-[var(--soft2)]" style={{ boxShadow: 'var(--shadow)' }} />
        <button onClick={send} className="press w-[48px] h-[48px] rounded-full grad text-white flex items-center justify-center shrink-0" aria-label={t('Отправить')}><Send size={17} /></button>
      </div>
    </div>
  )
}
