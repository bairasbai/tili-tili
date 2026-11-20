import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import { useLiveAccess } from './offlineProgramHooks'

export function useOrderLiveAccess(open: boolean, busy: boolean, refresh: (assertLatest: () => void) => Promise<void>, onError: (error: unknown) => void) {
  const version = useRef(0)
  const [requested, setRequested] = useState(0), [checked, setChecked] = useState(0)
  const [failed, setFailed] = useState(false)
  const recheck = useCallback(() => {
    if (navigator.onLine) setRequested(++version.current)
  }, [])
  const online = useLiveAccess(recheck)
  const refreshLatest = useEffectEvent(refresh)
  const report = useEffectEvent(onError)
  useEffect(() => {
    if (!open || busy || !online || requested === checked) return
    let active = true
    const assertLatest = () => {
      if (!active || version.current !== requested || !navigator.onLine) throw new Error('Access check superseded')
    }
    void refreshLatest(assertLatest).then(() => {
      assertLatest()
      setFailed(false)
      setChecked(requested)
    }).catch(error => {
      if (active && version.current === requested && navigator.onLine) {
        report(error)
        setFailed(true)
        setChecked(requested)
      }
    })
    return () => { active = false }
  }, [open, busy, online, requested, checked])
  return { online, checking: requested !== checked, failed, recheck,
    canAct: () => navigator.onLine && version.current === checked && !failed }
}
