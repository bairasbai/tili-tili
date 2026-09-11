import { useState } from 'react'
import { useNavigate } from 'react-router'
import { MessageSquareHeart, Plus, ShieldCheck, Star, Trash2, Users, X } from 'lucide-react'
import { fmt } from '@/lib/money'
import { rub } from '@/lib/money'
import { Bar, SectionHead, Tile, TopBar } from '@/components/chrome'
import { AsyncState, ready } from '@/components/AsyncState'
import { useApi, explainError } from '@/lib/api/useApi'
import { addFund, addGift as addGiftApi, contributeToFund, deleteFund, deleteGift as deleteGiftApi, fundGift, getGuestGifts, getWishlist, putAntiGifts, releaseGift, reserveGift } from '@/lib/api/gifts'
import { getGuestTeam, guestToken, sendGuestReview } from '@/lib/api/guest'
import { useStore } from '@/lib/store'
import { cn, goBack, pct } from '@/lib/utils'
import { t } from '@/lib/i18n'

/* ── Сторона пары: управление списком желаний ── */

/*
 * Подарки, фонды и «просим не дарить» живут на сервере.
 *
 * Прежде они лежали в `tt_gifts`, `tt_funds` и `tt_anti` — и это работало
 * ровно до второго устройства. Гость выбирает подарок со своего телефона:
 * его резерв не доходил до пары, а два гостя спокойно «занимали» одну и ту же
 * вещь, потому что каждый видел свою копию списка.
 *
 * Кто именно зарезервировал, паре не показывается никогда (§9) — сервер этого
 * поля ей и не отдаёт.
 */
export function WishlistManage() {
  const { weddingId } = useStore()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')
  const [group, setGroup] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const q = useApi(() => weddingId ? getWishlist(weddingId) : Promise.resolve(null), [weddingId])
  const gifts = q.data?.gifts ?? []
  const funds = q.data?.funds ?? []
  const anti = q.data?.antiGifts ?? []

  const write = async (id: string, fn: () => Promise<unknown>) => {
    if (!weddingId) { setErr(t('Сначала создайте свадьбу — список желаний живёт в ней')); return }
    setBusyId(id)
    setErr(null)
    try { await fn(); q.reload() } catch (e) { setErr(explainError(e)) } finally { setBusyId(null) }
  }

  const reserved = gifts.filter(g => g.reserved).length
  const submit = () => void write('new', async () => {
    if (!name.trim() || !Number(price)) return
    // поле «Цена, ₽» — рубли, на сервер уходят копейки
    await addGiftApi(weddingId!, { name: name.trim(), price: rub(Number(price)), group, icon: '🎁' })
    setName(''); setPrice(''); setGroup(false); setAdding(false)
  })

  return (
    <div className="pb-28">
      <TopBar back title={t('Список желаний')} sub={t('Что подарить вам на свадьбу')} />
      <AsyncState q={q} />
      <div className="px-5 mt-3 space-y-3">
        <div className="card p-4 flex gap-3 items-start">
          <ShieldCheck size={20} className="text-[var(--sage-deep)] shrink-0 mt-0.5" />
          <p className="text-[12px] text-[var(--soft)] leading-relaxed">
            {t('Гости выбирают подарки анонимно — вы видите только статус «Зарезервирован», но не видите, кто именно. Выбранный подарок закрывается для остальных, дублей не будет.')}
          </p>
        </div>

        {gifts.length > 0 && (
          <div className="card p-4">
            <div className="flex justify-between text-[12px] mb-2">
              <span className="font-medium">{t('Зарезервировано гостями')}</span>
              <span className="text-[var(--soft)]">{reserved} {t('из')} {gifts.length}</span>
            </div>
            <Bar pct={pct(reserved, gifts.length)} />
          </div>
        )}

        {err && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{err}</p>}

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
              <button disabled={busyId === 'new'} onClick={submit} className="press flex-1 py-3 rounded-[16px] grad text-[var(--on-grad)] text-[12.5px] font-semibold disabled:opacity-50">{busyId === 'new' ? t('Сохраняем…') : t('Добавить')}</button>
            </div>
          </div>
        )}
      </div>

      <SectionHead title={t('Наши желания')} sub={t('видно гостям по ссылке-приглашению')} />
      <div className="px-5 space-y-2.5">
        {!gifts.length && ready(q) && (
          <p className="text-[12px] text-[var(--soft)] text-center py-3">{t('Пока пусто — добавьте первое желание')}</p>
        )}
        {gifts.map((g, i) => (
          <CoupleGiftRow key={g.id} g={g} i={i} busy={busyId === g.id} onRemove={() => write(g.id ?? '', () => deleteGiftApi(weddingId!, g.id ?? ''))} />
        ))}
      </div>

      <FundsManage weddingId={weddingId} funds={funds} busyId={busyId} write={write} />
      <AntiManage weddingId={weddingId} anti={anti} busy={busyId === 'anti'} write={write} />

      {/* Кнопка «Открыть глазами гостя» убрана: гостевой экран подарков
          открывается по личному токену, которого у пары нет, — переход
          упирался бы в «нужна ссылка». Что видит гость, описано выше. */}
    </div>
  )
}

type Wish = NonNullable<Awaited<ReturnType<typeof getWishlist>>>
type WriteFn = (id: string, fn: () => Promise<unknown>) => Promise<void>

/* Денежные фонды — сторона пары */
function FundsManage({ weddingId, funds, busyId, write }: {
  weddingId: string | null
  funds: NonNullable<Wish['funds']>
  busyId: string | null
  write: WriteFn
}) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const submit = () => void write('fund', async () => {
    if (!name.trim() || !Number(target)) return
    await addFund(weddingId!, name.trim(), rub(Number(target)), '💌')
    setName(''); setTarget(''); setAdding(false)
  })
  /*
   * Деньги через приложение не проходят: платёжного провайдера нет (хвост
   * владельца). Взнос гостя — запись «обещаю внести», и сумма на полосе — то,
   * что гости обещали, а не то, что пришло. До ревью D3-02 здесь стояло
   * «Собрано» и «гости переводят на цель» — утверждение о деньгах без кода
   * под ним (R-174, R-203).
   */
  return (
    <>
      <SectionHead title={t('Денежные фонды')} sub={t('гости обещают суммы на цель вместо вещей')} />
      <div className="px-5 space-y-2.5">
        {funds.map(f => (
          <div key={f.id} className="card p-3.5">
            <div className="flex items-center gap-3">
              <Tile icon={f.icon ?? '💌'} tile="bg-[var(--rose-soft)]" />
              <div className="flex-1 min-w-0">
                <p className="text-[13.5px] font-semibold truncate">{f.name}</p>
                <p className="text-[11px] text-[var(--soft)]">{t('цель')} {fmt(f.target?.amount ?? 0)}</p>
              </div>
              <button disabled={busyId === f.id} onClick={() => write(f.id ?? '', () => deleteFund(weddingId!, f.id ?? ''))} className="press w-8 h-8 rounded-full bg-[var(--track)] flex items-center justify-center text-[var(--track-ink)] disabled:opacity-50" aria-label={t('Удалить')}><Trash2 size={14} /></button>
            </div>
            <div className="mt-3">
              <div className="flex justify-between text-[10.5px] text-[var(--soft)] mb-1">
                <span>{t('Обещано гостями')} {fmt(f.collected?.amount ?? 0)}</span><span>{pct(f.collected?.amount, f.target?.amount)}%</span>
              </div>
              <Bar pct={pct(f.collected?.amount, f.target?.amount)} />
            </div>
          </div>
        ))}
        {funds.length > 0 && (
          <p className="text-[10.5px] text-[var(--soft2)] px-1 leading-relaxed">{t('Суммы — обещания гостей: деньги они передают вам сами, приложение их не принимает.')}</p>
        )}
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
              <button disabled={busyId === 'fund'} onClick={submit} className="press flex-1 py-3 rounded-[16px] grad text-[var(--on-grad)] text-[12.5px] font-semibold disabled:opacity-50">{busyId === 'fund' ? t('Сохраняем…') : t('Добавить')}</button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

/* Анти-вишлист — сторона пары */
function AntiManage({ weddingId, anti, busy, write }: {
  weddingId: string | null
  anti: string[]
  busy: boolean
  write: WriteFn
}) {
  const [val, setVal] = useState('')
  /* Список заменяется целиком: отдельного пути «добавить строку» контракт не
     знает, и отправлять надо всё, что было. */
  const save = (items: string[]) => void write('anti', () => putAntiGifts(weddingId!, items))
  const add = () => { if (val.trim()) { save([...anti, val.trim()]); setVal('') } }
  return (
    <>
      <SectionHead title={t('Просим не дарить')} sub={t('анти-вишлист')} />
      <div className="px-5">
        <div className="card p-4">
          <div className="flex flex-wrap gap-2">
            {anti.map(a => (
              <span key={a} className="flex items-center gap-1.5 text-[11.5px] font-medium px-3 py-1.5 rounded-full bg-[var(--track)] text-[var(--track-ink)]">
                {a}
                <button disabled={busy} onClick={() => save(anti.filter(y => y !== a))} className="press disabled:opacity-50" aria-label={t('Удалить')}><X size={12} /></button>
              </span>
            ))}
          </div>
          <div className="flex gap-2 mt-3">
            <input value={val} onChange={e => setVal(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} placeholder={t('Например: сервизы')} className="flex-1 bg-[var(--track)] rounded-[12px] px-3.5 py-2.5 text-[12.5px] outline-none" />
            <button disabled={busy} onClick={add} className="press px-4 py-2.5 rounded-[12px] card-s text-[12px] font-bold disabled:opacity-50">{t('Добавить')}</button>
          </div>
        </div>
      </div>
    </>
  )
}

function CoupleGiftRow({ g, i, busy, onRemove }: {
  g: NonNullable<Wish['gifts']>[number]
  i: number
  busy: boolean
  onRemove: () => void
}) {
  const [confirm, setConfirm] = useState(false)
  /* Цвет плитки — дизайн-токен, а не данные: он считается по месту в списке.
     Сервер его и не отдаёт (см. описание `Gift.icon` в контракте). */
  const palette = ['bg-[var(--rose-soft)]', 'bg-[var(--sage-soft)]', 'bg-[var(--honey)]', 'bg-[var(--lav)]', 'bg-[var(--blue)]', 'bg-[var(--peach)]']
  return (
    <div className="card p-3.5 fade-up" style={{ animationDelay: `${i * 40}ms` }}>
      <div className="flex items-center gap-3">
        <Tile icon={g.icon ?? '🎁'} tile={palette[i % palette.length]!} />
        <div className="flex-1 min-w-0">
          <p className="text-[13.5px] font-semibold truncate">{g.name}</p>
          <p className="text-[11px] text-[var(--soft)]">{fmt(g.price?.amount ?? 0)}{g.group && ` · ${t('складчина')}`}</p>
        </div>
        {g.reserved
          ? <span className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-[var(--sage-soft)] text-[var(--sage-ink)]">{t('Зарезервирован')}</span>
          : <span className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-[var(--track)] text-[var(--track-ink)]">{t('Свободен')}</span>}
        {!confirm
          ? <button onClick={() => setConfirm(true)} className="press w-8 h-8 rounded-full bg-[var(--track)] flex items-center justify-center text-[var(--track-ink)]" aria-label={t('Удалить')}><Trash2 size={14} /></button>
          : <button disabled={busy} onClick={onRemove} className="press text-[10px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--rose-deep)] text-[var(--card)] disabled:opacity-50">{t('Точно?')}</button>}
      </div>
      {g.group && (
        <div className="mt-3">
          {/* Складчина — те же обещания, что и фонды: денег приложение не держит. */}
          <div className="flex justify-between text-[10.5px] text-[var(--soft)] mb-1">
            <span>{t('Обещано гостями')} {fmt(g.funded?.amount ?? 0)}</span><span>{pct(g.funded?.amount, g.price?.amount)}%</span>
          </div>
          <Bar pct={pct(g.funded?.amount, g.price?.amount)} />
        </div>
      )}
    </div>
  )
}

/* ── Сторона гостя: выбор подарка (анонимно) ── */

/*
 * Гость приходит сюда по своей ссылке-приглашению — тем же токеном, что и на
 * страницу RSVP. Раньше экран читал `tt_gifts` и `tt_funds` из браузера, и это
 * работало ровно до второго устройства: резерв не доходил до пары, а два гостя
 * спокойно занимали одну вещь, каждый в своей копии списка.
 *
 * Резерв атомарен на сервере: занятый подарок пропадает из выбора остальных, а
 * повторная попытка получает отказ, а не молчаливое «уже ваш».
 */
export function GiftPick() {
  const nav = useNavigate()
  const token = guestToken()
  const q = useApi(() => token ? getGuestGifts(token) : Promise.resolve(null), [token])
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [fundFor, setFundFor] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const gifts = q.data?.gifts ?? []
  const funds = q.data?.funds ?? []
  const anti = q.data?.antiGifts ?? []
  /* Ориентир «банкет на гостя» считает сервер по бюджету и числу гостей. Пока
     их нет — поля нет, и подставлять сюда 15 000 нельзя: это была выдуманная
     цифра, по которой человек решал, сколько потратить. */
  const fairPrice = q.data?.fairPrice?.amount ?? null

  const mine = gifts.filter(g => g.mine)
  const available = gifts.filter(g => !g.reserved)
  const taken = gifts.filter(g => g.reserved && !g.mine)

  const write = async (id: string, fn: () => Promise<unknown>) => {
    if (!token) return
    setBusyId(id)
    setErr(null)
    try { await fn(); q.reload() } catch (e) { setErr(explainError(e)) } finally { setBusyId(null) }
  }
  const doReserve = (id: string) => void write(id, async () => { await reserveGift(token!, id); setConfirmId(null) })
  const doRelease = (id: string) => void write(id, () => releaseGift(token!, id))
  const doFund = (id: string) => void write(id, async () => {
    const a = Number(amount)
    if (!a) return
    await fundGift(token!, id, rub(a))
    setAmount(''); setFundFor(null)
  })
  const doFundMoney = (id: string) => void write(id, async () => {
    const a = Number(amount)
    if (!a) return
    await contributeToFund(token!, id, rub(a))
    setAmount(''); setFundFor(null)
  })

  if (!token) return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-8 text-center">
      <p className="font-serif-d text-[22px]">{t('Нужна ссылка из приглашения')}</p>
      <p className="text-[12.5px] text-[var(--soft)] mt-3 leading-relaxed">
        {t('Список подарков открывается по личной ссылке: по ней приложение узнаёт, чей это резерв.')}
      </p>
    </div>
  )

  return (
    <div className="pb-28">
      <TopBar back title={t('Подарки')} sub={t('анонимно · резерв виден только вам')} />
      <AsyncState q={q} />
      <div className="px-5 mt-3">
        <div className="card p-4 flex gap-3 items-start">
          <ShieldCheck size={20} className="text-[var(--sage-deep)] shrink-0 mt-0.5" />
          <p className="text-[12px] text-[var(--soft)] leading-relaxed">
            {t('Полностью анонимно: молодожёны увидят только, что подарок зарезервирован, но не кем. Выбранный подарок сразу закрывается для других гостей.')}
          </p>
        </div>
        {fairPrice != null && (
          <p className="text-[10.5px] text-[var(--soft)] mt-2.5 px-1">{t('Деликатный ориентир: банкет на гостя ≈')} {fmt(fairPrice)}</p>
        )}
        {err && <p role="alert" className="text-[12px] text-[var(--rose-ink)] mt-2.5">{err}</p>}
      </div>

      {anti.length > 0 && (
        <div className="px-5 mt-3">
          <div className="card p-3.5">
            <p className="text-[11px] font-semibold mb-2">🙏 {t('Молодожёны просят не дарить')}:</p>
            <div className="flex flex-wrap gap-1.5">
              {anti.map(a => <span key={a} className="text-[10.5px] px-2.5 py-1 rounded-full bg-[var(--track)] text-[var(--track-ink)]">{a}</span>)}
            </div>
          </div>
        </div>
      )}

      {/*
        * Фонды и складчина — обещания, а не переводы. Платёжного провайдера
        * нет: сервер записывает сумму, которую гость обещал внести, и больше
        * ничего — деньги гость передаёт паре сам. До ревью D3-02 кнопка
        * называлась «Перевести на цель», подзаголовок — «анонимный перевод», и
        * гость, нажав «Внести», считал, что деньги ушли (R-174, R-203).
        */}
      {funds.length > 0 && (
        <>
          <SectionHead title={t('Денежные фонды')} sub={t('обещание внести — анонимно; деньги передаёте паре сами')} />
          <div className="px-5 space-y-2.5">
            {funds.map(f => (
              <div key={f.id} className="card p-3.5">
                <div className="flex items-center gap-3">
                  <Tile icon={f.icon ?? '💌'} tile="bg-[var(--rose-soft)]" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[13.5px] font-semibold truncate">{f.name}</p>
                    <p className="text-[11px] text-[var(--soft)]">{t('Обещано')} {fmt(f.collected?.amount ?? 0)} {t('из')} {fmt(f.target?.amount ?? 0)}</p>
                  </div>
                </div>
                <div className="mt-3"><Bar pct={pct(f.collected?.amount, f.target?.amount)} /></div>
                {fundFor === f.id ? (
                  <div className="flex gap-2 mt-2.5">
                    <input value={amount} onChange={e => setAmount(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder={t('Сумма, ₽')} className="flex-1 bg-[var(--track)] rounded-[12px] px-3.5 py-2.5 text-[12.5px] outline-none" />
                    <button disabled={busyId === f.id} onClick={() => doFundMoney(f.id ?? '')} className="press px-4 py-2.5 rounded-[12px] grad text-[var(--on-grad)] text-[12px] font-bold disabled:opacity-50">{t('Записать обещание')}</button>
                  </div>
                ) : (
                  <button onClick={() => { setFundFor(f.id ?? null); setAmount('') }} className="press mt-2.5 text-[11px] font-bold px-3.5 py-2 rounded-full card-s">{t('Обещаю внести')}</button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {mine.length > 0 && (
        <>
          <SectionHead title={t('Мой выбор')} />
          <div className="px-5 space-y-2.5">
            {mine.map(g => (
              <div key={g.id} className="card p-3.5 flex items-center gap-3 border-[1.5px] border-[var(--sage)]">
                <Tile icon={g.icon ?? '🎁'} tile="bg-[var(--sage-soft)]" />
                <div className="flex-1 min-w-0">
                  <p className="text-[13.5px] font-semibold truncate">{g.name}</p>
                  <p className="text-[11px] text-[var(--sage-deep)] font-medium">{t('Вы зарезервировали этот подарок')}</p>
                </div>
                <button disabled={busyId === g.id} onClick={() => doRelease(g.id ?? '')} className="press text-[10.5px] font-bold px-3 py-1.5 rounded-full bg-[var(--track)] text-[var(--track-ink)] disabled:opacity-50">{t('Снять резерв')}</button>
              </div>
            ))}
          </div>
        </>
      )}

      <SectionHead title={t('Свободные желания')} />
      <div className="px-5 space-y-2.5">
        {available.map((g, i) => {
          const price = g.price?.amount ?? 0
          const funded = g.funded?.amount ?? 0
          return (
            <div key={g.id} className="card p-3.5 fade-up" style={{ animationDelay: `${i * 40}ms` }}>
              <div className="flex items-center gap-3">
                <Tile icon={g.icon ?? '🎁'} tile="bg-[var(--rose-soft)]" />
                <div className="flex-1 min-w-0">
                  <p className="text-[13.5px] font-semibold truncate">{g.name}</p>
                  <p className="text-[11px] text-[var(--soft)]">{g.desc ? `${g.desc} · ` : ''}{fmt(price)}</p>
                </div>
                {/* «Купить в приложении» убрано: магазина и оплаты в приложении
                    нет, кнопка лишь ставила отметку «заказ оформлен». Гость
                    резервирует подарок и покупает его сам. */}
                {!g.group && (confirmId === g.id
                  ? <button disabled={busyId === g.id} onClick={() => doReserve(g.id ?? '')} className="press text-[11px] font-bold px-3.5 py-2 rounded-full grad text-[var(--on-grad)] disabled:opacity-50">{busyId === g.id ? t('Резервируем…') : t('Подтвердить')}</button>
                  : <button onClick={() => setConfirmId(g.id ?? null)} className="press text-[11px] font-bold px-3.5 py-2 rounded-full card-s">{t('Подарю')}</button>)}
              </div>
              {g.group && (
                <div className="mt-3">
                  {/* Складчина — обещания гостей, как и фонды (см. выше). */}
                  <div className="flex justify-between text-[10.5px] text-[var(--soft)] mb-1">
                    <span>{t('Обещано')} {fmt(funded)} {t('из')} {fmt(price)}</span><span>{pct(funded, price)}%</span>
                  </div>
                  <Bar pct={pct(funded, price)} />
                  {fundFor === g.id ? (
                    <div className="flex gap-2 mt-2.5">
                      <input value={amount} onChange={e => setAmount(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder={t('Сумма, ₽')} className="flex-1 bg-[var(--track)] rounded-[12px] px-3.5 py-2.5 text-[12.5px] outline-none" />
                      <button disabled={busyId === g.id} onClick={() => doFund(g.id ?? '')} className="press px-4 py-2.5 rounded-[12px] grad text-[var(--on-grad)] text-[12px] font-bold disabled:opacity-50">{t('Записать обещание')}</button>
                    </div>
                  ) : (
                    <button onClick={() => { setFundFor(g.id ?? null); setAmount('') }} className="press mt-2.5 text-[11px] font-bold px-3.5 py-2 rounded-full card-s">
                      {t('Скинуться')} · {t('осталось')} {fmt(Math.max(0, price - funded))}
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
        {!available.length && ready(q) && <p className="text-center text-[12px] text-[var(--soft)] py-6">{gifts.length ? t('Все желания уже зарезервированы 🎉') : t('Список желаний пока пуст')}</p>}
      </div>

      {taken.length > 0 && (
        <>
          <SectionHead title={t('Уже выбрано другими гостями')} />
          <div className="px-5 space-y-2.5">
            {taken.map(g => (
              <div key={g.id} className="card p-3.5 flex items-center gap-3 opacity-55">
                <Tile icon={g.icon ?? '🎁'} tile="bg-[var(--track)]" />
                <div className="flex-1 min-w-0">
                  <p className="text-[13.5px] font-semibold truncate">{g.name}</p>
                  <p className="text-[11px] text-[var(--soft)]">{fmt(g.price?.amount ?? 0)}</p>
                </div>
                <span className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-[var(--track)] text-[var(--track-ink)]">{t('Занято')}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Отзывы: список подрядчиков и отправка идут на сервер. Заголовок
          рисует сама форма — до свадьбы и без команды показывать нечего, а
          «Как прошла свадьба?» над пустым местом читается как поломка. */}
      <GuestReviewForm />

      <div className="px-5 mt-6">
        <button onClick={() => goBack(x => nav(x), (to, o) => nav(to, o), '/invite')} className="press w-full card-s py-4 text-[13px] font-semibold">{t('Назад')}</button>
      </div>
    </div>
  )
}

/**
 * Календарная дата «сейчас» в поясе свадьбы, `YYYY-MM-DD`.
 *
 * Пояс — из ответа сервера, если он его отдал; без него — пояс устройства:
 * гость обычно там же, где и свадьба, а UTC не совпадает ни с кем. Неизвестный
 * пояс не роняет экран — считаем по устройству.
 */
function todayIn(tz: string | null, now: number): string {
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit' } as const
  try {
    return new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: tz ?? undefined }).format(new Date(now))
  } catch {
    return new Intl.DateTimeFormat('en-CA', opts).format(new Date(now))
  }
}

/** Прошёл ли день свадьбы — по её поясу, как на сервере (`date < today`). */
const weddingPassed = (date: string, tz: string | null, now: number): boolean =>
  date < todayIn(tz, now)

/*
 * Отзыв гостя о подрядчике.
 *
 * Прежняя форма предлагала пять имён из мока («Елена Смирнова · фотограф») и
 * складывала отзыв в `tt_guest_reviews` браузера гостя: до пары он не доходил,
 * а оценить можно было того, кто на этой свадьбе не работал.
 *
 * Теперь список — те, кто действительно забронирован, а отзыв уходит на
 * сервер. Он же следит за остальным: оценивать можно только после свадьбы и
 * только того, у кого есть сделка, — повтор редактирует прежний отзыв.
 */
export function GuestReviewForm() {
  const token = guestToken()
  const q = useApi(() => token ? getGuestTeam(token) : Promise.resolve(null), [token])
  /* Идентификатор свадьбы приходит вместе с командой: путь отзыва требует его,
     а гостю взять его больше неоткуда. */
  const weddingId = q.data?.weddingId
  const team = q.data?.vendors ?? []
  const [vendorId, setVendorId] = useState('')
  const [stars, setStars] = useState(0)
  const [text, setText] = useState('')
  const [sentOk, setSentOk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /* «Сейчас» фиксируется на монтировании: `Date.now()` в теле рендера —
     нечистый вызов, его результат менялся бы от перерисовки к перерисовке. */
  const [now] = useState(() => Date.now())

  /* Без команды оценивать некого — формы нет вовсе, а не пустой список кнопок. */
  if (!token || !weddingId || !team.length) return null

  /* До свадьбы отзыв не принимается — это правило сервера, и сказать о нём
     нужно здесь, а не отказом после заполнения формы. День считается по
     поясу свадьбы, как на сервере: по UTC форма для свадьбы во Владивостоке
     появлялась на десять часов позже, чем сервер уже принимал отзыв, а при
     часах устройства «вперёд» — раньше, и гость получал 403 после
     заполнения (ревью D3-18). */
  const date = q.data?.weddingDate ?? null
  if (!date || !weddingPassed(date, (q.data as { tz?: string | null } | null)?.tz ?? null, now)) return (
    <>
      <SectionHead title={t('Как прошла свадьба?')} sub={t('отзыв о команде')} />
      <div className="px-5">
        <p className="text-[11.5px] text-[var(--soft)] leading-relaxed card p-4">
          {t('Оценить команду можно после дня свадьбы — тогда здесь появится форма отзыва.')}
        </p>
      </div>
    </>
  )

  const submit = () => void (async () => {
    if (!vendorId || !stars) return
    setBusy(true)
    setErr(null)
    try {
      await sendGuestReview(weddingId, token, vendorId, stars, text.trim() || undefined)
      setVendorId(''); setStars(0); setText(''); setSentOk(true)
    } catch (e) { setErr(explainError(e)) } finally { setBusy(false) }
  })()

  return (
    <>
      <SectionHead title={t('Как прошла свадьба?')} sub={t('ваш отзыв будет помечен «от гостя»')} />
      <div className="px-5 space-y-3">
      <div className="card p-4">
        <div className="flex gap-3 items-start">
          <MessageSquareHeart size={20} className="text-[var(--rose-deep)] shrink-0 mt-0.5" />
          <p className="text-[12px] text-[var(--soft)] leading-relaxed">
            {t('Вы оставляете отзыв')} <b className="text-[var(--ink)]">{t('как гость свадьбы')}</b>{t(' — он будет помечен значком «Гость» и не смешается с отзывом пары. Молодожёны увидят его анонимно.')}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5 mt-3">
          {team.map(v => (
            <button key={v.vendorId} onClick={() => setVendorId(v.vendorId ?? '')} className={cn('press text-[10.5px] font-medium px-3 py-1.5 rounded-full transition-all', vendorId === v.vendorId ? 'grad text-[var(--on-grad)]' : 'bg-[var(--bg)] text-[var(--soft)]')}>{v.name}</button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 mt-3">
          {[1, 2, 3, 4, 5].map(n => (
            <button key={n} onClick={() => setStars(n)} className="press p-1" aria-label={`${n}`}>
              <Star size={22} className={n <= stars ? 'fill-[var(--gold-soft)] text-[var(--gold-soft)]' : 'text-[var(--track)]'} />
            </button>
          ))}
          {stars > 0 && <span className="text-[11px] text-[var(--soft)] ml-1.5">{stars}/5</span>}
        </div>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={2} placeholder={t('Пара слов о впечатлениях (необязательно)')} className="w-full mt-2.5 px-4 py-3 rounded-xl bg-[var(--bg)] text-[12.5px] outline-none resize-none placeholder:text-[var(--soft2)]" />
        {err && <p role="alert" className="text-[11.5px] text-[var(--rose-ink)] mt-2">{err}</p>}
        <button onClick={submit} disabled={busy || !vendorId || !stars} className="press w-full h-[46px] rounded-full grad text-[var(--on-grad)] text-[12.5px] font-semibold mt-2.5 disabled:opacity-40">
          {busy ? t('Отправляем…') : sentOk ? t('✓ Спасибо! Отзыв отправлен') : t('Отправить отзыв гостя')}
        </button>
        {/* Список уже оставленных отзывов убран: он читался из `tt_guest_reviews`
            того же браузера и показывал гостю его собственные записи как «отзывы
            гостей». Настоящие отзывы читает пара — путь у неё свой. */}
      </div>
      </div>
    </>
  )
}
