"""019: real browser + API: candidates → requests → vendor sessions → compare → book.
Run with offers-e2e-server.mts on an isolated local *_test database and Vite on 3000.
E2E_FIXTURE_FILE holds test-only credentials (0600); never upload that file.
"""
import json
import os
import pathlib
import re
import traceback
from playwright.sync_api import expect, sync_playwright

out = pathlib.Path(os.environ['E2E_RESULT_DIR'])
out.mkdir(parents=True, exist_ok=True)
f = json.loads(pathlib.Path(os.environ['E2E_FIXTURE_FILE']).read_text())
wid = f['weddingId']
passed, errors = [], []
with sync_playwright() as pw:
    options = {'headless': True}
    if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'):
        options['executable_path'] = os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']
    browser = pw.chromium.launch(**options)

    def context(person):
        c = browser.new_context(viewport={'width': 390, 'height': 844})
        c.add_init_script("""(() => {const f=%s;
          if (!localStorage.getItem('tt_auth')) {
            localStorage.setItem('tt_auth',JSON.stringify(f.tokens));
            localStorage.setItem('tt_onboarded','1');
            localStorage.setItem('tt_wedding_id',JSON.stringify(%s));
            localStorage.setItem('tt_wedding_date',JSON.stringify(%s));
          }
        })();""" % (json.dumps(person), json.dumps(wid), json.dumps(f['date'])))
        return c

    owner = context(f['owner'])
    page = owner.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))

    def get(path, person=None):
        person = person or f['owner']
        r = owner.request.get('http://127.0.0.1:3001' + path,
                              headers={'authorization': 'Bearer ' + person['tokens']['accessToken']})
        assert r.ok, f'GET {path}: {r.status} {r.text()}'
        return r.json()

    try:
        for vendor in f['vendors']:
            page.goto(f'http://127.0.0.1:3000/vendor/{vendor["vendorId"]}')
            page.get_by_role('button', name='В кандидаты', exact=True).click()
            expect(page.get_by_role('button', name='✓ Уже в кандидатах', exact=True)).to_be_visible()
        sid = next(s['id'] for s in get(f'/weddings/{wid}/slots') if s['categoryId'] == 'photo')
        shortlist = get(f'/weddings/{wid}/slots/{sid}/shortlist')
        assert len(shortlist) == 2, shortlist
        assert all(e['slotId'] == sid for e in shortlist)
        passed.append('Two candidates added through vendor profile buttons')

        page.goto(f'http://127.0.0.1:3000/wedding/slot/{sid}')
        page.get_by_role('button', name='Запросить предложение (2)', exact=True).click()
        page.get_by_placeholder('Пожелания к предложению (необязательно)', exact=True).fill('Съёмка регистрации и банкета')
        page.get_by_role('button', name='Отправить запрос', exact=True).click()
        expect(page.get_by_text('Ждём ответ', exact=True)).to_have_count(2)
        passed.append('One browser batch sends two real offer requests')

        for index, vendor in enumerate(f['vendors']):
            c = context(vendor)
            p = c.new_page()
            p.on('pageerror', lambda e: errors.append(str(e)))
            p.goto('http://127.0.0.1:3000/vendor-app/offer-requests')
            p.get_by_label('Цена предложения, ₽', exact=True).fill(str(75000 + index * 10000))
            p.get_by_role('button', name='Отправить предложение', exact=True).click()
            expect(p.get_by_role('button', name='Изменить ответ', exact=True)).to_be_visible()
            c.close()
        passed.append('Independent vendor sessions reply with their own package and price')

        page.reload()
        page.get_by_role('button', name='Сравнить (2)', exact=True).click()
        expect(page).to_have_url(re.compile(r'/compare\?'))
        # The router may update the URL before replacing the previous slot screen.
        expect(page.get_by_text('Сравнение', exact=True)).to_be_visible()
        table = page.get_by_role('table')
        expect(table).to_be_visible()
        for vendor in f['vendors']:
            expect(table.get_by_role('button', name='Принять предложение: ' + vendor['packageName'], exact=True)).to_be_visible()
        page.screenshot(path=str(out / '01-compare.png'), full_page=True)
        chosen = f['vendors'][0]
        table.get_by_role('button', name='Принять предложение: ' + chosen['packageName'], exact=True).click()
        expect(page.get_by_text('Предложение выбрано', exact=True)).to_be_visible()
        expect(page.get_by_role('button', name=re.compile('^Принять предложение:'))).to_have_count(0)
        passed.append('Comparison accepts exactly one original offer and removes acceptance controls')

        slots = get(f'/weddings/{wid}/slots')
        slot = next(s for s in slots if s['id'] == sid)
        deal = slot['deal']
        assert deal['state'] == 'booked' and deal['price'] == {'amount': 7500000, 'currency': 'RUB'}, deal
        assert deal['packageName'] == chosen['packageName'], deal
        assert deal['packageIncludes'] == ['Съёмка 8 часов', '500 фотографий'], deal
        shortlist = get(f'/weddings/{wid}/slots/{sid}/shortlist')
        assert sorted(e['request']['closeReason'] for e in shortlist) == ['booked', 'booked_other'], shortlist
        cabinet = get('/vendor/deals', chosen)['items']
        assert sum(d['id'] == deal['id'] for d in cabinet) == 1, cabinet
        booked = next(d for d in cabinet if d['id'] == deal['id'])
        assert booked['packageName'] == chosen['packageName'] and booked['packageIncludes'] == deal['packageIncludes'], booked
        page.goto(f'http://127.0.0.1:3000/wedding/slot/{sid}')
        expect(page.get_by_role('button', name=re.compile('^Принять предложение:'))).to_have_count(0)
        expect(page.get_by_text(chosen['name'], exact=True).first).to_be_visible()
        page.screenshot(path=str(out / '02-booked.png'), full_page=True)
        passed.append('Reload + both API views preserve one booking, exact price and immutable package contents')
        assert not errors, errors
    except Exception:
        errors.append(traceback.format_exc())
        page.screenshot(path=str(out / 'failure.png'), full_page=True)
        (out / 'failure.html').write_text(page.content())
    finally:
        browser.close()
        (out / 'result.json').write_text(json.dumps({'passed': passed, 'errors': errors}, ensure_ascii=False, indent=2))
        print(json.dumps({'passed': passed, 'errors': errors}, ensure_ascii=False, indent=2))
if errors:
    raise SystemExit(1)
