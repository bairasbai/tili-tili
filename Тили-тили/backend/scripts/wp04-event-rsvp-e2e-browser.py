import json
import os
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


UI = 'http://127.0.0.1:3000'
FIXTURE = json.loads(Path(os.environ['E2E_FIXTURE_FILE']).read_text(encoding='utf-8'))['wp04']
LABELS = {
    'ru': ('Открыть приглашение', 'Приду', 'Не приду', 'Сохранить', 'Ответ на мероприятие сохранён'),
    'en': ('Open the invitation', 'Attending', 'Not attending', 'Save', 'Event response saved'),
}


def tab_to(page, target):
    expect(target).to_be_visible()
    for _ in range(85):
        if target.evaluate('el => el === document.activeElement'):
            break
        page.keyboard.press('Tab')
    expect(target).to_be_focused()


def outline(target):
    expect(target).to_be_focused()
    assert target.evaluate("""el => el.matches(':focus-visible')
        && getComputedStyle(el).outlineStyle !== 'none'
        && parseFloat(getComputedStyle(el).outlineWidth) >= 2""")


def verify(browser, lang, errors):
    invitation, yes, no, save, saved = LABELS[lang]
    fixture = FIXTURE[lang]
    context = browser.new_context(viewport={'width': 390, 'height': 844})
    context.add_init_script(f"localStorage.setItem('tt_lang', {json.dumps(lang)});")
    try:
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(type(error).__name__))
        page.bring_to_front()
        page.goto(UI + '/i/' + fixture['code'])
        opener = page.get_by_role('button', name=invitation, exact=True)
        tab_to(page, opener)
        page.keyboard.press('Enter')
        token = page.evaluate("localStorage.getItem('tt_guest_token')")
        api = '/api/rsvp/' + token + '/events'
        events = fixture['events']
        guest = fixture['guestName']
        cards = [page.get_by_role('region', name=event['name'], exact=True) for event in events]
        attending = cards[0].get_by_role('button', name=f'{guest} — {yes}', exact=True)
        declining = cards[1].get_by_role('button', name=f'{guest} — {no}', exact=True)
        for i, (control, status) in enumerate(((attending, 'attending'), (declining, 'declined'))):
            tab_to(page, control)
            outline(control)
            page.keyboard.press('Space')
            expect(control).to_have_attribute('aria-pressed', 'true')
            if i == 0:
                expect(declining).to_have_attribute('aria-pressed', 'false')
            for width in (320, 390, 480):
                page.set_viewport_size({'width': width, 'height': 844})
                assert cards[i].evaluate('el => el.getBoundingClientRect().right <= innerWidth')
            button = cards[i].get_by_role('button', name=save, exact=True)
            tab_to(page, button)
            path = api + '/' + events[i]['id'] + '/answers'
            with page.expect_response(lambda res: res.request.method == 'PUT' and urlparse(res.url).path == path) as pending:
                page.keyboard.press('Enter')
            assert pending.value.status == 200
            assert pending.value.request.post_data_json['answers'][0]['status'] == status
            assert pending.value.json()['people'][0]['guestId'] == fixture['guestId']
            expect(cards[i].get_by_role('status')).to_have_text(saved)
            outline(button)
            expect(button).to_be_disabled()
        recorded = context.request.get(UI + api)
        assert recorded.status == 200
        by_event = {item['event']['id']: item['people'][0]['status'] for item in recorded.json()['events']}
        assert by_event == {events[0]['id']: 'attending', events[1]['id']: 'declined'}
        page.reload()
        if opener.is_visible():
            tab_to(page, opener)
            page.keyboard.press('Enter')
        expect(attending).to_have_attribute('aria-pressed', 'true')
        expect(declining).to_have_attribute('aria-pressed', 'true')
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
                passed.append('separate-event-rsvp-' + lang)
            assert not errors, errors
        finally:
            browser.close()
    result = Path(os.environ['E2E_RESULT_DIR']) / 'wp04-event-rsvp-result.json'
    result.parent.mkdir(parents=True, exist_ok=True)
    result.write_text(json.dumps({'passed': passed, 'page_errors': errors}), encoding='utf-8')
    print('WP04 passed: ' + ', '.join(passed))


if __name__ == '__main__':
    main()
