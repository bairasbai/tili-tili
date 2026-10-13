// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react'
import {MemoryRouter} from 'react-router'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import App from '@/App'
import {appRoot,getI18nLang,reloadToRootWithLanguage,setI18nLang} from '@/lib/i18n'

const replies:Array<(response:Response)=>void>=[]
let previewEntry:HTMLScriptElement|undefined
beforeEach(()=>{localStorage.clear();sessionStorage.clear();setI18nLang('ru');vi.spyOn(navigator,'onLine','get').mockReturnValue(true)})
afterEach(async()=>{
 cleanup();await act(async()=>{for(const reply of replies.splice(0))reply(new Response(JSON.stringify({status:'ok'}),{headers:{'content-type':'application/json'}}));await Promise.resolve()})
 previewEntry?.remove();previewEntry=undefined
 vi.unstubAllGlobals();vi.restoreAllMocks();setI18nLang('ru')
})

function navigation(pathname='/auth',search='?onboarding=1',hash='#intro'){
 const replace=vi.fn()
 vi.stubGlobal('location',{pathname,search,hash,href:'http://localhost'+pathname+search+hash,replace})
 return replace
}

it('deliberate language reload keeps departing document unchanged and next App mount reads the preference',()=>{
 const calls:string[]=[]
 vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL)=>{
  const path=new URL(String(input),'http://localhost').pathname;calls.push(path)
  expect(path).toBe('/api/health');return new Promise<Response>(resolve=>replies.push(resolve))
 }))
 render(<MemoryRouter initialEntries={['/']}><App/></MemoryRouter>)
 fireEvent.click(screen.getByRole('button',{name:/Далее/}))
 expect(screen.getByRole('heading',{name:'Один день'})).toBeTruthy()
 const originalLocation=location,replace=navigation('/')
 fireEvent.click(screen.getByRole('button',{name:'EN'}))
 expect(replace).toHaveBeenCalledExactlyOnceWith(appRoot())
 expect(localStorage.getItem('tt_lang')).toBe('en')
 expect(sessionStorage.getItem('tt_redirect')).toBe('/?onboarding=1#intro')
 expect(getI18nLang(),'departing document must not translate before navigation').toBe('ru')
 expect(document.documentElement.lang).toBe('ru')
 expect(screen.getByRole('heading',{name:'Один день'})).toBeTruthy()
 expect(screen.getByRole('button',{name:'EN'})).toBeTruthy()
 expect(calls).toEqual(['/api/health'])
 cleanup();vi.stubGlobal('location',originalLocation)
 render(<MemoryRouter initialEntries={['/']}><App/></MemoryRouter>)
 expect(getI18nLang()).toBe('en');expect(document.documentElement.lang).toBe('en')
 expect(screen.getByRole('heading',{name:'All vendors'})).toBeTruthy()
 expect(screen.getByRole('button',{name:'RU'})).toBeTruthy()
 expect(calls).toEqual(['/api/health','/api/health'])
})

it.each(['ru','en'] as const)('persists %s without changing current module language and preserves the full redirect',language=>{
 const before=language==='ru'?'en':'ru';setI18nLang(before)
 const replace=navigation('/offers/42','?tab=quotes&sort=new','#terms')
 reloadToRootWithLanguage(language)
 expect(localStorage.getItem('tt_lang')).toBe(language);expect(getI18nLang()).toBe(before)
 expect(sessionStorage.getItem('tt_redirect')).toBe('/offers/42?tab=quotes&sort=new#terms')
 expect(replace).toHaveBeenCalledExactlyOnceWith(appRoot())
})

it('blocked preference storage retains the actual language and still attempts the existing reload',()=>{
 localStorage.setItem('tt_lang','ru')
 const proto=Object.getPrototypeOf(localStorage) as Storage,write=proto.setItem
 vi.spyOn(proto,'setItem').mockImplementation(function(this:Storage,key:string,value:string){
  if(this===localStorage&&key==='tt_lang')throw new DOMException('Blocked test preference','SecurityError')
  return write.call(this,key,value)
 })
 const replace=navigation();expect(()=>reloadToRootWithLanguage('en')).not.toThrow()
 expect(localStorage.getItem('tt_lang')).toBe('ru');expect(getI18nLang()).toBe('ru')
 expect(sessionStorage.getItem('tt_redirect')).toBe('/auth?onboarding=1#intro')
 expect(replace).toHaveBeenCalledExactlyOnceWith(appRoot())
})

it('blocked redirect storage retains the previous value and still reloads after persisting the language',()=>{
 sessionStorage.setItem('tt_redirect','/previous')
 const proto=Object.getPrototypeOf(sessionStorage) as Storage,write=proto.setItem
 vi.spyOn(proto,'setItem').mockImplementation(function(this:Storage,key:string,value:string){
  if(this===sessionStorage&&key==='tt_redirect')throw new DOMException('Blocked test redirect','SecurityError')
  return write.call(this,key,value)
 })
 const replace=navigation();expect(()=>reloadToRootWithLanguage('en')).not.toThrow()
 expect(localStorage.getItem('tt_lang')).toBe('en');expect(getI18nLang()).toBe('ru')
 expect(sessionStorage.getItem('tt_redirect')).toBe('/previous')
 expect(replace).toHaveBeenCalledExactlyOnceWith(appRoot())
})

it('a fresh module reads stored language and keeps the existing preview app root calculation',async()=>{
 localStorage.setItem('tt_lang','en');const replace=navigation()
 previewEntry=document.createElement('script');previewEntry.type='module';previewEntry.src='/preview/app/assets/main.js';document.head.append(previewEntry)
 vi.resetModules();const fresh=await import('@/lib/i18n')
 expect(fresh.getI18nLang()).toBe('en');expect(fresh.appRoot()).toBe('/preview/app/')
 fresh.reloadToRootWithLanguage('ru')
 expect(fresh.getI18nLang()).toBe('en');expect(localStorage.getItem('tt_lang')).toBe('ru')
 expect(sessionStorage.getItem('tt_redirect')).toBe('/auth?onboarding=1#intro')
 expect(replace).toHaveBeenCalledExactlyOnceWith('/preview/app/')
})

it('navigation failure retains the existing thrown error after persisting the requested language',()=>{
 const replace=navigation(),failure=new Error('Owned navigation refusal')
 replace.mockImplementation(()=>{throw failure})
 expect(()=>reloadToRootWithLanguage('en')).toThrow(failure)
 expect(localStorage.getItem('tt_lang')).toBe('en');expect(getI18nLang()).toBe('ru')
})
