import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InvitationBlocks } from '@/components/InvitationBlocks'
import { InvitationDesigner } from '@/components/InvitationDesigner'
import { ApiError } from './api/client'
import { parseInvitationDesign } from './invitationDesign'
import { setI18nLang } from './i18n'

const state = vi.hoisted(() => ({ generation:0, version:0, saved:[] as unknown[], publications:0, conflict:false, finish:null as (()=>void)|null, delayed:false,
  draft:{schemaVersion:1,content:[{type:'Text',props:{id:'one',heading:'Heading',body:'Saved'}}]}, published:null as unknown }))
vi.mock('./api/invitationDesign', () => {
  const snapshot=()=>({data:{draft:structuredClone(state.draft),published:structuredClone(state.published),version:String(state.version),publishedAt:null},etag:`"invitation-${state.version}"`,headers:new Headers()})
  return {
    getInvitationDesign:async()=>snapshot(),
    saveInvitationDesign:async(_id:string,draft:typeof state.draft)=>{state.saved.push(draft);if(state.delayed)await new Promise<void>(resolve=>{state.finish=resolve});if(state.conflict)throw new ApiError('http',409,'invitation_conflict','Conflict');state.draft=structuredClone(draft);state.version++;return snapshot()},
    publishInvitationDesign:async()=>{state.publications++;state.published=structuredClone(state.draft);state.version++;return snapshot()},
  }
})
vi.mock('./useLegacyActionScope',()=>({ useLegacySessionKey:()=>String(state.generation),useLegacyActionScope:()=>()=>{const generation=state.generation;return{isCurrent:()=>generation===state.generation,assertCurrent:()=>undefined}} }))
vi.mock('@/components/InvitationPuckEditor',()=>({default:({design,onChange,disabled,onPhotoPending}:{design:typeof state.draft;onChange:(value:typeof state.draft)=>void;disabled:boolean;onPhotoPending:(id:string,pending:boolean)=>void})=><><button disabled={disabled} onClick={()=>onChange({...design,content:[{type:'Text',props:{id:'one',heading:'Changed',body:'Unsaved draft'}}]})}>Edit fixture</button><button onClick={()=>onPhotoPending('photo',true)}>Start photo</button><button onClick={()=>onPhotoPending('photo',false)}>Finish photo</button></>}))
beforeEach(()=>{state.generation=0;state.version=1;state.saved=[];state.publications=0;state.conflict=false;state.delayed=false;state.finish=null;state.draft={schemaVersion:1,content:[{type:'Text',props:{id:'one',heading:'Heading',body:'Saved'}}]};state.published=null;setI18nLang('ru')})
afterEach(()=>{cleanup();vi.restoreAllMocks()})

it('renders markup as text, local photos and a fixed map host only',()=>{
  const document={schemaVersion:1,content:[{type:'Text',props:{id:'a',heading:'<script>alert(1)</script>',body:'<img src=x onerror=alert(2)>'}},{type:'Place',props:{id:'b',name:'Venue',address:'javascript:alert(3)'}}]}
  const view=render(<InvitationBlocks design={document}/>);
  expect(view.container.querySelector('script')).toBeNull();expect(view.container.querySelector('img')).toBeNull()
  expect(view.container.textContent).toContain('<script>alert(1)</script>')
  expect(new URL(screen.getByRole('link').getAttribute('href')!).hostname).toBe('yandex.ru')
  expect(()=>parseInvitationDesign({schemaVersion:1,content:[{type:'Photo',props:{id:'x',image:'https://evil.invalid/pixel',caption:'x'}}]})).toThrow()
})
it('requires saving changes before publication and publishes only explicitly',async()=>{
  render(<InvitationDesigner weddingId="w1" legacyText="Legacy" canEdit/>);
  fireEvent.click(await screen.findByRole('button',{name:'Открыть редактор'}));fireEvent.click(await screen.findByRole('button',{name:'Edit fixture'}))
  expect((screen.getByRole('button',{name:'Опубликовать приглашение'}) as HTMLButtonElement).disabled).toBe(true)
  expect(state.publications).toBe(0)
  fireEvent.click(screen.getByRole('button',{name:'Сохранить черновик'}));await waitFor(()=>expect(state.saved).toHaveLength(1));
  await waitFor(()=>expect((screen.getByRole('button',{name:'Опубликовать приглашение'}) as HTMLButtonElement).disabled).toBe(false))
  expect(state.published).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Опубликовать приглашение'}));await waitFor(()=>expect(state.publications).toBe(1))
  await waitFor(()=>expect(screen.getByText('Unsaved draft')).toBeTruthy())
})
it('retains the local draft on conflict and never silently retries a stale version',async()=>{
  state.conflict=true;render(<InvitationDesigner weddingId="w1" legacyText="Legacy" canEdit/>);
  fireEvent.click(await screen.findByRole('button',{name:'Открыть редактор'}));fireEvent.click(await screen.findByRole('button',{name:'Edit fixture'}));fireEvent.click(screen.getByRole('button',{name:'Сохранить черновик'}))
  await screen.findByRole('alert');expect(state.saved).toHaveLength(1);expect(state.publications).toBe(0)
  expect(screen.getByText(/Твой черновик сохранён/)).toBeTruthy()
  expect((screen.getByRole('button',{name:'Сохранить черновик'}) as HTMLButtonElement).disabled).toBe(true)
  vi.spyOn(window,'confirm').mockReturnValue(false);fireEvent.click(screen.getByRole('button',{name:'Обновить'}));expect(screen.getByRole('alert')).toBeTruthy()
})
it('blocks duplicate saves and discards an old-session result after A→B→A',async()=>{
  state.delayed=true;const view=render(<InvitationDesigner weddingId="w1" legacyText="Legacy" canEdit/>);
  fireEvent.click(await screen.findByRole('button',{name:'Открыть редактор'}));fireEvent.click(await screen.findByRole('button',{name:'Edit fixture'}));
  fireEvent.click(screen.getByRole('button',{name:'Сохранить черновик'}));fireEvent.click(screen.getByRole('button',{name:'Сохраняем…'}));await waitFor(()=>expect(state.saved).toHaveLength(1))
  state.generation=2;view.rerender(<InvitationDesigner weddingId="w1" legacyText="Legacy" canEdit/>);state.finish!()
  await screen.findByRole('button',{name:'Открыть редактор'});expect(screen.queryByText('Unsaved draft')).toBeNull();expect(state.publications).toBe(0)
})
it('shows helper read-only view and English control labels',async()=>{
  setI18nLang('en');render(<InvitationDesigner weddingId="w1" legacyText="Legacy" canEdit={false}/>);
  await screen.findByText('Guests still see the previous design');expect(screen.queryByRole('button',{name:'Open editor'})).toBeNull();expect(state.saved).toHaveLength(0)
})
it('blocks saving and publishing while a selected photo is still decoding',async()=>{
  render(<InvitationDesigner weddingId="w1" legacyText="Legacy" canEdit/>);
  fireEvent.click(await screen.findByRole('button',{name:'Открыть редактор'}));fireEvent.click(await screen.findByRole('button',{name:'Start photo'}))
  const publish=screen.getByRole('button',{name:'Опубликовать приглашение'}) as HTMLButtonElement
  expect(publish.disabled).toBe(true);expect((screen.getByRole('button',{name:'Сохранить черновик'}) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(publish);expect(state.publications).toBe(0);expect(state.saved).toHaveLength(0)
  fireEvent.click(screen.getByRole('button',{name:'Finish photo'}));expect(publish.disabled).toBe(false)
})
