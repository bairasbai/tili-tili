# WP00–WP16 · повторная проверка дополнения · 5 ноября 2026

База main: 2b133642a13d076cbbf97e7397d740e2b2ccc970 (повторное GitHub-чтение подтвердило).
Исходный локальный коммит: 6f063418935e65ca156335be8af70d0d5a8a8be2.
Ветка/worktree: docs/oss-reuse-wp00-wp16-20261105, /workspace/tili-tili-oss-plan.
Исходная копия work/3041d2c и прежние данные/FAILED/ветки сохранены.

## Разрешение и граница публикации

Пользователь: «Надо будет обновить коммит». Родительская сессия поручила после
независимой проверки и исправлений обычный push только документальных изменений
в отдельную безопасную ветку; запрещены main, чужие ветки, rewrite/force, merge и deploy.
Предыдущий запрет публикации относился к исходной подготовке и этим поручением заменён.

После авторского source-review по отдельному явному поручению запущен свежий reviewer
/root/review_oss_plan через tili-orchestrate. Независимое заключение на34880cfcf4801dc993f29e727b9cebd6cf85ef74:
ACCEPT, P1/P2/P3 замечаний нет. Прочитаны7changed documents/blocks,19license/source records,
metadata/peers,39cited product paths,17WP и фактическая цепочка альбома; его bounded
checks завершились exit0. Это статическая приёмка документации, не runtime/npm/provider gate.
Последующие правки касаются только provenance/status/авторизованной публикации и будут
отдельно показаны этому reviewer перед push.

Автоматических отказов/неопределённых мутаций нет. Последний git ls-remote по main и
целевой docs-ветке дал exit0: main прежний2b133642, docs-ветка отсутствует.
Этот handoff записан перед push; authoritative remoteSHA проверяется после публикации
и сообщается в итоговом ответе. Никакого main/чужих веток/PR/force/merge/deploy.

## Что исправлено

1. Лимит50 в config — default ALBUM_MAX_PER_GUEST, runtime настройка не наблюдалась.
   Квота metadata сейчас связана с primary guestId семейной ссылки.
2. MATRIX в wedding/access.ts разрешает GET/PATCH album ролям couple/helper/coordinator.
   Исходный текст «модерация пары» был слишком узким. В plan/OSS зафиксировано расхождение
   OpenAPI/комментария и исполняемой матрицы; код/права/контракт не менялись.
3. В требование50 на человека добавлено ограничение: общий анонимный QR и свободное
   имя не доказывают уникальность физического человека. Нужна проверенная person identity.
4. К19candidate rows добавлены17 прямых package.json ссылок и2README/stack по исследованным
   исходникам. Версии — snapshots; опубликованные npm-архивы/полный graph не приняты.
5. Из публичного OSS-реестра убрана часть служебных подробностей окружения.
   Местный GitHub guard hook отсутствует (MODULE_NOT_FOUND); его status неизвестен,
   запросы последовательны. Подробности остаются здесь, не подменяют техническую рекомендацию.
6. ERROR/JOURNAL/todo фиксируют коррекцию и последующее разрешение. Весь diff от main —
   7 документов, вместо первоначальных6 из-за обязательной записи в ERRORS.md.

Первоначальные полезные выводы сохранены: все17WP отдельно сопоставлены с кодом,
19 новых кандидатов и7 групп уже применённого OSS; PR46 и45→47→48 учтены.
Upload API501 и отсутствие готового QR/camera/гостевого upload/archive UI явно отмечены.
Puck/pdfme/assistant-ui/S3/Sharp уже применены. React-konva19.3 требует другой React minor;
FullCalendar Premium отдельно лицензируется; web-push/ical.js/axe-core MPL2.0.
Uppy6 direct S3 flow не является принятой заменой presigned POST032.
FotoToi — публичный UI-референс родительской сессии, без REA/replica и скрытого backend-аудита.
Код/дизайн/default25 референса не копируются; требование владельца —50 на человека.

## Фактическая проверка

- Повторный Python source validator:19 ordered source/license identities и Git blob SHA,
  17 npm metadata links/versions,2stack references,17WP и17code mappings — PASS.
-22локальные ссылки с heading anchors — PASS.
- Code-to-prose assertions: envNumber default50, ALL_TEAM, family-primary token/count и
  approved-only guest projection — PASS. Это source check, не запуск API/DB.
- Targeted scan добавленных строк на private keys/GitHub/AWS credentials/password URL —
  совпадений нет. Это не полный security audit.
- git diff --check — exit0; итоговый7-doc allowlist и5manifests/locks побайтно прежние;
  те же границы независимо подтвердил reviewer.
- Предыдущая наивная проверка требовала AtomicCRM package0.1.0 в строке app-reference.
  Отказ сохранён в выводе; проверка уточнена до действительно заявленных версий.
- Ранние link-check и apply_patch ошибки первоначальной поставки описаны в6f06341;
  их результаты не переименованы в PASS.

Среда Node24.19.0; проектный CI Node22/pnpm10.34.5. Установки, unit/integration/browser,
аудит нового graph, реальные S3/ClamAV, устройства/нагрузка — UNRUN.
Общие DB/Redis/browser/Docker/devservers не запускались.
Прикладной код, зависимости, оплата/безопасность/CI-конфиги не менялись; все17WP OPEN.

Первичные исходники исследования:
 /workspace/scratch/tili-oss-research-final-v2-20261105.json
 SHA256 143605b9c3e1091802a2b70fe21f5cc5ede41b3817ccbf333617d394ff569e60.
Это локальное evidence, в публикацию не входит; публичные ссылки теперь есть в OSS-реестре.

## Следующее действие

Короткая проверка reviewer-ом provenance/status commit, затем разрешённый обычный push
одной docs-ветки и readback remoteSHA. Не создавать PR без нового поручения.
Последний localSHA и authoritative remoteSHA будут указаны в финальном ответе.

Для разработки: минимальный отдельный S01 — synthetic CSV parser/preview вне продуктовых
файлов, без конкуренции сPR46. Текущий продуктовый этап — вся032-B/M01–M12;
перед SQL сверить свежий main/номер миграции и владельца. Альбом требует последующего
person-scoped инкремента, privacy/retention/timing/bytes/download и provider/device gates.
