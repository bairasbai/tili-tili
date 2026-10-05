"""Real API/PostgreSQL weekly reader. Only fixture setup writes disposable test data.
Never export credentials, browser storage or invitation links.
"""
import datetime
import json
import os
import pathlib
import re
import traceback
import uuid
from zoneinfo import ZoneInfo
from playwright.sync_api import expect, sync_playwright

out = pathlib.Path(os.environ['E2E_RESULT_DIR']); out.mkdir(parents=True, exist_ok=True)
f = json.loads(pathlib.Path(os.environ['E2E_FIXTURE_FILE']).read_text())
wid = f['weddingId']; api = 'http://127.0.0.1:3001'; ui = 'http://127.0.0.1:3000'
passed, errors, http_errors, writes = [], [], [], []
with sync_playwright() as pw:
    options = {'headless': True}
    if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'):
        options['executable_path'] = os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']
    browser = pw.chromium.launch(**options); setup = browser.new_context(); page = None
    def req(method, path, body=None):
        r = setup.request.fetch(api+path, method=method, data=body, headers={
            'authorization': 'Bearer '+f['owner']['tokens']['accessToken'], 'idempotency-key': str(uuid.uuid4())})
        assert r.ok, f'{method} {path}: {r.status} {r.text()}'
        return r.json() if r.status != 204 else None
    def money(n): return {'amount': n, 'currency': 'RUB'}
    def context(person, lang, width):
        c = browser.new_context(viewport={'width': width, 'height': 900})
        c.add_init_script("""(() => {const f=%s;
          if(!localStorage.getItem('tt_auth')) {
            localStorage.setItem('tt_auth',JSON.stringify({accessToken:f.tokens.accessToken,refreshToken:f.tokens.refreshToken}));
            localStorage.setItem('tt_onboarded','1');localStorage.setItem('tt_wedding_id',JSON.stringify(%s));
            localStorage.setItem('tt_wedding_date',JSON.stringify('2027-06-14'));
          } localStorage.setItem('tt_lang',JSON.stringify(%s));
        })();""" % (json.dumps(person), json.dumps(wid), json.dumps(lang)))
        return c
    def observe(p):
        p.on('pageerror', lambda e: errors.append(str(e)))
        p.on('request', lambda r: writes.append({'path':r.url.split('?')[0],'method':r.method}) if '/api/' in r.url and r.method not in ('GET','HEAD','OPTIONS') else None)
        p.on('response', lambda r: http_errors.append({'path':r.url.split('?')[0],'status':r.status}) if r.status >= 400 else None)
    def proof():
        s = req('GET',f'/weddings/{wid}/payment-schedule?from={start}&to={end}&includeOverdue=true&includeCancelled=false')
        return {'tasks':sorted((x['id'],x['done'],x['due']) for x in req('GET',f'/weddings/{wid}/tasks')),
            'guests':sorted((x['id'],x['partyId'],x['status']) for x in req('GET',f'/weddings/{wid}/guests')),
            'installments':sorted((x['id'],x['status'],x['remaining']['amount']) for x in s['allInstallments']),
            'payments':sorted((x['id'],x['amountKnown'],x['version']) for x in s['payments'])}
    try:
        wedding=req('GET',f'/weddings/{wid}'); today=datetime.datetime.now(ZoneInfo(wedding['tz'])).date()
        start=(today-datetime.timedelta(days=today.weekday())).isoformat()
        end=(today+datetime.timedelta(days=6-today.weekday())).isoformat()
        later=(datetime.date.fromisoformat(end)+datetime.timedelta(days=1)).isoformat()
        for name,due in [('Weekly overdue fixture',(today-datetime.timedelta(days=9)).isoformat()),('Weekly undated fixture',None),('Weekly future fixture',later)]:
            req('POST',f'/weddings/{wid}/tasks',{'title':name,'period':'1','dueMode':'fixed','due':due,'assigneeId':f['helper']['id']})
        imp=req('POST',f'/weddings/{wid}/guests/import',{'guests':[{'name':'Weekly family primary','members':[{'name':'Weekly second person'},{'name':'Weekly third person'}]}]})
        assert len(imp['created'])==1 and imp['created'][0]['partySize']==3
        slot=next(s for s in req('GET',f'/weddings/{wid}/slots') if s['categoryId']=='photo' and not s['deal'])
        deal=req('POST',f'/weddings/{wid}/slots/{slot["id"]}/external',{'vendorName':'Weekly photo fixture','price':money(1000000)})['deal']['id']
        stage=req('POST',f'/weddings/{wid}/payment-schedule',{'dealId':deal,'title':'Weekly payment fixture','amount':money(125099),'due':end})
        req('POST',f'/weddings/{wid}/payment-schedule/{stage["id"]}/pay',{'version':stage['version'],'amount':money(25000),'amountKnown':True,'paymentMethod':'other','visibility':'private','paidOn':today.isoformat()})
        req('POST',f'/weddings/{wid}/payment-schedule',{'dealId':deal,'title':'Weekly future payment fixture','amount':money(50000),'due':later})
        before=proof()
        for lang in ('ru','en'):
            labels={'open':'Открыть недельную сводку','payments':'Платежи этой недели','refresh':'Обновить сводку','retry':'Повторить','people':'3 персоны ждут ответа'} if lang=='ru' else {
                'open':'Open weekly agenda','payments':'Payments this week','refresh':'Refresh agenda','retry':'Retry','people':'3 people awaiting replies'}
            for width in (320,390,1280):
                c=context(f['owner'],lang,width);page=c.new_page();observe(page)
                page.goto(ui+'/home',wait_until='networkidle')
                page.get_by_role('button',name=re.compile('^'+labels['open'])).click()
                expect(page).to_have_url(ui+'/wedding/week')
                for name in ('Weekly overdue fixture','Weekly undated fixture','Weekly payment fixture',labels['people']):
                    expect(page.get_by_text(name,exact=True)).to_be_visible()
                for name in ('Weekly future fixture','Weekly future payment fixture'):
                    expect(page.get_by_text(name,exact=True)).to_have_count(0)
                assert page.locator('[data-testid="week-range"] time').evaluate_all('(xs)=>xs.map(x=>x.dateTime)')==[start,end]
                payments=page.get_by_role('region',name=labels['payments'],exact=True)
                assert re.search(r'1\s000,99',payments.inner_text()),payments.inner_text()
                assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth+1'),f'overflow {lang}/{width}'
                page.screenshot(path=str(out/f'{lang}-{width}-weekly.png'),full_page=True)
                passed.append(f'{lang}-{width}: actual data, week, person count, amount and layout')
                for title,route in [('Weekly overdue fixture','/wedding/checklist'),('Weekly payment fixture','/wedding/payments'),('Weekly second person','/wedding/guests')]:
                    page.locator(f'a[href="{route}"]').filter(has_text=title).click();expect(page).to_have_url(ui+route)
                    page.go_back(wait_until='networkidle');expect(page.get_by_text('Weekly payment fixture',exact=True)).to_be_visible()
                    passed.append(f'{lang}-{width}: read-only navigation {route}')
                if (lang,width) in [('ru',320),('en',1280)]:
                    route=re.compile(re.escape(ui+f'/api/weddings/{wid}/payment-schedule')+r'(?:\?.*)?$')
                    def refuse(r): r.fulfill(status=503,content_type='application/json',body=json.dumps({'error':{'message':'Weekly transport fixture unavailable'}}))
                    page.route(route,refuse);page.get_by_role('button',name=labels['refresh'],exact=True).click()
                    payments=page.get_by_role('region',name=labels['payments'],exact=True)
                    expect(payments.get_by_role('alert')).to_be_visible();expect(payments.get_by_text('Weekly payment fixture',exact=True)).to_have_count(0)
                    expect(page.get_by_text('Weekly overdue fixture',exact=True)).to_be_visible();expect(page.get_by_text(labels['people'],exact=True)).to_be_visible()
                    page.screenshot(path=str(out/f'{lang}-{width}-payment-failure.png'),full_page=True)
                    passed.append(f'{lang}-{width}: controlled 503 hides stale money, preserves other sources')
                    page.unroute(route,refuse);payments.get_by_role('button',name=labels['retry'],exact=True).click()
                    expect(page.get_by_text('Weekly payment fixture',exact=True)).to_be_visible()
                    passed.append(f'{lang}-{width}: explicit retry restores real API data')
                c.close()
        c=context(f['helper'],'ru',390);page=c.new_page();observe(page);page.goto(ui+'/wedding/week',wait_until='networkidle')
        payments=page.get_by_role('region',name='Платежи этой недели',exact=True)
        expect(payments.get_by_text('Weekly payment fixture',exact=True)).to_have_count(0)
        expect(payments.get_by_role('link')).to_have_count(0);expect(payments.get_by_role('button',name='Повторить',exact=True)).to_have_count(0)
        expect(page.get_by_text('Weekly overdue fixture',exact=True)).to_be_visible()
        assert any(r['status']==403 and r['path'].endswith('/payment-schedule') for r in http_errors)
        page.screenshot(path=str(out/'helper-390-weekly.png'),full_page=True);c.close()
        passed.append('real helper financial refusal with accessible tasks')
        after=proof();assert before==after,'Reader mutated domain data';assert not writes,writes;assert not errors,errors
        assert all(r['path'].endswith('/payment-schedule') and r['status'] in (403,503) for r in http_errors),http_errors
        passed.append('unchanged domain IDs, states, amounts; no browser writes')
        result={'passed':passed,'page_errors':errors,'http_errors':http_errors,'browser_writes':writes,'before':before,'after':after,
                'browser':browser.version,'range':{'from':start,'to':end,'timeZone':wedding['tz']},'limits':'Actual API/PostgreSQL; two controlled HTTP503 injections; Chromium viewports, not physical devices.'}
        (out/'weekly-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
        print(json.dumps({'passed':len(passed),'page_errors':errors,'browser_writes':writes}))
    except Exception:
        error=re.sub(r'eyJ[\w-]+\.[\w-]+\.[\w-]+','[redacted-token]',traceback.format_exc())
        (out/'weekly-result.json').write_text(json.dumps({'passed':passed,'page_errors':errors,'http_errors':http_errors,'error':error},ensure_ascii=False,indent=2))
        if page and not page.is_closed(): page.screenshot(path=str(out/'weekly-failure.png'),full_page=True)
        raise
    finally:
        browser.close()
