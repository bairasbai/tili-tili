"""018-A/018-B browser acceptance against the real API and a disposable task fixture.
No additional HTTP endpoints, bank requests or production credentials are used.
Receipt upload needs RECEIPTS_STORAGE=db in the fixture server environment (ревью 018, BB-01).
Button names carry the stage or file name since review 018 (F-15, BF-12).
"""
import datetime
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
wid = fixture['weddingId']
api = 'http://127.0.0.1:3001'
ui = 'http://127.0.0.1:3000'
passed, errors = [], []

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
            localStorage.setItem('tt_onboarded','1');localStorage.setItem('tt_wedding_id',JSON.stringify(%s));
            localStorage.setItem('tt_wedding_date',JSON.stringify('2027-06-14'));
          }})();""" % (json.dumps(person), json.dumps(wid)))
        return c
    owner = context(fixture['owner'])
    partner = context(fixture['helper'])
    page, other = owner.new_page(), partner.new_page()
    for p in (page, other):
        p.on('pageerror', lambda e: errors.append(str(e)))
    def request(method, path, body=None, person='owner'):
        headers = {'authorization': 'Bearer ' + fixture[person]['tokens']['accessToken'], 'idempotency-key': str(uuid.uuid4())}
        res = owner.request.fetch(api + path, method=method, headers=headers, data=body)
        assert res.ok, f'{method} {path}: {res.status} {res.text()}'
        return res.json() if res.status != 204 else None
    def data():
        return request('GET', f'/weddings/{wid}/payment-schedule?from=2001-01-01&to=2001-01-02')
    def save(p):
        form = p.get_by_role('form', name='Редактор платежа', exact=True)
        form.get_by_role('button', name='Сохранить', exact=True).click()
        expect(form).to_have_count(0)
        expect(p.get_by_role('button', name='Обновить данные', exact=True)).to_be_enabled()
    try:
        slots = request('GET', f'/weddings/{wid}/slots')
        slot = next(s for s in slots if s['categoryId'] == 'photo' and not s['deal'])
        booked = request('POST', f'/weddings/{wid}/slots/{slot["id"]}/external', {'vendorName': 'Фотограф E2E', 'price': money(1000000)})
        deal = booked['deal']['id']
        request('POST', f'/weddings/{wid}/slots/{slot["id"]}/pay', {'amount': money(100000)})
        today = datetime.date.fromisoformat(fixture['today'])
        due = (today + datetime.timedelta(days=10)).isoformat()
        moved_due = (today + datetime.timedelta(days=11)).isoformat()
        page.goto(ui + '/wedding/budget', wait_until='networkidle')
        page.get_by_role('button', name=re.compile('^График платежей')).click()
        expect(page).to_have_url(ui + '/wedding/payments')
        expect(page.get_by_text('Есть оплаты без активного этапа:', exact=False)).to_be_visible()
        passed.append('budget-navigation-and-unallocated-warning')
        page.get_by_role('button', name='Добавить этап', exact=True).click()
        form = page.get_by_role('form', name='Редактор платежа', exact=True)
        form.get_by_label('Название этапа', exact=True).fill('Аванс фотографу')
        form.get_by_label('Дата платежа', exact=True).fill(due)
        form.get_by_label('Сумма, ₽', exact=True).fill('4000')
        save(page)
        card = page.get_by_role('region', name='Аванс фотографу', exact=True)
        expect(card).to_be_visible()
        state = data()
        stage_id = next(i['id'] for i in state['allInstallments'] if i['title'] == 'Аванс фотографу')
        assert state['summary']['committed'] == money(1000000)
        assert len(state['payments']) == 1
        passed.append('create-installment-no-new-payment-or-double-commitment')
        page.locator('summary').filter(has_text='История оплат').click()
        page.get_by_role('button', name='Привязать оплату', exact=True).click()
        page.get_by_role('form', name='Редактор платежа').get_by_label('Этап платежа').select_option(stage_id)
        save(page)
        state = data()
        assert state['summary']['unallocated'] == money(0) and len(state['payments']) == 1
        passed.append('link-existing-payment-without-duplication')
        card.get_by_role('button', name='Отметить оплату: Аванс фотографу', exact=True).click()
        form = page.get_by_role('form', name='Редактор платежа')
        form.get_by_label('Сумма, ₽', exact=True).fill('1000')
        form.locator('select').select_option('cash')
        form.get_by_label('Только мы', exact=True).check()
        save(page)
        state = data()
        assert len(state['payments']) == 2
        assert state['summary']['recorded'] == money(200000)
        latest = next(p for p in state['payments'] if p['installmentId'] == stage_id)
        assert latest['paymentMethod'] == 'cash' and latest['visibility'] == 'private' and latest['amountKnown'] is True
        passed.append('partial-cash-private-payment-via-ui')
        page.reload(wait_until='networkidle')
        expect(page.get_by_role('region', name='Аванс фотографу')).to_contain_text('Частично отмечено')
        passed.append('payment-persists-after-reload')
        other.goto(ui + '/wedding/payments', wait_until='networkidle')
        expect(other.get_by_text('Финансовый раздел доступен только паре', exact=True)).to_be_visible()
        expect(other.get_by_role('button', name='История CSV', exact=True)).to_have_count(0)
        expect(other.get_by_text('Обязательства', exact=True)).to_have_count(0)
        passed.append('helper-cannot-read-or-export-finances')
        # Authorised role change through the public team API in a disposable wedding.
        request('PATCH', f'/weddings/{wid}/members/{fixture["helper"]["id"]}', {'role': 'couple'})
        other.reload(wait_until='networkidle')
        expect(other.get_by_role('region', name='Аванс фотографу')).to_contain_text('Частично отмечено')
        passed.append('second-couple-session-sees-same-payments')
        card = page.get_by_role('region', name='Аванс фотографу')
        card.get_by_role('button', name='Изменить: Аванс фотографу', exact=True).click()
        old_form = page.get_by_role('form', name='Редактор платежа')
        old_form.get_by_label('Название этапа').fill('Мой черновик')
        other.get_by_role('region', name='Аванс фотографу').get_by_role('button', name='Изменить: Аванс фотографу', exact=True).click()
        partner_form = other.get_by_role('form', name='Редактор платежа')
        partner_form.get_by_label('Название этапа').fill('Согласованный аванс')
        partner_form.get_by_label('Дата платежа').fill(moved_due)
        save(other)
        old_form.get_by_role('button', name='Сохранить', exact=True).click()
        expect(page.get_by_role('alert')).to_contain_text('Черновик остался в форме')
        expect(old_form.get_by_label('Название этапа')).to_have_value('Мой черновик')
        passed.append('stale-draft-rejected-and-preserved')
        old_form.get_by_role('button', name='Закрыть', exact=True).click()
        page.get_by_role('button', name='Обновить данные', exact=True).click()
        card = page.get_by_role('region', name='Согласованный аванс')
        expect(card).to_be_visible()
        request('POST', f'/weddings/{wid}/reschedule', {'date': '2027-08-14'})
        page.reload(wait_until='networkidle')
        expect(card.locator('time')).to_have_attribute('datetime', moved_due)
        passed.append('fixed-payment-deadline-after-wedding-reschedule')
        for width in (320, 390):
            page.set_viewport_size({'width': width, 'height': 844})
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), f'overflow at {width}px'
        page.screenshot(path=str(out / 'payment-schedule-mobile.png'), full_page=True)
        passed.append('320-and-390-pixel-layout')
        card.get_by_role('button', name='Отменить этап: Согласованный аванс', exact=True).click()
        form = page.get_by_role('form', name='Редактор платежа')
        expect(form).to_contain_text('не возвращает деньги')
        form.get_by_label('Причина отмены').fill('Срок согласуем заново')
        save(page)
        page.get_by_role('form', name='Период платежей').get_by_label('Показать отменённые').check()
        page.get_by_role('button', name='Применить период', exact=True).click()
        card = page.get_by_role('region', name='Согласованный аванс')
        expect(card).to_contain_text('Отменён')
        state = data()
        assert len(state['payments']) == 2 and state['summary']['recorded'] == money(200000)
        assert all(p['kind'] != 'refund' for p in state['payments'])
        passed.append('cancel-plan-keeps-cash-history-without-refund')
        with page.expect_download() as download:
            page.get_by_role('button', name='История CSV', exact=True).click()
        download.value.save_as(str(out / 'payment-history.csv'))
        csv = (out / 'payment-history.csv').read_text(encoding='utf-8-sig')
        assert '"plan"' in csv and csv.count('"payment"') == 2
        assert 'payment_method' in csv and 'visibility' in csv and 'amount_known' in csv
        assert '"cash"' in csv and '"private"' in csv
        assert 'accessToken' not in csv and 'eyJ' not in csv
        passed.append('csv-download-with-distinct-plan-and-payment-records')
        page.locator('summary').filter(has_text='История оплат').click()
        page.screenshot(path=str(out / 'payment-history-mobile.png'), full_page=True)
        # 018-B: private payment evidence — lazy list, upload, download, two-step delete.
        # The panel sits inside «История оплат»: take the inner <details> through its own summary.
        summary = page.locator('summary', has_text='Приложенные документы').first
        panel = summary.locator('xpath=..')
        summary.click()
        expect(panel.get_by_text('Файл приложен пользователем. Приложение не сверяет его с банковской операцией.', exact=True)).to_be_visible()
        expect(panel.get_by_text('Прикрепить файл', exact=True)).to_be_visible()
        png = bytes([137, 80, 78, 71, 13, 10, 26, 10]) + bytes(64)
        panel.locator('input[type=file]').set_input_files({'name': 'чек-e2e.png', 'mimeType': 'image/png', 'buffer': png})
        expect(panel.get_by_text('чек-e2e.png', exact=True)).to_be_visible()
        with page.expect_download() as receipt:
            panel.get_by_role('button', name='Скачать: чек-e2e.png', exact=True).click()
        assert receipt.value.suggested_filename == 'чек-e2e.png'
        panel.get_by_role('button', name='Удалить: чек-e2e.png', exact=True).click()
        panel.get_by_role('button', name='Удалить? чек-e2e.png', exact=True).click()
        expect(panel.get_by_text('чек-e2e.png', exact=True)).to_have_count(0)
        passed.append('receipt-upload-download-two-step-delete')
        # 018-B: reserve and a custom category limit on the budget screen.
        request('PATCH', f'/weddings/{wid}', {'budgetTotal': money(100_000_000)})
        page.goto(ui + '/wedding/budget', wait_until='networkidle')
        page.get_by_label('Резерв, %', exact=True).fill('12,5')
        page.get_by_role('button', name='Сохранить', exact=True).click()
        expect(page.get_by_text(re.compile('^Сейчас: 12,5'))).to_be_visible()
        category = request('GET', f'/weddings/{wid}/budget')['categories'][0]['title']
        page.get_by_label(f'{category} лимит, ₽', exact=True).fill('150 000')
        page.get_by_role('button', name=f'Задать лимит: {category}', exact=True).click()
        reset = page.get_by_role('button', name=f'Вернуть автоматический лимит: {category}', exact=True)
        expect(reset).to_be_visible()
        budget = request('GET', f'/weddings/{wid}/budget')
        assert budget['reserveBps'] == 1250, budget['reserveBps']
        assert budget['categories'][0]['planned'] == money(15_000_000) and budget['categories'][0]['limitCustom']
        reset.click()
        expect(reset).to_have_count(0)
        assert not request('GET', f'/weddings/{wid}/budget')['categories'][0]['limitCustom']
        for width in (320, 390):
            page.set_viewport_size({'width': width, 'height': 844})
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), f'budget overflow at {width}px'
        page.screenshot(path=str(out / 'budget-controls-mobile.png'), full_page=True)
        passed.append('budget-reserve-and-category-limit')
        assert not errors, errors
        result = {'passed': passed, 'page_errors': errors, 'browser': browser.version, 'viewport_widths': [320,390]}
        (out / 'payment-browser-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
        print(json.dumps({'passed_count': len(passed), 'page_errors': errors}))
    except Exception:
        # Do not retain browser storage, authorization headers or fixture tokens.
        error = traceback.format_exc()
        error = re.sub(r'eyJ[\w-]+\.[\w-]+\.[\w-]+', '[redacted-token]', error)
        (out / 'payment-browser-result.json').write_text(json.dumps({'passed':passed,'page_errors':errors,'error':error}, ensure_ascii=False, indent=2))
        try:
            page.screenshot(path=str(out / 'payment-failure.png'), full_page=True)
        except Exception:
            pass
        raise
    finally:
        browser.close()
