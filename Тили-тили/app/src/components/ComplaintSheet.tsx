import { useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { t } from '@/lib/i18n'
import { explainError } from '@/lib/api/useApi'
import { sendComplaint, type ComplaintCategory, type ComplaintTarget } from '@/lib/api/reviews'

/*
 * Шторка жалобы (§18.2) — одна на четыре места: анкета подрядчика, отзыв в
 * кабинете, сообщение в чате, спор по сделке. До сверки планов 2026-09-18
 * `POST /complaints` жил только на сервере: очередь `/admin/complaints` в
 * панели стояла без единого источника из приложения, а «Открыть спор» на
 * сделке вёл на почту поддержки.
 *
 * Причина — из четырёх, которые знает модерация; свободный текст — по
 * желанию. Ответ 201 и на повтор по той же цели — «ещё раз нажал», не вторая
 * жалоба. Сроков ответа здесь не обещаем: SLA модерации — вопрос дежурного
 * человека (RELEASE-BLOCKERS №18), не кода (R-174).
 */
const CATEGORIES: { id: ComplaintCategory; label: string; hint: string }[] = [
  { id: 'fraud', label: 'Обман или вымогательство', hint: 'просят оплату мимо договора, требуют лишнее, обещают то, чего нет' },
  { id: 'no_show', label: 'Не пришёл или не выполнил', hint: 'сорвал дату, не сделал оговорённое' },
  { id: 'content', label: 'Неприемлемое содержание', hint: 'оскорбления, чужие фото, недостоверная анкета или отзыв' },
  { id: 'spam', label: 'Спам', hint: 'реклама, массовые сообщения, навязывание услуг' },
]

export function ComplaintSheet({ target, targetId, title, onClose }: {
  target: ComplaintTarget
  targetId: string
  title: string
  onClose: () => void
}) {
  const [category, setCategory] = useState<ComplaintCategory | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  const submit = () => void (async () => {
    if (!category || busy) return
    setBusy(true)
    setErr(null)
    try {
      await sendComplaint(target, targetId, category, text)
      setSent(true)
    } catch (e) {
      setErr(explainError(e))
    } finally {
      setBusy(false)
    }
  })()

  return (
    <div role="dialog" aria-modal="true" aria-label={t('Пожаловаться')} className="fixed inset-0 z-50 bg-black/40 flex items-end justify-center" onClick={onClose}>
      <div className="w-full max-w-[430px] bg-[var(--bg)] rounded-t-[32px] p-6 pb-[max(28px,env(safe-area-inset-bottom))] fade-up" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <b className="font-serif-d text-[19px] block">{t('Пожаловаться')}</b>
            <p className="text-[10.5px] text-[var(--soft)] truncate">{title}</p>
          </div>
          <button onClick={onClose} className="press w-9 h-9 rounded-full bg-[var(--card)] flex items-center justify-center" aria-label={t('Закрыть')}><X size={15} /></button>
        </div>

        {sent ? (
          <div className="mt-5">
            <p role="status" className="text-[13px] font-semibold">{t('Жалоба принята')}</p>
            <p className="text-[11.5px] text-[var(--soft)] leading-relaxed mt-1">
              {t('Модерация её рассмотрит. Переписка и сделка остаются в приложении — им есть на что опереться.')}
            </p>
            <button onClick={onClose} className="press w-full h-[48px] rounded-full grad text-[var(--on-grad)] font-semibold text-[13px] mt-4">{t('Готово')}</button>
          </div>
        ) : (
          <>
            <div className="space-y-2 mt-4" role="radiogroup" aria-label={t('Причина')}>
              {CATEGORIES.map(c => (
                <button
                  key={c.id}
                  role="radio"
                  aria-checked={category === c.id}
                  onClick={() => setCategory(c.id)}
                  className={cn('press w-full card-s p-3.5 text-left', category === c.id && 'ring-2 ring-[var(--rose)]')}
                >
                  <b className="text-[12.5px] block">{t(c.label)}</b>
                  <span className="text-[10.5px] text-[var(--soft)] leading-relaxed">{t(c.hint)}</span>
                </button>
              ))}
            </div>
            <textarea
              value={text}
              onChange={e => setText(e.target.value.slice(0, 4000))}
              placeholder={t('Что случилось — по желанию')}
              className="w-full mt-3 rounded-[18px] bg-[var(--card)] px-4 py-3 text-[13px] outline-none min-h-[84px] placeholder:text-[var(--soft2)]"
              style={{ boxShadow: 'var(--shadow)' }}
            />
            {err && <p role="alert" className="text-[11.5px] text-[var(--rose-ink)] leading-relaxed mt-2">{err}</p>}
            <button
              disabled={!category || busy}
              onClick={submit}
              className="press w-full h-[52px] rounded-full grad text-[var(--on-grad)] font-semibold text-[14px] mt-4 disabled:opacity-50"
              style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}
            >
              {busy ? t('Отправляем…') : t('Отправить жалобу')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
