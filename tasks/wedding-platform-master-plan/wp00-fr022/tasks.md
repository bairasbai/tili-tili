# FR022: текущие задачи

База mainbaeb605/PR53, branchcodex/wp00-replacement-warning. Root owns product/tests/services/GitHub; [spec](spec.md).

- [x] Сверить свежую принятую main, handoff, конкретное требование и подтверждённый gap.
- [x] Подготовить scope/risks/checks; прежние guards/roles/rollback/retries сохранить.
- [x] Meaningful UI RED нового предупреждения (ошибка подготовки не считается RED).
- [x] Реализация RU/EN предупреждения/старой и новой стороны/пакета без новой команды или финансового обещания.
- [x] Targets/UI native privacy/concurrency/money preservation, types/lint/contract checks: UI205PASS без изменения app/OpenAPI/runtime; current native-target-v3 292PASS/0FAIL/0pending/source unchanged, types/lint0.
- [x] Independent review итогового source, fixture cleanup/scanner и browser harness/classifier: REVIEW-v1/BROWSER-REVIEW-v1/FIXTURE-REVIEW-v1 frozen/no blockers.
- [x] Actual init.sh итоговой версии: full-v2 5647PASS/all8/exit0/source3D unchanged.
- [x] Compiled browser/realAPI/PG/RUEN/sizes/errors/native rereads/owned cleanup/root14views: current13PASS/native exact/1046requests1045finished/one intentionalloss/zero unexpected errors,14actualPNG просмотрены; review-v3 no blockers.
- [ ] Docs/diff/commit/PR/exact-headCI/freshmain/merge/treeverify.

Предупреждение реализовано; conditional release исправлен по независимому review. UI205PASS/native77PASS (73PG+4generation); types/lint exit0. Current native292/full5647/browser13/root14views приняты; final commit/CI/merge ещё ожидаются. [Единственный текущий отчёт](REPORT-20261008.md). Полных WP0/17; остальные master FR/SC/NFR/A/U/M01/WP11/provider/device/human критерии сохраняются.
