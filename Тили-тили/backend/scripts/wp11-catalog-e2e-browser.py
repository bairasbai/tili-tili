import json
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


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
            context = browser.new_context(viewport={'width': 390, 'height': 844})
            context.add_init_script(f"""if (!localStorage.getItem('tt_auth')) {{
              localStorage.setItem('tt_auth', JSON.stringify({json.dumps(tokens)}));
              localStorage.setItem('tt_onboarded', '1');
            }}""")
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(type(error).__name__))
            page.goto('http://127.0.0.1:3000/settings')
            heading = page.get_by_text('Тарифы сервиса', exact=True)
            expect(heading).to_be_visible()
            expect(page.get_by_text('Тарифы пока недоступны.', exact=True)).to_have_count(0)
            with page.expect_response(lambda response: response.url.endswith('/api/users/me/service-plans')) as pending:
                heading.click()
            assert pending.value.status == 200
            if configured:
                plans = json.loads(os.environ['SERVICE_PLANS_JSON'])
                couple = next(plan for plan in plans if plan['audience'] == 'couple')
                vendor = next(plan for plan in plans if plan['audience'] == 'vendor')
                card = page.get_by_role('article').filter(has=page.get_by_role('heading', name=couple['title']))
                expect(card).to_contain_text('123,45 ₽ · 30 дн.')
                expect(card.get_by_text(couple['limits'][0], exact=True)).to_be_visible()
                expect(card.get_by_text(couple['expiryTerms'], exact=True)).to_be_visible()
                expect(card.get_by_text(couple['refundTerms'], exact=True)).to_be_visible()
                expect(page.get_by_text(vendor['title'], exact=True)).to_have_count(0)
                expect(page.get_by_text('Оплата тарифов пока недоступна.', exact=True)).to_be_visible()
                expect(card.get_by_role('button')).to_have_count(0)
                page.goto('http://127.0.0.1:3000/vendor-app/settings')
                page.get_by_text('Тарифы сервиса', exact=True).click()
                expect(page.get_by_role('heading', name=vendor['title'])).to_be_visible()
                expect(page.get_by_role('heading', name=couple['title'])).to_have_count(0)
            else:
                expect(page.get_by_text('Тарифы пока недоступны.', exact=True)).to_be_visible()
                expect(page.get_by_text('Оплата тарифов пока недоступна.', exact=True)).to_have_count(0)
            assert not errors, errors
        finally:
            browser.close()
    output.write_text(json.dumps({'configured': configured, 'page_errors': errors}), encoding='utf-8')
    print(f'WP11 service plans passed: configured={configured}')


if __name__ == '__main__':
    main()
