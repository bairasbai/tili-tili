# Feature 021 — способы оплаты и приватность платежей

## Scope

Feature 021 расширяет существующий finance core 018-A/B. Источник истины остаётся один:
`Wedding → Deal → payment_installments → payments → payment_receipts`.
Отдельной cash-транзакции, отдельной таблицы или отдельного cash endpoint нет.

## Payment model

`payments.payment_method`: `cash | bank_transfer | card | other`.

`payments.visibility`: `private | finance_members | vendor`.

`payments.amount_known`: `true | false`.

При `amount_known=false` поле `amount` равно SQL `NULL`. Ноль не используется как
маркер неизвестной суммы. Поэтому существующие SUM-агрегаты считают только известную
нижнюю границу, а API одновременно возвращает `unknownAmountPayments` /
`amountIncomplete`.

`paid_on` — фактическая календарная дата оплаты. Feature endpoint записывает её
явно; legacy/internal writers получают совместимый DB default.

## Privacy semantics

* `private` — финансовые wedding endpoints остаются доступны только текущей роли
  `couple`; helper/coordinator не получают новых прав.
* `finance_members` — зарезервированная семантика для существующей finance RBAC.
  В текущей RBAC 018 finance-role — только `couple`, поэтому эта видимость сейчас
  не расширяет доступ helper/coordinator.
* `vendor` — подрядчик видит только payment своей собственной deal. Vendor endpoints
  дополнительно фильтруют `deal.vendor_id = currentVendor` и `visibility='vendor'`.
  Private/finance_members не участвуют даже в vendor paid/revenue aggregates.

Receipts не дублируются. Existing `payment_receipts` используется и для cash, и для
transfer/card; файл необязателен для любого способа, включая cash. Vendor получает
receipt metadata/content только у vendor-visible payment своей deal.

## Unknown amount arithmetic

Факт оплаты без суммы:

* не уменьшает числовой остаток deal/installment;
* не считается как 0;
* не закрывает этап;
* не увеличивает точную сумму фактических расходов;
* выставляет `amountIncomplete=true`;
* UI показывает известную сумму как «от …» и предупреждение о неполноте.

## Migration

Forward migration: `1761700000000_payment_methods_privacy`.

Старые rows сохраняются как:

* `payment_method=other`;
* `visibility=private`;
* `amount_known=true`;
* `paid_on` = исторический `created_at`, преобразованный в timezone свадьбы.

Исторический method не выводится из `kind` или `provider_ref`: это было бы
недоказуемым предположением.

Rollback на populated `payments` запрещён, потому что pre-021 код не понимает
privacy discriminator и откат мог бы расширить доступ. Empty/disposable DB rollback
поддерживается и проверяется rehearsal.

## Contract

OpenAPI: 0.52.0. Generated backend schemas/types/paths и frontend schema генерируются
штатными scripts; generated files вручную не редактируются.

## Audit / export

`payment.recorded` пишет структурированные поля: payment entity id, dealId,
installmentId, paymentMethod, visibility, amountKnown, paidOn, version и amount только
когда сумма известна. Свободный комментарий feature не добавляет и в audit log не пишет.

Financial CSV и owner 152-ФЗ export включают новые поля. Helper/coordinator export
по-прежнему не содержит payment rows.

## Security invariants

1. Vendor A не может прочитать deal/payment/receipt Vendor B.
2. Подстановка случайного/чужого dealId даёт safe 404.
3. Подстановка paymentId/receiptId другой сделки не раскрывает объект.
4. private/finance_members не текут в vendor list, paid, expected, shortfall или revenue.
5. Archived wedding скрыта от vendor payment endpoints.
6. Deleted user не проходит auth.
7. Wedding finance routes по-прежнему запрещены helper/coordinator/vendor membership.

## Verification

Definition of Done проверяется CI и специализированными tests/rehearsals. Merge
разрешён только после зелёных backend/frontend suites, migration rehearsal, browser
payment E2E и regressions 017/019/020.
