import { useRef, useState } from 'react'
import { exportMyData } from '@/lib/api/auth'
import { explainError } from '@/lib/api/useApi'
import { t } from '@/lib/i18n'
import { useLegacyActionScope } from '@/lib/useLegacyActionScope'

export function AccountDataExport({ weddingId, buttonClassName }: { weddingId?: string; buttonClassName: string }) {
  const capture = useLegacyActionScope('account-export', weddingId)
  const pending = useRef(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function download() {
    if (pending.current) return
    const scope = capture()
    if (!scope.isCurrent()) return
    pending.current = true
    setExporting(true)
    setError(null)
    try {
      const data = await exportMyData(scope)
      scope.assertCurrent()
      const href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
      const link = document.createElement('a')
      try {
        link.href = href
        link.download = `tili-tili-${new Date().toISOString().slice(0, 10)}.json`
        document.body.appendChild(link)
        link.click()
      } finally {
        link.remove()
        URL.revokeObjectURL(href)
      }
    } catch (cause) {
      if (scope.isCurrent()) setError(explainError(cause))
    } finally {
      pending.current = false
      if (scope.isCurrent()) setExporting(false)
    }
  }

  return <div>
    <button type="button" disabled={exporting} onClick={() => void download()} className={buttonClassName}>
      {exporting ? t('Собираем файл…') : t('Выгрузить мои данные')}
    </button>
    {error && <p role="alert" className="mt-1 text-[11px] text-center text-[var(--rose-deep)]">{error}</p>}
  </div>
}
