import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {saveTokens} from './client'
import {addPaymentReceipt,correctPaymentRecord,createPaymentInstallment,deletePaymentReceipt,exportPaymentHistory,getInstallmentEditHistory,getPaymentCorrectionHistory,getPaymentReceipt,getPaymentSchedule,linkPaymentPlan,listPaymentReceipts,payInstallment,updatePaymentInstallment} from './paymentSchedule'
const A='00000000-0000-4000-8000-000000000011',B='00000000-0000-4000-8000-000000000012',S='00000000-0000-4000-8000-000000000013',T='00000000-0000-4000-8000-000000000014'
const token=(sub:string,sid:string,version=1)=>`e30.${btoa(JSON.stringify({sub,sid,exp:2100000000,v:version}))}.unsigned-local-scope-test`
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}})
beforeEach(()=>{localStorage.clear();saveTokens({accessToken:token(A,S),refreshToken:'synthetic-refresh-A'})})
afterEach(()=>{vi.unstubAllGlobals();saveTokens(null)})
const operations={
 correction:()=>correctPaymentRecord('w','p',{version:1,amountKnown:false,amount:null,paidOn:'2026-10-01',paymentMethod:'cash',reason:'Local scope test'},'exact-original-key'),
 stage:()=>updatePaymentInstallment('w','i',{version:1,title:'Local stage test'},'exact-stage-key'),
 paymentHistory:()=>getPaymentCorrectionHistory('w','p'),
 stageHistory:()=>getInstallmentEditHistory('w','i'),
 schedule:()=>getPaymentSchedule('w'),
 create:()=>createPaymentInstallment('w',{dealId:'d',title:'Local stage',due:'2027-01-01',amount:{amount:100000,currency:'RUB'}},'create-key'),
 pay:()=>payInstallment('w','i',{version:1,amountKnown:false,paymentMethod:'cash',visibility:'private'},'pay-key'),
 link:()=>linkPaymentPlan('w','p',{version:1,installmentId:null},'link-key'),
 export:()=>exportPaymentHistory('w'),
 receipts:()=>listPaymentReceipts('w','p'),
 addReceipt:()=>addPaymentReceipt('w','p',{filename:'synthetic.pdf',mimeType:'application/pdf',contentBase64:'c3ludGhldGlj'},'receipt-key'),
 receipt:()=>getPaymentReceipt('w','p','r'),
 deleteReceipt:()=>deletePaymentReceipt('w','p','r'),
}
describe('FR011 local session fence before original401 refresh/retry (no server authorization claim)',()=>{
 for(const [name,operation] of Object.entries(operations)){
  it.each(['account','session','away-back'] as const)(`${name}: observed %s switch forbids old original401 refresh and replay`,async(mode)=>{
   let finish!:(response:Response)=>void
   const fetch=vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve}));vi.stubGlobal('fetch',fetch)
   const pending=operation();expect(fetch).toHaveBeenCalledTimes(1)
   saveTokens({accessToken:token(mode==='session'?A:B,mode==='session'?T:S),refreshToken:'synthetic-refresh-B'})
   if(mode==='away-back')saveTokens({accessToken:token(A,S),refreshToken:'synthetic-refresh-A'})
   finish(json({error:{code:'token_expired',message:'Expired original A'}},401))
   await expect(pending).rejects.toThrow('Аккаунт или сессия изменились')
   expect(fetch).toHaveBeenCalledTimes(1)
  })
 }
 it('same subject/session access-token renewal keeps the current authorized-action scope',async()=>{
  let finish!:(response:Response)=>void
  const fetch=vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve}));vi.stubGlobal('fetch',fetch)
  const pending=operations.correction();saveTokens({accessToken:token(A,S,2),refreshToken:'synthetic-refresh-renewed'})
  finish(json({id:'p',amendmentId:'synthetic'}));await expect(pending).resolves.toMatchObject({id:'p'});expect(fetch).toHaveBeenCalledTimes(1)
 })
})
