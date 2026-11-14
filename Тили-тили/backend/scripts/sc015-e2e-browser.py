import json
import os
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


UI = 'http://127.0.0.1:3000'
FIXTURE = json.loads(Path(os.environ['E2E_FIXTURE_FILE']).read_text(encoding='utf-8'))['sc015']
WEDDING = '/weddings/' + FIXTURE['weddingId']
MESSAGE = 'Спасибо, что разделили этот день с нами!'
OWNER_HEADERS = {'Authorization': 'Bearer ' + FIXTURE['owner']['accessToken']}
THANKS = {
    'ru': ('Поблагодарить гостей', 'Текст благодарности', 'Предпросмотр благодарности',
           'Проверьте текст и приглашения', 'Изменить текст или получателей',
           'Подтвердить и разместить', 'Благодарность размещена · Приглашений: 1'),
    'en': ('Thank your guests', 'Thank-you message', 'Preview the thank-you message',
           'Review the message and invitations', 'Edit message or recipients',
           'Confirm and post', 'Thank-you message posted · Invitations: 1'),
}


def tab_to(page, target):
    expect(target).to_be_visible()
    page.bring_to_front()
    for _ in range(45):
        page.keyboard.press('Tab')
        if target.evaluate('el => el === document.activeElement'):
            return
    expect(target).to_be_focused()


def expect_focus_outline(target):
    expect(target).to_be_focused()
    assert target.evaluate("""el => el.matches(':focus-visible')
        && getComputedStyle(el).outlineStyle !== 'none'
        && parseFloat(getComputedStyle(el).outlineWidth) >= 2""")


def create_invitation(owner, name):
    response = owner.request.post(UI + '/api' + WEDDING + '/guests', headers=OWNER_HEADERS, data={'name': name})
    assert response.status == 201, f'Guest creation returned {response.status}'
    path = WEDDING + '/guests/' + response.json()['id'] + '/invite-link'
    return path, issue_link(owner, path)


def issue_link(owner, path):
    response = owner.request.post(UI + '/api' + path, headers=OWNER_HEADERS)
    assert response.status == 200, f'Invite issuance returned {response.status}'
    return UI + urlparse(response.json()['url']).path


def open_invitation(browser, errors, url):
    page = browser.new_page(viewport={'width': 390, 'height': 844})
    page.on('pageerror', lambda error: errors.append(type(error).__name__))
    page.goto(url)
    expect(page).to_have_url(UI + '/invite')
    page.get_by_role('button', name='Открыть приглашение').click()
    return page


def refresh(page, status):
    def is_invitation(response):
        path = urlparse(response.url).path
        return response.request.method == 'GET' and path.startswith('/api/rsvp/') and path.count('/') == 3

    with page.expect_response(is_invitation) as pending:
        page.evaluate("window.dispatchEvent(new Event('focus'))")
    assert pending.value.status == status, f'Invitation refresh returned {pending.value.status}'


def preview_with_keyboard(owner, lang, width):
    disclosure, label, preview, heading, edit, confirm, _ = THANKS[lang]
    owner.set_viewport_size({'width': width, 'height': 844})
    owner.goto(UI + '/after')
    trigger = owner.get_by_role('button', name=disclosure)
    tab_to(owner, trigger)
    expect_focus_outline(trigger)
    owner.keyboard.press('Enter')
    expect(trigger).to_have_attribute('aria-expanded', 'true')
    recipient = owner.get_by_role('checkbox', name='Анна SC-015')
    expect(recipient).to_be_visible()
    tab_to(owner, recipient)
    expect_focus_outline(recipient)
    owner.keyboard.press('Space')
    expect(recipient).to_be_checked()
    message = owner.get_by_role('textbox', name=label)
    tab_to(owner, message)
    owner.keyboard.insert_text(MESSAGE)
    expect(message).to_have_value(MESSAGE)
    preview_button = owner.get_by_role('button', name=preview)
    tab_to(owner, preview_button)
    expect_focus_outline(preview_button)
    owner.keyboard.press('Enter')
    preview_heading = owner.get_by_role('heading', name=heading)
    expect_focus_outline(preview_heading)
    expect(owner.get_by_text(MESSAGE, exact=True)).to_be_visible()
    expect(owner.get_by_text('Анна SC-015', exact=True)).to_be_visible()
    expect(owner.get_by_text('Борис SC-015', exact=True)).to_have_count(0)
    owner.keyboard.press('Tab')
    expect(owner.get_by_role('button', name=confirm)).to_be_focused()
    owner.keyboard.press('Tab')
    expect_focus_outline(owner.get_by_role('button', name=edit))
    owner.keyboard.press('Enter')
    expect_focus_outline(preview_button)
    expect(message).to_have_value(MESSAGE)
    expect(recipient).to_be_checked()
    assert owner.evaluate('document.documentElement.scrollWidth === innerWidth')
    return preview_heading


def verify_thanks(browser, errors):
    owner = signed_page(browser, errors, FIXTURE['owner'])
    selected_path, selected_url = create_invitation(owner, 'Анна SC-015')
    _, other_url = create_invitation(owner, 'Борис SC-015')
    selected = open_invitation(browser, errors, selected_url)
    other = open_invitation(browser, errors, other_url)
    english = signed_page(browser, errors, FIXTURE['owner'], 'en')
    for lang, page in (('en', english), ('ru', owner)):
        for width in (320, 390, 480):
            preview_heading = preview_with_keyboard(page, lang, width)
    english.context.close()
    expect(selected.get_by_text(MESSAGE, exact=True)).to_have_count(0)
    owner.keyboard.press('Enter')
    expect(preview_heading).to_be_focused()
    owner.keyboard.press('Tab')
    confirm = owner.get_by_role('button', name=THANKS['ru'][5])
    expect_focus_outline(confirm)
    owner.keyboard.press('Enter')
    receipt = owner.get_by_role('status').filter(has_text=THANKS['ru'][6])
    expect_focus_outline(receipt)
    refresh(selected, 200)
    expect(selected.get_by_text(MESSAGE, exact=True)).to_be_visible()
    refresh(other, 200)
    expect(other.get_by_text(MESSAGE, exact=True)).to_have_count(0)

    replacement_url = issue_link(owner, selected_path)
    refresh(selected, 401)
    expect(selected.get_by_role('alert')).to_have_text('Ссылка больше не действует')
    expect(selected.get_by_text(MESSAGE, exact=True)).to_have_count(0)
    replacement = open_invitation(browser, errors, replacement_url)
    expect(replacement.get_by_text(MESSAGE, exact=True)).to_have_count(0)
    for page in (owner, selected, other, replacement):
        page.context.close()


def signed_page(browser, errors, tokens, lang='ru'):
    page = browser.new_page(viewport={'width': 390, 'height': 844})
    page.add_init_script(f"""if (!localStorage.getItem('tt_auth')) {{
      localStorage.setItem('tt_auth', JSON.stringify({json.dumps(tokens)}));
      localStorage.setItem('tt_onboarded', '1');
      localStorage.setItem('tt_wedding_id', JSON.stringify({json.dumps(FIXTURE['weddingId'])}));
    }}""")
    page.add_init_script(f"localStorage.setItem('tt_lang', {json.dumps(lang)})")
    page.on('pageerror', lambda error: errors.append(type(error).__name__))
    return page


def open_wrapup(viewer):
    path = '/api' + WEDDING + '/completion'
    with viewer.expect_response(lambda response: urlparse(response.url).path == path) as initial:
        viewer.goto(UI + '/after')
    assert initial.value.status == 200
    title = viewer.get_by_text(initial.value.json()['title'], exact=True)
    action = viewer.get_by_text('Поблагодарить гостей', exact=True)
    expect(title).to_be_visible()
    expect(action).to_be_visible()
    return path, title, action


def verify_wrapup_denied(viewer, path, title, action):
    pending = []
    viewer.route(UI + path, lambda route: pending.append(route))
    with viewer.expect_request(lambda request: urlparse(request.url).path == path):
        viewer.evaluate("window.dispatchEvent(new Event('focus'))")
    checking = viewer.get_by_text('Проверяем доступ…', exact=True)
    expect(checking).to_be_visible()
    expect(title).to_be_hidden()
    expect(action).to_be_hidden()
    assert len(pending) == 1
    response = pending[0].fetch()
    assert response.status == 404
    pending[0].fulfill(response=response)
    expect(checking).to_have_count(0)
    expect(title).to_have_count(0)
    expect(action).to_have_count(0)


def verify_revoked_album_and_support(browser, errors):
    owner = signed_page(browser, errors, FIXTURE['owner'])
    viewer = signed_page(browser, errors, FIXTURE['viewer'])
    wrapup = signed_page(browser, errors, FIXTURE['viewer'])
    staff = signed_page(browser, errors, FIXTURE['staff'], 'en')
    viewer.goto(UI + '/wedding/album')
    approve = viewer.get_by_role('button', name='Одобрить кадр', exact=True)
    expect(approve).to_be_visible()
    viewer.context.set_offline(True)
    expect(approve).to_have_count(0)
    expect(viewer.get_by_text('Нет связи с сервером', exact=True)).to_be_visible()
    with viewer.expect_response(lambda res: res.url.endswith(WEDDING + '/album')) as album:
        viewer.context.set_offline(False)
    assert album.value.status == 200
    expect(approve).to_be_visible()
    completion = open_wrapup(wrapup)
    removed = owner.request.delete(UI + '/api' + WEDDING + '/members/' + FIXTURE['viewerId'], headers=OWNER_HEADERS)
    assert removed.status == 204
    with viewer.expect_response(lambda res: res.url.endswith(WEDDING + '/album')) as denied:
        viewer.evaluate("window.dispatchEvent(new Event('focus'))")
    assert denied.value.status == 404
    expect(approve).to_have_count(0)
    verify_wrapup_denied(wrapup, *completion)

    subject = 'Закрытое обращение SC-015'
    message = 'Материалы обращения SC-015'
    created = owner.request.post(UI + '/api/support/cases', headers={**OWNER_HEADERS, 'Idempotency-Key': str(uuid4())},
                                 data={'subject': subject, 'message': message, 'weddingId': FIXTURE['weddingId']})
    assert created.status == 201
    path = '/admin/support/cases/' + created.json()['id']
    headers = {'Authorization': 'Bearer ' + FIXTURE['staff']['accessToken']}
    claimed = owner.request.post(UI + '/api' + path, headers={**headers, 'Idempotency-Key': str(uuid4())}, data={'action': 'claim'})
    assert claimed.status == 200
    staff.goto(UI + '/admin/support')
    request_link = staff.get_by_role('link', name='Open request #' + created.json()['id'][-8:])
    expect(request_link).to_be_visible()
    tab_to(staff, request_link)
    expect_focus_outline(request_link)
    staff.keyboard.press('Enter')
    expect(staff.get_by_text(message, exact=True)).to_be_visible()
    summary = staff.get_by_role('link', name='Open the wedding summary')
    tab_to(staff, summary)
    expect_focus_outline(summary)
    released = owner.request.post(UI + '/api' + path, headers={**headers, 'Idempotency-Key': str(uuid4())}, data={'action': 'release'})
    assert released.status == 200
    with staff.expect_response(lambda res: res.url.endswith(path)) as denied_case:
        staff.evaluate("window.dispatchEvent(new Event('focus'))")
    assert denied_case.value.status == 404
    expect(staff.get_by_text(message, exact=True)).to_have_count(0)
    expect(summary).to_have_count(0)
    region = staff.get_by_role('region', name='Support request')
    expect_focus_outline(region)
    expect(region.get_by_role('alert')).to_have_text('Request not found')
    for page in (owner, viewer, wrapup, staff):
        page.context.close()


def main():
    errors, passed = [], []
    output = Path(os.environ['E2E_RESULT_DIR']) / 'sc015-browser-result.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with sync_playwright() as playwright:
            channel = os.environ.get('E2E_CHROMIUM_CHANNEL')
            browser = playwright.chromium.launch(headless=True, **({'channel': channel} if channel else {}))
            try:
                verify_thanks(browser, errors)
                passed.append('addressed-thanks-and-revocation')
                passed.append('thanks-keyboard-ru-en')
                verify_revoked_album_and_support(browser, errors)
                passed.append('album-wrapup-and-support-rechecked-after-revocation')
                assert not errors, errors
            finally:
                browser.close()
    finally:
        output.write_text(json.dumps({'passed': passed, 'page_errors': errors}), encoding='utf-8')
    print('SC-015 passed: ' + ', '.join(passed))


if __name__ == '__main__':
    main()
