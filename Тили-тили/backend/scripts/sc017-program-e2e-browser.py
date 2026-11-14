import json
import os
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


UI = 'http://127.0.0.1:3000'
API = UI + '/api'
FIXTURE = json.loads(Path(os.environ['E2E_FIXTURE_FILE']).read_text(encoding='utf-8'))
FIRST = 'Церемония SC-017'
SECOND = 'Церемония SC-017 после правки'
CHECKBOX = 'Я ознакомился с этой версией программы'
EDITOR_LABELS = {
    'ru': ('Править', 'Изменить блок', 'Планирование блока', 'Название блока',
           'Сохранить блок', 'Отмена', 'Обновить'),
    'en': ('Edit', 'Edit block', 'Block planning', 'Block name', 'Save block', 'Cancel', 'Refresh'),
}


def checked_response(response, status):
    assert response.status == status, f'Expected HTTP {status}, received {response.status}'
    return response


def tab_to(page, target):
    expect(target).to_be_visible()
    for _ in range(60):
        if target.evaluate('el => el === document.activeElement'):
            return
        page.keyboard.press('Tab')
    expect(target).to_be_focused()


def outlined(target):
    expect(target).to_be_focused()
    assert target.evaluate("""el => el.matches(':focus-visible')
        && getComputedStyle(el).outlineStyle !== 'none'
        && parseFloat(getComputedStyle(el).outlineWidth) >= 2""")


def verify_editor(browser, lang):
    edit, edit_block, form_name, field_name, save, cancel, refresh = EDITOR_LABELS[lang]
    account = FIXTURE['timelineEditors'][lang]
    tokens = account['first']
    headers = {'Authorization': 'Bearer ' + tokens['accessToken']}
    other_session = {'Authorization': 'Bearer ' + account['reopened']['accessToken']}
    context = browser.new_context(viewport={'width': 390, 'height': 844})
    errors = []
    try:
        checked = checked_response(context.request.post(API + '/weddings', headers=headers, data={
            'partnerName': f'WP03 {lang}', 'city': {'name': 'Уфа', 'region': 'Башкортостан'}, 'date': '2027-06-14',
        }), 201)
        wedding_id = checked.json()['id']
        timeline = API + '/weddings/' + wedding_id + '/timeline'
        ceremony, dinner = 'Ceremony WP03', 'Dinner WP03'
        blocks = [{'name': ceremony, 'startsAt': '2027-06-14T12:00:00Z', 'durationMinutes': 30, 'forGuests': True},
                  {'name': dinner, 'startsAt': '2027-06-14T14:00:00Z', 'durationMinutes': 30, 'forGuests': True}]
        etag = checked_response(context.request.get(timeline, headers=headers), 200).headers['etag']
        initial = checked_response(context.request.put(timeline, headers={**headers, 'If-Match': etag}, data=blocks), 200)
        initial_blocks = initial.json()
        ceremony_id, dinner_id = [row['id'] for row in initial_blocks]
        context.add_init_script(f"""localStorage.setItem('tt_auth', JSON.stringify({json.dumps(tokens)}));
          localStorage.setItem('tt_onboarded', '1');
          localStorage.setItem('tt_wedding_id', JSON.stringify({json.dumps(wedding_id)}));
          localStorage.setItem('tt_lang', {json.dumps(lang)});""")
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(type(error).__name__))
        page.bring_to_front()
        page.goto(UI + '/wedding/timeline')
        mode = page.get_by_role('button', name=edit, exact=True)
        tab_to(page, mode)
        outlined(mode)
        page.keyboard.press('Enter')
        trigger = page.get_by_role('button', name=f'{edit_block}: {dinner}')
        expect(trigger).to_be_enabled()
        tab_to(page, trigger)
        outlined(trigger)
        page.keyboard.press('Enter')
        form = page.get_by_role('form', name=form_name)
        field = form.get_by_role('textbox', name=field_name)
        outlined(field)
        dependency = form.get_by_role('checkbox', name=ceremony)
        tab_to(page, dependency)
        outlined(dependency)
        page.keyboard.press('Space')
        expect(dependency).to_be_checked()
        for width in (320, 390, 480):
            page.set_viewport_size({'width': width, 'height': 844})
            assert form.evaluate('el => el.getBoundingClientRect().right <= innerWidth'), f'Editor overflows at {width}px'
        tab_to(page, form.get_by_role('button', name=cancel))
        page.keyboard.press('Enter')
        expect(form).to_have_count(0)
        outlined(trigger)
        page.keyboard.press('Enter')
        outlined(field)
        expect(dependency).not_to_be_checked()
        tab_to(page, dependency)
        page.keyboard.press('Space')
        commit = form.get_by_role('button', name=save)
        tab_to(page, commit)
        with page.expect_response(lambda r: r.url.endswith(f'/weddings/{wedding_id}/timeline') and r.request.method == 'PUT') as saved:
            page.keyboard.press('Enter')
        persisted = checked_response(saved.value, 200)
        assert next(row for row in persisted.json() if row['id'] == dinner_id)['dependsOn'] == [ceremony_id]
        expect(form).to_have_count(0)
        outlined(trigger)
        expect(trigger).to_be_enabled()
        page.keyboard.press('Enter')
        outlined(field)
        page.keyboard.press('End')
        page.keyboard.insert_text(' draft')
        current = checked_response(context.request.get(timeline, headers=other_session), 200)
        replacement = [{**row, 'id': row_id, 'name': 'Ceremony from another session'} if row_id == ceremony_id
                       else {**row, 'id': row_id, 'dependsOn': [ceremony_id]}
                       for row, row_id in zip(blocks, (ceremony_id, dinner_id))]
        checked_response(context.request.put(timeline, headers={**other_session, 'If-Match': current.headers['etag']}, data=replacement), 200)
        tab_to(page, commit)
        with page.expect_response(lambda r: r.url.endswith(f'/weddings/{wedding_id}/timeline') and r.request.method == 'PUT') as denied:
            page.keyboard.press('Enter')
        checked_response(denied.value, 409)
        expect(form.get_by_role('alert')).to_be_visible()
        expect(field).to_have_value(dinner + ' draft')
        expect(commit).to_be_disabled()
        outlined(commit)
        reread = page.get_by_role('button', name=refresh, exact=True)
        tab_to(page, reread)
        page.keyboard.press('Enter')
        expect(page.get_by_text('Ceremony from another session', exact=True)).to_be_visible()
        expect(field).to_have_value(dinner + ' draft')
        expect(commit).to_be_disabled()
        saved_blocks = checked_response(context.request.get(timeline, headers=headers), 200).json()
        assert next(row for row in saved_blocks if row['id'] == dinner_id)['name'] == dinner
        assert not errors, errors
    finally:
        context.close()


def verify_program(browser):
    owner = browser.new_context()
    headers = {'Authorization': 'Bearer ' + FIXTURE['timelineEditors']['contractor']['accessToken']}
    created = checked_response(owner.request.post(API + '/weddings', headers=headers, data={
        'partnerName': 'Программа подрядчика SC-017', 'city': {'name': 'Уфа', 'region': 'Башкортостан'},
        'date': '2027-06-14',
    }), 201)
    wedding = '/weddings/' + created.json()['id']
    timeline_path = wedding + '/timeline'
    slots = checked_response(owner.request.get(API + wedding + '/slots', headers=headers), 200).json()
    slot_id = next(slot['id'] for slot in slots if slot['categoryId'] == 'photo')
    slot = wedding + '/slots/' + slot_id
    booked = checked_response(owner.request.post(API + slot + '/external', headers=headers, data={
        'vendorName': 'Фотограф SC-017', 'phone': '+79170000000', 'price': {'amount': 500000, 'currency': 'RUB'},
    }), 200).json()
    invite = checked_response(owner.request.post(API + slot + '/external/invite', headers=headers), 201).json()
    link = '/guest-vendor/' + invite['token']
    read_path = '/api' + link + '/timeline'
    timeline = checked_response(owner.request.get(API + timeline_path, headers=headers), 200)
    block = {'name': FIRST, 'startsAt': '2027-06-14T12:00:00Z', 'durationMinutes': 30,
             'responsible': {'kind': 'deal', 'id': booked['deal']['id']}, 'forGuests': False}

    def save(name, tag, status):
        return checked_response(owner.request.put(API + timeline_path, headers={**headers, 'If-Match': tag},
                                                  data=[{**block, 'name': name}]), status)

    first = save(FIRST, timeline.headers['etag'], 200)
    contractor = browser.new_page(viewport={'width': 390, 'height': 844})
    errors = []
    contractor.on('pageerror', lambda error: errors.append(type(error).__name__))
    contractor.goto(UI + link)
    expect(contractor.get_by_text(FIRST, exact=True)).to_be_visible()
    expect(contractor.get_by_placeholder('Сообщение…')).to_be_visible()
    contractor.wait_for_function("localStorage.getItem('tt_program_offline') !== null")
    checkbox = contractor.get_by_role('checkbox', name=CHECKBOX)
    checkbox.check()
    confirm = contractor.get_by_role('button', name='Подтвердить ознакомление')
    expect(confirm).to_be_enabled()

    second = save(SECOND, first.headers['etag'], 200)
    save(FIRST, first.headers['etag'], 409)

    def is_read(response):
        return response.request.method == 'GET' and urlparse(response.url).path == read_path

    with contractor.expect_response(is_read) as refreshed:
        contractor.evaluate("window.dispatchEvent(new Event('focus'))")
    checked_response(refreshed.value, 200)
    expect(contractor.get_by_text(SECOND, exact=True)).to_be_visible()
    expect(contractor.get_by_text(FIRST, exact=True)).to_have_count(0)
    expect(checkbox).not_to_be_checked()
    expect(confirm).to_be_disabled()

    checkbox.check()
    with contractor.expect_response(lambda r: r.request.method == 'POST' and urlparse(r.url).path == read_path + '/ack') as acknowledged:
        confirm.click()
    receipt = checked_response(acknowledged.value, 200)
    assert receipt.request.header_value('if-match') == second.headers['etag']
    assert receipt.json()['sourceVersion'] == second.headers['etag'].strip('"')
    expect(contractor.get_by_text('Версия подтверждена', exact=False)).to_be_visible()

    checked_response(owner.request.post(API + slot + '/cancel',
                                        headers={**headers, 'Idempotency-Key': str(uuid4())}), 200)
    with contractor.expect_response(is_read) as refused:
        contractor.evaluate("window.dispatchEvent(new Event('focus'))")
    checked_response(refused.value, 410)
    expect(contractor.get_by_role('alert')).to_have_text('Ссылка истекла или отозвана')
    expect(contractor.get_by_text(SECOND, exact=True)).to_have_count(0)
    expect(contractor.get_by_placeholder('Сообщение…')).to_have_count(0)
    contractor.wait_for_function("localStorage.getItem('tt_program_offline') === null")
    assert not errors, errors
    contractor.context.close()
    owner.close()


if __name__ == '__main__':
    passed = []
    with sync_playwright() as playwright:
        channel = os.environ.get('E2E_CHROMIUM_CHANNEL')
        browser = playwright.chromium.launch(headless=True, **({'channel': channel} if channel else {}))
        try:
            verify_program(browser)
            passed.append('contractor-version-and-revocation')
            for lang in EDITOR_LABELS:
                verify_editor(browser, lang)
                passed.append('timeline-editor-keyboard-' + lang)
            result = Path(os.environ['E2E_RESULT_DIR']) / 'sc017-program-result.json'
            result.parent.mkdir(parents=True, exist_ok=True)
            result.write_text(json.dumps({'passed': passed}), encoding='utf-8')
        finally:
            browser.close()
    print('SC-017/018 passed: ' + ', '.join(passed))
