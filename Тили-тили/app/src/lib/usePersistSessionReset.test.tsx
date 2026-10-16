// @vitest-environment jsdom
import { startTransition, useLayoutEffect } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { usePersist } from './usePersist'

const KEY = 'session-reset-real-hook'
let current: ReturnType<typeof usePersist<string | null>> | null = null
function Probe() {
  const persisted = usePersist<string | null>(KEY, null)
  useLayoutEffect(() => { current = persisted })
  return <output data-testid="persisted">{JSON.stringify(persisted[0])}</output>
}
beforeEach(() => { localStorage.clear(); current = null })
afterEach(cleanup)

describe('usePersist session reset retires queued persistence updates', () => {
  it('clear keeps initial null and removes storage after two old transition setters rebase', async () => {
    render(<Probe />)
    await act(async () => {
      const [, set, clear] = current!
      startTransition(() => { set('queued-first'); set('queued-old-second') })
      clear()
      await Promise.resolve()
    })
    expect(screen.getByTestId('persisted').textContent).toBe('null')
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('clear followed by a new B setter preserves the new state and exact stored value', async () => {
    render(<Probe />)
    await act(async () => {
      const [, set, clear] = current!
      startTransition(() => { set('queued-first'); set('queued-old-second') })
      clear()
      set('new-B')
      await Promise.resolve()
    })
    expect(screen.getByTestId('persisted').textContent).toBe(JSON.stringify('new-B'))
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify('new-B'))
  })
})
