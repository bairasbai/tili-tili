import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrderDelivery } from './OrderDelivery'
import { saveTokens } from '@/lib/api/client'
import { setI18nLang } from '@/lib/i18n'
import type { components } from '@/lib/api/schema'

const path = '/deals/d1/order/delivery'
const filePath = `${path}/files/file1/content`
const material = 'https://example.invalid/private-material'
const submitted: components['schemas']['OrderDeliveryView'] = {
  available: true, actorRole: 'couple', revision: 1, uploadEnabled: false, drafts: [],
  steps: [{ revision: 1, kind: 'submitted', summary: 'Готовая галерея', materialUrl: material,
    dueOn: '2027-06-15', comment: null, createdAt: '2027-06-14T12:00:00Z',
    files: [{ uploadId: 'file1', contentType: 'application/pdf', sizeBytes: 14 }] }],
}
const denied = () => json({ error: { code: 'forbidden', message: 'Доступ к материалам закрыт' } }, 403)
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}
function deferred() {
  let resolve!: (value: Response) => void
  const promise = new Promise<Response>(finish => { resolve = finish })
  return { promise, resolve }
}
function serve(handler: (path: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => handler(String(input).replace(/^\/api/, ''), init))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
async function open() {
  render(<OrderDelivery dealId="d1" />)
  fireEvent.click(screen.getByRole('button', { name: 'Материалы по сделке' }))
  await screen.findByText('Готовая галерея')
}
beforeEach(() => {
  setI18nLang('ru')
  saveTokens({ accessToken: 'a', refreshToken: 'r' })
})
afterEach(() => { cleanup(); saveTokens(null); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('hides private materials and writes offline, then checks access on reconnect and focus', async () => {
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  const reloaded = deferred()
  let response = () => json(submitted) as Response | Promise<Response>
  const calls = serve(() => response())
  await open()
  const accept = screen.getByRole('button', { name: 'Принять результат' })
  expect(screen.getByRole('link', { name: 'Открыть материалы' }).getAttribute('href')).toBe(material)
  const comment = 'Несохранённый комментарий'
  fireEvent.change(screen.getByLabelText('Что нужно исправить'), { target: { value: comment } })
  online.mockReturnValue(false)
  fireEvent(window, new Event('offline'))
  expect(screen.getByText('Нет связи с сервером')).toBeTruthy()
  expect(screen.queryByRole('link', { name: 'Открыть материалы' })).toBeNull()
  expect(screen.queryByRole('button', { name: /Скачать файл/ })).toBeNull()
  fireEvent.click(accept)
  expect(calls.mock.calls).toHaveLength(1)
  response = () => reloaded.promise
  online.mockReturnValue(true)
  fireEvent(window, new Event('online'))
  expect(screen.getByText('Обновляем…')).toBeTruthy()
  expect(screen.queryByText('Готовая галерея')).toBeNull()
  await act(async () => reloaded.resolve(json(submitted)))
  await screen.findByRole('link', { name: 'Открыть материалы' })
  expect(screen.getByLabelText('Что нужно исправить')).toHaveProperty('value', comment)
  response = denied
  fireEvent.focus(window)
  await screen.findByText('Доступ к материалам закрыт')
  expect(screen.queryByText('Готовая галерея')).toBeNull()
  expect(calls.mock.calls).toHaveLength(3)
})

it('cancels a pending download when access is rechecked and discards late bytes', async () => {
  const download = deferred()
  let response = () => json(submitted)
  const blobUrl = vi.fn(() => 'blob:private-material')
  const nativeCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: blobUrl })
  let signal: AbortSignal | null | undefined
  try {
    serve((url, init) => {
      if (url === filePath) { signal = init?.signal; return download.promise }
      return response()
    })
    await open()
    fireEvent.click(screen.getByRole('button', { name: /Скачать файл/ }))
    await waitFor(() => expect(signal).toBeTruthy())
    response = denied
    fireEvent.focus(window)
    await screen.findByText('Доступ к материалам закрыт')
    expect(signal?.aborted).toBe(true)
    await act(async () => download.resolve(new Response(new Blob(['synthetic file'], { type: 'application/pdf' }))))
    expect(blobUrl).not.toHaveBeenCalled()
  } finally {
    if (nativeCreate) Object.defineProperty(URL, 'createObjectURL', nativeCreate)
    else Reflect.deleteProperty(URL, 'createObjectURL')
  }
})
