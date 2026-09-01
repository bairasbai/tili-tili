import { useState } from 'react'

/** Защита от двойного тапа/повторной отправки: пока busy — повторные вызовы игнорируются. */
export function useBusy(cooldownMs = 700): [boolean, (fn: () => void) => void] {
  const [busy, setBusy] = useState(false)
  const run = (fn: () => void) => {
    if (busy) return
    setBusy(true)
    try { fn() } finally { setTimeout(() => setBusy(false), cooldownMs) }
  }
  return [busy, run]
}
