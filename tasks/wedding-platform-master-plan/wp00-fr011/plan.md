# FR011 · технический план и ворота инвариантов

Решения исходной спеки перенесены сюда по циклу крупной фичи; эта запись не является новым runtime PASS.

# WP00 · FR011: исправление ручных отметок и история

Требование: [FR-011 общего ТЗ](../spec.md). База — main406d5e7e091c737228995e7657a89bd926c653ca после [PR50](https://github.com/bairasbai/tili-tili/pull/50). Это следующий участок WP00; полный WP00–WP16 остаётся целью.

## Проверенное основание

График уже поддерживает этапы/сроки/суммы/частичные отметки и привязку платежа к этапу. PaymentSchedule предлагает привязку и документы, но не исправление сохранённой суммы/даты/способа оплаты. PATCH этапа перезаписывает title/amount/due; текущий audit не сохраняет прежние названия и не является доступной паре историей исправлений. [Аудит источников](C:/Тили-тили/.unlazy/wp00-fr002-20261007/FR011-MONEY-SEMANTICS-REVIEW.md).

Это source findings, не runtime PASS новой функции. Ранее отсутствовавшие редакции/авторов/даты не восстанавливать из предположений.

## Результат и границы

1. Пара исправляет ту же ручную отметку, видит исходные и исправленные сведения, причину, автора и время, перечитывает фактический итог. Исправление не создаёт второй payment и не запускает перевод денег.
2. Новый writer доступен current couple своей неархивной/неотменённой свадьбы, для сделки booked/paid_deposit/done с известной положительной ценой. Валюта и сделки, и payment должна быть RUB: новые writers не конвертируют и не переписывают legacy валюту. Отметка должна иметь status recorded, provider_ref NULL, kind deposit/balance. Это ограничение writer; provider_ref сам по себе не доказывает подтверждение банка. confirmed/refund/cancelled/provider-linked остаются read-only для исправления.
3. PATCH /weddings/{weddingId}/payments/{paymentId} получает полное намерение: текущую целую version, amountKnown, amount:Money|null, paidOn, paymentMethod и непустую после trim причину до500символов. Неизвестная сумма — null; известная — положительное безопасное целое число копеек. Сырые типы проверяются до AJV coercion. Дата использует существующие границы 2000–2100.
4. ID/deal/kind/status/currency/createdAt/installment/visibility/provider_ref сохраняются. Документы остаются на прежнем payment ID и не изменяются. Privileged vendor/helper projections не получают частную причину/старые значения. Привязка к этапу остаётся существующим отдельным /plan.
5. При изменении денежного вклада projectedDeal=PAID_SUM−old+next должен быть в0..price; linked projectedStage=paid−old+next в0..stage.amount. Refund учитывается с прежним отрицательным знаком, unknown не уменьшает долг. Нейтральная по деньгам правка даты/метода может сохранить прежний legacy итог вне этих границ, но не меняет суммы. Unsafe числовые значения отказываются сериализоваться. Нового глобального ограничения для всех legacy/refund writers нет.
6. Любое реальное изменение payment tuple поднимает общую plan_version ровно один раз, включая дату/метод. Существующий arithmetic trigger этапов сохраняется: изменение суммы влияет на stage paid/version, metadata-only не меняет арифметику. Версия ограничена2147483647; исчерпание проверяется до записи. No-op не создаёт историю/audit/version, но требует текущих прав/eligibility.
7. Доступна история payment corrections и реальных существующих правок title/amount/due/cancelled этапов. Хранятся фактические before/after и версии, автор, время; причина новой payment correction обязательна. У старого stage editor отсутствующая причина остаётся null. Создание/платёж/перепривязка не выдаются за исправление этапа. Прежних потерянных названий/редакций не придумывать.
8. GET /weddings/{weddingId}/payments/{paymentId}/history и GET /weddings/{weddingId}/payment-schedule/{installmentId}/history — couple-only, стабильная пагинация и свежий доступ. Финансовую историю cancelled wedding/deal можно читать, новая запись в отменённую свадьбу запрещена. Удалённый автор показывается без выдуманной личности; имя/телефон не копируются в бессрочный снимок.
9. Новая scoped immutable история имеет native scope constraints, допускает законное FK-null автора и удаляется только вместе со свадьбой. Upgrade сохраняет прежние строки/версии/приватность; down с историей отказывается терять записи. Account export пары включает исправления, erase одного партнёра сохраняет историю наследника без личности, whole-wedding purge удаляет её своим каскадом.
10. Writer использует wedding→principal/session/consent→member→deal→payment/stage locks, атомарные update/history/audit/idempotency. Replay требует текущего доступа и не выполняет действие снова; после реальных ожиданий/receipt UPDATE проверяется JWT. После COMMIT новый авторизованный read получает актуальную разрешённую проекцию. Отказ ответа после COMMIT не отменяет запись и не освобождает успешную receipt. Stale version —409 с перечитыванием и явной проверкой черновика.
11. UI сохраняет точное намерение/ключ при потерянном ответе, не переносит частный черновик/историю в другую свадьбу/сессию/роль. Текущие суммы и unknown показываются из финансовой проекции. deal.state/price/бронь/календарь/ресурсы не меняются, в том числе paid_deposit при unknown/net0; ручная отметка и документ не называются подтверждённой банковской операцией. RU/EN и320/390/480 проверяются фактически.

Отмена/void платёжной отметки, выполнение refund, settlement/provider flow, изменение цены/брони и весь WP12 в этот участок не входят. Отдельный CSV исправлений не заменяет UI/account export и не обязателен в этой поставке.

## Приёмка

Сначала actual RED отсутствующего исправления partial mark/reload/before-after и истории существующей правки этапа. Затем реальный HTTP/PG GREEN: metadata/known-null/version, caps/refunds/alternate slot-pay/link races, idempotency/no-op/stale, роли/сессия/consent/JWT после wait и post-COMMIT revoke, rollback/update/history/audit/receipt atomicity. Обязательны reviewed native clean/populated upgrade/down/cascade preservation, fresh source review, полный init.sh и актуальный built browser/native с просмотром PNG, документы и отдельная публикация/CI/main. Наличие этого проекта ничего не принимает; полных WP подтверждено0/17.

## Два дефекта полного прогона v2

Новые таблицы увеличили currency count17→19; сохранённая migration383 содержит RUB CHECK с автоматическими именами. Отдельная ordered383500 migration только переименует2CHECK после точной structural проверки, не меняя данные/функции/определения/OID. Её inverse down также сохраняет историю; lossy383down остаётся защищён. T1/T3 должны проверять все19 таблиц, не только исторические15probes. Второй failure — строковый предикат receipt UPDATE в paymentCorrections тесте безWHERE; требуется полное совпадение реальной scoped SQL без ослабления audit53. Выполнение этих исправлений и повторный полный/browser/CI остаются открытыми.
