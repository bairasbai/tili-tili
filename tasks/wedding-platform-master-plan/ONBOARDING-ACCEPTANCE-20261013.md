# Онбординг: функциональная приёмка с ограничением

13 октября 2026 Александр прямо принял онбординг по сохранённым данным V14 с известным исключением. Это отдельная приёмка владельцем; историческая строгая корреляция не получила PASS.

Принят только scope онбординга: `App.tsx`, `index.css`, `lib/api/legal.ts`, `lib/consent.test.tsx`, `lib/i18n.ts`, `pages/Account.tsx`, `pages/Onboarding.tsx`, `lib/onboardingDeparture.test.tsx`, `lib/onboardingLanguageHealth.test.tsx` в `Тили-тили/app/src`. Исторический источник: 795 файлов, SHA256 `A8A0619825BB440CA6F96768C87D09CE774E78C4866F32913E10BB02FBD20A02`. Новый полный или браузерный прогон не выполнялся.

Сохранённые доказательства:

- [Штатный полный gate](C:/Тили-тили/.unlazy/wp03-onboarding-20261010/ROOT-ONBOARDING-FULL-QUALIFIED-v5.json): 6046 = 2637 frontend + 3409 backend, все 8 стадий PASS, sourceEqual=true. Это результат исторического источника, не нового коммита или интеграции с main.
- [Сбор данных V14](C:/Тили-тили/.unlazy/wp03-onboarding-20261010/ROOT-V14-COLLECT-ALL-AUDIT-v1.json): завершены 96 сочетаний RU/EN × 320/390/480 × 4 сцены × online/offline × normal/reduced; 1080 held-нажатий, 1176 PNG. Строгий результат остаётся AUDIT_INCOMPLETE.
- [Сохранённый просмотр оригиналов](C:/Тили-тили/.unlazy/wp03-onboarding-20261010/ROOT-V14-ORIGINAL-VISUAL-READBACK-v1.json): 49 × 24 = 1176 оригиналов; ROOT не заметил проблем раскладки. Повторный просмотр не выполнялся.

**Разрешённое исключение:** native row 756 — единственный `GET /legal/policy`, HTTP 200, без Authorization и Cookie, без доказанного соответствия браузерной фазе. В сохранённой таблице 1417 native-записей и 1416 browser-запросов. Инициатор не установлен; я не могу это подтвердить. Владелец принял именно этот пробел проверки, а не доказательство происхождения запроса. [Исходная диагностика](C:/Тили-тили/.unlazy/wp03-onboarding-20261010/ROOT-V14-PUBLIC-PHASE-CORRELATION-DIAGNOSTIC-v1.json).

[Отдельная исправленная диагностика](C:/Тили-тили/.unlazy/wp03-onboarding-20261010/root-diagnostic-v14-v2/actual-correlation-result.json) убрала зависимый TypeError, сохранила первичный отказ, посетила все 1417 записей и явно пропустила три зависимые проверки. `inputsUnchanged=true`, `qualification=false`, `wholeAcceptance=false`. Исходные V12–V14, FAILED_POSTCOLLECTION и неизвестный child exit не переписаны.

Публикация этого scope разрешена после проверок; окончательный scoped diff, CI фактического коммита и обычное слияние проверяются отдельно. Production deployment не разрешён. Полный WP00, SC-004, PWA и весь продукт этой приёмкой не закрыты. Полных пакетов WP00–WP16: 0/17; 17 = 16 − 0 + 1.
