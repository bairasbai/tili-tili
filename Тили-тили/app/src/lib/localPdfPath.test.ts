import { afterEach, expect, it, vi } from 'vitest'

const scope = vi.hoisted(() => ({ base: '/' }))
vi.mock('./i18n', () => ({ appRoot: () => scope.base }))
afterEach(() => vi.unstubAllGlobals())

it.each(['/', '/preview/'])('loads its font from app root %s on a nested route', async base => {
  vi.resetModules(); scope.base = base
  const fetcher = vi.fn().mockResolvedValue({ ok: false })
  vi.stubGlobal('fetch', fetcher)
  const { downloadTextPdf } = await import('./localPdf')
  await expect(downloadTextPdf({ title: 'Test', body: 'Text', filename: 'test.pdf', isCurrent: () => true })).rejects.toThrow('PDF font unavailable')
  const requested = new URL(fetcher.mock.calls[0][0], `https://example.invalid${base}wedding/seating`)
  expect(requested.pathname).toBe(`${base}fonts/pdf/ProjectSans.ttf`)
})
