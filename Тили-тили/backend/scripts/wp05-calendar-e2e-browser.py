import json
import os
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


UI = 'http://127.0.0.1:3000'
IMPORT = '/api/vendor/calendar/import'
EXTERNAL = '/api/vendor/calendar/external'
FIXTURE = json.loads(Path(os.environ['E2E_FIXTURE_FILE']).read_text(encoding='utf-8'))['wp05']
LABELS = {
    'ru': ('Календарь занятости', 'Внешняя занятость', 'Часовой пояс внешнего календаря',
           'Файл календаря ICS', 'Импортировать ICS', 'Не удалось прочитать файл календаря ICS',
           'Интервалов в импорте', 'Начало внешнего заказа', 'Первый день после заказа',
           'Добавить внешний заказ', 'Убрать внешний заказ', 'Подтвердить удаление интервала'),
    'en': ('Availability calendar', 'External availability', 'External calendar time zone',
           'ICS calendar file', 'Import ICS', 'Could not read the ICS calendar file',
           'Imported periods', 'External order start', 'First day after the order',
           'Add external order', 'Remove external order', 'Confirm removal of the period'),
}


def outlined(target):
    expect(target).to_be_focused()
    assert target.evaluate("""el => el.matches(':focus-visible')
        && getComputedStyle(el).outlineStyle !== 'none'
        && parseFloat(getComputedStyle(el).outlineWidth) >= 2""")


def tab_to(page, target):
    expect(target).to_be_visible()
    for _ in range(100):
        if target.evaluate('el => el === document.activeElement'):
            break
        page.keyboard.press('Tab')
    outlined(target)


def write(page, target, method, path, status):
    tab_to(page, target)
    with page.expect_response(lambda res: res.request.method == method and urlparse(res.url).path == path) as pending:
        page.keyboard.press('Enter')
    assert pending.value.status == status, f'{method} {path} returned {pending.value.status}'
    return pending.value


def pick(page, field, text):
    expect(field).to_be_enabled()
    tab_to(page, field)
    with page.expect_file_chooser() as chooser:
        field.press('Enter')
    chooser.value.set_files({'name': 'availability.ics', 'mimeType': 'text/calendar', 'buffer': text.encode()})


def verify(browser, lang, errors):
    calendar_label, external_label, zone_label, file_label, import_label, failure, count, start, end, add, remove, confirm = LABELS[lang]
    context = browser.new_context(viewport={'width': 390, 'height': 844})
    tokens = FIXTURE[lang]
    context.add_init_script(f"""localStorage.setItem('tt_auth', JSON.stringify({json.dumps(tokens)}));
      localStorage.setItem('tt_onboarded', '1'); localStorage.setItem('tt_lang', {json.dumps(lang)});""")
    headers = {'Authorization': 'Bearer ' + tokens['accessToken']}
    try:
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(type(error).__name__))
        page.bring_to_front()
        page.goto(UI + '/vendor-app')
        calendar = page.get_by_role('region', name=calendar_label, exact=True)
        disclosure = calendar.locator('summary').filter(has_text=external_label)
        tab_to(page, disclosure)
        page.keyboard.press('Enter')
        external = calendar.get_by_role('region', name=external_label, exact=True)
        zone = external.get_by_role('textbox', name=zone_label)
        tab_to(page, zone)
        page.keyboard.press('Control+a')
        page.keyboard.insert_text('Europe/Moscow')
        calendar_file = external.get_by_label(file_label)
        pick(page, calendar_file, 'not a calendar')
        upload = external.get_by_role('button', name=import_label)
        bad = write(page, upload, 'PUT', IMPORT, 422)
        assert 'calendar' in bad.json()['error']['fields']
        expect(calendar.get_by_role('alert')).to_have_text(failure)
        outlined(upload)
        expect(upload).to_be_enabled()
        assert calendar_file.evaluate('el => el.files.length === 1')
        lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:wp05-calendar',
                 'DTSTART;VALUE=DATE:20270614', 'DTEND;VALUE=DATE:20270615', 'END:VEVENT', 'END:VCALENDAR', '']
        pick(page, calendar_file, '\r\n'.join(lines))
        assert write(page, upload, 'PUT', IMPORT, 200).json() == {'count': 1}
        expect(external.get_by_role('status').filter(has_text=count)).to_have_text(f'{count} 1')
        outlined(upload)
        for width in (320, 390, 480):
            page.set_viewport_size({'width': width, 'height': 844})
            assert external.evaluate('el => el.getBoundingClientRect().right <= innerWidth')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        for label, value in ((start, '2027-06-20'), (end, '2027-06-22')):
            date = external.get_by_label(label, exact=True)
            tab_to(page, date)
            date.fill(value)
        add_button = external.get_by_role('button', name=add, exact=True)
        assert write(page, add_button, 'POST', EXTERNAL, 200).json() == {'count': 1}
        outlined(add_button)
        interval = external.get_by_role('button', name=remove)
        tab_to(page, interval)
        page.keyboard.press('Enter')
        final = external.get_by_role('button', name=confirm)
        outlined(final)
        assert context.request.get(UI + EXTERNAL, headers=headers).json() == [{'start': '2027-06-20', 'end': '2027-06-22'}]
        write(page, final, 'DELETE', EXTERNAL, 204)
        expect(interval).to_have_count(0)
        outlined(external)
        assert context.request.get(UI + EXTERNAL, headers=headers).json() == []
        actual = context.request.get(UI + '/api/vendor/calendar?month=2027-06', headers=headers)
        assert actual.status == 200
        assert [(day['date'], day['source']) for day in actual.json()] == [('2027-06-14', 'ics')]
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
                passed.append('external-calendar-keyboard-' + lang)
            assert not errors, errors
        finally:
            browser.close()
    result = Path(os.environ['E2E_RESULT_DIR']) / 'wp05-calendar-result.json'
    result.parent.mkdir(parents=True, exist_ok=True)
    result.write_text(json.dumps({'passed': passed, 'page_errors': errors}), encoding='utf-8')
    print('WP05 passed: ' + ', '.join(passed))


if __name__ == '__main__':
    main()
