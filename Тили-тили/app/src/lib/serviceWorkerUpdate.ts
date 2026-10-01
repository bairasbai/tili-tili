import { reloadToRoot } from './i18n'

let waiting: ServiceWorker | null = null
const listeners = new Set<() => void>()
export const pendingUpdate = () => waiting
export function subscribeUpdate(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function publish(worker: ServiceWorker | null) {
  if (waiting === worker) return
  waiting = worker
  listeners.forEach(listener => listener())
}

export function observeRegistration(registration: ServiceWorkerRegistration) {
  const refresh = () => publish(registration.waiting?.state === 'installed' ? registration.waiting : null)
  const watchInstalling = () => {
    const installing = registration.installing
    if (installing) installing.addEventListener('statechange', refresh)
    refresh()
  }
  registration.addEventListener('updatefound', watchInstalling)
  watchInstalling()
}

export function observeController(container: ServiceWorkerContainer) {
  let controlled = !!container.controller
  let reloading = false
  container.addEventListener('controllerchange', () => {
    publish(null)
    if (controlled && !reloading) {
      reloading = true
      reloadToRoot()
    }
    controlled = !!container.controller
  })
}

export function requestUpdate() {
  if (!waiting || waiting.state !== 'installed') return false
  waiting.postMessage({ type: 'SKIP_WAITING' })
  return true
}
