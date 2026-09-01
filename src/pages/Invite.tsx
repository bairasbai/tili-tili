import { useState } from 'react'
import { MapPin, Clock3, Heart, CalendarPlus, UtensilsCrossed, Bus, Baby } from 'lucide-react'
import { couple, timeline } from '@/lib/data'
import { cn } from '@/lib/utils'

/* Гостевое приглашение: шторы → скролл-история → RSVP с вопросами */
export default function Invite() {
  const [opened, setOpened] = useState(false)
  const [rsvp, setRsvp] = useState<'yes' | 'no' | null>(null)
  const [plus, setPlus] = useState<boolean | null>(null)
  const [meal, setMeal] = useState<string | null>(null)
  const [transfer, setTransfer] = useState<boolean | null>(null)
  const [sent, setSent] = useState(false)

  return (
    <div className="min-h-dvh relative overflow-hidden" style={{ background: '#F6EDE7' }}>

      {/* ── Сцена открытия: бархатные шторы ── */}
      <div className={cn('fixed inset-0 z-50 pointer-events-none transition-opacity duration-700', opened && 'opacity-0')}>
        <div className={cn('absolute inset-y-0 left-0 w-1/2 transition-transform duration-[1400ms]', opened && '-translate-x-full')}
          style={{ background: 'repeating-linear-gradient(90deg,#8E3B3B 0 14px,#7C3232 14px 28px,#964242 28px 42px)', transitionTimingFunction: 'cubic-bezier(.22,1,.36,1)', boxShadow: 'inset -30px 0 60px -30px rgba(0,0,0,.5)' }} />
        <div className={cn('absolute inset-y-0 right-0 w-1/2 transition-transform duration-[1400ms]', opened && 'translate-x-full')}
          style={{ background: 'repeating-linear-gradient(90deg,#8E3B3B 0 14px,#7C3232 14px 28px,#964242 28px 42px)', transitionTimingFunction: 'cubic-bezier(.22,1,.36,1)', boxShadow: 'inset 30px 0 60px -30px rgba(0,0,0,.5)' }} />
        {!opened && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-8 pointer-events-auto">
            <span className="text-[10px] tracking-[.34em] uppercase font-semibold" style={{ color: '#E8C9B8' }}>Приглашение на свадьбу</span>
            <div className="w-[74px] h-[74px] rounded-full mt-8 flex items-center justify-center font-serif-d text-[20px] pop"
              style={{ background: 'linear-gradient(135deg,#D9A8A0,#B57171)', color: '#FFF7F0', boxShadow: '0 14px 34px -10px rgba(0,0,0,.5), inset 0 0 0 3px rgba(255,247,240,.35)' }}>
              А♥Т
            </div>
            <h1 className="font-serif-d text-[34px] mt-7 leading-tight" style={{ color: '#FFF7F0' }}>Алина<br />&<br />Тимур</h1>
            <button onClick={() => setOpened(true)}
              className="press mt-10 px-9 h-[52px] rounded-full text-[13px] font-semibold tracking-wide"
              style={{ background: '#FFF7F0', color: '#7C3232' }}>
              Открыть приглашение
            </button>
            <p className="text-[10px] mt-5 tracking-[.2em] uppercase" style={{ color: 'rgba(255,247,240,.55)' }}>14 · июня · 2027</p>
          </div>
        )}
      </div>

      {/* ── Основная история ── */}
      <div className={cn('max-w-[430px] mx-auto transition-opacity duration-700 pb-16', opened ? 'opacity-100' : 'opacity-0')}>

        {/* Hero */}
        <div className="pt-20 pb-12 px-8 text-center relative">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-72 h-72 rounded-full opacity-50 blur-3xl" style={{ background: '#F2DFDC' }} />
          <p className="font-serif-d italic text-[15px] relative" style={{ color: '#A98A80' }}>Дорогая Марина Ивановна!</p>
          <p className="text-[10px] tracking-[.3em] uppercase font-semibold mt-8 relative" style={{ color: '#B57171' }}>Мы женимся</p>
          <h1 className="font-serif-d text-[44px] leading-[1.05] mt-4 relative" style={{ color: '#3A2E28' }}>
            {couple.bride}<br /><em className="grad-text not-italic">&</em> {couple.groom}
          </h1>
          <div className="flex items-center justify-center gap-3 mt-6 relative">
            <span className="w-10 h-[1px]" style={{ background: '#D9B8AE' }} />
            <p className="text-[11px] tracking-[.26em] uppercase font-semibold" style={{ color: '#8E5A5A' }}>14 июня 2027 · Уфа</p>
            <span className="w-10 h-[1px]" style={{ background: '#D9B8AE' }} />
          </div>
        </div>

        {/* Обращение */}
        <div className="px-8 fade-up">
          <p className="font-serif-d text-[17px] leading-relaxed text-center" style={{ color: '#5C4A42' }}>
            «Мы хотим разделить с вами самый особенный день нашей жизни. Для нас будет честью видеть вас рядом в этот важный момент».
          </p>
        </div>

        {/* Детали дня */}
        <div className="px-6 mt-12">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-[24px] p-5 text-center" style={{ background: '#FFFFFF', boxShadow: '0 14px 34px -16px rgba(181,113,113,.3)' }}>
              <span className="text-[9px] tracking-[.2em] uppercase font-bold" style={{ color: '#B98A2F' }}>Церемония</span>
              <b className="font-serif-d text-[17px] block mt-2" style={{ color: '#3A2E28' }}>15:30</b>
              <p className="text-[10.5px] mt-1" style={{ color: '#A98A80' }}>Усадьба «Липовый сад», шатёр у пруда</p>
            </div>
            <div className="rounded-[24px] p-5 text-center" style={{ background: '#FFFFFF', boxShadow: '0 14px 34px -16px rgba(181,113,113,.3)' }}>
              <span className="text-[9px] tracking-[.2em] uppercase font-bold" style={{ color: '#B98A2F' }}>Банкет</span>
              <b className="font-serif-d text-[17px] block mt-2" style={{ color: '#3A2E28' }}>17:00</b>
              <p className="text-[10.5px] mt-1" style={{ color: '#A98A80' }}>Большой зал усадьбы</p>
            </div>
          </div>
          <a href="https://yandex.ru/maps" target="_blank" rel="noreferrer"
            className="press mt-3 rounded-[24px] p-5 flex items-center gap-4"
            style={{ background: 'linear-gradient(120deg,#EED9D2,#E6EEE2)' }}>
            <MapPin size={20} style={{ color: '#8E5A5A' }} />
            <div className="flex-1 text-left">
              <b className="text-[13px]" style={{ color: '#3A2E28' }}>Построить маршрут</b>
              <p className="text-[10.5px]" style={{ color: '#8E7A70' }}>Яндекс Карты · 25 мин от центра · парковка у входа</p>
            </div>
            <span style={{ color: '#8E5A5A' }}>→</span>
          </a>
        </div>

        {/* Программа */}
        <div className="px-6 mt-12">
          <h2 className="font-serif-d text-[24px] text-center flex items-center justify-center gap-2" style={{ color: '#3A2E28' }}>
            <Clock3 size={18} style={{ color: '#B57171' }} /> Программа дня
          </h2>
          <div className="mt-5 rounded-[26px] px-5 py-2" style={{ background: '#FFFFFF', boxShadow: '0 14px 34px -16px rgba(181,113,113,.3)' }}>
            {timeline.slice(3).map((e, i, arr) => (
              <div key={e.id} className={cn('flex gap-4 py-3.5 items-baseline', i !== arr.length - 1 && 'border-b')} style={{ borderColor: '#F4E8E0' }}>
                <span className="text-[12px] font-bold w-[64px] shrink-0 tabular" style={{ color: '#B57171' }}>{e.time.split(' — ')[0]}</span>
                <div>
                  <b className="text-[13px]" style={{ color: '#3A2E28' }}>{e.name}</b>
                  <p className="text-[10px] mt-0.5" style={{ color: '#A98A80' }}>{e.loc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Дресс-код */}
        <div className="px-6 mt-12 text-center">
          <h2 className="font-serif-d text-[24px]" style={{ color: '#3A2E28' }}>Дресс-код</h2>
          <div className="flex justify-center gap-3 mt-5">
            {['#C98A8A', '#A9BCA0', '#D9CCE3', '#F0DCB8', '#C3D5E8'].map(c => (
              <span key={c} className="w-10 h-10 rounded-full border-[3px]" style={{ background: c, borderColor: '#FFF7F0', boxShadow: '0 8px 20px -8px rgba(58,46,40,.35)' }} />
            ))}
          </div>
          <p className="text-[11.5px] mt-4 font-light leading-relaxed" style={{ color: '#8E7A70' }}>
            Будем рады оттенкам пастели.<br />Белый — только для невесты 🤍
          </p>
        </div>

        {/* RSVP */}
        <div className="px-6 mt-12">
          <div className="rounded-[28px] p-6 relative overflow-hidden" style={{ background: '#FFFFFF', boxShadow: '0 18px 44px -18px rgba(181,113,113,.4)' }}>
            <div className="absolute inset-x-0 top-0 h-1.5 grad" />
            <h2 className="font-serif-d text-[24px] text-center" style={{ color: '#3A2E28' }}>Вы придёте?</h2>
            <p className="text-[11px] text-center mt-1.5" style={{ color: '#A98A80' }}>Ответьте до 1 мая — нам важно знать</p>

            {!sent ? (
              <>
                <div className="flex gap-2.5 mt-5">
                  <button onClick={() => setRsvp('yes')} className={cn('press flex-1 h-[50px] rounded-full text-[13px] font-semibold transition-all', rsvp === 'yes' ? 'grad text-white' : '')}
                    style={rsvp === 'yes' ? {} : { background: '#F6EDE7', color: '#5C4A42' }}>Приду с радостью</button>
                  <button onClick={() => setRsvp('no')} className={cn('press flex-1 h-[50px] rounded-full text-[13px] font-semibold transition-all')}
                    style={rsvp === 'no' ? { background: '#3A2E28', color: '#FFF7F0' } : { background: '#F6EDE7', color: '#A98A80' }}>Не смогу</button>
                </div>

                {rsvp === 'yes' && (
                  <div className="mt-5 space-y-4 fade-up">
                    <div>
                      <p className="text-[11px] font-semibold flex items-center gap-1.5" style={{ color: '#5C4A42' }}><Heart size={12} style={{ color: '#B57171' }} /> Придёте с парой?</p>
                      <div className="flex gap-2 mt-2">
                        {['Один/одна', 'С +1'].map((o, k) => (
                          <button key={o} onClick={() => setPlus(k === 1)} className={cn('press flex-1 h-[42px] rounded-full text-[12px] font-medium', plus === (k === 1) ? 'grad text-white' : '')}
                            style={plus === (k === 1) ? {} : { background: '#F6EDE7', color: '#5C4A42' }}>{o}</button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold flex items-center gap-1.5" style={{ color: '#5C4A42' }}><UtensilsCrossed size={12} style={{ color: '#B57171' }} /> Предпочтения по еде</p>
                      <div className="flex flex-wrap gap-2 mt-2">
                        {['Всё ем', 'Без рыбы', 'Вегетарианское', 'Детское меню'].map(o => (
                          <button key={o} onClick={() => setMeal(o)} className={cn('press px-4 h-[38px] rounded-full text-[11.5px] font-medium', meal === o ? 'grad text-white' : '')}
                            style={meal === o ? {} : { background: '#F6EDE7', color: '#5C4A42' }}>{o}</button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold flex items-center gap-1.5" style={{ color: '#5C4A42' }}><Bus size={12} style={{ color: '#B57171' }} /> Нужен трансфер из центра?</p>
                      <div className="flex gap-2 mt-2">
                        {['Да, нужен', 'Сам доберусь'].map((o, k) => (
                          <button key={o} onClick={() => setTransfer(k === 0)} className={cn('press flex-1 h-[42px] rounded-full text-[12px] font-medium', transfer === (k === 0) ? 'grad text-white' : '')}
                            style={transfer === (k === 0) ? {} : { background: '#F6EDE7', color: '#5C4A42' }}>{o}</button>
                        ))}
                      </div>
                    </div>
                    <p className="text-[10px] flex items-center gap-1.5" style={{ color: '#A98A80' }}><Baby size={12} /> Детская зона с аниматором — будет</p>
                  </div>
                )}

                {rsvp && (
                  <button onClick={() => setSent(true)} className="press w-full h-[52px] rounded-full grad text-white font-semibold text-[13.5px] mt-5"
                    style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}>
                    Отправить ответ
                  </button>
                )}
              </>
            ) : (
              <div className="text-center py-6 pop">
                <div className="w-[72px] h-[72px] rounded-full grad mx-auto flex items-center justify-center text-white text-[26px]">✓</div>
                <b className="font-serif-d text-[20px] block mt-4" style={{ color: '#3A2E28' }}>
                  {rsvp === 'yes' ? 'Ждём вас!' : 'Спасибо за честный ответ'}
                </b>
                <p className="text-[11.5px] mt-2" style={{ color: '#A98A80' }}>
                  {rsvp === 'yes' ? 'Алина и Тимур уже видят ваш ответ в списке гостей.' : 'Алина и Тимур получили ваш ответ. ♥'}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Календарь + подарки */}
        <div className="px-6 mt-6 space-y-3">
          <button className="press w-full rounded-[24px] py-4 text-[13px] font-semibold flex items-center justify-center gap-2"
            style={{ background: '#FFFFFF', color: '#5C4A42', boxShadow: '0 14px 34px -16px rgba(181,113,113,.3)' }}>
            <CalendarPlus size={16} style={{ color: '#B57171' }} /> Добавить в календарь (.ics)
          </button>
          <div className="rounded-[24px] p-5 text-center" style={{ background: 'linear-gradient(120deg,#F7ECD9,#F3E3D3)' }}>
            <p className="text-[11.5px] leading-relaxed font-light" style={{ color: '#6B5844' }}>
              🎁 Лучший подарок — ваше присутствие.<br />Если хотите порадовать нас иначе — конверт в копилку медового месяца 💛
            </p>
          </div>
        </div>

        <p className="text-center text-[10px] mt-10 tracking-[.2em] uppercase" style={{ color: '#C4AE9F' }}>Сделано в Тили-тили 💍</p>
      </div>
    </div>
  )
}
