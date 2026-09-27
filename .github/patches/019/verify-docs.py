"""Finalize feature documentation only after all verification gates pass."""
from pathlib import Path
import json, os
folder = Path('tasks/фичи/019-кандидаты-и-предложения')
evidence = Path('/tmp/verify019')
checks = dict(line.split('\t') for line in (evidence/'checks.tsv').read_text().splitlines())
assert len(checks) == 11 and all(value == '0' for value in checks.values()), checks
reports = {}
for name, minimum in [('acceptance-backend',20), ('acceptance-app',19), ('backend-tests',1213), ('app-tests',1046)]:
    data = json.loads((evidence/(name+'.json')).read_text())
    assert data['success'] and data['numFailedTests'] == 0 and data['numPendingTests'] == 0
    assert data['numPassedTests'] == data['numTotalTests'] and data['numTotalTests'] >= minimum
    reports[name] = {key:data[key] for key in ['numTotalTests','numPassedTests','numFailedTests','numPendingTests']}
url = 'https://github.com/bairasbai/tili-tili/actions/runs/'+os.environ['GITHUB_RUN_ID']
result = {'feature':'019 / US3 / T032-T038','base_commit':'c4d37c2995d2aeb28bd988cb5144af164ff9fb60','verification_run':url,'checks':checks,'tests':reports,'browser_e2e':'Not run; T041 remains open','deployment':'Not deployed; main unchanged'}
(folder/'verification-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
text = '## Фактические результаты\n\n'
for name,data in reports.items():
    text += f"- {name}: {data['numPassedTests']}/{data['numTotalTests']}, ошибок и пропусков 0.\n"
text += '\nTypeScript, полный ESLint, обе сборки и повторный `bash init.sh` с PostgreSQL 16 и Redis 7 прошли.\nПрогон: '+url+'\nJSON и полные журналы сохранены в артефакте verify019.\n\nT032–T038 закрыты. Фаза 6 T039–T042, включая браузерный E2E, остаётся открытой.\nНет оплаты, слияния в main или развёртывания на сервере.\n'
p=folder/'acceptance-report.md'
s=p.read_text().replace('Фактические результаты прогона записываются ниже после выполнения. Наличие тестов\nсамо по себе не означает успешного прогона или готовности к production.','Живой прогон завершён; результаты ниже. Это не означает готовности всего приложения к production.')
assert '<!-- VERIFY019_RESULTS -->' in s
p.write_text(s.replace('<!-- VERIFY019_RESULTS -->',text))
p=folder/'tasks.md';s=p.read_text()
for number in range(32,39):
    old=f'- [ ] T{number:03d}';assert old in s;s=s.replace(old,f'- [x] T{number:03d}',1)
assert all(f'- [ ] T{number:03d}' in s for number in range(39,43))
p.write_text(s.replace('## Фаза 6 — полировка','**Проверено 2026-09-28:** T032–T038 завершены; результаты — [acceptance-report.md](acceptance-report.md).\n\n## Фаза 6 — полировка',1))
p=Path('tasks/todo.md');s=p.read_text().replace('реализуется одной фичей поверх c4d37c2','завершена одной фичей поверх c4d37c2; PostgreSQL/Redis и bash init.sh прошли');p.write_text(s)
for name in ['JOURNAL.md','session-handoff.md','tasks/product-improvements-roadmap.md']:
    p=Path(name);p.write_text(p.read_text()+'\n019 / US3: живой gate и `bash init.sh` прошли. Результаты: `tasks/фичи/019-кандидаты-и-предложения/verification-results.json`. Следующая работа — T039–T042.\n')
