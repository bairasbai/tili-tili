import json,re,pathlib,os,uuid,time,sys,traceback
from hashlib import sha256
from datetime import date, timedelta
from playwright.sync_api import sync_playwright, expect
out=pathlib.Path(os.environ['E2E_RESULT_DIR']);out.mkdir(parents=True,exist_ok=True)
f=json.loads(pathlib.Path(os.environ['E2E_FIXTURE_FILE']).read_text())
results=[]
with sync_playwright() as p:
    channel=os.environ.get('E2E_CHROMIUM_CHANNEL')
    browser=p.chromium.launch(headless=True,**({'channel':channel} if channel else {}))
    def context(person, wedding_id=None, lang='ru'):
        c=browser.new_context(viewport={'width':390,'height':844})
        c.add_init_script("""(() => {const f=%s; if(!localStorage.getItem('tt_auth')) {
          localStorage.setItem('tt_auth',JSON.stringify({accessToken:f.tokens.accessToken,refreshToken:f.tokens.refreshToken}));
          localStorage.setItem('tt_onboarded','1');localStorage.setItem('tt_wedding_id',JSON.stringify(%s));
          localStorage.setItem('tt_wedding_date',JSON.stringify('2027-06-14'));
          localStorage.setItem('tt_lang',%s); }})();"""%(json.dumps(person),json.dumps(wedding_id or f['weddingId']),json.dumps(lang)))
        return c
    owner=context(f['owner']); page=owner.new_page(); errors=[]
    pages={'owner': page}
    def verify_event_keyboard(guest, lang, open_invite, open_programme, edit, name, save, reopen, warning):
        ui='http://127.0.0.1:3000'
        event_path=f"/weddings/{guest['weddingId']}/events/{guest['eventId']}"
        current=owner.request.get('http://127.0.0.1:3001'+event_path.rsplit('/',1)[0],
                                  headers={'Authorization':'Bearer '+guest['owner']['accessToken']})
        assert current.status==200
        title=next(event['name'] for event in current.json() if event['id']==guest['eventId'])
        with browser.new_context() as guest_context:
            guest_context.add_init_script("localStorage.setItem('tt_guest_token',%s); localStorage.setItem('tt_lang',%s)"
                                          %(json.dumps(guest['guestToken']),json.dumps(lang)))
            guest_page=guest_context.new_page()
            guest_page.on('pageerror',lambda e:errors.append(type(e).__name__))
            for width in (320,390,480):
                guest_page.set_viewport_size({'width':width,'height':844})
                guest_page.goto(ui+'/invite')
                guest_page.get_by_role('button',name=open_invite,exact=True).press('Enter')
                event=guest_page.get_by_role('region',name=title,exact=True)
                programme=event.get_by_role('button',name=f"{open_programme} — Гость второго дня SC-017",exact=True)
                programme.press('Tab')
                guest_page.keyboard.press('Shift+Tab')
                expect(programme).to_be_focused()
                assert programme.evaluate("e => e.matches(':focus-visible') && parseFloat(getComputedStyle(e).outlineWidth) >= 2")
                assert guest_page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), (lang,width)
                guest_page.keyboard.press('Enter')
                expect(guest_page.get_by_text(guest['programmeName'],exact=True)).to_be_visible()
                assert f"eventId={guest['eventId']}&guestId={guest['guestId']}" in guest_page.url
        with context({'tokens':guest['owner']},guest['weddingId'],lang) as first, context({'tokens':guest['owner']},guest['weddingId'],lang) as second:
            editor, other=first.new_page(),second.new_page()
            for current_page in (editor,other):
                current_page.on('pageerror',lambda e:errors.append(type(e).__name__))
                current_page.goto(ui+'/wedding/events')
            trigger=editor.get_by_role('button',name=f'{edit}: {title}',exact=True)
            dialog=editor.get_by_role('dialog',name=edit,exact=True)
            field=dialog.get_by_role('textbox',name=name,exact=True)
            for width in (320,390,480):
                editor.set_viewport_size({'width':width,'height':844})
                trigger.press('Enter')
                expect(field).to_be_focused()
                assert dialog.evaluate("e => e.scrollWidth <= e.clientWidth + 1"), (lang,width)
                editor.keyboard.press('Escape')
                expect(trigger).to_be_focused()
            trigger.press('Enter')
            field.fill(f'Unsaved {lang}')
            other.get_by_role('button',name=f'{edit}: {title}',exact=True).press('Enter')
            remote=other.get_by_role('dialog',name=edit,exact=True)
            fresh=f'Second day {lang}'
            remote.get_by_role('textbox',name=name,exact=True).fill(fresh)
            def patch_response(response):
                return response.url.endswith(event_path) and response.request.method=='PATCH'
            with other.expect_response(patch_response) as accepted:
                remote.get_by_role('button',name=save,exact=True).press('Enter')
            assert accepted.value.status==200
            with editor.expect_response(patch_response) as conflict:
                dialog.get_by_role('button',name=save,exact=True).press('Enter')
            assert conflict.value.status==409
            expect(dialog.get_by_role('alert').filter(has_text=warning)).to_be_visible()
            expect(field).to_have_value(f'Unsaved {lang}')
            expect(dialog.get_by_role('button',name=save,exact=True)).to_be_disabled()
            dialog.get_by_role('button',name=reopen,exact=True).press('Enter')
            expect(field).to_have_value(fresh)
            expect(field).to_be_focused()
            editor.keyboard.press('Escape')
            expect(editor.get_by_role('button',name=f'{edit}: {fresh}',exact=True)).to_be_focused()
        results.append(f'additional-event-keyboard-and-conflict-{lang}')

    def verify_contract_approval(fixture):
        ui='http://127.0.0.1:3000'
        agreement=fixture['agreement']
        deal,document=agreement['dealId'],agreement['documentId']
        endpoint=f'/deals/{deal}/documents/{document}/agreement'
        pdf_path=f"/deals/{deal}/documents/{document}/attachments/{agreement['uploadId']}/content"
        for side,tokens,lang,path,summary,propose,approve,back in (
            ('couple',fixture['owner'],'ru',f'/wedding/documents?document={document}',
             'Редакции и согласование','Предложить редакцию','Согласовать редакцию','Назад'),
            ('vendor',agreement['vendor'],'en',f'/vendor-app/deals/{deal}',
             'Versions and approval',None,'Approve version','Back'),
        ):
            with context({'tokens':tokens},fixture['weddingId'],lang) as actor:
                contract=actor.new_page()
                contract.on('pageerror',lambda e:errors.append(type(e).__name__))
                writes=[]
                def is_write(response):
                    return response.url.endswith(endpoint) and response.request.method=='POST'
                contract.on('request',lambda request: writes.append(request.post_data_json)
                            if request.method=='POST' and request.url.endswith(endpoint) else None)
                contract.goto(ui+path)
                if side=='vendor':
                    contract.get_by_text(summary,exact=True).press('Enter')
                else:
                    expect(contract.get_by_text('Пара согласования SC-012',exact=True)).to_be_visible()
                    download=contract.get_by_role('button',name='Скачать PDF',exact=True)
                    pdf_route=re.compile(re.escape(pdf_path)+'$')
                    pending=[]
                    downloaded=[]
                    contract.on('download',lambda file: downloaded.append(file))
                    contract.route(pdf_route,lambda route: pending.append(route))
                    download.press('Enter')
                    expect(contract.get_by_role('status').filter(has_text='Скачиваем…')).to_be_visible()
                    expect(download).to_be_focused()
                    expect(download).to_have_attribute('aria-disabled','true')
                    download.press('Space')
                    assert len(pending)==1
                    with contract.expect_response(lambda response: response.url.endswith(pdf_path)) as failure:
                        pending[0].fulfill(status=503,json={'error':{'code':'media_storage_unavailable','message':'Test storage unavailable'}})
                    assert failure.value.status==503 and not downloaded
                    expect(contract.get_by_role('alert').filter(has_text='Сервер недоступен. Попробуйте позже')).to_be_visible()
                    expect(download).to_be_focused()
                    contract.unroute(pdf_route)
                    with contract.expect_download() as saved, contract.expect_response(lambda response: response.url.endswith(pdf_path)) as read:
                        download.press('Enter')
                    assert read.value.status==200 and read.value.headers.get('cache-control')=='private, no-store'
                    file=saved.value
                    assert file.suggested_filename=='contract.pdf'
                    assert sha256(pathlib.Path(file.path()).read_bytes()).hexdigest()==agreement['pdfSha256']
                    expect(contract.get_by_role('alert').filter(has_text='Сервер недоступен. Попробуйте позже')).to_have_count(0)
                    expect(download).to_be_focused()
                    results.append('contract-pdf-keyboard-retry-and-verified-bytes')
                dialog=contract.get_by_role('alertdialog')
                for label,action in ([(propose,'propose')] if propose else [])+[(approve,'agree')]:
                    trigger=contract.get_by_role('button',name=label,exact=True)
                    for width in (320,390,480):
                        contract.set_viewport_size({'width':width,'height':844})
                        trigger.press('Enter')
                        cancel=dialog.get_by_role('button',name=back,exact=True)
                        expect(cancel).to_be_focused()
                        contract.keyboard.press('Tab')
                        confirm=dialog.get_by_role('button',name=label,exact=True)
                        expect(confirm).to_be_focused()
                        assert confirm.evaluate("e => e.matches(':focus-visible') && parseFloat(getComputedStyle(e).outlineWidth)>=2")
                        assert dialog.evaluate('e => e.scrollWidth <= e.clientWidth + 1'), (side,width)
                        contract.keyboard.press('Escape')
                        expect(dialog).to_have_count(0)
                        expect(trigger).to_be_focused()
                    assert len(writes)==(1 if side=='couple' and action=='agree' else 0)
                    trigger.press('Enter')
                    with contract.expect_response(is_write) as response:
                        dialog.get_by_role('button',name=label,exact=True).press('Enter')
                    assert response.value.status==200
                    assert response.value.request.post_data_json=={'action':action,'attachmentId':agreement['uploadId']}
                    expected_receipt='proposedAt' if action=='propose' else f'{side}At'
                    assert response.value.json()[expected_receipt]
                    expect(dialog).to_have_count(0)
                if side=='vendor':
                    expect(contract.get_by_text('Latest version approved by both parties',exact=True)).to_be_visible()
                assert [entry['action'] for entry in writes]==(['propose','agree'] if side=='couple' else ['agree'])
        results.append('contract-approval-keyboard-cancel-and-exact-receipts')

    def verify_tilly_keyboard(fixture):
        ui='http://127.0.0.1:3000'
        api='http://127.0.0.1:3001'
        wedding=fixture['weddingId']
        data=fixture['tilly']
        headers={'Authorization':'Bearer '+fixture['owner']['accessToken']}
        def count_tasks(title):
            reply=owner.request.get(f'{api}/weddings/{wedding}/tasks',headers=headers)
            assert reply.status==200
            return sum(task['title']==title for task in reply.json())
        for action,lang,heading,why,confirm,prompt,saving,error,done in zip(
            data['actions'],
            ('ru','en'),('Добавить задачу','Add task'),('Почему предложено','Why it was suggested'),
            ('Подтвердить изменение','Confirm change'),('Применить это изменение в чек-листе?','Apply this change to the checklist?'),
            ('Сохраняем…','Saving…'),('Не удалось применить. Повтори','Could not apply the change. Retry'),
            ('Изменение выполнено','Change applied'),strict=True,
        ):
            with context({'tokens':fixture['owner']},wedding,lang) as actor:
                chat=actor.new_page()
                chat.on('pageerror',lambda e:errors.append(type(e).__name__))
                chat.goto(f"{ui}/us/chats/{data['chat']}")
                card=chat.get_by_role('region',name=heading,exact=True).filter(has_text=action['title'])
                button=card.get_by_role('button',name=confirm,exact=True)
                expect(card.get_by_text(why,exact=True)).to_be_visible()
                assert count_tasks(action['title'])==0
                endpoint=f"/weddings/{wedding}/tilly/actions/{action['id']}/accept"
                def is_write(response):
                    return response.url.endswith(endpoint) and response.request.method=='POST'
                def dismiss(dialog):
                    assert dialog.message==prompt
                    dialog.dismiss()
                for width in (320,390,480):
                    chat.set_viewport_size({'width':width,'height':844})
                    button.press('Tab')
                    chat.keyboard.press('Shift+Tab')
                    expect(button).to_be_focused()
                    assert button.evaluate("e => e.matches(':focus-visible') && parseFloat(getComputedStyle(e).outlineWidth)>=2")
                    assert chat.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), (lang,width)
                    chat.once('dialog',dismiss)
                    chat.keyboard.press('Enter')
                    expect(button).to_be_focused()
                assert count_tasks(action['title'])==0
                pending=[]
                route=re.compile(re.escape(endpoint)+'$')
                chat.route(route,lambda request: pending.append(request))
                chat.once('dialog',lambda dialog: dialog.accept())
                button.press('Enter')
                expect(card.get_by_role('status')).to_have_text(saving)
                working=card.get_by_role('button',name=saving,exact=True)
                expect(working).to_be_focused()
                expect(working).to_have_attribute('aria-disabled','true')
                working.press('Space')
                assert len(pending)==1
                with chat.expect_response(is_write) as failed:
                    pending[0].fulfill(status=503,json={'error':{'code':'test_unavailable','message':'Synthetic test failure'}})
                assert failed.value.status==503
                expect(card.get_by_role('alert')).to_contain_text(error)
                expect(button).to_be_focused()
                assert count_tasks(action['title'])==0
                chat.unroute(route)
                chat.once('dialog',lambda dialog: dialog.accept())
                with chat.expect_response(is_write) as accepted:
                    button.press('Enter')
                assert accepted.value.status==200 and accepted.value.request.post_data_json=={}
                assert accepted.value.json()['id']==action['id'] and accepted.value.json()['state']=='applied'
                expect(card.get_by_role('status')).to_have_text(done)
                assert count_tasks(action['title'])==1
            results.append(f'tilly-action-keyboard-preview-retry-{lang}')

    def capture_failure(exc_type, exc, tb):
        # Only disposable fixture views and redacted diagnostics are retained.
        def redact(value):
            text=str(value)
            token_sets=[f['owner']['tokens'],f['helper']['tokens']]
            if 'contractAccess' in f:
                token_sets.extend(f['contractAccess'][role] for role in ('owner','viewer'))
                token_sets.append(f['contractAccess']['search']['viewer'])
                token_sets.append({'guestToken':f['contractAccess']['guestProgramme']['guestToken']})
                token_sets.append(f['contractAccess']['guestProgramme']['owner'])
                token_sets.append(f['contractAccess']['agreement']['vendor'])
                token_sets.extend(f['contractAccess']['staff'][role] for role in ('viewer','taskOwner','companyOwner'))
            for tokens in token_sets:
                for token in tokens.values():
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
        # Both tabs share one synthetic browser session. Changing account in the
        # second tab must replace the private list without reloading the first.
        isolated_inbox=context(f['helper'])
        inbox=isolated_inbox.new_page()
        inbox.on('pageerror',lambda e:errors.append(str(e)))
        inbox.goto('http://127.0.0.1:3000/notifications')
        expect(inbox.get_by_text(reminder_title,exact=True).first).to_be_visible()
        account_tab=isolated_inbox.new_page()
        account_tab.goto('http://127.0.0.1:3000/notifications')
        with inbox.expect_response(lambda res: res.url.endswith('/api/notifications')
                                   and res.request.method=='GET') as inbox_response:
            account_tab.evaluate("tokens => localStorage.setItem('tt_auth', JSON.stringify(tokens))", f['owner']['tokens'])
        assert inbox_response.value.status==200
        assert all(row['id']!=notice['id'] for row in inbox_response.value.json())
        expect(inbox.get_by_text(reminder_title,exact=True)).to_have_count(0)
        isolated_inbox.close()
        results.append('notification-inbox-changes-account')
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
        page.goto('http://127.0.0.1:3000/wedding/checklist',wait_until='networkidle')
        template_title='Репетиция первого танца'
        page.get_by_role('button',name='Все задачи',exact=True).click()
        template=page.get_by_role('button',name=re.compile('^'+template_title))
        template.click()
        page.get_by_role('button',name='Не относится к свадьбе',exact=True).click()
        page.get_by_label('Причина исключения').fill('Первого танца не будет')
        page.get_by_role('button',name='Исключить задачу',exact=True).click()
        expect(template).to_have_count(0)
        page.reload(wait_until='networkidle')
        page.locator('summary').filter(has_text='Исключённые задачи').click()
        expect(page.get_by_text('Первого танца не будет',exact=True)).to_be_visible()
        h.goto('http://127.0.0.1:3000/wedding/checklist',wait_until='networkidle')
        h.get_by_role('button',name='Все задачи',exact=True).click()
        expect(h.get_by_role('button',name=re.compile('^'+template_title))).to_have_count(0)
        expect(h.get_by_text('Первого танца не будет',exact=True)).to_have_count(0)
        page.get_by_role('button',name='Вернуть в план',exact=True).click()
        expect(page.locator('summary').filter(has_text='Исключённые задачи')).to_have_count(0)
        page.get_by_role('button',name='Все задачи',exact=True).click()
        expect(template).to_be_visible()
        results.append('template-exclusion-persists-and-is-private-until-restored')
        near_date=(date.fromisoformat(f['today']) + timedelta(days=4)).isoformat()
        response=owner.request.post('http://127.0.0.1:3001/weddings/'+f['weddingId']+'/reschedule',headers={
          'authorization':'Bearer '+f['owner']['tokens']['accessToken'], 'idempotency-key':str(uuid.uuid4())},data={'date':near_date})
        assert response.status==200,response.text()
        page.reload(wait_until='networkidle')
        priorities=page.get_by_role('region',name='Приоритеты подготовки')
        first=priorities.get_by_role('button').first
        expect(first).to_contain_text('Подтвердить время и места встречи с командой')
        expect(first).to_contain_text('Нужно для ближайшего этапа')
        first.click()
        expect(page.get_by_role('button',name=re.compile('^Подтвердить время и места встречи с командой'),expanded=True)).to_be_focused()
        expect(page.get_by_role('button',name='Последняя неделя',exact=True)).to_have_attribute('aria-pressed','true')
        page.get_by_role('button',name='После свадьбы',exact=True).click()
        expect(page.get_by_role('button',name=re.compile('^Проверить выполненные заказы'))).to_be_visible()
        results.append('short-plan-ranks-opens-and-focuses-last-week-task')
        menu_title='Утвердить окончательное меню'
        guest_name='Гость для проверки меню'
        guest=owner.request.post('http://127.0.0.1:3001/weddings/'+f['weddingId']+'/guests',
          headers={'authorization':'Bearer '+f['owner']['tokens']['accessToken']},data={'name':guest_name})
        assert guest.status==201,guest.text()
        page.reload(wait_until='networkidle')
        menu=page.get_by_role('button',name=re.compile('^'+menu_title),expanded=False)
        menu.click()
        requirements=page.get_by_role('region',name='Условия завершения')
        requirements.get_by_role('button',name='Ждём ответы гостей (1)',exact=True).click()
        expect(page).to_have_url('http://127.0.0.1:3000/wedding/guests')
        expect(page.get_by_text(guest_name,exact=True)).to_be_visible()
        h.goto('http://127.0.0.1:3000/wedding/checklist',wait_until='networkidle')
        h.get_by_role('button',name=re.compile('^'+menu_title),expanded=False).click()
        expect(h.get_by_role('region',name='Условия завершения').get_by_text('Ждём ответы гостей (1)')).to_be_visible()
        expect(h.get_by_role('button',name='Завершить с причиной',exact=True)).to_have_count(0)
        page.goto('http://127.0.0.1:3000/wedding/checklist',wait_until='networkidle')
        menu.click()
        requirements.get_by_role('button',name='Завершить с причиной',exact=True).click()
        confirmation=requirements.get_by_role('button',name='Подтвердить завершение',exact=True)
        expect(confirmation).to_be_disabled()
        requirements.get_by_label('Почему завершаете сейчас').fill('Ответ получен отдельно')
        confirmation.click()
        expect(page.get_by_role('button',name=re.compile('^'+menu_title),expanded=True).locator('..')
          .get_by_label('Снять отметку')).to_be_visible()
        results.append('task-dependency-links-to-rsvp-and-couple-confirms-with-reason')
        if 'contractAccess' in f:
            fixture=f['contractAccess']
            verify_contract_approval(fixture)
            verify_tilly_keyboard(fixture)
            guest=fixture['guestProgramme']
            verify_event_keyboard(guest,'ru','Открыть приглашение','Открыть программу','Изменить мероприятие',
                                  'Название мероприятия','Сохранить','Открыть свежую версию','Перед повторным изменением откройте свежую версию')
            verify_event_keyboard(guest,'en','Open the invitation','Open programme','Edit event',
                                  'Event name','Save','Open fresh version','Open a fresh version before making another change')
            with browser.new_context(viewport={'width':390,'height':844}) as guest_context:
                guest_context.add_init_script("localStorage.setItem('tt_guest_token', %s)"%json.dumps(guest['guestToken']))
                programme=guest_context.new_page()
                programme.on('pageerror',lambda e:errors.append(type(e).__name__))
                selected='?eventId='+guest['eventId']+'&guestId='+guest['guestId']
                def guest_read(res):
                    return '/join/' in res.url and res.url.endswith('/day'+selected)
                with programme.expect_response(guest_read) as initial_programme:
                    programme.goto('http://127.0.0.1:3000/invite'+selected)
                assert initial_programme.value.status==200
                programme_block=programme.get_by_text(guest['programmeName'],exact=True)
                expect(programme_block).to_be_visible()
                expect(programme.get_by_text('Внутренний блок SC-017',exact=True)).to_have_count(0)
                programme.wait_for_function("localStorage.getItem('tt_guest_event_offline') !== null")
                roster='http://127.0.0.1:3001/weddings/'+guest['weddingId']+'/events/'+guest['eventId']+'/invitations'
                headers={'Authorization':'Bearer '+guest['owner']['accessToken']}
                current=owner.request.get(roster,headers=headers)
                assert current.status==200
                updated=owner.request.put(roster,headers={**headers,'If-Match':current.headers['etag']},data={'guestIds':[]})
                assert updated.status==200
                with programme.expect_response(guest_read) as programme_refused:
                    programme.evaluate("window.dispatchEvent(new Event('focus'))")
                assert programme_refused.value.status==404
                expect(programme.get_by_role('alert')).to_be_visible()
                expect(programme_block).to_have_count(0)
                programme.wait_for_function("localStorage.getItem('tt_guest_event_offline') === null")
            results.append('guest-selected-programme-rechecked-and-forgotten-after-invitation-revocation')
            staff=fixture['staff']
            with browser.new_context(viewport={'width':390,'height':844}) as staff_context:
                staff_context.add_init_script("""(() => {
                  localStorage.setItem('tt_auth', JSON.stringify(%s));
                  localStorage.setItem('tt_onboarded', '1');
                })();"""%json.dumps(staff['viewer']))
                assignments=staff_context.new_page()
                assignments.on('pageerror',lambda e:errors.append(type(e).__name__))
                assignment_path='/users/me/vendor-staff/duties'
                assignments.goto('http://127.0.0.1:3000/staff-duties')
                duty=assignments.get_by_text(staff['dutyTitle'],exact=True)
                expect(duty).to_be_visible()
                tasks=staff_context.new_page()
                tasks.on('pageerror',lambda e:errors.append(type(e).__name__))
                tasks_path='/users/me/task-delegations'
                tasks.goto('http://127.0.0.1:3000/delegated-tasks')
                task=tasks.get_by_text(staff['taskTitle'],exact=True)
                expect(task).to_be_visible()
                staff_context.set_offline(True)
                expect(duty).to_have_count(0)
                expect(task).to_have_count(0)
                removed_task=owner.request.delete('http://127.0.0.1:3001'+staff['delegationPath'],
                    headers={'Authorization':'Bearer '+staff['taskOwner']['accessToken']})
                assert removed_task.status==204
                removed_duty=owner.request.post('http://127.0.0.1:3001'+staff['dutyRevokePath'],
                    headers={'Authorization':'Bearer '+staff['companyOwner']['accessToken']},data={'expectedVersion':staff['dutyVersion']})
                assert removed_duty.status==200
                with assignments.expect_response(lambda res: res.url.endswith(assignment_path)) as duties, \
                     tasks.expect_response(lambda res: res.url.endswith(tasks_path)) as delegated:
                    staff_context.set_offline(False)
                assert duties.value.status==200 and duties.value.json()['items']==[]
                assert delegated.value.status==200 and delegated.value.json()==[]
                expect(assignments.get_by_text('Действующих рабочих назначений пока нет')).to_be_visible()
                expect(tasks.get_by_text('Поручений пока нет')).to_be_visible()
                expect(task).to_have_count(0)
                expect(duty).to_have_count(0)
            results.append('staff-and-delegated-tasks-hidden-after-offline-and-revocation')
            search=fixture['search']
            with browser.new_context(viewport={'width':390,'height':844}) as search_context:
                search_context.add_init_script("""(() => {
                  localStorage.setItem('tt_auth', JSON.stringify(%s));
                  localStorage.setItem('tt_onboarded', '1');
                  localStorage.setItem('tt_wedding_id', JSON.stringify(%s));
                })();"""%(json.dumps(search['viewer']),json.dumps(fixture['weddingId'])))
                profile=search_context.new_page()
                profile.on('pageerror',lambda e:errors.append(type(e).__name__))
                shortlist_path='/weddings/'+fixture['weddingId']+'/slots/'+search['slotId']+'/shortlist'
                with profile.expect_response(lambda res: res.url.endswith(shortlist_path)) as initial_shortlist:
                    profile.goto('http://127.0.0.1:3000/vendor/'+search['vendorId']+'?slotId='+search['slotId'])
                assert initial_shortlist.value.status==200
                candidate=profile.get_by_role('button',name='✓ Уже в кандидатах')
                expect(candidate).to_be_visible()
                search_context.set_offline(True)
                expect(profile.get_by_text('Нет связи с сервером',exact=True)).to_be_visible()
                expect(candidate).to_have_count(0)
                with profile.expect_response(lambda res: res.url.endswith(shortlist_path)) as fresh_shortlist:
                    search_context.set_offline(False)
                assert fresh_shortlist.value.status==200
                expect(candidate).to_be_visible()
                removed=owner.request.delete('http://127.0.0.1:3001/weddings/'+fixture['weddingId']+'/members/'+search['viewerId'],
                    headers={'Authorization':'Bearer '+fixture['owner']['accessToken']})
                assert removed.status==204
                with profile.expect_response(lambda res: res.url.endswith('/weddings')) as memberships:
                    profile.evaluate("window.dispatchEvent(new Event('focus'))")
                assert memberships.value.status==200 and not any(row['id']==fixture['weddingId'] for row in memberships.value.json())
                expect(candidate).to_have_count(0)
                expect(profile.get_by_role('button',name='В кандидаты',exact=True)).to_have_count(0)
                denied=profile.request.get('http://127.0.0.1:3001'+shortlist_path,
                    headers={'Authorization':'Bearer '+search['viewer']['accessToken']})
                assert denied.status==404
            results.append('search-candidates-hidden-after-network-loss-and-membership-revocation')
            with browser.new_context(viewport={'width':390,'height':844}) as contract_context:
                contract_context.add_init_script("""(() => {
                  localStorage.setItem('tt_auth', JSON.stringify(%s));
                  localStorage.setItem('tt_onboarded', '1');
                  localStorage.setItem('tt_wedding_id', JSON.stringify(%s));
                })();"""%(json.dumps(fixture['viewer']),json.dumps(fixture['weddingId'])))
                contract=contract_context.new_page()
                contract.on('pageerror',lambda e:errors.append(type(e).__name__))
                contract.goto('http://127.0.0.1:3000/wedding/documents?document='+fixture['documentId'])
                details=contract.locator('details').filter(has_text='Редакции и согласование')
                expect(details.get_by_text(fixture['marker'],exact=True)).to_be_visible()
                contract_context.set_offline(True)
                expect(details.get_by_role('status')).to_have_text('Нет связи с сервером')
                expect(details.get_by_text(fixture['marker'],exact=True)).to_have_count(0)
                contract_context.set_offline(False)
                expect(details.get_by_text(fixture['marker'],exact=True)).to_be_visible()
                deal=contract_context.new_page()
                deal.on('pageerror',lambda e:errors.append(type(e).__name__))
                deal.goto('http://127.0.0.1:3000/deal/'+fixture['dealId']+'/terms')
                journal=deal.locator('section').filter(has=deal.get_by_role('heading',name='Что происходило'))
                note=journal.get_by_text(fixture['journalNote'],exact=True)
                expect(note).to_be_visible()
                deal.get_by_role('button',name='Показать предложения переноса').click()
                moves=deal.locator('section').filter(has=deal.get_by_role('heading',name='Перенос мероприятия',exact=True))
                empty=moves.get_by_text('Предложений переноса пока нет')
                expect(empty).to_be_visible()
                contract_context.set_offline(True)
                expect(journal.get_by_role('status')).to_have_text('Нет связи с сервером')
                expect(moves.get_by_role('status')).to_have_text('Нет связи с сервером')
                expect(note).to_have_count(0)
                expect(empty).to_have_count(0)
                contract_context.set_offline(False)
                expect(note).to_be_visible()
                expect(empty).to_be_visible()
                move=fixture['move']
                move_path='/deal/'+move['dealId']+'/event-moves/'+move['proposalId']
                read_path='/deals/'+move['dealId']+'/event-moves/'+move['proposalId']
                consent=contract_context.new_page()
                consent.on('pageerror',lambda e:errors.append(type(e).__name__))
                with consent.expect_response(lambda res: res.url.endswith(read_path)) as initial_move:
                    consent.goto('http://127.0.0.1:3000'+move_path)
                initial=initial_move.value.json()
                assert initial_move.value.status==200, f"Move read returned {initial_move.value.status} ({initial.get('error',{}).get('code')})"
                assert initial['status']=='pending' and initial.get('readToken'), f"Unexpected move state: {initial['status']}"
                move_title=consent.get_by_role('heading',name=move['title'],exact=True)
                confirm=consent.get_by_role('button',name='Подтвердить перенос своего заказа')
                consent.get_by_role('checkbox').check()
                expect(confirm).to_be_enabled()
                contract_context.set_offline(True)
                expect(consent.get_by_text('Нет связи с сервером',exact=True)).to_be_visible()
                expect(move_title).to_have_count(0)
                expect(confirm).to_have_count(0)
                with consent.expect_response(lambda res: res.url.endswith(read_path)) as fresh_move:
                    contract_context.set_offline(False)
                assert fresh_move.value.status==200
                expect(move_title).to_be_visible()
                expect(confirm).to_be_enabled()
                with consent.expect_response(lambda res: res.url.endswith(read_path+'/accept')) as receipt:
                    confirm.click()
                assert receipt.value.status==200
                assert len(receipt.value.json()['receipts'])==1
                expect(consent.get_by_text(re.compile('^Согласие пары:'))).to_be_visible()
                terms=contract_context.new_page()
                terms.on('pageerror',lambda e:errors.append(type(e).__name__))
                terms_read='/deals/'+move['dealId']+'/order/terms'
                with terms.expect_response(lambda res: res.url.endswith(terms_read)) as initial_terms:
                    terms.goto('http://127.0.0.1:3000/deal/'+move['dealId']+'/terms')
                assert initial_terms.value.status==200
                assert initial_terms.value.json()['selected']['id']==fixture['termsId']
                order_terms=terms.locator('#order-terms')
                details_toggle=order_terms.get_by_text('Подробности сохранённой редакции',exact=True)
                details_toggle.click()
                terms_checkbox=order_terms.get_by_role('checkbox')
                terms_checkbox.check()
                accept_terms=order_terms.get_by_role('button',name='Принять эту редакцию')
                expect(accept_terms).to_be_enabled()
                contract_context.set_offline(True)
                expect(order_terms.get_by_text('Нет связи с сервером',exact=True)).to_be_visible()
                expect(details_toggle).to_have_count(0)
                expect(accept_terms).to_have_count(0)
                with terms.expect_response(lambda res: res.url.endswith(terms_read)) as reloaded_terms:
                    contract_context.set_offline(False)
                assert reloaded_terms.value.status==200
                expect(details_toggle).to_be_visible()
                expect(accept_terms).to_be_disabled()
                draft=contract_context.new_page()
                draft.on('pageerror',lambda e:errors.append(type(e).__name__))
                draft_read='/deals/'+fixture['dealId']+'/order'
                with draft.expect_response(lambda res: res.url.endswith(draft_read)) as draft_initial:
                    draft.goto('http://127.0.0.1:3000/deal/'+fixture['dealId']+'?agreement=1')
                assert draft_initial.value.status==200
                order_draft=draft.locator('details').filter(has=draft.get_by_text('Состав заказа',exact=True)).last
                contact=order_draft.get_by_label('Имя внешнего исполнителя')
                save_contact=order_draft.get_by_role('button',name='Сохранить внешний контакт')
                expect(contact).to_have_value('Фотограф SC-017')
                contact.fill('Локальный ввод SC-017')
                expect(save_contact).to_be_enabled()
                contract_context.set_offline(True)
                expect(order_draft.get_by_text('Нет связи с сервером',exact=True)).to_be_visible()
                expect(contact).to_be_hidden()
                expect(save_contact).to_have_count(0)
                with draft.expect_response(lambda res: res.url.endswith(draft_read)) as draft_reloaded:
                    contract_context.set_offline(False)
                assert draft_reloaded.value.status==200
                expect(contact).to_have_value('Локальный ввод SC-017')
                expect(save_contact).to_be_enabled()
                bounds_summary=order_draft.get_by_text('Границы прежних календарных обязательств',exact=True)
                bounds=bounds_summary.locator('..')
                bounds_path='/weddings/'+fixture['weddingId']+'/deals/'+fixture['dealId']+'/legacy-calendar'
                with draft.expect_response(lambda res: res.url.endswith(bounds_path)) as bounds_initial:
                    bounds_summary.click()
                assert bounds_initial.value.status==200
                assert bounds_initial.value.json()['sources']==[]
                bounds_status=bounds.get_by_text('Записанных источников нет. Это не подтверждение свободного времени.',exact=True)
                try:
                    expect(bounds_status).to_be_visible()
                except AssertionError as failure:
                    raise AssertionError('Calendar UI after initial read: '+bounds.inner_text()) from failure
                contract_context.set_offline(True)
                expect(bounds_status).to_be_hidden()
                with draft.expect_response(lambda res: res.url.endswith(bounds_path)) as bounds_reloaded:
                    contract_context.set_offline(False)
                assert bounds_reloaded.value.status==200
                expect(bounds_status).to_be_visible()
                expect(contact).to_have_value('Локальный ввод SC-017')
                materials=contract_context.new_page()
                materials.on('pageerror',lambda e:errors.append(type(e).__name__))
                delivery_read='/deals/'+move['dealId']+'/order/delivery'
                materials.goto('http://127.0.0.1:3000/deal/'+move['dealId'])
                disclosure=materials.get_by_role('button',name='Материалы по сделке')
                with materials.expect_response(lambda res: res.url.endswith(delivery_read)) as delivery_initial:
                    disclosure.click()
                assert delivery_initial.value.status==200
                delivery=disclosure.locator('..')
                material=delivery.get_by_role('link',name='Открыть материалы')
                expect(material).to_have_attribute('href',fixture['material'])
                comment=delivery.get_by_label('Что нужно исправить')
                comment.fill('Черновик правок SC-017')
                contract_context.set_offline(True)
                expect(delivery.get_by_text('Нет связи с сервером',exact=True)).to_be_visible()
                expect(material).to_have_count(0)
                expect(delivery.get_by_role('button',name='Принять результат')).to_have_count(0)
                with materials.expect_response(lambda res: res.url.endswith(delivery_read)) as delivery_reloaded:
                    contract_context.set_offline(False)
                assert delivery_reloaded.value.status==200
                expect(material).to_have_attribute('href',fixture['material'])
                expect(comment).to_have_value('Черновик правок SC-017')
                plan_summary=materials.get_by_text('План ресурсов заказа',exact=True)
                booking_summary=materials.get_by_text('Бронь ресурсов заказа',exact=True)
                plan_block=plan_summary.locator('..')
                booking_block=booking_summary.locator('..')
                plan_path='/deals/'+move['dealId']+'/order/resource-plan'
                booking_path='/deals/'+move['dealId']+'/order/resource-commitments'
                plan_status=plan_block.get_by_text('Ресурсы не зарезервированы',exact=True)
                booking_status=booking_block.get_by_text('Ресурсы не зарезервированы',exact=True)
                plan_summary.click()
                expect(plan_status).to_be_visible()
                booking_summary.click()
                expect(booking_status).to_be_visible()
                contract_context.set_offline(True)
                for block,status in ((plan_block,plan_status),(booking_block,booking_status)):
                    expect(block.get_by_text('Нет связи с сервером',exact=True)).to_be_visible()
                    expect(status).to_have_count(0)
                with materials.expect_response(lambda res: res.url.endswith(plan_path)) as plan_reloaded, \
                     materials.expect_response(lambda res: res.url.endswith(booking_path)) as booking_reloaded:
                    contract_context.set_offline(False)
                assert plan_reloaded.value.status==200 and booking_reloaded.value.status==200
                expect(plan_status).to_be_visible()
                expect(booking_status).to_be_visible()
                price_context=browser.new_context(viewport={'width':390,'height':844})
                price_context.add_init_script("""(() => {
                  localStorage.setItem('tt_auth', JSON.stringify(%s));
                  localStorage.setItem('tt_onboarded', '1');
                  localStorage.setItem('tt_wedding_id', JSON.stringify(%s));
                })();"""%(json.dumps(fixture['viewer']),json.dumps(fixture['weddingId'])))
                price_page=price_context.new_page()
                price_page.on('pageerror',lambda e:errors.append(type(e).__name__))
                price_page.goto('http://127.0.0.1:3000/deal/'+move['dealId'])
                price_summary=price_page.get_by_text('Предпросмотр изменения цены',exact=True)
                price_block=price_summary.locator('..')
                price_input=price_block.get_by_label('Новое количество для «Сверхурочные»')
                price_result=price_block.get_by_text('Известная оценка с изменениями',exact=True)
                price_order='/deals/'+move['dealId']+'/order'
                price_calls=[]
                price_page.on('request',lambda request: price_calls.append(request.method) if request.url.endswith(price_order+'/price-preview') else None)
                price_summary.click()
                price_input.fill('3')
                with price_page.expect_response(lambda res: res.url.endswith(price_order+'/price-preview')) as calculated:
                    price_block.get_by_role('button',name='Рассчитать разницу').click()
                assert calculated.value.status==200 and calculated.value.json()['difference']['amount']==10000
                expect(price_result).to_be_visible()
                price_context.set_offline(True)
                expect(price_block.get_by_text('Нет связи с сервером',exact=True)).to_be_visible()
                expect(price_result).to_have_count(0)
                with price_page.expect_response(lambda res: res.url.endswith(price_order)) as price_reloaded:
                    price_context.set_offline(False)
                assert price_reloaded.value.status==200
                expect(price_input).to_have_value('3')
                expect(price_result).to_have_count(0)
                assert price_calls==['POST']
                changed=owner.request.patch('http://127.0.0.1:3001/weddings/'+fixture['weddingId']+'/members/'+fixture['viewerId'],
                    headers={'Authorization':'Bearer '+fixture['owner']['accessToken']},data={'role':'helper'})
                assert changed.status==200, f'Role change returned {changed.status}'
                with contract.expect_response(lambda res: res.url.endswith('/deals/'+fixture['dealId']+'/documents')) as recheck:
                    contract.evaluate("window.dispatchEvent(new Event('focus'))")
                assert recheck.value.status==403
                expect(details.get_by_text('Договор оформляют пара и подрядчик, а не команда свадьбы')).to_be_visible()
                expect(details.get_by_text(fixture['marker'],exact=True)).to_have_count(0)
                base='/deals/'+fixture['dealId']
                with deal.expect_response(lambda res: res.url.endswith(base+'/events')) as journal_check, \
                     deal.expect_response(lambda res: res.url.endswith(base+'/event-moves')) as moves_check:
                    deal.evaluate("window.dispatchEvent(new Event('focus'))")
                for check,block in ((journal_check,journal),(moves_check,moves)):
                    assert check.value.status in (403,404)
                    expect(block.get_by_text(check.value.json()['error']['message'],exact=True)).to_be_visible()
                expect(note).to_have_count(0)
                expect(empty).to_have_count(0)
                with consent.expect_response(lambda res: res.url.endswith(read_path)) as consent_check:
                    consent.evaluate("window.dispatchEvent(new Event('focus'))")
                assert consent_check.value.status==404
                expect(consent.get_by_text(consent_check.value.json()['error']['message'],exact=True)).to_be_visible()
                expect(move_title).to_have_count(0)
                expect(confirm).to_have_count(0)
                with terms.expect_response(lambda res: res.url.endswith(terms_read)) as terms_refusal:
                    terms.evaluate("window.dispatchEvent(new Event('focus'))")
                assert terms_refusal.value.status==404
                expect(order_terms.get_by_text(terms_refusal.value.json()['error']['message'],exact=True)).to_be_visible()
                expect(details_toggle).to_have_count(0)
                expect(accept_terms).to_have_count(0)
                with draft.expect_response(lambda res: res.url.endswith(draft_read)) as draft_refusal:
                    draft.evaluate("window.dispatchEvent(new Event('focus'))")
                assert draft_refusal.value.status==404
                expect(order_draft.get_by_text(draft_refusal.value.json()['error']['message'],exact=True)).to_be_visible()
                expect(contact).to_have_count(0)
                expect(bounds_summary).to_have_count(0)
                with materials.expect_response(lambda res: res.url.endswith(delivery_read)) as delivery_refusal, \
                     materials.expect_response(lambda res: res.url.endswith(plan_path)) as plan_refusal, \
                     materials.expect_response(lambda res: res.url.endswith(booking_path)) as booking_refusal:
                    materials.evaluate("window.dispatchEvent(new Event('focus'))")
                assert delivery_refusal.value.status==404
                assert plan_refusal.value.status==404 and booking_refusal.value.status==404
                with price_page.expect_response(lambda res: res.url.endswith(price_order)) as price_refusal:
                    price_page.evaluate("window.dispatchEvent(new Event('focus'))")
                assert price_refusal.value.status==404
                expect(price_block.get_by_role('alert')).to_be_visible()
                expect(price_input).to_have_count(0)
                assert price_calls==['POST']
                price_context.close()
                expect(delivery.get_by_text(delivery_refusal.value.json()['error']['message'],exact=True)).to_be_visible()
                expect(material).to_have_count(0)
                expect(comment).to_have_count(0)
                for block,status in ((plan_block,plan_status),(booking_block,booking_status)):
                    expect(block.get_by_role('alert')).to_be_visible()
                    expect(status).to_have_count(0)
                archived=owner.request.post('http://127.0.0.1:3001/weddings/'+fixture['weddingId']+'/cancel',
                    headers={'Authorization':'Bearer '+fixture['owner']['accessToken']})
                assert archived.status==200 and archived.json()['state']=='cancelled', f'Archiving returned {archived.status}'
                contract.goto('http://127.0.0.1:3000/archived-contracts')
                expect(contract.get_by_text('В архиве нет доступных договоров')).to_be_visible()
            results.append('contract-access-rechecked-after-offline-and-focus')
            results.append('deal-reads-rechecked-after-offline-and-focus')
            results.append('move-consent-rechecked-before-submit-and-after-revocation')
            results.append('order-terms-rechecked-after-offline-and-focus')
            results.append('order-draft-preserves-input-only-after-access-recheck')
            results.append('order-delivery-materials-rechecked-after-offline-and-focus')
            results.append('order-resource-plan-and-booking-rechecked-after-offline-and-focus')
            results.append('legacy-calendar-bounds-rechecked-after-offline-and-focus')
            results.append('order-price-preview-rechecked-without-automatic-calculation')
            with browser.new_context(viewport={'width':390,'height':844}) as archive_context:
                archive_context.add_init_script("""(() => {
                  localStorage.setItem('tt_auth', JSON.stringify(%s));
                  localStorage.setItem('tt_onboarded', '1');
                })();"""%json.dumps(fixture['owner']))
                archive=archive_context.new_page()
                archive.on('pageerror',lambda e:errors.append(type(e).__name__))
                endpoint='/users/me/archived-contracts?side=couple'
                with archive.expect_response(lambda res: res.url.endswith(endpoint)) as listing:
                    archive.goto('http://127.0.0.1:3000/archived-contracts')
                assert listing.value.status==200
                items=listing.value.json()['items']
                assert {item['dealId'] for item in items}=={fixture['dealId'],fixture['agreement']['dealId']}
                archived_cards=archive.get_by_role('article')
                expect(archived_cards).to_have_count(2)
                archive_context.set_offline(True)
                expect(archive.get_by_text('Нет связи с сервером',exact=True)).to_be_visible()
                expect(archived_cards).to_have_count(0)
                expect(archive.get_by_text('В архиве нет доступных договоров')).to_have_count(0)
                with archive.expect_response(lambda res: res.url.endswith(endpoint)) as reconnect:
                    archive_context.set_offline(False)
                assert reconnect.value.status==200
                expect(archived_cards).to_have_count(2)
                with archive.expect_response(lambda res: res.url.endswith(endpoint)) as focus:
                    archive.evaluate("window.dispatchEvent(new Event('focus'))")
                assert focus.value.status==200
                expect(archived_cards).to_have_count(2)
            results.append('archive-list-rechecked-after-offline-and-focus')
        assert not errors,errors
        (out/'browser-result.json').write_text(json.dumps({'passed':results,'page_errors':errors,'browser':browser.version,'viewport':'390x844'},ensure_ascii=False,indent=2))
        print(json.dumps({'passed':results,'page_errors':errors},ensure_ascii=False))
    except BaseException:
        capture_failure(*sys.exc_info())
        raise
    finally:
        sys.excepthook=original_hook
        browser.close()
