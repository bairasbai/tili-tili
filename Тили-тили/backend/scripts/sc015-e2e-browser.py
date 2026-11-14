import json
import os
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


UI = 'http://127.0.0.1:3000'
FIXTURE = json.loads(Path(os.environ['E2E_FIXTURE_FILE']).read_text(encoding='utf-8'))['sc015']
WEDDING = '/weddings/' + FIXTURE['weddingId']
MESSAGE = 'Спасибо, что разделили этот день с нами!'
OWNER_HEADERS = {'Authorization': 'Bearer ' + FIXTURE['owner']['accessToken']}


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


def verify_thanks(browser, errors):
    tokens = FIXTURE['owner']
    context = browser.new_context(viewport={'width': 390, 'height': 844})
    context.add_init_script(f"""if (!localStorage.getItem('tt_auth')) {{
      localStorage.setItem('tt_auth', JSON.stringify({json.dumps(tokens)}));
      localStorage.setItem('tt_onboarded', '1');
      localStorage.setItem('tt_wedding_id', JSON.stringify({json.dumps(FIXTURE['weddingId'])}));
    }}""")
    owner = context.new_page()
    owner.on('pageerror', lambda error: errors.append(type(error).__name__))
    selected_path, selected_url = create_invitation(owner, 'Анна SC-015')
    _, other_url = create_invitation(owner, 'Борис SC-015')
    selected = open_invitation(browser, errors, selected_url)
    other = open_invitation(browser, errors, other_url)
    owner.goto(UI + '/after')
    owner.get_by_role('button', name='Поблагодарить гостей').click()
    owner.get_by_role('checkbox', name='Анна SC-015').check()
    owner.get_by_label('Текст благодарности').fill(MESSAGE)
    owner.get_by_role('button', name='Предпросмотр благодарности').click()
    expect(owner.get_by_role('heading', name='Проверьте текст и приглашения')).to_be_visible()
    expect(owner.get_by_text(MESSAGE, exact=True)).to_be_visible()
    expect(owner.get_by_text('Анна SC-015', exact=True)).to_be_visible()
    expect(owner.get_by_text('Борис SC-015', exact=True)).to_have_count(0)
    expect(selected.get_by_text(MESSAGE, exact=True)).to_have_count(0)

    owner.get_by_role('button', name='Подтвердить и разместить').click()
    expect(owner.get_by_text('Благодарность размещена · Приглашений: 1', exact=True)).to_be_visible()
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
                assert not errors, errors
                passed.append('addressed-thanks-and-revocation')
            finally:
                browser.close()
    finally:
        output.write_text(json.dumps({'passed': passed, 'page_errors': errors}), encoding='utf-8')
    print('SC-015 passed: ' + ', '.join(passed))


if __name__ == '__main__':
    main()
