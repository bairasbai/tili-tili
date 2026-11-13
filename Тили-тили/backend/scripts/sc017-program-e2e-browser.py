import json
import os
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


UI = 'http://127.0.0.1:3000'
API = UI + '/api'
FIXTURE = json.loads(Path(os.environ['E2E_FIXTURE_FILE']).read_text(encoding='utf-8'))
WEDDING = '/weddings/' + FIXTURE['weddingId']
TIMELINE = WEDDING + '/timeline'
OWNER = {'Authorization': 'Bearer ' + FIXTURE['owner']['tokens']['accessToken']}
FIRST = 'Церемония SC-017'
SECOND = 'Церемония SC-017 после правки'
CHECKBOX = 'Я ознакомился с этой версией программы'


def checked_response(response, status):
    assert response.status == status, f'Expected HTTP {status}, received {response.status}'
    return response


def verify_program(browser):
    owner = browser.new_context()
    slots = checked_response(owner.request.get(API + WEDDING + '/slots', headers=OWNER), 200).json()
    slot_id = next(slot['id'] for slot in slots if slot['categoryId'] == 'photo')
    slot = WEDDING + '/slots/' + slot_id
    booked = checked_response(owner.request.post(API + slot + '/external', headers=OWNER, data={
        'vendorName': 'Фотограф SC-017', 'phone': '+79170000000', 'price': {'amount': 500000, 'currency': 'RUB'},
    }), 200).json()
    invite = checked_response(owner.request.post(API + slot + '/external/invite', headers=OWNER), 201).json()
    link = '/guest-vendor/' + invite['token']
    read_path = '/api' + link + '/timeline'
    timeline = checked_response(owner.request.get(API + TIMELINE, headers=OWNER), 200)
    block = {'name': FIRST, 'startsAt': '2027-06-14T12:00:00Z', 'durationMinutes': 30,
             'responsible': {'kind': 'deal', 'id': booked['deal']['id']}, 'forGuests': False}

    def save(name, tag, status):
        return checked_response(owner.request.put(API + TIMELINE, headers={**OWNER, 'If-Match': tag},
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
                                        headers={**OWNER, 'Idempotency-Key': str(uuid4())}), 200)
    with contractor.expect_response(is_read) as refused:
        contractor.evaluate("window.dispatchEvent(new Event('focus'))")
    checked_response(refused.value, 410)
    expect(contractor.get_by_role('alert')).to_have_text('Ссылка истекла или отозвана')
    expect(contractor.get_by_text(SECOND, exact=True)).to_have_count(0)
    expect(contractor.get_by_placeholder('Сообщение…')).to_have_count(0)
    contractor.wait_for_function("localStorage.getItem('tt_program_offline') === null")
    assert not errors, errors


if __name__ == '__main__':
    with sync_playwright() as playwright:
        channel = os.environ.get('E2E_CHROMIUM_CHANNEL')
        browser = playwright.chromium.launch(headless=True, **({'channel': channel} if channel else {}))
        try:
            verify_program(browser)
        finally:
            browser.close()
    print('SC-017/018 passed: stale save, exact acknowledgment, cancelled contractor access')
