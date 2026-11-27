import json
import os
import re
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


UI = 'http://127.0.0.1:3000'
MY_TASKS = '/api/users/me/task-delegations'
FIXTURE = json.loads(Path(os.environ['E2E_FIXTURE_FILE']).read_text(encoding='utf-8'))['wp09']
LABELS = {
    'ru': ('Приоритеты подготовки', 'Подтвердить время и места встречи с командой', 'Задача для помощника',
           'Создать ссылку для помощника', 'Ссылка для помощника', 'Принять поручение', 'Мои поручения',
           'Отметить выполненной', 'Вернуть в работу', 'Нет связи с сервером', 'Отозвать поручение', 'Поручений пока нет'),
    'en': ('Planning priorities', 'Confirm times and meeting points with the team', 'Task for a helper',
           'Create an invitation link', 'Helper invitation link', 'Accept task', 'My delegated tasks',
           'Mark as done', 'Move back to active', 'No connection to the server', 'Revoke access', 'No delegated tasks yet'),
}
COORDINATOR_LABELS = {
    'ru': {
        'wedding': 'Выбранная свадьба', 'employee_code': 'Код сотрудника', 'my_code': 'Мой код сотрудника',
        'issue': 'Создать ссылку сотруднику', 'remove': 'Отозвать доступ сотрудника',
        'confirm': 'Подтвердить отзыв доступа', 'cancel': 'Отмена',
    },
    'en': {
        'wedding': 'Selected wedding', 'employee_code': 'Employee code', 'my_code': 'My employee code',
        'issue': 'Create employee invite', 'remove': 'Remove employee access',
        'confirm': 'Confirm access removal', 'cancel': 'Cancel',
    },
}


def outlined(target):
    expect(target).to_be_focused()
    assert target.evaluate("""el => el.matches(':focus-visible')
        && getComputedStyle(el).outlineStyle !== 'none'
        && parseFloat(getComputedStyle(el).outlineWidth) >= 2""")


def tab_to(page, target):
    expect(target).to_be_visible()
    for _ in range(90):
        if target.evaluate('el => el === document.activeElement'):
            break
        page.keyboard.press('Tab')
    outlined(target)


def browser_write(page, target, method, path, status):
    expect(target).to_be_enabled()
    tab_to(page, target)
    with page.expect_response(lambda res: res.request.method == method and urlparse(res.url).path == path) as pending:
        page.keyboard.press('Enter')
    assert pending.value.status == status, f'{method} {path} returned {pending.value.status}'
    return pending.value


def signed(browser, fixture, actor, lang, errors):
    context = browser.new_context(viewport={'width': 390, 'height': 844})
    context.add_init_script(f"""localStorage.setItem('tt_auth', JSON.stringify({json.dumps(fixture[actor])}));
      localStorage.setItem('tt_onboarded', '1');
      localStorage.setItem('tt_wedding_id', JSON.stringify({json.dumps(fixture['weddingId'] if actor != 'recipient' else None)}));
      localStorage.setItem('tt_lang', {json.dumps(lang)});""")
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(type(error).__name__))
    return page


def choose_option(page, select, option):
    tab_to(page, select)
    index = option.evaluate('el => el.index')
    page.keyboard.press('Home')
    for _ in range(index):
        page.keyboard.press('ArrowDown')
    expect(select).to_have_value(option.get_attribute('value'))


def verify(browser, lang, errors):
    priorities, first_task, selector, issue, link_label, accept, board, done, undo, offline, revoke, empty = LABELS[lang]
    fixture = FIXTURE[lang]
    title = fixture['taskTitle']
    path = f"/api/weddings/{fixture['weddingId']}/task-delegations"
    owner = signed(browser, fixture, 'owner', lang, errors)
    recipient = signed(browser, fixture, 'recipient', lang, errors)
    try:
        owner.bring_to_front()
        owner.goto(UI + '/wedding/checklist')
        priority = owner.get_by_role('region', name=priorities).get_by_role('button', name=re.compile('^' + first_task))
        tab_to(owner, priority)
        owner.keyboard.press('Enter')
        outlined(owner.get_by_role('button', name=re.compile('^' + first_task), expanded=True))
        owner.goto(UI + '/wedding/task-delegations')
        select = owner.get_by_role('combobox', name=selector)
        option = select.get_by_role('option', name=title, exact=True)
        choose_option(owner, select, option)
        issued = browser_write(owner, owner.get_by_role('button', name=issue), 'POST', path, 201).json()
        link = owner.get_by_role('textbox', name=link_label)
        outlined(link)
        assert urlparse(link.input_value()).fragment == issued['code']

        recipient.bring_to_front()
        recipient.goto(link.input_value())
        region = recipient.get_by_role('region', name=board)
        browser_write(recipient, region.get_by_role('button', name=accept), 'POST', MY_TASKS + '/accept', 204)
        expect(recipient).to_have_url(UI + '/delegated-tasks')
        card = region.get_by_role('article').filter(has_text=title)
        expect(card).to_be_visible()
        for width in (320, 390, 480):
            recipient.set_viewport_size({'width': width, 'height': 844})
            assert card.evaluate('el => el.getBoundingClientRect().right <= innerWidth')
        browser_write(recipient, card.get_by_role('button', name=done), 'PUT', MY_TASKS + '/' + issued['id'] + '/completion', 204)
        expect(card.get_by_role('button', name=undo)).to_be_visible()
        outlined(region)
        tab_to(recipient, card.get_by_role('button', name=undo))
        recipient.context.set_offline(True)
        expect(region.get_by_role('status')).to_have_text(offline)
        expect(card).to_have_count(0)
        outlined(region)
        owner.bring_to_front()
        owner_card = owner.get_by_role('article').filter(has_text=title)
        browser_write(owner, owner_card.get_by_role('button', name=revoke), 'DELETE', path + '/' + issued['id'], 204)
        recipient.bring_to_front()
        with recipient.expect_response(lambda res: res.request.method == 'GET' and urlparse(res.url).path == MY_TASKS) as refreshed:
            recipient.context.set_offline(False)
        assert refreshed.value.status == 200 and refreshed.value.json() == []
        expect(region.get_by_text(empty, exact=True)).to_be_visible()
        expect(card).to_have_count(0)
        outlined(region)
    finally:
        recipient.context.close()
        owner.context.close()


def verify_coordinator(browser, lang, errors):
    _, _, selector, _, link_label, accept, board, done, undo, offline, _, _ = LABELS[lang]
    labels = COORDINATOR_LABELS[lang]
    fixture = FIXTURE[lang]
    coordinator = signed(browser, fixture, 'coordinator', lang, errors)
    recipient = signed(browser, fixture, 'recipient', lang, errors)
    try:
        recipient.goto(UI + '/delegated-tasks')
        region = recipient.get_by_role('region', name=board)
        tab_to(recipient, region.get_by_role('button', name=labels['my_code']))
        recipient.keyboard.press('Enter')
        code_field = region.get_by_role('textbox', name=labels['employee_code'])
        expect(code_field).to_have_value(re.compile(r'^[0-9a-f-]{36}$'))
        employee_code = code_field.input_value()

        coordinator.goto(UI + '/wedding/task-delegations')
        picker = coordinator.get_by_role('combobox', name=labels['wedding'])
        task_select = coordinator.get_by_role('combobox', name=selector)

        def issue_and_accept(wedding_id, title):
            coordinator.bring_to_front()
            if picker.input_value() != wedding_id:
                choose_option(coordinator, picker, picker.locator(f'option[value="{wedding_id}"]'))
            choose_option(coordinator, task_select, task_select.get_by_role('option', name=title, exact=True))
            issue = coordinator.get_by_role('button', name=labels['issue'])
            expect(issue).to_be_disabled()
            target = coordinator.get_by_role('textbox', name=labels['employee_code'])
            tab_to(coordinator, target)
            coordinator.keyboard.insert_text(employee_code)
            path = f'/api/weddings/{wedding_id}/task-delegations'
            response = browser_write(coordinator, issue, 'POST', path, 201)
            assert response.request.post_data_json['targetUserId'] == employee_code
            invitation = response.json()
            link = coordinator.get_by_role('textbox', name=link_label)
            outlined(link)
            assert urlparse(link.input_value()).fragment == invitation['code']

            recipient.bring_to_front()
            recipient.goto(link.input_value())
            browser_write(recipient, region.get_by_role('button', name=accept), 'POST', MY_TASKS + '/accept', 204)
            expect(recipient).to_have_url(UI + '/delegated-tasks')
            expect(region.get_by_role('article').filter(has_text=title)).to_be_visible()
            return invitation

        first_title, other_title = fixture['coordinatorTaskTitle'], fixture['otherTaskTitle']
        first = issue_and_accept(fixture['weddingId'], first_title)
        other = issue_and_accept(fixture['otherWeddingId'], other_title)
        first_card = region.get_by_role('article').filter(has_text=first_title)
        other_card = region.get_by_role('article').filter(has_text=other_title)
        expect(first_card).to_be_visible()
        expect(other_card).to_be_visible()
        for width in (320, 390, 480):
            recipient.set_viewport_size({'width': width, 'height': 844})
            assert other_card.evaluate('el => el.getBoundingClientRect().right <= innerWidth')
        browser_write(recipient, first_card.get_by_role('button', name=done),
                      'PUT', MY_TASKS + '/' + first['id'] + '/completion', 204)
        expect(first_card.get_by_role('button', name=undo)).to_be_visible()
        recipient.context.set_offline(True)
        expect(region.get_by_role('status')).to_have_text(offline)
        expect(first_card).to_have_count(0)
        expect(other_card).to_have_count(0)

        coordinator.bring_to_front()
        choose_option(coordinator, picker, picker.locator(f"option[value='{fixture['weddingId']}']"))
        board_path = f"/api/weddings/{fixture['weddingId']}/task-delegations"
        remove_path = f'{board_path}/recipients/{employee_code}'
        removals = []

        def record_delete(request):
            if request.method == 'DELETE':
                removals.append(request)

        def is_board_read(response):
            return response.request.method == 'GET' and urlparse(response.url).path == board_path

        coordinator.on('request', record_delete)
        remove = coordinator.get_by_role('button', name=labels['remove'])
        tab_to(coordinator, remove)
        coordinator.keyboard.press('Enter')
        confirm = coordinator.get_by_role('button', name=labels['confirm'])
        expect(confirm).to_be_enabled()
        cancel = coordinator.get_by_role('button', name=labels['cancel'], exact=True)
        outlined(cancel)

        held_reads = []

        def delay_board(route):
            if route.request.method == 'GET' and not held_reads:
                held_reads.append(route)
            else:
                route.continue_()

        coordinator.route('**' + board_path, delay_board)
        with coordinator.expect_request(lambda req: req.method == 'GET' and urlparse(req.url).path == board_path):
            coordinator.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(confirm).to_be_disabled()
        coordinator.keyboard.press('Enter')
        expect(confirm).to_have_count(0)
        outlined(remove)
        expect(coordinator.get_by_role('article').filter(has_text=first_title)).to_be_visible()
        assert not removals
        assert len(held_reads) == 1
        with coordinator.expect_response(is_board_read):
            held_reads[0].continue_()
        coordinator.unroute('**' + board_path, delay_board)

        expect(remove).to_be_enabled()
        tab_to(coordinator, remove)
        coordinator.keyboard.press('Enter')
        outlined(cancel)

        # A second manager session replaces the grant while this confirmation is open.
        manager_headers = {'Authorization': 'Bearer ' + fixture['coordinatorReopened']['accessToken']}
        employee_headers = {'Authorization': 'Bearer ' + fixture['recipient']['accessToken']}
        replacement_title = fixture['replacementTaskTitle']
        replacement_id = task_select.get_by_role('option', name=replacement_title, exact=True).get_attribute('value')

        def retire_in_other_session(grant_id):
            retired = coordinator.request.delete(UI + remove_path, headers=manager_headers,
                                                 params={'delegationId': grant_id})
            assert retired.status == 204

        def grant_in_other_session():
            replacement = coordinator.request.post(UI + board_path, headers=manager_headers,
                                                    data={'taskId': replacement_id, 'targetUserId': employee_code})
            assert replacement.status == 201
            issued = replacement.json()
            accepted = recipient.request.post(UI + MY_TASKS + '/accept', headers=employee_headers,
                                              data={'code': issued['code']})
            assert accepted.status == 204
            return issued

        retire_in_other_session(first['id'])
        grant = grant_in_other_session()
        with coordinator.expect_response(is_board_read):
            coordinator.evaluate("window.dispatchEvent(new Event('focus'))")
        replacement_card = coordinator.get_by_role('article').filter(has_text=replacement_title)
        expect(replacement_card).to_be_visible()

        with coordinator.expect_response(is_board_read) as rechecked:
            stale = browser_write(coordinator, confirm, 'DELETE', remove_path, 204)
        assert urlparse(stale.url).query == f"delegationId={first['id']}"
        assert [item['id'] for item in rechecked.value.json()['items']] == [grant['id']]
        expect(replacement_card).to_be_visible()
        outlined(task_select)
        assert len(removals) == 1

        expect(remove).to_be_enabled()
        tab_to(coordinator, remove)
        coordinator.keyboard.press('Enter')
        outlined(cancel)
        retire_in_other_session(grant['id'])
        with coordinator.expect_response(is_board_read) as emptied:
            coordinator.evaluate("window.dispatchEvent(new Event('focus'))")
        assert emptied.value.json()['items'] == []
        expect(confirm).to_have_count(0)
        outlined(task_select)

        grant = grant_in_other_session()
        with coordinator.expect_response(is_board_read):
            coordinator.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(replacement_card).to_be_visible()
        expect(confirm).to_have_count(0)
        expect(remove).to_be_enabled()
        tab_to(coordinator, remove)
        coordinator.keyboard.press('Enter')
        removal = browser_write(coordinator, confirm, 'DELETE', remove_path, 204)
        assert urlparse(removal.url).query == f"delegationId={grant['id']}"
        expect(replacement_card).to_have_count(0)
        outlined(task_select)
        assert len(removals) == 2

        with recipient.expect_response(lambda res: res.request.method == 'GET' and urlparse(res.url).path == MY_TASKS) as refreshed:
            recipient.context.set_offline(False)
        assert refreshed.value.status == 200
        assert [task['id'] for task in refreshed.value.json()] == [other['id']]
        expect(first_card).to_have_count(0)
        expect(other_card).to_be_visible()
    finally:
        recipient.context.close()
        coordinator.context.close()


def main():
    errors, passed = [], []
    with sync_playwright() as playwright:
        channel = os.environ.get('E2E_CHROMIUM_CHANNEL')
        browser = playwright.chromium.launch(headless=True, **({'channel': channel} if channel else {}))
        try:
            for lang in LABELS:
                verify(browser, lang, errors)
                passed.append('task-delegation-keyboard-' + lang)
            for lang in COORDINATOR_LABELS:
                verify_coordinator(browser, lang, errors)
                passed.append('coordinator-employee-access-' + lang)
            assert not errors, errors
        finally:
            browser.close()
    result = Path(os.environ['E2E_RESULT_DIR']) / 'wp09-delegations-result.json'
    result.parent.mkdir(parents=True, exist_ok=True)
    result.write_text(json.dumps({'passed': passed, 'page_errors': errors}), encoding='utf-8')
    print('WP09 passed: ' + ', '.join(passed))


if __name__ == '__main__':
    main()
