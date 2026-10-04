// @vitest-environment jsdom
import { randomUUID } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setI18nLang } from '@/lib/i18n'

// Eventual placement: app/src/lib/c05PushUiAdmission.test.tsx.
// Settings, Store, push/auth helpers and API client are real. Only browser/HTTP adapters are synthetic.
// No PG, provider, physical device, production credentials or candidate helper is exercised/imported.
vi.stubEnv('VITE_API_URL', '/api')
const { Settings } = await import('@/pages/Account')
const { StoreProvider, useStore } = await import('@/lib/store')
const { saveTokens, onSessionChanged, api } = await import('@/lib/api/client')
const SUB_PATH = '/users/me/push-subscriptions', SESSIONS = '/users/me/sessions'
const OFF = 'Push на этом устройстве выключен', CONFLICT = 'Подписки изменились. Повторите действие.'
type Scope = 'single' | 'all'
interface Reply { status?: number; body?: unknown; headers?: Record<string,string>; down?: boolean }
interface Call { method: string; path: string; endpoint: string | null; authorization: string | null; account: string | null; refreshToken: string | null }
interface Later { promise: Promise<Reply>; resolve(reply: Reply): void }
interface Browser { endpoint: string; alive: boolean; failures: number; unsubscribes: number; subscriptions: number }

describe.sequential('independent actual Settings push refusal/retry and logout privacy', () => {
  let user: string, sid: string, otherSid: string, wedding: string, favorite: string, token: string, browser: Browser
  let calls: Call[] = [], events: string[] = [], unexpected: string[] = [], serverDevices = new Map<string,Set<string>>(), credentials = new Map<string,string>()
  let decide: (call:Call)=>Reply|Promise<Reply> = ()=>({status:204}), logout = false
  let refresh: (call:Call)=>Reply|Promise<Reply> = ()=>({status:401,body:{error:{code:'refresh_expired',message:'Synthetic expired refresh'}}})
  let ordinary401 = false
  let logoutHTTP: {completed:boolean;browserAlive:boolean;unsubscribes:number}[] = []
  let persistentTransportWritten = false
  let registration: {active:object;pushManager:{getSubscription():Promise<object|null>;subscribe():Promise<never>}}
  const browserSubscriptions=new Map<Browser,object>()
  const gates = new Set<Later>(), fetches = new Set<Promise<Response>>(), readers = new Set<Promise<unknown>>(), observers = new Set<()=>void>()
  let logSpies: ReturnType<typeof vi.spyOn>[] = []
  function later():Later{
    let release!: (reply:Reply)=>void;const value={promise:new Promise<Reply>(resolve=>{release=resolve}),resolve(reply:Reply){gates.delete(value);release(reply)}}
    gates.add(value);return value
  }
  function credential(revision:number,owner=user,session=sid){
    const encode=(value:object)=>btoa(JSON.stringify(value)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')
    // Unsigned fixture bytes are only local-session metadata and header evidence, never server authentication.
    const value=encode({alg:'none',typ:'JWT'})+'.'+encode({sub:owner,sid:session,exp:Math.floor(Date.now()/1000)+900,fixtureRevision:revision})+'.synthetic';credentials.set(value,owner);return value
  }
  function installSubscription(endpoint='https://push.example.invalid/ephemeral/'+randomUUID()){
    const owned:Browser={endpoint,alive:true,failures:0,unsubscribes:0,subscriptions:0};browser=owned
    const sub={get endpoint(){return owned.endpoint},toJSON(){return{endpoint:owned.endpoint,keys:{p256dh:'synthetic-only',auth:'synthetic-only'}}},
      async unsubscribe(){events.push('browser-unsubscribe');owned.unsubscribes++;if(logout)await Promise.resolve();if(owned.failures>0){owned.failures--;throw new Error('Synthetic browser unsubscribe refusal')};owned.alive=false;events.push('browser-unsubscribe-completed');return true}}
    browserSubscriptions.set(owned,sub);return owned
  }
  function browserAdapter(){
    browserSubscriptions.clear();installSubscription()
    registration={active:{},pushManager:{async getSubscription(){return browser.alive?browserSubscriptions.get(browser)!:null},async subscribe(){browser.subscriptions++;throw new Error('Unexpected subscription creation on a disable/logout path')}}}
    vi.stubGlobal('PushManager',class {})
    vi.stubGlobal('Notification',class { static permission='granted';static async requestPermission(){return'granted'} })
    vi.stubGlobal('navigator',{serviceWorker:{async getRegistration(){return registration},ready:Promise.resolve(registration)}})
  }
  function json(reply:Reply){return new Response(reply.status===204?null:JSON.stringify(reply.body??{}),{status:reply.status??200,headers:{'content-type':'application/json',...reply.headers}})}
  function httpAdapter(){
    vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL,init?:RequestInit)=>{
      const url=new URL(String(input),'https://controlled-ui.example.invalid'),authorization=new Headers(init?.headers).get('authorization'),body=init?.body?JSON.parse(String(init.body)) as {refreshToken?:string}:null
      const call:Call={method:init?.method??'GET',path:url.pathname.replace(/^\/api(?=\/)/,''),endpoint:url.searchParams.get('endpoint'),authorization,account:credentials.get(authorization?.replace(/^Bearer /,'')??'')??null,refreshToken:body?.refreshToken??null}
      if(logout&&((call.path===SUB_PATH&&call.method==='DELETE')||call.path.startsWith(SESSIONS))){
        logoutHTTP.push({completed:events.includes('browser-unsubscribe-completed'),browserAlive:browser.alive,unsubscribes:browser.unsubscribes});events.push('logout-HTTP')
      }
      calls.push(call)
      const pending=(async()=>{
        let reply:Reply
        if(call.path===SUB_PATH&&call.method==='DELETE'){
          events.push(call.endpoint?'HTTP-single-DELETE':'HTTP-all-DELETE');reply=await decide(call)
          if(!reply.down&&(reply.status??200)===204){const devices=serverDevices.get(call.account!);if(call.endpoint)devices?.delete(call.endpoint);else devices?.clear();events.push('HTTP-subscription-204')}
          else if(!reply.down&&reply.status===409)events.push('HTTP-subscription-409')
        }else if(call.path==='/auth/refresh'&&call.method==='POST')reply=await refresh(call)
        else if(logout&&call.path.startsWith(SESSIONS))reply=await decide(call)
        else if(call.method==='GET'&&call.path===SUB_PATH)reply={body:[...(serverDevices.get(call.account!)??[])].map((endpoint,i)=>({id:'synthetic-device-'+i,endpointHost:'push.example.invalid',mine:endpoint===call.endpoint,createdAt:'2026-10-03T12:00:00Z'}))}
        else if(call.method==='GET'&&call.path==='/users/me'&&ordinary401){ordinary401=false;reply={status:401,body:{error:{code:'token_expired',message:'Synthetic ordinary A caller expired'}}}}
        else if(call.method==='GET'&&call.path==='/users/me')reply={body:{id:call.account,name:'Synthetic profile',lang:'ru',tz:'UTC',urgentIncidents:false,push:{tasks:true,chats:true,deals:true,tips:true},quietHours:{from:'00:00',to:'00:00'}}}
        else if(call.method==='GET'&&call.path===SESSIONS)reply={body:sessionRows()}
        else if(call.method==='GET'&&call.path==='/weddings')reply={body:[{id:wedding,title:'Synthetic owned wedding',date:'2027-06-14',role:'couple'}]}
        else if(call.method==='GET'&&call.path===`/weddings/${wedding}`)reply={body:{id:wedding,title:'Synthetic owned wedding',date:'2027-06-14',tz:'UTC',members:[{role:'couple',user:{id:user,name:'Synthetic profile'}}]}}
        else if(call.method==='GET'&&call.path===`/weddings/${wedding}/slots`)reply={body:[]}
        else if(call.method==='GET'&&call.path===`/weddings/${wedding}/attention`)reply={body:{version:'1',mode:'essential',effectiveMode:'essential',coordinatorUserId:null,coordinatorState:'not_selected',coordinator:null},headers:{etag:'"1"'}}
        else if(call.method==='GET'&&call.path==='/me/favorites')reply={body:[{id:favorite,name:'Synthetic favorite'}]}
        else{unexpected.push(call.method+' '+call.path);throw new Error('Unadmitted controlled HTTP path without transport query')}
        if(reply.down)throw new TypeError('Synthetic controlled network refusal')
        return json(reply)
      })()
      fetches.add(pending);void pending.then(()=>fetches.delete(pending),()=>fetches.delete(pending));return pending
    }))
  }
  function sessionRows(){return[{id:otherSid,device:'Synthetic other device',current:false},{id:sid,device:'Synthetic current device',current:true}]}
  function MemoryWitness(){const s=useStore();return<output data-testid="session-memory">{JSON.stringify({wedding:s.weddingId,date:s.weddingDate,onboarded:s.onboarded,favorites:s.favorites,quizBudget:s.quiz.budget,slotsState:s.slotsState,weddingsState:s.weddingsState})}</output>}
  function memory(){return JSON.parse(screen.getByTestId('session-memory').textContent!) as {wedding:string|null;date:string|null;onboarded:boolean;favorites:string[];quizBudget:string|null;slotsState:string;weddingsState:string}}
  async function view(){
    render(<MemoryRouter initialEntries={['/settings']}><StoreProvider><MemoryWitness/><Routes><Route path="/settings" element={<Settings/>}/><Route path="/auth" element={<p>Independent auth destination</p>}/></Routes></StoreProvider></MemoryRouter>)
    await screen.findByRole('button',{name:'Push на этом устройстве'})
    await waitFor(()=>{expect(memory().wedding===wedding).toBe(true);expect(memory().favorites.includes(favorite)).toBe(true);expect(memory().slotsState).toBe('ready');expect(memory().weddingsState).toBe('ready')})
    expect(browser.alive).toBe(true);expect(oldText()).toBeTruthy()
  }
  const toggle=()=>screen.getByRole('button',{name:'Push на этом устройстве'}) as HTMLButtonElement
  const oldText=()=>screen.getByText(/^В браузере подписка есть/).textContent
  const deletes=()=>calls.filter(c=>c.method==='DELETE'&&c.path===SUB_PATH)
  function click(scope:Scope){if(scope==='single')fireEvent.click(toggle());else{fireEvent.click(screen.getByRole('button',{name:'Снять push на всех устройствах'}));fireEvent.click(screen.getByRole('button',{name:'Снять на всех устройствах?'}))}}
  function expectTransport(call:Call,scope:Scope,current:string){expect(call.path===SUB_PATH&&call.method==='DELETE').toBe(true);expect(scope==='single'?call.endpoint===browser.endpoint:call.endpoint===null).toBe(true);expect(call.authorization==='Bearer '+current).toBe(true)}
  async function respond(gate:Later,reply:Reply){await act(async()=>{gate.resolve(reply)});await waitFor(()=>expect(toggle().disabled).toBe(false))}
  function privateTransportAbsent(){
    expect(persistentTransportWritten).toBe(false)
    const values=[localStorage,sessionStorage].flatMap(storage=>Array.from({length:storage.length},(_,i)=>storage.getItem(storage.key(i)!)))
    for(const owned of browserSubscriptions.keys()){
      expect(values.some(value=>value?.includes(owned.endpoint))).toBe(false)
      expect(document.body.textContent?.includes(owned.endpoint)??false).toBe(false)
      const contains=(value:unknown,seen=new Set<object>()):boolean=>{
        try{if(String(value).includes(owned.endpoint))return true}catch{/* Unprintable values still get the object traversal below. */}
        if(value&&typeof value==='object'&&!seen.has(value)){seen.add(value);return Object.values(value).some(child=>contains(child,seen))}return false
      }
      expect(logSpies.some(spy=>spy.mock.calls.some((args:unknown[])=>args.some(value=>contains(value))))).toBe(false)
    }
  }
  beforeEach(()=>{
    localStorage.clear();sessionStorage.clear();vi.stubEnv('VITE_API_URL','/api');vi.stubEnv('VITE_VAPID_PUBLIC_KEY','AQID');setI18nLang('ru')
    user=randomUUID();sid=randomUUID();otherSid=randomUUID();wedding=randomUUID();favorite=randomUUID();credentials=new Map();token=credential(1);calls=[];events=[];unexpected=[];serverDevices=new Map();logout=false;ordinary401=false;logoutHTTP=[];persistentTransportWritten=false;decide=()=>({status:204});refresh=()=>({status:401,body:{error:{code:'refresh_expired',message:'Synthetic expired refresh'}}})
    localStorage.setItem('tt_onboarded','1');localStorage.setItem('tt_wedding_id',JSON.stringify(wedding));localStorage.setItem('tt_wedding_date',JSON.stringify('2027-06-14'));localStorage.setItem('tt_fav',JSON.stringify([favorite]))
    localStorage.setItem('tt_quiz',JSON.stringify({date:'2027-06-14',guests:null,budget:'Synthetic private budget',format:null,style:null,planner:null,booked:[]}))
    for(const[k,v]of[['tt_theme','dark'],['tt_lang','ru'],['tt_city','Synthetic city'],['tt_city_region','Synthetic region']])localStorage.setItem(k,v)
    saveTokens({accessToken:token,refreshToken:'synthetic-refresh'});browserAdapter();serverDevices.set(user,new Set([browser.endpoint,'synthetic-other-device']));httpAdapter()
    for(const prototype of new Set([Object.getPrototypeOf(localStorage),Object.getPrototypeOf(sessionStorage)] as Storage[])){
      const setItem=prototype.setItem
      vi.spyOn(prototype,'setItem').mockImplementation(function(this:Storage,key:string,value:string){
        if([...browserSubscriptions.keys()].some(owned=>String(key).includes(owned.endpoint)||String(value).includes(owned.endpoint)))persistentTransportWritten=true
        return setItem.call(this,key,value)
      })
    }
    logSpies=['log','info','warn','error','debug'].map(method=>vi.spyOn(console,method as 'log').mockImplementation(()=>{}))
  })
  afterEach(async()=>{
    try{
      await act(async()=>{for(const gate of [...gates])gate.resolve({status:503,body:{error:{code:'controlled_cleanup',message:'Synthetic test cleanup'}}});await Promise.allSettled([...fetches,...readers])})
      cleanup();expect(fetches.size).toBe(0);expect(readers.size).toBe(0);expect(gates.size).toBe(0);expect(unexpected).toEqual([]);privateTransportAbsent()
    }finally{for(const stop of observers)stop();observers.clear();cleanup();localStorage.clear();sessionStorage.clear();vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();setI18nLang('ru')}
  })

  it('single named409 keeps browser/UI and user retry repeats exact endpoint with current authorization, then204 unsubscribes/off',async()=>{
    const first=later(),second=later();let n=0;decide=call=>call.endpoint?(++n===1?first.promise:second.promise):{status:204}
    await view();const before=oldText();click('single');await waitFor(()=>expect(deletes().length).toBe(1))
    expectTransport(deletes()[0]!,'single',token);expect(browser.alive).toBe(true);expect(browser.unsubscribes).toBe(0)
    await respond(first,{status:409,body:{error:{code:'push_subscription_scope_changed',message:CONFLICT}}})
    expect(screen.getByRole('alert').textContent===CONFLICT).toBe(true);expect(oldText()===before).toBe(true);expect(browser.alive).toBe(true);expect(deletes().length).toBe(1)
    token=credential(2);await act(async()=>saveTokens({accessToken:token,refreshToken:'synthetic-refresh-2'}));click('single');await waitFor(()=>expect(deletes().length).toBe(2))
    expectTransport(deletes()[1]!,'single',token);expect(browser.alive).toBe(true)
    await respond(second,{status:204});expect(screen.getByText(OFF)).toBeTruthy();expect(browser.alive).toBe(false);expect(browser.unsubscribes).toBe(1);expect(browser.subscriptions).toBe(0)
    expect(events.filter(e=>e==='HTTP-subscription-409'||e==='HTTP-subscription-204'||e==='browser-unsubscribe')).toEqual(['HTTP-subscription-409','HTTP-subscription-204','browser-unsubscribe'])
  })
  it('DELETE-all named409 preserves browser and confirmed retry; global204 then unsubscribes/off without per-endpoint DELETE',async()=>{
    const first=later(),second=later();let n=0;decide=call=>call.endpoint?{status:204}:(++n===1?first.promise:second.promise)
    await view();const before=oldText();click('all');await waitFor(()=>expect(deletes().filter(c=>c.endpoint===null).length).toBe(1))
    expect(deletes().map(c=>c.endpoint!==null)).toEqual([false]);expectTransport(deletes()[0]!,'all',token);expect(browser.alive).toBe(true);expect(browser.unsubscribes).toBe(0)
    await respond(first,{status:409,body:{error:{code:'push_subscription_scope_changed',message:CONFLICT}}})
    expect(screen.getByRole('alert').textContent===CONFLICT).toBe(true);expect(oldText()===before).toBe(true);expect(browser.alive).toBe(true)
    token=credential(2);await act(async()=>saveTokens({accessToken:token,refreshToken:'synthetic-refresh-2'}));click('all');await waitFor(()=>expect(deletes().length).toBe(2));expectTransport(deletes()[1]!,'all',token)
    await respond(second,{status:204});expect(screen.getByText(OFF)).toBeTruthy();expect(browser.alive).toBe(false);expect(serverDevices.get(user)?.size).toBe(0);expect(browser.unsubscribes).toBe(1);expect(browser.subscriptions).toBe(0)
    expect(deletes().map(c=>c.endpoint!==null)).toEqual([false,false]);expect(events.filter(e=>e==='HTTP-subscription-409'||e==='HTTP-subscription-204'||e==='browser-unsubscribe')).toEqual(['HTTP-subscription-409','HTTP-subscription-204','browser-unsubscribe'])
  })
  it.each(['single','all'] as const)('%s server204 then local unsubscribe rejection keeps truthful old state and supports another204 retry',async scope=>{
    const first=later(),second=later();let n=0;decide=call=>scope==='all'&&call.endpoint?{status:204}:(++n===1?first.promise:second.promise);await view();const before=oldText();browser.failures=1
    click(scope);await waitFor(()=>expect(deletes().filter(c=>scope==='single'?c.endpoint!==null:c.endpoint===null).length).toBe(1));expectTransport(deletes().find(c=>scope==='single'?c.endpoint!==null:c.endpoint===null)!,scope,token);await respond(first,{status:204})
    expect(browser.alive).toBe(true);expect(screen.queryByText(OFF)).toBeNull();expect(oldText()===before).toBe(true);expect(screen.queryByRole('alert')).not.toBeNull()
    click(scope);await waitFor(()=>expect(deletes().length).toBe(2));expectTransport(deletes()[1]!,scope,token);await respond(second,{status:204})
    expect(screen.getByText(OFF)).toBeTruthy();expect(browser.alive).toBe(false);expect(browser.unsubscribes).toBe(2);expect(browser.subscriptions).toBe(0)
    expect(events.filter(e=>e==='HTTP-subscription-204'||e==='browser-unsubscribe')).toEqual(['HTTP-subscription-204','browser-unsubscribe','HTTP-subscription-204','browser-unsubscribe'])
  })
  for(const change of ['A-to-B','A-to-B-to-A','same-A-renewal'] as const)it.each(['single','all'] as const)(`${change}: %s old204 cannot remove a changed browser generation or falsely turn its UI off`,async scope=>{
    const pending=later();decide=call=>scope==='all'&&call.endpoint?{status:204}:pending.promise
    await view();let scopeEvents=0;const stop=onSessionChanged(()=>{scopeEvents++});observers.add(stop)
    const initial={user,sid,token,endpoint:browser.endpoint},old=browser,before=oldText();click(scope)
    await waitFor(()=>expect(deletes().filter(c=>scope==='single'?c.endpoint!==null:c.endpoint===null).length).toBe(1))
    const sent=deletes().find(c=>scope==='single'?c.endpoint!==null:c.endpoint===null)!;expectTransport(sent,scope,initial.token)
    let installed=old,intermediate:Browser|undefined
    if(change==='same-A-renewal'){
      token=credential(2);await act(async()=>saveTokens({accessToken:token,refreshToken:'synthetic-renewed-A'}))
    }else{
      user=randomUUID();sid=randomUUID();token=credential(2)
      await act(async()=>{saveTokens({accessToken:token,refreshToken:'synthetic-B'});intermediate=installSubscription();serverDevices.set(user,new Set([intermediate.endpoint,'synthetic-B-other-device']))});installed=intermediate!
      if(change==='A-to-B-to-A'){
        user=initial.user;sid=initial.sid;token=initial.token
        await act(async()=>{saveTokens({accessToken:token,refreshToken:'synthetic-refresh'});installed=installSubscription(initial.endpoint)})
      }
    }
    expect(scopeEvents).toBe(change==='same-A-renewal'?0:change==='A-to-B'?1:2)
    // Exactly these observed local events define the sticky fixture; no universal unobserved ABA claim.
    await respond(pending,{status:204})
    const stored=JSON.parse(localStorage.getItem('tt_auth')!) as {accessToken:string}
    expect(stored.accessToken===token).toBe(true)
    expect(deletes().filter(c=>c.authorization!==('Bearer '+initial.token)).length).toBe(0)
    if(change==='same-A-renewal'){expect(screen.getByText(OFF)).toBeTruthy();expect(old.alive).toBe(false);expect(old.unsubscribes).toBe(1)}
    else{expect(installed.alive).toBe(true);expect(installed.unsubscribes).toBe(0);expect(intermediate!.unsubscribes).toBe(0);expect(screen.queryByText(OFF)).toBeNull();expect(oldText()===before).toBe(true)}
    expect(browser.subscriptions).toBe(0)
  })
  for(const initiator of ['Settings-starts','ordinary-caller-shared'] as const)for(const outcome of ['expired401','old-A-success200'] as const)it.each(['single','all'] as const)(`existing API client ${initiator}/${outcome}: %s delayed A refresh cannot resend DELETE as B or overwrite B credentials`,async scope=>{
    const unauthorized=later(),refreshReply=later();let targetCount=0
    decide=call=>scope==='all'&&call.endpoint?{status:204}:(++targetCount===1?unauthorized.promise:{status:204});refresh=()=>refreshReply.promise
    await view();const initial={user,sid,token}
    if(initiator==='ordinary-caller-shared'){
      ordinary401=true;const reader=api.get('/users/me');readers.add(reader);void reader.then(()=>readers.delete(reader),()=>readers.delete(reader))
      await waitFor(()=>expect(calls.filter(c=>c.path==='/auth/refresh').length).toBe(1))
    }
    click(scope)
    await waitFor(()=>expect(deletes().filter(c=>scope==='single'?c.endpoint!==null:c.endpoint===null).length).toBe(1))
    await act(async()=>unauthorized.resolve({status:401,body:{error:{code:'token_expired',message:'Synthetic A token expired'}}}))
    await waitFor(()=>expect(calls.filter(c=>c.path==='/auth/refresh').length).toBe(1))
    const exchanged=calls.find(c=>c.path==='/auth/refresh')!;expect(exchanged.refreshToken==='synthetic-refresh').toBe(true);expect(exchanged.authorization).toBeNull()
    user=randomUUID();sid=randomUUID();token=credential(2);let current!:Browser
    await act(async()=>{saveTokens({accessToken:token,refreshToken:'synthetic-B'});current=installSubscription();serverDevices.set(user,new Set([current.endpoint,'synthetic-B-other-device']))})
    const oldSuccess=credential(3,initial.user,initial.sid)
    await respond(refreshReply,outcome==='expired401'?{status:401,body:{error:{code:'refresh_expired',message:'Synthetic old A refresh expired'}}}:{body:{accessToken:oldSuccess,refreshToken:'synthetic-old-A-next'}})
    await Promise.allSettled([...readers]);expect(calls.filter(c=>c.path==='/auth/refresh').length).toBe(1)
    expect(deletes().filter(c=>c.authorization!==('Bearer '+initial.token)).length).toBe(0)
    expect(deletes().filter(c=>scope==='single'?c.endpoint!==null:c.endpoint===null).length).toBe(1)
    const stored=JSON.parse(localStorage.getItem('tt_auth')!) as {accessToken:string;refreshToken:string}
    expect(stored.accessToken===token&&stored.refreshToken==='synthetic-B').toBe(true);expect(current.alive).toBe(true);expect(current.unsubscribes).toBe(0);expect(screen.queryByText(OFF)).toBeNull()
    // These assertions expose the existing generic refresh boundary separately from new UI refusal semantics.
  })
  for(const scope of ['here','everywhere'] as const)for(const down of ['push','session'] as const)it(`${scope} logout with ${down} network refusal still removes browser push and cleans actual local/store session`,async()=>{
    await view();const start=calls.length;logout=true;events=[]
    decide=call=>{
      if(call.path===SUB_PATH)return down==='push'?{down:true}:{status:204}
      if(down==='session')return{down:true}
      if(call.method==='GET'&&call.path===SESSIONS)return{body:sessionRows()}
      return{status:204}
    }
    fireEvent.click(screen.getByRole('button',{name:scope==='here'?'Выйти только с этого устройства':'Выйти со всех устройств'}))
    await screen.findByText('Independent auth destination');await waitFor(()=>expect(memory()).toEqual({wedding:null,date:null,onboarded:false,favorites:[],quizBudget:null,slotsState:'idle',weddingsState:'idle'}))
    expect(browser.alive).toBe(false);expect(browser.unsubscribes).toBe(1);expect(browser.subscriptions).toBe(0);expect(localStorage.getItem('tt_auth')).toBeNull()
    for(const key of ['tt_wedding_id','tt_wedding_date','tt_quiz','tt_fav','tt_onboarded'])expect(localStorage.getItem(key)).toBeNull()
    for(const[k,v]of[['tt_theme','dark'],['tt_lang','ru'],['tt_city','Synthetic city'],['tt_city_region','Synthetic region']])expect(localStorage.getItem(k)).toBe(v)
    const actions=calls.slice(start),pushDeletes=actions.filter(c=>c.path===SUB_PATH&&c.method==='DELETE');expect(pushDeletes.length).toBe(1);expectTransport(pushDeletes[0]!,'single',token)
    const sessionCalls=actions.filter(c=>c.path.startsWith(SESSIONS)).map(c=>c.method+' '+(c.path===SESSIONS?'collection':c.path===SESSIONS+'/'+sid?'current':c.path===SESSIONS+'/'+otherSid?'other':'unknown'))
    expect(sessionCalls).toEqual(down==='session'?(scope==='here'?['GET collection']:['DELETE collection']):(scope==='here'?['GET collection','DELETE current']:['DELETE collection','GET collection','DELETE current']))
    expect(actions.every(c=>c.authorization==='Bearer '+token)).toBe(true)
    expect(logoutHTTP.length).toBe(pushDeletes.length+sessionCalls.length);expect(logoutHTTP.length).toBeGreaterThan(0)
    expect(logoutHTTP[0]).toEqual({completed:true,browserAlive:false,unsubscribes:1});expect(logoutHTTP.every(call=>call.completed&&!call.browserAlive&&call.unsubscribes===1)).toBe(true)
    const completed=events.indexOf('browser-unsubscribe-completed'),firstHTTP=events.indexOf('logout-HTTP');expect(completed>=0&&firstHTTP>completed).toBe(true)
    // Completion is asynchronously observed before every actual push/session fetch, including network refusal.
    // The network-refused seam does not prove server session revocation or physical push delivery.
  })
})
