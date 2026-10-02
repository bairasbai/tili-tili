# Задачи 022

- [x] T001 Прочитать источники/контракт/main; оформить spec.md, plan.md, tasks.md и внешний GATES.md, отправить опрос.
- [x] T002 Регрессия DELETE If-Match в app/src/lib/api/client.test.ts и типизированные app/src/lib/api/weddingEvents.ts; witness1fail → permanent regression passed.
- [x] T003 [US1] Реализовать app/src/pages/WeddingEvents.tsx, маршрут app/src/App.tsx и навигацию app/src/pages/Wedding.tsx.
- [x] T004 [US2] Проверить защищённые состояния/RU/EN в app/src/lib/weddingEvents.test.tsx и расширить route sweep app/src/lib/nomocks.test.tsx. Последний focused10files219pass.
- [x] T005 Выполнить свежий полный init.sh, actual browser, проверить скриншоты/569source hashes; записать REPORT.md. eventsfull3:1429frontend/1733backend/no skips/init0; eventsfinal1:9checks/zeroerrors/all11PNG inspected/source569match.
- [x] T006 Обновить Тили-тили/Тили-тили_Карта_экранов.md и Карту_кнопок.md, JOURNAL.md, ERRORS.md, session-handoff.md; commit/push/CI/main. PR25 merged04a8355/all7CI SUCCESS; local main clean/equal fetched origin/main/source569match. Внешнее подтверждение: .unlazy/wp04-events-ui-20261001/PUBLICATION-CONFIRMED.md.

## Зависимости И Продолжение
T001 → T002 → T003 → T004 → T005 → T006. Scoped MVP этой поставки = CRUD UI
после полной проверки и публикации, не завершённый этап022 или WP04.
Далее в этом же этапе: персональные приглашения/RSVP, логистика, остальные
обязательства WP04 и WP00–WP16; исходный master-plan/tasks.md T010 остаётся открыт.

## Поставка Состава Приглашённых
- [x] T007 [US3] Модель/FK/revision/down refusal в backend/migrations/1762500000000_event_invitations.cjs; actual migration-drill second сохраняет прежние строки/RSVP/токены, empty down/up, populated refusal и wedding cascade.
- [x] T008 [US3] Couple-only versioned roster в backend/src/routes/events.ts и приватная проекция backend/src/guests/event-invitations.ts, backend/src/routes/guests.ts; контракт0.63.0 и генерация161paths/212operations/111schemas.
- [x] T009 [US3] Закрепить атомарность/приватность/роли/гонки/FK в backend/test/eventInvitations022.test.ts:29cases; focused9files289pass с audit55, controlled token-reassignment before1fail сохранён.
- [x] T010 [US4] Реальный экран app/src/pages/EventInvitations.tsx и гостевой состав app/src/pages/Invite.tsx;22cases в app/src/lib/eventInvitations.test.tsx, focused8files182pass с dictionary guard.
- [x] T011-L Свежая полная проверка1452frontend/1762backend/no skips/init0, browser invitationsfinal3:9checks/zeroerrors/all10PNG inspected/source574match; REPORT-INVITATIONS.md, карты/JOURNAL/handoff.
- [ ] T011-P Scoped publication/main. На границе этого коммита ещё не объявлена; подтверждение после remote work в .unlazy/wp04-event-invitations-20261001/PUBLICATION-CONFIRMED.md и attached PR.
- [x] T012-L [US5] Отдельные RSVP по person/event, общий календарный deadline/end-of-day zone по IANA-поясу, обращение после срока и organizer provenance реализованы: контракт0.70.0/6операций(0da3e23), миграция1763700000000_event_rsvp_deadlines.cjs, backend rsvp-events.ts, гостевой блок /invite (один список, решение D5) и новый экран пары /wedding/events/:eventId/rsvp. Targeted4files/68tests, весь фронт111files/2085passed, tsc/eslint чисто; backend T012131tests+legacy regression266 на свежей полной БД(79миграций по порядку), после независимого Opus-ревью155tests+quiet-hours/notify regression318 на dev-БД; migration drill22own migrations через1763700000000/12T012SQL-отказов+1guarded CLI down refusal; browser9/9checks/zeroerrors RU/EN320/390/1440. Ревью нашло и закрыло: P1 каскадное удаление гостя/семьи/+1/события с просьбой500(BEFORE DELETE стража путал ON DELETE CASCADE), P1 решение по просьбе снятого с ростера человека404-илось и откатывалось, P2 чужой guestId401вместо404(identity-оракул), P2 срок≤дата мероприятия вынесен в DB CHECK, P3 чтение по гостевому токену for share вместо for update, P3 DST-переход на местной полуночи — второй проход коррекции в fromLocal. Источник: REPORT-RSVP.md; правила на будущее — ERRORS.md.
- [ ] T012-P Полный `bash init.sh` на финальном дереве, CI, merge владельцем. На границе этого коммита ещё не выполнены; публикация не объявлена.
