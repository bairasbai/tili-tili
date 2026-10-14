"""ROOT-owned compiled Onboarding observation. SOURCE ONLY author runtime UNRUN.

No transport/interception, JWT, OTP, account, fake animation or native authority.
Collection remains unqualified; actual failures and original captures are retained.
"""
import asyncio
import base64
import contextvars
import copy
import hashlib
import json
import math
import os
import pathlib
import re
import struct
import time
import types
import uuid
from urllib.parse import urlsplit
from playwright.async_api import async_playwright, expect, Error as PlaywrightError
from playwright._impl._network import Response as InstalledResponse

SOURCE_DIGEST = 'A8A0619825BB440CA6F96768C87D09CE774E78C4866F32913E10BB02FBD20A02'
SOURCE_COUNT = 795
ENTRY_PATH = '/?onboarding=1#intro'
POINTS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'top-edge',
          'right-edge', 'bottom-edge', 'left-edge', 'center']
TITLES = {'ru': ['Все специалисты', 'Один день', 'Гости без хаоса', 'Одно приложение'],
          'en': ['All vendors', 'One day', 'Guests without chaos', 'One app']}
TEXT = {'ru': {'skip': 'Пропустить', 'next': 'Далее', 'start': 'Начать', 'back': 'Назад',
               'slide': 'Слайд', 'auth': 'С возвращением',
               'offline': 'Нет сети — новые данные недоступны'},
        'en': {'skip': 'Skip', 'next': 'Next', 'start': 'Start', 'back': 'Back',
               'slide': 'Slide', 'auth': 'Welcome back',
               'offline': 'No connection — new data is unavailable'}}


def digest(raw):
    return hashlib.sha256(raw).hexdigest().upper()


def now():
    return time.time()


class RunnerRefused(Exception):
    def __init__(self, code):
        self.code = code if type(code) is str and re.fullmatch(r'[a-z0-9_]{1,80}', code) else 'observer_refused'
        super().__init__(self.code)


def require(ok, code='observer_refused'):
    if not ok:
        raise RunnerRefused(code) from None


def safe_failure(error):
    # No exception text/args/locals/source paths/URLs/headers are read or saved.
    labels = {RunnerRefused: 'RunnerRefused', AssertionError: 'AssertionError',
              asyncio.CancelledError: 'CancelledError', TimeoutError: 'TimeoutError',
              PlaywrightError: 'PlaywrightError', ValueError: 'ValueError',
              KeyError: 'KeyError', TypeError: 'TypeError'}
    result = {'exceptionClass': labels.get(type(error), 'UnknownException')}
    if type(error) is RunnerRefused:
        result['code'] = error.code
    trace = BaseException.__getattribute__(error, '__traceback__')
    result['ownedLines'] = []
    for _ in range(128):
        if trace is None:
            break
        if trace.tb_frame.f_code.co_filename == safe_failure.__code__.co_filename and len(result['ownedLines']) < 32:
            result['ownedLines'].append(trace.tb_lineno)
        trace = trace.tb_next
    return result


def write_new(path, value):
    with path.open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


class FinishedTaskOwner:
    """Own only pinned on_finished children; never cancel shared page futures."""
    def __init__(self):
        network = pathlib.Path(InstalledResponse.finished.__code__.co_filename).resolve()
        require(digest(network.read_bytes()) == 'C2528EAF76B59E45CC86C03152ABFAFCF694D3C39F6A4C8A55CE8F0ECB270926',
                'finished_library_pin_refused')
        codes = [c for c in InstalledResponse.finished.__code__.co_consts
                 if isinstance(c, types.CodeType) and c.co_name == 'on_finished']
        require(len(codes) == 1 and codes[0].co_qualname == 'Response.finished.<locals>.on_finished',
                'finished_child_code_refused')
        self.code = codes[0]
        self.marker = contextvars.ContextVar('quiz_original_finished_owner', default=None)
        self.owners, self.active, self.pages = [], {}, {}
        self.sequence, self.invalid, self.drained = 0, False, False

    def order(self):
        self.sequence += 1
        return self.sequence

    def __enter__(self):
        self.loop = asyncio.get_running_loop()
        self.previous = self.loop.get_task_factory()
        def factory(loop, coroutine, **kwargs):
            context = kwargs.get('context')
            token = context.get(self.marker) if context is not None else self.marker.get()
            invocation = self.active.get(token)
            exact = getattr(coroutine, 'cr_code', None) is self.code
            task = (self.previous(loop, coroutine, **kwargs) if self.previous is not None
                    else asyncio.Task(coroutine, loop=loop, **kwargs))
            if invocation is not None and exact:
                invocation['children'].append(task)
                require(isinstance(task, asyncio.Task) and task.get_coro() is coroutine
                        and len(invocation['children']) == 1, 'finished_child_ownership_refused')
            return task
        self.factory = factory
        self.loop.set_task_factory(factory)
        return self

    def __exit__(self, kind, error, trace):
        unchanged = self.loop.get_task_factory() is self.factory
        if unchanged:
            self.loop.set_task_factory(self.previous)
        require(unchanged and not self.active and self.drained
                and all(c.done() and c in o['retrieved'] for o in self.owners for c in o['children']),
                'finished_owner_scope_refused')

    def watch(self, page):
        require(page not in self.pages, 'finished_page_duplicate_refused')
        row = {'closed': None}
        self.pages[page] = row
        def closed(original_page):
            if original_page is not page or row['closed'] is not None or not page.is_closed():
                self.invalid = True
                return
            if any(o['page'] is page and o['success'] is not None
                   and any(c.done() for c in o['children']) for o in self.owners):
                self.invalid = True
            row['closed'] = self.order()
        def crashed(original_page):
            # Crash resolves the same shared future but is not a close witness.
            self.invalid = True
        page.on('close', closed)
        page.on('crash', crashed)

    async def finished(self, response, page):
        require(self.loop.get_task_factory() is self.factory and page in self.pages
                and response.request.frame.page is page, 'finished_original_page_refused')
        token = object()
        invocation = {'response': response, 'page': page, 'children': [], 'retrieved': set(),
                      'success': None, 'pendingAtReturn': False}
        self.owners.append(invocation)
        self.active[token] = invocation
        reset = self.marker.set(token)
        try:
            # Actual original API method/return is retained; no future is reset.
            actual = await response.finished()
            require(actual is None, 'original_response_finished_refused')
            require(len(invocation['children']) == 1 and not invocation['children'][0].done()
                    and self.pages[page]['closed'] is None and not page.is_closed(),
                    'finished_child_premature_refused')
            invocation['pendingAtReturn'] = True
            invocation['success'] = self.order()
            return actual
        finally:
            self.marker.reset(reset)
            self.active.pop(token)

    def expected_post_close_error(self, error):
        if type(error) is not PlaywrightError:
            return False
        trace = BaseException.__getattribute__(error, '__traceback__')
        while trace is not None and trace.tb_next is not None:
            trace = trace.tb_next
        return (trace is not None and trace.tb_frame.f_code is self.code
                and trace.tb_lineno == self.code.co_firstlineno + 2)

    async def drain(self, deadline):
        # Shares the original final collector's 10-second cleanup budget.
        # No child cancellation: every child directly awaits a shared page future.
        children = [c for o in self.owners for c in o['children']]
        bad = self.invalid or bool(self.active) or len(set(children)) != len(children)
        eligible = []
        for invocation in self.owners:
            page = invocation['page']
            closed = self.pages[page]['closed']
            if closed is None or not page.is_closed():
                bad = True
            else:
                eligible.extend(invocation['children'])
            if (len(invocation['children']) != 1 or invocation['success'] is None
                    or not invocation['pendingAtReturn'] or closed is None
                    or invocation['success'] >= closed):
                bad = True
        pending = [c for c in eligible if not c.done()]
        if pending:
            await asyncio.wait(pending, timeout=max(0, deadline - self.loop.time()))
        for invocation in self.owners:
            for child in invocation['children']:
                if not child.done():
                    bad = True
                    continue
                try:
                    child.result()
                except BaseException as error:
                    expected = self.expected_post_close_error(error)
                else:
                    expected = False
                invocation['retrieved'].add(child)
                if not expected:
                    bad = True
        self.drained = not bad
        require(not bad, 'finished_owned_cleanup_refused')
        return {'scope': 'original finished child ownership cleanup only; no HTTP/native acceptance',
                'ownedInvocations': len(self.owners), 'successfulOriginalNone': len(self.owners),
                'postCloseChildrenRetrieved': len(children), 'pendingChildren': 0}



def validate_cached_font_data(value, original_length):
    assert isinstance(value, dict) and isinstance(value.get('requestId'), str) and value['requestId']
    assert type(original_length) is int and original_length > 4, 'Bound original WOFF2 byte length'
    assert isinstance(value.get('dataEvents'), list) and isinstance(value.get('finishedEvents'), list)
    assert len(value['finishedEvents']) == 1
    request, response, finish = value['requestEvent'], value['responseEvent'], value['finishedEvents'][0]
    assert request['requestId'] == response['requestId'] == finish['event']['requestId'] == value['requestId']
    finite = lambda number: type(number) in (int, float) and float('-inf') < number < float('inf')
    for number in [request['timestamp'], response['timestamp'], finish['event']['timestamp'], value['requestAt'], value['responseAt'], finish['at']]:
        assert finite(number), 'Finite actual CDP and observed data timestamps'
    assert request['timestamp'] <= response['timestamp'] and request['timestamp'] <= finish['event']['timestamp']
    assert value['requestAt'] <= value['responseAt'] <= finish['at'], 'Actual observed request/response/finish order'
    assert type(finish['event']['encodedDataLength']) in (int, float) and finish['event']['encodedDataLength'] == 0
    total, previous_timestamp, previous_at = 0, request['timestamp'], value['responseAt']
    for row in value['dataEvents']:
        assert isinstance(row, dict) and set(row) == {'at', 'event'}
        event = row['event']
        assert isinstance(event, dict) and set(event) == {'requestId', 'timestamp', 'dataLength', 'encodedDataLength'}, 'Only observed CDP data fields; no streamed/invented body'
        assert event['requestId'] == value['requestId']
        assert finite(event['timestamp']) and finite(row['at']), 'Finite actual data timestamps'
        assert previous_timestamp <= event['timestamp'] <= finish['event']['timestamp'], 'Ordered CDP data within request/finish'
        assert previous_at <= row['at'] <= finish['at'], 'Ordered observed data within response/finish'
        length = event['dataLength']
        assert finite(length) and length > 0 and length == int(length) and length <= 9007199254740991, 'Positive integer decoded chunk length'
        assert type(event['encodedDataLength']) in (int, float) and event['encodedDataLength'] == 0
        total += length
        assert total <= 9007199254740991
        previous_timestamp, previous_at = event['timestamp'], row['at']
    if value['dataEvents']:
        assert total == original_length, 'Observed decoded chunks bind original exact WOFF2 length'
    return {'dataEvents': len(value['dataEvents']), 'decodedChunkBytes': total, 'encodedBytes': 0}


CONTENT_GEOMETRY = r"""el=>{
 const policy='rendered_content_and_exact_nine_points_v1',rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}},style=e=>getComputedStyle(e);
 const metrics=e=>{const r=rect(e),s=style(e),ow=e.offsetWidth||r.right-r.left,oh=e.offsetHeight||r.bottom-r.top;return {offsetWidth:ow,offsetHeight:oh,clientLeft:e.clientLeft,clientTop:e.clientTop,clientWidth:e.clientWidth,clientHeight:e.clientHeight,scaleX:(r.right-r.left)/ow,scaleY:(r.bottom-r.top)/oh}};
 const client=(e,m=metrics(e))=>{const r=rect(e),left=r.left+m.clientLeft*m.scaleX,top=r.top+m.clientTop*m.scaleY;return {left,right:left+m.clientWidth*m.scaleX,top,bottom:top+m.clientHeight*m.scaleY}};
 const raw=e=>({clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight});
 const nodes=[el,...el.querySelectorAll('*')],ancestors=[];for(let n=el.parentElement;n;n=n.parentElement)ancestors.push(n);
 const owner=e=>e===el?'@control':nodes.includes(e)?'@control/'+nodes.indexOf(e):'@ancestor/'+ancestors.indexOf(e),viewport={width:innerWidth,height:innerHeight},m=metrics(el),controlBox=client(el,m),pseudos=[],boxes=[],unmeasured=[];
 const visible=e=>{const s=style(e),r=rect(e);return s.display!=='none'&&s.visibility==='visible'&&r.right>r.left&&r.bottom>r.top};
 const clips=e=>{
  const rows=[{owner:'@viewport',box:{left:0,right:innerWidth,top:0,bottom:innerHeight},x:true,y:true},{owner:'@control',box:controlBox,x:true,y:true}];
  for(let n=e;n;n=n.parentElement){const s=style(n),x=['hidden','clip','auto','scroll'].includes(s.overflowX),y=['hidden','clip','auto','scroll'].includes(s.overflowY),paint=/(^|\s)(paint|strict|content)(\s|$)/.test(s.contain);
   if(s.clipPath!=='none'||(s.maskImage&&s.maskImage!=='none'))unmeasured.push({owner:owner(n),reason:'unsupported clipPath/mask',clipPath:s.clipPath,maskImage:s.maskImage});
   if(x||y||paint)rows.push({owner:n===el?'@control-clip':owner(n),box:client(n),rect:rect(n),metrics:metrics(n),css:{overflowX:s.overflowX,overflowY:s.overflowY,contain:s.contain},x:x||paint,y:y||paint});
  }
  return rows;
 };
 const add=(kind,e,r)=>{if(r.right>r.left&&r.bottom>r.top)boxes.push({kind,owner:owner(e),rect:r,clips:clips(kind==='text'?e:e.parentElement)})};
 for(const n of nodes){if(!visible(n))continue;
  for(const pseudo of ['::before','::after']){const s=getComputedStyle(n,pseudo);pseudos.push({owner:owner(n),pseudo,content:s.content,display:s.display,visibility:s.visibility,position:s.position,pointerEvents:s.pointerEvents})}
  if(n!==el)add(n instanceof SVGElement?'svg':n.tagName==='IMG'?'image':'element',n,rect(n));
 }
 const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);
 while(walker.nextNode()){const n=walker.currentNode,p=n.parentElement;if(!n.textContent.trim()||!visible(p))continue;const range=document.createRange();range.selectNodeContents(n);for(const r of range.getClientRects())add('text',p,{left:r.left,right:r.right,top:r.top,bottom:r.bottom});range.detach()}
 const native=['INPUT','SELECT','TEXTAREA'].includes(el.tagName);if(native)boxes.push({kind:'native',owner:'@control',rect:controlBox,clips:clips(el)});
 const active=p=>p.display!=='none'&&p.visibility==='visible'&&!['none','normal'].includes(p.content);
 const decorative=p=>['\"\"',"''"].includes(p.content)&&p.position==='absolute'&&p.pointerEvents==='none';
 const generated=pseudos.filter(active),rawWithin=el.scrollWidth<=el.clientWidth+1;
 const fits=b=>b.clips.every(c=>(!c.x||b.rect.left>=c.box.left-1&&b.rect.right<=c.box.right+1)&&(!c.y||b.rect.top>=c.box.top-1&&b.rect.bottom<=c.box.bottom+1));
 const qualified=unmeasured.length===0&&generated.every(decorative)&&boxes.every(fits)&&(rawWithin||!native&&generated.some(decorative)&&boxes.length>0);
 return {policy,tag:el.tagName,viewport,rect:rect(el),clientBox:controlBox,metrics:m,raw:raw(el),pseudos,boxes,unmeasured,qualified};
}"""
SUMMARY_GEOMETRY = """({names,measure})=>{
 const inFrame=e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&e.scrollWidth<=e.clientWidth+1};
 const labels=[...document.querySelectorAll('body *')].filter(e=>names.includes(e.textContent)&&!e.children.length&&e.getBoundingClientRect().width>0);
 const controls=[...document.querySelectorAll('button,a,input,select,textarea')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&r.top>=0&&r.bottom<=innerHeight&&!e.disabled&&getComputedStyle(e).visibility==='visible'});
 const controlSummary=controls.map(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);return {content:measure(e),hitPresent:!!hit,hitContained:!!hit&&e.contains(hit)}});
 return {documentWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),visibleNamesWithinViewport:labels.every(inFrame),controlsUnobscured:controlSummary.every(c=>c.content.rect.left>=0&&c.content.rect.right<=innerWidth&&c.content.qualified&&c.hitPresent&&c.hitContained),nameCount:labels.length,controlSummary};
}"""
SHOT_GEOMETRY = "el=>{\n const b=el.getBoundingClientRect(),s=getComputedStyle(el),cx=(b.left+b.right)/2,cy=(b.top+b.bottom)/2;\n const sx=b.width/(el.offsetWidth||b.width),sy=b.height/(el.offsetHeight||b.height),cssW=b.width/sx,cssH=b.height/sy;\n const length=(v,size)=>v.endsWith('%')?parseFloat(v)*size/100:parseFloat(v);\n const radius=value=>{const v=value.trim().split(/\\s+/);return{x:length(v[0],cssW)*sx,y:length(v[1]||v[0],cssH)*sy}};\n const r={tl:radius(s.borderTopLeftRadius),tr:radius(s.borderTopRightRadius),br:radius(s.borderBottomRightRadius),bl:radius(s.borderBottomLeftRadius)};\n const factor=Math.min(1,b.width/(r.tl.x+r.tr.x)||Infinity,b.width/(r.bl.x+r.br.x)||Infinity,b.height/(r.tl.y+r.bl.y)||Infinity,b.height/(r.tr.y+r.br.y)||Infinity);\n for(const v of Object.values(r)){v.x*=factor;v.y*=factor}\n const inset=Math.min(1,b.width/4,b.height/4),arc=1-Math.SQRT1_2;\n const points=[\n  ['top-left',b.left+r.tl.x*arc+inset,b.top+r.tl.y*arc+inset],\n  ['top-right',b.right-r.tr.x*arc-inset,b.top+r.tr.y*arc+inset],\n  ['bottom-left',b.left+r.bl.x*arc+inset,b.bottom-r.bl.y*arc-inset],\n  ['bottom-right',b.right-r.br.x*arc-inset,b.bottom-r.br.y*arc-inset],\n  ['top-edge',b.left+(r.tl.x+b.width-r.tr.x)/2,b.top+inset],\n  ['right-edge',b.right-inset,b.top+(r.tr.y+b.height-r.br.y)/2],\n  ['bottom-edge',b.left+(r.bl.x+b.width-r.br.x)/2,b.bottom-inset],\n  ['left-edge',b.left+inset,b.top+(r.tl.y+b.height-r.bl.y)/2],\n  ['center',cx,cy]\n ];\n const describe=node=>{if(!node)return null;const c=getComputedStyle(node);return{tag:node.tagName,id:node.id,className:typeof node.className==='string'?node.className:String(node.className),role:node.getAttribute('role'),position:c.position,zIndex:c.zIndex,pointerEvents:c.pointerEvents,visibility:c.visibility,opacity:c.opacity}};\n const hits=points.map(([name,x,y])=>{const hit=document.elementFromPoint(x,y);return{name,x,y,contained:!!hit&&el.contains(hit),hit:describe(hit),stack:document.elementsFromPoint(x,y).slice(0,4).map(describe)}});\n return{left:b.left,right:b.right,top:b.top,bottom:b.bottom,viewportWidth:innerWidth,viewportHeight:innerHeight,unobscured:hits.every(p=>p.contained),borderRadii:r,css:{borderTopLeftRadius:s.borderTopLeftRadius,borderTopRightRadius:s.borderTopRightRadius,borderBottomLeftRadius:s.borderBottomLeftRadius,borderBottomRightRadius:s.borderBottomRightRadius,overflow:s.overflow,pointerEvents:s.pointerEvents,position:s.position,zIndex:s.zIndex,transform:s.transform},hits};\n}"



DOCUMENT = """()=>({url:location.href,timeOrigin:performance.timeOrigin,readyState:document.readyState,
 online:navigator.onLine,language:document.documentElement.lang,hidden:document.hidden,
 visibilityState:document.visibilityState,fontsStatus:document.fonts.status,
 auth:Object.fromEntries(['tt_auth','tt_guest_token','tt_wedding_id','tt_wedding_date'].map(k=>[k,localStorage.getItem(k)!==null]))})"""
SETTLE = """async()=>{const start=performance.now(),limit=start+5000;
 const expired=()=>{if(performance.now()>limit)throw Error('settlement_deadline')};
 const animations=()=>document.getAnimations().filter(a=>{
  const t=a.effect?.getComputedTiming();return t&&t.iterations!==Infinity&&
  ((a instanceof CSSAnimation&&['fadeUp','pop'].includes(a.animationName))||a instanceof CSSTransition)});
 await document.fonts.ready;expired();let last=null,same=0;
 while(true){expired();await new Promise(requestAnimationFrame);expired();
  const running=animations().some(a=>['running','pending'].includes(a.playState));
  const rects=[...document.querySelectorAll('button,a,input,select,textarea')].map(e=>{
   const r=e.getBoundingClientRect();return [r.left,r.top,r.right,r.bottom,getComputedStyle(e).transform]});
  const value=JSON.stringify(rects);same=value===last?same+1:0;last=value;
  if(!running&&document.fonts.status==='loaded'&&same>=1)return {startedAt:start,finishedAt:performance.now(),
   timeOrigin:performance.timeOrigin,url:location.href,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,
   animationStyles:[...document.querySelectorAll('.fade-up,.pop')].map(e=>({className:e.className,
     animationName:getComputedStyle(e).animationName,animationDuration:getComputedStyle(e).animationDuration})),
   animations:animations().map(a=>({kind:a instanceof CSSAnimation?'CSSAnimation':'CSSTransition',
    name:a instanceof CSSAnimation?a.animationName:a.transitionProperty,playState:a.playState,currentTime:a.currentTime})),rects};
 }}"""
POINTER_INSTALL = """el=>{if(window.__onboardingPointer)throw Error('pointer_observer_exists');
 const rows=[],types=['pointerdown','pointerup','mousedown','mouseup','click'];
 const handler=e=>rows.push({type:e.type,isTrusted:e.isTrusted,at:Date.now(),performanceNow:performance.now(),
  timeOrigin:performance.timeOrigin,x:e.clientX,y:e.clientY,button:e.button,contained:el.contains(e.target)});
 for(const type of types)document.addEventListener(type,handler,true);
 window.__onboardingPointer={el,rows,remove:()=>{for(const type of types)document.removeEventListener(type,handler,true)}};
 return {timeOrigin:performance.timeOrigin,url:location.href}}"""
POINTER_REMOVE = """()=>{const o=window.__onboardingPointer;if(!o)return null;
 o.remove();const rows=o.rows;delete window.__onboardingPointer;return rows}"""


def matrix_key(row):
    require(isinstance(row, dict) and set(row) == {'id', 'language', 'width', 'height', 'scene', 'network', 'motion'}, 'matrix_fields')
    require(type(row['width']) is int and type(row['height']) is int and type(row['scene']) is int
            and row['language'] in ('ru', 'en') and row['width'] in (320, 390, 480) and row['height'] == 844
            and row['scene'] in (1, 2, 3, 4) and row['network'] in ('online', 'offline')
            and row['motion'] in ('normal', 'reduced') and re.fullmatch(r'[A-Za-z0-9_-]+', row['id']), 'matrix_value')
    return tuple(row[k] for k in ('language', 'width', 'scene', 'network', 'motion'))


def float32(value):
    # Chromium carries pointer positions as single-precision floats.
    return struct.unpack('<f', struct.pack('<f', value))[0]


def pointer_events_valid(rows, point, time_origin):
    types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']
    finite = lambda value: type(value) in (int, float) and math.isfinite(value)
    if not isinstance(rows, list) or len(rows) != 5 or not isinstance(point, dict):
        return False
    if not finite(time_origin) or time_origin <= 0 or any(not finite(point.get(k)) or point[k] < 0 for k in ('x', 'y')):
        return False
    previous = None
    for kind, row in zip(types, rows):
        if not isinstance(row, dict) or row.get('type') != kind:
            return False
        if row.get('isTrusted') is not True or row.get('contained') is not True or type(row.get('button')) is not int or row['button'] != 0:
            return False
        if any(not finite(row.get(k)) for k in ('x', 'y', 'at', 'performanceNow', 'timeOrigin')):
            return False
        px, py = float32(point['x']), float32(point['y'])
        expected_x, expected_y = (px, py) if kind.startswith('pointer') else (math.floor(px), math.floor(py))
        if row['x'] != expected_x or row['y'] != expected_y or row['timeOrigin'] != time_origin or row['at'] <= 0 or row['performanceNow'] < 0:
            return False
        if previous is not None and (previous['at'] > row['at'] or previous['performanceNow'] > row['performanceNow']):
            return False
        previous = row
    return True



def font_document_scope(before, after, frame, row, origin):
    # One document is one epoch in one frame/loader; its URL is mutable. After a language
    # reload the app boots at '/' and main.tsx restores the entry with history.replaceState,
    # so the two samples may straddle exactly that root->entry restoration and nothing else.
    keys = {'url', 'timeOrigin'}
    if not (set(before) == keys and set(after) == keys
            and type(before['timeOrigin']) in (int, float) and math.isfinite(before['timeOrigin'])
            and before['timeOrigin'] == after['timeOrigin']
            and type(frame['id']) is str and frame['id'] and type(frame['loaderId']) is str and frame['loaderId']):
        return False
    restored = (row['documentURL'] == origin + '/' and before['url'] == origin + '/'
                and after['url'] == origin + ENTRY_PATH)
    if before['url'] != after['url'] and not restored:
        return False
    return frame['url'] in {before['url'], before['url'].split('#')[0], after['url'], after['url'].split('#')[0]}


def original_font_history(rows, row, before, frame, observed_count, origin):
    # `before` is the settled (later) sample; font_document_scope admits only the boot
    # root->entry restoration between the two samples, with the original epoch/frame guard.
    require(row['documentURL'] in (origin + '/', origin + ENTRY_PATH, origin + '/auth')
            and before['url'] in (origin + '/', origin + ENTRY_PATH, origin + '/auth'), 'font_history_public_document')
    if row['documentURL'] == before['url']:
        return None
    require(row['documentURL'] == origin + '/' and before['url'] == origin + ENTRY_PATH, 'font_history_exact_root_entry')
    require(type(observed_count) is int and 0 <= observed_count <= len(rows), 'font_history_boundary')
    prefix = rows[:observed_count]
    require(all(v['index'] == i for i, v in enumerate(prefix)), 'font_history_original_indices')
    anchors = [v for v in prefix if v['caseId'] == row['caseId'] and v['phase'] == row['phase']
               and v['event'] == 'Page.frameNavigated' and v['frameId'] == frame['id']
               and v.get('loaderId') == frame['loaderId'] and v['url'] == row['documentURL']]
    require(len(anchors) == 1, 'font_history_unique_loader_anchor')
    anchor = anchors[0]
    subsequent = [v for v in prefix if v['index'] > anchor['index'] and v['frameId'] == frame['id']]
    require(subsequent and all(v['caseId'] == row['caseId'] and v['phase'] == row['phase']
            and v['event'] == 'Page.navigatedWithinDocument' and v['navigationType'] == 'historyApi'
            and v['frameEventIndex'] == anchor['index'] and v['loaderIdFromFrameEvent'] == frame['loaderId']
            and v['url'] == before['url'] for v in subsequent), 'font_history_literal_restoration_only')
    return {'anchorIndex': anchor['index'], 'historyEventIndices': [v['index'] for v in subsequent]}

class Observer:
    def __init__(self, out, admission, raw):
        self.out, self.admission, self.ui = out, admission, admission['origin']
        parsed = urlsplit(self.ui)
        require(parsed.scheme == 'http' and parsed.hostname == '127.0.0.1' and parsed.port
                and parsed.path == '' and not parsed.query and not parsed.fragment and not parsed.username, 'owned_origin')
        require(admission['kind'] == 'ROOT_COMPILED_ONBOARDING_ADMISSION_V1'
                and admission['sourceDigest'] == SOURCE_DIGEST and admission['sourceCount'] == SOURCE_COUNT, 'admission_source')
        require(admission['entryPath'] == ENTRY_PATH, 'entry_path')
        rows = admission['matrix']
        expected = {(l, w, s, n, m) for l in ('ru', 'en') for w in (320, 390, 480)
                    for s in (1, 2, 3, 4) for n in ('online', 'offline') for m in ('normal', 'reduced')}
        require(len(rows) == 96 and {matrix_key(r) for r in rows} == expected
                and len({r['id'] for r in rows}) == 96, 'exact_matrix96')
        self.builds = {r['path']: r['sha256'] for r in admission['build']}
        require(len(self.builds) == len(admission['build']) and 'index.html' in self.builds
                and all(re.fullmatch(r'[A-F0-9]{64}', h) for h in self.builds.values()), 'build_inventory')
        pin = admission['chromium']
        require(digest(pathlib.Path(pin['path']).read_bytes()) == pin['sha256']
                and os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE'].replace('\\', '/') == pin['path'], 'chromium_pin')
        self.result = {k: [] for k in ('cases', 'phases', 'layouts', 'held', 'drains', 'requests', 'responses', 'finished',
                                     'fontNetwork', 'consoleErrors', 'pageErrors', 'requestFailures', 'captureErrors', 'failures', 'geometryDiagnostics', 'documentChronology')}
        self.result.update(kind='ROOT_ACTUAL_COMPILED_ONBOARDING_COLLECTION_V1', status='COLLECTION_FAILED',
                           sourceDigest=SOURCE_DIGEST, sourceCount=SOURCE_COUNT, admissionSHA256=digest(raw),
                           browserClosed=False, contextsCreated=0, contextsClosed=0,
                           scope='Original anonymous Playwright collection; native and whole acceptance belong to ROOT')
        self.states, self.tasks, self.contexts = {}, set(), []
        self.changed = asyncio.Event()
        self.finished_owner = FinishedTaskOwner()
        self.browser = self.page = self.current = None
        self.phase, self.sequence = 'preparation', 0
        self.active_phase = None
        self.font_proofs = {}

    def binding(self):
        return {'caseId': self.current['id'] if self.current else None, 'phase': self.phase}

    def safe_url(self, url):
        p = urlsplit(url)
        require(p.scheme + '://' + p.netloc == self.ui and not p.username and not p.password, 'foreign_or_credential_url')
        if p.path.startswith('/api/'):
            require(p.path in ('/api/health', '/api/legal/policy') and not p.query and not p.fragment, 'anonymous_get_routes')
        else:
            require((p.path == '/' and p.query in ('', 'onboarding=1') and p.fragment in ('', 'intro'))
                    or (p.path == '/auth' and not p.query and not p.fragment)
                    or (p.path[1:] in self.builds and not p.query and not p.fragment), 'compiled_public_path')
        return url

    def schedule(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.tasks.add(task)
        def done(t):
            self.tasks.discard(t)
            try:
                t.result()
            except BaseException as error:
                self.result['captureErrors'].append({**self.binding(), **safe_failure(error)})
            self.changed.set()
        task.add_done_callback(done)
        return task

    async def font_history_settled(self, row, frame, url):
        # The CDP row of that restoration can trail the page's own view of the new URL;
        # wait (bounded) so the chronology snapshot taken next contains it.
        deadline = time.monotonic() + 2
        while not any(v['event'] == 'Page.navigatedWithinDocument' and v.get('navigationType') == 'historyApi'
                      and v['caseId'] == row['caseId'] and v['phase'] == row['phase'] and v['frameId'] == frame['id']
                      and v.get('loaderIdFromFrameEvent') == frame['loaderId'] and v['url'] == url
                      for v in self.result['documentChronology']):
            require(time.monotonic() < deadline, 'font_history_settle_timeout')
            await asyncio.sleep(0.01)

    def requested(self, request):
        try:
            require(request not in self.states and request.service_worker is None
                    and request.frame.page is self.page and request.frame is self.page.main_frame, 'original_main_request')
            self.sequence += 1
            row = {'id': self.sequence, **self.binding(), 'url': self.safe_url(request.url), 'method': request.method,
                   'at': now(), 'resourceType': request.resource_type, 'documentURL': request.frame.url,
                    'expectedCaseCookieSHA256': self._probe_case_sha256,
                   'owner': {'kind': 'main-frame', 'observedPage': True}}
            require(request.method == 'GET' and request.post_data_buffer is None, 'anonymous_get_only')
            state = {'request': request, 'row': row, 'page': self.page, 'cdp': self.cdp, 'context': self.contexts[-1],
                     'httpFinished': asyncio.Event(), 'response': None, 'finished': False}
            self.states[request] = state
            self.result['requests'].append(row)
            async def headers():
                h = await request.all_headers()
                if request.resource_type == 'font':
                    require(request.frame.page is state['page'] and request.frame is state['page'].main_frame, 'original_font_frame_before')
                    before = await request.frame.evaluate('()=>({url:location.href,timeOrigin:performance.timeOrigin})')
                    frame = (await state['cdp'].send('Page.getFrameTree'))['frameTree']['frame']
                    after = await request.frame.evaluate('()=>({url:location.href,timeOrigin:performance.timeOrigin})')
                    require(request.frame.page is state['page'] and request.frame is state['page'].main_frame
                            and font_document_scope(before, after, frame, row, self.ui), 'original_font_document_scope')
                    if before['url'] != after['url']:
                        await self.font_history_settled(row, frame, after['url'])
                    count = len(self.result['documentChronology'])
                    history = original_font_history(self.result['documentChronology'], row, after, frame, count, self.ui)
                    row['fontScope'] = {'before': dict(before), 'after': dict(after), 'frameURL': frame['url'],
                                        'observedChronologyCount': count, 'history': history}
                    row.update(documentTimeOrigin=after['timeOrigin'], frameId=frame['id'], loaderId=frame['loaderId'])
                elif urlsplit(request.url).path.startswith('/api/'):
                    row['documentTimeOrigin'] = await request.frame.evaluate('performance.timeOrigin')
                row.update(authorizationPresent='authorization' in h, cookiePresent='cookie' in h,
                           bodyPresent=False, bodySHA256=None, bodyByteLength=None)
                require(not row['authorizationPresent'], 'anonymous_headers')
                marker = None
                if row['cookiePresent']:
                    parts = h['cookie'].split(';')
                    require(len(parts) == 1 and parts[0].strip().startswith('tt_probe_case='), 'probe_cookie_only')
                    name, value = parts[0].strip().split('=', 1)
                    require(name == 'tt_probe_case' and re.fullmatch(r'[a-f0-9]{64}', value), 'probe_cookie_format')
                    marker = digest(value.encode('ascii'))
                    require(marker == row['expectedCaseCookieSHA256'], 'probe_cookie_identity')
                row.update(caseCookieSHA256=marker, probeCookieObserved=marker is not None)
                if urlsplit(request.url).path.startswith('/api/'):
                    require(marker == row['expectedCaseCookieSHA256'], 'api_probe_cookie_observed')
            state['requestCapture'] = self.schedule(headers())
        except BaseException as error:
            self.result['captureErrors'].append({**self.binding(), **safe_failure(error)})
        self.changed.set()

    def response(self, response):
        state = self.states.get(response.request)
        if state is None or state['response'] is not None:
            self.result['captureErrors'].append({**self.binding(), 'code': 'original_response_identity'})
            return
        q = state['row']
        row = {k: q[k] for k in ('id', 'caseId', 'phase', 'url', 'method')}
        row.update(at=now(), status=response.status, fromServiceWorker=response.from_service_worker)
        state['response'], state['responseRow'] = response, row
        self.result['responses'].append(row)
        async def capture():
            await state['requestCapture']
            h = await response.all_headers()
            require('set-cookie' not in h, 'anonymous_response_cookie')
            row['headers'] = {k: h[k] for k in ('content-type', 'content-length', 'cache-control', 'etag',
                                                'content-security-policy', 'x-content-type-options') if k in h}
            if q['resourceType'] == 'font':
                row['headers'] = h
                await state['httpFinished'].wait()
                row['requestStartTime'] = response.request.timing['startTime']
                key = (q['caseId'], q['phase'], q['url'], q['documentURL'].split('#')[0], q['frameId'], q['loaderId'])
                await self.font_waiters.setdefault(key, asyncio.Event()).wait()
                candidates = [v for v in self.font_network.values() if v['caseId'] == key[0] and v['phase'] == key[1]
                              and v['requestEvent']['request']['url'] == key[2] and v['requestEvent']['documentURL'] == key[3]
                              and v['requestEvent']['frameId'] == key[4] and v['requestEvent']['loaderId'] == key[5]]
                require(len(candidates) == 1, 'unique_current_font_request')
                value = candidates[0]
                require(value.get('responseEvent') and len(value['finishedEvents']) == 1, 'original_font_cdp_finish')
                meta = value['responseEvent']['response']
                priors = [v for v in self.result['responses'] if v.get('bodyKind') == 'original-response-body'
                          and v['caseId'] == q['caseId'] and v['url'] == q['url'] and v['id'] < q['id']
                          and any(f['id'] == v['id'] and f['at'] < q['at'] for f in self.result['finished'])]
                if meta.get('fromDiskCache') is True and value['cachedEvents'] and priors:
                    require(meta.get('fromServiceWorker') is True and meta.get('fromPrefetchCache') is False
                            and meta.get('serviceWorkerResponseSource') == 'cache-storage'
                            and meta.get('mimeType') == 'font/woff2' and meta.get('status') == 200
                            and meta.get('encodedDataLength') == 0 and len(value['cachedEvents']) == 1
                            and value['finishedEvents'][0]['event']['encodedDataLength'] == 0, 'cached_font_original_cdp')
                    prior = priors[0]
                    raw = base64.b64decode(prior['bodyBase64'], validate=True)
                    rel = urlsplit(q['url']).path[1:]
                    require(raw[:4] == b'wOF2' and digest(raw) == prior['bodySHA256'] == self.builds[rel]
                            and row['headers'].get('content-length') == str(len(raw)), 'cached_font_original_bytes')
                    validate_cached_font_data(value, len(raw))
                    row.update(bodyKind='proved-cached-font', cached={'originalResponseId': prior['id'],
                                                                     'cdpRequestId': value['requestId']})
                    return
            raw = await response.body()
            row.update(bodyKind='original-response-body', bodyBase64=base64.b64encode(raw).decode(),
                       bodySHA256=digest(raw), bodyByteLength=len(raw))
            if urlsplit(q['url']).path.startswith('/api/'):
                row['json'] = json.loads(raw)
            else:
                path = urlsplit(q['url']).path
                rel = 'index.html' if q['resourceType'] == 'document' and path in ('/', '/auth') else path[1:]
                require(digest(raw) == self.builds[rel], 'original_compiled_response_bytes')
        state['responseCapture'] = self.schedule(capture())
        self.changed.set()

    def finished(self, request):
        state = self.states.get(request)
        if state is None or state['finished']:
            self.result['captureErrors'].append({**self.binding(), 'code': 'original_finished_identity'})
            return
        state['finished'] = True
        at = now()
        async def capture():
            require(state['response'] is not None and state['response'].request is request, 'finished_response_missing')
            require(await self.finished_owner.finished(state['response'], state['page']) is None, 'actual_finished_none')
            state['httpFinished'].set()
            await state['responseCapture']
            q = state['row']
            self.result['finished'].append({**{k: q[k] for k in ('id', 'caseId', 'phase', 'url', 'method')}, 'at': at})
        state['finishedCapture'] = self.schedule(capture())
        self.changed.set()

    def attach(self, page, cdp):
        self.finished_owner.watch(page)
        self.font_network, self.font_waiters = {}, {}
        def ready(value):
            if value.get('responseEvent') and value['finishedEvents']:
                e = value['requestEvent']
                key = (value['caseId'], value['phase'], e['request']['url'], e['documentURL'], e['frameId'], e['loaderId'])
                self.font_waiters.setdefault(key, asyncio.Event()).set()
        def font_request(e):
            if e['type'] != 'Font':
                return
            try:
                require(e['requestId'] not in self.font_network, 'duplicate_font_cdp')
                self.safe_url(e['request']['url']);self.safe_url(e['documentURL'])
                v = {**self.binding(), 'requestId': e['requestId'], 'requestAt': now(),
                     'requestEvent': {k: e[k] for k in ('requestId', 'timestamp', 'wallTime', 'documentURL', 'frameId', 'loaderId', 'type')},
                     'cachedEvents': [], 'dataEvents': [], 'finishedEvents': []}
                v['requestEvent']['request'] = {'url': e['request']['url'], 'method': e['request']['method']}
                self.font_network[e['requestId']] = v;self.result['fontNetwork'].append(v)
            except BaseException as error:
                self.result['captureErrors'].append({**self.binding(), **safe_failure(error)})
        def font_response(e):
            if e['type'] != 'Font':
                return
            v = self.font_network.get(e['requestId'])
            if v is None or 'responseEvent' in v:
                self.result['captureErrors'].append({**self.binding(), 'code': 'font_response_identity'})
                return
            if any(k.lower() == 'set-cookie' for k in e['response'].get('headers', {})):
                self.result['captureErrors'].append({**self.binding(), 'code': 'anonymous_font_response_cookie'})
                return
            v.update(responseAt=now(), responseEvent={**{k: e[k] for k in ('requestId', 'timestamp', 'type', 'frameId', 'loaderId')},
                         'response': {k: e['response'][k] for k in ('url', 'status', 'mimeType', 'encodedDataLength',
                             'fromDiskCache', 'fromServiceWorker', 'fromPrefetchCache', 'serviceWorkerResponseSource',
                             'cacheStorageCacheName', 'headers') if k in e['response']}})
            ready(v)
        def font_more(kind, e):
            v = self.font_network.get(e['requestId'])
            if v is not None:
                v[kind].append({'at': now(), 'event': e});ready(v)
        original_main_frame = {'id': None, 'loaderId': None, 'index': None}
        def public_document_url(url):
            # Unknown URL text never becomes public evidence; a null URL cannot authorize an alias.
            return url if url in (self.ui + '/', self.ui + ENTRY_PATH, self.ui + ENTRY_PATH.split('#')[0], self.ui + '/auth') else None
        def frame_navigated(e):
            f = e['frame']
            if f.get('parentId'):
                return
            original_main_frame.update(id=f['id'], loaderId=f.get('loaderId'))
            if f['url'] == 'about:blank' and original_main_frame['index'] is None:
                return  # Initial created-page realm outside owned document observations.
            value = {**self.binding(), 'at': now(), 'index': len(self.result['documentChronology']),
                     'event': 'Page.frameNavigated', 'frameId': f['id'], 'loaderId': f.get('loaderId'),
                     'url': public_document_url(f['url'])}
            self.result['documentChronology'].append(value)
            original_main_frame['index'] = value['index']
        def within_document(e):
            if e['frameId'] != original_main_frame['id'] or original_main_frame['index'] is None:
                return
            self.result['documentChronology'].append({**self.binding(), 'at': now(),
                'index': len(self.result['documentChronology']), 'event': 'Page.navigatedWithinDocument',
                'frameId': e['frameId'], 'navigationType': e.get('navigationType'),
                'frameEventIndex': original_main_frame['index'],
                'loaderIdFromFrameEvent': original_main_frame['loaderId'], 'url': public_document_url(e['url'])})
        cdp.on('Page.frameNavigated', frame_navigated)
        cdp.on('Page.navigatedWithinDocument', within_document)
        cdp.on('Network.requestWillBeSent', font_request)
        cdp.on('Network.responseReceived', font_response)
        for event, key in [('requestServedFromCache', 'cachedEvents'), ('dataReceived', 'dataEvents'), ('loadingFinished', 'finishedEvents')]:
            cdp.on('Network.' + event, lambda e, key=key: font_more(key, e))
        cdp.on('Network.loadingFailed', lambda e: self.result['captureErrors'].append(
            {**self.binding(), 'code': 'original_cdp_loading_failed', 'cdpRequestId': e['requestId']}))
        page.on('request', self.requested);page.on('response', self.response);page.on('requestfinished', self.finished)
        page.on('requestfailed', lambda q: self.result['requestFailures'].append(
            {**self.binding(), 'id': self.states[q]['row']['id'] if q in self.states else None, 'at': now(),
             'code': 'original_request_failed'}))
        page.on('console', lambda m: self.result['consoleErrors'].append({**self.binding(), 'at': now(),
            'textSHA256': digest(m.text.encode()), 'textByteLength': len(m.text.encode())}) if m.type == 'error' else None)
        page.on('pageerror', lambda e: self.result['pageErrors'].append({**self.binding(), 'at': now(), 'code': 'original_page_error'}))

    async def document(self):
        observed = await self.page.evaluate(DOCUMENT)
        self.safe_url(observed['url'])
        return observed

    async def settle(self):
        proof = await asyncio.wait_for(self.page.evaluate(SETTLE), 5)
        require(proof['url'] == self.page.url and proof['reduced'] == (self.current['motion'] == 'reduced'), 'settlement_scope')
        return proof

    async def drain(self, health=False):
        deadline = asyncio.get_running_loop().time() + 10
        initial = await self.document()
        while True:
            self.changed.clear()
            require(asyncio.get_running_loop().time() < deadline, 'current_document_drain_deadline')
            require(not any(self.result[k] for k in ('captureErrors', 'pageErrors', 'requestFailures', 'consoleErrors')), 'actual_observation_errors')
            current = await self.document()
            require(current['url'] == initial['url'] and current['timeOrigin'] == initial['timeOrigin']
                    and current['readyState'] == 'complete' and current['fontsStatus'] == 'loaded'
                    and all(v is False for v in current['auth'].values()), 'current_anonymous_document')
            rows = [s for s in self.states.values() if s['page'] is self.page]
            complete = all(s['finished'] and s.get('finishedCapture') is not None
                           and s['finishedCapture'].done() and 'bodyKind' in s.get('responseRow', {}) for s in rows)
            if complete and not self.tasks:
                ids = {s['row']['id'] for s in rows}
                require(len(ids) == len(rows), 'current_request_bijection')
                if health:
                    hs = [s for s in rows if s['row']['url'] == self.ui + '/api/health'
                          and s['row']['documentURL'] == current['url']
                          and s['row'].get('documentTimeOrigin') == current['timeOrigin']]
                    require(len(hs) == 1, 'current_terminal_health')
                    h = hs[0]['responseRow'];v = h['json']
                    require(h['status'] == 200 and h['headers'].get('cache-control') == 'no-store'
                            and set(v) == {'status', 'uptime'} and v['status'] == 'ok'
                            and type(v['uptime']) is int and v['uptime'] >= 0, 'original_health_projection')
                require(all(s['responseRow']['status'] == 200 for s in rows), 'unexpected_http_status')
                proof = {**self.binding(), 'at': now(), 'document': current, 'requestIds': sorted(ids),
                         'pendingRequests': 0, 'pendingCaptures': 0, 'terminalHealthRequired': health}
                key = (self.page, self.phase, current['timeOrigin'], current['url'])
                if key not in self.font_proofs:
                    self.font_proofs[key] = await self.font_snapshot(self.cdp)
                proof['fonts'] = self.font_proofs[key]
                self.result['drains'].append(proof)
                return proof
            remaining = deadline - asyncio.get_running_loop().time()
            await asyncio.wait_for(self.changed.wait(), remaining)

    async def font_snapshot(self, cdp):
        frame = (await cdp.send('Page.getFrameTree'))['frameTree']['frame']
        document = await cdp.send('DOM.getDocument', {'depth': 1})
        used = []
        for selector in ['h1', 'p']:
            node = (await cdp.send('DOM.querySelector', {'nodeId': document['root']['nodeId'], 'selector': selector}))['nodeId']
            require(node > 0, 'live_font_node')
            used.append({'selector': selector, 'nodeId': node,
                         'fonts': (await cdp.send('CSS.getPlatformFontsForNode', {'nodeId': node}))['fonts']})
        value = await self.page.evaluate("""()=>{const cssRules=[];for(const sheet of document.styleSheets){
         for(const rule of sheet.cssRules){if(rule.type!==CSSRule.FONT_FACE_RULE)continue;
          const s=rule.style,src=s.getPropertyValue('src'),m=/^url\\(["']?(\\.\\/[a-zA-Z0-9_.-]+\\.woff2)["']?\\) format\\(["']woff2["']\\)$/.exec(src);
          if(!m)throw Error('unsupported_font_source');cssRules.push({stylesheetURL:sheet.href,family:s.getPropertyValue('font-family'),
           style:s.getPropertyValue('font-style'),weight:s.getPropertyValue('font-weight'),unicodeRange:s.getPropertyValue('unicode-range'),
           src,url:new URL(m[1],sheet.href).href})}}
         return {observation:'live-CSSOM-and-platform-fonts',documentURL:location.href,fontsStatus:document.fonts.status,cssRules,
          fontFaces:[...document.fonts].map(f=>({family:f.family,status:f.status,weight:f.weight,style:f.style,unicodeRange:f.unicodeRange}))}}""")
        value.update(at=now(), frameId=frame['id'], loaderId=frame['loaderId'], usedFonts=used)
        require(value['fontsStatus'] == 'loaded' and any(f['isCustomFont'] and f['glyphCount'] > 0 for u in used for f in u['fonts']), 'actual_custom_fonts')
        return value

    def close_event(self, identity, event, **values):
        self.result.setdefault('closeJournal', []).append({**identity, 'event': event, 'at': now(), **values})

    async def teardown_drain(self):
        # Only the unloaded document: original scenario/font/geometry checks are unchanged.
        deadline = asyncio.get_running_loop().time() + 10
        while True:
            self.changed.clear()
            require(self.phase == 'teardown-unload' and self.page.url == 'about:blank', 'unloaded_teardown_scope')
            require(asyncio.get_running_loop().time() < deadline, 'teardown_capture_deadline')
            require(not any(self.result[k] for k in ('captureErrors', 'pageErrors', 'requestFailures', 'consoleErrors')), 'actual_observation_errors')
            rows = [s for s in self.states.values() if s['page'] is self.page]
            complete = all(s['finished'] and s.get('finishedCapture') is not None
                           and s['finishedCapture'].done() and 'bodyKind' in s.get('responseRow', {}) for s in rows)
            if complete and not self.tasks:
                ids = {s['row']['id'] for s in rows}
                require(len(ids) == len(rows), 'current_request_bijection')
                require(all(s['responseRow']['status'] == 200 for s in rows), 'unexpected_http_status')
                self.result['drains'].append({**self.binding(), 'at': now(),
                    'document': {'url': 'about:blank', 'observedVia': 'page.url'},
                    'requestIds': sorted(ids), 'pendingRequests': 0, 'pendingCaptures': 0,
                    'terminalHealthRequired': False, 'teardownOnly': True})
                return
            await asyncio.wait_for(self.changed.wait(), max(0, deadline - asyncio.get_running_loop().time()))

    async def phase_end(self):
        if self.active_phase is None:
            return
        record, complete = self.active_phase, False
        try:
            if record['name'] == 'teardown-unload':
                await self.teardown_drain()
            else:
                await self.drain(health=False)
            complete = True
        finally:
            record.update(finishedAt=now(), requestIds=[r['id'] for r in self.result['requests']
                if r['caseId'] == record['caseId'] and r['phase'] == record['name']], captured=complete)
            record['fontProofs'] = [] if record['name'] == 'teardown-unload' else [d['fonts'] for d in self.result['drains']
                if d['caseId'] == record['caseId'] and d['phase'] == record['name']]
            self.result['phases'].append(record)
            self.active_phase = None

    async def phase_start(self, name):
        await self.phase_end()
        self.phase = name
        self.active_phase = {'caseId': self.current['id'], 'name': name, 'startedAt': now()}

    def button(self, name):
        return self.page.get_by_role('button', name=name, exact=True)

    async def mounted(self, scene, language=None):
        language = language or self.current['language']
        await expect(self.page.get_by_role('heading', name=TITLES[language][scene - 1], exact=True)).to_be_visible(timeout=5000)
        require(self.page.url == self.ui + ENTRY_PATH, 'onboarding_route')
        return await self.settle()

    async def controls(self, scene, language=None):
        language = language or self.current['language'];t = TEXT[language]
        names = ['EN' if language == 'ru' else 'RU', t['skip'],
                 *[t['slide'] + ' ' + str(i) for i in range(1, 5)],
                 *([t['back']] if scene > 1 else []), t['start'] if scene == 4 else t['next']]
        require(len(names) == (7 if scene == 1 else 8), 'mandatory_control_count')
        proofs = []
        for name in names:
            button = self.button(name)
            require(await button.count() == 1 and await button.is_visible() and await button.is_enabled(), 'mandatory_control_eligible')
            box = await button.bounding_box()
            require(box and 0 <= box['x'] and box['x'] + box['width'] <= self.current['width']
                    and 0 <= box['y'] and box['y'] + box['height'] <= 844, 'mandatory_control_viewport_before_filter')
            proofs.append({'name': name, 'box': box})
        return proofs

    async def geometry(self, scene):
        mandatory = await self.controls(scene)
        g = await self.page.evaluate('names=>(' + SUMMARY_GEOMETRY + ')({names,measure:(' + CONTENT_GEOMETRY + ')})', [])
        self.result['geometryDiagnostics'].append({**self.binding(), 'at': now(), 'scene': scene,
            'guard': 'actual_geometry_summary', 'controlIdentifier': None,
            'mandatory': copy.deepcopy(mandatory), 'g': copy.deepcopy(g), 'exact': None})
        require(g['documentWidth'] <= self.current['width'] and g['controlsUnobscured']
                and g['visibleNamesWithinViewport'], 'actual_geometry_summary')
        g['controls'] = []
        for control_index, control in enumerate(await self.page.locator('button,a,input,select,textarea').all()):
            if not await control.is_visible() or await control.is_disabled():
                continue
            box = await control.bounding_box()
            if box is None or box['y'] < 0 or box['y'] + box['height'] > 844:
                continue
            exact = await control.evaluate('el=>{const s=(' + SHOT_GEOMETRY + ')(el);s.content=(' + CONTENT_GEOMETRY + ')(el);return s}')
            self.result['geometryDiagnostics'].append({**self.binding(), 'at': now(), 'scene': scene,
                'guard': 'actual_exact_nine_geometry',
                'controlIdentifier': {'selector': 'button,a,input,select,textarea', 'index': control_index},
                'mandatory': copy.deepcopy(mandatory), 'g': copy.deepcopy(g), 'exact': copy.deepcopy(exact)})
            require(exact['unobscured'] and exact['content']['qualified']
                    and 0 <= exact['left'] < exact['right'] <= self.current['width']
                    and [p['name'] for p in exact['hits']] == POINTS, 'actual_exact_nine_geometry')
            g['controls'].append(exact)
        return {'mandatory': mandatory, 'actual': g}

    async def png(self, stem):
        require(re.fullmatch(r'[A-Za-z0-9_-]+', stem), 'owned_image_name')
        document = await self.document()
        require(all(v is False for v in document['auth'].values()), 'anonymous_image_document')
        raw = await self.page.screenshot(full_page=True, animations='allow')
        path = self.out / (stem + '.png')
        with path.open('xb') as stream:
            stream.write(raw)
        return {'path': str(path).replace('\\', '/'), 'file': path.name, 'sha256': digest(raw),
                'width': self.current['width'], 'viewportHeight': 844, 'scale': 1, 'cropped': False,
                'animations': 'allow', 'at': now()}

    async def open_entry(self):
        # goto() to the URL the page already shows (same path, query and #intro) is a
        # same-document fragment navigation: no new document, the app keeps its scene.
        # A fresh entry document therefore needs reload() in that case.
        if self.page.url == self.ui + ENTRY_PATH:
            await self.page.reload(wait_until='networkidle', timeout=5000)
        else:
            await self.page.goto(self.ui + ENTRY_PATH, wait_until='networkidle', timeout=5000)
        require(self.page.url == self.ui + ENTRY_PATH, 'fresh_entry_document')

    async def navigate_cell(self, scene):
        if self.page.url != 'about:blank':
            await self.drain(health=False)
        await self.open_entry()
        await self.mounted(1)
        if scene > 1:
            await self.scene_click(TEXT[self.current['language']]['slide'] + ' ' + str(scene), 1, scene)
        await self.drain(health=self.current['network'] == 'online')

    async def scene_click(self, name, before_scene, after_scene, language=None):
        language = language or self.current['language']
        await self.mounted(before_scene, language)
        before = await self.document()
        target = self.button(name)
        await target.evaluate(POINTER_INSTALL)
        events = None
        try:
            await target.click(timeout=5000)
            await self.mounted(after_scene, language)
            after = await self.document()
            events = await self.page.evaluate(POINTER_REMOVE)
            require(before['timeOrigin'] == after['timeOrigin'] and before['url'] == after['url']
                    and events and all(e['isTrusted'] for e in events)
                    and any(e['type'] == 'click' and e['contained'] for e in events), 'real_scene_action')
            self.current_case['actions'].append({'kind': 'actual-scene-click', 'control': name,
                'beforeScene': before_scene, 'afterScene': after_scene, 'before': before, 'after': after,
                'heading': TITLES[language][after_scene - 1], 'pointerEvents': events})
        finally:
            if events is None and not self.page.is_closed():
                await self.page.evaluate(POINTER_REMOVE)

    async def interactions(self, scene):
        await self.phase_start('actual-next-back-dots')
        t = TEXT[self.current['language']]
        if scene < 4:
            await self.scene_click(t['next'], scene, scene + 1)
            await self.scene_click(t['back'], scene + 1, scene)
        elif scene > 1:
            await self.scene_click(t['back'], scene, scene - 1)
            await self.scene_click(t['next'], scene - 1, scene)
        other = 1 if scene != 1 else 4
        await self.scene_click(t['slide'] + ' ' + str(other), scene, other)
        await self.scene_click(t['slide'] + ' ' + str(scene), other, scene)
        for index, target_language in enumerate([('en' if self.current['language'] == 'ru' else 'ru'), self.current['language']]):
            await self.drain(health=self.current['network'] == 'online')
            await self.phase_start('language-opposite-reload' if index == 0 else 'language-original-reload')
            before = await self.document()
            await self.button('EN' if before['language'] == 'ru' else 'RU').click(timeout=5000)
            await self.page.wait_for_function('(old)=>performance.timeOrigin>old', arg=before['timeOrigin'], timeout=5000)
            await self.mounted(1, target_language)
            after = await self.document()
            require(after['url'] == before['url'] and after['language'] == target_language
                    and await self.page.evaluate("localStorage.getItem('tt_lang')") == target_language
                    and await self.page.evaluate("sessionStorage.getItem('tt_redirect')") is None, 'real_language_reload')
            if scene > 1:
                await self.scene_click(TEXT[target_language]['slide'] + ' ' + str(scene), 1, scene, target_language)
            await self.drain(health=self.current['network'] == 'online')
            self.current_case['actions'].append({'kind': 'actual-language-reload', 'before': before, 'after': after})
        self.current_case['actions'].append({'kind': 'actual-next-back-dots', 'scene': scene, 'at': now()})

    async def trial(self, scene, kind, point_index):
        await self.phase_start('trial-' + kind + '-' + POINTS[point_index])
        await self.navigate_cell(scene)
        await self.geometry(scene)
        button = self.button(TEXT[self.current['language']][kind])
        original = await button.evaluate('el=>{const s=(' + SHOT_GEOMETRY + ')(el);s.content=(' + CONTENT_GEOMETRY + ')(el);return s}')
        point = original['hits'][point_index]
        require(point['contained'], 'original_point_eligible')
        witness = await button.evaluate(POINTER_INSTALL)
        record = {**self.binding(), 'kind': kind, 'point': point, 'original': original, 'document': witness,
                  'status': 'TRIAL_RUNNING'}
        self.current_case['trials'].append(record)
        down = False
        try:
            await self.page.mouse.move(point['x'], point['y'])
            await self.page.mouse.down();down = True
            record['settlement'] = await self.settle()
            record['active'] = await button.evaluate('el=>({active:el.matches(":active"),connected:el.isConnected,transform:getComputedStyle(el).transform})')
            require(record['active']['active'] and record['active']['connected'], 'actual_held_active')
            record['heldGeometry'] = await button.evaluate('el=>{const s=(' + SHOT_GEOMETRY + ')(el);s.content=(' + CONTENT_GEOMETRY + ')(el);return s}')
            held = await self.png(self.current['id'] + '-' + kind + '-' + point['name'] + '-held')
            record['heldImage'] = held;self.result['held'].append({**self.binding(), **held, 'kind': kind, 'pointName': point['name']})
            await self.page.mouse.up();down = False
            # Original absolute pointer is unchanged while active scale transforms the target.
            await expect(self.page.get_by_role('heading', name=TEXT[self.current['language']]['auth'], exact=True)).to_be_visible(timeout=5000)
            require(self.page.url == self.ui + '/auth' and await self.page.locator('input[type=tel]').count() == 1, 'actual_mounted_auth')
            record['pointerEvents'] = await self.page.evaluate(POINTER_REMOVE)
            rows = record['pointerEvents']
            require(pointer_events_valid(rows, point, witness['timeOrigin']), 'original_trusted_release')
            await self.settle();await self.drain(health=False)
            record.update(status='TRIAL_COLLECTION_COMPLETE_UNQUALIFIED', destination=await self.document())
            require(record['destination']['timeOrigin'] == witness['timeOrigin'], 'actual_same_document_auth')
        except BaseException as error:
            record.update(status='TRIAL_FAILED', failure=safe_failure(error))
            raise
        finally:
            if down:
                await self.page.mouse.up()
            if 'pointerEvents' not in record and not self.page.is_closed():
                record['pointerEvents'] = await self.page.evaluate(POINTER_REMOVE)

    async def warm(self, cdp):
        await self.page.goto(self.ui + ENTRY_PATH, wait_until='networkidle', timeout=5000)
        await self.mounted(1);await self.drain(health=True)
        await asyncio.wait_for(self.page.evaluate('navigator.serviceWorker.ready'), 5)
        await self.page.wait_for_function('navigator.serviceWorker.controller!==null', timeout=5000)
        require(await self.page.evaluate('navigator.serviceWorker.ready.then(r=>r.scope)') == self.ui + '/', 'actual_sw_scope')
        # Registration starts at the original load event: warm a genuine controlled document before offline.
        await self.drain(health=True)
        await self.open_entry()
        await self.mounted(1);await self.drain(health=True)
        fonts = await self.font_snapshot(cdp)
        cached = await self.page.evaluate("""async()=>{const rows=[];for(const name of await caches.keys()){
         const c=await caches.open(name);for(const key of await c.keys()){const r=await c.match(key),b=await r.arrayBuffer();
          rows.push({name,url:key.url,status:r.status,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b))).map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase()})}}return rows}""")
        require(cached and all((urlsplit(v['url']).path[1:] or 'index.html') in self.builds
                  and v['status'] == 200 and v['sha256'] == self.builds[urlsplit(v['url']).path[1:] or 'index.html']
                  and not urlsplit(v['url']).query and self.safe_url(v['url']) for v in cached), 'actual_compiled_cache')
        require(any(urlsplit(v['url']).path == '/index.html' for v in cached), 'actual_cached_root')
        font_urls = {s['row']['url'] for s in self.states.values() if s['page'] is self.page and s['row']['resourceType'] == 'font'}
        require(font_urls and font_urls.issubset({v['url'] for v in cached}), 'actual_cached_used_fonts')
        await self.drain(health=True)
        self.current_case['warm'] = {'at': now(), 'document': await self.document(), 'fonts': fonts, 'cache': cached}

    async def case(self, spec):
        self.current = spec;self.phase = 'online-warm'
        context = await self.browser.new_context(viewport={'width': spec['width'], 'height': 844},
                        reduced_motion='reduce' if spec['motion'] == 'reduced' else 'no-preference', service_workers='allow')
        self.contexts.append(context);self.result['contextsCreated'] += 1
        probe_value = uuid.uuid4().hex + uuid.uuid4().hex
        self._probe_value = probe_value  # In-memory only, for evidence redaction.
        self._probe_case_sha256 = digest(probe_value.encode('ascii'))
        identity = {'caseId': spec['id'], 'caseCookieSHA256': self._probe_case_sha256}
        context.on('close', lambda: self.close_event(identity, 'context-close'))
        await context.add_cookies([{'name': 'tt_probe_case', 'value': probe_value,
            'url': self.ui + '/', 'httpOnly': True, 'sameSite': 'Lax', 'secure': False}])
        self.result.setdefault('caseProbes', []).append({**identity, 'at': now(), 'cookieAddedBeforeNavigation': True})
        # Device preferences only. Never install auth/onboarded/wedding/route state.
        await context.add_init_script("(()=>{if(location.origin===ORIGIN&&!sessionStorage.getItem('onboarding_pref_seed')){localStorage.setItem('tt_lang',LANG);localStorage.setItem('tt_theme','dark');sessionStorage.setItem('onboarding_pref_seed','1')}})()".replace('ORIGIN', json.dumps(self.ui)).replace('LANG', json.dumps(spec['language'])))
        self.page = await context.new_page()
        self.page.on('close', lambda: self.close_event(identity, 'page-close'))
        cdp = await context.new_cdp_session(self.page);self.cdp = cdp;self.attach(self.page, cdp)
        for domain in ('Page', 'Network', 'DOM', 'CSS'):
            await cdp.send(domain + '.enable')
        row = {**spec, 'status': 'CASE_RUNNING', 'trials': [], 'actions': []}
        self.current_case = row;self.result['cases'].append(row)
        self.active_phase = {'caseId': spec['id'], 'name': 'online-warm', 'startedAt': now()}
        try:
            await self.warm(cdp)
            if spec['network'] == 'offline':
                await self.phase_start('offline-entry');await context.set_offline(True)
            else:
                await self.phase_start('online-entry')
            await self.navigate_cell(spec['scene'])
            if spec['network'] == 'offline':
                await expect(self.page.get_by_text(TEXT[spec['language']]['offline'], exact=True)).to_be_visible(timeout=5000)
            await self.phase_start('primary')
            settlement = await self.mounted(spec['scene'])
            geometry = await self.geometry(spec['scene'])
            fonts = await self.font_snapshot(cdp)
            image = await self.png(spec['id'] + '-primary')
            row['primary'] = {**image, 'settlement': settlement, 'geometry': geometry, 'fonts': fonts,
                              'document': await self.document()}
            self.result['layouts'].append({'caseId': spec['id'], 'state': 'primary', **row['primary']})
            await self.interactions(spec['scene'])
            for kind in ['skip'] + (['start'] if spec['scene'] == 4 else []):
                for index in range(9):
                    await self.trial(spec['scene'], kind, index)
            row['status'] = 'CASE_COLLECTION_COMPLETE_UNQUALIFIED'
        except BaseException as error:
            row.update(status='CASE_FAILED', failure=safe_failure(error))
            if not self.page.is_closed():
                try:
                    self.safe_url(self.page.url)
                    row['failureImage'] = await self.png(spec['id'] + '-failure-diagnostic')
                except BaseException as image_error:
                    row['failureImageError'] = safe_failure(image_error)
            raise
        finally:
            try:
                await self.phase_end()
                self.close_event(identity, 'phase-end', phase=self.phase, kind='scenario')
                if not getattr(self, '_old_close_control', False):
                    await self.phase_start('teardown-unload')
                    self.close_event(identity, 'unload-start')
                    try:
                        await self.page.goto('about:blank', wait_until='load', timeout=5000)
                        require(self.page.url == 'about:blank', 'application_unloaded')
                        self.close_event(identity, 'unload-done', url='about:blank')
                    except BaseException as error:
                        failure = safe_failure(error)
                        self.result['captureErrors'].append({**identity, 'phase': 'teardown-unload', 'code': 'unload_failed', **failure})
                        self.close_event(identity, 'unload-error', failure=failure)
                        raise
                    finally:
                        await self.phase_end()
                    self.close_event(identity, 'phase-end', phase='teardown-unload', kind='teardown')
                else:
                    self.close_event(identity, 'unload-skipped', reason='positive-old-order-control')
            finally:
                self.close_event(identity, 'close-call')
                try:
                    await context.close()
                    self.result['contextsClosed'] += 1;self.contexts.remove(context)
                finally:
                    self.close_event(identity, 'close-return')

    async def run(self):
        try:
            async with async_playwright() as pw:
                self.browser = await pw.chromium.launch(executable_path=self.admission['chromium']['path'], headless=True)
                self.result['browserVersion'] = self.browser.version
                require(self.browser.version == self.admission['chromium']['version'], 'actual_chromium_version')
                try:
                    for spec in self.admission['matrix']:
                        await self.case(spec)
                    require(len(self.result['cases']) == 96 and len(self.result['layouts']) == 96
                            and len(self.result['held']) == 1080
                            and all(r['status'] == 'CASE_COLLECTION_COMPLETE_UNQUALIFIED' for r in self.result['cases']), 'whole96_collection')
                    self.result['status'] = 'COLLECTION_COMPLETE_UNQUALIFIED'
                finally:
                    for context in list(self.contexts):
                        await context.close();self.result['contextsClosed'] += 1;self.contexts.remove(context)
                    await self.browser.close();self.result['browserClosed'] = True
        except BaseException as error:
            self.result['status'] = 'COLLECTION_FAILED'
            self.result['failures'].append(safe_failure(error))
        finally:
            deadline = asyncio.get_running_loop().time() + 10
            if self.tasks:
                _, pending = await asyncio.wait(list(self.tasks), timeout=max(0, deadline - asyncio.get_running_loop().time()))
                for task in pending:
                    task.cancel()
                if pending:
                    await asyncio.gather(*pending, return_exceptions=True)
                    self.result['captureErrors'].append({'code': 'capture_cleanup_deadline'})
            try:
                self.result['finishedTaskCleanup'] = await self.finished_owner.drain(deadline)
            except BaseException as error:
                self.result['failures'].append(safe_failure(error));self.result['status'] = 'COLLECTION_FAILED'
            if any(self.result[k] for k in ('captureErrors', 'pageErrors', 'requestFailures', 'consoleErrors', 'failures')):
                self.result['status'] = 'COLLECTION_FAILED'
            self.result['observedCounts'] = {k: len(self.result[k]) for k in ('cases', 'layouts', 'held', 'requests', 'responses', 'finished',
                                                       'consoleErrors', 'pageErrors', 'captureErrors', 'requestFailures')}


async def main():
    out = pathlib.Path(os.environ['ONBOARDING_OUT']).resolve()
    require(out.parent == pathlib.Path('C:/Тили-тили/.unlazy/wp03-onboarding-20261010').resolve()
            and re.fullmatch(r'browser-[0-9a-f-]{36}', out.name) and out.is_dir(), 'owned_output')
    raw = (out / 'admission.json').read_bytes();admission = json.loads(raw)
    require(str(uuid.UUID(admission['runId'])) == admission['runId'] == out.name[8:], 'owned_run_uuid')
    observer = Observer(out, admission, raw)
    try:
        with observer.finished_owner:
            await observer.run()
    except BaseException as error:
        observer.result['status'] = 'COLLECTION_FAILED';observer.result['failures'].append(safe_failure(error))
    finally:
        write_new(out / 'browser-result.json', observer.result)
    return observer.result['status'] == 'COLLECTION_COMPLETE_UNQUALIFIED'


async def owned_run():
    out = pathlib.Path(os.environ['ONBOARDING_OUT']).resolve()
    admission = json.loads((out / 'admission.json').read_bytes())
    running = asyncio.create_task(main())
    async def stop():
        while not running.done():
            path = out / 'stop.request.json'
            if path.exists():
                try:
                    value = json.loads(path.read_bytes())
                    require(value['runId'] == admission['runId'], 'owned_stop_identity')
                except Exception:
                    running.cancel();return
                running.cancel();return
            await asyncio.sleep(.05)
    watcher = asyncio.create_task(stop())
    try:
        return await running
    finally:
        watcher.cancel();await asyncio.gather(watcher, return_exceptions=True)


if __name__ == '__main__':
    raise SystemExit(0 if asyncio.run(owned_run()) else 1)
