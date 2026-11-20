import json
import os
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


UI = 'http://127.0.0.1:3000'
FIXTURE = json.loads(Path(os.environ['E2E_FIXTURE_FILE']).read_text(encoding='utf-8'))['wp06']
LABELS = {
    'ru': {
        'order': 'Состав заказа', 'brief': 'Пожелания по услуге', 'coverage': 'Какие события снимать',
        'save': 'Сохранить пожелания', 'staff': 'Назначения сотрудников', 'employee': 'Сотрудник',
        'event': 'Мероприятие для назначения', 'duty': 'Что сделать', 'assign': 'Назначить сотрудника',
        'materials': 'Материалы по сделке', 'description': 'Описание результата', 'link': 'Ссылка на материалы',
        'date': 'Срок сдачи', 'submit': 'Сдать результат', 'submitted': 'Результат сдан',
        'comment': 'Что нужно исправить', 'revise': 'Запросить правки', 'revisions': 'Запрошены правки',
        'accept': 'Принять результат', 'accepted': 'Результат принят', 'offline': 'Нет связи с сервером',
    },
    'en': {
        'order': 'Order contents', 'brief': 'Service preferences', 'coverage': 'Events to cover',
        'save': 'Save preferences', 'staff': 'Staff assignments', 'employee': 'Employee',
        'event': 'Event for this assignment', 'duty': 'What to do', 'assign': 'Assign employee',
        'materials': 'Order materials', 'description': 'Description of the work', 'link': 'Link to the materials',
        'date': 'Delivery deadline', 'submit': 'Submit work', 'submitted': 'Work submitted',
        'comment': 'What needs to be fixed', 'revise': 'Request revisions', 'revisions': 'Revisions requested',
        'accept': 'Accept work', 'accepted': 'Work accepted', 'offline': 'No connection to the server',
    },
}


def activate(page):
    page.bring_to_front()


def focus(page, target):
    expect(target).to_be_visible()
    for _ in range(120):
        if target.evaluate('el => el === document.activeElement'):
            break
        page.keyboard.press('Tab')
    expect_outline(target)


def expect_outline(target):
    expect(target).to_be_focused()
    assert target.evaluate("""el => el.matches(':focus-visible')
        && getComputedStyle(el).outlineStyle !== 'none'
        && parseFloat(getComputedStyle(el).outlineWidth) >= 2""")


def press(page, target):
    focus(page, target)
    page.keyboard.press('Enter')


def type_text(page, target, value):
    focus(page, target)
    page.keyboard.insert_text(value)


def signed(browser, fixture, actor, lang, errors):
    context = browser.new_context(viewport={'width': 390, 'height': 844}, locale='en-US')
    context.add_init_script(f"""localStorage.setItem('tt_auth', JSON.stringify({json.dumps(fixture[actor])}));
      localStorage.setItem('tt_onboarded', '1');
      localStorage.setItem('tt_wedding_id', JSON.stringify({json.dumps(fixture['weddingId'])}));
      localStorage.setItem('tt_lang', {json.dumps(lang)});""")
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(type(error).__name__))
    return page


def write(page, path, method, trigger, status):
    with page.expect_response(lambda response: response.request.method == method and urlparse(response.url).path == path) as pending:
        press(page, trigger)
    response = pending.value
    assert response.status == status, f'{method} {path} returned {response.status}, expected {status}'
    return response.json()


def materials(page, labels):
    disclosure = page.get_by_role('button', name=labels['materials'], exact=True)
    press(page, disclosure)
    expect(disclosure).to_have_attribute('aria-expanded', 'true')
    return page.get_by_role('region', name=labels['materials'])


def refresh(page, path):
    with page.expect_response(lambda response: response.request.method == 'GET' and urlparse(response.url).path == path) as pending:
        page.evaluate("window.dispatchEvent(new Event('focus'))")
    assert pending.value.status == 200


def submit(page, region, labels, delivery, summary):
    type_text(page, region.get_by_role('textbox', name=labels['description']), summary)
    type_text(page, region.get_by_role('textbox', name=labels['link']), 'https://example.invalid/wp06-material')
    deadline = region.get_by_label(labels['date'], exact=True)
    focus(page, deadline)
    deadline.fill('2027-06-21')
    write(page, delivery, 'POST', region.get_by_role('button', name=labels['submit']), 200)
    expect_outline(region)
    expect(region.get_by_text(summary, exact=True)).to_be_visible()


def verify(browser, lang, errors):
    fixture, labels = FIXTURE[lang], LABELS[lang]
    vendor = signed(browser, fixture, 'vendor', lang, errors)
    owner = signed(browser, fixture, 'owner', lang, errors)
    deal = fixture['dealId']
    order_path = f'/api/deals/{deal}/order'
    delivery = order_path + '/delivery'
    try:
        activate(vendor)
        vendor.goto(UI + '/vendor-app/deals/' + deal)
        press(vendor, vendor.locator('summary').filter(has_text=labels['order']))
        press(vendor, vendor.locator('summary').filter(has_text=labels['brief']))
        brief = vendor.get_by_label(labels['coverage'], exact=True)
        type_text(vendor, brief, 'Ceremony WP06')
        write(vendor, order_path + '/brief', 'PATCH', vendor.get_by_role('button', name=labels['save']), 200)
        expect(brief).to_have_value('Ceremony WP06')

        press(vendor, vendor.get_by_role('button', name=labels['staff'], exact=True))
        for label in ('employee', 'event'):
            select = vendor.get_by_role('combobox', name=labels[label], exact=True)
            focus(vendor, select)
            expect(select.get_by_role('option')).to_have_count(2)
            vendor.keyboard.press('End')
            vendor.keyboard.press('Enter')
            assert select.input_value()
        task = 'Capture the entrance WP06'
        type_text(vendor, vendor.get_by_role('textbox', name=labels['duty'], exact=True), task)
        assign = vendor.get_by_role('button', name=labels['assign'], exact=True)
        write(vendor, f'/api/vendor/deals/{deal}/staff-duties', 'POST', assign, 201)
        expect_outline(assign)
        expect(vendor.get_by_text(task, exact=True)).to_be_visible()

        region = materials(vendor, labels)
        for width in (320, 390, 480):
            vendor.set_viewport_size({'width': width, 'height': 844})
            field = region.get_by_role('textbox', name=labels['description'])
            expect(field).to_be_visible()
            assert field.evaluate('el => el.getBoundingClientRect().right <= innerWidth'), width
        submit(vendor, region, labels, delivery, 'First delivery WP06')
        expect(region.get_by_role('status').filter(has_text=labels['submitted'])).to_have_count(1)

        activate(owner)
        owner.goto(UI + '/deal/' + deal)
        review = materials(owner, labels)
        expect(review.get_by_text('First delivery WP06', exact=True)).to_be_visible()
        type_text(owner, review.get_by_role('textbox', name=labels['comment']), 'Crop the opening shot WP06')
        write(owner, delivery, 'POST', review.get_by_role('button', name=labels['revise']), 200)
        expect_outline(review)
        expect(review.get_by_role('status').filter(has_text=labels['revisions'])).to_have_count(1)

        activate(vendor)
        vendor.reload()
        region = materials(vendor, labels)
        expect(region.get_by_text('Crop the opening shot WP06', exact=True)).to_be_visible()
        submit(vendor, region, labels, delivery, 'Updated delivery WP06')
        activate(owner)
        refresh(owner, delivery)
        expect(review.get_by_text('Updated delivery WP06', exact=True)).to_be_visible()
        write(owner, delivery, 'POST', review.get_by_role('button', name=labels['accept']), 200)
        expect_outline(review)
        expect(review.get_by_role('status').filter(has_text=labels['accepted'])).to_have_count(1)
        checked = owner.request.get(UI + delivery, headers={'Authorization': 'Bearer ' + fixture['owner']['accessToken']})
        assert checked.status == 200
        assert [step['kind'] for step in checked.json()['steps']] == ['accepted', 'submitted', 'changes_requested', 'submitted']
        material = review.get_by_role('link').first
        focus(owner, material)
        owner.context.set_offline(True)
        expect(review.get_by_role('status').filter(has_text=labels['offline'])).to_be_visible()
        expect(review.get_by_role('link')).to_have_count(0)
        expect_outline(review)
        with owner.expect_response(lambda response: response.request.method == 'GET' and urlparse(response.url).path == delivery) as reconnect:
            owner.context.set_offline(False)
        assert reconnect.value.status == 200
        expect(review.get_by_text('Updated delivery WP06', exact=True)).to_be_visible()
    finally:
        vendor.context.close()
        owner.context.close()


def main():
    errors, passed = [], []
    with sync_playwright() as playwright:
        channel = os.environ.get('E2E_CHROMIUM_CHANNEL')
        browser = playwright.chromium.launch(headless=True, **({'channel': channel} if channel else {}))
        try:
            for lang in LABELS:
                verify(browser, lang, errors)
                passed.append('vendor-delivery-keyboard-' + lang)
            assert not errors, errors
        finally:
            browser.close()
    result = Path(os.environ['E2E_RESULT_DIR']) / 'wp06-delivery-result.json'
    result.parent.mkdir(parents=True, exist_ok=True)
    result.write_text(json.dumps({'passed': passed, 'page_errors': errors}), encoding='utf-8')
    print('WP06 passed: ' + ', '.join(passed))


if __name__ == '__main__':
    main()
