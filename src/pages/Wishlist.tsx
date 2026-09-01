import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Gift as GiftIcon, Plus, ShieldCheck, Trash2, Users } from 'lucide-react'
import { fmt, type Gift } from '@/lib/data'
import { AiTip, Bar, SectionHead, Tile, TopBar } from '@/components/chrome'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { t } from '@/lib/i18n'

/* ── Сторона пары: управление списком желаний ── */
export function WishlistManage() {
  const nav = useNavigate()
  const { gifts, addGift, removeGift } = useStore()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')
  const [group, setGroup] = useState(false)

  const reserved = gifts.filter(g => g.reserved).length
  const submit = () => {
    if (!name.trim() || !Number(price)) return
    const palette = ['bg-[var(--rose-soft)]', 'bg-[var(--sage-soft)]', 'bg-[var(--honey)]', 'bg-[var(--lav)]', 'bg-[var(--blue)]', 'bg-[var(--peach)]']
    addGift({ name: name.trim(), price: Number(price), group, icon: '🎁', tile: palette[gifts.length % palette.length] })
    setName(''); setPrice(''); setGroup(false); setAdding(false)
  }

  return (
    <div className="pb-28">
      <TopBar back title={t('Список желаний')} sub={t('Что подарить вам на свадьбу')} />
      <div className="px-5 mt-3 space-y-3">
        <div className="card p-4 flex gap-3 items-start">
          <ShieldCheck size={20} className="text-[#A9BCA0] shrink-0 mt-0.5" />
          <p className="text-[12px] text-[var(--soft)] leading-relaxed">
            {t('Гости выбирают подарки анонимно — вы видите только статус «Зарезервирован», но не видите, кто именно. Выбранный подарок закрывается для остальных, дублей не будет.')}
          </p>
        </div>

        <div className="card p-4">
          <div className="flex justify-between text-[12px] mb-2">
            <span className="font-medium">{t('Зарезервировано гостями')}</span>
            <span className="text-[var(--soft)]">{reserved} {t('из')} {gifts.length}</span>
          </div>
          <Bar pct={gifts.length ? (reserved / gifts.length) * 100 : 0} />
        </div>

        <AiTip text={t('Добавьте подарки разной цены — от 5 000 до складчины на мечту. Так каждый гость найдёт вариант по бюджету.')} />

        {!adding ? (
          <button onClick={() => setAdding(true)} className="press w-full card-s p-4 flex items-center justify-center gap-2 text-[13px] font-semibold">
            <Plus size={16} />{t('Добавить желание')}
          </button>
        ) : (
          <div className="card p-4 space-y-3 fade-up">
            <input value={name} onChange={e => setName(e.target.value)} placeholder={t('Название подарка')} className="w-full bg-[var(--track)] rounded-[14px] px-4 py-3 text-[13px] outline-none" />
            <input value={price} onChange={e => setPrice(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder={t('Цена, ₽')} className="w-full bg-[var(--track)] rounded-[14px] px-4 py-3 text-[13px] outline-none" />
            <button onClick={() => setGroup(g => !g)} className="press w-full flex items-center justify-between text-[12.5px] font-medium">
              <span className="flex items-center gap-2"><Users size={15} className="text-[var(--soft)]" />{t('Можно складчину (дорогой подарок)')}</span>
              <span className={cn('w-10 h-6 rounded-full transition-all relative', group ? 'grad' : 'bg-[var(--track)]')}>
                <span className={cn('absolute top-[3px] w-[18px] h-[18px] rounded-full bg-white transition-all', group ? 'left-[19px]' : 'left-[3px]')} />
              </span>
            </button>
            <div className="flex gap-2">
              <button onClick={() => setAdding(false)} className="press flex-1 card-s py-3 text-[12.5px] font-semibold">{t('Отмена')}</button>
              <button onClick={submit} className="press flex-1 py-3 rounded-[16px] grad text-white text-[12.5px] font-semibold">{t('Добавить')}</button>
            </div>
          </div>
        )}
      </div>

      <SectionHead title={t('Наши желания')} sub={t('видно гостям по ссылке-приглашению')} />
      <div className="px-5 space-y-2.5">
        {gifts.map((g, i) => <CoupleGiftRow key={g.id} g={g} i={i} onRemove={() => removeGift(g.id)} />)}
      </div>

      <div className="px-5 mt-6">
        <button onClick={() => nav('/gifts')} className="press w-full py-4 rounded-[20px] grad text-white text-[14px] font-semibold flex items-center justify-center gap-2">
          <GiftIcon size={17} />{t('Открыть глазами гостя')}
        </button>
      </div>
    </div>
  )
}

function CoupleGiftRow({ g, i, onRemove }: { g: Gift; i: number; onRemove: () => void }) {
  const [confirm, setConfirm] = useState(false)
  const pct = g.price ? Math.round((g.funded / g.price) * 100) : 0
  return (
    <div className="card p-3.5 fade-up" style={{ animationDelay: `${i * 40}ms` }}>
      <div className="flex items-center gap-3">
        <Tile icon={g.icon} tile={g.tile} />
        <div className="flex-1 min-w-0">
          <p className="text-[13.5px] font-semibold truncate">{g.name}</p>
          <p className="text-[11px] text-[var(--soft)]">{fmt(g.price)}{g.group && ` · ${t('складчина')}`}</p>
        </div>
        {g.reserved
          ? <span className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-[var(--sage-soft)] text-[#5F7A56]">{t('Зарезервирован')}</span>
          : <span className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-[var(--track)] text-[var(--soft)]">{t('Свободен')}</span>}
        {!confirm
          ? <button onClick={() => setConfirm(true)} className="press w-8 h-8 rounded-full bg-[var(--track)] flex items-center justify-center text-[var(--soft)]" aria-label={t('Удалить')}><Trash2 size={14} /></button>
          : <button onClick={onRemove} className="press text-[10px] font-bold px-2.5 py-1.5 rounded-full text-white" style={{ background: '#C98A8A' }}>{t('Точно?')}</button>}
      </div>
      {g.group && (
        <div className="mt-3">
          <div className="flex justify-between text-[10.5px] text-[var(--soft)] mb-1">
            <span>{t('Собрано')} {fmt(g.funded)}</span><span>{pct}%</span>
          </div>
          <Bar pct={pct} />
        </div>
      )}
    </div>
  )
}

/* ── Сторона гостя: выбор подарка (анонимно) ── */
export function GiftPick() {
  const nav = useNavigate()
  const { gifts, myGifts, reserveGift, releaseGift, fundGift } = useStore()
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [fundFor, setFundFor] = useState<string | null>(null)
  const [amount, setAmount] = useState('')

  const mine = gifts.filter(g => myGifts.includes(g.id))
  const available = gifts.filter(g => !g.reserved && !myGifts.includes(g.id))
  const taken = gifts.filter(g => g.reserved && !myGifts.includes(g.id))

  const doFund = (id: string) => {
    const a = Number(amount)
    if (!a) return
    fundGift(id, a)
    setAmount(''); setFundFor(null)
  }

  return (
    <div className="pb-28">
      <TopBar back title={t('Подарки')} sub={t('Алина & Тимур · 14 июня 2027')} />
      <div className="px-5 mt-3">
        <div className="card p-4 flex gap-3 items-start">
          <ShieldCheck size={20} className="text-[#A9BCA0] shrink-0 mt-0.5" />
          <p className="text-[12px] text-[var(--soft)] leading-relaxed">
            {t('Полностью анонимно: молодожёны увидят только, что подарок зарезервирован, но не кем. Выбранный подарок сразу закрывается для других гостей.')}
          </p>
        </div>
      </div>

      {mine.length > 0 && (
        <>
          <SectionHead title={t('Мой выбор')} />
          <div className="px-5 space-y-2.5">
            {mine.map(g => (
              <div key={g.id} className="card p-3.5 flex items-center gap-3" style={{ border: '1.5px solid rgba(169,188,160,.5)' }}>
                <Tile icon={g.icon} tile={g.tile} />
                <div className="flex-1 min-w-0">
                  <p className="text-[13.5px] font-semibold truncate">{g.name}</p>
                  <p className="text-[11px] text-[#5F7A56] font-medium">{t('Вы зарезервировали этот подарок')}</p>
                </div>
                <button onClick={() => releaseGift(g.id)} className="press text-[10.5px] font-bold px-3 py-1.5 rounded-full bg-[var(--track)] text-[var(--soft)]">{t('Снять резерв')}</button>
              </div>
            ))}
          </div>
        </>
      )}

      <SectionHead title={t('Свободные желания')} />
      <div className="px-5 space-y-2.5">
        {available.map((g, i) => {
          const pct = g.price ? Math.round((g.funded / g.price) * 100) : 0
          const left = g.price - g.funded
          return (
            <div key={g.id} className="card p-3.5 fade-up" style={{ animationDelay: `${i * 40}ms` }}>
              <div className="flex items-center gap-3">
                <Tile icon={g.icon} tile={g.tile} />
                <div className="flex-1 min-w-0">
                  <p className="text-[13.5px] font-semibold truncate">{g.name}</p>
                  <p className="text-[11px] text-[var(--soft)]">{g.desc ? `${g.desc} · ` : ''}{fmt(g.price)}</p>
                </div>
                {confirmId === g.id
                  ? <button onClick={() => { reserveGift(g.id); setConfirmId(null) }} className="press text-[11px] font-bold px-3.5 py-2 rounded-full grad text-white">{t('Подтвердить')}</button>
                  : !g.group && <button onClick={() => setConfirmId(g.id)} className="press text-[11px] font-bold px-3.5 py-2 rounded-full card-s">{t('Подарю')}</button>}
              </div>
              {g.group && (
                <div className="mt-3">
                  <div className="flex justify-between text-[10.5px] text-[var(--soft)] mb-1">
                    <span>{t('Собрано')} {fmt(g.funded)} {t('из')} {fmt(g.price)}</span><span>{pct}%</span>
                  </div>
                  <Bar pct={pct} />
                  {fundFor === g.id ? (
                    <div className="flex gap-2 mt-2.5">
                      <input value={amount} onChange={e => setAmount(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder={t('Сумма, ₽')} className="flex-1 bg-[var(--track)] rounded-[12px] px-3.5 py-2.5 text-[12.5px] outline-none" />
                      <button onClick={() => doFund(g.id)} className="press px-4 py-2.5 rounded-[12px] grad text-white text-[12px] font-bold">{t('Внести')}</button>
                    </div>
                  ) : (
                    <button onClick={() => { setFundFor(g.id); setAmount('') }} className="press mt-2.5 text-[11px] font-bold px-3.5 py-2 rounded-full card-s">
                      {t('Скинуться')} · {t('осталось')} {fmt(left)}
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
        {available.length === 0 && <p className="text-center text-[12px] text-[var(--soft)] py-6">{t('Все желания уже зарезервированы 🎉')}</p>}
      </div>

      {taken.length > 0 && (
        <>
          <SectionHead title={t('Уже выбрано другими гостями')} />
          <div className="px-5 space-y-2.5">
            {taken.map(g => (
              <div key={g.id} className="card p-3.5 flex items-center gap-3 opacity-55">
                <Tile icon={g.icon} tile={g.tile} />
                <div className="flex-1 min-w-0">
                  <p className="text-[13.5px] font-semibold truncate">{g.name}</p>
                  <p className="text-[11px] text-[var(--soft)]">{fmt(g.price)}</p>
                </div>
                <span className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-[var(--track)] text-[var(--soft)]">{t('Занято')}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="px-5 mt-6">
        <button onClick={() => nav(-1)} className="press w-full card-s py-4 text-[13px] font-semibold">{t('Назад')}</button>
      </div>
    </div>
  )
}
