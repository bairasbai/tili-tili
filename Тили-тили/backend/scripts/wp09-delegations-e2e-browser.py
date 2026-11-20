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
    tab_to(page, target)
    with page.expect_response(lambda res: res.request.method == method and urlparse(res.url).path == path) as pending:
        page.keyboard.press('Enter')
    assert pending.value.status == status, f'{method} {path} returned {pending.value.status}'
    return pending.value


def signed(browser, fixture, actor, lang, errors):
    context = browser.new_context(viewport={'width': 390, 'height': 844})
    context.add_init_script(f"""localStorage.setItem('tt_auth', JSON.stringify({json.dumps(fixture[actor])}));
      localStorage.setItem('tt_onboarded', '1');
      localStorage.setItem('tt_wedding_id', JSON.stringify({json.dumps(fixture['weddingId'] if actor == 'owner' else None)}));
      localStorage.setItem('tt_lang', {json.dumps(lang)});""")
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(type(error).__name__))
    return page


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
        tab_to(owner, select)
        option = select.get_by_role('option', name=title, exact=True)
        index = option.evaluate('el => el.index')
        owner.keyboard.press('Home')
        for _ in range(index):
            owner.keyboard.press('ArrowDown')
        assert select.input_value() == option.get_attribute('value')
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


def main():
    errors, passed = [], []
    with sync_playwright() as playwright:
        channel = os.environ.get('E2E_CHROMIUM_CHANNEL')
        browser = playwright.chromium.launch(headless=True, **({'channel': channel} if channel else {}))
        try:
            for lang in LABELS:
                verify(browser, lang, errors)
                passed.append('task-delegation-keyboard-' + lang)
            assert not errors, errors
        finally:
            browser.close()
    result = Path(os.environ['E2E_RESULT_DIR']) / 'wp09-delegations-result.json'
    result.parent.mkdir(parents=True, exist_ok=True)
    result.write_text(json.dumps({'passed': passed, 'page_errors': errors}), encoding='utf-8')
    print('WP09 passed: ' + ', '.join(passed))


if __name__ == '__main__':
    main()
