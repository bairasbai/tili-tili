// @vitest-environment node
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { projectFile } from '@/test/projectFiles'

type FetchEvent = {
  request: Request
  respondWith: (response: Promise<Response>) => void
  waitUntil: (work: Promise<unknown>) => void
}

function runtime(options: { hit?: Response; response?: Response; put?: () => Promise<void> } = {}) {
  const handlers = new Map<string, (event: FetchEvent) => void>()
  const writes: { url: string; body: Promise<string> }[] = []
  const work: Promise<unknown>[] = []
  let fetches = 0, opens = 0, response: Promise<Response> | null = null
  runInNewContext(projectFile('public/sw.js'), {
    self: { registration: { scope: 'https://example.test/app/' }, addEventListener: (name: string, callback: (event: FetchEvent) => void) => handlers.set(name, callback) },
    location: { origin: 'https://example.test' }, URL, Request, Response,
    caches: { open: async () => { opens++; return {
      match: async () => options.hit,
      put: async (request: Request, copy: Response) => {
        writes.push({ url: request.url, body: copy.text() })
        await options.put?.()
      },
    } } },
    fetch: async () => { fetches++; return options.response ?? new Response('build js', { headers: { 'content-type': 'application/javascript' } }) },
  })
  const request = (path = 'assets/lazy-hash.js') => {
    handlers.get('fetch')!({
      request: new Request(new URL(path, 'https://example.test/app/')),
      respondWith: promise => { response = promise }, waitUntil: promise => { work.push(promise) },
    })
    return response
  }
  return { request, writes, work, counts: () => ({ fetches, opens }) }
}

describe('runtime static cache survives service-worker event completion', () => {
  it('returns the response promptly and keeps the worker alive until the cache write finishes', async () => {
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const worker = runtime({ put: () => gate })
    const response = await worker.request()
    expect(await response!.text()).toBe('build js')
    expect(worker.writes).toHaveLength(1)
    expect(await worker.writes[0].body).toBe('build js')
    expect(worker.work).toHaveLength(1)
    let completed = false
    const completion = Promise.all(worker.work).then(() => { completed = true })
    await Promise.resolve()
    expect(completed).toBe(false)
    finish(); await completion
    expect(completed).toBe(true)
  })

  it('still serves the network response when cache storage rejects the write', async () => {
    const worker = runtime({ put: async () => { throw new Error('quota exceeded') } })
    expect(await (await worker.request())!.text()).toBe('build js')
    await expect(Promise.all(worker.work)).resolves.toBeDefined()
  })

  it('serves a cache hit without another request or write', async () => {
    const worker = runtime({ hit: new Response('cached build') })
    expect(await (await worker.request())!.text()).toBe('cached build')
    await Promise.all(worker.work)
    expect(worker.counts().fetches).toBe(0)
    expect(worker.writes).toEqual([])
  })

  it.each(['redirect', 'html', 'http-error'])('does not cache a %s response under a build asset URL', async kind => {
    const response = new Response('unexpected response', { status: kind === 'http-error' ? 404 : 200, headers: { 'content-type': kind === 'html' ? 'text/html' : 'application/javascript' } })
    if (kind === 'redirect') Object.defineProperty(response, 'redirected', { value: true })
    const worker = runtime({ response })
    expect(await (await worker.request())!.text()).toBe('unexpected response')
    await Promise.all(worker.work)
    expect(worker.writes).toEqual([])
  })

  it.each(['/api/users/me', '/v1/weddings/private', '/app/uploads/private.jpg', 'https://foreign.test/assets/file.js'])('leaves %s outside CacheStorage', path => {
    const worker = runtime()
    expect(worker.request(path)).toBeNull()
    expect(worker.counts()).toEqual({ fetches: 0, opens: 0 })
    expect(worker.work).toEqual([])
  })
})
