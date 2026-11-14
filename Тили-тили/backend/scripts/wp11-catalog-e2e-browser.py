import json
import os
import re
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

WIDTHS = (320, 390, 480)
ENDPOINT = re.compile(r'/api/users/me/service-plans$')


def main():
    fixture = json.loads(Path(os.environ['E2E_FIXTURE_FILE']).read_text(encoding='utf-8'))
    tokens = fixture['owner']['tokens']
    configured = bool(os.environ.get('SERVICE_PLANS_JSON', '').strip())
    errors = []
    output = Path(os.environ['E2E_RESULT_DIR']) / ('wp11-configured.json' if configured else 'wp11-empty.json')
    output.parent.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        channel = os.environ.get('E2E_CHROMIUM_CHANNEL')
        browser = playwright.chromium.launch(headless=True, **({'channel': channel} if channel else {}))
        try:
            for lang in ('ru', 'en'):
                verify_catalog(browser, tokens, lang, configured, errors)
            assert not errors, errors
        finally:
            browser.close()
    output.write_text(json.dumps({'configured': configured, 'page_errors': errors,
                                  'languages': ['ru', 'en'], 'viewport_widths': WIDTHS}), encoding='utf-8')
    print(f'WP11 service plans passed: configured={configured}, RU/EN, 320/390/480')


def verify_catalog(browser, tokens, lang, configured, errors):
    title, unavailable, payments, loading, offline, retry, error = (
        ('Тарифы сервиса', 'Тарифы пока недоступны.', 'Оплата тарифов пока недоступна.',
         'Загружаем…', 'Нет связи с сервером', 'Повторить', 'Сервер недоступен. Попробуйте позже')
        if lang == 'ru' else
        ('Service plans', 'Service plans are currently unavailable.', 'Plan payments are currently unavailable.',
         'Loading…', 'No connection to the server', 'Try again', 'The server is unavailable. Please try again later')
    )
    with browser.new_context(viewport={'width': 390, 'height': 844}) as context:
        context.add_init_script(f"""if (!localStorage.getItem('tt_auth')) {{
          localStorage.setItem('tt_auth', JSON.stringify({json.dumps(tokens)}));
          localStorage.setItem('tt_onboarded', '1');
          localStorage.setItem('tt_lang', {json.dumps(lang)});
        }}""")
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(type(error).__name__))
        page.goto('http://127.0.0.1:3000/settings')
        heading = page.locator('summary').filter(has_text=re.compile(f'^{title}$'))
        catalog = page.locator('details').filter(has=heading)
        expect(heading).to_be_visible()
        expect(page.get_by_text(unavailable, exact=True)).to_have_count(0)
        held = []
        failed_response = {'error': {'code': 'test_unavailable', 'message': 'Synthetic error'}}
        fail_reads = False

        def delay_catalog(route):
            if fail_reads:
                route.fulfill(status=503, json=failed_response)
            else:
                held.append(route)

        page.route(ENDPOINT, delay_catalog)
        heading.press('Enter')
        expect(catalog.get_by_role('status')).to_have_text(loading)
        fail_reads = True
        for route in held:
            route.fulfill(status=503, json=failed_response)
        expect(catalog.get_by_role('alert')).to_have_text(error)
        page.unroute(ENDPOINT, delay_catalog)
        retry_button = catalog.get_by_role('button', name=retry, exact=True)
        retry_button.press('Tab')
        page.keyboard.press('Shift+Tab')
        expect(retry_button).to_be_focused()
        assert retry_button.evaluate("e => e.matches(':focus-visible') && parseFloat(getComputedStyle(e).outlineWidth) >= 2")
        with page.expect_response(lambda response: ENDPOINT.search(response.url)) as retried:
            page.keyboard.press('Enter')
        assert retried.value.status == 200
        if configured:
            plans = json.loads(os.environ['SERVICE_PLANS_JSON'])
            couple = next(plan for plan in plans if plan['audience'] == 'couple')
            vendor = next(plan for plan in plans if plan['audience'] == 'vendor')
            card = page.get_by_role('article').filter(has=page.get_by_role('heading', name=couple['title']))
            expect(card).to_contain_text('123,45 ₽ · 30 дн.' if lang == 'ru' else '123.45 ₽ · 30 d.')
            expect(card.get_by_text(couple['limits'][0], exact=True)).to_be_visible()
            expect(card.get_by_text(couple['expiryTerms'], exact=True)).to_be_visible()
            expect(card.get_by_text(couple['refundTerms'], exact=True)).to_be_visible()
            expect(page.get_by_text(vendor['title'], exact=True)).to_have_count(0)
            expect(page.get_by_text(payments, exact=True)).to_be_visible()
            expect(card.get_by_role('button')).to_have_count(0)
            page.goto('http://127.0.0.1:3000/vendor-app/settings')
            heading.press('Enter')
            expect(page.get_by_role('heading', name=vendor['title'])).to_be_visible()
            expect(page.get_by_role('heading', name=couple['title'])).to_have_count(0)
        else:
            expect(page.get_by_text(unavailable, exact=True)).to_be_visible()
            expect(page.get_by_text(payments, exact=True)).to_have_count(0)
        state = (catalog.get_by_role('heading', name=vendor['title']) if configured
                 else catalog.get_by_text(unavailable, exact=True))
        for width in WIDTHS:
            page.set_viewport_size({'width': width, 'height': 844})
            heading.press('Tab')
            page.keyboard.press('Shift+Tab')
            expect(heading).to_be_focused()
            assert heading.evaluate("e => e.matches(':focus-visible') && parseFloat(getComputedStyle(e).outlineWidth) >= 2")
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), (lang, width)
        context.set_offline(True)
        expect(catalog.get_by_role('status')).to_have_text(offline)
        expect(state).to_have_count(0)
        with page.expect_response(lambda response: ENDPOINT.search(response.url)) as refresh:
            context.set_offline(False)
        assert refresh.value.status == 200
        expect(state).to_be_visible()


if __name__ == '__main__':
    main()
