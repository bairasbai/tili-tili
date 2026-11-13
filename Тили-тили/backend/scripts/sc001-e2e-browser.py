import calendar
import json
import os
import re
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


UI = 'http://127.0.0.1:3000'
API = 'http://127.0.0.1:3001'
MENU = 'Утвердить окончательное меню'
DATE_TASK = 'Выбрать дату свадьбы'
PHOTO_TASK = 'Найти фотографа'
FIXTURE = json.loads(Path(os.environ['E2E_FIXTURE_FILE']).read_text(encoding='utf-8'))
TODAY = date.fromisoformat(FIXTURE['today'])


def context(browser, tokens, errors, *, reopened=False):
    session = browser.new_context(viewport={'width': 390, 'height': 844}, timezone_id='UTC')
    # A new browser and server session with no remembered wedding, date or quiz answers.
    session.add_init_script(f"""if (!localStorage.getItem('tt_auth')) {{
      localStorage.setItem('tt_auth', JSON.stringify({json.dumps(tokens)}));
      {'localStorage.setItem("tt_onboarded", "1");' if reopened else ''}
    }}""")
    page = session.new_page()
    page.on('pageerror', lambda error: errors.append(type(error).__name__))
    return session, page


def read(session, tokens, path):
    response = session.request.get(API + path, headers={'Authorization': 'Bearer ' + tokens['accessToken']})
    assert response.ok, f'GET {path} returned {response.status}'
    return response.json()


def next_step(page):
    page.get_by_role('button', name='Далее', exact=True).click()


def skip(page):
    page.get_by_role('button', name='Пропустить вопрос').click()


def choose_day(page, current, target):
    picker = page.get_by_role('dialog', name='Выбор даты свадьбы')
    offset = (target.year - current.year) * 12 + target.month - current.month
    direction = 'Следующий месяц' if offset >= 0 else 'Предыдущий месяц'
    for _ in range(abs(offset)):
        picker.get_by_role('button', name=direction).click()
    label = page.evaluate(
        """iso => new Intl.DateTimeFormat('ru-RU', { dateStyle: 'full', timeZone: 'UTC' })
          .format(new Date(iso + 'T12:00:00Z'))""",
        target.isoformat(),
    )
    picker.get_by_role('button', name=label, exact=True).click()


def month_before(day):
    year, month = (day.year, day.month - 1) if day.month > 1 else (day.year - 1, 12)
    return date(year, month, min(day.day, calendar.monthrange(year, month)[1]))


def short_date(day):
    return day.strftime('%d.%m.%Y')


def date_button(page, day):
    label = page.evaluate(
        """iso => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
          .format(new Date(iso + 'T12:00:00Z'))""",
        day.isoformat(),
    )
    return page.get_by_role('button', name=re.compile(re.escape(label)))


def create_wedding(page, initial):
    page.goto(UI + '/quiz')
    page.get_by_role('button', name='Выбрать день в календаре').click()
    choose_day(page, TODAY, initial or TODAY + timedelta(days=30))
    if initial:
        next_step(page)
    else:
        skip(page)  # Clear a date already selected in the calendar.
    page.get_by_role('button', name='Уфа', exact=True).click()
    next_step(page)
    if initial:
        page.get_by_role('button', name='До 30', exact=True).click()
        next_step(page)
    else:
        skip(page)
    skip(page)  # Budget.
    skip(page)  # Format.
    skip(page)  # Style.
    skip(page)  # Planner.
    page.get_by_role('button', name='Фотограф', exact=True).click()
    next_step(page)
    page.get_by_role('textbox', name='Имя партнёра').fill('Партнёр SC-001')
    with page.expect_response(lambda reply: reply.request.method == 'POST' and urlparse(reply.url).path == '/api/weddings') as created:
        page.get_by_role('button', name='Создать мою свадьбу ✨').click()
    assert created.value.status == 201, f'Wedding creation returned {created.value.status}'
    expect(page).to_have_url(UI + '/home')
    return created.value.json()['id']


def verify_wedding(session, tokens, path, saved_date, short):
    wedding = read(session, tokens, path)
    assert wedding['date'] == (saved_date.isoformat() if saved_date else None)
    assert wedding['guestsPlanned'] == (30 if short else None)
    assert all(wedding[key] is None for key in ('budgetTotal', 'format', 'style', 'planner', 'venue'))
    slots = read(session, tokens, path + '/slots')
    photo = next(slot for slot in slots if slot['categoryId'] == 'photo')
    assert photo['prebooked'] and photo['deal'] is None
    tasks = {task['title']: task for task in read(session, tokens, path + '/tasks')}
    assert tasks[PHOTO_TASK]['done'] and tasks[DATE_TASK]['done'] == bool(saved_date)
    assert tasks[MENU]['due'] == (month_before(saved_date).isoformat() if saved_date else None)
    if not saved_date:
        assert all(task['due'] is None for task in tasks.values())
    return tasks[MENU]['id']


def verify_case(browser, accounts, short, errors):
    owner_tokens, helper_tokens = accounts['owner']['first'], accounts['helper']['first']
    owner, page = context(browser, owner_tokens, errors)
    helper, recipient = context(browser, helper_tokens, errors)
    initial = TODAY + timedelta(days=30) if short else None
    target = TODAY + timedelta(days=34 if short else 30)
    path = '/weddings/' + create_wedding(page, initial)
    expect(page.get_by_test_id('prebooked-slot').get_by_text('Фотограф', exact=True)).to_be_visible()
    menu_id = verify_wedding(owner, owner_tokens, path, initial, short)
    page.goto(UI + '/wedding/checklist')
    if short:
        expect(page.get_by_role('region', name='Приоритеты подготовки')).to_be_visible()
    else:
        expect(page.get_by_role('button', name=re.compile('^' + DATE_TASK))).to_be_visible()
    page.goto(UI + '/wedding/task-delegations')
    page.get_by_label('Задача для помощника').select_option(label=MENU)
    page.get_by_role('button', name='Создать ссылку для помощника').click()
    link = page.get_by_label('Ссылка для помощника')
    expect(link).to_be_visible()
    recipient.goto(link.input_value())
    recipient.get_by_role('button', name='Принять поручение').click()
    expect(recipient.get_by_role('heading', name=MENU)).to_be_visible()

    page.goto(UI + '/us')
    if initial:
        date_button(page, initial).click()
    else:
        page.get_by_role('button', name=re.compile('^' + DATE_TASK)).click()
    choose_day(page, initial or TODAY, target)
    preview = page.get_by_role('dialog', name='Предпросмотр переноса')
    menu = preview.get_by_role('region', name='Сроки задач').get_by_role('listitem').filter(has_text=MENU)
    before = short_date(month_before(initial)) if initial else 'Дата не указана'
    after = short_date(month_before(target))
    expect(menu).to_contain_text(f'{before} → {after}')
    verify_wedding(owner, owner_tokens, path, initial, short)
    with page.expect_response(lambda reply: reply.request.method == 'POST' and urlparse(reply.url).path.endswith('/reschedule')) as moved:
        preview.get_by_role('button', name='Подтвердить перенос').click()
    assert moved.value.status == 200, f'Reschedule returned {moved.value.status}'
    assert moved.value.request.post_data_json['previewToken']
    expect(preview).to_be_hidden()
    owner.close()
    helper.close()

    reopened_owner, page = context(browser, accounts['owner']['reopened'], errors, reopened=True)
    reopened_helper, recipient = context(browser, accounts['helper']['reopened'], errors, reopened=True)
    page.goto(UI + '/us')
    expect(date_button(page, target)).to_be_visible()
    assert verify_wedding(reopened_owner, accounts['owner']['reopened'], path, target, short) == menu_id
    page.goto(UI + '/home')
    expect(page.get_by_test_id('prebooked-slot').get_by_text('Фотограф', exact=True)).to_be_visible()
    recipient.goto(UI + '/delegated-tasks')
    assignment = recipient.get_by_role('article').filter(has_text=MENU)
    expect(assignment.get_by_text(after, exact=True)).to_be_visible()
    reopened_owner.close()
    reopened_helper.close()


def main():
    passed, errors = [], []
    output = Path(os.environ['E2E_RESULT_DIR']) / 'sc001-browser-result.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with sync_playwright() as playwright:
            channel = os.environ.get('E2E_CHROMIUM_CHANNEL')
            browser = playwright.chromium.launch(headless=True, **({'channel': channel} if channel else {}))
            try:
                for case in ('undated', 'short'):
                    verify_case(browser, FIXTURE['sc001'][case], case == 'short', errors)
                    passed.append(case)
                assert not errors, errors
            finally:
                browser.close()
    finally:
        output.write_text(json.dumps({'passed': passed, 'page_errors': errors}), encoding='utf-8')
    print('SC-001 passed: ' + ', '.join(passed))


if __name__ == '__main__':
    main()
