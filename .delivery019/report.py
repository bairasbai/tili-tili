"""Publish verification observations only after all gates completed successfully."""
import hashlib
import json
import os
import pathlib
import re

root = pathlib.Path('work')
out = pathlib.Path(os.environ['RUNNER_TEMP']) / 'offer019-evidence'
log = re.sub(r'\x1b\[[0-9;]*m', '', (out / 'full-gate.log').read_text())
assert 'OK — фронт и бэк: типы, тесты, линт и сборка прошли.' in log
summaries = re.findall(r'^\s*(Test Files|Tests)\s+(.+)$', log, re.M)
assert len(summaries) == 4, summaries
assert all('failed' not in s and 'skipped' not in s for _, s in summaries), summaries
assert 'Unhandled Errors' not in log
result = json.loads((out / 'browser/result.json').read_text())
assert len(result['passed']) == 5 and result['errors'] == [], result
manifest = json.loads(pathlib.Path('manifest019.json').read_text())
for name, expected in manifest.items():
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == expected, name
run = f"https://github.com/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
feature = root / 'tasks/фичи/019-кандидаты-и-предложения'
text = '\n'.join([
    '# Проверка 019 / US3: принятие предложения → бронь', '',
    'Дата поставки: 2026-09-28. Только feature-ветка; main и production не изменялись.', '',
    'База: `c4d37c2995d2aeb28bd988cb5144af164ff9fb60`.',
    'Дельта исходников: SHA-256 `8eb5e22ed77e18b794ba1e803376dae0a49c3b0a81096d03f54b667ea5806e20`.',
    f'[Полный журнал GitHub Actions]({run}) (попытка {os.environ["GITHUB_RUN_ATTEMPT"]}).', '',
    '## Реально выполнено', '',
    '- Node 22; PostgreSQL 16 и Redis 7 в одноразовом CI-окружении; все миграции применены.',
    '- `TEST_DATABASE_URL=postgres://tili:tili@127.0.0.1:5432/tili_test TEST_REDIS_URL=redis://127.0.0.1:6379 bash init.sh` — exit 0.',
    '- Frontend: ' + summaries[0][1] + ' файлов; ' + summaries[1][1] + ' тестов.',
    '- Backend: ' + summaries[2][1] + ' файлов; ' + summaries[3][1] + ' тестов.',
    '- TypeScript, ESLint по всему дереву и обе production-сборки — exit 0.',
    '- 42 новых проверки: 21 с реальной PostgreSQL и 21 экранная. Прежние offers019/shortlist019 сохранены и исправлены их фикстуры/барьеры.',
    '- SHA-256 каждого из 41 изменённого файла проверен перед публикацией. Полный gate выполнен до запуска браузерных серверов.', '',
    '## Браузер, без моков API', '',
    'Playwright 1.57.0 / Chromium; viewport 390×844. Отдельная база `offers_test`, независимые сессии пары и двух подрядчиков.',
    *['- ' + s for s in result['passed']],
    '- JavaScript page errors: 0. Проверены цена 7 500 000 копеек, один deal, закрытие обоих запросов и одинаковый неизменяемый состав в API пары и подрядчика.',
    f'- Артефакт `offer019-verification` в [этом запуске]({run}): result.json, 01-compare.png, 02-booked.png, full-gate.log.', '',
    '## Инварианты и границы', '',
    'Тесты покрывают дубли и конкурентное принятие, замену ответа, удаление пакета, истечение срока в разных поясах, stale-даты, занятую дату с откатом и повтором, роли, приватность, закрытие при переносе/отмене и сохранение принятого снимка после стирания подрядчика.',
    'Локально также выполнен полный gate с PostgreSQL/Redis: frontend 1056 и backend 1213, exit 0. Локальный Chromium заблокирован политикой среды; политика не менялась, браузерная приёмка выполнена на обычном GitHub runner.',
    'T032–T038 и T041 закрыты. T039 (полная обработка стирания/tombstone), T040 (экспорт) и T042 (финальная приёмка всего 019) остаются открытыми. Проверка сохранения принятого снимка не закрывает T039 целиком.',
    'SMS, S3, юридическая приёмка, production deployment и реальная репетиция восстановления в этот прогон не входят.', ''
])
(feature / 'verification-acceptance.md').write_text(text)
tasks = feature / 'tasks.md'
body = tasks.read_text()
assert body.count('- [ ] T041 ') == 1
body = body.replace('- [ ] T041 ', '- [x] T041 ')
tasks.write_text(body)
print(text)
