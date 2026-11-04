import { useEffect, useRef, useState } from 'react'
import { Download } from 'lucide-react'
import { t } from '@/lib/i18n'
import type { PdfPageSize } from '@/lib/localPdf'
import { useLegacyActionScope, useLegacySessionKey } from '@/lib/useLegacyActionScope'

type PdfDocument = { title: string; body: string; filename: string; pageSize?: PdfPageSize }

/** Export the current displayed snapshot, fenced through every asynchronous step. */
export function OwnedPdfButton({ weddingId, snapshot, disabled = false, label, createDocument, verifyAccess, canExport, className }: {
  weddingId: string | null; snapshot: unknown; disabled?: boolean; label: string; createDocument: () => PdfDocument
  verifyAccess: () => Promise<unknown>; canExport?: () => boolean; className?: string
}) {
  const sessionKey = useLegacySessionKey(weddingId ?? '')
  const captureAccess = useLegacyActionScope(sessionKey, weddingId)
  const latest = useRef({ weddingId, snapshot, disabled, revision: 0 })
  if (latest.current.weddingId !== weddingId || latest.current.snapshot !== snapshot || latest.current.disabled !== disabled) {
    latest.current = { weddingId, snapshot, disabled, revision: latest.current.revision + 1 }
  }
  const mounted = useRef(true)
  const operation = useRef<object | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current = null } }, [])

  async function save() {
    if (!weddingId || disabled || operation.current) return
    let access: ReturnType<typeof captureAccess>
    try { access = captureAccess() } catch { return }
    const revision = latest.current.revision
    const request = {}
    operation.current = request
    const isCurrent = () => mounted.current && operation.current === request && latest.current.revision === revision
      && latest.current.weddingId === weddingId && !latest.current.disabled && access.isCurrent() && (canExport?.() ?? true)
    if (!isCurrent()) { operation.current = null; return }
    setBusy(true); setError(false)
    try {
      await verifyAccess()
      if (!isCurrent()) return
      const document = createDocument()
      const { downloadTextPdf } = await import('@/lib/localPdf')
      if (!isCurrent()) return
      await downloadTextPdf({ ...document, isCurrent, beforeDownload: verifyAccess })
    } catch {
      if (isCurrent()) setError(true)
    } finally {
      if (operation.current === request) {
        operation.current = null
        if (mounted.current) setBusy(false)
      }
    }
  }

  return <>
    <button type="button" disabled={disabled || busy || !weddingId} aria-busy={busy} onClick={() => void save()}
      className={className ?? 'press card-s py-4 text-[12.5px] font-semibold flex items-center justify-center gap-2 disabled:opacity-50'}>
      <Download size={15} />{busy ? t('Готовим PDF…') : label}
    </button>
    {error && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{t('Не удалось сохранить PDF. Повторите.')}</p>}
  </>
}
