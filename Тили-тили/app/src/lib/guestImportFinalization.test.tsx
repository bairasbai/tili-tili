// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GuestImportPanel } from '@/components/GuestImportPanel'
import { ApiError, saveTokens } from './api/client'
import { importGuests } from './api/weddingWrite'
import { buildImportPreview, createImportDraft, prepareImport } from './guestImportDraft'
import { setI18nLang } from './i18n'

vi.mock('./api/weddingWrite', () => ({ importGuests: vi.fn() }))
const request = vi.mocked(importGuests)
const refreshed = vi.fn()
const props = { weddingId: 'w1', existing: [], open: true, onImported: refreshed, onClose: vi.fn() }
function family(text = 'Анна', names = ['Борис']) {
  const row = createImportDraft(text)[0]!
  return { ...row, members: names.map((name, i) => ({ id: `m${i}`, name })) }
}
function open(text = 'Анна') {
  const view = render(<GuestImportPanel {...props} />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Список гостей' }), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Проверить и дополнить' }))
  return view
}
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Импортировать приглашения' }))
const retry = () => fireEvent.click(screen.getByRole('button', { name: 'Повторить тот же импорт' }))
beforeEach(() => { vi.clearAllMocks(); request.mockReset(); localStorage.clear(); setI18nLang('ru') })
afterEach(() => { cleanup(); saveTokens(null); localStorage.clear(); setI18nLang('ru') })

describe('FR-032 family-aware preview matches the server name policy', () => {
  it.each([['Анна'], ['Борис', ' БОРИС ']])('rejects duplicate members inside one invitation: %j', (...names) => {
    const preview = buildImportPreview([family('Анна', names)], [])
    expect(preview[0]!.duplicate).toBe(true)
    expect(prepareImport(preview).rows).toEqual([])
  })
  it('detects a companion already present in the server list', () => {
    const preview = buildImportPreview([family()], [{ name: ' БОРИС ' }])
    expect(preview[0]!.duplicate).toBe(true)
    expect(prepareImport(preview).persons).toBe(0)
  })
  it('reserves the accepted companion name against a later primary', () => {
    const rows = createImportDraft('Анна\nБорис')
    rows[0] = { ...rows[0]!, members: [{ id: 'm', name: 'Борис' }] }
    expect(buildImportPreview(rows, undefined).map(row => row.duplicate)).toEqual([false, true])
  })
  it('reserves companion names against later companions', () => {
    const rows = createImportDraft('Анна\nВера')
    const preview = buildImportPreview(rows.map(row => ({ ...row, members: [{ id: row.id, name: 'Борис' }] })), [])
    expect(preview.map(row => row.duplicate)).toEqual([false, true])
  })
  it('does not reserve any name or phone from a rejected invitation', () => {
    const rows = createImportDraft('Анна,89170001122\nАнна,89170001122')
    rows[0] = { ...rows[0]!, members: [{ id: 'm', name: 'Борис' }] }
    expect(buildImportPreview(rows, [{ name: 'Борис' }]).map(row => row.duplicate)).toEqual([true, false])
  })
  it('matches the server-generated legacy placeholder name', () => {
    expect(buildImportPreview(createImportDraft('Анна,+1'), [{ name: 'Спутник Анна' }])[0]!.duplicate).toBe(true)
  })
  it('accepts exactly 300 distinct invitations with ten people each', () => {
    const rows = createImportDraft(Array.from({ length: 300 }, (_, i) => `Семья ${i}`).join('\n'))
      .map((row, i) => ({ ...row, members: Array.from({ length: 9 }, (_, j) => ({ id: `m${j}`, name: `Человек ${i} ${j}` })) }))
    expect(prepareImport(buildImportPreview(rows, []))).toMatchObject({ invitations: 300, persons: 3000 })
  })
})

describe('RU and EN counter forms', () => {
  it.each([
    ['ru', 1, '1 приглашение · 1 персона'],
    ['ru', 2, '2 приглашения · 2 персоны'],
    ['ru', 5, '5 приглашений · 5 персон'],
    ['ru', 11, '11 приглашений · 11 персон'],
    ['ru', 21, '21 приглашение · 21 персона'],
    ['en', 1, '1 invitation · 1 person'],
    ['en', 2, '2 invitations · 2 people'],
    ['en', 21, '21 invitations · 21 people'],
  ] as const)('%s %i: %s', (lang, count, phrase) => {
    setI18nLang(lang)
    render(<GuestImportPanel {...props} />)
    fireEvent.change(screen.getByRole('textbox', { name: lang === 'ru' ? 'Список гостей' : 'Guest list' }),
      { target: { value: Array.from({ length: count }, (_, i) => `Guest ${i}`).join('\n') } })
    fireEvent.click(screen.getByRole('button', { name: lang === 'ru' ? 'Проверить и дополнить' : 'Review and complete' }))
    expect(screen.getByRole('status').textContent).toContain(phrase)
  })
})

describe('SC-007 explicit immutable retry, controlled HTTP outcomes', () => {
  it('freezes the captured intention after loss and repeats it despite a refreshed duplicate preview', async () => {
    request.mockRejectedValueOnce(new ApiError('network', 0, 'network', 'lost'))
    const view = open()
    fireEvent.click(screen.getByRole('button', { name: 'Добавить человека в семью' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Человек семьи 2' }), { target: { value: 'Борис' } })
    submit()
    await screen.findByRole('button', { name: 'Повторить тот же импорт' })
    expect(request).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('textbox', { name: 'Основной человек' }).matches(':disabled')).toBe(true)
    expect(screen.queryByText(/Создано приглашений:/)).toBeNull()
    view.rerender(<GuestImportPanel {...props} existing={[{ name: 'Анна' }, { name: 'Борис' }]} />)
    expect(screen.getByRole('status').textContent).toBe('Сохранённая попытка: 1 приглашение · 2 персоны')
    request.mockResolvedValueOnce({ created: [], skipped: [{ index: 0, name: 'Анна', reason: 'duplicate' }] })
    retry()
    await screen.findByText('Создано приглашений: 0')
    expect(request.mock.calls[1]).toEqual(request.mock.calls[0])
    expect(request.mock.calls[1]).toEqual(['w1', [{ name: 'Анна', members: [{ name: 'Борис' }] }]])
    expect(screen.getByText('Создано персон: 0')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Повторить тот же импорт' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Основной человек' }).matches(':disabled')).toBe(false)
  })
  it('never re-sends the locally invalid row, including on a repeated attempt', async () => {
    request.mockRejectedValueOnce(new Error('network'))
    open('А\nАнна')
    submit()
    await screen.findByRole('button', { name: 'Повторить тот же импорт' })
    request.mockResolvedValueOnce({ created: [{ partySize: 1 }], skipped: [] })
    retry()
    await screen.findByText('Создано персон: 1')
    expect(request.mock.calls[1]).toEqual(['w1', [{ name: 'Анна' }]])
    expect((screen.getByRole('textbox', { name: 'Основной человек' }) as HTMLInputElement).value).toBe('А')
  })
  it('keeps an unconfirmed attempt across closing and reopening', async () => {
    request.mockRejectedValueOnce(new Error('network'))
    const view = open()
    submit()
    await screen.findByRole('button', { name: 'Повторить тот же импорт' })
    view.rerender(<GuestImportPanel {...props} open={false} />)
    view.rerender(<GuestImportPanel {...props} />)
    expect(screen.getByRole('button', { name: 'Повторить тот же импорт' })).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'Основной человек' }) as HTMLInputElement).value).toBe('Анна')
    expect(request).toHaveBeenCalledTimes(1)
  })
  it.each([new ApiError('timeout', 0, 'timeout', 'timeout'), new ApiError('http', 500, 'error', 'failure')])('treats an uncertain server/transport outcome as retryable without fabricating totals: %s', async reason => {
    request.mockRejectedValueOnce(reason)
    open(); submit()
    await screen.findByRole('button', { name: 'Повторить тот же импорт' })
    expect(screen.queryByText(/Создано приглашений:/)).toBeNull()
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('retains an incomplete response as unknown, not successful', async () => {
    request.mockResolvedValueOnce({ created: [], skipped: [] })
    open(); submit()
    await screen.findByRole('button', { name: 'Повторить тот же импорт' })
    expect(screen.getByRole('alert').textContent).toContain('Не удалось подтвердить итог импорта')
    expect(screen.queryByText(/Создано приглашений:/)).toBeNull()
  })
  it('a definitive HTTP 422 leaves the form editable, not locked in uncertain retry', async () => {
    request.mockRejectedValueOnce(new ApiError('http', 422, 'validation', 'Проверьте имя'))
    open(); submit()
    await screen.findByText('Проверьте имя')
    expect(screen.queryByRole('button', { name: 'Повторить тот же импорт' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Основной человек' }).matches(':disabled')).toBe(false)
  })
  it('same-tick repeated retry clicks make exactly one additional command', async () => {
    request.mockRejectedValueOnce(new Error('network'))
    open(); submit()
    const button = await screen.findByRole('button', { name: 'Повторить тот же импорт' })
    let resolve!: (value: Awaited<ReturnType<typeof importGuests>>) => void
    request.mockReturnValueOnce(new Promise(yes => { resolve = yes }))
    act(() => { button.click(); button.click() })
    expect(request).toHaveBeenCalledTimes(2)
    await act(async () => resolve({ created: [{ partySize: 1 }], skipped: [] }))
    expect(screen.getByText('Создано персон: 1')).toBeTruthy()
  })
  it('a list-refresh callback failure never turns a confirmed import into a POST retry', async () => {
    request.mockResolvedValueOnce({ created: [{ partySize: 1 }], skipped: [] })
    refreshed.mockImplementationOnce(() => { throw new Error('refresh failed') })
    open(); submit()
    await screen.findByText('Создано персон: 1')
    expect(screen.queryByRole('button', { name: 'Повторить тот же импорт' })).toBeNull()
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('a rejected replay does not falsely settle the original uncertain transaction', async () => {
    request.mockRejectedValueOnce(new Error('network'))
    open(); submit()
    await screen.findByRole('button', { name: 'Повторить тот же импорт' })
    request.mockRejectedValueOnce(new ApiError('http', 422, 'validation', 'rejected replay'))
    retry()
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: 'Повторить тот же импорт' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Основной человек' }).matches(':disabled')).toBe(true)
    expect(screen.queryByText(/Создано приглашений:/)).toBeNull()
  })
  it('refresh failure cannot replace uncertainty with an instruction not to retry', async () => {
    refreshed.mockImplementationOnce(() => { throw new Error('reader failed') })
    request.mockRejectedValueOnce(new Error('network'))
    open(); submit()
    await screen.findByRole('button', { name: 'Повторить тот же импорт' })
    expect(screen.getByRole('alert').textContent).toContain('Сервер мог сохранить записи')
    expect(screen.getByRole('alert').textContent).not.toContain('повторная отправка не нужна')
  })

})

function credentials(session: string, expiry = 2000000000) {
  const claims = btoa(JSON.stringify({ sub: 'import-owner', sid: session, exp: expiry }))
  return { accessToken: `e30.${claims}.signature`, refreshToken: `refresh-${session}-${expiry}` }
}

describe('uncertain replay obeys the existing private-session boundary', () => {
  it('forgets the saved attempt and rejects a stale retry click after logout', async () => {
    saveTokens(credentials('session-a'))
    request.mockRejectedValueOnce(new Error('network'))
    open(); submit()
    const button = await screen.findByRole('button', { name: 'Повторить тот же импорт' })
    act(() => { saveTokens(null); button.click() })
    expect(request).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Повторить тот же импорт' })).toBeNull()
    expect((screen.getByRole('textbox', { name: 'Список гостей' }) as HTMLTextAreaElement).value).toBe('')
  })
  it('preserves the saved attempt through renewal but ignores a late replay after session replacement', async () => {
    saveTokens(credentials('session-a'))
    request.mockRejectedValueOnce(new Error('network'))
    open(); submit()
    await screen.findByRole('button', { name: 'Повторить тот же импорт' })
    act(() => saveTokens(credentials('session-a', 2000000300)))
    expect(screen.getByRole('button', { name: 'Повторить тот же импорт' })).toBeTruthy()
    let resolve!: (value: Awaited<ReturnType<typeof importGuests>>) => void
    request.mockReturnValueOnce(new Promise(yes => { resolve = yes }))
    retry()
    expect(request.mock.calls[1]).toEqual(request.mock.calls[0])
    const refreshCount = refreshed.mock.calls.length
    await act(async () => {
      saveTokens(credentials('session-b'))
      resolve({ created: [{ partySize: 1 }], skipped: [] })
    })
    expect(refreshed).toHaveBeenCalledTimes(refreshCount)
    expect(screen.queryByText(/Создано приглашений:/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Повторить тот же импорт' })).toBeNull()
  })
  it('cannot replay one wedding attempt into another wedding', async () => {
    request.mockRejectedValueOnce(new Error('network'))
    const view = open(); submit()
    await screen.findByRole('button', { name: 'Повторить тот же импорт' })
    view.rerender(<GuestImportPanel {...props} weddingId="w2" />)
    expect(screen.queryByRole('button', { name: 'Повторить тот же импорт' })).toBeNull()
    expect((screen.getByRole('textbox', { name: 'Список гостей' }) as HTMLTextAreaElement).value).toBe('')
    expect(request).toHaveBeenCalledTimes(1)
  })
})
