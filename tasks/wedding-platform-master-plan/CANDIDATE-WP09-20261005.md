# Ближайшие задачи по срокам · WP09 · 2026-10-05

Кандидат подготовлен вне полного checkout. Полный init.sh, Vitest/React, PostgreSQL/Redis, браузер и GitHub CI НЕ ПРОГНАНЫ. Не считать feature/WP принятым; main и production не менять.

## Изменения

Главная, блок «Ближайшие дедлайны»: до трёх открытых задач, известные календарные сроки по возрастанию; неизвестные и неверные после них. При равных сроках сохраняется серверный порядок. Имя ответственного показывается только из ответа API. Ошибка/загрузка не становятся пустым списком. Ссылка и карточки ведут в /wedding/checklist.

Карточка задачи → navigate(/wedding/checklist); «Чек-лист →» → тот же существующий маршрут. Новых API-запросов и мутаций нет. Имя/срок входят в доступное имя кнопки; дата размечена time.

## Проверка

Исходная база 7c0cb5b60243e135bbc172b1b924eed4e61dd783. В поставляемом пакете: исполняемый node:test набор для чистых модулей и фактические логи, строгая TypeScript-проверка этих модулей. Это не прогон приложения. Authored Vitest-файлы требуют реального выполнения в проекте. Не переносить PASS старых PR на этот код.

## Перед коммитом/PR

Проверить итоговый diff и переводы, выполнить полные гейты по CLAUDE.md на финальном дереве, затем отдельный feature commit. Публиковать только отдельную ветку/PR без auto-merge. Владелец сливает самостоятельно.


## Publication gate, 2026-10-05

Workflow: https://github.com/bairasbai/tili-tili/actions/runs/37294757779, attempt 1. The full checkout frontend TypeScript, complete Vitest suite, ESLint and production build passed before this candidate commit was created. The immutable pre-gate file manifest and logs are workflow artifacts. Earlier UNRUN statements above describe preparation history. Backend/PostgreSQL/Redis, real browser/mobile acceptance and exact-head PR CI are still unverified by this helper. This remains a candidate, not whole-WP acceptance. No main merge, auto-merge or deployment.
