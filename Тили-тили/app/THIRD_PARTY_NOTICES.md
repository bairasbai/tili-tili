# Локальный PDF

- `@pdfme/generator`, `@pdfme/common`, `@pdfme/schemas`: закреплены на **6.2.8**, [исходный проект](https://github.com/pdfme/pdfme). MIT, Copyright (c) 2020 HandDot. Полный текст: `public/licenses/pdfme-LICENSE.txt`; он включается в сборку. Используется генератор библиотеки; исходники проекта целиком не копировались.
- `public/fonts/pdf/ProjectSans.ttf`: изменённый и переименованный поднабор Noto Sans Regular, SIL OFL 1.1. Copyright 2022 The Noto Project Authors. Полный OFL: `public/fonts/pdf/OFL.txt`. Поддерживаются латиница, кириллица, башкирские буквы и знак рубля; это не универсальный шрифт для всех письменностей и эмодзи.
- Исходный шрифт: `https://raw.githubusercontent.com/google/fonts/main/ofl/notosans/NotoSans%5Bwdth,wght%5D.ttf`; SHA256 `bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d`.
- Поднабор: SHA256 `4d0ded15b9c59cdeba6bf1db3c0e85fd25f9df94d80646f60f9812b5e29915c6`, 128820 байт. Воспроизводимая сборка: `python scripts/build-pdf-font.py <исходный-ttf> public/fonts/pdf/ProjectSans.ttf` (нужен fontTools). В приложении Python не нужен.
- PDF создаётся в браузере, без внешнего API и облачных моделей. Генератор загружается по требованию, шрифт — со своего origin. Внешний исходный URL используется только при подготовке шрифта разработчиком.
- У пакетов upstream заданы peer-зависимости через `latest`; менеджер pnpm предупреждает об этом даже при одинаковой закреплённой версии. Версии проверяются типами, реальной генерацией и сборкой; предупреждение не скрывается настройками.

Puck 0.24.0 — MIT, Copyright (c) The Puck Contributors. Local library used for the invitation editor. Full license: public/licenses/puck-LICENSE.txt. https://github.com/puckeditor/puck

`@assistant-ui/react` 0.15.32 и `@assistant-ui/core` 0.3.32 — MIT, Copyright (c) 2026 AgentbaseAI Inc. Используются только для отображения карточек действий в существующем чате. Новый транспорт и автоматическое исполнение инструментов не подключены. Полный одинаковый текст лицензии обоих пакетов: `public/licenses/assistant-ui-LICENSE.txt`; исходный проект: https://github.com/assistant-ui/assistant-ui.
