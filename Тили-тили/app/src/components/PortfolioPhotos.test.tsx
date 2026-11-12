import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PortfolioPhotos } from './PortfolioPhotos'
import { saveTokens } from '@/lib/api/client'
import { setI18nLang } from '@/lib/i18n'
import type { MediaUpload } from '@/lib/api/media'

type Call = { path: string; method: string; headers: Headers; body: BodyInit | null | undefined; signal?: AbortSignal | null }
const tokens = (sub: string, sid = 'session-a', exp = 1) => ({ accessToken: 'header.' + btoa(JSON.stringify({ sub, sid, exp })) + '.signature', refreshToken: `${sub}-${exp}` })
const photo = (patch: Partial<MediaUpload> = {}): MediaUpload => ({ uploadId: 'u1', state: 'ready', contentType: 'image/png', sizeBytes: 3,
  createdAt: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z', readyAt: '2026-01-01T00:00:01Z', deletedAt: null,
  fileUrl: 'https://app.example.test/api/media/photos/u1', outputBytes: 3, width: 1, height: 1, errorCode: null, retryable: false, ...patch })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const image = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/webp' } })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { resolve, promise } }
async function abortable<T>(pending: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  let stop = () => undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'))
      stop = () => { signal?.removeEventListener('abort', abort); return undefined }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      pending.then(resolve, reject)
    })
  } finally { stop() }
}
function serve(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { path: String(input).replace(/^\/api/, ''), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body, signal: init?.signal }
    calls.push(call); return await handler(call)
  }))
  return calls
}
const createURL = vi.fn<(blob: Blob) => string>(), revokeURL = vi.fn<(url: string) => void>()
const props = () => ({ confirmed: true, confirming: false, onConfirmRights: vi.fn(), legacy: [] as string[] })
const view = (p = props()) => <MemoryRouter><PortfolioPhotos {...p} /></MemoryRouter>
beforeEach(() => {
  localStorage.clear(); saveTokens(tokens('a')); setI18nLang('ru')
  createURL.mockReset().mockImplementation(() => `blob:synthetic-${createURL.mock.calls.length}`); revokeURL.mockReset()
  vi.stubGlobal('URL', class extends URL { static createObjectURL = createURL; static revokeObjectURL = revokeURL })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setI18nLang('ru') })

describe('portfolio UI through the actual API client (controlled HTTP, no PostgreSQL claim)', () => {
  it('waits for explicit rights acknowledgement and never enables an unconfigured upload', async () => {
    const p = { ...props(), confirmed: false }
    const calls = serve(() => json({ enabled: false, items: [] }))
    const screenView = render(view(p))
    expect(screen.queryByLabelText('Выбрать фотографию портфолио')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить права и сохранить анкету' }))
    expect(p.onConfirmRights).toHaveBeenCalledTimes(1); expect(calls).toHaveLength(0)
    expect(screen.queryByLabelText('Выбрать фотографию портфолио')).toBeNull()
    screenView.rerender(view({ ...p, confirmed: true }))
    const input = await screen.findByLabelText('Выбрать фотографию портфолио')
    expect(input).toHaveProperty('disabled', true); expect(screen.queryByText('Загрузка фотографий пока не подключена')).not.toBeNull()
  })
  it('renders actual pending/processing/failed/ready states and retries the existing failed ID', async () => {
    let items = [photo({ uploadId: 'pending', state: 'pending', fileUrl: null, retryable: true }),
      photo({ uploadId: 'processing', state: 'processing', fileUrl: null, retryable: true }),
      photo({ uploadId: 'failed', state: 'failed', fileUrl: null, retryable: true }), photo()]
    const calls = serve(call => {
      if (call.path === '/media/uploads') return json({ enabled: true, items })
      if (call.path.startsWith('/media/photos/')) return image()
      if (call.path === '/media/uploads/failed/complete') { items = items.map(item => item.uploadId === 'failed' ? photo({ uploadId: 'failed' }) : item); return json(photo({ uploadId: 'failed' })) }
      throw new Error(`Unexpected ${call.method} ${call.path}`)
    })
    render(view())
    await screen.findByText('Ожидает загрузки')
    expect(screen.queryByText('Проверяем фотографию…')).not.toBeNull(); expect(screen.queryByText('Фотография готова')).not.toBeNull()
    const failed = screen.getByText('Проверка не завершена').closest('div')!
    fireEvent.click(within(failed).getByRole('button', { name: 'Повторить проверку' }))
    await waitFor(() => expect(screen.queryByText('Проверка не завершена')).toBeNull())
    expect(calls.filter(call => call.path.endsWith('/complete')).map(call => call.path)).toEqual(['/media/uploads/failed/complete'])
    expect(calls.filter(call => call.path.includes('/media/photos/')).every(call => call.headers.get('authorization')?.startsWith('Bearer '))).toBe(true)
  })
  it('shows upload then scan then ready and sends a real multipart body to the controlled provider', async () => {
    const provider = deferred<Response>(), scanning = deferred<void>(), completion = deferred<Response>()
    let items: MediaUpload[] = []
    const calls = serve(call => {
      if (call.path === '/media/uploads') return json({ enabled: true, items })
      if (call.path === '/media/upload-url') return json({ uploadId: 'u1', method: 'POST', uploadUrl: 'https://objects.example.test/upload', fields: { Policy: 'synthetic', key: 'quarantine/u1/original' }, expiresAt: '2027-01-01T00:00:00Z' }, 201)
      if (call.path === 'https://objects.example.test/upload') return abortable(provider.promise, call.signal)
      if (call.path.endsWith('/complete')) { scanning.resolve(); return abortable(completion.promise, call.signal) }
      if (call.path.startsWith('/media/photos/')) return image()
      throw new Error(call.path)
    })
    render(view())
    fireEvent.change(await screen.findByLabelText('Выбрать фотографию портфолио'), { target: { files: [new File(['png'], 'private.png', { type: 'image/png' })] } })
    await screen.findByText('Загружаем фотографию…')
    await act(async () => { provider.resolve(new Response(null, { status: 204 })); await scanning.promise })
    expect(screen.queryByText('Проверяем фотографию…')).not.toBeNull()
    items = [photo()]
    await act(async () => { completion.resolve(json(photo())) })
    await screen.findByText('Фотография добавлена в портфолио')
    expect((await screen.findByRole('img', { name: 'Фотография портфолио' })).getAttribute('src')).toBe('blob:synthetic-1')
    const sent = calls.find(call => call.path === 'https://objects.example.test/upload')!
    expect(sent.body).toBeInstanceOf(FormData); expect(sent.headers.has('authorization')).toBe(false)
  })
  it('deletes via the existing asset ID, reports queued physical removal and revokes its blob', async () => {
    let items = [photo()]
    const calls = serve(call => {
      if (call.path === '/media/uploads') return json({ enabled: true, items })
      if (call.path === '/media/photos/u1') return image()
      if (call.path === '/media/uploads/u1' && call.method === 'DELETE') { items = []; return json({ uploadId: 'u1', state: 'deleted', deletion: 'queued' }) }
      throw new Error(call.path)
    })
    render(view())
    const preview = await screen.findByRole('img', { name: 'Фотография портфолио' })
    const previewUrl = preview.getAttribute('src')
    expect(previewUrl).toMatch(/^blob:synthetic-/)
    fireEvent.click(screen.getByRole('button', { name: 'Удалить фотографию' }))
    await screen.findByText('Фотография скрыта, физическое удаление поставлено в очередь')
    await waitFor(() => {
      expect(screen.queryByRole('img', { name: 'Фотография портфолио' })).toBeNull()
      expect(revokeURL).toHaveBeenCalledWith(previewUrl)
    })
    expect(calls.filter(call => call.method === 'DELETE').map(call => call.path)).toEqual(['/media/uploads/u1'])
  })
  it('hides old data and revokes the ready preview on A→B→A', async () => {
    serve(call => call.path === '/media/uploads' ? json({ enabled: true, items: [photo()] }) : image())
    render(view()); await screen.findByRole('img', { name: 'Фотография портфолио' })
    act(() => { saveTokens(tokens('b', 'session-b')); saveTokens(tokens('a', 'session-a', 2)) })
    expect(screen.queryByText('Сессия изменилась — откройте анкету заново')).not.toBeNull()
    expect(screen.queryByRole('img')).toBeNull(); expect(revokeURL).toHaveBeenCalledWith('blob:synthetic-1')
  })
  it('aborts a late private body on session change without creating any blob URL', async () => {
    const reading = deferred<void>(); let aborted = false
    serve(call => {
      if (call.path === '/media/uploads') return json({ enabled: true, items: [photo()] })
      const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
        call.signal!.addEventListener('abort', () => { aborted = true; controller.error(new DOMException('Aborted', 'AbortError')) }, { once: true })
      } }), { headers: { 'content-type': 'image/webp' } })
      const blob = response.blob.bind(response); response.blob = () => { reading.resolve(); return blob() }
      return response
    })
    render(view()); await screen.findByText('Фотография готова'); await reading.promise
    act(() => { saveTokens(tokens('b', 'session-b')) })
    await waitFor(() => expect(aborted).toBe(true))
    expect(createURL).not.toHaveBeenCalled(); expect(screen.queryByRole('img')).toBeNull()
  })
  it('unmount aborts an ongoing provider upload and never initiates complete', async () => {
    const entered = deferred<void>(); let aborted = false
    const calls = serve(call => {
      if (call.path === '/media/uploads') return json({ enabled: true, items: [] })
      if (call.path === '/media/upload-url') return json({ uploadId: 'u1', method: 'POST', uploadUrl: 'https://objects.example.test/upload', fields: {}, expiresAt: '2027-01-01T00:00:00Z' }, 201)
      if (call.path === 'https://objects.example.test/upload') return new Promise<Response>((_resolve, reject) => {
        call.signal!.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')) }, { once: true }); entered.resolve()
      })
      throw new Error(call.path)
    })
    const mounted = render(view())
    fireEvent.change(await screen.findByLabelText('Выбрать фотографию портфолио'), { target: { files: [new File(['png'], 'private.png', { type: 'image/png' })] } })
    await act(async () => { await entered.promise }); mounted.unmount()
    expect(aborted).toBe(true); expect(calls.some(call => call.path.endsWith('/complete'))).toBe(false)
  })
  it('offers retry after preview failure and retries the authenticated GET', async () => {
    let previews = 0
    serve(call => {
      if (call.path === '/media/uploads') return json({ enabled: true, items: [photo()] })
      if (++previews === 1) return json({ error: { code: 'media_storage_unavailable', message: 'Хранилище временно недоступно — попробуйте позже' } }, 503)
      return image()
    })
    render(view())
    fireEvent.click(await screen.findByRole('button', { name: 'Повторить предпросмотр' }))
    await screen.findByRole('img', { name: 'Фотография портфолио' })
    expect(previews).toBe(2)
  })
  it('keeps legacy external same-path images and uses the English dictionary', async () => {
    setI18nLang('en')
    serve(() => json({ enabled: false, items: [] }))
    render(view({ ...props(), legacy: ['https://external.example/media/photos/old-image'] }))
    expect(await screen.findByLabelText('Choose a portfolio photo')).toHaveProperty('disabled', true)
    expect(screen.queryByText('Portfolio photos')).not.toBeNull()
    expect(screen.getByRole('img', { name: 'Previously added work' }).getAttribute('src')).toBe('https://external.example/media/photos/old-image')
  })
  it('retries an unknown completion with the same selected file and intent key', async () => {
    let items: MediaUpload[] = [], completions = 0
    const keys: (string | null)[] = []
    serve(call => {
      if (call.path === '/media/uploads') return json({ enabled: true, items })
      if (call.path === '/media/upload-url') {
        keys.push(call.headers.get('idempotency-key'))
        return json({ uploadId: 'u1', method: 'POST', uploadUrl: 'https://objects.example.test/upload', fields: {}, expiresAt: '2027-01-01T00:00:00Z' }, 201)
      }
      if (call.path === 'https://objects.example.test/upload') return new Response(null, { status: 204 })
      if (call.path.endsWith('/complete')) {
        items = [photo()]
        if (++completions === 1) throw new TypeError('Synthetic completion response loss')
        return json(photo())
      }
      if (call.path.startsWith('/media/photos/')) return image()
      throw new Error(call.path)
    })
    render(view())
    fireEvent.change(await screen.findByLabelText('Выбрать фотографию портфолио'), { target: { files: [new File(['png'], 'private.png', { type: 'image/png' })] } })
    fireEvent.click(await screen.findByRole('button', { name: 'Повторить ту же загрузку' }))
    await screen.findByText('Фотография добавлена в портфолио')
    expect(keys).toHaveLength(2); expect(keys[0]).toBeTruthy(); expect(keys[1]).toBe(keys[0]); expect(completions).toBe(2)
  })
})
