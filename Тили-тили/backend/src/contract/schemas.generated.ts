/* СГЕНЕРИРОВАНО. Не править руками — правится контракт, потом `pnpm run gen:schemas`.
 * Схем: 79. */

export const CONTRACT_SCHEMA_ID = "contract"

/** Единый документ схем; подключается через app.addSchema.
  * Ключ `definitions`, а не `components.schemas`: AJV в strict-режиме
  * отвергает неизвестное ключевое слово, а `definitions` он знает. */
export const CONTRACT_SCHEMAS = {
  $id: "contract",
  definitions: {
      "AdminCategories": {
          "type": "object",
          "description": "Текущее состояние справочника: то, что заменит следующий PUT.",
          "properties": {
              "categories": {
                  "type": "array",
                  "items": {
                      "$ref": "contract#/definitions/AdminCategory"
                  }
              },
              "synonyms": {
                  "type": "object",
                  "description": "слово → идентификатор категории",
                  "additionalProperties": {
                      "type": "string"
                  }
              },
              "version": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{16}$",
                  "description": "Отпечаток содержимого справочника — шестнадцать шестнадцатеричных знаков.\nМеняется от ЛЮБОЙ правки категорий или словаря, в том числе сделанной\nмимо панели: он считается по самим строкам, а не по времени сохранения.\nВозвращается в теле PUT, чтобы сохранение не затёрло чужую правку.\n"
              }
          }
      },
      "AdminCategoriesUpdate": {
          "type": "object",
          "description": "Тело правки справочника категорий (фича 014: одна схема — и контракту, и обработчику).",
          "additionalProperties": false,
          "properties": {
              "categories": {
                  "type": "array",
                  "maxItems": 200,
                  "description": "до 200 категорий — справочник шлётся целиком (сейчас 35)",
                  "items": {
                      "$ref": "contract#/definitions/AdminCategory"
                  }
              },
              "synonyms": {
                  "type": "object",
                  "maxProperties": 2000,
                  "propertyNames": {
                      "maxLength": 40
                  },
                  "description": "слово → идентификатор категории; слово хранится в нижнем регистре.\nНе больше 2000 слов, длина слова — до 40 знаков: словарь\nзаменяется целиком и вставляется построчно под блокировкой\nсправочника, а «фотограф» — это слово, а не абзац.\n",
                  "additionalProperties": {
                      "type": "string"
                  }
              },
              "version": {
                  "type": "string",
                  "maxLength": 16,
                  "pattern": "^[0-9a-f]{16}$",
                  "description": "Версия справочника, с которой начата правка (из `GET /admin/categories`).\nНе совпала с текущей — 409 `categories_stale`. Без поля сохранение\nидёт без проверки. Шестнадцать шестнадцатеричных знаков — всё\nостальное 422, а не 409: такой версии сервер не выдавал никогда.\n"
              }
          }
      },
      "AdminCategory": {
          "type": "object",
          "description": "Категория глазами сотрудника: то же, что в каталоге, плюс порядок в мозаике.\nОтдельная схема, а не Category, потому что `sort` наружу не выходит —\nпаре он не нужен, а панель без него не может переставлять плитки.\n",
          "required": [
              "id",
              "title"
          ],
          "properties": {
              "id": {
                  "type": "string",
                  "maxLength": 40,
                  "pattern": "^[a-z0-9_-]{1,40}$"
              },
              "title": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 100
              },
              "icon": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 16,
                  "description": "Значок категории. В базе может быть пустым, и это `null`, а не «нет поля».\nВ теле PUT пропуск — прежний значок, `null` — стереть (R-17: пропуск и\nочистка — разные намерения; фича 014).\n"
              },
              "sort": {
                  "type": "integer",
                  "description": "порядок в мозаике: меньше — выше"
              }
          }
      },
      "AdminMetrics": {
          "type": "object",
          "description": "Показатели платформы на сейчас. Каждое число считается сервером —\nклиент их не складывает и не досчитывает, иначе на двух экранах\nполучились бы два разных ответа.\n",
          "properties": {
              "users": {
                  "type": "integer",
                  "description": "живые аккаунты"
              },
              "weddings": {
                  "type": "integer",
                  "description": "неархивные свадьбы"
              },
              "vendorsPublished": {
                  "type": "integer",
                  "description": "опубликованные и не заблокированные анкеты"
              },
              "moderationQueue": {
                  "type": "integer",
                  "description": "анкеты, ждущие проверки"
              },
              "verificationQueue": {
                  "type": "integer",
                  "description": "Заявки на верификацию, ждущие решения. Считается тем же условием,\nчто и очередь `GET /admin/verifications`: число на дашборде и длина\nочереди — одно и то же, иначе панель обещает работу, которой нет.\n"
              },
              "complaintsOpen": {
                  "type": "integer",
                  "description": "нерассмотренные жалобы"
              },
              "complaintsOverdue": {
                  "type": "integer",
                  "description": "Из них старше суток. Срок разбора — 24 часа (§18.2); без отдельного\nсчётчика он существует только на бумаге.\n"
              },
              "deals": {
                  "type": "integer",
                  "description": "сделки в состояниях booked, paid_deposit, done"
              },
              "gmv": {
                  "allOf": [
                      {
                          "$ref": "contract#/definitions/Money"
                      }
                  ],
                  "description": "оборот по тем же сделкам"
              },
              "cities": {
                  "type": "array",
                  "description": "до двадцати городов по числу анкет",
                  "items": {
                      "type": "object",
                      "properties": {
                          "city": {
                              "type": "string"
                          },
                          "vendors": {
                              "type": "integer"
                          },
                          "launchReady": {
                              "type": "boolean",
                              "description": "город готов к запуску — анкет 50 и больше"
                          }
                      }
                  }
              },
              "llm": {
                  "type": "object",
                  "description": "Расход Тиля на языковую модель за последние 30 дней — по строкам\nучёта `tilly_usage` (одна на каждый вызов, фича 010). `calls` —\nвсе обращения, включая отказы провайдера и ответы заглушкой;\n`answered` — сколько из них ответила модель; токены — только по\nответам модели. Стоимость в рублях сервер не считает: цены у\nпровайдеров и моделей разные и меняются — владелец умножает сам.\n",
                  "required": [
                      "since",
                      "calls",
                      "answered",
                      "inputTokens",
                      "outputTokens"
                  ],
                  "properties": {
                      "since": {
                          "type": "string",
                          "format": "date-time",
                          "description": "начало окна — 30 дней назад"
                      },
                      "calls": {
                          "type": "integer",
                          "minimum": 0
                      },
                      "answered": {
                          "type": "integer",
                          "minimum": 0
                      },
                      "inputTokens": {
                          "type": "integer",
                          "minimum": 0
                      },
                      "outputTokens": {
                          "type": "integer",
                          "minimum": 0
                      }
                  }
              },
              "profiles": {
                  "type": "object",
                  "description": "Заполненность живых опубликованных анкет (фича 012, План §19.10\nп. 4). Заполненность одной анкеты — доля заполненных из четырёх\nполей, которые подрядчик может заполнить сам: описание, рабочий\nтелефон, цена «от», хотя бы один пакет. Фото и видео не считаются —\nзагрузок нет до хранилища, и метрика штрафовала бы всех за\nинфраструктуру. `published` — тот же набор, что `vendorsPublished`;\n`complete` — 4 из 4; `averagePercent` — среднее по анкетам, 0…100.\nПустой каталог — нули по факту ответа, не «неизвестно».\n",
                  "required": [
                      "published",
                      "complete",
                      "averagePercent"
                  ],
                  "properties": {
                      "published": {
                          "type": "integer",
                          "minimum": 0
                      },
                      "complete": {
                          "type": "integer",
                          "minimum": 0
                      },
                      "averagePercent": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 100
                      }
                  }
              }
          }
      },
      "AlbumPhoto": {
          "type": "object",
          "properties": {
              "id": {
                  "type": "string"
              },
              "url": {
                  "type": "string"
              },
              "approved": {
                  "type": "boolean"
              },
              "createdAt": {
                  "type": "string",
                  "format": "date-time"
              }
          }
      },
      "AuthTokens": {
          "type": "object",
          "properties": {
              "accessToken": {
                  "type": "string"
              },
              "refreshToken": {
                  "type": "string"
              },
              "expiresIn": {
                  "type": "integer",
                  "description": "срок жизни accessToken, секунды. 15 минут по плану §1"
              },
              "user": {
                  "$ref": "contract#/definitions/User"
              },
              "consentRequired": {
                  "type": "boolean",
                  "description": "Только у `POST /auth/otp/verify`: нет живого согласия под\nдействующей редакцией политики — новый аккаунт, восстановленный\nпосле отзыва, или согласие дано под прежней редакцией (фича 005).\nДо `POST /users/me/consent` остальные пути отвечают: без согласия\nвовсе — 403 `forbidden`; под прежней редакцией — 403\n`consent_outdated`.\n"
              }
          }
      },
      "BroadcastResult": {
          "type": "object",
          "description": "Что сделала «рассылка гостям»: гостям доставки нет (ни SMS, ни почты\n— «Хвосты»), запись уходит в журнал рассылок и команде в приложении.\n",
          "properties": {
              "broadcastId": {
                  "type": "string"
              },
              "recipients": {
                  "type": "integer",
                  "description": "скольких гостей касается (по записям/ответам)"
              },
              "notified": {
                  "type": "integer",
                  "description": "скольким членам команды ушло уведомление"
              },
              "debounced": {
                  "type": "boolean",
                  "description": "true — та же рассылка уже была недавно, повторно не отправлялась"
              }
          }
      },
      "Budget": {
          "type": "object",
          "properties": {
              "total": {
                  "$ref": "contract#/definitions/Money"
              },
              "spent": {
                  "$ref": "contract#/definitions/Money"
              },
              "reserve": {
                  "allOf": [
                      {
                          "$ref": "contract#/definitions/Money"
                      }
                  ],
                  "description": "Резерв на непредвиденное — 10% от общего бюджета (План ч. 283).\nОтдельная строка, а не категория: категории делят сто процентов\nмежду собой, и резерв внутри них означал бы, что часть сметы\nпросто уменьшили.\n\nСчитает сервер, чтобы доля не разошлась между экранами.\n"
              },
              "categories": {
                  "type": "array",
                  "items": {
                      "type": "object",
                      "properties": {
                          "id": {
                              "type": "string"
                          },
                          "title": {
                              "type": "string"
                          },
                          "planned": {
                              "$ref": "contract#/definitions/Money"
                          },
                          "fromSlots": {
                              "type": "integer",
                              "description": "автосумма из броней"
                          },
                          "color": {
                              "type": "string",
                              "description": "Цвет полосы категории в разбивке бюджета. Задаётся сервером,\nа не клиентом: категории приходят из справочника, и палитра\nдолжна совпадать во всех клиентах и в выгрузках.\n"
                          },
                          "live": {
                              "type": [
                                  "string",
                                  "null"
                              ],
                              "description": "Кто из забронированной команды попал в эту категорию, через\nразделитель. Пусто — в категории пока только плановая сумма.\nНужно, чтобы пара видела, откуда взялась автосумма: без этого\n«120 000 из команды» выглядит как число ниоткуда.\n"
                          },
                          "items": {
                              "type": "array",
                              "items": {
                                  "$ref": "contract#/definitions/BudgetItem"
                              }
                          }
                      }
                  }
              }
          }
      },
      "BudgetItem": {
          "type": "object",
          "properties": {
              "id": {
                  "type": "string"
              },
              "title": {
                  "type": "string"
              },
              "amount": {
                  "$ref": "contract#/definitions/Money"
              },
              "categoryId": {
                  "type": "string"
              },
              "custom": {
                  "type": "boolean",
                  "description": "true = своя статья (удаляемая)"
              }
          }
      },
      "BusRoute": {
          "type": "object",
          "description": "Маршрут для гостей — работа перевозчика глазами гостей: точка сбора,\nвремя, места. Перевозчик — подрядчик (сделка в слоте «Транспорт»);\nмаршрут может ссылаться на его сделку (фича 006), а может жить сам по\nсебе (свой микроавтобус без сделки). Лимузин пары — сделка без маршрута.\n",
          "properties": {
              "id": {
                  "type": "string"
              },
              "name": {
                  "type": "string"
              },
              "from": {
                  "type": "string"
              },
              "time": {
                  "type": "string"
              },
              "seats": {
                  "type": "integer"
              },
              "taken": {
                  "type": "integer",
                  "readOnly": true,
                  "description": "занято ПЕРСОН (гость «с +1» — двое); считает база, переполнение запрещено"
              },
              "dealId": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "Сделка с перевозчиком этой свадьбы — только в слоте категории\n`transport` (иначе 422 `not_transport`) и живая: отменённая — 409\n`deal_cancelled`, кандидат или переговоры — 409 `deal_not_booked`\n(фича 014: «везёт перевозчик X» — обещание гостям, его не дают за\nподрядчика, который ничего не подтвердил). null — маршрут без\nперевозчика. Отмена сделки обнуляет поле, маршрут и записи гостей\nостаются.\n"
              },
              "carrier": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "readOnly": true,
                  "description": "Имя перевозчика по сделке: название анкеты из каталога или имя\nсвоего подрядчика. Видят пара, команда и гость (`GET /join/{t}/shuttle`)\n— только имя, без телефона и цены.\n"
              }
          }
      },
      "CancelResult": {
          "type": "object",
          "description": "Чем кончился вызов отмены. Отмена свадьбы — решение обоих партнёров,\nпоэтому первый вызов только просит подтверждения, и ответ обязан\nразличать эти два случая: экран показывает разное.\n",
          "properties": {
              "state": {
                  "type": "string",
                  "enum": [
                      "confirmation_required",
                      "cancelled"
                  ],
                  "description": "`confirmation_required` — ждём второго партнёра; `cancelled` — свадьба отменена"
              },
              "requestedBy": {
                  "type": "string",
                  "description": "кто попросил отмену — есть при `confirmation_required`"
              },
              "cancelledDeals": {
                  "type": "integer",
                  "description": "сколько сделок отменено — есть при `cancelled`; `done` в это число не входят"
              }
          }
      },
      "CategoriesUpdated": {
          "type": "object",
          "description": "Сколько строк сохранено. Словарь заменён целиком — число равно его новому размеру.",
          "properties": {
              "categories": {
                  "type": "integer"
              },
              "synonyms": {
                  "type": "integer"
              },
              "version": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{16}$",
                  "description": "Версия справочника после сохранения — с ней продолжают правку, не перечитывая."
              }
          }
      },
      "Category": {
          "type": "object",
          "description": "Справочник категорий подрядчиков. Список фиксированный — 35 записей, сид-данные лежат в миграции seed_categories; фронт берёт его только отсюда (моков `lib/data.ts` нет с 2026-09-06). Enum здесь не ставится намеренно: добавление категории не должно требовать выката новой версии контракта. Изменять список может только админ через PUT /admin/categories.\n",
          "properties": {
              "id": {
                  "type": "string"
              },
              "title": {
                  "type": "string"
              },
              "icon": {
                  "type": "string"
              },
              "vendorsCount": {
                  "type": "integer",
                  "description": "опубликованных анкет: в городе `city`, если он передан, иначе по всей базе"
              },
              "description": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "одна строка: что делает подрядчик и что у него спросить (миграция 39, план бэкенда §8.5)"
              }
          }
      },
      "Chat": {
          "type": "object",
          "properties": {
              "id": {
                  "type": "string"
              },
              "title": {
                  "type": "string"
              },
              "avatarUrl": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "lastMessage": {
                  "type": "string"
              },
              "unread": {
                  "type": "integer"
              },
              "kind": {
                  "type": "string",
                  "enum": [
                      "vendor",
                      "team",
                      "day",
                      "tilly",
                      "external",
                      "crew"
                  ],
                  "description": "`vendor` — пара с подрядчиком из каталога. `external` — со своим\nподрядчиком, найденным парой (§11), привязан к сделке\n(`chats.deal_id`): у следующего подрядчика того же слота — свой чат.\n`team` — команда свадьбы: пара, помощники и ЗАБРОНИРОВАННЫЕ\nподрядчики (Бизнес-логика §3.11); в нём координатор командует\nвсеми разом. `crew` — чат исполнителей: координатор и\nзабронированные подрядчики, БЕЗ пары (решение владельца\n2026-09-03). Пара видит строку `crew` в списке — с подписью\nвместо последней реплики и нулём непрочитанных, — а на чтение\nпереписки получает 403. `tilly` — помощник, только паре.\n`day` — чат дня X, открывается накануне.\n"
              },
              "closed": {
                  "type": "boolean",
                  "description": "Только у kind=external: сделка со своим подрядчиком отменена —\nпереписка остаётся паре для чтения, писать больше некому. Чат\nпривязан к сделке, не к слоту: у нового подрядчика в том же слоте\nсвой чат, и историю прежнего он не видит (фича 005, ERR-0219).\n"
              },
              "openFrom": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time",
                  "description": "Только у kind=day: 09:00 НАКАНУНЕ свадьбы по Wedding.tz. Чат\nсуществует с момента создания свадьбы и до этого срока виден,\nно закрыт (423) — иначе в списке чатов до дня X была бы пустота\nвместо строки «откроется 13 июня». Дату перенесли — срок едет\nвместе с ней.\n"
              },
              "tilly": {
                  "type": [
                      "object",
                      "null"
                  ],
                  "description": "Только у kind=tilly (фича 010), у остальных чатов — null. `live` — за Тилем стоит языковая\nмодель (провайдер настроен); false — он отвечает честной заглушкой\n«Тиль пока без ИИ», и экран говорит это словами. `usedToday` —\nсколько реплик пара уже отправила Тилю за сутки по поясу свадьбы,\n`limitPerDay` — предел (План §18: 50); на пределе POST отвечает\n429 `tilly_daily_limit`. Числа считает сервер — экран их не\nдосчитывает и без ответа не показывает.\n",
                  "required": [
                      "live",
                      "usedToday",
                      "limitPerDay"
                  ],
                  "properties": {
                      "live": {
                          "type": "boolean"
                      },
                      "usedToday": {
                          "type": "integer",
                          "minimum": 0
                      },
                      "limitPerDay": {
                          "type": "integer",
                          "minimum": 1
                      }
                  }
              }
          }
      },
      "City": {
          "type": "object",
          "properties": {
              "id": {
                  "type": "integer"
              },
              "name": {
                  "type": "string"
              },
              "region": {
                  "type": "string"
              },
              "district": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "lat": {
                  "type": "number"
              },
              "lon": {
                  "type": "number"
              },
              "population": {
                  "type": [
                      "integer",
                      "null"
                  ]
              },
              "big": {
                  "type": "boolean",
                  "description": "крупный город — блок «Популярные» в CityPicker"
              }
          }
      },
      "CityRef": {
          "type": "object",
          "required": [
              "name",
              "region"
          ],
          "properties": {
              "name": {
                  "type": "string"
              },
              "region": {
                  "type": "string"
              }
          }
      },
      "Complaint": {
          "type": "object",
          "properties": {
              "id": {
                  "type": "string"
              },
              "targetKind": {
                  "type": "string",
                  "enum": [
                      "vendor",
                      "review",
                      "message",
                      "deal"
                  ]
              },
              "targetId": {
                  "type": "string"
              },
              "category": {
                  "type": "string",
                  "enum": [
                      "fraud",
                      "content",
                      "no_show",
                      "spam"
                  ]
              },
              "text": {
                  "type": "string"
              },
              "status": {
                  "type": "string",
                  "enum": [
                      "new",
                      "resolved"
                  ]
              },
              "createdAt": {
                  "type": "string",
                  "format": "date-time"
              }
          }
      },
      "ComplaintDecision": {
          "type": "object",
          "description": "Что записано по жалобе.",
          "properties": {
              "complaintId": {
                  "type": "string"
              },
              "action": {
                  "type": "string",
                  "enum": [
                      "dismiss",
                      "warn",
                      "downrank",
                      "block"
                  ]
              }
          }
      },
      "ConciergeDecision": {
          "type": "object",
          "description": "Что записано по заявке консьержу.",
          "properties": {
              "requestId": {
                  "type": "string"
              },
              "status": {
                  "type": "string",
                  "enum": [
                      "in_progress",
                      "done",
                      "cancelled"
                  ]
              }
          }
      },
      "ConciergePage": {
          "type": "object",
          "properties": {
              "items": {
                  "type": "array",
                  "items": {
                      "$ref": "contract#/definitions/ConciergeRequest"
                  }
              },
              "nextCursor": {
                  "type": [
                      "string",
                      "null"
                  ]
              }
          }
      },
      "ConciergeRequest": {
          "type": "object",
          "description": "Заявка консьержу в очереди панели: что искать, где, на какой бюджет и кому перезвонить.",
          "properties": {
              "id": {
                  "type": "string"
              },
              "status": {
                  "type": "string",
                  "enum": [
                      "new",
                      "in_progress",
                      "done",
                      "cancelled"
                  ]
              },
              "categoryId": {
                  "type": "string"
              },
              "categoryName": {
                  "type": "string",
                  "description": "название категории из справочника"
              },
              "city": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "город поиска; пусто — заявка без города"
              },
              "budget": {
                  "allOf": [
                      {
                          "$ref": "contract#/definitions/Money"
                      }
                  ],
                  "type": [
                      "object",
                      "array",
                      "string",
                      "number",
                      "boolean",
                      "null"
                  ]
              },
              "comment": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "phone": {
                  "type": "string",
                  "description": "номер входа пары — она попросила связаться; сотрудник звонит по нему"
              },
              "name": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "имя пары из профиля"
              },
              "createdAt": {
                  "type": "string",
                  "format": "date-time",
                  "description": "когда подана — от неё считаются сутки"
              }
          }
      },
      "DayXBroadcast": {
          "type": "object",
          "description": "Ответ на «+15 мин» и активацию плана Б.",
          "properties": {
              "minutes": {
                  "type": "integer",
                  "description": "только у сдвига"
              },
              "shiftedBlocks": {
                  "type": "integer",
                  "description": "только у сдвига — сколько блоков сдвинуто"
              },
              "scenario": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "только у плана Б"
              },
              "guestsAffected": {
                  "type": "integer",
                  "description": "Скольких гостей (ответивших «да») касается — им сообщает команда.\nПоле `notifiedGuests` (всегда 0, канала до гостей нет) снято в v0.30.0.\n"
              }
          }
      },
      "Deal": {
          "type": "object",
          "description": "Договорённость пары с конкретным исполнителем на конкретный слот.\nНоситель состояния: у слота собственного статуса нет (решение владельца\n2026-09-02) — раньше слот, сделка и фронтенд описывали одно понятие тремя\nразными наборами значений.\n",
          "properties": {
              "id": {
                  "type": "string"
              },
              "state": {
                  "$ref": "contract#/definitions/DealState"
              },
              "vendor": {
                  "allOf": [
                      {
                          "$ref": "contract#/definitions/Vendor"
                      }
                  ],
                  "description": "null у своего подрядчика не из каталога (§11)",
                  "type": [
                      "object",
                      "array",
                      "string",
                      "number",
                      "boolean",
                      "null"
                  ]
              },
              "externalName": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "имя своего подрядчика"
              },
              "externalPhone": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "packageName": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "Снимок принятого названия, только couple: текст может содержать цену.\nУдаление живого пакета/предложения не меняет его. null — название неизвестно.\n"
              },
              "packageIncludes": {
                  "type": [
                      "array",
                      "null"
                  ],
                  "items": {
                      "type": "string"
                  },
                  "description": "Снимок состава, только couple; null — состав неизвестен, [] — известный пустой состав."
              },
              "price": {
                  "$ref": "contract#/definitions/Money"
              },
              "paid": {
                  "allOf": [
                      {
                          "$ref": "contract#/definitions/Money"
                      }
                  ],
                  "description": "Сколько уже внесено по этой сделке: платежи `deposit` и `balance`\nминус возвраты, без отменённых. Считается на лету, в базе не\nхранится (§3.1: производное значение расходится с источником).\n\nБез него «оплачено 30 000 из 50 000» показать нечем, и человек\nдержит остаток долга в голове. Уходит вместе с ценой — тому, кто\nвидит деньги: помощник и координатор не видят ни того, ни другого.\n"
              },
              "paidAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time",
                  "description": "дата последнего платежа. Пусто — платежей не было"
              },
              "negotiatingUntil": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time",
                  "description": "срок мягкой брони: 72 ч на этапе negotiating (§18.3)"
              },
              "bookedAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time"
              },
              "doneAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time"
              },
              "cancelledAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time"
              }
          }
      },
      "DealState": {
          "type": "string",
          "description": "Шесть состояний сделки (План §8.1, решение владельца 2026-09-02).\nМягкая бронь на 72 часа — не отдельное состояние, а срок жизни `negotiating` (§18.3).\n",
          "enum": [
              "candidate",
              "contacted",
              "negotiating",
              "booked",
              "paid_deposit",
              "done",
              "cancelled"
          ]
      },
      "Document": {
          "type": "object",
          "properties": {
              "id": {
                  "type": "string"
              },
              "dealId": {
                  "type": "string"
              },
              "templateCode": {
                  "type": "string"
              },
              "version": {
                  "type": "integer"
              },
              "status": {
                  "type": "string",
                  "enum": [
                      "draft",
                      "sent",
                      "signed"
                  ]
              },
              "pdfUrl": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "Появляется после подключения объектного хранилища. До тех пор\nдоговор существует как запись с полями и версией, но файла нет:\nвыдать ссылку в никуда хуже, чем честно вернуть null.\n"
              },
              "docxUrl": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "fields": {
                  "type": "object",
                  "additionalProperties": true,
                  "description": "Подставленные значения: стороны, дата, сумма, город."
              },
              "createdAt": {
                  "type": "string",
                  "format": "date-time"
              }
          }
      },
      "Error": {
          "type": "object",
          "properties": {
              "error": {
                  "type": "object",
                  "properties": {
                      "code": {
                          "type": "string"
                      },
                      "message": {
                          "type": "string"
                      },
                      "fields": {
                          "type": "object",
                          "additionalProperties": {
                              "type": "string"
                          },
                          "description": "Только у 422: какие именно поля не прошли проверку.\nКлюч — имя поля (`reason`, `action`, `synonyms.тамада`),\nзначение — что с ним не так. Человеку показывается `message`,\nполя подсвечивает форма.\n"
                      },
                      "details": {
                          "type": "object",
                          "additionalProperties": true,
                          "description": "Машинные подробности отказа там, где экрану нужно больше кода:\nу 409 `wedding_exists` — `weddingId` живой свадьбы пары (фича 005).\n"
                      }
                  }
              }
          }
      },
      "Fund": {
          "type": "object",
          "properties": {
              "id": {
                  "type": "string"
              },
              "name": {
                  "type": "string"
              },
              "icon": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 16
              },
              "target": {
                  "$ref": "contract#/definitions/Money"
              },
              "collected": {
                  "$ref": "contract#/definitions/Money"
              }
          }
      },
      "Gift": {
          "type": "object",
          "properties": {
              "id": {
                  "type": "string"
              },
              "name": {
                  "type": "string"
              },
              "icon": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 16,
                  "description": "Значок подарка (§9). Плитка (`tile` в моках) сюда не входит: это\nцвет из палитры, он считается на клиенте по месту в списке —\nдизайн-токен, а не данные.\n"
              },
              "desc": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "price": {
                  "$ref": "contract#/definitions/Money"
              },
              "group": {
                  "type": "boolean",
                  "description": "можно скидываться"
              },
              "funded": {
                  "$ref": "contract#/definitions/Money"
              },
              "reserved": {
                  "type": "boolean",
                  "description": "кем именно — паре не отдаётся никогда"
              },
              "mine": {
                  "type": "boolean",
                  "readOnly": true,
                  "description": "Резерв поставлен ЭТИМ гостем. Только в гостевом ответе; паре поле\nне отдаётся вовсе — иначе «занято мной» на её экране и означало бы\nтого самого гостя, которого §9 обещает не показывать.\n"
              }
          }
      },
      "Guest": {
          "type": "object",
          "properties": {
              "id": {
                  "type": "string"
              },
              "name": {
                  "type": "string"
              },
              "partyId": {
                  "type": "string",
                  "format": "uuid",
                  "readOnly": true,
                  "description": "одно семейное приглашение для 1–10 персон"
              },
              "partyPosition": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 10,
                  "readOnly": true
              },
              "partySize": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 10,
                  "readOnly": true,
                  "description": "текущее число персон в семейном приглашении"
              },
              "isPrimary": {
                  "type": "boolean",
                  "readOnly": true,
                  "description": "только у primary показывается inviteUrl"
              },
              "isPlaceholder": {
                  "type": "boolean",
                  "readOnly": true,
                  "description": "системное имя, созданное из старого +1; пара может переименовать"
              },
              "plusOne": {
                  "type": "boolean",
                  "description": "переходное поле: true у primary, если в party больше одной персоны; новые клиенты используют partyId/отдельные строки"
              },
              "group": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "phone": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "Для напоминаний по SMS; вводит пара. Видит только пара (152-ФЗ,\nминимизация): помощнику и координатору поле не приходит —\nу них есть `hasPhone`.\n"
              },
              "hasPhone": {
                  "type": "boolean",
                  "description": "телефон записан — для ролей, которым сам номер не показывается"
              },
              "comment": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "Что гость написал в RSVP (`POST /join/{guestToken}`). Только паре —\nдо фичи 005 писалось и нигде не читалось (D3-25).\n"
              },
              "status": {
                  "type": "string",
                  "enum": [
                      "yes",
                      "no",
                      "pending"
                  ]
              },
              "tableId": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "diet": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "enum": [
                      null,
                      "vegetarian",
                      "vegan",
                      "halal",
                      "kosher",
                      "gluten_free",
                      "other"
                  ],
                  "description": "RSVP+ — ограничения по еде"
              },
              "dietNote": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "аллергии словами, когда enum не хватает"
              },
              "menuOptionId": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "выбор в опросе меню"
              },
              "transfer": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "enum": [
                      null,
                      "need",
                      "own"
                  ],
                  "description": "нужен ли трансфер"
              },
              "busId": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "посажен в этот автобус"
              },
              "hotelId": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "inviteUrl": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "ОДНОРАЗОВАЯ ссылка-приглашение для этого гостя. Пара её пересылает; при первом открытии код обменивается на персональный guestToken и гаснет. Сырой guestToken паре не отдаётся НИКОГДА — иначе пара может открыть гостевую страницу и увидеть его резерв подарка, что ломает анонимность (§9 бизнес-логики)"
              },
              "inviteUrlUsed": {
                  "type": "boolean",
                  "readOnly": true,
                  "description": "true — гость уже открыл ссылку. Чтобы выдать новую, нужен POST …/invite-link"
              }
          }
      },
      "GuestPersonRsvp": {
          "type": "object",
          "required": [
              "guestId",
              "name",
              "status"
          ],
          "properties": {
              "guestId": {
                  "type": "string",
                  "format": "uuid"
              },
              "name": {
                  "type": "string"
              },
              "status": {
                  "type": "string",
                  "enum": [
                      "yes",
                      "no",
                      "pending"
                  ]
              },
              "diet": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "enum": [
                      null,
                      "vegetarian",
                      "vegan",
                      "halal",
                      "kosher",
                      "gluten_free",
                      "other"
                  ]
              },
              "dietNote": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "transfer": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "enum": [
                      null,
                      "need",
                      "own"
                  ]
              },
              "isPlaceholder": {
                  "type": "boolean",
                  "readOnly": true
              }
          }
      },
      "HotelBlock": {
          "type": "object",
          "properties": {
              "id": {
                  "type": "string"
              },
              "name": {
                  "type": "string"
              },
              "rooms": {
                  "type": "integer"
              },
              "booked": {
                  "type": "integer"
              },
              "price": {
                  "$ref": "contract#/definitions/Money"
              },
              "deadline": {
                  "type": "string",
                  "format": "date"
              },
              "promo": {
                  "type": "string"
              },
              "mine": {
                  "type": "boolean",
                  "readOnly": true,
                  "description": "Только в `GET /join/{guestToken}/hotels`: гость уже занял номер\nв этом блоке. Без признака гость не видел своей брони и тап по\nдругому блоку переносил её молча (D3-15).\n"
              }
          }
      },
      "InviteLink": {
          "type": "object",
          "properties": {
              "code": {
                  "type": "string"
              },
              "url": {
                  "type": "string"
              },
              "role": {
                  "type": "string",
                  "enum": [
                      "couple",
                      "helper",
                      "coordinator",
                      "vendor"
                  ]
              },
              "label": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "expiresAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "used": {
                  "type": "boolean"
              }
          }
      },
      "Lead": {
          "type": "object",
          "properties": {
              "id": {
                  "type": "string"
              },
              "coupleName": {
                  "type": "string"
              },
              "weddingDate": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date"
              },
              "city": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "message": {
                  "type": "string"
              },
              "status": {
                  "type": "string",
                  "enum": [
                      "new",
                      "replied",
                      "hold",
                      "declined",
                      "won"
                  ]
              },
              "holdUntil": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time"
              },
              "createdAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "chatId": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "Чат пары с этим подрядчиком — тот же, что открыло «Написать» пары\nи в который уходит ответ на заявку. Кабинет ведёт из заявки прямо в\nпереписку (фича 007). null — у заявки без чата (выигранная без\nпереписки).\n"
              }
          }
      },
      "Member": {
          "type": "object",
          "description": "Член свадьбы — тот, у кого есть аккаунт и доступ в приложение. Гость (guest) и свой подрядчик (guest-vendor) членами НЕ являются: они опознаются токеном по ссылке, аккаунта не имеют и в members не попадают. Матрица доступа (§4 плана) описывает все шесть ролей, эта схема — только четыре с аккаунтом.\n",
          "properties": {
              "user": {
                  "$ref": "contract#/definitions/User"
              },
              "role": {
                  "type": "string",
                  "enum": [
                      "couple",
                      "helper",
                      "coordinator",
                      "vendor"
                  ]
              },
              "joinedAt": {
                  "type": "string",
                  "format": "date-time"
              }
          }
      },
      "MenuPoll": {
          "type": "object",
          "required": [
              "options"
          ],
          "properties": {
              "question": {
                  "type": "string"
              },
              "sentAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time",
                  "readOnly": true,
                  "description": "когда сводка ушла кейтерингу (POST …/menu-poll/remind); null — ещё не уходила"
              },
              "expectedPortions": {
                  "type": "integer",
                  "readOnly": true,
                  "description": "На сколько ПЕРСОН готовить. Считается по подтвердившим гостям:\nзапись с «+1» — двое. Кейтерингу нужны порции, а не строки\nсписка, и считать их на клиенте значит получить два разных\nответа на разных экранах.\n"
              },
              "options": {
                  "type": "array",
                  "items": {
                      "type": "object",
                      "properties": {
                          "id": {
                              "type": "string"
                          },
                          "name": {
                              "type": "string"
                          },
                          "icon": {
                              "type": "string"
                          },
                          "votes": {
                              "type": "integer"
                          }
                      }
                  }
              }
          }
      },
      "Message": {
          "type": "object",
          "properties": {
              "id": {
                  "type": "string"
              },
              "chatId": {
                  "type": "string"
              },
              "senderId": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "null — сообщение не от пользователя приложения: ответ Тиль, системная запись или, в чате со своим подрядчиком (§11), сам подрядчик — аккаунта у него нет. Системных записей в таком чате не бывает, поэтому там пустой отправитель однозначно означает подрядчика.\n"
              },
              "text": {
                  "type": "string"
              },
              "attachmentUrl": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "sentAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "system": {
                  "type": "boolean",
                  "description": "Системная запись (сдвиг тайминга, перенос даты, «участник вышел»)\n— не реплика человека. Экран рисует её по признаку, а не угадывает\nпо тексту (D4-15). У ответа Тиль, реплик своего подрядчика и гостей — false.\n"
              },
              "guestName": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "Имя гостя, если реплику написал гость по своей ссылке в чат дня X\n(фича 009): у гостя нет аккаунта, `senderId` пуст, имя — из списка\nгостей. У остальных реплик — null.\n"
              },
              "mine": {
                  "type": [
                      "boolean",
                      "null"
                  ],
                  "description": "Своя ли это реплика для того, кто читает (фича 014). Участнику —\nпо `senderId`, гостю в чате дня — по его строке в списке гостей:\nу гостя нет идентификатора аккаунта, и сравнивать имена (две\nМарины) экран не должен. Считает сервер. `null` — читатель\nнеизвестен (реплика пришла живым каналом всем сразу): экран\nучастника тогда решает по `senderId`.\n"
              },
              "warning": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "readOnly": true,
                  "description": "Мягкое предупреждение о выводе сделки мимо платформы (§18.2):\nсообщение ДОСТАВЛЕНО, но обе стороны видят плашку и системную\nзапись в чате. Блокировать нельзя — разговор просто уйдёт\nв мессенджер, где нет ни договора, ни эскроу, ни следа\nдля разбирательства.\n"
              }
          }
      },
      "ModerationVendor": {
          "allOf": [
              {
                  "$ref": "contract#/definitions/Vendor"
              },
              {
                  "type": "object",
                  "properties": {
                      "createdAt": {
                          "type": "string",
                          "format": "date-time",
                          "description": "когда анкета заведена"
                      },
                      "publishedAt": {
                          "type": [
                              "string",
                              "null"
                          ],
                          "format": "date-time",
                          "description": "Когда анкета опубликована. Именно от этой даты считается срок\nпроверки, и именно её показывает очередь: дата заведения\nу анкеты, пролежавшей месяц в черновике, ответила бы не на тот вопрос.\n"
                      }
                  }
              }
          ]
      },
      "ModerationVendorPage": {
          "type": "object",
          "properties": {
              "items": {
                  "type": "array",
                  "items": {
                      "$ref": "contract#/definitions/ModerationVendor"
                  }
              },
              "nextCursor": {
                  "type": [
                      "string",
                      "null"
                  ]
              }
          }
      },
      "Money": {
          "type": "object",
          "description": "Денежная сумма. Решение владельца 2026-09-02: минорные единицы плюс код\nвалюты у КАЖДОЙ суммы, а не одна валюта на свадьбу — план §19.7 описывает\nсвадьбу за границей, где сделка в евро, а бюджет в рублях.\nВ MVP принимается только RUB; enum расширяется вместе с поддержкой курсов.\n",
          "required": [
              "amount",
              "currency"
          ],
          "properties": {
              "amount": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991,
                  "description": "Сумма в копейках. 85 000 ₽ = 8500000. Дробных значений не бывает.\nПотолок — предел точного целого в JSON: за ним число молча\nокругляется, и «потрачено» перестаёт сходиться с суммой сделок.\n"
              },
              "currency": {
                  "type": "string",
                  "description": "Код валюты по ISO 4217.",
                  "enum": [
                      "RUB"
                  ]
              }
          }
      },
      "Note": {
          "type": "object",
          "description": "Заметка команды свадьбы (фича 014). Автор — по имени из профиля; удалённый аккаунт — null.",
          "required": [
              "id",
              "text",
              "createdAt"
          ],
          "properties": {
              "id": {
                  "type": "string"
              },
              "text": {
                  "type": "string"
              },
              "authorName": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "createdAt": {
                  "type": "string",
                  "format": "date-time"
              }
          }
      },
      "Notification": {
          "type": "object",
          "properties": {
              "id": {
                  "type": "string"
              },
              "title": {
                  "type": "string"
              },
              "body": {
                  "type": "string"
              },
              "kind": {
                  "type": "string",
                  "enum": [
                      "deal",
                      "chat",
                      "task",
                      "guest",
                      "system"
                  ]
              },
              "link": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "Место, а не маршрут приложения: `/deal/{dealId}`, `/chats/{chatId}`,\n`/guests`, `/checklist`, `/dayx`, `/vendor-app`. У пары и у\nподрядчика одно и то же место лежит по разным адресам, поэтому\nперевод в маршрут делает клиент. Незнакомое место никуда не ведёт.\n"
              },
              "read": {
                  "type": "boolean"
              },
              "createdAt": {
                  "type": "string",
                  "format": "date-time"
              }
          }
      },
      "Offer": {
          "description": "Точная публичная форма одной версии ответа: оба варианта имеют ровно\nдевять полей. У `decline` поля предложения равны только `null`, а\n`includes` строго пуст; у `offer` название, положительная цена и срок\nне могут быть `null`.\n",
          "oneOf": [
              {
                  "type": "object",
                  "title": "Предложение",
                  "required": [
                      "id",
                      "requestId",
                      "kind",
                      "packageId",
                      "title",
                      "price",
                      "includes",
                      "message",
                      "validUntil"
                  ],
                  "additionalProperties": false,
                  "properties": {
                      "id": {
                          "type": "string",
                          "format": "uuid"
                      },
                      "requestId": {
                          "type": "string",
                          "format": "uuid"
                      },
                      "kind": {
                          "type": "string",
                          "enum": [
                              "offer"
                          ]
                      },
                      "packageId": {
                          "type": [
                              "string",
                              "null"
                          ],
                          "format": "uuid"
                      },
                      "title": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 200
                      },
                      "price": {
                          "$ref": "contract#/definitions/PositiveMoney"
                      },
                      "includes": {
                          "type": "array",
                          "maxItems": 40,
                          "items": {
                              "type": "string",
                              "maxLength": 200
                          }
                      },
                      "message": {
                          "type": [
                              "string",
                              "null"
                          ],
                          "maxLength": 2000
                      },
                      "validUntil": {
                          "type": "string",
                          "format": "date",
                          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
                      }
                  }
              },
              {
                  "type": "object",
                  "title": "Отказ",
                  "required": [
                      "id",
                      "requestId",
                      "kind",
                      "packageId",
                      "title",
                      "price",
                      "includes",
                      "message",
                      "validUntil"
                  ],
                  "additionalProperties": false,
                  "properties": {
                      "id": {
                          "type": "string",
                          "format": "uuid"
                      },
                      "requestId": {
                          "type": "string",
                          "format": "uuid"
                      },
                      "kind": {
                          "type": "string",
                          "enum": [
                              "decline"
                          ]
                      },
                      "packageId": {
                          "type": [
                              "string",
                              "null"
                          ],
                          "format": "uuid",
                          "enum": [
                              null
                          ]
                      },
                      "title": {
                          "type": [
                              "string",
                              "null"
                          ],
                          "enum": [
                              null
                          ]
                      },
                      "price": {
                          "type": [
                              "object",
                              "null"
                          ],
                          "enum": [
                              null
                          ]
                      },
                      "includes": {
                          "type": "array",
                          "minItems": 0,
                          "maxItems": 0,
                          "items": {
                              "type": "string"
                          }
                      },
                      "message": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2000
                      },
                      "validUntil": {
                          "type": [
                              "string",
                              "null"
                          ],
                          "format": "date",
                          "enum": [
                              null
                          ]
                      }
                  }
              }
          ]
      },
      "OfferInput": {
          "description": "Пакет, своё предложение или отказ — ровно одна из трёх строгих форм.",
          "oneOf": [
              {
                  "type": "object",
                  "title": "Ответ пакетом анкеты",
                  "required": [
                      "kind",
                      "packageId",
                      "price"
                  ],
                  "additionalProperties": false,
                  "properties": {
                      "kind": {
                          "type": "string",
                          "enum": [
                              "offer"
                          ]
                      },
                      "packageId": {
                          "type": "string",
                          "format": "uuid"
                      },
                      "price": {
                          "$ref": "contract#/definitions/PositiveMoney"
                      },
                      "message": {
                          "type": "string",
                          "maxLength": 2000
                      },
                      "validUntil": {
                          "type": "string",
                          "format": "date",
                          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
                      }
                  }
              },
              {
                  "type": "object",
                  "title": "Собственное предложение",
                  "required": [
                      "kind",
                      "title",
                      "price",
                      "includes"
                  ],
                  "additionalProperties": false,
                  "properties": {
                      "kind": {
                          "type": "string",
                          "enum": [
                              "offer"
                          ]
                      },
                      "title": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 200
                      },
                      "price": {
                          "$ref": "contract#/definitions/PositiveMoney"
                      },
                      "includes": {
                          "type": "array",
                          "maxItems": 40,
                          "items": {
                              "type": "string",
                              "maxLength": 200
                          }
                      },
                      "message": {
                          "type": "string",
                          "maxLength": 2000
                      },
                      "validUntil": {
                          "type": "string",
                          "format": "date",
                          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
                      }
                  }
              },
              {
                  "type": "object",
                  "title": "Отказ",
                  "required": [
                      "kind",
                      "message"
                  ],
                  "additionalProperties": false,
                  "properties": {
                      "kind": {
                          "type": "string",
                          "enum": [
                              "decline"
                          ]
                      },
                      "message": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2000
                      }
                  }
              }
          ]
      },
      "OfferPublic": {
          "type": "object",
          "description": "Безопасный статус для помощника и координатора без условий и ответа подрядчика.",
          "required": [
              "status"
          ],
          "additionalProperties": false,
          "properties": {
              "status": {
                  "type": "string",
                  "enum": [
                      "pending",
                      "responded"
                  ]
              }
          }
      },
      "OfferRequest": {
          "type": "object",
          "description": "Условия свадьбы, зафиксированные в момент отправки запроса этому подрядчику.",
          "required": [
              "id",
              "status",
              "weddingDate",
              "guests",
              "city",
              "wishes",
              "createdAt"
          ],
          "additionalProperties": false,
          "properties": {
              "id": {
                  "type": "string",
                  "format": "uuid"
              },
              "status": {
                  "type": "string",
                  "enum": [
                      "open",
                      "closed"
                  ]
              },
              "closeReason": {
                  "type": "string",
                  "enum": [
                      "removed",
                      "booked_other",
                      "booked",
                      "wedding_cancelled",
                      "date_changed",
                      "vendor_erased"
                  ]
              },
              "weddingDate": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date",
                  "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
              },
              "guests": {
                  "type": [
                      "integer",
                      "null"
                  ],
                  "minimum": 0,
                  "maximum": 5000
              },
              "city": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "minLength": 1,
                  "maxLength": 200
              },
              "wishes": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 2000
              },
              "createdAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "budgetHint": {
                  "$ref": "contract#/definitions/PositiveMoney"
              },
              "offer": {
                  "$ref": "contract#/definitions/Offer"
              }
          }
      },
      "PositiveMoney": {
          "type": "object",
          "description": "Положительная сумма в копейках; в 019 принимается только RUB.",
          "required": [
              "amount",
              "currency"
          ],
          "additionalProperties": false,
          "properties": {
              "amount": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
              },
              "currency": {
                  "type": "string",
                  "enum": [
                      "RUB"
                  ]
              }
          }
      },
      "PrebookedCategory": {
          "type": "string",
          "enum": [
              "venue",
              "photo",
              "video",
              "host"
          ],
          "description": "Категория слота шаблона, подрядчик которой уже найден вне приложения (фича 018): площадка, фотограф, видеограф, ведущий."
      },
      "Readiness": {
          "type": "object",
          "properties": {
              "status": {
                  "type": "string",
                  "enum": [
                      "ok",
                      "not_ready"
                  ]
              },
              "db": {
                  "type": "string",
                  "enum": [
                      "up",
                      "down"
                  ]
              },
              "redis": {
                  "type": "string",
                  "enum": [
                      "up",
                      "down"
                  ]
              }
          }
      },
      "Review": {
          "type": "object",
          "properties": {
              "id": {
                  "type": "string"
              },
              "source": {
                  "type": "string",
                  "enum": [
                      "couple",
                      "guest"
                  ],
                  "description": "Пара со сделкой или гость свадьбы: в рейтинге веса разные (§15)."
              },
              "authorName": {
                  "type": "string"
              },
              "rating": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 5
              },
              "text": {
                  "type": "string"
              },
              "createdAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "reply": {
                  "type": [
                      "object",
                      "null"
                  ],
                  "properties": {
                      "text": {
                          "type": "string"
                      },
                      "createdAt": {
                          "type": "string",
                          "format": "date-time"
                      }
                  }
              }
          }
      },
      "Session": {
          "type": "object",
          "properties": {
              "id": {
                  "type": "string"
              },
              "device": {
                  "type": "string"
              },
              "current": {
                  "type": "boolean"
              },
              "createdAt": {
                  "type": "string",
                  "format": "date-time"
              }
          }
      },
      "ShortlistEntry": {
          "type": "object",
          "required": [
              "id",
              "slotId",
              "position",
              "createdAt",
              "available",
              "occupancy",
              "vendor"
          ],
          "additionalProperties": false,
          "properties": {
              "id": {
                  "type": "string",
                  "format": "uuid",
                  "description": "Стабильный id записи шорт-листа; по нему запись удаляется."
              },
              "slotId": {
                  "type": "string",
                  "format": "uuid"
              },
              "position": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 3
              },
              "createdAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "available": {
                  "type": [
                      "boolean",
                      "null"
                  ],
                  "description": "`true` — живая анкета той же категории; `false` — анкета скрыта,\nзаблокирована или сменила категорию; `null` — обезличенный tombstone.\n"
              },
              "occupancy": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "enum": [
                      "free",
                      "held",
                      "busy",
                      null
                  ],
                  "description": "Занятость на дату свадьбы. `null` — дата не выбрана или анкета стёрта;\nсвоя бронь этой свадьбы считается `free`.\n"
              },
              "request": {
                  "description": "Паре — полный запрос с действующим ответом, если он уже есть;\nпомощнику и координатору — только обезличенный статус. Поля нет,\nпока пара не отправила запрос этому кандидату.\n",
                  "oneOf": [
                      {
                          "$ref": "contract#/definitions/OfferRequest"
                      },
                      {
                          "$ref": "contract#/definitions/OfferPublic"
                      }
                  ]
              },
              "vendor": {
                  "type": [
                      "object",
                      "null"
                  ],
                  "required": [
                      "id",
                      "name",
                      "categoryId",
                      "city",
                      "priceFrom",
                      "rating",
                      "reviewsCount",
                      "photoUrl",
                      "verified",
                      "hasVideo",
                      "packages"
                  ],
                  "additionalProperties": false,
                  "description": "Публичная карточка кандидата. `null` — подрядчик стёрт: прежние id,\nимя и другие данные не возвращаются. У скрытой/заблокированной анкеты\nмедиа, цены и пакеты не возвращаются.\n",
                  "properties": {
                      "id": {
                          "type": "string",
                          "format": "uuid"
                      },
                      "name": {
                          "type": "string"
                      },
                      "categoryId": {
                          "type": "string"
                      },
                      "city": {
                          "type": [
                              "string",
                              "null"
                          ]
                      },
                      "priceFrom": {
                          "allOf": [
                              {
                                  "$ref": "contract#/definitions/Money"
                              }
                          ],
                          "type": [
                              "object",
                              "array",
                              "string",
                              "number",
                              "boolean",
                              "null"
                          ]
                      },
                      "rating": {
                          "type": [
                              "number",
                              "null"
                          ]
                      },
                      "reviewsCount": {
                          "type": "integer",
                          "minimum": 0
                      },
                      "photoUrl": {
                          "type": [
                              "string",
                              "null"
                          ]
                      },
                      "verified": {
                          "type": "boolean"
                      },
                      "hasVideo": {
                          "type": "boolean"
                      },
                      "packages": {
                          "type": "array",
                          "items": {
                              "$ref": "contract#/definitions/VendorPackage"
                          }
                      }
                  }
              }
          }
      },
      "Slot": {
          "type": "object",
          "description": "Место в команде свадьбы. Слот либо пуст, либо несёт сделку — собственного\nстатуса у него нет. tileState — производная подпись для мозаики команды,\nтолько для чтения: клиент не должен вычислять её сам, чтобы экраны не\nразошлись между собой. Пустой слот может нести отметку `prebooked`\n(«уже забронировано вне приложения», фича 018) — она приходит всегда.\n",
          "required": [
              "prebooked"
          ],
          "properties": {
              "id": {
                  "type": "string"
              },
              "categoryId": {
                  "type": "string"
              },
              "label": {
                  "type": "string",
                  "readOnly": true,
                  "description": "подпись плитки в мозаике («Фотограф», «Площадка») — из шаблона слотов сервера"
              },
              "deal": {
                  "allOf": [
                      {
                          "$ref": "contract#/definitions/Deal"
                      }
                  ],
                  "description": "null = слот пуст",
                  "type": [
                      "object",
                      "array",
                      "string",
                      "number",
                      "boolean",
                      "null"
                  ]
              },
              "tileState": {
                  "type": "string",
                  "readOnly": true,
                  "description": "производное от deal.state для плитки в мозаике",
                  "enum": [
                      "empty",
                      "candidate",
                      "hold",
                      "booked",
                      "paid"
                  ]
              },
              "prebooked": {
                  "type": "boolean",
                  "readOnly": true,
                  "description": "Пара ответила в квизе, что подрядчик этой категории уже найден вне\nприложения (`POST /weddings`, поле `prebooked`). Бывает только у\nслота без сделки — это держит ограничение базы: бронь из каталога и\nсвой подрядчик снимают отметку той же операцией. Снять вручную —\n`DELETE …/slots/{slotId}/prebooked`. Счётчики готовности и подсказки\nТиля (`GET …/tips`) считают такой слот забронированным, а `tileState`\nостаётся производной от сделки — `empty`.\n"
              }
          }
      },
      "SupportDeal": {
          "type": "object",
          "description": "Сделка глазами поддержки (фича 013): только то, что нужно для разбора\nспора о деньгах. Имена — есть, телефонов и переписки — нет.\n",
          "required": [
              "id",
              "slotLabel",
              "categoryId",
              "state",
              "paid",
              "events"
          ],
          "properties": {
              "id": {
                  "type": "string"
              },
              "slotLabel": {
                  "type": "string",
                  "description": "подпись слота на мозаике пары («Фотограф»)"
              },
              "categoryId": {
                  "type": "string"
              },
              "vendorName": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "анкета каталога; null у своего подрядчика"
              },
              "externalName": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "свой подрядчик пары (§11); null у сделки из каталога"
              },
              "state": {
                  "$ref": "contract#/definitions/DealState"
              },
              "price": {
                  "allOf": [
                      {
                          "$ref": "contract#/definitions/Money"
                      }
                  ],
                  "type": [
                      "object",
                      "array",
                      "string",
                      "number",
                      "boolean",
                      "null"
                  ]
              },
              "paid": {
                  "allOf": [
                      {
                          "$ref": "contract#/definitions/Money"
                      }
                  ],
                  "description": "оплачено по платежам (возвраты вычтены, отменённые не считаются) — та же формула, что у пары и подрядчика"
              },
              "bookedAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time"
              },
              "cancelledAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time"
              },
              "events": {
                  "type": "array",
                  "description": "история состояний по времени: кто (couple | vendor | system), откуда, куда, заметка",
                  "items": {
                      "type": "object",
                      "required": [
                          "at",
                          "by",
                          "toState"
                      ],
                      "properties": {
                          "at": {
                              "type": "string",
                              "format": "date-time"
                          },
                          "by": {
                              "type": "string",
                              "enum": [
                                  "couple",
                                  "vendor",
                                  "system"
                              ]
                          },
                          "fromState": {
                              "type": [
                                  "string",
                                  "null"
                              ]
                          },
                          "toState": {
                              "type": "string"
                          },
                          "note": {
                              "type": [
                                  "string",
                                  "null"
                              ]
                          }
                      }
                  }
              }
          }
      },
      "Table": {
          "type": "object",
          "properties": {
              "id": {
                  "type": "string"
              },
              "name": {
                  "type": "string"
              },
              "capacity": {
                  "type": "integer",
                  "default": 8
              },
              "guestIds": {
                  "type": "array",
                  "items": {
                      "type": "string"
                  }
              }
          }
      },
      "Task": {
          "type": "object",
          "properties": {
              "id": {
                  "type": "string"
              },
              "title": {
                  "type": "string"
              },
              "period": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "done": {
                  "type": "boolean"
              },
              "custom": {
                  "type": "boolean"
              },
              "due": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date",
                  "description": "Срок задачи. Relative двигается вместе с датой свадьбы; fixed сохраняет выбранную дату, в том числе отсутствие срока."
              },
              "dueMode": {
                  "type": "string",
                  "enum": [
                      "relative",
                      "fixed"
                  ]
              },
              "assignee": {
                  "type": [
                      "object",
                      "null"
                  ],
                  "properties": {
                      "userId": {
                          "type": "string",
                          "format": "uuid"
                      },
                      "name": {
                          "type": [
                              "string",
                              "null"
                          ]
                      }
                  }
              },
              "reminderDaysBefore": {
                  "type": [
                      "integer",
                      "null"
                  ],
                  "minimum": 0,
                  "maximum": 30,
                  "description": "Напомнить ответственному за N календарных дней до срока; 0 — в день срока, null — выключено. Для включения нужны срок и ответственный. Снятие срока или назначения выключает напоминание."
              },
              "reminderTime": {
                  "type": "string",
                  "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$",
                  "description": "Время по поясу ответственного (профиль → свадьба → Москва), по умолчанию 09:00. Тихие часы и настройки уведомлений имеют приоритет."
              }
          }
      },
      "TaskCreate": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "title",
              "period"
          ],
          "properties": {
              "title": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 300
              },
              "period": {
                  "type": "string",
                  "maxLength": 40,
                  "description": "Число месяцев 0–120 до свадьбы или произвольная подпись периода без вычисленного срока."
              },
              "due": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date"
              },
              "dueMode": {
                  "type": "string",
                  "enum": [
                      "relative",
                      "fixed"
                  ],
                  "description": "Без явной даты — relative; с явной датой или null — fixed по умолчанию. Relative с точной датой требует даты свадьбы."
              },
              "assigneeId": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "uuid"
              },
              "reminderDaysBefore": {
                  "type": [
                      "integer",
                      "null"
                  ],
                  "minimum": 0,
                  "maximum": 30,
                  "description": "Напомнить ответственному за N календарных дней до срока; 0 — в день срока, null — выключено. Для включения нужны срок и ответственный. Снятие срока или назначения выключает напоминание."
              },
              "reminderTime": {
                  "type": "string",
                  "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$",
                  "description": "Время по поясу ответственного (профиль → свадьба → Москва), по умолчанию 09:00. Тихие часы и настройки уведомлений имеют приоритет."
              }
          }
      },
      "TaskPatch": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
              "title": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 300
              },
              "done": {
                  "type": "boolean"
              },
              "due": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date",
                  "description": "Пропуск сохраняет срок; null снимает срок. Явное значение без dueMode переключает в fixed."
              },
              "dueMode": {
                  "type": "string",
                  "enum": [
                      "relative",
                      "fixed"
                  ],
                  "description": "Relative без due пересчитывает срок по периоду и дате свадьбы; fixed без due сохраняет дату."
              },
              "assigneeId": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "uuid",
                  "description": "Живой участник этой свадьбы с ролью couple/helper/coordinator. Null снимает назначение; пропуск сохраняет."
              },
              "reminderDaysBefore": {
                  "type": [
                      "integer",
                      "null"
                  ],
                  "minimum": 0,
                  "maximum": 30,
                  "description": "Напомнить ответственному за N календарных дней до срока; 0 — в день срока, null — выключено. Для включения нужны срок и ответственный. Снятие срока или назначения выключает напоминание."
              },
              "reminderTime": {
                  "type": "string",
                  "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$",
                  "description": "Время по поясу ответственного (профиль → свадьба → Москва), по умолчанию 09:00. Тихие часы и настройки уведомлений имеют приоритет."
              }
          }
      },
      "TimelineEvent": {
          "type": "object",
          "properties": {
              "id": {
                  "type": "string"
              },
              "name": {
                  "type": "string"
              },
              "location": {
                  "type": "string"
              },
              "startsAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "endsAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "who": {
                  "type": "string",
                  "description": "кто отвечает"
              },
              "icon": {
                  "type": "string",
                  "description": "Значок блока. Приходит с сервера, потому что шаблон тайминга\nсобирается там при создании свадьбы: клиент не знает, что «Сборы\nневесты» — это рассвет, а «Первый танец» — музыка, и подбирать\nзначок по названию значит гадать по строке.\n"
              },
              "outdoor": {
                  "type": "boolean",
                  "description": "блок под открытым небом — к нему привязывается план Б"
              },
              "forGuests": {
                  "type": "boolean",
                  "default": true,
                  "description": "Видят ли блок гости в день X (`GET /join/{guestToken}/day`). По\nумолчанию да — программа праздника; «Сборы невесты» и «Монтаж\nарки» пара снимает галочкой (План §8.8, фича 009).\n"
              }
          }
      },
      "Tip": {
          "type": "object",
          "description": "Подсказка по правилу §3.14; `link` — куда ведёт (экран поиска категории или бюджет).",
          "required": [
              "kind",
              "title",
              "body",
              "link"
          ],
          "properties": {
              "kind": {
                  "type": "string",
                  "enum": [
                      "deficit",
                      "blocking_slot",
                      "budget"
                  ]
              },
              "title": {
                  "type": "string"
              },
              "body": {
                  "type": "string"
              },
              "link": {
                  "type": "string"
              },
              "categoryId": {
                  "type": [
                      "string",
                      "null"
                  ]
              }
          }
      },
      "User": {
          "type": "object",
          "properties": {
              "id": {
                  "type": "string"
              },
              "name": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "null, пока человек не назвал себя"
              },
              "phone": {
                  "type": "string",
                  "readOnly": true,
                  "description": "E.164 — тот, что подтверждён кодом"
              },
              "email": {
                  "type": "string",
                  "format": "email"
              },
              "avatarUrl": {
                  "type": [
                      "string",
                      "null"
                  ]
              }
          }
      },
      "UserProfile": {
          "type": "object",
          "properties": {
              "id": {
                  "type": "string",
                  "readOnly": true
              },
              "name": {
                  "type": "string"
              },
              "phone": {
                  "type": "string",
                  "readOnly": true
              },
              "email": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "readOnly": true,
                  "description": "Пока только читается: отправителя писем нет (хвост владельца), и\nпринимать адрес, на который ничего не уйдёт, — обещать доставку.\nПравка появится вместе с отправителем и подтверждением адреса.\n"
              },
              "isStaff": {
                  "type": "boolean",
                  "readOnly": true,
                  "description": "Сотрудник платформы: по этому признаку в меню «Мы» появляется\n«Админка». Только чтение и только про себя: списка сотрудников\nнаружу нет, а признак ставится руками в базе при найме.\nPATCH /users/me берёт тело по этой же схеме — без readOnly контракт\nобъявил бы права настраиваемыми, то есть «сделай меня админом»\nв один запрос.\n"
              },
              "lang": {
                  "type": "string",
                  "enum": [
                      "ru",
                      "en"
                  ]
              },
              "tz": {
                  "type": "string",
                  "description": "нужна для открытия чата дня X в 09:00 по местному"
              },
              "push": {
                  "type": "object",
                  "description": "четыре независимых канала — тумблеры в настройках",
                  "properties": {
                      "tasks": {
                          "type": "boolean"
                      },
                      "chats": {
                          "type": "boolean"
                      },
                      "deals": {
                          "type": "boolean"
                      },
                      "tips": {
                          "type": "boolean"
                      }
                  }
              },
              "quietHours": {
                  "type": "object",
                  "description": "по умолчанию 22:00–09:00; в день X отключаются автоматически",
                  "properties": {
                      "from": {
                          "type": "string"
                      },
                      "to": {
                          "type": "string"
                      }
                  }
              }
          }
      },
      "Vendor": {
          "type": "object",
          "properties": {
              "id": {
                  "type": "string"
              },
              "name": {
                  "type": "string"
              },
              "categoryId": {
                  "type": "string"
              },
              "city": {
                  "type": "string"
              },
              "priceFrom": {
                  "allOf": [
                      {
                          "$ref": "contract#/definitions/Money"
                      }
                  ],
                  "type": [
                      "object",
                      "array",
                      "string",
                      "number",
                      "boolean",
                      "null"
                  ]
              },
              "rating": {
                  "type": [
                      "number",
                      "null"
                  ]
              },
              "reviewsCount": {
                  "type": "integer"
              },
              "photoUrl": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "verified": {
                  "type": "boolean",
                  "description": "Документы сверены. Сами документы не публикуются НИКОГДА —\nнаружу выходит только этот признак (план §6).\n"
              },
              "hasVideo": {
                  "type": "boolean"
              },
              "distanceKm": {
                  "type": [
                      "integer",
                      "null"
                  ],
                  "description": "Расстояние от города поиска (`city`) до города анкеты в\nкилометрах, округлённое (фича 011): 0 — тот же город; null — запрос\nбез `city`, у одного из городов нет координат или это анкета вне\nвыдачи (`GET /catalog/vendors/{vendorId}`). Считается между\nцентрами городов справочника, не до площадки — адресов у анкет нет.\n"
              }
          }
      },
      "VendorDecision": {
          "type": "object",
          "description": "Что записано по анкете. Ответ подтверждает решение, а не состояние анкеты целиком.",
          "properties": {
              "vendorId": {
                  "type": "string"
              },
              "action": {
                  "type": "string",
                  "enum": [
                      "approve",
                      "reject",
                      "verify"
                  ]
              }
          }
      },
      "VendorDetail": {
          "allOf": [
              {
                  "$ref": "contract#/definitions/Vendor"
              },
              {
                  "type": "object",
                  "properties": {
                      "about": {
                          "type": "string"
                      },
                      "phone": {
                          "type": [
                              "string",
                              "null"
                          ],
                          "description": "Рабочий телефон подрядчика. Отдельное поле анкеты, а не номер\nвхода: публикация личного номера — раскрытие персональных\nданных, и заполняя это поле, подрядчик соглашается его показать.\n\nПриходит ЗАПОЛНЕННЫМ только той паре (и её команде), которая\nэтого подрядчика уже забронировала — `booked`, `paid_deposit`\nили `done` (решение владельца 2026-09-03). До брони — `null`,\nи это значит «ещё рано», а не «номер не указан»: клиент\nпоказывает вместо него кнопку «Написать». Владелец анкеты\nвидит свой номер всегда.\n"
                      },
                      "cityRegion": {
                          "type": [
                              "string",
                              "null"
                          ],
                          "description": "Регион города анкеты. Нужен владельцу, чтобы вернуть анкету\nобратно без потери города: `city` приходит одной строкой, а\nсправочник различает одноимённые города по региону.\n"
                      },
                      "published": {
                          "type": "boolean",
                          "description": "Опубликована ли анкета. Приходит только владельцу (`GET /vendor/profile`):\nдля чужого читателя вопрос не стоит — неопубликованную он не видит вовсе.\n\nПодрядчику это главный факт кабинета: пока анкета не опубликована,\nеё нет в каталоге, и заявок не будет, сколько ни заполняй поля.\n"
                      },
                      "moderated": {
                          "type": "boolean",
                          "description": "Прошла ли пост-модерацию. Публикация мгновенная, проверка идёт следом."
                      },
                      "blocked": {
                          "type": "boolean",
                          "description": "Анкета заблокирована модератором по жалобе (`block`). Только\nвладельцу: в каталоге её нет, публикация отвечает 409, и\nкабинет обязан сказать почему, а не показывать «не опубликована»\nс кнопкой, которая не сработает (D5-23).\n"
                      },
                      "mediaRights": {
                          "type": "boolean",
                          "description": "Подрядчик подтвердил права на фото и видео портфолио и согласие\nснятых на публикацию (152-ФЗ, план бэкенда §7). Только владельцу.\nСтавится один раз через `mediaRights: true` в `PUT /vendor/profile`\nи не снимается; мастер анкеты не публикует без него.\n"
                      },
                      "completeness": {
                          "type": "object",
                          "description": "Заполненность анкеты (План §8.2) — только владельцу. Одно правило\nна кабинет и панель (`vendor/completeness.ts`): четыре поля —\nо себе, телефон, цена «от», пакеты; фотографии не считаются до\nхранилища (№3). `missing` — чего не хватает, для подсказки.\n",
                          "required": [
                              "pct",
                              "missing"
                          ],
                          "properties": {
                              "pct": {
                                  "type": "integer",
                                  "minimum": 0,
                                  "maximum": 100
                              },
                              "missing": {
                                  "type": "array",
                                  "items": {
                                      "type": "string",
                                      "enum": [
                                          "about",
                                          "phone",
                                          "priceFrom",
                                          "packages"
                                      ]
                                  }
                              }
                          }
                      },
                      "gallery": {
                          "type": "array",
                          "description": "Ссылки на фотографии — совместимость с прежней формой ответа.",
                          "items": {
                              "type": "string"
                          }
                      },
                      "media": {
                          "type": "array",
                          "items": {
                              "type": "object",
                              "properties": {
                                  "kind": {
                                      "type": "string",
                                      "enum": [
                                          "photo",
                                          "video"
                                      ]
                                  },
                                  "url": {
                                      "type": "string"
                                  },
                                  "durationS": {
                                      "type": [
                                          "integer",
                                          "null"
                                      ]
                                  }
                              }
                          }
                      },
                      "packages": {
                          "type": "array",
                          "description": "В порядке, заданном подрядчиком.",
                          "items": {
                              "$ref": "contract#/definitions/VendorPackage"
                          }
                      },
                      "reviews": {
                          "type": "array",
                          "items": {
                              "$ref": "contract#/definitions/Review"
                          }
                      }
                  }
              }
          ]
      },
      "VendorPackage": {
          "type": "object",
          "description": "Пакет услуг подрядчика в ответе. `id` постоянен: правка анкеты, не\nудаляющая пакет, его не меняет, и брони называют пакет, как до правки\n(019, FR-006).\n",
          "required": [
              "id",
              "name",
              "price",
              "includes"
          ],
          "properties": {
              "id": {
                  "type": "string"
              },
              "name": {
                  "type": "string"
              },
              "price": {
                  "allOf": [
                      {
                          "$ref": "contract#/definitions/Money"
                      }
                  ],
                  "description": "`null` — цена не названа («по запросу»), а не 0 ₽ (R-281).",
                  "type": [
                      "object",
                      "array",
                      "string",
                      "number",
                      "boolean",
                      "null"
                  ]
              },
              "includes": {
                  "type": "array",
                  "description": "Что входит в пакет — пунктами.",
                  "items": {
                      "type": "string"
                  }
              }
          }
      },
      "VendorPackageInput": {
          "type": "object",
          "description": "Пакет услуг в `PUT /vendor/profile`. С `id` — свой пакет, который\nостаётся тем же (имя, цена, состав и место в списке обновляются);\nбез `id` — новый. Цены нет — поле не присылается: `null` не\nпринимается, пакет хранится без цены (R-281).\n",
          "required": [
              "name"
          ],
          "properties": {
              "id": {
                  "type": "string",
                  "maxLength": 64
              },
              "name": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 120
              },
              "price": {
                  "$ref": "contract#/definitions/Money"
              },
              "includes": {
                  "type": "array",
                  "maxItems": 40,
                  "items": {
                      "type": "string",
                      "maxLength": 200
                  }
              }
          }
      },
      "VendorPage": {
          "type": "object",
          "properties": {
              "items": {
                  "type": "array",
                  "items": {
                      "$ref": "contract#/definitions/Vendor"
                  }
              },
              "nextCursor": {
                  "type": [
                      "string",
                      "null"
                  ]
              }
          }
      },
      "VendorUpsert": {
          "type": "object",
          "description": "Анкета целиком. Правило для списков (`packages`, `portfolioUrls`, `media`):\n**поля нет — список не трогаем, пустой массив — очищаем**. Пакеты\nсохраняются по `id`: присланный с `id` — тот же пакет, без `id` —\nновый, неприсланный удаляется (019, FR-006).\n\nИначе экран, который списком не занимается — мастер анкеты портфолио не\nредактирует, загрузка ждёт хранилища, — стирал бы чужие работы при\nсохранении имени или телефона.\n",
          "required": [
              "name",
              "categoryId",
              "city"
          ],
          "properties": {
              "name": {
                  "type": "string"
              },
              "categoryId": {
                  "type": "string"
              },
              "city": {
                  "allOf": [
                      {
                          "$ref": "contract#/definitions/CityRef"
                      }
                  ],
                  "description": "Регион можно не присылать, если название города в справочнике\nединственное. Иначе он обязателен: «Октябрьский» есть и в\nБашкортостане, и в Волгоградской области.\n\nБез этого послабления анкету нельзя было отредактировать: в ответе\nгород приходит одной строкой, региона в нём нет, и любое сохранение\nпадало с «городом не найден».\n"
              },
              "about": {
                  "type": "string"
              },
              "phone": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "minLength": 5,
                  "maxLength": 32,
                  "description": "Рабочий телефон для пар, которые уже забронировали. Формат свободный: люди пишут +7, 8, со скобками и без — навязывать один вид значит ловить отказы на живых номерах.\n"
              },
              "priceFrom": {
                  "$ref": "contract#/definitions/Money"
              },
              "mediaRights": {
                  "type": "boolean",
                  "description": "`true` — подрядчик подтверждает права на фото и видео портфолио и\nсогласие снятых людей на публикацию. Записывается моментом\n(`vendors.media_rights_at`) и не снимается; `false` и отсутствие\nполя прежнее подтверждение не трогают.\n"
              },
              "packages": {
                  "type": "array",
                  "maxItems": 20,
                  "items": {
                      "$ref": "contract#/definitions/VendorPackageInput"
                  }
              },
              "portfolioUrls": {
                  "type": "array",
                  "description": "Фотографии портфолио. Для видео нужен `media` — там есть длительность.",
                  "items": {
                      "type": "string"
                  }
              },
              "media": {
                  "type": "array",
                  "description": "Портфолио с типом файла. У видео длительность обязательна: ограничение\n180 с проверяется на сервере, а из голой ссылки его не узнать.\n",
                  "items": {
                      "type": "object",
                      "required": [
                          "kind",
                          "url"
                      ],
                      "properties": {
                          "kind": {
                              "type": "string",
                              "enum": [
                                  "photo",
                                  "video"
                              ]
                          },
                          "url": {
                              "type": "string"
                          },
                          "durationS": {
                              "type": [
                                  "integer",
                                  "null"
                              ],
                              "minimum": 1,
                              "maximum": 180
                          }
                      }
                  }
              }
          }
      },
      "VerificationDecision": {
          "type": "object",
          "description": "Что записано по заявке. Ответ подтверждает решение, а не состояние подрядчика целиком.",
          "properties": {
              "requestId": {
                  "type": "string"
              },
              "action": {
                  "type": "string",
                  "enum": [
                      "approve",
                      "reject"
                  ]
              }
          }
      },
      "VerificationItem": {
          "type": "object",
          "description": "Заявка в очереди. Ни ссылки на документ, ни ИНН здесь нет — только\nпризнак `hasFile`: документы отдаются в карточке одному сотруднику\nи с записью в журнал, а не страницами всем подряд.\n",
          "properties": {
              "id": {
                  "type": "string"
              },
              "vendorId": {
                  "type": "string"
              },
              "vendorName": {
                  "type": "string"
              },
              "kind": {
                  "type": "string",
                  "enum": [
                      "passport",
                      "ip",
                      "company"
                  ],
                  "description": "что прислали: паспорт, документы ИП или документы компании"
              },
              "hasFile": {
                  "type": "boolean",
                  "description": "приложена ли ссылка на документ"
              },
              "createdAt": {
                  "type": "string",
                  "format": "date-time",
                  "description": "когда подана"
              }
          }
      },
      "VerificationPage": {
          "type": "object",
          "properties": {
              "items": {
                  "type": "array",
                  "items": {
                      "$ref": "contract#/definitions/VerificationItem"
                  }
              },
              "nextCursor": {
                  "type": [
                      "string",
                      "null"
                  ]
              }
          }
      },
      "VerificationRequest": {
          "type": "object",
          "description": "Карточка заявки: то, по чему принимается решение. Единственный ответ,\nгде ссылка на документ и ИНН выходят наружу, — и только сотруднику.\n",
          "properties": {
              "id": {
                  "type": "string"
              },
              "vendorId": {
                  "type": "string"
              },
              "vendorName": {
                  "type": "string"
              },
              "vendorPublished": {
                  "type": "boolean",
                  "description": "Есть ли анкета в каталоге сейчас (опубликована и не заблокирована).\nРешение по документам этим не задерживается — признак нужен, чтобы\nкарточка не вела на анкету, которой в каталоге нет.\n"
              },
              "kind": {
                  "type": "string",
                  "enum": [
                      "passport",
                      "ip",
                      "company"
                  ]
              },
              "fileUrl": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "Ссылка на документ во внешнем хранилище. Пусто — документ не приложен."
              },
              "inn": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "status": {
                  "type": "string",
                  "enum": [
                      "pending",
                      "approved",
                      "rejected"
                  ]
              },
              "createdAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "checkedAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time",
                  "description": "когда разобрана"
              }
          }
      },
      "VerificationStatus": {
          "type": "object",
          "description": "Состояние последней заявки подрядчика. `none` — заявок не было.\nПричины отказа здесь нет: она приходит уведомлением.\n",
          "properties": {
              "status": {
                  "type": "string",
                  "enum": [
                      "none",
                      "pending",
                      "approved",
                      "rejected"
                  ]
              },
              "kind": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "enum": [
                      "passport",
                      "ip",
                      "company"
                  ]
              },
              "submittedAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time",
                  "description": "когда подана"
              },
              "checkedAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time",
                  "description": "когда разобрана"
              }
          }
      },
      "VerificationSubmit": {
          "type": "object",
          "description": "Тело подачи документов на верификацию (фича 014: одна схема — и контракту, и обработчику).",
          "required": [
              "kind",
              "fileUrl"
          ],
          "additionalProperties": false,
          "properties": {
              "kind": {
                  "type": "string",
                  "enum": [
                      "passport",
                      "ip",
                      "company"
                  ]
              },
              "fileUrl": {
                  "type": "string",
                  "maxLength": 2000,
                  "pattern": "^https://[^ ]+$",
                  "description": "Ссылка на скан. Только `https` — сотрудник открывает её в новой\nвкладке из карточки заявки, и `http`, `javascript:` или `file:`\nздесь были бы не документом, а тем, что сотруднику подсунули.\n"
              },
              "inn": {
                  "type": "string",
                  "pattern": "^[0-9]{10}$|^[0-9]{12}$",
                  "description": "ИНН: 10 знаков у организации, 12 у ИП и физлица."
              }
          }
      },
      "Wedding": {
          "type": "object",
          "properties": {
              "id": {
                  "type": "string"
              },
              "title": {
                  "type": "string"
              },
              "date": {
                  "type": "string",
                  "format": "date"
              },
              "city": {
                  "$ref": "contract#/definitions/CityRef"
              },
              "budgetTotal": {
                  "$ref": "contract#/definitions/Money"
              },
              "guestsPlanned": {
                  "type": "integer"
              },
              "style": {
                  "type": "string"
              },
              "format": {
                  "allOf": [
                      {
                          "$ref": "contract#/definitions/WeddingFormat"
                      }
                  ],
                  "description": "формат из квиза (фича 018); null — не указан: вопрос пропущен или свадьба заведена раньше",
                  "type": [
                      "object",
                      "array",
                      "string",
                      "number",
                      "boolean",
                      "null"
                  ]
              },
              "planner": {
                  "allOf": [
                      {
                          "$ref": "contract#/definitions/WeddingPlanner"
                      }
                  ],
                  "description": "кто планирует (фича 018); null — не указано",
                  "type": [
                      "object",
                      "array",
                      "string",
                      "number",
                      "boolean",
                      "null"
                  ]
              },
              "tz": {
                  "type": "string",
                  "description": "таймзона места свадьбы. По ней открывается чат дня X и считаются напоминания — не по таймзоне пользователя"
              },
              "inviteText": {
                  "type": "string"
              },
              "inviteThemeId": {
                  "type": "integer"
              },
              "dressCode": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "палитра дресс-кода — её же видит гость"
              },
              "dressNote": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "cancelRequestedBy": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "Кто из пары запросил отмену свадьбы и ждёт подтверждения второго. Видно только паре. Нужно, чтобы второй партнёр понимал: его нажатие «Отменить» не запросит отмену, а ИСПОЛНИТ её — брони отменятся, даты уйдут подрядчикам. Без этого поля показать предупреждение нечем. Пусто — запроса нет или он протух (срок 72 часа).\n"
              },
              "cancelRequestedAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time",
                  "description": "Когда запрошена отмена. Запрос живёт 72 часа, дальше требуется новый."
              },
              "members": {
                  "type": "array",
                  "items": {
                      "$ref": "contract#/definitions/Member"
                  }
              }
          }
      },
      "WeddingFormat": {
          "type": "string",
          "enum": [
              "classic",
              "outdoor",
              "intimate",
              "two_day"
          ],
          "description": "Формат свадьбы из квиза (фича 018). Код, а не подпись варианта: подпись\nпереводится на экране, и «Классика» на другом языке стала бы другим\nответом.\n- `classic` — «Классика: ЗАГС + банкет»: 12 слотов шаблона; в тайминге\n  «Регистрация в ЗАГСе» 14:00–15:00 вместо «Выездной церемонии» 16:00–17:00.\n- `outdoor` — «Выездная церемония»: плюс слоты «Площадка выездной\n  церемонии» (`ceremony`) и «Церемониймейстер» (`registrar`); тайминг\n  шаблона.\n- `intimate` — «Камерная свадьба»: 12 слотов; «Ужин» 18:00–22:00 вместо\n  «Банкета», без «Салюта и финала».\n- `two_day` — «Банкет+ на 2 дня»: плюс слот «Отель для гостей» (`hotel`);\n  тайминг выездной и два блока на следующее число — «День 2: бранч»\n  12:00–14:00 и «День 2: продолжение праздника» 14:00–20:00. Перенос даты\n  двигает их вместе с первым днём.\n"
      },
      "WeddingPlanner": {
          "type": "string",
          "enum": [
              "self",
              "agency",
              "coordinator"
          ],
          "description": "Кто планирует (фича 018): `agency` — плюс слот «Организатор» (`agency`), `coordinator` — плюс «Координатор дня» (`coordinator`), `self` — ничего."
      },
      "WeddingPublic": {
          "type": "object",
          "description": "Публичная часть свадьбы для гостей (без бюджета)",
          "properties": {
              "title": {
                  "type": "string"
              },
              "date": {
                  "type": "string",
                  "format": "date"
              },
              "city": {
                  "$ref": "contract#/definitions/CityRef"
              },
              "inviteText": {
                  "type": "string"
              },
              "inviteThemeId": {
                  "type": "integer"
              },
              "venue": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "dressCode": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "идентификатор палитры — гость видит её в приглашении"
              },
              "dressNote": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "tz": {
                  "type": "string",
                  "description": "Часовой пояс места свадьбы. Гость считает «свадьба уже прошла»\n(окно отзыва) по нему, а не по поясу своего телефона (D3-18).\n"
              }
          }
      },
      "WeddingSupportCard": {
          "type": "object",
          "description": "Карточка, а не свадьба целиком: ни гостей, ни переписки, ни сумм.\nДля разбора обращения этого достаточно, а лишнее здесь — чужая свадьба\nна экране поддержки.\n",
          "properties": {
              "id": {
                  "type": "string"
              },
              "title": {
                  "type": "string"
              },
              "date": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date"
              },
              "city": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "style": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "guestsPlanned": {
                  "type": [
                      "integer",
                      "null"
                  ]
              },
              "createdAt": {
                  "type": "string",
                  "format": "date-time"
              }
          }
      }
  },
} as const

/** Ссылка на схему контракта для body/response обработчика. */
export function ref(name: ContractSchemaName): { $ref: string } {
  return { $ref: `contract#/definitions/${name}` }
}

export type ContractSchemaName =
  | "AdminCategories"
  | "AdminCategoriesUpdate"
  | "AdminCategory"
  | "AdminMetrics"
  | "AlbumPhoto"
  | "AuthTokens"
  | "BroadcastResult"
  | "Budget"
  | "BudgetItem"
  | "BusRoute"
  | "CancelResult"
  | "CategoriesUpdated"
  | "Category"
  | "Chat"
  | "City"
  | "CityRef"
  | "Complaint"
  | "ComplaintDecision"
  | "ConciergeDecision"
  | "ConciergePage"
  | "ConciergeRequest"
  | "DayXBroadcast"
  | "Deal"
  | "DealState"
  | "Document"
  | "Error"
  | "Fund"
  | "Gift"
  | "Guest"
  | "GuestPersonRsvp"
  | "HotelBlock"
  | "InviteLink"
  | "Lead"
  | "Member"
  | "MenuPoll"
  | "Message"
  | "ModerationVendor"
  | "ModerationVendorPage"
  | "Money"
  | "Note"
  | "Notification"
  | "Offer"
  | "OfferInput"
  | "OfferPublic"
  | "OfferRequest"
  | "PositiveMoney"
  | "PrebookedCategory"
  | "Readiness"
  | "Review"
  | "Session"
  | "ShortlistEntry"
  | "Slot"
  | "SupportDeal"
  | "Table"
  | "Task"
  | "TaskCreate"
  | "TaskPatch"
  | "TimelineEvent"
  | "Tip"
  | "User"
  | "UserProfile"
  | "Vendor"
  | "VendorDecision"
  | "VendorDetail"
  | "VendorPackage"
  | "VendorPackageInput"
  | "VendorPage"
  | "VendorUpsert"
  | "VerificationDecision"
  | "VerificationItem"
  | "VerificationPage"
  | "VerificationRequest"
  | "VerificationStatus"
  | "VerificationSubmit"
  | "Wedding"
  | "WeddingFormat"
  | "WeddingPlanner"
  | "WeddingPublic"
  | "WeddingSupportCard"
