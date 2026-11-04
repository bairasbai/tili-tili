# Исправления аудита PR81–83 · 4 ноября 2026

Поручение: исправить три подтверждённых P2, добавить регрессии, выполнить проверки и обычное слияние без дополнительных подтверждений. Production запрещён. Старые FAILED и аудит не меняются. До реализации изучена параллельная PR84; работа ведётся в отдельном дереве от её кандидата b2cec15. Слияние исправлений — после PR84 и сверки main.

## Поведение

1. Terms GET, публикация и принятие schema1/2/3 завершаются только после повторной проверки access JWT внутри TX. Cached POST replay проходит тот же финализатор. Истечение во время фактического native wait даёт401 и не сохраняет terms/audit/idempotency изменения; отдельный read-token не заменяет access JWT.
2. Forward98 меняет только последний широкий predicate `legacy_calendar_bounds_assert_adopted`: исторические released rows не обязаны принадлежать текущему событию. Exact current certificate/event/reason/proof/head/same-TX checks остаются буквальными; любой оставшийся live alias того же holder/vendor запрещает COMMIT. UP меняет только одно тело функции; DOWN возвращает literal95 definition. Миграции1–97 byte-immutable.
3. Actual owner компании выступает performer, даже если он couple. Общий OrderContext не меняется. Один user/session не получает противоположное согласие; старые receipts сохраняются. Ошибочная старая customer-подпись owner исправляется новой явной публикацией с обычным CAS и новым ключом: canonical/digest могут совпасть, согласия не переносятся. После восстановления обычный same-material no-op сохраняется.

Третье исправление включает существующий terms reader schema1/2: actorRole каталога не скрывает performer-действие владельца после customer-согласия другого участника. Валидированный owner UUID snapshot и локальные user/session UUID используются только для отображения; серверная авторизация неизменна. Свой receipt закрывает повторное/opposite приглашение; старый owner-customer восстанавливается только явной новой редакцией и новым deliberate read. Unknown actor и неподдержанная schema не дают принять. Новая форма API и UI372/schema3 не добавляются.

## Приёмка

- Старый продукт: actual RED8 = пять JWT doors/replays + V1→V2→adopt + dual role + исторический self-receipt. Setup/migrations успешны; 29 прежних случаев были отфильтрованы и не объявлялись пройденными. E/RED97-VERIFIED.json содержит raw sources/results/dump refs; retained БД `tili_pr8183_audit_red97_test` не используется дальше.
- GREEN обязан включать эти случаи, recovery edition и native ALIAS COMMIT-negative: disjoint real July alias остаётся при staged domain success, затем exact SQL23514 и whole rollback.
- UI-остаток закреплён meaningful RED5 на неизменённом OrderTerms0dc (87 прежних тестов были filtered), затем6новыми регрессиями и полным текущим frontend. Native browser компонента со syntheticHTTP отдельно проверяет owner+couple, явное восстановление без унаследованного согласия и другого actor/закрытие старого reader; это не настоящий backend/согласия людей.
- Целевые39 adoption cases, смежные bounds/lifecycle/terms regressions; SOURCE closed98 admission с unknown99/tamper/missing/lower-kind refusals; preserving97→98 up/repeat/down/reup с exact old rows/catalogue/OID/ACL.
- Два обязательных preserving результата: полный общий drill на empty и populated finance/allocation/mirrors; отдельно97→98→DOWN→UP на клоне настоящей сохранённой RED97 с V1/V2, superseded occupancy и live certificates. Оригинал RED97 подключается только read-only для полного before/after сравнения; его dump hash неизменен. Первый drill40 FAILED из-за неверного предположения о составе общего populated fixture сохраняется; исправленный общий drill использует другую новую БД39.
- Полные backend/frontend и требуемые browser CI на итоговом SHA, независимые SOURCE/ACTUAL, обычный merge после PR84, фактическая проверка parents/tree и уборка только собственных ресурсов.

Текущее состояние проверок и невыполненные гейты: `C:/Тили-тили/.unlazy/pr81-83-audit-fixes-20261104/GATES.md`. Частичные зелёные результаты не означают, что этап уже слит. UI372,373/374 и полныйT009 этим исправлением не закрываются.
