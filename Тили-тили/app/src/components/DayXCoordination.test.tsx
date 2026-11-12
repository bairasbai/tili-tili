import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DayXCoordination } from './DayXCoordination'
import { saveTokens } from '@/lib/api/client'
import { setI18nLang } from '@/lib/i18n'
import type { DayXPerformer, DayXPerformerUpdate } from '@/lib/api/weddingWrite'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); setI18nLang('ru') })

it('uses the event time zone and saves arrival and readiness as separate actions', async () => {
  setI18nLang('ru')
  localStorage.setItem('tt_wedding_id', JSON.stringify('wedding'))
  const claims = btoa(JSON.stringify({ sub: 'coordinator', sid: 'session', exp: 1 }))
  saveTokens({ accessToken: `header.${claims}.signature`, refreshToken: 'synthetic-refresh' })
  const scopeKey = 'a'.repeat(64), writes: DayXPerformerUpdate[] = []
  const openTasks = [{ id: 'task', title: 'Проверить микрофон', due: null, assignee: null }]
  let performer: DayXPerformer = {
    dealId: 'deal', label: 'Фотограф', name: 'Тестовый фотограф', phone: '+7 (917) 000-00-00',
    event: { name: 'Церемония', date: '2027-06-14', timeZone: 'Europe/Moscow' },
    scopeKey, revision: null, plannedArrivalAt: null, arrival: null, readiness: null,
  }
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== 'PATCH') return Response.json({ performers: [performer], openTasks })
    const patch = JSON.parse(String(init.body)) as DayXPerformerUpdate
    writes.push(patch)
    const observation = { at: '2027-06-14T09:00:00Z', by: 'Координатор теста' }
    performer = {
      ...performer, revision: 'revision-' + writes.length,
      ...(patch.plannedArrivalAt !== undefined && { plannedArrivalAt: patch.plannedArrivalAt }),
      ...(patch.arrived && { arrival: observation }),
      ...(patch.ready && { readiness: observation }),
    }
    return Response.json(performer)
  }))

  render(<DayXCoordination weddingId="wedding" />)
  await screen.findByText('Тестовый фотограф')
  expect(screen.getByRole('link', { name: /Позвонить/ }).getAttribute('href')).toBe('tel:+79170000000')
  expect(screen.getByText('Незакрытые задачи · 1')).toBeDefined()
  expect(screen.getByText('Проверить микрофон')).toBeDefined()
  fireEvent.change(screen.getByLabelText(/Время приезда по месту мероприятия/), { target: { value: '2027-06-14T12:30' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить время' }))
  await screen.findByText(/Плановый приезд · 14\.06\.2027 · 12:30/)
  expect(screen.getByText('Прибытие · Не отмечено')).toBeDefined()
  expect(screen.getByText('Готовность · Не отмечено')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Отметить прибытие' }))
  await screen.findByRole('button', { name: 'Снять отметку прибытия' })
  expect(screen.getByText('Готовность · Не отмечено')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Отметить готовность' }))
  await waitFor(() => expect(screen.getAllByText(/Координатор теста/)).toHaveLength(2))
  expect(writes).toEqual([
    { scopeKey, expectedRevision: null, plannedArrivalAt: '2027-06-14T09:30:00.000Z' },
    { scopeKey, expectedRevision: 'revision-1', arrived: true },
    { scopeKey, expectedRevision: 'revision-2', ready: true },
  ])
})
