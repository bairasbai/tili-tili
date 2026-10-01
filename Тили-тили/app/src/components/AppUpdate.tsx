import { useEffect, useState, useSyncExternalStore } from 'react'
import { RefreshCw } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { pendingUpdate, requestUpdate, subscribeUpdate } from '@/lib/serviceWorkerUpdate'
import { t } from '@/lib/i18n'

export function AppUpdate() {
  const worker = useSyncExternalStore(subscribeUpdate, pendingUpdate)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!busy) return
    const timeout = window.setTimeout(() => { setBusy(false); setError(true) }, 15000)
    return () => window.clearTimeout(timeout)
  }, [busy])
  if (!worker) return null
  const update = () => {
    setError(false)
    try {
      if (requestUpdate()) setBusy(true)
      else setError(true)
    } catch { setError(true) }
  }
  return <div role="status" className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-[13px] bg-[var(--card)] text-[var(--ink)] border-b border-[var(--border)]">
    <span>{t('Доступно обновление')}</span>
    <button type="button" onClick={() => setOpen(true)} title={t('Обновить приложение')} aria-label={t('Обновить приложение')} className="inline-flex h-9 items-center gap-2 px-2 font-semibold"><RefreshCw size={16} />{t('Обновить')}</button>
    <Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next) }}>
      <DialogContent className="bg-[var(--card)] text-[var(--ink)]" showCloseButton={!busy}>
        <DialogTitle>{t('Обновить приложение')}</DialogTitle>
        <DialogDescription>{t('Открытые вкладки приложения перезагрузятся. Несохранённые изменения могут быть потеряны.')}</DialogDescription>
        {error && <p role="alert">{t('Не удалось применить обновление. Попробуйте ещё раз.')}</p>}
        <div className="flex flex-wrap justify-end gap-3">
          <button type="button" disabled={busy} onClick={() => setOpen(false)} className="h-10 px-3 disabled:opacity-50">{t('Отмена')}</button>
          <button type="button" disabled={busy} onClick={update} className="inline-flex h-10 items-center gap-2 px-3 font-semibold disabled:opacity-50"><RefreshCw size={16} />{busy ? t('Обновляем…') : t('Обновить')}</button>
        </div>
      </DialogContent>
    </Dialog>
  </div>
}
