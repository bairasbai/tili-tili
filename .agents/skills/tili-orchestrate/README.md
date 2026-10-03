# tili-orchestrate

Производный skill для распределения работы между агентами Codex. Корневой агент ведёт полный объём задачи, интеграцию, проверки и поставку; исполнители получают ограниченные области файлов, а свежий проверяющий изучает текущий результат. Рабочий контракт находится в [SKILL.md](SKILL.md), детали приёмки и общих ресурсов — в [references/workflow-evidence.md](references/workflow-evidence.md).

## Происхождение

База: [harnessmachine/codex-orchestrate](https://github.com/harnessmachine/codex-orchestrate), локально скопированная версия с точным SHA:

```text
e44c06e5738a5ea9007ff01ab894df97e89217e8
```

SHA получен командой `git rev-parse HEAD` из предоставленной копии upstream. Это фиксация использованной версии; актуальность относительно удалённой ветки не заявляется.

Исходные файлы этой версии: [SKILL.md](https://github.com/harnessmachine/codex-orchestrate/blob/e44c06e5738a5ea9007ff01ab894df97e89217e8/SKILL.md), [README.md](https://github.com/harnessmachine/codex-orchestrate/blob/e44c06e5738a5ea9007ff01ab894df97e89217e8/README.md), [agents/openai.yaml](https://github.com/harnessmachine/codex-orchestrate/blob/e44c06e5738a5ea9007ff01ab894df97e89217e8/agents/openai.yaml) и [LICENSE](https://github.com/harnessmachine/codex-orchestrate/blob/e44c06e5738a5ea9007ff01ab894df97e89217e8/LICENSE).

Лицензия MIT и `Copyright (c) 2026 Ivan` сохранены в [LICENSE](LICENSE).

## Изменения варианта

- Делегирование через доступные native `collaboration` APIs после разрешения пользователя; выбор исполнителей по ролям без обязательных имён моделей.
- Явное непересекающееся владение файлами и отдельный свежий проверяющий.
- Приёмка каждого требования полного feature/WP scope по текущим исходникам и наблюдаемым результатам.
- Последовательная работа с общими PostgreSQL, Redis, браузером и GitHub только через root.
- GitHub guard, локальная проверка перед API, отсутствие частого опроса CI и остановка при ошибках лимитов или авторизации.
- Сохранение ранее выданного разрешения на commit/push/merge в пределах задачи; production требует отдельной авторизации.

Эти правила описаны в файлах skill. Пакет не запускает scheduler, не обещает автоматическую поставку и не гарантирует отсутствие всех ошибок или уязвимостей.

## Установка из рабочей копии

Каталог `.agents/skills/tili-orchestrate` содержит самостоятельный пакет. Для личной установки из корня этой рабочей копии можно скопировать его в `~/.codex/skills/tili-orchestrate`. Команды ниже прекращают установку, если целевой каталог уже существует:

```powershell
$skillSource = (Resolve-Path -LiteralPath '.agents/skills/tili-orchestrate').Path
$skillInstallRoot = Join-Path $env:USERPROFILE '.codex/skills'
$skillDestination = Join-Path $skillInstallRoot 'tili-orchestrate'
if (Test-Path -LiteralPath $skillDestination) {
    throw 'tili-orchestrate уже установлен; проверьте существующую копию перед обновлением.'
}
New-Item -ItemType Directory -Path $skillInstallRoot -Force | Out-Null
Copy-Item -LiteralPath $skillSource -Destination $skillDestination -Recurse
```

При переносе пакета в отдельный репозиторий копируйте весь его каталог, включая лицензию и метаданные. README не указывает URL собственного удалённого репозитория: публикация не входит в создание этого локального пакета.

Проверьте появление `tili-orchestrate` в списке доступных skills вашей среды. Если список ещё не обновился, начните новый диалог. Пример явного вызова:

```text
$tili-orchestrate продолжи полный план PWA, распредели реализацию и тесты между агентами, проверь каждую фичу и выполни уже разрешённую поставку в main.
```

## Проверка пакета

Используйте штатный `scripts/quick_validate.py` из установленного `skill-creator`, передав путь каталога `tili-orchestrate`. Он проверяет frontmatter, имя и незавершённые шаблоны. Дополнительно проверьте относительные ссылки, YAML метаданных и поведение skill на ограниченной реальной задаче. Структурная проверка сама по себе не доказывает качество оркестрации.

2026-10-03 выполнена ограниченная offline-проверка: отдельные агенты написали dependency-free `paymentSummary` и regression tests, третий свежий агент провёл read-only review. Корневой агент повторил `node --test --test-reporter=spec test/payment-summary.test.mjs`: 106 tests, 106 pass, 0 fail/skipped, exit 0. Штатный `quick_validate.py` также вернул `Skill is valid!`, exit 0. Fixture и точные команды сохранены локально в `C:/Тили-тили/.unlazy/tili-orchestrate-forward-20261003/RESULT.md`; они не входят в устанавливаемый пакет. Проверка подтверждает исполненный путь delegation → HANDOFF → integration → fresh review. DB, Redis, браузер, GitHub и production в этой fixture не проверялись.
