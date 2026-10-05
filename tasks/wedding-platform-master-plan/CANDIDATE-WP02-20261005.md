# Именованные семьи в импорте · WP02 · 2026-10-05

Кандидат подготовлен вне полного checkout. Полный init.sh, Vitest/React, PostgreSQL/Redis, браузер и GitHub CI НЕ ПРОГНАНЫ. Не считать feature/WP принятым; main и production не менять.

## Изменения

Гости, «Добавить списком»: вставка → явный редактируемый preview приглашений. Основной человек + до 9 именованных персон; legacy +1 преобразуется в имя только явным действием. Счётчики приглашений/персон раздельны, серверный partySize не угадывается. Частичный ответ оставляет пропущенные и локально невалидные строки. Панель сохраняется при закрытии в той же свадьбе, размонтируется по key при смене свадьбы.

«Проверить и дополнить» фиксирует локальный draft; добавить/удалить человека меняет payload будущего POST; «Указать имя вместо +1» снимает legacy-флаг; «Убрать приглашение» исключает строку; возврат к вставке требует подтверждения сброса. «Импортировать приглашения» → importGuests → POST /weddings/{weddingId}/guests/import, ответ проходит reconcileImportResponse, затем reload. Ввод и повторная отправка блокируются на время запроса. «Закрыть» сохраняет draft; подтверждение успеха только по полному ответу.

## Проверка

Исходная база 7c0cb5b60243e135bbc172b1b924eed4e61dd783. В поставляемом пакете: исполняемый node:test набор для чистых модулей и фактические логи, строгая TypeScript-проверка этих модулей. Это не прогон приложения. Authored Vitest-файлы требуют реального выполнения в проекте. Не переносить PASS старых PR на этот код.

## Перед коммитом/PR

Проверить итоговый diff и переводы, выполнить полные гейты по CLAUDE.md на финальном дереве, затем отдельный feature commit. Публиковать только отдельную ветку/PR без auto-merge. Владелец сливает самостоятельно.


## Publication gate, 2026-10-05

Workflow: https://github.com/bairasbai/tili-tili/actions/runs/37296979740, attempt 1. The full checkout frontend TypeScript, complete Vitest suite, ESLint and production build passed before this candidate commit was created. The immutable pre-gate file manifest and logs are workflow artifacts. Earlier UNRUN statements above describe preparation history. Backend/PostgreSQL/Redis, real browser/mobile acceptance and exact-head PR CI are still unverified by this helper. This remains a candidate, not whole-WP acceptance. No main merge, auto-merge or deployment.
