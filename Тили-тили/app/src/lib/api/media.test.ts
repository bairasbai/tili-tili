import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveTokens } from './client'
import { completePortfolioPhoto, getPortfolioPreview, uploadPortfolioPhoto } from './media'

const tokens = (sub: string, sid = 'session-a', exp = 1) => ({ accessToken: 'header.' + btoa(JSON.stringify({ sub, sid, exp })) + '.signature', refreshToken: `refresh-${sub}-${exp}` })
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
const grant = { uploadId: 'u1', method: 'POST', uploadUrl: 'https://objects.example.test/private-media',
  fields: { key: 'quarantine/u1/original', Policy: 'synthetic-policy', 'Content-Type': 'image/png', 'X-Amz-Signature': 'synthetic-signature' }, expiresAt: '2027-01-01T00:00:00Z' }
const ready = { uploadId: 'u1', state: 'ready', contentType: 'image/png', sizeBytes: 3, createdAt: '2026-01-01T00:00:00Z',
  expiresAt: '2027-01-01T00:00:00Z', readyAt: '2026-01-01T00:00:01Z', deletedAt: null, fileUrl: 'https://app.example.test/api/media/photos/u1',
  outputBytes: 3, width: 1, height: 1, errorCode: null, retryable: false }
const file = () => new File(['png'], 'private-user-filename.png', { type: 'image/png' })
const options = () => ({ assertCurrent: vi.fn(), onIntent: vi.fn(), onProgress: vi.fn() })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { resolve, promise } }
beforeEach(() => { localStorage.clear(); saveTokens(tokens('a')) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('portfolio client through actual session/refresh/body boundaries (controlled HTTP replies)', () => {
  it('sends one exact multipart POST with signed fields before file, without app credentials', async () => {
    const calls: { path: string; init?: RequestInit }[] = [], opts = options()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input); calls.push({ path, init })
      if (path.endsWith('/upload-url')) return json(grant, 201)
      if (path === grant.uploadUrl) return new Response(null, { status: 204 })
      return json(ready)
    }))
    expect(await uploadPortfolioPhoto(file(), 'same-intent-key', opts)).toEqual(ready)
    expect(calls).toHaveLength(3)
    expect(new Headers(calls[0]!.init!.headers).get('authorization')).toContain('Bearer ')
    expect(new Headers(calls[0]!.init!.headers).get('idempotency-key')).toBe('same-intent-key')
    const provider = calls[1]!.init!
    expect(provider.credentials).toBe('omit'); expect(provider.redirect).toBe('error'); expect(provider.referrerPolicy).toBe('no-referrer')
    const headers = new Headers(provider.headers)
    expect(headers.has('authorization')).toBe(false); expect(headers.has('idempotency-key')).toBe(false); expect(headers.has('content-type')).toBe(false)
    const body = provider.body as FormData
    expect([...body.keys()]).toEqual([...Object.keys(grant.fields), 'file'])
    expect((body.get('file') as File).name).toBe('portfolio')
    expect(opts.onIntent).toHaveBeenCalledWith('u1'); expect(opts.onProgress.mock.calls.map(a => a[0])).toEqual(['uploading', 'scanning'])
  })
  it.each(['empty', 'svg', 'oversized'] as const)('rejects %s before any request', async kind => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    const chosen = kind === 'empty' ? new File([], 'empty.png', { type: 'image/png' })
      : kind === 'svg' ? new File(['<svg/>'], 'image.svg', { type: 'image/svg+xml' })
      : new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' })
    await expect(uploadPortfolioPhoto(chosen, 'key', options())).rejects.toMatchObject({ code: 'media_invalid_photo' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each(['issue', 'provider-body', 'complete-body'] as const)('a queued A→B→A boundary stops the entire chain at %s', async phase => {
    const entered = deferred<void>(), resume = deferred<void>(), calls: string[] = [], opts = options()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input); calls.push(path)
      if (path.endsWith('/upload-url')) {
        if (phase === 'issue') { entered.resolve(); await resume.promise }
        return json(grant, 201)
      }
      if (path === grant.uploadUrl) {
        if (phase !== 'provider-body') return new Response(null, { status: 204 })
        let controller!: ReadableStreamDefaultController<Uint8Array>
        const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value } }), { status: 200 })
        const getReader = response.body!.getReader.bind(response.body!)
        Object.defineProperty(response.body!, 'getReader', { value: () => {
          const reader = getReader(), read = reader.read.bind(reader)
          let first = true
          reader.read = async () => {
            if (first) { first = false; entered.resolve(); await resume.promise; controller.enqueue(new Uint8Array([1])); controller.close() }
            return read()
          }
          return reader
        } })
        return response
      }
      const response = json(ready)
      if (phase === 'complete-body') {
        const original = response.text.bind(response)
        response.text = async () => { entered.resolve(); await resume.promise; return original() }
      }
      return response
    }))
    const pending = uploadPortfolioPhoto(file(), 'key', opts)
    const outcome = pending.then(() => 'resolved', () => 'rejected')
    await entered.promise
    const a = JSON.stringify(tokens('a')), b = JSON.stringify(tokens('b', 'session-b'))
    localStorage.setItem('tt_auth', JSON.stringify(tokens('a', 'session-a', 2)))
    window.dispatchEvent(new StorageEvent('storage', { key: 'tt_auth', storageArea: localStorage, oldValue: a, newValue: b }))
    resume.resolve()
    expect(await outcome).toBe('rejected')
    expect(calls.some(path => path.includes('/auth/refresh'))).toBe(false)
    if (phase !== 'complete-body') expect(calls.some(path => path.endsWith('/complete'))).toBe(false)
    if (phase === 'issue') expect(calls).toHaveLength(1)
    expect(localStorage.getItem('tt_auth')).toBe(JSON.stringify(tokens('a', 'session-a', 2)))
  })
  it('renews the same session during provider upload and finishes under its new access token', async () => {
    let completeAuthorization: string | null = null
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/upload-url')) return json(grant, 201)
      if (String(input) === grant.uploadUrl) { saveTokens(tokens('a', 'session-a', 2)); return new Response(null, { status: 204 }) }
      completeAuthorization = new Headers(init?.headers).get('authorization'); return json(ready)
    }))
    await expect(uploadPortfolioPhoto(file(), 'key', options())).resolves.toEqual(ready)
    expect(completeAuthorization).toBe('Bearer ' + tokens('a', 'session-a', 2).accessToken)
  })
  it('retries a lost completion response with the same intent key and upload ID', async () => {
    let completions = 0
    const keys: (string | null)[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.endsWith('/upload-url')) { keys.push(new Headers(init?.headers).get('idempotency-key')); return json(grant, 201) }
      if (path === grant.uploadUrl) return new Response(null, { status: 204 })
      if (++completions === 1) throw new TypeError('Synthetic lost HTTP response after completion')
      expect(path).toBe('/api/media/uploads/u1/complete'); return json(ready)
    }))
    await expect(uploadPortfolioPhoto(file(), 'same-key', options())).rejects.toMatchObject({ kind: 'network' })
    await expect(uploadPortfolioPhoto(file(), 'same-key', options())).resolves.toEqual(ready)
    expect(keys).toEqual(['same-key', 'same-key']); expect(completions).toBe(2)
  })
  it('private blob reading keeps Authorization and fences a late body after logout', async () => {
    const entered = deferred<void>(), resume = deferred<void>()
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + tokens('a').accessToken)
      const response = new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/webp' } })
      const original = response.blob.bind(response)
      response.blob = async () => { entered.resolve(); await resume.promise; return original() }
      return response
    }))
    const pending = getPortfolioPreview('u1', { assertCurrent: () => undefined })
    const result = pending.then(() => 'resolved', () => 'rejected')
    await entered.promise; saveTokens(null); resume.resolve()
    expect(await result).toBe('rejected'); expect(localStorage.getItem('tt_auth')).toBeNull()
  })
  it('pre-aborted action never initiates complete', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    const controller = new AbortController(); controller.abort()
    await expect(completePortfolioPhoto('u1', { assertCurrent: () => undefined, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('cancels an actual pending private body on logout after headers', async () => {
    const entered = deferred<void>(); let cancelled = false
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        init!.signal!.addEventListener('abort', () => { cancelled = true; controller.error(new DOMException('Aborted', 'AbortError')) }, { once: true })
      } })
      const response = new Response(stream, { headers: { 'content-type': 'image/webp' } })
      const original = response.blob.bind(response)
      response.blob = () => { entered.resolve(); return original() }
      return response
    }))
    const pending = getPortfolioPreview('u1', { assertCurrent: () => undefined })
    const outcome = pending.then(() => 'resolved', () => 'rejected')
    await entered.promise; saveTokens(null)
    expect(await outcome).toBe('rejected'); expect(cancelled).toBe(true)
  })
})
