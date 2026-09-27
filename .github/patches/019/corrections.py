from pathlib import Path
import runpy
runpy.run_path('/tmp/patch019/acceptance-fixes.py')
p = Path('Тили-тили/backend/test/audit32.test.ts')
s = p.read_text()
old = "      const reply = (await historyOf(w.token, tilly.id)).find((m) => m.senderId === null)"
assert s.count(old) == 1
s = s.replace(old, "      // 201 confirms the user's message, not the asynchronous Tilly reply.\n      // Await the service's existing completion barrier, never a fixed delay.\n      await app.tilly.settle()\n" + old)
p.write_text(s)
for name in ['ERRORS.md', 'tasks/фичи/019-кандидаты-и-предложения/acceptance-report.md']:
    p = Path(name)
    p.write_text(p.read_text() + '''\n\n### Стабильная проверка асинхронного ответа Тиля\n\nВ полном прогоне audit32 иногда читал историю сразу после 201 пользовательской\nреплики, раньше записи фонового ответа Тиля. Перед проверкой `Message.system`\nтест теперь ожидает существующий `app.tilly.settle()`, не произвольный таймер.\nПроверка содержимого ответа сохранена; production-логика чата не изменена.\n''')
