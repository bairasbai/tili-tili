import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TillyActionCards, type TillyActionView } from '@/components/TillyActionCards'
import { ApiError } from './api/client'
import { setI18nLang } from './i18n'
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', TestResizeObserver)
const state=vi.hoisted(()=>({generation:0}))
vi.mock('./useLegacyActionScope',()=>({useLegacySessionKey:()=>String(state.generation),useLegacyActionScope:()=>()=>{const generation=state.generation;return{isCurrent:()=>generation===state.generation,assertCurrent:()=>undefined}}}))
const pending:TillyActionView={id:'a1',kind:'create_task',title:'Synthetic task',due:'2027-06-02',state:'pending',expiresAt:'2099-06-02T12:00:00Z',result:null,canApply:true}
const applied={...pending,state:'applied' as const,canApply:false,result:{taskId:'task1'}}
beforeEach(()=>{state.generation=0;setI18nLang('ru');vi.spyOn(window,'confirm').mockReturnValue(true)})
afterEach(()=>{cleanup();vi.restoreAllMocks()})
it('renders actual assistant-ui cards without automatic tool execution; confirmation sends only the ledger ID',async()=>{
  const accept=vi.fn(async()=>applied)
  render(<TillyActionCards weddingId="w1" messageId="m1" actions={[pending]} accept={accept}/>)
  expect(await screen.findByText('Synthetic task')).toBeTruthy();expect(accept).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:'Подтвердить изменение'}))
  expect((await screen.findByRole('status')).textContent).toBe('Изменение выполнено');expect(accept.mock.calls).toEqual([['a1',expect.any(Function)]]);expect(window.confirm).toHaveBeenCalledTimes(1)
})
it('cancel, foreign recipient and completed states never call the action transport',async()=>{
  const accept=vi.fn(async()=>applied);vi.mocked(window.confirm).mockReturnValue(false)
  const view=render(<TillyActionCards weddingId="w1" messageId="m1" actions={[pending]} accept={accept}/>)
  fireEvent.click(await screen.findByRole('button',{name:'Подтвердить изменение'}));expect(accept).not.toHaveBeenCalled()
  view.rerender(<TillyActionCards weddingId="w1" messageId="m1" actions={[{...pending,canApply:false}]} accept={accept}/>);
  expect(await screen.findByText('Подтвердить может автор запроса.')).toBeTruthy();expect(screen.queryByRole('button')).toBeNull()
  view.rerender(<TillyActionCards weddingId="w1" messageId="m1" actions={[applied]} accept={accept}/>);
  expect(await screen.findByRole('status')).toBeTruthy();expect(accept).not.toHaveBeenCalled()
})
it('blocks double taps, keeps a retry after transport loss and shows committed staleness',async()=>{
  let finish:((value:TillyActionView)=>void)|undefined
  const accept=vi.fn(()=>new Promise<TillyActionView>(resolve=>{finish=resolve}))
  render(<TillyActionCards weddingId="w1" messageId="m1" actions={[pending]} accept={accept}/>)
  const button=await screen.findByRole('button',{name:'Подтвердить изменение'});fireEvent.click(button);fireEvent.click(button);expect(accept).toHaveBeenCalledTimes(1)
  finish!(applied);expect(await screen.findByRole('status')).toBeTruthy();cleanup()
  const retry=vi.fn().mockRejectedValueOnce(new Error('connection lost')).mockRejectedValueOnce(new ApiError('http',409,'tilly_action_stale','Stale'))
  render(<TillyActionCards weddingId="w1" messageId="m2" actions={[pending]} accept={retry}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Подтвердить изменение'}));await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button',{name:'Подтвердить изменение'}));expect(await screen.findByText('Предложение больше не действует')).toBeTruthy();expect(retry).toHaveBeenCalledTimes(2)
})
it('discards late replies across a session A→B→A and a wedding change',async()=>{
  let finish:((value:TillyActionView)=>void)|undefined
  const accept=vi.fn(()=>new Promise<TillyActionView>(resolve=>{finish=resolve}))
  const view=render(<TillyActionCards weddingId="w1" messageId="m1" actions={[pending]} accept={accept}/>)
  fireEvent.click(await screen.findByRole('button',{name:'Подтвердить изменение'}));state.generation+=2
  view.rerender(<TillyActionCards weddingId="w2" messageId="m2" actions={[pending]} accept={accept}/>);finish!(applied)
  await waitFor(()=>expect(screen.queryByRole('status')).toBeNull());expect(await screen.findByRole('button',{name:'Подтвердить изменение'})).toBeTruthy()
})
it('uses the existing English dictionary with the real card runtime',async()=>{
  setI18nLang('en')
  const accept = vi.fn(async () => applied)
  const action: TillyActionView = {
    ...pending,
    kind: 'reschedule_task',
    preview: { currentDue: '2027-05-12', assignee: { name: 'Wedding coordinator' } },
  }
  const view = render(<TillyActionCards weddingId="w1" messageId="m1" actions={[action]} accept={accept} />)
  expect(await screen.findByText('Reschedule task')).toBeTruthy()
  expect(screen.getByText('12 May 2027')).toBeTruthy()
  expect(screen.getByText('2 June 2027')).toBeTruthy()
  expect(screen.getByText('Why it was suggested')).toBeTruthy()
  expect(screen.getByText('Who is affected')).toBeTruthy()
  expect(screen.getByText('Task assignee — Wedding coordinator')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Confirm change' })).toBeTruthy()
  expect(accept).not.toHaveBeenCalled()

  view.rerender(<TillyActionCards weddingId="w1" messageId="m1" actions={[{ ...action, preview: undefined }]} accept={accept} />)
  expect(await screen.findByText('Current due date unavailable')).toBeTruthy()
  expect(screen.queryByText(/Wedding coordinator/)).toBeNull()
  view.rerender(<TillyActionCards weddingId="w1" messageId="m1" actions={[{ ...action, preview: { currentDue: null, assignee: null } }]} accept={accept} />)
  expect(await screen.findByText('No due date')).toBeTruthy()
  expect(accept).not.toHaveBeenCalled()
})
it('retires an already open card at expiry and explains the next step to its author',async()=>{
  const accept=vi.fn(async()=>applied)
  render(<TillyActionCards weddingId="w1" messageId="m1" actions={[{...pending,expiresAt:new Date(Date.now()+200).toISOString()}]} accept={accept}/>);
  expect(await screen.findByRole('button',{name:'Подтвердить изменение'})).toBeTruthy()
  expect(await screen.findByText('Предложение устарело. Попроси Тиля подготовить новое.')).toBeTruthy();expect(screen.queryByRole('button')).toBeNull();expect(accept).not.toHaveBeenCalled()
})
