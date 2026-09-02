/*
 * Тестовое окружение.
 *
 * 1. Node 25 объявляет собственный глобальный `localStorage` (геттер Web Storage,
 *    неактивный без флага --localstorage-file). Он перекрывает Storage из jsdom,
 *    и любой вызов localStorage.clear/getItem падает с TypeError.
 * 2. jsdom не реализует IntersectionObserver (скролл-раскрытие приглашения)
 *    и window.scrollTo (сброс скролла при смене роута).
 */
class MemoryStorage implements Storage {
  private map = new Map<string, string>()
  get length() { return this.map.size }
  clear() { this.map.clear() }
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null }
  key(i: number) { return Array.from(this.map.keys())[i] ?? null }
  removeItem(k: string) { this.map.delete(k) }
  setItem(k: string, v: string) { this.map.set(k, String(v)) }
  [name: string]: unknown
}

function bind(name: 'localStorage' | 'sessionStorage') {
  const fromWindow = typeof window !== 'undefined' ? window[name] : undefined
  const store: Storage = fromWindow && typeof fromWindow.getItem === 'function' ? fromWindow : new MemoryStorage()
  Object.defineProperty(globalThis, name, { value: store, configurable: true, writable: true })
  if (typeof window !== 'undefined')
    Object.defineProperty(window, name, { value: store, configurable: true, writable: true })
}

bind('localStorage')
bind('sessionStorage')

/* Наблюдатель сразу сообщает «элемент виден»: в тестах нет вьюпорта и скролла,
   а без этого блоки приглашения остаются скрытыми классом .rv. */
if (typeof globalThis.IntersectionObserver === 'undefined') {
  class TestIntersectionObserver implements IntersectionObserver {
    readonly root = null
    readonly rootMargin = ''
    readonly thresholds: ReadonlyArray<number> = []
    private cb: IntersectionObserverCallback
    constructor(cb: IntersectionObserverCallback) { this.cb = cb }
    observe(target: Element) {
      this.cb([{ isIntersecting: true, target } as IntersectionObserverEntry], this)
    }
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] { return [] }
  }
  Object.defineProperty(globalThis, 'IntersectionObserver', {
    value: TestIntersectionObserver, configurable: true, writable: true,
  })
}

if (typeof window !== 'undefined')
  Object.defineProperty(window, 'scrollTo', { value: () => {}, configurable: true, writable: true })
