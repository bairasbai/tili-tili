# Repo-scoped design skills

Локальная установка для Codex в `bairasbai/tili-tili`. Вызывать явно: `$ui-ux-pro-max` для проверки интерфейсов и `$diagram-design` для схем. В обоих `agents/openai.yaml` стоит `allow_implicit_invocation: false`; зависимости инструментов и автоматическая загрузка не объявлены. Точный состав и SHA-256 файлов — в [sources.lock.json](sources.lock.json).

## Закреплённые источники

| Навык | Источник / commit | Версия в исходнике | Лицензия |
|---|---|---|---|
| UI/UX Pro Max | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/tree/b7d5353e0130feb8c5574ef1251f8a1db1873ccb) · `b7d5353e0130feb8c5574ef1251f8a1db1873ccb` | plugin `2.15.0`; CLI `2.5.0` не установлен | [MIT, © 2024 Next Level Builder](ui-ux-pro-max/LICENSE) |
| Diagram Design | [cathrynlavery/diagram-design](https://github.com/cathrynlavery/diagram-design/tree/f24d98b05e2d7a5e68c2dedfe46e5b7173f50118) · `f24d98b05e2d7a5e68c2dedfe46e5b7173f50118` | plugin `2.6.141`; frontmatter upstream `2.6` | [MIT, © 2025 Cathryn Lavery](diagram-design/LICENSE) |

Это фиксация проверенных исходников, не утверждение об их последней доступной версии. Никакого обновления при запуске нет.

## Состав и адаптации

UI/UX Pro Max: четыре runtime-скрипта `search.py`, `core.py`, `design_system.py`, `reasoning_contract.py`, весь локальный каталог `data/` с исходными provenance/license metadata и два справочника. Runtime и данные скопированы без изменений. Краткий upstream `SKILL.md` адаптирован к Codex: metadata из `templates/platforms/codex.json`, команды от корня `.agents/skills/ui-ux-pro-max/scripts/search.py`, без `CLAUDE_PLUGIN_ROOT`. Шаблонный путь `skills/...` без `.agents/` здесь не используется. Убрано требование генерировать новую дизайн-систему для каждой страницы; утверждённый Soft Pastel имеет приоритет.

Diagram Design: самостоятельный каталог `skills/diagram-design/{assets,references,scripts}`. Сохранены примеры и справочники всех типов, чтобы ссылки пакета оставались разрешимыми. Добавлены [проектные правила](diagram-design/references/tili-project.md), метаданные Codex и их приоритет в `SKILL.md`/`style-guide.md`; upstream defaults остаются демонстрационными. Единственная правка runtime: `export_png.py` запускает Chromium с `chromium_sandbox=True`, без fallback на отключённый sandbox.

Не перенесены CLI/marketplace/plugin manifests, slash commands, сетевые refresh/build scripts, upstream CI/maintainer tooling, screenshots, fonts, личные профили, hooks или настройки редактора. `tili-orchestrate` и приложение не изменены. Установка не добавляет зависимости или lock-файлы приложения.

## Стороннее содержимое Diagram Design

Исходный [THIRD_PARTY_LICENSES.md](diagram-design/THIRD_PARTY_LICENSES.md) сохранён без изменений, включая указания о товарных знаках и происхождении отдельных SAS/Stata marks. Упомянутые там пути относятся к структуре upstream; установлено только содержимое каталога skill, без исходных vendor/build scripts и plugin logo.

Полные тексты лицензий для включённых в справочники/HTML иконок сохранены дополнительно:

- [Tabler Icons — MIT](diagram-design/licenses/Tabler-Icons-MIT.txt).
- [Simple Icons — CC0 1.0](diagram-design/licenses/Simple-Icons-CC0.txt).
- [log-z/logos — MIT](diagram-design/licenses/log-z-logos-MIT.txt).
- [Devicon — MIT](diagram-design/licenses/Devicon-MIT.txt).

Их исходные URL и Git blob SHA указаны в `sources.lock.json`. Отдельные версии исходных наборов иконок upstream не фиксирует; байты включённых иконок закреплены commit Diagram Design. Шрифтовые файлы и содержащий глиф Instrument Serif логотип не поставляются. UI/UX Pro Max содержит метаданные Google Fonts и рекомендации Phosphor; сами шрифты и библиотека иконок не устанавливаются.

## Проверка и ограничения

Команды из примеров UI/UX выполняются из корня репозитория; из другой cwd передавать полный путь скрипта. Diagram Design: для HTML достаточно Python 3.10+ и стандартной библиотеки; SVG экспортируется локально с `--system-fonts`.

Скопированные upstream HTML-примеры содержат Google Fonts и местами inline motion. Не открывать их как готовый офлайн-результат: для нового вывода удалить внешние ресурсы, применить проектный overlay и выполнить `self_check.py --offline`. Шаблоны не загружаются и не исполняются при установке.

PNG требует отдельно подготовленных Python Playwright и совместимого Chromium с рабочим sandbox. Установка ничего не скачивает; PNG и фактический browser rendering не входят в подтверждённую приёмку. Если sandbox недоступен, сообщить об этом без `--no-sandbox`. Анимация, профили в домашнем каталоге, website onboarding, полная upstream maintainer suite, Windows и физические устройства этой установкой не проверены.

Проверки привязаны к составу пакетов в lock-файле; протокол локальной приёмки и её пределы — в `session-handoff.md` и `JOURNAL.md`. Push, PR, merge и deploy в текущий этап не входят.
