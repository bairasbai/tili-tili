import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AppUpdate } from '@/components/AppUpdate'
import { observeController, observeRegistration, pendingUpdate, requestUpdate } from './serviceWorkerUpdate'

vi.mock('./i18n', () => ({ t: (s: string) => s, reloadToRoot: vi.fn() }))
import { reloadToRoot } from './i18n'

// Browser-shaped event targets; the actual worker is exercised separately in Chromium.
function registration(worker: ServiceWorker | null = null) {
  return Object.assign(new EventTarget(), { waiting: worker, installing: null }) as unknown as ServiceWorkerRegistration
}
function worker(state: ServiceWorkerState = 'installed') {
  return Object.assign(new EventTarget(), { state, postMessage: vi.fn() }) as unknown as ServiceWorker
}
beforeEach(() => { cleanup(); vi.clearAllMocks(); observeRegistration(registration()) })
describe('explicit service worker upgrade', () => {
  it('does not display an update or send a command without a waiting installed worker', () => {
    render(<AppUpdate />)
    expect(screen.queryByRole('button', { name: 'Обновить приложение' })).toBeNull()
    expect(requestUpdate()).toBe(false)
  })
  it('shows the existing waiting worker, cancellation does not activate it, confirmation does', () => {
    const waiting = worker(); observeRegistration(registration(waiting)); render(<AppUpdate />)
    fireEvent.click(screen.getByRole('button', { name: 'Обновить приложение' }))
    expect(screen.getByRole('dialog').textContent).toContain('Несохранённые изменения могут быть потеряны.')
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    expect(waiting.postMessage).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Обновить приложение' }))
    fireEvent.click(screen.getByRole('button', { name: 'Обновить' }))
    expect(waiting.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'SKIP_WAITING' })
  })
  it('observes a newly installed waiting worker and does not activate it automatically', () => {
    const reg = registration(), installing = worker('installing')
    Object.defineProperty(reg, 'installing', { value: installing, configurable: true })
    observeRegistration(reg)
    expect(pendingUpdate()).toBeNull()
    Object.defineProperty(reg, 'waiting', { value: installing })
    Object.defineProperty(installing, 'state', { value: 'installed' })
    installing.dispatchEvent(new Event('statechange'))
    expect(pendingUpdate()).toBe(installing)
    expect(installing.postMessage).not.toHaveBeenCalled()
  })
  it('does not reload on first claim, reloads to app root only once on subsequent upgrade', () => {
    const container = Object.assign(new EventTarget(), { controller: null }) as unknown as ServiceWorkerContainer
    observeController(container)
    Object.defineProperty(container, 'controller', { value: worker() })
    container.dispatchEvent(new Event('controllerchange'))
    expect(reloadToRoot).not.toHaveBeenCalled()
    container.dispatchEvent(new Event('controllerchange')); container.dispatchEvent(new Event('controllerchange'))
    expect(reloadToRoot).toHaveBeenCalledTimes(1)
  })
  it('reports a failed activation command instead of claiming success', () => {
    const waiting = worker(); vi.mocked(waiting.postMessage).mockImplementation(() => { throw new Error('closed worker') })
    observeRegistration(registration(waiting)); render(<AppUpdate />)
    fireEvent.click(screen.getByRole('button', { name: 'Обновить приложение' }))
    fireEvent.click(screen.getByRole('button', { name: 'Обновить' }))
    expect(screen.getByRole('alert').textContent).toContain('Не удалось применить обновление.')
  })
})
