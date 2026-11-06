# Навыки дизайна · локальная подготовка · 6 ноября 2026

## Локальный результат

Репозиторий `bairasbai/tili-tili`; собственная worktree `/workspace/tili-design-skills`, ветка `codex/install-design-skills-20261106` без remote tracking. Основание — свежий GitHub main `d89979974fc7e7fc9b38e2aafea45fed644b4209` (один fetch, main SHA сверен 06.11). Исходная `/workspace/tili-tili` не переключалась; её содержимое сохранено. AGENTS.md в актуальном дереве main/локальных предках отсутствует. Прочитаны CLAUDE.md, текущие todo/handoff, tili-orchestrate и утверждённые дизайн-токены. GitHub guard в home этого cloud environment отсутствует; запросы чтения шли последовательно.

Добавлено только в `.agents/skills/`:

- `ui-ux-pro-max/`: 48 файлов / 3 288 761 байт; источник `nextlevelbuilder/ui-ux-pro-max-skill@b7d5353e0130feb8c5574ef1251f8a1db1873ccb`, plugin 2.15.0. Четыре runtime-скрипта, весь каталог data с provenance/license metadata, два справочника, Codex SKILL/metadata, MIT.
- `diagram-design/`: 298 файлов / 5 401 282 байта; источник `cathrynlavery/diagram-design@f24d98b05e2d7a5e68c2dedfe46e5b7173f50118`, plugin 2.6.141. Самостоятельный skill с assets/references/scripts, Codex metadata, локальный Soft Pastel overlay, MIT и исходные third-party notices; полные лицензии Tabler/log-z/Devicon/Simple Icons с проверенными blob SHA.
- `THIRD_PARTY_NOTICES.md`: состав, происхождение, адаптации, ручной вызов и ограничения.
- `sources.lock.json`: pins и SHA-256 каждого из 346 файлов; 335 исходных неизменённых, 4 адаптированных, 3 локальных, 4 дополнительных лицензии.

Явные вызовы: `$ui-ux-pro-max`, `$diagram-design`; `allow_implicit_invocation: false`, без dependencies/tools. Пути UI для Codex включают `.agents/` от корня. Утверждённый дизайн, русские ключи i18n, existing icon system/intentional emoji tiles, карты и проектные гейты имеют приоритет. Новый дизайн-системный MASTER в проект не создаётся. Единственное изменение runtime — PNG helper явно включает Chromium sandbox; если host его не поддерживает, отказ без обхода. Hooks, глобальные установки, package/lock-файлы приложения, CI, CLAUDE.md и tili-orchestrate не менялись. Юлдаш и компьютер пользователя не затрагивались.

## Подтверждённые проверки

- `python3 -B /workspace/scratch/design-skill-checks/quick_validate.py .agents/skills/<name>` для обоих навыков: `Skill is valid!`, exit 0.
- Все 346 SHA-256, соответствие 335 исходных файлов pin, 4 Git blob SHA лицензий, YAML/explicit invocation/default_prompt, Python AST/imports, корректность Codex path и 209 локальных Markdown links: PASS.
- `python3 -I -B /workspace/scratch/design-skill-checks/audit_run.py /workspace/scratch/design-skill-checks/ui_upstream_checks.py`: upstream catalog contracts на установленных 12 domain / 22 stack + reasoning PASS; 38 выбранных upstream core tests PASS/0 failed, exit 0. Один concurrent subprocess test намеренно не запускался под запретом дочерних процессов; это не полный upstream suite.
- `python3 -B /workspace/scratch/design-skill-checks/smoke_checks.py`: 15 guarded CLI checks PASS, exit 0. Guard сам проверен на отказ network/outside writes/child processes. Поиск UX/React19/shadcn/Tailwind3; Mermaid/draw.io/Excalidraw и два untrusted inputs; XML entities отклонены exit 2; offline HTML и portable SVG PASS; external script и truncated HTML отклонены exit 1.
- `python3 -I -B /workspace/scratch/design-skill-checks/audit_run.py /workspace/scratch/design-skill-checks/run/png_sandbox_probe.py`: launch kwargs `chromium_sandbox=True` подтверждены stub, exit 0; настоящий браузер не запускался.
- Независимый ограниченный forward-check: агент использовал установленный Diagram Design для концептуальной русской static-схемы. HTML `/workspace/scratch/design-skill-checks/forward/request-check-response.html`, SHA-256 `9723e58c6ed3876a6816b25537ea0ee74440b6cc3f4ae21b44559f8b48a6eb07`; packaged `self_check.py --offline` PASS/exit 0 у агента и root. Root прочитал фактический результат; локальные токены, шрифтовые fallback и offline/static режим соблюдены.
- Собственные/адаптированные файлы проходят `git diff --cached --check`. Общий default check имеет exit 2: 1342 исходных whitespace/CRLF warnings в 19 побайтово неизменённых upstream файлах; raw log и классификация сохранены. Чужие байты не переформатировались.

Протоколы, audit runner и fixtures сохранены в `/workspace/scratch/design-skill-checks/`: `ui-upstream.log`, `smoke-results.json`, `*.stdout`/`*.stderr`, `diff-check-upstream.log`, `diff-check-summary.json`, `forward/`. Upstream read-only checkouts — `/workspace/scratch/design-skill-sources/`. Они не входят в commit и не загружаются при использовании навыков.

## Пределы и блокер

bwrap preflight завершился до запуска payload: `setting up uid map: Read-only file system`. Эскалация и обход не выполнялись. Проверки использовали disposable fixtures, Python audit guard и resource limits; это не доказательство отдельного OS sandbox. Python Playwright уже есть в окружении; Chromium availability/launch и PNG rendering не проверялись, ничего не устанавливалось. Browser rendering/геометрия/fallback metrics, motion, личные profiles, website onboarding, Windows/device и полная upstream maintainer suite не проверены. Скопированные examples по-прежнему содержат upstream Google Fonts/иногда motion; они не открывались, для нового вывода требуется overlay/удаление внешних ресурсов/`--offline` check.

Frontend/backend tests, types, lint и build в этой задаче не запускались: приложение и его зависимости полностью неизменны. Предыдущий продуктный checkpoint сохранён в истории: `git show d89979974fc7e7fc9b38e2aafea45fed644b4209:session-handoff.md`; эта установка не принимает и не закрывает прежние WP.

Текущий этап заканчивается одним локальным commit. Push ветки в `origin` и создание PR в `bairasbai/tili-tili` запрещены родительским поручением из-за незавершённой проверки полномочий. Не пытались повторять эти операции; исходящий GitHub write, merge и deploy не выполнялись. Следующий шаг — передать parent локальный SHA/ветку/эту сводку; публикация только после снятия родительского блокера. Своих DB/Redis/dev-server/browser процессов нет; worktree/ветка и доказательства сохраняются для продолжения.
