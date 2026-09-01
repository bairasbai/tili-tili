import { useState } from 'react'
import { MapPin, Clock3, Armchair, Heart } from 'lucide-react'
import { couple, timeline } from '@/lib/data'
import { cn } from '@/lib/utils'

/* Гостевое приглашение: конверт → открытие → RSVP */
export default function Invite() {
  const [opened, setOpened] = useState(false)
  const [rsvp, setRsvp] = useState<'yes' | 'no' | null>(null)

  return (
    <div className="min-h-dvh pb-16 relative overflow-hidden">
      <div className="absolute -top-24 -left-24 w-80 h-80 rounded-full opacity-40 blur-3xl" style={{ background: '#F2DFDC' }} />
      <div className="absolute -bottom-24 -right-24 w-80 h-80 rounded-full opacity-40 blur-3xl" style={{ background: '#E6EEE2' }} />

      {!opened ? (
        <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center fade-in">
          <span className="text-[11px] tracking-[.3em] uppercase text-[#B57171] font-semibold">Вам приглашение</span>
          <button onClick={() => setOpened(true)} className="press mt-8 relative">
            <div className="w-[290px] h-[190px] rounded-[22px] relative overflow-hidden" style={{ background: 'linear-gradient(160deg,#fff,#F6EDE7)', boxShadow: 'var(--shadow)' }}>
              <div className="absolute inset-x-0 top-0 h-[95px]" style={{ background: 'linear-gradient(160deg,#F2DFDC,#EAD9CF)', clipPath: 'polygon(0 0, 100% 0, 50% 100%)' }} />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-[62px] h-[62px] rounded-full grad flex items-center justify-center font-serif-d text-white text-[19px] border-2 border-white/50 pop" style={{ boxShadow: '0 10px 24px -8px rgba(181,113,113,.7)' }}>
                  А♥Т
                </div>
              </div>
            </div>
          </button>
          <p className="text-[13px] text-[#93897F] mt-8 font-light">Нажмите на конверт, чтобы открыть</p>
        </div>
      ) : (
        <div className="px-5 pt-10 max-w-[430px] mx-auto fade-up">
          <div className="card p-7 text-center relative overflow-hidden">
            <div className="absolute -top-10 -right-10 w-36 h-36 rounded-full bg-[#F2DFDC] opacity-60" />
            <p className="font-serif-d italic text-[16px] text-[#93897F] relative">Дорогая Марина Ивановна!</p>
            <h1 className="font-serif-d text-[34px] mt-5 relative">{couple.bride} <em className="grad-text">&</em> {couple.groom}</h1>
            <p className="text-[10.5px] tracking-[.24em] uppercase text-[#B57171] font-semibold mt-2 relative">{couple.date} · {couple.city}</p>
            <p className="text-[12.5px] text-[#93897F] leading-relaxed mt-5 font-light relative">
              Приглашаем вас разделить с нами самый важный день. Выездная церемония — усадьба «Липовый сад», сбор гостей в 15:30.
            </p>
            <div className="flex gap-2.5 justify-center mt-6 relative">
              <button onClick={() => setRsvp('yes')} className={cn('press px-6 py-3.5 rounded-full text-[12.5px] font-semibold transition-all', rsvp === 'yes' ? 'grad text-white' : 'bg-[#FBF6F1] text-[#2E2A26]')}>
                Приду с радостью
              </button>
              <button onClick={() => setRsvp('no')} className={cn('press px-6 py-3.5 rounded-full text-[12.5px] font-semibold transition-all', rsvp === 'no' ? 'bg-[#2E2A26] text-white' : 'bg-[#FBF6F1] text-[#93897F]')}>
                Не смогу
              </button>
            </div>
            {rsvp === 'yes' && <p className="text-[11.5px] text-[#7E9A74] mt-4 pop">✓ Ответ отправлен! Пара увидит его сразу.</p>}
            {rsvp === 'no' && <p className="text-[11.5px] text-[#B57171] mt-4 pop">Жаль, но спасибо за честный ответ ♥</p>}
          </div>

          <div className="grid grid-cols-3 gap-2.5 mt-4">
            <div className="card-s p-3.5 text-center"><MapPin size={17} className="mx-auto text-[#B57171]" /><b className="text-[10.5px] block mt-1.5">Маршрут</b></div>
            <div className="card-s p-3.5 text-center"><Armchair size={17} className="mx-auto text-[#7E9A74]" /><b className="text-[10.5px] block mt-1.5">Стол № 3</b></div>
            <div className="card-s p-3.5 text-center"><Heart size={17} className="mx-auto text-[#C98A8A]" /><b className="text-[10.5px] block mt-1.5">Дресс-код</b></div>
          </div>

          <h2 className="font-serif-d text-[20px] mt-7 mb-3 flex items-center gap-2"><Clock3 size={17} className="text-[#B57171]" /> Программа дня</h2>
          <div className="card px-4 py-2">
            {timeline.slice(3).map((e, i, arr) => (
              <div key={e.id} className={cn('flex gap-3 py-3', i !== arr.length - 1 && 'border-b border-[#F1E9E2]')}>
                <span className="text-[12px] font-bold text-[#B57171] w-[74px] shrink-0 tabular">{e.time.split(' — ')[0]}</span>
                <div>
                  <b className="text-[12.5px]">{e.name}</b>
                  <p className="text-[10px] text-[#93897F] mt-0.5">{e.loc}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="text-center text-[10px] text-[#BFB5AA] mt-6">Приглашение создано в Тили-тили 💍</p>
        </div>
      )}
    </div>
  )
}
