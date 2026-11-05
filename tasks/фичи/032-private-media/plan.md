# План 032

Две поставки: 032-A — шаги1–2 с независимым review/full/CI и уборкой; 032-B — шаги3–5 со всеми оставшимися migration/browser/owner gates6–7. Причина: права, квоты действующих POST grants, lease и outbox до cascade требуют общей приёмки; их нельзя включать по отдельности. Требования M01–M12 не сокращаются; до032-B сохраняется501.

1. Сначала зафиксировать M01–M12 и OSS/provenance; negative controls размера/типа/сканера/неполной конфигурации/сбоев S3.
2. Дополнить config (полностью выключено по умолчанию), bounded S3 transport и ClamAV INSTREAM, нормализацию растров. Не использовать credentials chain из окружения AWS автоматически; только явная собственная конфигурация.
3. Добавить следующую99миграцию: upload intent/state/lease, durable object cleanup, стабильную связь vendor_media. Прежние1–98SQL не меняются. Сохранить cleanup keys trigger-ом до cascade; повторный backfill/up/down проверить с данными.
   Безопасный откат: legacy seed98 → up99 → настоящий down98 → up99 с сохранением прежних IDs/URL/sort/photo_url. При любых данных новых таблиц down99 обязан отказать ДО DDL (`media_preserving_down_032`), сохранив строки, схему и pgmigrations. Такой отказ не называется успешным downgrade managed-данных; операторское восстановление остаётся отдельным гейтом.
4. Реализовать owner-only issue/status/complete/list/delete, текущий JWT после await, квоты и profile PUT; durable GC с nonce fence и обработкой потерянного COMMIT. Экспорт/erase — в том же этапе.
5. Единый OpenAPI/штатная генерация; UI портфолио; R-MAP/R-BTN/i18n/доменные документы и журнал. Независимый reviewer только читает, root исправляет подтверждённое.
6. Native targeted DB/service tests, source/migration audit99, types/lint/build, браузер на собственной production SPA, требуемые full checks и exact-head CI. Сохранить реальные ограничения SDK fixtures/provider/device gates.
7. Обычная согласованная поставка, актуальная17ведомость и handoff. Остановить только собственные ресурсы; удалить свою зарегистрированную worktree/сборки/зависимости после сохранения исходных байтов и необходимых FAILED/native доказательств.
