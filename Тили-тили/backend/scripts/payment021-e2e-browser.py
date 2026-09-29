"""021 acceptance: real vendor UI, privacy, unknown amounts and receipt download.
Uses the disposable task fixture with E2E_PAYMENT_VENDOR=yes and RECEIPTS_STORAGE=db.
No mocked HTTP responses, production accounts or browser storage in retained evidence.
"""
import base64
import json
import os
import pathlib
import re
import traceback
import uuid
from playwright.sync_api import expect, sync_playwright

out = pathlib.Path(os.environ['E2E_RESULT_DIR'])
out.mkdir(parents=True, exist_ok=True)
fixture = json.loads(pathlib.Path(os.environ['E2E_FIXTURE_FILE']).read_text())
wid, today = fixture['weddingId'], fixture['today']
vendor, foreign = fixture['vendors']
api, ui = 'http://127.0.0.1:3001', 'http://127.0.0.1:3000'
passed, errors = [], []
png = bytes([137, 80, 78, 71, 13, 10, 26, 10, 0])

def money(amount):
    return {'amount': amount, 'currency': 'RUB'}

with sync_playwright() as pw:
    options = {'headless': True}
    if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'):
        options['executable_path'] = os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']
    browser = pw.chromium.launch(**options)
    def context(person):
        c = browser.new_context(viewport={'width': 390, 'height': 844}, accept_downloads=True)
        c.add_init_script("""(() => {const f=%s;
          if(!localStorage.getItem('tt_auth')) {
            localStorage.setItem('tt_auth', JSON.stringify({accessToken:f.tokens.accessToken,refreshToken:f.tokens.refreshToken}));
            localStorage.setItem('tt_onboarded','1');localStorage.setItem('tt_wedding_id','null');
          }})();""" % json.dumps(person))
        return c
    own_context, foreign_context = context(vendor), context(foreign)
    page, other = own_context.new_page(), foreign_context.new_page()
    for p in (page, other):
        p.on('pageerror', lambda e: errors.append(str(e)))
    def request(method, path, body=None, person=None, status=None):
        person = person or fixture['owner']
        headers = {'authorization': 'Bearer ' + person['tokens']['accessToken'], 'idempotency-key': str(uuid.uuid4())}
        res = own_context.request.fetch(api + path, method=method, headers=headers, data=body)
        if status is not None:
            assert res.status == status, f'{method} {path}: unexpected status {res.status}'
        else:
            assert res.ok, f'{method} {path}: unexpected status {res.status}'
        return res.json() if res.status != 204 else None
    try:
        slots = request('GET', f'/weddings/{wid}/slots')
        slot = next(s for s in slots if s['categoryId'] == 'video' and not s['deal'])
        booked = request('POST', f'/weddings/{wid}/slots/{slot["id"]}/book', {'vendorId': vendor['vendorId'], 'price': money(1000000)})
        deal = booked['deal']['id']
        request('POST', f'/weddings/{wid}/slots/{slot["id"]}/pay', {'amount': money(250000)})
        payments_path = f'/vendor/deals/{deal}/payments'
        assert request('GET', payments_path, person=vendor) == []
        own = request('GET', '/vendor/deals', person=vendor)
        assert next(d for d in own['items'] if d['id'] == deal)['paid'] == money(0)
        assert own['expected'] == money(1000000)
        assert request('GET', '/vendor/analytics?period=month', person=vendor)['revenue'] == money(0)
        page.goto(ui + f'/vendor-app/deals/{deal}', wait_until='networkidle')
        expect(page.get_by_text('Пара пока не поделилась платежами', exact=True)).to_be_visible()
        page.screenshot(path=str(out / 'payment021-private-vendor.png'), full_page=True)
        passed.append('slot-private-payment-excluded-from-vendor-history-and-totals')

        stage = request('POST', f'/weddings/{wid}/payment-schedule', {'dealId': deal, 'title': 'Видео 021', 'due': today, 'amount': money(400000)})
        paid = request('POST', f'/weddings/{wid}/payment-schedule/{stage["id"]}/pay', {
            'version': stage['version'], 'amount': money(100000), 'paymentMethod': 'cash', 'visibility': 'vendor', 'paidOn': today})
        records = request('GET', payments_path, person=vendor)
        assert len(records) == 1 and records[0]['amount'] == money(100000)
        shared_id = records[0]['id']
        receipt = request('POST', f'/weddings/{wid}/payments/{shared_id}/receipts', {
            'filename': 'payment021.png', 'mimeType': 'image/png', 'contentBase64': base64.b64encode(png).decode()})
        page.reload(wait_until='networkidle')
        history = page.get_by_role('region', name='История платежей', exact=True)
        expect(history.get_by_text('Наличные', exact=False)).to_be_visible()
        expect(history.get_by_text('Оплата отмечена', exact=True)).to_be_visible()
        expect(history.get_by_role('article')).to_have_count(1)
        passed.append('shared-payment-method-date-and-history-visible-in-real-ui')

        with page.expect_download() as event:
            history.get_by_role('button', name='Скачать payment021.png', exact=True).click()
        download = event.value
        assert download.suggested_filename == 'payment021.png'
        file = out / 'payment021-receipt.png'
        download.save_as(file)
        assert file.read_bytes() == png
        passed.append('shared-receipt-download-matches-server-bytes')

        request('POST', f'/weddings/{wid}/payment-schedule/{stage["id"]}/pay', {
            'version': paid['version'], 'amountKnown': False, 'paymentMethod': 'bank_transfer', 'visibility': 'vendor', 'paidOn': today})
        page.reload(wait_until='networkidle')
        expect(page.get_by_text('Известные оплаты', exact=True)).to_be_visible()
        expect(page.get_by_text('Есть оплаты с неизвестной суммой', exact=True)).to_be_visible()
        expect(page.get_by_text('Сумма не сохранена', exact=True)).to_be_visible()
        expect(history.get_by_role('article')).to_have_count(2)
        for width in (320, 390, 1280):
            page.set_viewport_size({'width': width, 'height': 844})
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), f'vendor deal overflow at {width}px'
        page.set_viewport_size({'width': 390, 'height': 844})
        page.screenshot(path=str(out / 'payment021-shared-vendor.png'), full_page=True)
        page.goto(ui + '/vendor-app/analytics', wait_until='networkidle')
        expect(page.get_by_text('Доход по известным суммам', exact=True)).to_be_visible()
        expect(page.get_by_text('Есть оплаты с неизвестной суммой', exact=True)).to_be_visible()
        page.screenshot(path=str(out / 'payment021-analytics-vendor.png'), full_page=True)
        page.goto(ui + '/vendor-app/deals', wait_until='networkidle')
        expect(page.get_by_text('Есть оплаты с неизвестной суммой. Итоги рассчитаны только по известным суммам.', exact=True)).to_be_visible()
        passed.append('unknown-amount-warnings-in-vendor-card-list-and-analytics')

        request('GET', payments_path, person=foreign, status=404)
        request('GET', f'{payments_path}/{shared_id}/receipts/{receipt["id"]}/content', person=foreign, status=404)
        other.goto(ui + f'/vendor-app/deals/{deal}', wait_until='networkidle')
        expect(other.get_by_text('Сделка не найдена', exact=True)).to_be_visible()
        expect(other.get_by_role('region', name='История платежей', exact=True)).to_have_count(0)
        passed.append('foreign-vendor-has-no-deal-payment-or-receipt-access')
        assert not errors, errors
        result = {'passed': passed, 'page_errors': errors, 'browser': browser.version, 'viewport_widths': [320, 390, 1280]}
        (out / 'payment-privacy-browser-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
        print(json.dumps({'passed_count': len(passed), 'page_errors': errors}))
    except Exception:
        error = re.sub(r'eyJ[\w-]+\.[\w-]+\.[\w-]+', '[redacted-token]', traceback.format_exc())
        (out / 'payment-privacy-browser-result.json').write_text(json.dumps({'passed': passed, 'page_errors': errors, 'error': error}, ensure_ascii=False, indent=2))
        try:
            page.screenshot(path=str(out / 'payment021-failure.png'), full_page=True)
        except Exception:
            pass
        raise
    finally:
        browser.close()
