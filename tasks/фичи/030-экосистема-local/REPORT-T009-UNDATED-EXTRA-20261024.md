# T009 · дополнительное мероприятие без выбранной даты

База: main `d6135d40` после PR78. Ветка `codex/wp04-t009-continuation-20261024`. Это ограниченный этап T009; полный T009/374 остаётся OPEN. Production не затрагивается.

## Поведение

Для дополнительного мероприятия можно забронировать исполнителя из каталога, пока дата не выбрана, если у мероприятия есть собственный известный часовой пояс. Запрос передаёт точные `id`, `date: null`, `timeZone`; подстановки даты или часового пояса основной свадьбы нет. Такая бронь не создаёт физическую DATE и не подтверждает доступность исполнителя на будущий день.

Снимок предложения сохраняет семь полей мероприятия, включая дату со значением NULL. Историческое отсутствие снимка допустимо только для основного мероприятия. Новый внешний исполнитель без даты, неизвестный часовой пояс и неподдерживаемый сложный состав получают отказ.

Первая дата уже забронированного дополнительного мероприятия назначается через согласование. Каждая сторона читает условия своего заказа и подтверждает их; для двух заказов нужны четыре согласия. Последнее согласие не применяет перенос. Пара отдельно нажимает применение, после чего одна транзакция создаёт новые версии и DATE. Старые версии, цены, платежи, фиксированные сроки оплат, основное и соседнее мероприятия сохраняются.

Источники: `backend/src/deals/program-event-context.ts`, `backend/src/deals/day-scope-write.ts`, `backend/src/deals/book.ts`, `backend/src/deals/replace.ts`, `backend/src/routes/deals.ts`, `backend/src/orders/event-moves.ts`; OpenAPI `0.72.9`, `EventMoveFrom.date` nullable. Четыре generated-файла обновлены штатными генераторами. UI: `app/src/lib/slotEventContext.ts`, `app/src/components/OfferAcceptance.tsx`, `app/src/components/EventMoveReview.tsx`, Search/Smart/Wedding; карты экранов и кнопок обновлены.

## Миграция и границы отката

Forward93 `1763910000000_additional_event_undated.cjs` после первого фактического UP неизменна: SHA256 `4FF66E47B92954A8DCA6D430925143727B99FC3FD54376FEB24A4B96E6CC59D4`. UP заменяет тела шести функций; 112 старых таблиц и OID/метаданные 441 функции сохранены. DOWN консервативно отказывает при недатированных данных, NULL в снимке предложения либо любой истории/аудите переноса. Совместимый откат заполненной базы здесь не заявляется.

Preserving drill прошёл с настоящими SQL23514 и ожиданием AX/55P03, шестью UP, двумя пустыми DOWN и четырьмя защищёнными DOWN. Его проверка заполненной истории использовала прежний audit; отдельное новое переносное history в этом блокере не тестировалось. Сохранность таблиц, функций и scoped cleanup проверены независимо.

## Проверки текущего кода

Доказательства вне временной копии: `C:/Тили-тили/.unlazy/wp04-t009-continuation-20261024` (далее E).

| Проверка | Фактический результат | Доказательство |
|---|---|---|
| Новые native-интеграции | 49 + 23 = 72 PASS, 0 skipped; SQL rollback/deferred COMMIT, ACL, удержанные блокировки, retry, общий DATE с тремя holders | `E/NATIVE72-V2-ROOT-QUALIFIED.json`, независимое `NATIVE72-V2-INDEPENDENT-ACTUAL-REVIEW.md` |
| Admission unit | 253 PASS / 5 файлов, 0 skipped | `E/ADMISSION93-UNIT-VITEST.json` |
| Прежние affected регрессии | 67 + 119 + 10 = 196 PASS / 3 файла, 0 skipped; backend types/lint/build прошли | `E/REGRESSION196-ROOT-QUALIFIED.json` |
| Основное мероприятие без даты, замена | Прежний отказ сохранён, 1 PASS; 72 других отфильтрованы и не заявляются прогнанными | `E/run-compiled93-admit-v2-e8f4a854-eaf0-450d-8f36-51b16cb5074a` |
| Весь фронтенд | 3052 PASS / 143 файла, 0 skipped; types/lint/build прошли; отдельные 77 targeted PASS | `E/FRONT-FULL-ROOT-QUALIFIED.json`, независимое `UNDATED-UI-V2-INDEPENDENT-ACTUAL-REVIEW.md` |
| Preserving drill93 | Native exit0 и оба EOF, scoped cleanup и сохранность подтверждены | `E/run-drill93-host-48d0ed68-06d5-475c-92fe-35689ff9deba`, независимое `DRILL93-INDEPENDENT-ACTUAL-REVIEW.md` |
| Настоящий compiled TCP | 14 фаз PASS, 172 HTTP с EOF, 80 private/no-store ответов; старые датированные сценарии и первая DATE из NULL | `E/COMPILED93-TCP14-INDEPENDENT-ACTUAL-REVIEW.md` |

Локальный полный backend-прогон **FAILED и прерван**, успешным не считается: отсутствовал Git `sh` в PATH, две прежние admission-проверки ещё запрещали journal93. PATH уточнён, только закрытые списки этих двух guards расширены до93, тела прежних тестов сохранены; affected196 прошли. Полный backend требуется отдельно на итоговом SHA в CI. Локально использовался Node24.19, CI закрепляет Node22.

Старые public U0/shape92/первые native72/FE/два drill и частичный backend FAILED сохранены вместе с данными и raw-логами. Исправление причины подтверждается новым отдельным запуском; старый результат не переименовывается в PASS.

CI head11734e6 завершился **4143PASS+2FAIL=4145/172 файла**: audit53 не узнавал inherited/delegated wait двух новых серийных файлов, audit55 ожидал0.72.8 при опубликованной0.72.9. Bounded errors: `E/CI79-11734e6-FAILED-ERROR-SUMMARY.txt`. Исправлены только эти два tests; independent SOURCE GO `E/CI79-AUDIT53-55-INDEPENDENT-SOURCE-REVIEW.md` SHA7C3076A6. Focused **31PASS=30audit53+1version audit55**,46 прочих audit55 отфильтрованы и UNRUN; types/lint0 (`E/CI79-AUDIT53-55-ROOT-QUALIFIED.json`). Это не новый full backend/CI. Fixes и текущие docs ещё uncommitted, PR79 остаётся DRAFT на11734e6.

## Браузер и поставка

Александр разрешил ровно две локальные галочки входа после сохранённого исторического автоматического отказа. В newRUN47ba755a-2993-4659-aec8-4438029c1ec2 Cua выполнил обычный OTP login пары кодом6543; product source/dist прежние. Настоящий explicit UIapply proposal01a16dd1-28c6-7323-83db-25e373a9656c к event01a16db6-152a-7722-a41a-4a4a99797dee показал DOM/screenshot «Перенос применён»:2027-07-20/Asia/Vladivostok/Synthetic browser first DATE venue. Четыре прежних реальных receipts (3actors/2roots) сохранились. `E/browser93-resume2-pre-DATABASE.json` и `browser93-resume2-applied-DATABASE.json` —112raw read-only snapshots, effects0→1/receipts4→4; независимый ACTUAL compiled_review ещё ожидается. Прежние four/blocked checkpoints сохранены и не выдаются за результат apply.

OTPcleanup завершён штатным COMMITtrue. Первый безопасный connect/idlepool0 отказ без мутаций сохранён; после readiness200 неизменённый helper успешно повторён. Parent cleanup native24632/exit0/EOF2 (`E/run-compiled93-resume2-cleanup-96b265db-a96e-42c3-90c0-19fe855f2a7b`) зафиксировал111nonAuditbaseline restored/audit retained/cleanupCommitted=true/finalSeal=true; независимая проверка ожидается. Это Root native результат, не преждевременное ALLMET.

Root штатно закрыл new47ba API22368/Web35476 native0/EOF2/nonce-stop и PG23212/Redis31152 CLI0. `E/RESUME2-OWN-SERVICES-CLOSED-VERIFIED.json` подтверждает PID/children absent, порты15432/56379/57297/57298free, ownbrowserlist=[]; удалён только свой Redisv3 config-only dir (`RESUME2-REDIS-TEMP-CLEANUP.json`), PGdata сохранены. Fresh nine-DB read-only retention native33272/0EOF2 выполнен до shutdown (`ACCEPTED-RETENTION93-SUMMARY.json`); независимый review ещё ожидается.

Следующий шаг Root: завершить независимые ACTUAL reviews, scoped commit двух test fixes+docs и push, затем полный current-head CI/backend/FE/native49/drill/остальные mandatory checks; после G4+G5 — обычный merge, проверка main и normal WT cleanup. Поставка подтверждается только итоговым `E/PUBLICATION-UNDATED-EXTRA-FINAL.json` с привязкой к feature SHA, attached PR, current-head CI, обычному merge и дереву main. PR79 не слит, ALLMET/worktree cleanup не заявлены. ПолныйT009/374 OPEN; production, ALLoldFAILED/audit/PGdata/foreignWT не затронуты.
