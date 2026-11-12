#!/usr/bin/env bash
set -euo pipefail

probe_chromium() {
  python - <<'PY'
from playwright.sync_api import sync_playwright

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        page = browser.new_page()
        page.set_content('<p>Проверка Chromium</p>')
        if page.locator('p').inner_text() != 'Проверка Chromium':
            raise RuntimeError('Chromium did not render the test page')
        if not page.screenshot().startswith(b'\x89PNG\r\n\x1a\n'):
            raise RuntimeError('Chromium did not produce a PNG screenshot')
        print(f'Playwright Chromium {browser.version} started and rendered a page')
    finally:
        browser.close()
PY
}

python -m pip install playwright==1.57.0
python -m playwright install chromium

# Hosted runners may already have the necessary libraries. Ask the browser
# itself before contacting Ubuntu mirrors for system packages.
if ! probe_chromium; then
  python -m playwright install-deps chromium
  probe_chromium
fi
