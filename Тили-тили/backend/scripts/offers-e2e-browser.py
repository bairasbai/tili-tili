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

TERM_LABELS = {
    'hours': 'Часы и охват услуги',
    'team': 'Команда в предложении',
    'result': 'Результат услуги',
    'delivery': 'Срок сдачи результата',
    'extras': 'Дополнительные расходы',
    'cancellation': 'Условия отмены',
    'reschedule': 'Условия переноса',
}
CHOSEN_TERMS = {
    'hours': 'Девять часов съёмки',
    'team': 'Фотограф и ассистент',
    'result': 'Альбом и онлайн-галерея',
    'delivery': 'Галерея через три недели',
    'extras': '0',
    'cancellation': 'Отмена по письменному соглашению',
    'reschedule': 'Перенос на свободный день',
}
OTHER_TERMS = {'hours': 'Шесть часов съёмки'}

out = pathlib.Path(os.environ['E2E_RESULT_DIR'])
out.mkdir(parents=True, exist_ok=True)
f = json.loads(pathlib.Path(os.environ['E2E_FIXTURE_FILE']).read_text())
wid = f['weddingId']
passed, errors = [], []
with sync_playwright() as pw:
    options = {'headless': True}
    if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'):
        options['executable_path'] = os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']
    elif os.environ.get('E2E_CHROMIUM_CHANNEL'):
        options['channel'] = os.environ['E2E_CHROMIUM_CHANNEL']
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

    def expect_booking_terms(booking_page):
        for field, label in TERM_LABELS.items():
            row = booking_page.get_by_text(label, exact=True).locator('..')
            expect(row.locator('dd')).to_have_text(CHOSEN_TERMS[field])

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
            package_mode = p.get_by_role('button', name='Пакет', exact=True)
            expect(package_mode).to_have_attribute('aria-pressed', 'true')
            if index == 0:
                custom = p.get_by_role('button', name='Своё предложение')
                custom.focus()
                p.keyboard.press('Space')
                expect(custom).to_have_attribute('aria-pressed', 'true')
                decline = p.get_by_role('button', name='Отказ', exact=True)
                p.keyboard.press('Tab')
                expect(decline).to_be_focused()
                p.keyboard.press('Tab')
                title = p.get_by_role('textbox', name='Название предложения')
                expect(title).to_be_focused()
                assert title.evaluate("""el => el.matches(':focus-visible')
                    && getComputedStyle(el).outlineStyle !== 'none'
                    && parseFloat(getComputedStyle(el).outlineWidth) > 0""")
                expect(p.get_by_role('textbox', name='Что входит — по пункту в строке')).to_be_visible()
                for width in (320, 390, 480):
                    p.set_viewport_size({'width': width, 'height': 844})
                    assert title.evaluate("""el => el.getBoundingClientRect().right <= innerWidth
                        && document.documentElement.scrollWidth <= innerWidth"""), f'Offer editor overflows at {width}px'
                p.set_viewport_size({'width': 390, 'height': 844})
                package_mode.click()
                expect(package_mode).to_have_attribute('aria-pressed', 'true')
            p.get_by_label('Цена предложения, ₽', exact=True).fill(str(75000 + index * 10000))
            for field, value in (CHOSEN_TERMS if index == 0 else OTHER_TERMS).items():
                p.get_by_label(TERM_LABELS[field], exact=True).fill(value)
            p.get_by_role('button', name='Отправить предложение', exact=True).click()
            expect(p.get_by_role('button', name='Изменить ответ', exact=True)).to_be_visible()
            c.close()
        passed.append('Independent vendor sessions reply with their own package, price and quoted terms')

        page.reload()
        page.get_by_role('button', name='Сравнить (2)', exact=True).click()
        expect(page).to_have_url(re.compile(r'/compare\?'))
        # The router may update the URL before replacing the previous slot screen.
        expect(page.get_by_text('Сравнение', exact=True)).to_be_visible()
        table = page.get_by_role('table')
        expect(table).to_be_visible()
        page.set_viewport_size({'width': 320, 'height': 844})
        comparison = page.get_by_role('region', name='Сравнение подрядчиков')
        expect(comparison).to_have_attribute('tabindex', '0')
        for _ in range(20):
            page.keyboard.press('Tab')
            if comparison.evaluate('el => el === document.activeElement'):
                break
        expect(comparison).to_be_focused()
        assert comparison.evaluate('el => el.scrollWidth > el.clientWidth && document.documentElement.scrollWidth <= innerWidth')
        page.keyboard.press('ArrowRight')
        page.wait_for_function('document.activeElement.scrollLeft > 0')
        page.set_viewport_size({'width': 390, 'height': 844})
        for vendor in f['vendors']:
            expect(table.get_by_role('button', name='Принять предложение: ' + vendor['packageName'], exact=True)).to_be_visible()
        availability = table.get_by_role('rowheader', name='Актуальность доступности', exact=True).locator('..')
        service = table.get_by_role('rowheader', name='Состав услуги в предложении', exact=True).locator('..')
        for vendor, terms in zip(f['vendors'], (CHOSEN_TERMS, OTHER_TERMS), strict=True):
            column = table.get_by_role('columnheader', name=re.compile(re.escape(vendor['name'])))
            cell_index = column.evaluate('(cell) => cell.cellIndex') - 1
            assert cell_index >= 0, vendor['name']
            expect(service.get_by_role('cell').nth(cell_index)).to_have_text('Съёмка 8 часов 500 фотографий')
            for field, label in TERM_LABELS.items():
                row = table.get_by_role('rowheader', name=label, exact=True).locator('..')
                expect(row.get_by_role('cell').nth(cell_index)).to_have_text(terms.get(field, 'Неизвестно'))
            observed = availability.get_by_role('cell').nth(cell_index)
            expect(observed.get_by_text('Календарь дня', exact=True)).to_be_visible()
            expect(observed.get_by_text(re.compile(r'^Дата календаря:'))).to_be_visible()
            expect(observed.locator('time')).to_have_attribute('datetime', re.compile(r'^\d{4}-\d{2}-\d{2}T.*Z$'))
        passed.append('Comparison shows quoted values, missing conditions and the calendar observation for each vendor')
        page.screenshot(path=str(out / '01-compare.png'), full_page=True)
        partner = context(f['partner'])
        partner_page = partner.new_page()
        partner_page.on('pageerror', lambda e: errors.append(str(e)))
        partner_page.goto(page.url)
        expect(partner_page.get_by_role('table')).to_be_visible()
        chosen = f['vendors'][0]
        partner_page.get_by_role('table').get_by_role(
            'button', name='Принять предложение: ' + chosen['packageName'], exact=True).click()
        expect(partner_page.get_by_text('Предложение выбрано', exact=True)).to_be_visible()
        page.reload()
        expect(page.get_by_text('Предложение выбрано', exact=True)).to_be_visible()
        expect(page.get_by_role('button', name=re.compile('^Принять предложение:'))).to_have_count(0)
        passed.append('Second couple session accepts one offer; first session shows the selection after reload')

        slots = get(f'/weddings/{wid}/slots')
        slot = next(s for s in slots if s['id'] == sid)
        deal = slot['deal']
        partner_slot = next(s for s in get(f'/weddings/{wid}/slots', f['partner']) if s['id'] == sid)
        assert partner_slot['deal']['id'] == deal['id'], 'Both partners must read the same deal'
        assert deal['state'] == 'booked' and deal['price'] == {'amount': 7500000, 'currency': 'RUB'}, deal
        assert deal['packageName'] == chosen['packageName'], deal
        assert deal['packageIncludes'] == ['Съёмка 8 часов', '500 фотографий'], deal
        assert deal['comparisonTerms'] == CHOSEN_TERMS, deal['comparisonTerms']
        assert partner_slot['deal']['comparisonTerms'] == CHOSEN_TERMS
        shortlist = get(f'/weddings/{wid}/slots/{sid}/shortlist')
        assert sorted(e['request']['closeReason'] for e in shortlist) == ['booked', 'booked_other'], shortlist
        cabinet = get('/vendor/deals', chosen)['items']
        assert sum(d['id'] == deal['id'] for d in cabinet) == 1, cabinet
        booked = next(d for d in cabinet if d['id'] == deal['id'])
        assert booked['packageName'] == chosen['packageName'] and booked['packageIncludes'] == deal['packageIncludes'], booked
        assert booked['comparisonTerms'] == CHOSEN_TERMS, booked['comparisonTerms']
        page.goto(f'http://127.0.0.1:3000/wedding/slot/{sid}')
        expect(page.get_by_role('button', name=re.compile('^Принять предложение:'))).to_have_count(0)
        expect(page.get_by_text(chosen['name'], exact=True).first).to_be_visible()
        page.screenshot(path=str(out / '02-booked.png'), full_page=True)
        partner.close()
        passed.append('Both couple sessions and the vendor read one booking with exact price and saved package')

        page.goto(f'http://127.0.0.1:3000/deal/{deal["id"]}')
        expect_booking_terms(page)
        vendor_context = context(chosen)
        vendor_page = vendor_context.new_page()
        vendor_page.on('pageerror', lambda e: errors.append(str(e)))
        vendor_page.goto(f'http://127.0.0.1:3000/vendor-app/deals/{deal["id"]}')
        expect_booking_terms(vendor_page)
        vendor_context.close()
        passed.append('Couple and vendor booking screens show all seven accepted terms after fresh navigation')
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
