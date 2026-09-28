# REVIEW — stage 019 / post-merge audit

Дата: 2026-09-28.

Проверяемая поставка: PR #5, head `38a34e10f839bda9a9c5289287f5925b3b3a087f`,
merge `027d6c3eb76e6a31c4ecd8b73c0376a910bd488d`.
Дальнейший `main` до `75bda05ffb0045fd85b2a55969ed79877cdbbb03` менял только документы 019/roadmap,
production-код 019 между этими точками не менялся.

## Проверено

- RBAC shortlist / offer requests / accept и сокрытие сумм от helper/coordinator.
- Lock ordering и конкурентные сценарии reply/accept/booking/delete.
- Идемпотентность batch request, ответа подрядчика и accept.
- Rollback при `vendor_unavailable` / занятой дате.
- Immutable snapshot условий сделки.
- Перенос/отмена свадьбы и закрытие открытых запросов.
- Hard erase, tombstone и export isolation.
- Clean-integration CI и browser E2E PR #5.

Подтверждено, что merge commit PR #5 и проверенный head имеют одинаковый Git tree:
`306c4c06312cd45038bd895f5dd20a2475ef9b34`.

## Найдено

### R019-01 — custom offer допускает пустой состав

Уровень: data-integrity / contract mismatch.

`FR-009` требует для собственного предложения цену и «что входит». UI уже требовал хотя бы один
непустой пункт, но контракт `OfferInput` допускал `includes: []` и строки из пробелов, а backend
сохранял `body.includes` без нормализации. Прямой API-клиент мог создать предложение без реального
состава; после принятия этот пустой состав попадал в immutable snapshot сделки.

Исправление:
- OpenAPI: `minItems: 1`, непустой содержательный item.
- Backend: trim/filter и дополнительный 422 guard.
- PostgreSQL regression: пустой и whitespace-only состав не создают offer/notification; валидные пункты
  сохраняются нормализованными.

### R019-02 — исторические номера контракта в tasks.md

Уровень: documentation only.

В истории задач 019 встречаются версии 0.46–0.49 feature-линии. Clean integration PR #5 намеренно
пересобрана на актуальном main и в слитом результате OpenAPI имеет версию 0.45.0. Исторические номера
не следует трактовать как версию текущего main; актуальное состояние зафиксировано в
`verification-finalization.md`.

### R019-03 — открытые superseded PR #4 и #6

Уровень: repository hygiene.

PR #4 и PR #6 относятся к старым/параллельным линиям 019. PR #6 прямо помечен handoff-документом как
superseded и не должен сливаться поверх main. Их состояние не менялось этим аудитом.

## CI-база до исправления

PR #5 / head `38a34e10`:
- frontend: 77/77 files, 1020/1020 tests;
- backend: 105/105 files, 1164/1164 tests;
- Offers 019 browser E2E: success;
- Task planning browser E2E: success.

Новый regression должен пройти в отдельном PR до слияния исправления в main.
