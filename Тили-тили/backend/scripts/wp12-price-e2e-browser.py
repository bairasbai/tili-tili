import json
import os
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


UI = 'http://127.0.0.1:3000'
FIXTURE = json.loads(Path(os.environ['E2E_FIXTURE_FILE']).read_text(encoding='utf-8'))['wp12']
LABELS = {
    'ru': ('Предпросмотр изменения цены', 'Новое количество для «Сверхурочные»', 'Рассчитать разницу',
           'Предложить новую цену', 'Разница по изменённым позициям', '3,0', '+125,05 ₽'),
    'en': ('Preview price changes', 'New quantity for Overtime', 'Calculate the difference',
           'Propose the new price', 'Difference for changed items', '3.0', '+125.05 ₽'),
}


def outlined(target):
    expect(target).to_be_focused()
    assert target.evaluate("""el => el.matches(':focus-visible')
        && getComputedStyle(el).outlineStyle !== 'none'
        && parseFloat(getComputedStyle(el).outlineWidth) >= 2""")


def tab_to(page, target):
    expect(target).to_be_visible()
    for _ in range(100):
        if target.evaluate('el => el === document.activeElement'):
            break
        page.keyboard.press('Tab')
    outlined(target)


def write(page, target, path, status):
    tab_to(page, target)
    with page.expect_response(lambda r: r.request.method == 'POST' and urlparse(r.url).path == path) as pending:
        page.keyboard.press('Enter')
    assert pending.value.status == status, f'{path} returned {pending.value.status}, expected {status}'
    return pending.value.json()


def verify(browser, lang, errors):
    disclosure, quantity_label, calculate, publish, difference, quantity, display = LABELS[lang]
    fixture = FIXTURE[lang]
    order = '/api/deals/' + fixture['dealId'] + '/order'
    proposals = order + '/terms/price-proposals'
    context = browser.new_context(viewport={'width': 390, 'height': 844})
    context.add_init_script(f"""localStorage.setItem('tt_auth', JSON.stringify({json.dumps(fixture['vendor'])}));
      localStorage.setItem('tt_onboarded', '1'); localStorage.setItem('tt_lang', {json.dumps(lang)});""")
    headers = {'Authorization': 'Bearer ' + fixture['owner']['accessToken']}
    try:
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(type(error).__name__))
        page.bring_to_front()
        page.goto(UI + '/vendor-app/deals/' + fixture['dealId'])
        summary = page.locator('summary').filter(has_text=disclosure)
        tab_to(page, summary)
        page.keyboard.press('Enter')
        editor = summary.locator('..')
        field = editor.get_by_role('textbox', name=quantity_label)
        tab_to(page, field)
        page.keyboard.insert_text(quantity)
        button = editor.get_by_role('button', name=calculate)
        preview = write(page, button, order + '/price-preview', 200)
        assert preview['difference'] == {'amount': 12505, 'currency': 'RUB'}
        outlined(button)
        expect(editor.get_by_text(difference, exact=True).locator('xpath=following-sibling::dd[1]')).to_have_text(display)
        for width in (320, 390, 480):
            page.set_viewport_size({'width': width, 'height': 844})
            assert editor.evaluate('el => el.getBoundingClientRect().right <= innerWidth')
        amendment = preview['amendment']
        other = context.request.post(UI + proposals, headers={**headers, 'Idempotency-Key': str(uuid4())}, data={
            'expectedAgreementId': amendment['agreementId'], 'expectedOrderVersion': amendment['orderVersion'],
            'expectedTermsRevision': amendment['termsRevision'], 'expectedAmount': amendment['proposedPrice']['amount'],
            'changes': [{'kind': 'overtime', 'quantity': '3'}],
        })
        assert other.status == 200, f'Other session returned {other.status}'
        blocked = write(page, editor.get_by_role('button', name=publish), proposals, 409)
        assert blocked['error']['code'] == 'order_version_conflict'
        expect(editor.get_by_role('alert')).to_be_visible()
        outlined(button)
        expect(field).to_have_value(quantity)
        fresh = write(page, button, order + '/price-preview', 200)
        assert fresh['amendment']['termsRevision'] != amendment['termsRevision']
        expect(editor.get_by_role('alert')).to_have_count(0)
        assert fresh['amendment']['currentPrice'] == amendment['currentPrice']
        expect(editor.get_by_text(difference, exact=True).locator('xpath=following-sibling::dd[1]')).to_have_text(display)
        current = context.request.get(UI + order + '/terms', headers=headers)
        assert current.status == 200
        assert current.json()['selected']['id'] == other.json()['selected']['id']
    finally:
        context.close()


def main():
    errors, passed = [], []
    with sync_playwright() as playwright:
        channel = os.environ.get('E2E_CHROMIUM_CHANNEL')
        browser = playwright.chromium.launch(headless=True, **({'channel': channel} if channel else {}))
        try:
            for lang in LABELS:
                verify(browser, lang, errors)
                passed.append('order-price-keyboard-' + lang)
            assert not errors, errors
        finally:
            browser.close()
    result = Path(os.environ['E2E_RESULT_DIR']) / 'wp12-price-result.json'
    result.parent.mkdir(parents=True, exist_ok=True)
    result.write_text(json.dumps({'passed': passed, 'page_errors': errors}), encoding='utf-8')
    print('WP12 passed: ' + ', '.join(passed))


if __name__ == '__main__':
    main()
