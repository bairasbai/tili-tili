"""019: real candidate/request/response/accept flow with isolated browser sessions."""
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
    partner = context(fixture['vendor'])
    page, other = owner.new_page(), partner.new_page()
    for p in (page, other):
        p.on('pageerror', lambda e: errors.append(str(e)))
    def request(method, path, body=None, person='owner'):
        headers = {'authorization': 'Bearer ' + fixture[person]['tokens']['accessToken'], 'idempotency-key': str(uuid.uuid4())}
        res = owner.request.fetch(api + path, method=method, headers=headers, data=body)
        assert res.ok, f'{method} {path}: {res.status} {res.text()}'
        return res.json() if res.status != 204 else None
    try:
        # Each candidate is added through the real profile button.
        for vid in [fixture['vendorId'], fixture['secondId']]:
            page.goto(ui + '/vendor/' + vid)
            page.get_by_role('button', name='В кандидаты', exact=True).click()
            expect(page.get_by_role('button', name='✓ Уже в кандидатах', exact=True)).to_be_visible()
        slots = request('GET', f'/weddings/{wid}/slots')
        slot = next(s for s in slots if s['categoryId'] == 'photo')
        sid = slot['id']
        page.goto(ui + '/wedding/slot/' + sid)
        page.get_by_role('button', name='Запросить предложение (2)', exact=True).click()
        page.get_by_placeholder('Пожелания к предложению (необязательно)').fill('Живой репортаж')
        page.get_by_role('button', name='Отправить запрос', exact=True).click()
        expect(page.get_by_role('status')).to_contain_text('Запрос отправлен')
        passed.append('candidate_to_batch_request')
        vendor_requests = request('GET', '/vendor/offer-requests', person='vendor')
        assert len(vendor_requests) == 1 and vendor_requests[0]['status'] == 'open', vendor_requests
        other.goto(ui + '/vendor-app/offer-requests')
        # A new request opens its editor immediately; the "Reply" button is
        # only rendered after the editor has been collapsed or an offer exists.
        expect(other.get_by_placeholder('Название предложения')).to_be_visible()
        other.get_by_placeholder('Название предложения').fill('Репортаж E2E')
        other.get_by_placeholder('Что входит — по пункту в строке').fill('8 часов\nРетушь')
        other.get_by_label('Цена предложения, ₽', exact=True).fill('12345')
        other.get_by_label('Действует до', exact=True).fill('2027-06-20')
        other.get_by_role('button', name='Отправить предложение', exact=True).click()
        expect(other.get_by_role('button', name='Изменить ответ', exact=True)).to_be_visible()
        passed.append('vendor_response_second_session')
        page.reload()
        page.get_by_role('button', name=re.compile('^Сравнить')).click()
        expect(page.get_by_text('Репортаж E2E', exact=True)).to_be_visible()
        page.screenshot(path=str(out / 'compare.png'), full_page=True)
        page.get_by_role('button', name='Принять предложение', exact=True).click()
        expect(page).to_have_url(ui + '/wedding/slot/' + sid)
        expect(page.get_by_text('Предложение выбрано', exact=True)).to_be_visible()
        current = next(s for s in request('GET', f'/weddings/{wid}/slots') if s['id'] == sid)
        assert current['deal']['price']['amount'] == 1234500, current
        assert current['deal']['packageName'] == 'Репортаж E2E'
        assert current['deal']['packageIncludes'] == ['8 часов', 'Ретушь']
        assert current['tileState'] == 'booked'
        shortlist = request('GET', f'/weddings/{wid}/slots/{sid}/shortlist')
        assert sorted(e['request']['closeReason'] for e in shortlist) == ['booked', 'booked_other']
        passed.append('comparison_to_booking_and_snapshot')
        other.reload()
        expect(other.get_by_text('Предложение выбрано', exact=True)).to_be_visible()
        page.screenshot(path=str(out / 'booking.png'), full_page=True)
        assert not errors, errors
    except Exception:
        errors.append(traceback.format_exc())
        page.screenshot(path=str(out / 'owner-failure.png'), full_page=True)
        other.screenshot(path=str(out / 'vendor-failure.png'), full_page=True)
    finally:
        browser.close()
        (out / 'result.json').write_text(json.dumps({'passed': passed, 'errors': errors},ensure_ascii=False,indent=2))
if errors:
    raise SystemExit('019 browser failed: ' + '\n'.join(errors))
print('019 browser: ' + str(len(passed)) + '/3 passed')
