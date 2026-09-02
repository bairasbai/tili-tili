import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Gift as GiftIcon, MessageSquareHeart, Plus, ShieldCheck, ShoppingBag, Star, Trash2, Users, X } from 'lucide-react'
import { fmt, initialAntiGifts, initialFunds, initialGuestReviews, type Fund, type Gift, type GuestReview } from '@/lib/data'
import { AiTip, Bar, SectionHead, Tile, TopBar } from '@/components/chrome'
import { useStore } from '@/lib/store'
import { usePersist } from '@/lib/usePersist'
import { cn, goBack } from '@/lib/utils'
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

      <FundsManage />
      <AntiManage />

      <div className="px-5 mt-6">
        <button onClick={() => nav('/gifts')} className="press w-full py-4 rounded-[20px] grad text-white text-[14px] font-semibold flex items-center justify-center gap-2">
          <GiftIcon size={17} />{t('Открыть глазами гостя')}
        </button>
      </div>
    </div>
  )
}

/* Денежные фонды — сторона пары */
function FundsManage() {
  const [funds, setFunds] = usePersist<Fund[]>('tt_funds', initialFunds)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const submit = () => {
    if (!name.trim() || !Number(target)) return
    setFunds(f => [...f, { id: 'f' + Date.now(), name: name.trim(), icon: '💌', tile: 'bg-[var(--rose-soft)]', target: Number(target), collected: 0 }])
    setName(''); setTarget(''); setAdding(false)
  }
  return (
    <>
      <SectionHead title={t('Денежные фонды')} sub={t('гости переводят на цель вместо вещей')} />
      <div className="px-5 space-y-2.5">
        {funds.map(f => {
          const pct = f.target ? Math.round((f.collected / f.target) * 100) : 0
          return (
            <div key={f.id} className="card p-3.5">
              <div className="flex items-center gap-3">
                <Tile icon={f.icon} tile={f.tile} />
                <div className="flex-1 min-w-0">
                  <p className="text-[13.5px] font-semibold truncate">{f.name}</p>
                  <p className="text-[11px] text-[var(--soft)]">{t('цель')} {fmt(f.target)}</p>
                </div>
                <button onClick={() => setFunds(fs => fs.filter(x => x.id !== f.id))} className="press w-8 h-8 rounded-full bg-[var(--track)] flex items-center justify-center text-[var(--soft)]" aria-label={t('Удалить')}><Trash2 size={14} /></button>
              </div>
              <div className="mt-3">
                <div className="flex justify-between text-[10.5px] text-[var(--soft)] mb-1">
                  <span>{t('Собрано')} {fmt(f.collected)}</span><span>{pct}%</span>
                </div>
                <Bar pct={pct} />
              </div>
            </div>
          )
        })}
        {!adding ? (
          <button onClick={() => setAdding(true)} className="press w-full card-s p-4 flex items-center justify-center gap-2 text-[13px] font-semibold">
            <Plus size={16} />{t('Добавить фонд')}
          </button>
        ) : (
          <div className="card p-4 space-y-3 fade-up">
            <input value={name} onChange={e => setName(e.target.value)} placeholder={t('Название цели')} className="w-full bg-[var(--track)] rounded-[14px] px-4 py-3 text-[13px] outline-none" />
            <input value={target} onChange={e => setTarget(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder={t('Сумма цели, ₽')} className="w-full bg-[var(--track)] rounded-[14px] px-4 py-3 text-[13px] outline-none" />
            <div className="flex gap-2">
              <button onClick={() => setAdding(false)} className="press flex-1 card-s py-3 text-[12.5px] font-semibold">{t('Отмена')}</button>
              <button onClick={submit} className="press flex-1 py-3 rounded-[16px] grad text-white text-[12.5px] font-semibold">{t('Добавить')}</button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

/* Анти-вишлист — сторона пары */
function AntiManage() {
  const [anti, setAnti] = usePersist<string[]>('tt_anti', initialAntiGifts)
  const [val, setVal] = useState('')
  const add = () => { if (val.trim()) { setAnti(a => [...a, val.trim()]); setVal('') } }
  return (
    <>
      <SectionHead title={t('Просим не дарить')} sub={t('анти-вишлист')} />
      <div className="px-5">
        <div className="card p-4">
          <div className="flex flex-wrap gap-2">
            {anti.map(a => (
              <span key={a} className="flex items-center gap-1.5 text-[11.5px] font-medium px-3 py-1.5 rounded-full bg-[var(--track)] text-[var(--soft)]">
                {a}
                <button onClick={() => setAnti(x => x.filter(y => y !== a))} className="press" aria-label={t('Удалить')}><X size={12} /></button>
              </span>
            ))}
          </div>
          <div className="flex gap-2 mt-3">
            <input value={val} onChange={e => setVal(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} placeholder={t('Например: сервизы')} className="flex-1 bg-[var(--track)] rounded-[12px] px-3.5 py-2.5 text-[12.5px] outline-none" />
            <button onClick={add} className="press px-4 py-2.5 rounded-[12px] card-s text-[12px] font-bold">{t('Добавить')}</button>
          </div>
        </div>
      </div>
    </>
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
  const [funds, setFunds] = usePersist<Fund[]>('tt_funds', initialFunds)
  const [anti] = usePersist<string[]>('tt_anti', initialAntiGifts)
  const [bought, setBought] = usePersist<string[]>('tt_bought', [])
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [fundFor, setFundFor] = useState<string | null>(null)
  const [amount, setAmount] = useState('')

  const mine = gifts.filter(g => myGifts.includes(g.id))
  const available = gifts.filter(g => !g.reserved && !myGifts.includes(g.id))
  const taken = gifts.filter(g => g.reserved && !myGifts.includes(g.id))
  const fairPrice = 15000 // ориентир: стоимость банкета на гостя (деликатная подсказка)

  const doFund = (id: string) => {
    const a = Number(amount)
    if (!a) return
    fundGift(id, a)
    setAmount(''); setFundFor(null)
  }
  const doFundMoney = (id: string) => {
    const a = Number(amount)
    if (!a) return
    setFunds(fs => fs.map(f => f.id === id ? { ...f, collected: Math.min(f.target, f.collected + a) } : f))
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
        <p className="text-[10.5px] text-[var(--soft)] mt-2.5 px-1">{t('Деликатный ориентир: банкет на гостя ≈')} {fmt(fairPrice)}</p>
      </div>

      {anti.length > 0 && (
        <div className="px-5 mt-3">
          <div className="card p-3.5">
            <p className="text-[11px] font-semibold mb-2">🙏 {t('Молодожёны просят не дарить')}:</p>
            <div className="flex flex-wrap gap-1.5">
              {anti.map(a => <span key={a} className="text-[10.5px] px-2.5 py-1 rounded-full bg-[var(--track)] text-[var(--soft)]">{a}</span>)}
            </div>
          </div>
        </div>
      )}

      {funds.length > 0 && (
        <>
          <SectionHead title={t('Денежные фонды')} sub={t('анонимный перевод на цель')} />
          <div className="px-5 space-y-2.5">
            {funds.map(f => {
              const pct = f.target ? Math.round((f.collected / f.target) * 100) : 0
              return (
                <div key={f.id} className="card p-3.5">
                  <div className="flex items-center gap-3">
                    <Tile icon={f.icon} tile={f.tile} />
                    <div className="flex-1 min-w-0">
                      <p className="text-[13.5px] font-semibold truncate">{f.name}</p>
                      <p className="text-[11px] text-[var(--soft)]">{t('Собрано')} {fmt(f.collected)} {t('из')} {fmt(f.target)}</p>
                    </div>
                  </div>
                  <div className="mt-3"><Bar pct={pct} /></div>
                  {fundFor === f.id ? (
                    <div className="flex gap-2 mt-2.5">
                      <input value={amount} onChange={e => setAmount(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder={t('Сумма, ₽')} className="flex-1 bg-[var(--track)] rounded-[12px] px-3.5 py-2.5 text-[12.5px] outline-none" />
                      <button onClick={() => doFundMoney(f.id)} className="press px-4 py-2.5 rounded-[12px] grad text-white text-[12px] font-bold">{t('Внести')}</button>
                    </div>
                  ) : (
                    <button onClick={() => { setFundFor(f.id); setAmount('') }} className="press mt-2.5 text-[11px] font-bold px-3.5 py-2 rounded-full card-s">{t('Перевести на цель')}</button>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

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
                  : !g.group && (
                    <div className="flex flex-col gap-1.5 items-end">
                      <button onClick={() => setConfirmId(g.id)} className="press text-[11px] font-bold px-3.5 py-2 rounded-full card-s">{t('Подарю')}</button>
                      {bought.includes(g.id)
                        ? <span className="text-[9.5px] font-bold text-[#5F7A56]">✓ {t('Заказ оформлен')}</span>
                        : <button onClick={() => { setBought(b => [...b, g.id]); reserveGift(g.id) }} className="press text-[10px] font-bold px-3 py-1.5 rounded-full bg-[var(--track)] text-[var(--soft)] flex items-center gap-1"><ShoppingBag size={11} />{t('Купить в приложении')}</button>}
                    </div>
                  )}
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

      {/* Отзывы гостей о подрядчиках (после свадьбы) */}
      <SectionHead title={t('Как прошла свадьба?')} sub={t('ваш отзыв будет помечен «от гостя»')} />
      <GuestReviewForm />

      <div className="px-5 mt-6">
        <button onClick={() => goBack(x => nav(x), (to, o) => nav(to, o), '/invite')} className="press w-full card-s py-4 text-[13px] font-semibold">{t('Назад')}</button>
      </div>
    </div>
  )
}

/* Форма отзыва гостя: подрядчик → звёзды → текст; сохраняется с пометкой «гость» */
export function GuestReviewForm() {
  const [reviews, setReviews] = usePersist<GuestReview[]>('tt_guest_reviews', initialGuestReviews)
  const [vendor, setVendor] = useState('')
  const [stars, setStars] = useState(0)
  const [text, setText] = useState('')
  const [sentOk, setSentOk] = useState(false)
  const vendorOptions = [t('Елена Смирнова · фотограф'), t('Артём Краснов · ведущий'), t('Студия «Пион» · флористика'), t('Усадьба «Липовый сад»'), t('«Марципан» · торт')]
  const submit = () => {
    if (!vendor || !stars) return
    setReviews(r => [{ id: `gr${Date.now()}`, vendor, stars, text: text.trim() || t('Без комментария'), at: t('сегодня') }, ...r])
    setVendor(''); setStars(0); setText(''); setSentOk(true)
    setTimeout(() => setSentOk(false), 2200)
  }
  return (
    <div className="px-5 space-y-3">
      <div className="card p-4">
        <div className="flex gap-3 items-start">
          <MessageSquareHeart size={20} className="text-[#C98A8A] shrink-0 mt-0.5" />
          <p className="text-[12px] text-[var(--soft)] leading-relaxed">
            {t('Вы оставляете отзыв')} <b className="text-[var(--ink)]">{t('как гость свадьбы')}</b>{t(' — он будет помечен значком «Гость» и не смешается с отзывом пары. Молодожёны увидят его анонимно.')}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5 mt-3">
          {vendorOptions.map(v => (
            <button key={v} onClick={() => setVendor(v)} className={cn('press text-[10.5px] font-medium px-3 py-1.5 rounded-full transition-all', vendor === v ? 'grad text-white' : 'bg-[var(--bg)] text-[var(--soft)]')}>{v}</button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 mt-3">
          {[1, 2, 3, 4, 5].map(n => (
            <button key={n} onClick={() => setStars(n)} className="press p-1" aria-label={`${n}`}>
              <Star size={22} className={n <= stars ? 'fill-[#E3C892] text-[#E3C892]' : 'text-[var(--track)]'} />
            </button>
          ))}
          {stars > 0 && <span className="text-[11px] text-[var(--soft)] ml-1.5">{stars}/5</span>}
        </div>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={2} placeholder={t('Пара слов о впечатлениях (необязательно)')} className="w-full mt-2.5 px-4 py-3 rounded-xl bg-[var(--bg)] text-[12.5px] outline-none resize-none placeholder:text-[var(--soft2)]" />
        <button onClick={submit} disabled={!vendor || !stars} className="press w-full h-[46px] rounded-full grad text-white text-[12.5px] font-semibold mt-2.5 disabled:opacity-40">
          {sentOk ? t('✓ Спасибо! Отзыв отправлен') : t('Отправить отзыв гостя')}
        </button>
      </div>
      {reviews.length > 0 && (
        <div className="space-y-2">
          {reviews.slice(0, 3).map(r => (
            <div key={r.id} className="card-s p-3.5">
              <div className="flex items-center justify-between gap-2">
                <b className="text-[12px] truncate">{r.vendor}</b>
                <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-[var(--blue)] text-[#5B7898] shrink-0">{t('Гость свадьбы')}</span>
              </div>
              <p className="text-[10px] text-[#B98A2F] mt-1">{'★'.repeat(r.stars)}{'☆'.repeat(5 - r.stars)} <span className="text-[var(--soft2)]">· {r.at}</span></p>
              <p className="text-[11.5px] text-[var(--ink2)] mt-1 font-light">{r.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
