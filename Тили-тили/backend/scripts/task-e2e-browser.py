import json,re,pathlib,os,uuid
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
    helper=context(f['helper']); h=helper.new_page()
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
    page.get_by_role('button',name='Добавить расход',exact=True).click()
    expect(page.get_by_label('Ответственный',exact=True)).to_have_count(0)
    results.append('budget-form-regression')
    assert not errors,errors
    (out/'browser-result.json').write_text(json.dumps({'passed':results,'page_errors':errors,'browser':browser.version,'viewport':'390x844'},ensure_ascii=False,indent=2))
    print(json.dumps({'passed':results,'page_errors':errors},ensure_ascii=False))
    browser.close()
