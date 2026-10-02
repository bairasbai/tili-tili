import { useRef, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'

/** Полноэкранный пикер без сайдбара; Radix изолирует фокус и фон. */
export function PickerDialog({ label, onClose, children }: {
  label: string
  onClose: () => void
  children: ReactNode
}) {
  const opener = useRef<HTMLElement | null>(null)

  return (
    <DialogPrimitive.Root open onOpenChange={open => { if (!open) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <DialogPrimitive.Content
          className="picker-dialog"
          aria-label={label}
          aria-modal="true"
          aria-describedby={undefined}
          onOpenAutoFocus={() => {
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          }}
          onCloseAutoFocus={event => {
            // Пикеры открываются из разных экранов, без Radix DialogTrigger.
            event.preventDefault()
            if (opener.current?.isConnected) opener.current.focus({ preventScroll: true })
          }}
        >
          <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
