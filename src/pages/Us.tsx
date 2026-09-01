import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ChevronLeft, Send, Settings, Globe, Bell, Shield, LogOut, FileText, ImagePlus, LifeBuoy, Store, PartyPopper, GitCompareArrows } from 'lucide-react'
import { chats, chatMessages, couple } from '@/lib/data'
import { Tile, TopBar } from '@/components/chrome'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'

/* «Мы» — профиль пары */
export function Us() {
  const { lang, setLang } = useStore()
  const nav = useNavigate()
  return (
    <div className="pb-28">
      <TopBar title="Мы" sub="Профиль пары и настройки" />
      <div className="px-5 mt-3">
        <div className="card p-5 text-center fade-up">
          <div className="flex justify-center -space-x-3.5">
            <div className="w-16 h-16 rounded-full bg-[#C98A8A] text-white font-serif-d text-[26px] flex items-center justify-center border-4 border-white">А</div>
            <div className="w-16 h-16 rounded-full bg-[#A9BCA0] text-white font-serif-d text-[26px] flex items-center justify-center border-4 border-white">Т</div>
          </div>
          <b className="font-serif-d text-[20px] block mt-3">{couple.full}</b>
          <p className="text-[11.5px] text-[#93897F] mt-1">{couple.date} · {couple.city} · {couple.venue}</p>
          <button className="press mt-4 px-5 h-[42px] rounded-full bg-[#FBF6F1] text-[12px] font-semibold text-[#B57171]">
            + Пригласить партнёра кодом
          </button>
        </div>

        <div className="card px-4 py-1.5 mt-4">
          {[
            { icon: Settings, label: 'Настройки', tile: 'bg-[#F3E3D3]', to: '/settings' },
            { icon: Bell, label: 'Уведомления и тихие часы', tile: 'bg-[#F0DCB8]', badge: '22:00–09:00', to: '/settings' },
            { icon: LifeBuoy, label: 'Поддержка и FAQ', tile: 'bg-[#F2DFDC]', to: '/support' },
            { icon: FileText, label: 'Оферта и конфиденциальность', tile: 'bg-[#C3D5E8]', to: '/support' },
            { icon: Shield, label: 'Сессии и устройства', tile: 'bg-[#E6EEE2]', to: '/settings' },
          ].map(it => (
            <button key={it.label} onClick={() => nav(it.to)} className="press w-full flex items-center gap-3 py-3.5 text-left border-b border-[#F1E9E2] last:border-none">
              <Tile icon="" tile={it.tile} size={38} />
              <span className="absolute ml-3"><it.icon size={16} className="text-[#5C554B]" /></span>
              <span className="flex-1 text-[13px] font-medium ml-1">{it.label}</span>
              {it.badge && <span className="text-[9.5px] text-[#93897F]">{it.badge}</span>}
            </button>
          ))}
          <div className="flex items-center gap-3 py-3.5">
            <Tile icon="" tile="bg-[#D9CCE3]" size={38} />
            <span className="absolute ml-3"><Globe size={16} className="text-[#5C554B]" /></span>
            <span className="flex-1 text-[13px] font-medium ml-1">Язык интерфейса</span>
            <div className="flex bg-[#FBF6F1] rounded-full p-1">
              {(['ru', 'en'] as const).map(l => (
                <button key={l} onClick={() => setLang(l)} className={cn('press px-3.5 py-1.5 rounded-full text-[11px] font-bold uppercase', lang === l ? 'grad text-white' : 'text-[#93897F]')}>{l}</button>
              ))}
            </div>
          </div>
        </div>

        <div className="card px-4 py-1.5 mt-3.5">
          {[
            { icon: GitCompareArrows, label: 'Сравнение подрядчиков', tile: 'bg-[#D9CCE3]', to: '/compare' },
            { icon: PartyPopper, label: 'После свадьбы', tile: 'bg-[#F0DCB8]', to: '/after' },
            { icon: Store, label: 'Кабинет подрядчика', tile: 'bg-[#E6EEE2]', badge: 'демо', to: '/vendor-app' },
          ].map(it => (
            <button key={it.label} onClick={() => nav(it.to)} className="press w-full flex items-center gap-3 py-3.5 text-left border-b border-[#F1E9E2] last:border-none">
              <Tile icon="" tile={it.tile} size={38} />
              <span className="absolute ml-3"><it.icon size={16} className="text-[#5C554B]" /></span>
              <span className="flex-1 text-[13px] font-medium ml-1">{it.label}</span>
              {it.badge && <span className="text-[9.5px] text-[#93897F]">{it.badge}</span>}
            </button>
          ))}
        </div>

        <button onClick={() => nav('/auth')} className="press w-full card-s mt-4 py-4 text-[13px] font-semibold text-[#B57171] flex items-center justify-center gap-2">
          <LogOut size={15} /> Выйти из аккаунта
        </button>
        <p className="text-center text-[10px] text-[#BFB5AA] mt-4">Тили-тили v0.1 · MVP · сделано с любовью в Уфе</p>
      </div>
    </div>
  )
}

/* Список чатов */
export function Chats() {
  const nav = useNavigate()
  return (
    <div className="pb-28">
      <TopBar back title="Чаты" sub="Подрядчики · команда · день X" />
      <div className="px-5 mt-3 space-y-2.5 stagger">
        {chats.map(c => (
          <button key={c.id} onClick={() => nav(`/us/chats/${c.id}`)} className="press w-full card-s p-3.5 flex items-center gap-3 text-left fade-up">
            <Tile icon={c.icon} tile={c.tile} size={48} />
            <div className="flex-1 min-w-0">
              <div className="flex justify-between items-baseline gap-2">
                <b className="text-[13.5px] truncate">{c.name}</b>
                <span className="text-[10px] text-[#93897F] shrink-0">{c.time}</span>
              </div>
              <p className="text-[11.5px] text-[#93897F] truncate mt-0.5">{c.last}</p>
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
  const [msgs, setMsgs] = useState(chatMessages)
  const [text, setText] = useState('')
  const send = () => {
    if (!text.trim()) return
    setMsgs(m => [...m, { id: `m${m.length + 1}`, me: false, text: text.trim(), time: 'сейчас' }])
    setText('')
  }
  return (
    <div className="h-dvh flex flex-col">
      <div className="glass-tab border-t-0 border-b px-4 pt-6 pb-3 flex items-center gap-3 z-10">
        <button onClick={() => nav(-1)} className="press w-9 h-9 rounded-full bg-white flex items-center justify-center" style={{ boxShadow: 'var(--shadow)' }} aria-label="Назад">
          <ChevronLeft size={17} />
        </button>
        <Tile icon={chat.icon} tile={chat.tile} size={38} />
        <div className="flex-1 min-w-0">
          <b className="text-[14px] block truncate">{chat.name}</b>
          <span className="text-[10px] text-[#7E9A74]">● онлайн · сделка: фотограф, 14.06</span>
        </div>
        <button className="press w-9 h-9 rounded-full bg-white flex items-center justify-center" style={{ boxShadow: 'var(--shadow)' }} aria-label="Вложение"><ImagePlus size={16} /></button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2.5">
        <div className="text-center"><span className="text-[9.5px] text-[#93897F] bg-white px-3 py-1.5 rounded-full" style={{ boxShadow: 'var(--shadow)' }}>Сделка: Фотограф · 85 000 ₽ · забронировано</span></div>
        {msgs.map(m => (
          <div key={m.id} className={cn('flex fade-up', m.me ? 'justify-start' : 'justify-end')}>
            <div className={cn('max-w-[78%] px-4 py-3 text-[13px] leading-relaxed',
              m.me ? 'card rounded-br-[6px] text-[#2E2A26]' : 'grad text-white rounded-bl-[6px]')}
              style={{ borderRadius: 18 }}>
              {m.text}
              <span className={cn('block text-[9px] mt-1 text-right', m.me ? 'text-[#93897F]' : 'text-white/70')}>{m.time}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="glass-tab border-t-0 border-b-0 px-4 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] flex gap-2.5">
        <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()}
          placeholder="Сообщение…" className="flex-1 bg-white rounded-full px-5 h-[48px] text-[13.5px] outline-none placeholder:text-[#BFB5AA]" style={{ boxShadow: 'var(--shadow)' }} />
        <button onClick={send} className="press w-[48px] h-[48px] rounded-full grad text-white flex items-center justify-center shrink-0" aria-label="Отправить"><Send size={17} /></button>
      </div>
    </div>
  )
}
