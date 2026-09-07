# План: Очередь заявок на верификацию подрядчиков

**Спека:** ./spec.md

## Затрагивается

| Слой | Что |
|---|---|
| Фронт | `app/src/pages/Admin.tsx` — два экрана: `AdminVerifications` (очередь) и `AdminVerification` (карточка с решением); главная панели — раздел и показатель; `app/src/App.tsx` — маршруты `/admin/verifications`, `/admin/verifications/:requestId`; `app/src/lib/api/admin.ts` — три обёртки; `app/src/lib/api/vendor.ts` — `getVerificationStatus`; `app/src/pages/VendorApp.tsx` (`VendorVerification`) — статус заявки; `app/src/lib/i18n.en.ts`; тесты `app/src/lib/audit24.test.tsx`, массивы `ROUTES` в `nomocks`/`smoke`/`clickstorm`, `FORBIDDEN_WHEN_DOWN` |
| Бэк | `backend/src/routes/admin.ts` — `GET /admin/verifications`, `GET /admin/verifications/{requestId}`, `POST /admin/verifications/{requestId}`, показатель `verificationQueue` в метриках; решение `reject` по анкете больше не трогает `vendor_verifications`; `backend/src/routes/vendorCabinet.ts` — `GET /vendor/verification`; тесты `backend/test/audit25.test.ts` |
| БД | **без изменений**: `vendor_verifications` (id, vendor_id, kind, file_url, inn, status pending/approved/rejected, checked_at, created_at), индекс `(status, created_at)`, `vendors.verified_at` |
| Контракт | v0.26.0 → v0.27.0, см. «Контракт» |

## Ворота инвариантов

Проверено против `CLAUDE.md` §5 и R-01…R-15.

| Инвариант | Что нарушаем | Зачем | Почему нельзя иначе |
|---|---|---|---|
| §5.11 инварианты — в ограничениях БД | «одна незакрытая заявка на подрядчика» держится проверкой в обработчике подачи, частичного уникального индекса нет | очередь не должна пухнуть от повторных нажатий | индекс — миграция, а миграции под стоп-условием; строка владельцу в «Хвостах» (`tasks/todo.md`); решение по заявке берёт строку `for update`, так что двойное решение исключено и без индекса |

Пояснения, где нарушения нет:
- **§5.15 / R-174.** Ссылка на документ показывается только сотруднику и только в карточке заявки; ни один
  ответ каталога и кабинета её не отдаёт — существующие тесты (`stage3`, `stage8`) остаются.
- **§5.5 / R-176.** Обе кнопки решения — запрос; переход к анкете — маршрут; ссылка на документ — внешняя.
- **§5.13.** Показатель заявок на дашборде — через `num()`.
- **R-15.** Экран 55 «Верификация документов» (подрядчик) и 63 «Очередь модерации» уже в §20.1; очередь заявок —
  часть экрана 63 (модерация), как деталь анкеты.

## Контракт

Версия `0.27.0`. Генераторы в той же итерации.

1. **`GET /admin/verifications`** (сотрудник; `Limit`/`Cursor`) → `VerificationPage { items: VerificationItem[], nextCursor }`;
   `VerificationItem { id, vendorId, vendorName, kind (passport|ip|company), hasFile: boolean, createdAt }` —
   без ссылки и ИНН: список не должен раздавать документы; только `pending`, только подрядчики живых
   пользователей, старейшие сверху (индекс `(status, created_at)` уже есть).
2. **`GET /admin/verifications/{requestId}`** (сотрудник) → `VerificationRequest { id, vendorId, vendorName, vendorPublished: boolean,
   kind, fileUrl (nullable), inn (nullable), status, createdAt, checkedAt (nullable) }`; каждый ответ пишет `audit_log`
   `verification.view` (как просмотр карточки свадьбы — до ответа). Ответы 401/403/404. `vendorPublished` — чтобы карточка
   не вела на «анкета вне каталога» (сверка V03).
3. **`POST /admin/verifications/{requestId}`** (сотрудник) `{ action: approve|reject, reason? (≤ 1000) }` →
   `VerificationDecision { requestId, action }`; `reject` без непустой причины — 422 поле `reason`; заявка не
   `pending` — 409 `verification_not_pending`; 404 если нет. Описание: `approve` здесь — «документы сверены» (галочка сразу и по
   неопубликованной анкете), в отличие от `approve` анкеты в модерации — «анкета проверена»; `reject` документов анкету не трогает.
4. **`GET /vendor/verification`** (владелец анкеты) → `VerificationStatus { status: none|pending|approved|rejected,
   kind (nullable), submittedAt (nullable), checkedAt (nullable) }` — последняя заявка; без ссылки и ИНН (свои
   же, но не нужны экрану и не должны кэшироваться на устройстве). Без анкеты — 403, как отвечает `myVendorId` у
   всех путей кабинета (сверка V01).
5. `AdminMetrics` + `verificationQueue: integer`.
6. `POST /admin/moderation/vendors/{vendorId}`: описание — `reject` больше не закрывает заявку на верификацию;
   `verify` закрывает (`approved`), как сейчас.
7. Ответы 401/403/404/409/422 у новых операций ссылками на существующие `responses`.

## Хранение

Новых таблиц и ограничений нет. Что делает бэкенд:

- очередь: `from vendor_verifications r join vendors v on v.id = r.vendor_id join users u on u.id = v.user_id and u.deleted_at is null where r.status = 'pending' order by r.created_at, r.id`, курсор `(created_at, id)`;
- карточка: та же выборка по `id`, плюс `file_url`, `inn`, `status`, `checked_at`; `audit(staff, 'verification.view', 'verification', id, {})` до ответа;
- решение — одна транзакция: `select status, vendor_id from vendor_verifications where id = $1 for update` →
  не `pending` → 409; `approve`: `update vendor_verifications set status = 'approved', checked_at = now()` и
  `update vendors set verified_at = coalesce(verified_at, now())`; `reject`: `status = 'rejected', checked_at = now()`;
  `audit(staff, 'verification.approve|reject', 'verification', id, { vendorId, reason })` в транзакции;
  уведомление владельцу после фиксации: `system`, `approve` → «Вы проверены» / «Галочка «Проверен» видна парам в
  каталоге» — только если `verified_at` был пуст (иначе то же уведомление уже ушло от `verify` анкеты — V05),
  `reject` → «Документы не подтверждены» / причина, `link: '/vendor-app/verification'`, `critical: false`;
  сбой уведомления — в лог, ответ 200 (как у решений фичи 001 после ревью A-14);
- `verify` по анкете (`admin.ts`) остаётся: `approved` всем `pending` этого подрядчика + `verified_at`;
  `reject` по анкете — блок `vendor_verifications … 'rejected'` удаляется из кода (это правка одной ветки, не
  удаление файла);
- статус подрядчику: последняя строка по `created_at desc` для `myVendorId(user)`; нет строк → `status: 'none'`;
- метрика: `count(*)` по тому же условию, что очередь (R-212 — одна SQL-константа `VERIFICATION_QUEUE_FROM`).

## Решения

| Решение | Почему | Что отклонили и почему |
|---|---|---|
| ссылка на документ — только в карточке заявки, с записью в журнал | документы «уходят только модератору»: экран подрядчика это обещает, а журнал делает проверяемым | ссылка в списке — раздача документов постранично; без журнала — «кто смотрел» неизвестно |
| отдельная операция решения по заявке, а не `verify` в решении по анкете | заявка живёт дольше анкеты в очереди модерации (№25); отклонить документы, не снимая анкету, нечем | расширять `POST /admin/moderation/vendors/{id}` — смешивает два решения в одном пути |
| `reject` анкеты больше не закрывает заявку | документы и публикация — разные решения; заявка должна дойти до очереди верификации | оставить как было — очередь верификации теряла бы заявки при каждом снятии анкеты |
| причина отказа — в журнале и уведомлении | без миграции; подрядчику причина приходит уведомлением, сотруднику — в журнале | колонка `reason` — миграция (стоп-условие); отдать причину в `GET /vendor/verification` из `audit_log` — чтение журнала по сущности, которого в проекте нет и которое здесь начинать не стоит |
| `approve` ставит `verified_at` и по неопубликованной анкете | проверка документов не зависит от публикации; галочка покажется вместе с анкетой | 409 по неопубликованной — заявка застревала бы до публикации, а документы уже сверены |
| экраны — в `pages/Admin.tsx` тем же чанком | как остальные экраны панели | свой файл — второй чанк ради двух экранов |

## Открытые технические вопросы

- **Подача из приложения.** Появится с хранилищем (№3): `POST /media/upload-url` → `fileUrl` → `POST /vendor/verification`.
  Экран подрядчика уже описывает шаги; кнопка отправки — отдельная задача того дня, не этой фичи.
- **Уникальность незакрытой заявки** — частичный уникальный индекс `(vendor_id) where status = 'pending'`:
  миграция, владельцу.
