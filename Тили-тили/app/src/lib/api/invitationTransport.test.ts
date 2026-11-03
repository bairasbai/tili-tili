import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { beginLocalSessionAction, saveTokens } from './client'
import { publishInvitationDesign, saveInvitationDesign } from './invitationDesign'
const token=(sub:string,sid:string)=>`e30.${btoa(JSON.stringify({sub,sid,exp:2100000000}))}.synthetic-invitation`
const document={schemaVersion:1,content:[{type:'Text',props:{id:'a',heading:'Synthetic',body:'Body'}}]}
beforeEach(()=>{localStorage.clear();saveTokens({accessToken:token('A','S'),refreshToken:'synthetic-A'})})
afterEach(()=>{vi.unstubAllGlobals();saveTokens(null)})
for(const mode of ['account','session','away-back'] as const)it.each(['save','publish'] as const)(`${mode}: old %s never refreshes or retries under another action owner`,async operation=>{
  let finish!:(response:Response)=>void
  const fetch=vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve}));vi.stubGlobal('fetch',fetch)
  const action=beginLocalSessionAction()
  try{
    const pending=operation==='save'?saveInvitationDesign('w1',document,'"invitation-1"',action.assertCurrent):publishInvitationDesign('w1','"invitation-1"',action.assertCurrent)
    expect(fetch).toHaveBeenCalledTimes(1)
    saveTokens({accessToken:token(mode==='session'?'A':'B',mode==='session'?'T':'S'),refreshToken:'synthetic-B'})
    if(mode==='away-back')saveTokens({accessToken:token('A','S'),refreshToken:'synthetic-A'})
    finish(new Response(JSON.stringify({error:{code:'token_expired',message:'Synthetic original token expired'}}),{status:401,headers:{'content-type':'application/json'}}))
    await expect(pending).rejects.toThrow('Аккаунт или сессия изменились');expect(fetch).toHaveBeenCalledTimes(1)
  }finally{action.close()}
})
