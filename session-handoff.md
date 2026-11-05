# WP00–WP16 · готовые решения · 5 ноября 2026

Задача родительской сессии: для каждого из 17 WP найти готовые GitHub-решения,
проверить коммерческие лицензии и совместимость с кодом, дополнить план.
Объём этой поставки — документы в отдельной локальной ветке, без push/PR/merge/deploy.
Использование библиотек в дальнейшей разработке расписано; новых заимствований и установок нет.

## Ветка и сохранность

- Worktree: /workspace/tili-tili-oss-plan; ветка docs/oss-reuse-wp00-wp16-20261105.
- База: main 2b133642a13d076cbbf97e7397d740e2b2ccc970,
  tree 6bc333d950131fa02e56ca6149136a63d1b7c3a9.
- Один git fetch --no-tags origin main; повторное GitHub-чтение перед завершением
  подтвердило тот же SHA. Исходная копия /workspace/tili-tili на work/3041d2c сохранена.
- AGENTS.md в родительских, корневом и целевых каталогах нет. CLAUDE.md и имеющийся
  tili-orchestrate SKILL.md прочитаны; новых субагентов не запускали.
- GitHub guard hook локально отсутствует: MODULE_NOT_FOUND. Его статус не подтверждён;
  дальнейшие GitHub-запросы последовательны, без 403/429.
- Прежний handoff сохранён в исходной копии и в Git по baseline SHA. Исторические
  записи todo/JOURNAL не удалены. Старые FAILED, БД, CI, branches и чужая работа сохранены.

## Изменения

1. tasks/wedding-platform-master-plan/plan.md: update-note и §11, 17 отдельных строк
   WP00–WP16 с повторным использованием, границами новых компонентов и приёмкой.
2. OSS-REUSE-20261105.md в том же каталоге: 17 привязок к текущему коду,
   7 групп уже используемого OSS, 19 кандидатов с primary лицензиями и SHA,
   зависимости, зрелость, ограничения, 9 открытых PR и 6 экспериментов UNRUN.
3. README плана: ссылка на реестр; tasks/todo.md и JOURNAL.md: эта поставка.
4. Этот handoff заменяет прежний только в новой рабочей ветке.

Главные выводы: не устанавливать заново pdfme/Puck/assistant-ui/S3/Sharp.
Upload API остаётся 501 до 032-B/M01–M12. PR46 уже содержит семейный preview/recovery,
PR45→47→48 — weekly/dependencies; имена файлов этих PR сверены.
FullCalendar resource/timeline Premium лицензируется отдельно. MPL2.0 у ical.js,
axe-core и web-push. React-konva19.3.2 требует React19.3 при locked19.2.3.
Atomic CRM и Seating-Planner годятся для отдельных UI-идей; auth/backend/storage не переносить.
Надёжный SDK WP11 пока не выбран; для WP13/14/15 совместимый готовый доменный backend
не подтверждён. Применимые общие компоненты повторены явно; все 17 WP остаются OPEN.

Уточнение владельца про альбом добавлено в plan.md §11.1: QR на столе, камера/выбор,
общий просмотр и скачивание после свадьбы, 50 фото на человека. Main считает50 по
primary person семейной ссылки, поэтому требование ещё не выполнено; upload501 и
готового гостевого QR/upload/archive UI нет. Есть metadata/consent/moderation.
Нужны person-scoped identity/quota, независимые upload/view windows с wedding timezone,
приватность/модерация/отзыв/retention и bounded download. FotoToi изучен по публичному UI
родительской сессией; REA/replica и скрытые backend правила не проверялись, код/дизайн
не переносятся. Uppy — optional UI: текущий S3v6 flow не заменяет наш presigned POST.

## Фактические проверки

- git diff --check: exit0.
- Python/std-only document check: exit0 — 17 строк WP нового §11, 17 code mappings,
  19 кандидатов N01–N19, 22 локальные ссылки с heading anchors, парность fences.
- Все 18 проверенных primary entry-point файлов существуют.
- Оба package.json и 3 lock-файла (frontend package-lock/pnpm-lock, backend pnpm-lock)
  побайтно совпали с baseline: 5/5. Прикладные файлы и настройки в diff отсутствуют.
- SHA1 Git-blob проверка полученных LICENSE/LICENCE: 19/19 совпали с GitHub blob SHA;
  qualified package JSON читается. Первоначальные ошибочные пути LICENSE/package
  уточнены по directory listing; источники итогового реестра прочитаны.
- Первый общий link-check: exit1 на исторической Windows C:/ссылке todo.
  Затем проверены только добавленные ссылки todo и полные plan/README/OSS: exit0.
  Старые доказательства не редактировались.
- Начальный apply_patch с delete/add одного handoff отклонён валидатором до изменений;
  выполнен обычный update. Это ошибка формата patch, не неопределённая мутация.

Среда Node24.19.0; CI проекта Node22/pnpm10.34.5. Установка, unit/integration/browser,
audit нового dependency graph, облако/ClamAV engine, нагрузка, устройства и production — UNRUN.
Старые PASS не перенесены. Независимого reviewer итоговых документов в этой среде не было;
предложения родительской исследовательской сессии сверены с исходными лицензиями/metadata.
DB/Redis/browser/Docker/devservers и внешние отправки не запускались.

Primary evidence вне product diff:
 /workspace/scratch/tili-oss-research-final-v2-20261105.json
 SHA256 143605b9c3e1091802a2b70fe21f5cc5ede41b3817ccbf333617d394ff569e60.
Содержит 19 candidate snapshots, raw license/package/stack, supplementary reads, PR heads/files.
Предыдущий частичный research JSON сохранён рядом; финальный список — в final.

## Открытые вопросы и следующий шаг

Родительской сессии — независимо прочитать итоговый diff и матрицу.
Локальный коммит с 6 файлами готовится этой передачей; фактический SHA будет указан
в финальном ответе после commit. Публикация запрещена текущим поручением.
Автоматических отказов согласования или неопределённых мутаций нет.

Минимальная отдельная разработка: S01, локальный parser/preview синтетического CSV,
без UI/API/storage/оплаты/security изменений, с проверкой published PapaParse/types/interop.
Перед интеграцией в Wedding/GuestImportPanel сверить владельца и PR46.
Текущий продуктовый этап — 032-B целиком M01–M12; перед SQL перепроверить номер
миграции и владельца участка, сохранить все native/preserving/source-admission gates.
Реальные S3/ClamD/operator/recovery и выбор платёжного провайдера остаются отдельными условиями.
Плавающий redis:7-alpine требует фактического version/digest/license до выпуска; конфиг не меняли.
