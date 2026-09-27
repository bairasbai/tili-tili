"""Fail closed when the payment browser result is incomplete or changed."""
import json
import os
import pathlib


EXPECTED_SCENARIOS = [
    'budget-navigation-and-unallocated-warning',
    'create-installment-no-new-payment-or-double-commitment',
    'link-existing-payment-without-duplication',
    'partial-payment-via-ui',
    'payment-persists-after-reload',
    'helper-cannot-read-or-export-finances',
    'second-couple-session-sees-same-payments',
    'stale-draft-rejected-and-preserved',
    'fixed-payment-deadline-after-wedding-reschedule',
    '320-and-390-pixel-layout',
    'cancel-plan-keeps-cash-history-without-refund',
    'csv-download-with-distinct-plan-and-payment-records',
    'receipt-upload-download-two-step-delete',
    'budget-reserve-and-category-limit',
]


def verify(result: dict) -> None:
    if result.get('passed') != EXPECTED_SCENARIOS:
        raise AssertionError('payment browser scenarios are missing, duplicated, reordered, or unexpected')
    if result.get('page_errors'):
        raise AssertionError('payment browser reported page errors')
    if 'error' in result:
        raise AssertionError('payment browser reported an execution error')


if __name__ == '__main__':
    result_path = pathlib.Path(os.environ['E2E_RESULT_DIR']) / 'payment-browser-result.json'
    verify(json.loads(result_path.read_text(encoding='utf-8')))
    print(f'Payment browser acceptance: {len(EXPECTED_SCENARIOS)}/{len(EXPECTED_SCENARIOS)}')
