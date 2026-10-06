"""FR005 through the real page and API; synthetic data in this job's disposable DB only."""
import json
import os
import pathlib
import re
import traceback
from playwright.sync_api import sync_playwright, expect

out = pathlib.Path(os.environ['E2E_RESULT_DIR']); out.mkdir(parents=True, exist_ok=True)
f = json.loads(pathlib.Path(os.environ['E2E_FIXTURE_FILE']).read_text())
wid = f['weddingId']; api = 'http://127.0.0.1:3001'; ui = 'http://127.0.0.1:3000'
passed, page_errors, writes = [], [], []
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True); setup = browser.new_context(); page = None
    def request(method, path, body=None):
        result = setup.request.fetch(api + path, method=method, data=body, headers=f['owner']['headers'])
        assert result.ok, f'Fixture API refused {method}: {result.status}'
        return result.json()
    def context(person, lang, width):
        c = browser.new_context(viewport={'width': width, 'height': 900})
        c.add_init_script("""(() => { const f=%s;
          if (!localStorage.getItem('tt_auth')) {
            localStorage.setItem('tt_auth', JSON.stringify({accessToken:f.tokens.accessToken,refreshToken:f.tokens.refreshToken}));
            localStorage.setItem('tt_onboarded','1'); localStorage.setItem('tt_wedding_id',JSON.stringify(%s));
            localStorage.setItem('tt_wedding_date',JSON.stringify('2027-06-14'));
          } localStorage.setItem('tt_lang',%s);
        })();""" % (json.dumps(person), json.dumps(wid), json.dumps(lang)))
        p = c.new_page(); p.on('pageerror', lambda error: page_errors.append(str(error)))
        p.on('request', lambda req: writes.append({'path': req.url.split('?')[0], 'method': req.method}) if '/api/' in req.url and req.method not in ('GET','HEAD','OPTIONS') else None)
        return c,p
    try:
        pairs=[]
        for lang in ('ru','en'):
            text = {'region':'Зависимости задачи','edit':'Изменить зависимости','save':'Сохранить зависимости','complete':'Отметить выполненной','reason':'Причина ручного решения','override':'Завершить с указанной причиной','undo':'Снять отметку'} if lang=='ru' else {
                'region':'Task dependencies','edit':'Edit dependencies','save':'Save dependencies','complete':'Mark as done','reason':'Reason for the manual decision','override':'Complete with this reason','undo':'Unmark as done'}
            for width in (320,390,1280):
                a=request('POST',f'/weddings/{wid}/tasks',{'title':f'FR005 {lang} {width} guest replies','period':'1','due':None})
                b=request('POST',f'/weddings/{wid}/tasks',{'title':f'FR005 {lang} {width} final menu','period':'1','due':None})
                pairs.append((a,b)); c,page=context(f['owner'],lang,width)
                page.goto(ui+f'/wedding/checklist?wedding={wid}&task={b["id"]}',wait_until='networkidle')
                assert page.evaluate("localStorage.getItem('tt_lang')")==lang
                section=page.get_by_role('region',name=text['region'],exact=True)
                section.get_by_role('button',name=text['edit'],exact=True).click()
                section.get_by_role('checkbox',name=a['title'],exact=True).check()
                section.get_by_role('button',name=text['save'],exact=True).click()
                expect(section.get_by_role('link',name=a['title'],exact=True)).to_be_visible()
                actual=next(t for t in request('GET',f'/weddings/{wid}/tasks') if t['id']==b['id'])
                assert [d['id'] for d in actual['dependencies']]==[a['id']] and not actual['done']
                passed.append(f'{lang}/{width}: UI saved exact prerequisite and API retained it')
                before=len(writes)
                row=page.get_by_role('button',name=b['title'],exact=True).locator('..')
                row.get_by_role('button',name=text['complete'],exact=True).click()
                expect(section.get_by_role('button',name=text['override'],exact=True)).to_be_disabled()
                assert len(writes)==before,'Blocked ordinary completion must not send a mutation'
                reason=f'Synthetic reviewed menu decision {lang} {width}'
                section.get_by_role('textbox',name=text['reason'],exact=True).fill(reason)
                section.get_by_role('button',name=text['override'],exact=True).click()
                expect(row.get_by_role('button',name=text['undo'],exact=True)).to_be_visible()
                page.reload(wait_until='networkidle')
                section=page.get_by_role('region',name=text['region'],exact=True)
                expect(section.get_by_text(re.compile(re.escape(reason)))).to_be_visible()
                actual=next(t for t in request('GET',f'/weddings/{wid}/tasks') if t['id']==b['id'])
                assert actual['done'] and actual['dependencyOverride']['reason']==reason
                assert actual['dependencies'][0]['done'] is False
                passed.append(f'{lang}/{width}: explicit reason survived API reload without completing prerequisite')
                assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth+1'),f'Horizontal overflow {lang}/{width}'
                section.scroll_into_view_if_needed(); page.screenshot(path=str(out/f'fr005-{lang}-{width}.png'))
                passed.append(f'{lang}/{width}: layout and persisted explanation recorded')
                c.close()
        a,b=pairs[0]
        request('PATCH',f'/weddings/{wid}/tasks/{b["id"]}',{'done':False})
        before=len(writes); c,page=context(f['helper'],'ru',390)
        page.goto(ui+f'/wedding/checklist?wedding={wid}&task={b["id"]}',wait_until='networkidle')
        section=page.get_by_role('region',name='Зависимости задачи',exact=True)
        expect(section.get_by_role('link',name=a['title'],exact=True)).to_be_visible()
        expect(section.get_by_role('button',name='Изменить зависимости',exact=True)).to_have_count(0)
        expect(section.get_by_role('textbox')).to_have_count(0)
        row=page.get_by_role('button',name=b['title'],exact=True).locator('..')
        row.get_by_role('button',name='Отметить выполненной',exact=True).click()
        expect(section.get_by_text('Ручное завершение при незакрытых предпосылках подтверждает пара.',exact=True)).to_be_visible()
        assert len(writes)==before
        section.scroll_into_view_if_needed();page.screenshot(path=str(out/'fr005-helper-390.png'));c.close()
        passed.append('helper reads prerequisites but cannot submit a manual completion or edit links')
        allowed={ui+f'/api/weddings/{wid}/tasks/{b["id"]}' for a,b in pairs}
        assert len(writes)==12 and all(r['method']=='PATCH' and r['path'] in allowed for r in writes),writes
        assert not page_errors,page_errors
        (out/'dependency-browser-result.json').write_text(json.dumps({'passed':passed,'page_errors':page_errors,'browser_writes':writes,'browser':browser.version,'limits':'Real API and disposable PostgreSQL; synthetic decisions; Chromium viewports, not physical phones. Backend tests cover audit and concurrent writes.'},ensure_ascii=False,indent=2))
        print(json.dumps({'checkpoints':len(passed),'browserWrites':len(writes),'pageErrors':page_errors}))
    except Exception:
        error=re.sub(r'eyJ[\w-]+\.[\w-]+\.[\w-]+','[redacted-token]',traceback.format_exc())
        (out/'dependency-browser-result.json').write_text(json.dumps({'passed':passed,'page_errors':page_errors,'browser_writes':writes,'error':error},ensure_ascii=False,indent=2))
        if page and not page.is_closed(): page.screenshot(path=str(out/'fr005-failed.png'))
        raise
    finally:
        browser.close()
