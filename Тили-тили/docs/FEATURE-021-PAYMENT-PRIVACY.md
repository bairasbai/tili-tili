# Feature 021 — способы оплаты и приватность платежей подрядчикам

Feature 021 расширяет существующий finance core 018-A/B. Источник истины остаётся таблица payments; отдельной системы cash/transfer/card нет.

Каждая новая запись хранит payment_method (cash, bank_transfer, card, other), visibility (private, finance_members, vendor), amount_known и фактическую календарную дату paid_on. Безопасный default — private. Старые строки мигрируются как other/private/known, потому что исторический способ оплаты достоверно вывести нельзя.

## Неизвестная сумма

amount_known=false хранится как amount=NULL, никогда как 0. Поэтому существующие SUM-выражения считают только известную нижнюю границу, а API добавляет unknownAmountPayments и amountIncomplete. Неизвестная сумма не уменьшает числовой остаток и не закрывает долг автоматически.

## Права

Wedding finance endpoints сохраняют RBAC 018-A/B: helper/coordinator/vendor не получают финансовые права автоматически. finance_members поэтому сейчас не расширяет фактический круг чтения за роль couple.

visibility=vendor раскрывает запись только vendor собственной сделки через vendor-scoped endpoints. Все запросы связывают текущий vendorId с dealId; receipt content дополнительно связывает paymentId, receiptId и wedding. Чужая или архивная сделка отвечает безопасным 404.

Новые private и finance_members записи не входят в vendor payment list, receipts, analytics и totals. Старые строки мигрируются в private, поэтому после 021 они также не раскрываются vendor автоматически; это намеренно безопаснее, чем угадывать историческое согласие.

Исправление аудита 2026-09-30: slot/pay использует тот же private default, что и payment schedule. Колонка legacy_vendor_visible сохранена для совместимости схемы, но больше не читается как право доступа и не выставляется новым кодом. Уже созданные private/finance_members строки с этим флагом также исключены из всех vendor sums; переносить их в vendor без явного согласия нельзя.

Кабинет подрядчика показывает только раскрытые суммы. unknownAmountPayments / amountIncomplete / revenueIncomplete сопровождаются предупреждением в карточке, списке и аналитике. Процент изменения дохода отсутствует, если суммы неизвестны хотя бы в одном сравниваемом периоде. В карточке доступны дата, способ, статус платежа и скачивание его подтверждений через vendor-scoped endpoints.

## Подтверждения

Существующая payment_receipts не дублируется. Cash не требует receipt, но может использовать тот же upload/download/delete flow. Ограничения MIME/signature/quota/hard erase 018-B сохраняются.

## API и миграция

OpenAPI: 0.52.1. Поля неполноты vendor responses включены в контракт. Generated backend/frontend artifacts создаются штатными generators.

Forward migration: 1761700000000_payment_methods_privacy. Production migrations 018 не изменяются. Populated rollback 021 запрещён: pre-021 код не знает visibility и мог бы расширить доступ.

## Проверки

Definition of Done включает migration rehearsal, backend/frontend typecheck/lint/build/full suites, payment browser E2E, 019/020/task regressions через полный CI, IDOR, idempotency, concurrency, 152-ФЗ export и hard erase.
