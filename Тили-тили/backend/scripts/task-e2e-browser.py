import json,re,pathlib,os,uuid,time,sys,traceback
from playwright.sync_api import sync_playwright, expect
out=pathlib.Path(os.environ['E2E_RESULT_DIR']);out.mkdir(parents=True,exist_ok=True)
f=json.loads(pathlib.Path(os.environ['E2E_FIXTURE_FILE']).read_text())
results=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    def context(person):
        c=browser.new_context(viewport={'width':390,'height':844})
        c.add_init_script("""(() => {const f=%s; if(!localStorage.getItem('tt_auth')) {
          localStorage.setItem('tt_auth',JSON.stringify({accessToken:f.tokens.accessToken,refreshToken:f.tokens.refreshToken}));
          localStorage.setItem('tt_onboarded','1');localStorage.setItem('tt_wedding_id',JSON.stringify(%s));
          localStorage.setItem('tt_wedding_date',JSON.stringify('2027-06-14')); }})();"""%(json.dumps(person),json.dumps(f['weddingId'])))
        return c
    owner=context(f['owner']); page=owner.new_page(); errors=[]
    pages={'owner': page}
    def capture_failure(exc_type, exc, tb):
        # Only disposable fixture views and redacted diagnostics are retained.
        def redact(value):
            text=str(value)
            for person in (f['owner'], f['helper']):
                for token in person['tokens'].values():
                    if isinstance(token,str) and len(token)>20:
                        text=text.replace(token,'[redacted]')
            return re.sub(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+','[redacted-token]',text)
        failure={'passed':list(results),'page_errors':[redact(e) for e in errors],
                 'error':redact(''.join(traceback.format_exception(exc_type,exc,tb))), 'pages':{}}
        for name,current in pages.items():
            try:
                failure['pages'][name]={'url':redact(current.url)}
                current.screenshot(path=str(out/(name+'-failure.png')),full_page=True)
            except Exception as capture_error:
                failure['pages'][name]={'capture_error':redact(capture_error)}
        (out/'browser-result.json').write_text(json.dumps(failure,ensure_ascii=False,indent=2))
        sys.__excepthook__(exc_type,exc,tb)
    # Handle errors while the browser is still alive, before the context exits.
    original_hook=sys.excepthook
    sys.excepthook=capture_failure
    try:
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('http://127.0.0.1:3000/wedding/checklist',wait_until='networkidle')
        expect(page.get_by_role('button',name='+ Задача',exact=True)).to_be_enabled()
        page.get_by_role('button',name='+ Задача',exact=True).click()
        form=page.get_by_role('group',name='Новая задача',exact=True)
        form.get_by_placeholder('Новая задача…').fill('E2E — отправить меню')
        form.get_by_label('Ответственный',exact=True).select_option(f['helper']['id'])
        form.get_by_label('Дата выполнения',exact=True).fill('2027-05-05')
        form.get_by_role('button',name='Добавить',exact=True).click()
        expect(page.get_by_role('button',name=re.compile('^E2E — отправить меню'))).to_be_visible()
        results.append('create-via-ui')
        page.reload(wait_until='networkidle')
        row=page.get_by_role('button',name=re.compile('^E2E — отправить меню'))
        expect(row).to_be_visible();row.click()
        expect(page.get_by_text('Ответственный: Боря E2E',exact=True)).to_be_visible()
        results.append('persist-and-reload')
        page.get_by_role('button',name='Ответственный и срок',exact=True).click()
        editor=page.get_by_role('group',name='Планирование задачи')
        expect(editor.get_by_label('Дата выполнения',exact=True)).to_have_value('2027-05-05')
        expect(editor.get_by_label('Поведение при переносе свадьбы',exact=True)).to_have_value('fixed')
        page.screenshot(path=str(out/'task-planning-mobile.png'),full_page=True)
        helper=context(f['helper']); h=helper.new_page(); pages['helper']=h
        h.on('pageerror',lambda e:errors.append(str(e)))
        h.goto('http://127.0.0.1:3000/wedding/checklist',wait_until='networkidle')
        h.get_by_role('button',name='Мои задачи',exact=True).click()
        expect(h.get_by_role('button',name=re.compile('^E2E — отправить меню'))).to_be_visible()
        results.append('second-user-my-tasks')
        hrow=h.get_by_role('button',name=re.compile('^E2E — отправить меню'))
        # The checkbox is separate from the title button in the row.
        hrow.locator('..').get_by_label('Отметить выполненной').click()
        expect(hrow.locator('..').get_by_label('Снять отметку')).to_be_visible()
        results.append('complete-from-second-user')
        page.reload(wait_until='networkidle')
        row=page.get_by_role('button',name=re.compile('^E2E — отправить меню'))
        expect(row.locator('..').get_by_label('Снять отметку')).to_be_visible()
        # API uses the same server/database as the browser; this changes the wedding while checking the persisted UI result.
        response=owner.request.post('http://127.0.0.1:3001/weddings/'+f['weddingId']+'/reschedule',headers={
          'authorization':'Bearer '+f['owner']['tokens']['accessToken'], 'idempotency-key':str(uuid.uuid4())},data={'date':'2027-07-14'})
        assert response.status==200,response.text()
        page.reload(wait_until='networkidle');page.get_by_role('button',name=re.compile('^E2E — отправить меню')).click()
        page.get_by_role('button',name='Ответственный и срок',exact=True).click()
        editor=page.get_by_role('group',name='Планирование задачи')
        expect(editor.get_by_label('Дата выполнения',exact=True)).to_have_value('2027-05-05')
        results.append('fixed-deadline-after-reschedule')
        editor.get_by_label('Дата выполнения',exact=True).fill('')
        editor.get_by_label('Ответственный',exact=True).select_option('')
        editor.get_by_role('button',name='Сохранить планирование',exact=True).click()
        expect(page.get_by_text('Ответственный: не назначен',exact=True)).to_be_visible()
        page.reload(wait_until='networkidle');page.get_by_role('button',name=re.compile('^E2E — отправить меню')).click()
        expect(page.get_by_text('Ответственный: не назначен',exact=True)).to_be_visible()
        results.append('clear-assignee-and-date-survives-reload')
        h.reload(wait_until='networkidle');h.get_by_role('button',name='Мои задачи',exact=True).click()
        expect(h.get_by_role('button',name=re.compile('^E2E — отправить меню'))).to_have_count(0)
        results.append('second-user-sees-unassignment')
        # Existing budget creation must remain usable; no task-only controls appear there.
        page.goto('http://127.0.0.1:3000/wedding/budget',wait_until='networkidle')
        expect(page).to_have_url('http://127.0.0.1:3000/wedding/budget')
        page.get_by_role('button',name='Добавить расход',exact=True).click()
        expect(page.get_by_label('Ответственный',exact=True)).to_have_count(0)
        results.append('budget-form-regression')
        # 017-B: all task writes go through the actual UI. A test-only worker runs
        # the real reminder job against the same disposable database.
        page.goto('http://127.0.0.1:3000/wedding/checklist',wait_until='networkidle')
        page.get_by_role('button',name='+ Задача',exact=True).click()
        form=page.get_by_role('group',name='Новая задача',exact=True)
        reminder_title='E2E — напоминание'
        form.get_by_placeholder('Новая задача…').fill(reminder_title)
        form.get_by_label('Ответственный',exact=True).select_option(f['helper']['id'])
        form.get_by_label('Дата выполнения',exact=True).fill(f['today'])
        form.get_by_label('Напомнить ответственному',exact=True).check()
        form.get_by_label('За сколько дней до срока',exact=True).select_option('0')
        form.get_by_label('Время напоминания',exact=True).fill('00:00')
        form.get_by_role('button',name='Добавить',exact=True).click()
        expect(page.get_by_role('button',name=re.compile('^'+reminder_title))).to_be_visible()
        page.reload(wait_until='networkidle')
        page.get_by_role('button',name=re.compile('^'+reminder_title)).click()
        page.get_by_role('button',name='Ответственный и срок',exact=True).click()
        editor=page.get_by_role('group',name='Планирование задачи')
        expect(editor.get_by_label('Напомнить ответственному',exact=True)).to_be_checked()
        expect(editor.get_by_label('За сколько дней до срока',exact=True)).to_have_value('0')
        expect(editor.get_by_label('Время напоминания',exact=True)).to_have_value('00:00')
        editor.scroll_into_view_if_needed()
        page.screenshot(path=str(out/'task-reminder-mobile.png'))
        results.append('reminder-settings-via-ui-survive-reload')
        helper_headers={'authorization':'Bearer '+f['helper']['tokens']['accessToken']}
        def reminder_notices():
            res=helper.request.get('http://127.0.0.1:3001/notifications',headers=helper_headers)
            assert res.status==200,res.text()
            return [n for n in res.json() if n.get('body')==reminder_title]
        def await_reminder():
            for _ in range(40):
                rows=reminder_notices()
                reminder=[n for n in rows if n['title']=='Напоминание о задаче']
                if len(reminder)==1:
                    return reminder[0]
                time.sleep(0.25)
            raise AssertionError('The actual reminder worker did not create one inbox notice')
        notice=await_reminder()
        assert len(reminder_notices())==2,reminder_notices()
        # Several real worker iterations must not produce another copy.
        time.sleep(1.1)
        assert len(reminder_notices())==2,reminder_notices()
        results.append('assignment-and-one-worker-reminder-in-recipient-inbox')
        h.goto('http://127.0.0.1:3000/notifications',wait_until='networkidle')
        expect(h.get_by_text('Вам назначена задача',exact=True)).to_be_visible()
        h.screenshot(path=str(out/'task-reminder-inbox-mobile.png'))
        h.get_by_role('button',name=re.compile('Напоминание о задаче.*'+reminder_title)).click()
        expect(h).to_have_url('http://127.0.0.1:3000'+notice['link'])
        expect(h.get_by_role('button',name=re.compile('^'+reminder_title))).to_have_attribute('aria-expanded','true')
        results.append('notification-opens-exact-task-and-wedding')
        h.get_by_role('button',name='Ответственный и срок',exact=True).click()
        editor=h.get_by_role('group',name='Планирование задачи')
        editor.get_by_label('Напомнить ответственному',exact=True).uncheck()
        editor.get_by_role('button',name='Сохранить планирование',exact=True).click()
        expect(editor).to_have_count(0)
        h.reload(wait_until='networkidle')
        expect(h).to_have_url('http://127.0.0.1:3000'+notice['link'])
        expect(h.get_by_role('button',name=re.compile('^'+reminder_title))).to_have_attribute('aria-expanded','true')
        h.get_by_role('button',name='Ответственный и срок',exact=True).click()
        editor=h.get_by_role('group',name='Планирование задачи')
        expect(editor.get_by_label('Напомнить ответственному',exact=True)).not_to_be_checked()
        assert not reminder_notices(),reminder_notices()
        results.append('turning-reminder-off-retracts-stale-inbox-notices')
        editor.get_by_label('Напомнить ответственному',exact=True).check()
        editor.get_by_label('За сколько дней до срока',exact=True).select_option('0')
        editor.get_by_role('button',name='Сохранить планирование',exact=True).click()
        expect(editor).to_have_count(0)
        new_notice=await_reminder()
        assert new_notice['id']!=notice['id']
        time.sleep(1.1)
        assert len(reminder_notices())==1,reminder_notices()
        results.append('rearmed-reminder-is-once-per-new-configuration')
        h.get_by_role('button',name=re.compile('^'+reminder_title)).locator('..').get_by_label('Отметить выполненной').click()
        expect(h.get_by_role('button',name=re.compile('^'+reminder_title)).locator('..').get_by_label('Снять отметку')).to_be_visible()
        h.goto('http://127.0.0.1:3000/notifications',wait_until='networkidle')
        expect(h.get_by_text(reminder_title,exact=True)).to_have_count(0)
        assert not reminder_notices(),reminder_notices()
        results.append('completion-cancels-pending-and-visible-task-notices')
        assert not errors,errors
        (out/'browser-result.json').write_text(json.dumps({'passed':results,'page_errors':errors,'browser':browser.version,'viewport':'390x844'},ensure_ascii=False,indent=2))
        print(json.dumps({'passed':results,'page_errors':errors},ensure_ascii=False))
    except BaseException:
        capture_failure(*sys.exc_info())
        raise
    finally:
        sys.excepthook=original_hook
        browser.close()
