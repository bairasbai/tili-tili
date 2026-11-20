import json
import os
import re
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


UI = 'http://127.0.0.1:3000'
FIXTURE = json.loads(Path(os.environ['E2E_FIXTURE_FILE']).read_text(encoding='utf-8'))


def save(page, button, expected):
    with page.expect_response(lambda response: response.request.method == 'PUT'
                              and urlparse(response.url).path.startswith('/api/weddings/')) as pending:
        page.get_by_role('button', name=button, exact=True).click()
    assert pending.value.status == expected, f'Expected {expected}, got {pending.value.status}'
    return pending.value


def verify_conflict(first, second, *, route, add, title_label, edit, submit, extra_fields=None):
    first.goto(UI + route)
    first.get_by_role('button', name=add).click()
    title = first.get_by_label(title_label, exact=True)
    initial, remote, draft, merged = ('Исходная карточка', 'Правка второй вкладки', 'Локальный черновик', 'Проверенная правка')
    title.fill(initial)
    if extra_fields:
        extra_fields(first)
    created = save(first, submit, 200).json()
    expect(first.get_by_role('heading', name=initial, exact=True)).to_be_visible()
    second.goto(UI + route)
    first.get_by_role('button', name=f'{edit} · {initial}', exact=True).click()
    second.get_by_role('button', name=f'{edit} · {initial}', exact=True).click()
    title.fill(draft)
    second.get_by_label(title_label, exact=True).fill(remote)
    assert save(second, submit, 200).json()['version'] == created['version'] + 1
    rejected = save(first, submit, 409).json()
    assert rejected['error']['code'] == ('stale_wedding_purchase' if route.endswith('/purchases') else 'stale_wedding_item')
    expect(title).to_have_value(draft)
    expect(first.get_by_role('button', name=submit, exact=True)).to_be_disabled()
    expect(first.get_by_text('Черновик остался в форме.', exact=False)).to_be_visible()
    first.get_by_role('button', name='Загрузить актуальную версию').click()
    expect(title).to_have_value(remote)
    title.fill(merged)
    saved = save(first, submit, 200).json()
    assert saved['id'] == created['id'] and saved['version'] == created['version'] + 2
    expect(first.get_by_role('heading', name=merged, exact=True)).to_be_visible()


def verify_price_history(page):
    name = 'Аренда для сверки истории'
    page.goto(UI + '/wedding/purchases')
    page.get_by_role('button', name='Добавить аренду').click()
    for label, value in {
        'Название аренды': name, 'Единица измерения': 'шт.',
        'Согласованная стоимость, ₽': '840', 'Дата получения': '2027-06-13',
        'Дата возврата': '2027-06-15', 'Согласованный залог, ₽': '500',
    }.items():
        page.get_by_label(label, exact=True).fill(value)
    assert save(page, 'Сохранить аренду', 200).json()['agreedAmount'] == 84000
    card = page.get_by_role('article').filter(has=page.get_by_role('heading', name=name, exact=True))
    card.get_by_role('button', name=f'Изменить аренду · {name}').click()
    page.get_by_label('Согласованная стоимость, ₽', exact=True).fill('920')
    updated = save(page, 'Сохранить аренду', 200).json()
    assert updated['status'] == 'needed' and updated['version'] == 2 and updated['agreedAmount'] == 92000
    card.get_by_role('button', name='История аренды').click()
    history = card.get_by_role('listitem')
    expect(history).to_have_count(2)
    for version, amount in [(2, '920'), (1, '840')]:
        entry = history.filter(has_text=f'Версия {version}')
        price = entry.get_by_text('Согласованная стоимость', exact=True).locator('..').locator('dd')
        expect(price).to_have_text(re.compile(rf'^{amount}\s*₽$'))
    page.goto(UI + '/wedding/budget')
    row = page.get_by_role('link', name=name, exact=True).locator('..')
    expect(row).to_contain_text(re.compile(r'920\s*₽'))
    expect(row).not_to_contain_text('840')


def verify_rental_keyboard(browser, errors, lang):
    add, title_label, unit, pickup, return_date, deposit, paid, refunded, status, save_label, edit, latest, history, screen, returned = {
        'ru': ('Добавить аренду', 'Название аренды', 'Единица измерения', 'Дата получения', 'Дата возврата',
               'Согласованный залог, ₽', 'Внесено залога, ₽', 'Возвращено залога, ₽', 'Статус',
               'Сохранить аренду', 'Изменить аренду', 'Загрузить актуальную версию', 'История аренды', 'Покупки и аренда', 'Возвращено'),
        'en': ('Add rental', 'Rental name', 'Unit', 'Pickup date', 'Return date',
               'Agreed deposit, ₽', 'Deposit paid, ₽', 'Deposit refunded, ₽', 'Status',
               'Save rental', 'Edit rental', 'Load latest version', 'Rental history', 'Purchases and rentals', 'Returned'),
    }[lang]
    page = state_page(browser, errors, FIXTURE['owner'], lang)
    title = 'Rental return WP13 ' + lang
    remote = title + ' v2'
    path = f"/api/weddings/{FIXTURE['weddingId']}/purchases"
    headers = {'Authorization': 'Bearer ' + FIXTURE['owner']['tokens']['accessToken']}

    def activate(target):
        expect(target).to_be_visible()
        if not target.evaluate('el => el === document.activeElement'):
            tab_to(page, target)
        page.keyboard.press('Enter')

    def write(code):
        with page.expect_response(lambda response: response.request.method == 'PUT'
                                  and urlparse(response.url).path.startswith(path + '/')) as pending:
            activate(page.get_by_role('button', name=save_label, exact=True))
        assert pending.value.status == code, f'Rental write returned {pending.value.status}'
        return pending.value.json()

    def select(value):
        field = page.get_by_role('combobox', name=status, exact=True)
        field.focus()
        option = field.locator(f'option[value="{value}"]')
        index = option.evaluate('el => el.index')
        page.keyboard.press('Home')
        for _ in range(index):
            page.keyboard.press('ArrowDown')
        assert field.input_value() == value

    try:
        page.bring_to_front()
        page.goto(UI + '/wedding/purchases')
        activate(page.get_by_role('button', name=add, exact=True))
        field = page.get_by_label(title_label, exact=True)
        expect(field).to_be_focused()
        page.keyboard.insert_text(title)
        for label, value in ((unit, 'pcs'), (pickup, '2027-06-13'), (return_date, '2027-06-15'),
                             (deposit, '500'), (paid, '500')):
            page.get_by_label(label, exact=True).fill(value)
        item = write(200)
        row = page.get_by_role('article').filter(has=page.get_by_role('heading', name=title, exact=True))
        expect(row).to_be_visible()
        region = page.get_by_role('region', name=screen, exact=True)
        expect(region).to_be_focused()
        for value in ('ordered', 'received'):
            activate(row.get_by_role('button', name=f'{edit} · {title}', exact=True))
            select(value)
            item = write(200)
            assert item['status'] == value
            expect(row).to_be_visible()

        activate(row.get_by_role('button', name=f'{edit} · {title}', exact=True))
        expect(field).to_be_focused()
        for width in (320, 390, 480):
            page.set_viewport_size({'width': width, 'height': 844})
            assert field.evaluate('el => el.getBoundingClientRect().right <= innerWidth')
        page.get_by_label(refunded, exact=True).fill('499,50' if lang == 'ru' else '499.50')
        select('returned')
        payload = {key: item[key] for key in ('version', 'title', 'quantity', 'unit', 'categoryId',
                   'estimatedAmount', 'agreedAmount', 'seller', 'sellerUrl', 'dueOn', 'assigneeId', 'eventId', 'linkedDealId', 'status', 'rental')}
        payload['title'] = remote
        update = page.request.put(UI + path + '/' + item['id'], headers=headers, data=payload)
        assert update.status == 200
        rejected = write(409)
        assert rejected['error']['code'] == 'stale_wedding_purchase'
        refresh = page.get_by_role('button', name=latest, exact=True)
        expect(refresh).to_be_focused()
        expect(field).to_have_value(title)
        expect(page.get_by_label(refunded, exact=True)).to_have_value('499,50' if lang == 'ru' else '499.50')
        page.keyboard.press('Enter')
        expect(field).to_have_value(remote)
        expect(field).to_be_focused()
        page.get_by_label(refunded, exact=True).fill('499.50')
        select('returned')
        result = write(200)
        assert result['status'] == 'returned' and result['version'] == update.json()['version'] + 1
        assert result['rental']['paidAmount'] == 50000 and result['rental']['refundedAmount'] == 49950
        updated = page.get_by_role('article').filter(has=page.get_by_role('heading', name=remote, exact=True))
        expect(updated.get_by_text(returned, exact=True)).to_be_visible()
        expect(region).to_be_focused()
        activate(updated.get_by_role('button', name=history, exact=True))
        expect(updated.get_by_role('listitem').first).to_contain_text(returned)
    finally:
        page.close()


def set_role(browser, role):
    owner = FIXTURE['owner']['tokens']
    member = FIXTURE['helper']['id']
    path = f"/api/weddings/{FIXTURE['weddingId']}/members/{member}"
    request = browser.new_context()
    try:
        response = request.request.patch(UI + path, headers={'Authorization': 'Bearer ' + owner['accessToken']},
                                         data={'role': role})
        assert response.status == 200, f'Role change returned {response.status}'
    finally:
        request.close()


def verify_live_access(browser, errors, *, section, edit, title_label, denial):
    set_role(browser, 'couple')
    context = browser.new_context(viewport={'width': 390, 'height': 844})
    tokens = FIXTURE['helper']['tokens']
    context.add_init_script(f"""if (!localStorage.getItem('tt_auth')) {{
      localStorage.setItem('tt_auth', JSON.stringify({json.dumps(tokens)}));
      localStorage.setItem('tt_onboarded', '1');
      localStorage.setItem('tt_wedding_id', JSON.stringify({json.dumps(FIXTURE['weddingId'])}));
    }}""")
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(type(error).__name__))
    path = f"/api/weddings/{FIXTURE['weddingId']}/{section}"

    def is_list(response):
        return response.request.method == 'GET' and urlparse(response.url).path == path

    try:
        page.goto(UI + '/wedding/' + section)
        heading = page.get_by_role('heading', name='Проверенная правка', exact=True)
        card = page.get_by_role('article').filter(has=heading)
        history_button = card.get_by_role('button', name='История покупки' if section == 'purchases' else 'История вещи')
        with page.expect_response(lambda r: r.request.method == 'GET' and urlparse(r.url).path.endswith('/history')) as history:
            history_button.click()
        assert history.value.status == 200
        expect(card.get_by_role('listitem').first).to_be_visible()
        page.get_by_role('button', name=f'{edit} · Проверенная правка', exact=True).click()
        draft = page.get_by_label(title_label, exact=True)
        draft.fill('Проверяемый черновик')
        context.set_offline(True)
        expect(page.get_by_text('Нет связи с сервером', exact=True)).to_be_visible()
        expect(heading).to_have_count(0)
        expect(draft).to_have_count(0)

        with page.expect_response(is_list) as refreshed:
            context.set_offline(False)
        assert refreshed.value.status == 200
        expect(draft).to_have_value('Проверяемый черновик')

        set_role(browser, 'helper')
        with page.expect_response(is_list) as refused:
            page.evaluate("window.dispatchEvent(new Event('focus'))")
        assert refused.value.status == 403
        expect(page.get_by_text(denial, exact=True)).to_be_visible()
        expect(heading).to_have_count(0)
        expect(draft).to_have_count(0)
    finally:
        context.close()


def tab_to(page, control):
    for _ in range(32):
        page.keyboard.press('Tab')
        if control.evaluate('(el) => el === document.activeElement'):
            assert control.evaluate("""el => el.matches(':focus-visible')
                && getComputedStyle(el).outlineStyle !== 'none'
                && parseFloat(getComputedStyle(el).outlineWidth) > 0""")
            return
    raise AssertionError('Keyboard focus did not reach the control')


def state_page(browser, errors, person, language):
    page = browser.new_page(viewport={'width': 320, 'height': 844})
    tokens = person['tokens']
    page.add_init_script(f"""if (!localStorage.getItem('tt_auth')) {{
      localStorage.setItem('tt_auth', JSON.stringify({json.dumps(tokens)}));
      localStorage.setItem('tt_onboarded', '1');
      localStorage.setItem('tt_wedding_id', JSON.stringify({json.dumps(FIXTURE['weddingId'])}));
      localStorage.setItem('tt_lang', {json.dumps(language)});
    }}""")
    page.on('pageerror', lambda error: errors.append(type(error).__name__))
    return page


def verify_read_states(browser, errors, section, language):
    english = language == 'en'
    purchases = section == 'purchases'
    loading = 'Loading…' if english else 'Загружаем…'
    server_error = ('The server is unavailable. Please try again later' if english
                    else 'Сервер недоступен. Попробуйте позже')
    add = (('Add purchase' if purchases else 'Add item') if english
           else ('Добавить покупку' if purchases else 'Добавить вещь'))
    name = (('Purchase name' if purchases else 'Item name') if english
            else ('Название покупки' if purchases else 'Название вещи'))
    if purchases:
        denial = ('The budget is run by the couple - your role has no access to it.' if english
                  else 'Бюджет ведёт пара — у вашей роли к нему доступа нет.')
    else:
        denial = 'Item kits are available to the couple.' if english else 'Наборы вещей доступны паре.'
    route = UI + '/wedding/' + section
    path = f"/api/weddings/{FIXTURE['weddingId']}/{section}"
    api = UI + path

    def is_list(response):
        return response.request.method == 'GET' and urlparse(response.url).path == path

    page = state_page(browser, errors, FIXTURE['owner'], language)
    try:
        held = []
        unavailable = {'error': {'code': 'unavailable', 'message': 'Temporary failure'}}
        fail_reads = False

        def delay_list(route):
            if fail_reads:
                route.fulfill(status=503, json=unavailable)
            else:
                held.append(route)

        page.route(api, delay_list)
        page.goto(route, wait_until='domcontentloaded')
        expect(page.locator('html')).to_have_attribute('lang', language)
        expect(page.get_by_role('status').filter(has_text=loading)).to_be_visible()
        fail_reads = True
        for request in held:
            request.fulfill(status=503, json=unavailable)
        expect(page.get_by_role('alert').filter(has_text=server_error)).to_be_visible()
        page.unroute(api, delay_list)
        retry = page.get_by_role('button', name='Try again' if english else 'Повторить', exact=True)
        tab_to(page, retry)
        with page.expect_response(is_list) as refreshed:
            page.keyboard.press('Enter')
        assert refreshed.value.status == 200
        open_form = page.get_by_role('button', name=add, exact=True)
        tab_to(page, open_form)
        page.keyboard.press('Enter')
        field = page.get_by_role('textbox', name=name, exact=True)
        expect(field).to_be_visible()
        tab_to(page, field)
        page.keyboard.type('WP13')
        expect(field).to_have_value('WP13')
        for width in (320, 390, 480):
            page.set_viewport_size({'width': width, 'height': 844})
            assert field.evaluate("""el => el.getBoundingClientRect().right <= innerWidth
                && document.documentElement.scrollWidth <= innerWidth"""), f'Horizontal overflow at {width}px'
    finally:
        page.close()

    denied = state_page(browser, errors, FIXTURE['helper'], language)
    try:
        with denied.expect_response(is_list) as refused:
            denied.goto(route)
        assert refused.value.status == 403
        expect(denied.get_by_role('alert').filter(has_text=denial)).to_be_visible()
        expect(denied.get_by_role('button', name=add, exact=True)).to_have_count(0)
    finally:
        denied.close()


def main():
    errors, passed = [], []
    output = Path(os.environ['E2E_RESULT_DIR']) / 'wp13-conflict-result.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with sync_playwright() as playwright:
            channel = os.environ.get('E2E_CHROMIUM_CHANNEL')
            browser = playwright.chromium.launch(headless=True, **({'channel': channel} if channel else {}))
            try:
                context = browser.new_context(viewport={'width': 390, 'height': 844})
                tokens = FIXTURE['owner']['tokens']
                context.add_init_script(f"""if (!localStorage.getItem('tt_auth')) {{
                  localStorage.setItem('tt_auth', JSON.stringify({json.dumps(tokens)}));
                  localStorage.setItem('tt_onboarded', '1');
                  localStorage.setItem('tt_wedding_id', JSON.stringify({json.dumps(FIXTURE['weddingId'])}));
                }}""")
                first, second = context.new_page(), context.new_page()
                for page in (first, second):
                    page.on('pageerror', lambda error: errors.append(type(error).__name__))
                verify_conflict(first, second, route='/wedding/purchases', add='Добавить покупку',
                                title_label='Название покупки', edit='Изменить покупку', submit='Сохранить покупку',
                                extra_fields=lambda page: page.get_by_label('Единица измерения').fill('шт.'))
                passed.append('purchase-draft')
                verify_conflict(first, second, route='/wedding/item-sets', add='Добавить вещь',
                                title_label='Название вещи', edit='Изменить вещь', submit='Сохранить')
                passed.append('item-draft')
                verify_price_history(first)
                passed.append('rental-price-history')
                for language in ('ru', 'en'):
                    verify_rental_keyboard(browser, errors, language)
                    passed.append('rental-return-keyboard-' + language)
                verify_live_access(browser, errors, section='purchases', edit='Изменить покупку',
                                   title_label='Название покупки', denial='Бюджет ведёт пара — у вашей роли к нему доступа нет.')
                passed.append('purchase-access-recheck')
                verify_live_access(browser, errors, section='item-sets', edit='Изменить вещь',
                                   title_label='Название вещи', denial='Наборы вещей доступны паре.')
                passed.append('item-access-recheck')
                for section in ('purchases', 'item-sets'):
                    for language in ('ru', 'en'):
                        verify_read_states(browser, errors, section, language)
                        passed.append(f'{section}-read-states-{language}')
                assert not errors, errors
            finally:
                browser.close()
    finally:
        output.write_text(json.dumps({'passed': passed, 'page_errors': errors}), encoding='utf-8')
    print('WP13 passed: ' + ', '.join(passed))


if __name__ == '__main__':
    main()
