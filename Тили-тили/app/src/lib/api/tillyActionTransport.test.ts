import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { beginLocalSessionAction, saveTokens } from './client'
import { acceptTillyAction } from './tillyActions'
const token=(sub:string,sid:string)=>`e30.${btoa(JSON.stringify({sub,sid,exp:2100000000}))}.synthetic-031`
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}})
beforeEach(()=>{localStorage.clear();saveTokens({accessToken:token('A','S'),refreshToken:'synthetic-A'})})
afterEach(()=>{vi.unstubAllGlobals();saveTokens(null)})
it.each(['account','session','away-back'] as const)('never refreshes/replays an old action after observed %s change',async mode=>{
  let finish!:(response:Response)=>void
  const fetch=vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve}));vi.stubGlobal('fetch',fetch)
  const action=beginLocalSessionAction()
  try{
    const pending=acceptTillyAction('w1','a1',action.assertCurrent);expect(fetch).toHaveBeenCalledTimes(1)
    saveTokens({accessToken:token(mode==='session'?'A':'B',mode==='session'?'T':'S'),refreshToken:'synthetic-B'})
    if(mode==='away-back')saveTokens({accessToken:token('A','S'),refreshToken:'synthetic-A'})
    finish(json({error:{code:'token_expired',message:'Synthetic expired original request'}},401))
    await expect(pending).rejects.toThrow('Аккаунт или сессия изменились');expect(fetch).toHaveBeenCalledTimes(1)
  }finally{action.close()}
})
it('sends no model payload and accepts only a matching committed receipt',async()=>{
  const fetch=vi.fn<(input:RequestInfo|URL,init?:RequestInit)=>Promise<Response>>(async()=>json({id:'a1',state:'applied',canApply:false,result:{taskId:'t1'}}));vi.stubGlobal('fetch',fetch)
  const action=beginLocalSessionAction()
  try{expect(await acceptTillyAction('chat-wedding','a1',action.assertCurrent)).toMatchObject({id:'a1',state:'applied'});expect(String(fetch.mock.calls[0]![0])).toContain('/weddings/chat-wedding/tilly/actions/a1/accept');expect((fetch.mock.calls[0]![1] as RequestInit).body).toBe('{}')
    fetch.mockImplementation(async()=>json({id:'other',state:'applied',canApply:false,result:{taskId:'t1'}}));await expect(acceptTillyAction('chat-wedding','a1',action.assertCurrent)).rejects.toMatchObject({code:'invalid_response'})
  }finally{action.close()}
})
