import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import type { OutputBundle, OutputChunk } from 'rollup'
import { CRITICAL_PAGES, criticalAssets } from '../../build/criticalAssets'
import { projectFile } from '@/test/projectFiles'

function fixture(): OutputBundle {
  const chunk = (fileName: string, modules: string[] = [], imports: string[] = [], isEntry = false): OutputChunk =>
    ({ type: 'chunk', fileName, modules: Object.fromEntries(modules.map(m => [m, {}])), imports, isEntry }) as OutputChunk
  return Object.fromEntries([
    ['assets/main-hash.js', chunk('assets/main-hash.js', [], ['assets/shared-hash.js'], true)],
    ['assets/shared-hash.js', chunk('assets/shared-hash.js')],
    ['assets/not-critical.js', chunk('assets/not-critical.js', ['C:/src/pages/Admin.tsx'])],
    ...CRITICAL_PAGES.map((page, i) => [`assets/critical-${i}.js`, chunk(`assets/critical-${i}.js`, ['C:\\src\\pages\\' + page], ['assets/shared-hash.js'])]),
  ])
}
describe('actual-build critical static assets', () => {
  it('includes entry/critical routes/transitive shared imports once, not every lazy route or API', () => {
    const assets = criticalAssets(fixture())
    expect(assets).toHaveLength(6)
    expect(assets).toContain('./assets/shared-hash.js')
    expect(assets).not.toContain('./assets/not-critical.js')
  })
  it('refuses missing critical route, missing import and unsafe nonstatic output', () => {
    const missing = fixture(); delete missing['assets/critical-0.js']; expect(() => criticalAssets(missing)).toThrow('page missing')
    const broken = fixture(); delete broken['assets/shared-hash.js']; expect(() => criticalAssets(broken)).toThrow('import missing')
    const unsafe = fixture(); const shared = unsafe['assets/shared-hash.js']
    unsafe['api/private.js'] = { ...shared, fileName: 'api/private.js' }
    const main = unsafe['assets/main-hash.js'] as OutputChunk; main.imports = ['api/private.js']
    expect(() => criticalAssets(unsafe)).toThrow('Unsafe critical')
  })
})

async function install(failure: 'missing' | 'html' | 'redirect' | 'streams' | null, active = false) {
  const handlers = new Map<string, (event: { waitUntil: (promise: Promise<unknown>) => void }) => void>()
  const stored: string[] = [], removed: string[] = [], fetched: string[] = []
  let skipped = false, pending: Promise<unknown> | null = null
  let openStreams = 0
  const queued: (() => void)[] = []
  const source = projectFile('public/sw.js').replace('const CRITICAL_ASSETS = []', "const CRITICAL_ASSETS = ['./assets/critical.js']")
  runInNewContext(source, {
    self: { registration: { scope: 'https://example.test/app/', active: active ? {} : null }, addEventListener: (name: string, fn: typeof handlers extends Map<string, infer F> ? F : never) => handlers.set(name, fn), skipWaiting: () => { skipped = true } },
    location: { origin: 'https://example.test' }, URL, Request, Response,
    caches: { open: async () => ({ put: async (request: Request) => { stored.push(request.url) } }), delete: async (name: string) => { removed.push(name) } },
    fetch: async (request: Request) => {
      if (failure === 'streams') {
        if (openStreams === 2) await new Promise<void>(resolve => queued.push(resolve))
        openStreams++
      }
      fetched.push(request.url)
      const bad = request.url.endsWith('critical.js')
      return { ok: !(bad && failure === 'missing'), redirected: bad && failure === 'redirect', status: 200, statusText: 'OK',
        headers: new Headers({ 'content-type': bad && failure === 'html' ? 'text/html' : 'application/javascript' }),
        arrayBuffer: async () => { if (failure === 'streams') { openStreams--; queued.shift()?.() }; return new ArrayBuffer(1) } }
    },
  })
  handlers.get('install')!({ waitUntil: promise => { pending = promise } })
  let error = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([pending, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('install stalled')), 500) })]) } catch { error = true }
  finally { clearTimeout(timeout) }
  return { stored, removed, fetched, skipped, error }
}
describe('service worker installation uses complete validated static-only precache', () => {
  it('consumes response bodies before awaiting every header, even with bounded concurrent network streams', async () => {
    const result = await install('streams')
    expect(result.error).toBe(false); expect(result.skipped).toBe(true)
    expect(result.stored).toHaveLength(5)
  })
  it('does not force a new worker onto an existing client before explicit upgrade', async () => {
    const result = await install(null, true)
    expect(result.error).toBe(false); expect(result.skipped).toBe(false)
    expect(result.stored).toContain('https://example.test/app/assets/critical.js')
  })
  it('caches critical route before first visit, including subpath scope', async () => {
    const result = await install(null)
    expect(result.error).toBe(false); expect(result.skipped).toBe(true)
    expect(result.stored).toContain('https://example.test/app/assets/critical.js')
    expect(result.fetched.some(url => url.includes('/api/'))).toBe(false)
  })
  it.each(['missing', 'html', 'redirect'] as const)('does not activate or retain a partial cache on %s', async failure => {
    const result = await install(failure)
    expect(result.error).toBe(true); expect(result.skipped).toBe(false)
    expect(result.stored).toEqual([]); expect(result.removed).toEqual(['tilitili:/app/:v6'])
  })
})

describe('service worker cache ownership and subpath isolation', () => {
  it('accepts explicit activation only from its own scope, not another app or another message', async () => {
    let skipped = 0, pending: Promise<unknown> | null = null
    type Message = { data: { type: string }; source?: { url: string }; waitUntil: (promise: Promise<unknown>) => void }
    const handlers = new Map<string, (event: Message) => void>()
    runInNewContext(projectFile('public/sw.js'), {
      self: { registration: { scope: 'https://example.test/app/' }, addEventListener: (name: string, fn: (event: Message) => void) => handlers.set(name, fn), skipWaiting: async () => { skipped++ } },
      location: { origin: 'https://example.test' }, URL,
    })
    const send = (url: string, type: string) => handlers.get('message')!({ data: { type }, source: { url }, waitUntil: promise => { pending = promise } })
    send('https://example.test/other/', 'SKIP_WAITING'); send('https://foreign.test/app/', 'SKIP_WAITING'); send('https://example.test/app/', 'UNRELATED')
    expect(skipped).toBe(0)
    send('https://example.test/app/tools', 'SKIP_WAITING'); await pending
    expect(skipped).toBe(1)
  })
  it('activation deletes only obsolete caches of its own application scope', async () => {
    let pending: Promise<unknown> | null = null
    const deleted: string[] = [], handlers = new Map<string, (event: { waitUntil: (promise: Promise<unknown>) => void }) => void>()
    runInNewContext(projectFile('public/sw.js'), {
      self: { registration: { scope: 'https://example.test/app/' }, addEventListener: (name: string, fn: (event: { waitUntil: (promise: Promise<unknown>) => void }) => void) => handlers.set(name, fn), clients: { claim: async () => undefined } },
      location: { origin: 'https://example.test' }, URL,
      caches: { keys: async () => ['foreign-app-cache', 'tilitili:/app/:v6-old', 'tilitili:/other/:v6-sibling'], delete: async (name: string) => { deleted.push(name) } },
    })
    handlers.get('activate')!({ waitUntil: promise => { pending = promise } }); await pending
    expect(deleted).toEqual(['tilitili:/app/:v6-old'])
  })
  it('does not serve a foreign CacheStorage hit as its own bundled static asset', async () => {
    let pending: Promise<Response> | null = null
    const work: Promise<unknown>[] = []
    const handlers = new Map<string, (event: { request: Request; respondWith: (promise: Promise<Response>) => void; waitUntil: (promise: Promise<unknown>) => void }) => void>()
    runInNewContext(projectFile('public/sw.js'), {
      self: { registration: { scope: 'https://example.test/app/' }, addEventListener: (name: string, fn: (event: { request: Request; respondWith: (promise: Promise<Response>) => void; waitUntil: (promise: Promise<unknown>) => void }) => void) => handlers.set(name, fn) },
      location: { origin: 'https://example.test' }, URL, Request,
      caches: { match: async () => new Response('FOREIGN CACHE JS'), open: async () => ({ match: async () => undefined, put: async () => undefined }) },
      fetch: async () => new Response('OWN BUILD JS', { headers: { 'content-type': 'application/javascript' } }),
    })
    handlers.get('fetch')!({ request: new Request('https://example.test/app/assets/critical.js'), respondWith: promise => { pending = promise }, waitUntil: promise => { work.push(promise) } })
    const response = await pending as Response | null
    expect(response).not.toBeNull(); expect(await response!.text()).toBe('OWN BUILD JS')
    await Promise.all(work)
  })
})
