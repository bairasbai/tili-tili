/* СГЕНЕРИРОВАНО. Не править руками — правится контракт, потом `pnpm run gen:schemas`.
 * Схем: 169. */

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
      "AvailabilityObservation": {
          "type": [
              "object",
              "null"
          ],
          "additionalProperties": false,
          "description": "Время чтения существующей DATE-занятости в текущем native SELECT, а не время обновления провайдера или обещание свободного ресурса; null означает отсутствие такого наблюдения.",
          "required": [
              "source",
              "date",
              "checkedAt"
          ],
          "properties": {
              "source": {
                  "type": "string",
                  "enum": [
                      "legacy_day"
                  ]
              },
              "date": {
                  "type": "string",
                  "format": "date"
              },
              "checkedAt": {
                  "type": "string",
                  "format": "date-time"
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
          "required": [
              "reserveBps",
              "settingsVersion"
          ],
          "properties": {
              "paymentSummary": {
                  "$ref": "contract#/definitions/PaymentSummary"
              },
              "total": {
                  "$ref": "contract#/definitions/Money"
              },
              "spent": {
                  "$ref": "contract#/definitions/Money"
              },
              "reserveBps": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 5000,
                  "description": "Доля резерва в базисных пунктах: 1000 = 10 %. От 0 до 5000 (50 %), по умолчанию 1000."
              },
              "settingsVersion": {
                  "type": "integer",
                  "minimum": 0,
                  "description": "Версия настроек резерва для `PATCH …/budget/settings`; 0 — резерв ни разу не меняли."
              },
              "reserve": {
                  "allOf": [
                      {
                          "$ref": "contract#/definitions/Money"
                      }
                  ],
                  "description": "Резерв на непредвиденное — `reserveBps` от общего бюджета: по\nумолчанию 10 % (План ч. 283), пара меняет долю от 0 до 50 % (018-B).\nОтдельная строка, а не категория: категории делят сто процентов\nмежду собой, и резерв внутри них означал бы, что часть сметы\nпросто уменьшили.\n\nСчитает сервер, чтобы доля не разошлась между экранами.\n"
              },
              "categories": {
                  "type": "array",
                  "items": {
                      "type": "object",
                      "required": [
                          "limitCustom",
                          "limitVersion"
                      ],
                      "properties": {
                          "id": {
                              "type": "string"
                          },
                          "title": {
                              "type": "string"
                          },
                          "planned": {
                              "allOf": [
                                  {
                                      "$ref": "contract#/definitions/Money"
                                  }
                              ],
                              "description": "Лимит категории: доля общего бюджета или, при `limitCustom`, сумма, заданная парой."
                          },
                          "limitCustom": {
                              "type": "boolean",
                              "description": "true — лимит задан парой (`PUT …/limit`), false — автоматическая доля."
                          },
                          "limitVersion": {
                              "type": "integer",
                              "minimum": 0,
                              "description": "Версия лимита для `PUT`/`PATCH …/limit`; 0 — лимит ни разу не задавали."
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
              "comparisonTerms": {
                  "$ref": "contract#/definitions/OfferComparisonTerms"
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
      "EventInvitationRoster": {
          "type": "object",
          "required": [
              "event",
              "people"
          ],
          "properties": {
              "event": {
                  "$ref": "contract#/definitions/WeddingEvent"
              },
              "people": {
                  "type": "array",
                  "items": {
                      "type": "object",
                      "required": [
                          "guestId",
                          "name",
                          "invited"
                      ],
                      "properties": {
                          "guestId": {
                              "type": "string",
                              "format": "uuid"
                          },
                          "name": {
                              "type": "string"
                          },
                          "invited": {
                              "type": "boolean"
                          }
                      }
                  }
              }
          }
      },
      "EventRsvpCouplePerson": {
          "description": "EventRsvpPerson с привязкой к семейному приглашению — вид пары (T012).",
          "allOf": [
              {
                  "$ref": "contract#/definitions/EventRsvpPerson"
              },
              {
                  "type": "object",
                  "required": [
                      "partyId",
                      "partyLabel"
                  ],
                  "properties": {
                      "partyId": {
                          "type": "string",
                          "format": "uuid"
                      },
                      "partyLabel": {
                          "type": [
                              "string",
                              "null"
                          ],
                          "maxLength": 120,
                          "description": "Подпись семейного приглашения; `null` — приглашение без подписи."
                      }
                  }
              }
          ]
      },
      "EventRsvpDeadline": {
          "type": "object",
          "description": "Срок ответа на дополнительное мероприятие и его текущее состояние (T012).",
          "required": [
              "date",
              "timeZone",
              "state",
              "closesAt"
          ],
          "properties": {
              "date": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date",
                  "description": "Срок ответа включительно, в часовом поясе мероприятия; `null` — срок не задан."
              },
              "timeZone": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "Часовой пояс мероприятия на момент расчёта срока; `null` только вместе с `date=null`."
              },
              "state": {
                  "type": "string",
                  "enum": [
                      "none",
                      "open",
                      "closed"
                  ],
                  "description": "`none` — срок не задан; `open` — ответ ещё принимается; `closed` — срок прошёл."
              },
              "closesAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time",
                  "description": "Момент закрытия (начало суток `date+1` по `timeZone`) в UTC; `null` при `state=none`."
              }
          }
      },
      "EventRsvpDecisionResult": {
          "type": "object",
          "description": "Итог решения пары по просьбе гостя (T012).",
          "required": [
              "request",
              "person"
          ],
          "properties": {
              "request": {
                  "$ref": "contract#/definitions/EventRsvpRequest"
              },
              "person": {
                  "$ref": "contract#/definitions/EventRsvpCouplePerson"
              }
          }
      },
      "EventRsvpPerson": {
          "type": "object",
          "description": "Ответ одной персоны на дополнительное мероприятие (T012).",
          "required": [
              "guestId",
              "name",
              "status",
              "source",
              "version",
              "request"
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
                      "unknown",
                      "attending",
                      "declined"
                  ]
              },
              "source": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "enum": [
                      null,
                      "legacy_main_rsvp",
                      "guest_response",
                      "team_observation",
                      "organizer_correction"
                  ],
                  "description": "`null` — персона ни разу не отвечала на это мероприятие."
              },
              "version": {
                  "type": "string",
                  "pattern": "^(0|[1-9][0-9]{0,18})$",
                  "description": "Версия ответа в `event_guest_participation`; `\"0\"` — персона ни разу не отвечала."
              },
              "request": {
                  "allOf": [
                      {
                          "$ref": "contract#/definitions/EventRsvpRequest"
                      }
                  ],
                  "description": "Последняя просьба персоны изменить ответ; `null` — просьб не было или активной не осталось.",
                  "type": [
                      "object",
                      "array",
                      "string",
                      "number",
                      "boolean",
                      "null"
                  ]
              }
          }
      },
      "EventRsvpRequest": {
          "type": "object",
          "description": "Просьба гостя изменить ответ после срока (T012, таблица `event_rsvp_requests`).",
          "required": [
              "id",
              "guestId",
              "requestedStatus",
              "state",
              "comment",
              "decisionNote",
              "createdAt",
              "decidedAt",
              "version"
          ],
          "properties": {
              "id": {
                  "type": "string",
                  "format": "uuid"
              },
              "guestId": {
                  "type": "string",
                  "format": "uuid"
              },
              "requestedStatus": {
                  "type": "string",
                  "enum": [
                      "attending",
                      "declined"
                  ]
              },
              "state": {
                  "type": "string",
                  "enum": [
                      "pending",
                      "accepted",
                      "rejected"
                  ]
              },
              "comment": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 500,
                  "description": "Комментарий гостя к просьбе; `null` — без комментария."
              },
              "decisionNote": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 500,
                  "description": "Пояснение пары к решению; `null` — пока не решено или решено без пояснения."
              },
              "createdAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "decidedAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time",
                  "description": "`null`, пока `state=pending`."
              },
              "version": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              }
          }
      },
      "EventRsvpRoster": {
          "type": "object",
          "description": "Срок, состав ответов и просьбы дополнительного мероприятия — вид пары (T012).",
          "required": [
              "deadline",
              "people",
              "requests"
          ],
          "properties": {
              "deadline": {
                  "$ref": "contract#/definitions/EventRsvpDeadline"
              },
              "people": {
                  "type": "array",
                  "items": {
                      "$ref": "contract#/definitions/EventRsvpCouplePerson"
                  }
              },
              "requests": {
                  "type": "array",
                  "description": "Ожидающие просьбы и несколько последних решений; не вся история просьб.",
                  "items": {
                      "$ref": "contract#/definitions/EventRsvpRequest"
                  }
              }
          }
      },
      "FinancialBalance": {
          "type": "object",
          "required": [
              "amount",
              "currency"
          ],
          "properties": {
              "amount": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
              },
              "currency": {
                  "type": "string",
                  "enum": [
                      "RUB"
                  ]
              }
          },
          "description": "Знаковый итог в копейках; при несогласованной истории возвратов отрицательные деньги не скрываются нулём."
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
      "GuestInvitedEvent": {
          "type": "object",
          "required": [
              "id",
              "name",
              "kind",
              "date",
              "timeZone",
              "location",
              "isMain",
              "guestIds"
          ],
          "properties": {
              "id": {
                  "type": "string",
                  "format": "uuid"
              },
              "name": {
                  "type": "string"
              },
              "kind": {
                  "$ref": "contract#/definitions/WeddingEventKind"
              },
              "date": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date"
              },
              "timeZone": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "location": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "isMain": {
                  "type": "boolean"
              },
              "guestIds": {
                  "type": "array",
                  "minItems": 1,
                  "maxItems": 10,
                  "items": {
                      "type": "string",
                      "format": "uuid"
                  },
                  "description": "Только приглашённые люди своей семьи; без чужих ответов и полного состава события."
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
      "GuestRsvpEvent": {
          "type": "object",
          "description": "Одно дополнительное мероприятие семьи со сроком и ответами её персон (T012).",
          "required": [
              "event",
              "deadline",
              "people"
          ],
          "properties": {
              "event": {
                  "$ref": "contract#/definitions/WeddingEvent"
              },
              "deadline": {
                  "$ref": "contract#/definitions/EventRsvpDeadline"
              },
              "people": {
                  "type": "array",
                  "minItems": 1,
                  "maxItems": 10,
                  "items": {
                      "$ref": "contract#/definitions/EventRsvpPerson"
                  }
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
          "description": "Точная публичная форма одной версии ответа: оба варианта имеют ровно\nдесять полей. У `decline` поля предложения равны только `null`, а\n`includes` строго пуст; у `offer` название, положительная цена и срок\nне могут быть `null`.\n",
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
                      "validUntil",
                      "comparisonTerms"
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
                      "comparisonTerms": {
                          "$ref": "contract#/definitions/OfferComparisonTerms"
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
                      "validUntil",
                      "comparisonTerms"
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
                      "comparisonTerms": {
                          "type": [
                              "object",
                              "null"
                          ],
                          "enum": [
                              null
                          ]
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
      "OfferComparisonTerms": {
          "type": [
              "object",
              "null"
          ],
          "additionalProperties": false,
          "description": "Явно введённые условия предложения; null означает, что условия не указаны. Тексты не являются вычисленными суммами, датами или фактом исполнения.",
          "required": [
              "hours",
              "team",
              "result",
              "delivery",
              "extras",
              "cancellation",
              "reschedule"
          ],
          "properties": {
              "hours": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 2000
              },
              "team": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 2000
              },
              "result": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 2000
              },
              "delivery": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 2000
              },
              "extras": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 2000
              },
              "cancellation": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 2000
              },
              "reschedule": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 2000
              }
          }
      },
      "OfferComparisonTermsInput": {
          "type": [
              "object",
              "null"
          ],
          "additionalProperties": false,
          "description": "Явно введённые условия предложения; null означает, что условия не указаны. Тексты не являются вычисленными суммами, датами или фактом исполнения.",
          "properties": {
              "hours": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 2000
              },
              "team": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 2000
              },
              "result": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 2000
              },
              "delivery": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 2000
              },
              "extras": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 2000
              },
              "cancellation": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 2000
              },
              "reschedule": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 2000
              }
          }
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
                      "comparisonTerms": {
                          "$ref": "contract#/definitions/OfferComparisonTermsInput"
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
                      "comparisonTerms": {
                          "$ref": "contract#/definitions/OfferComparisonTermsInput"
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
      "OrderAssignmentCancel": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "expectedVersion",
              "expectedAssignmentVersion"
          ],
          "properties": {
              "expectedVersion": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              },
              "expectedAssignmentVersion": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              }
          }
      },
      "OrderAssignmentCreate": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "expectedVersion",
              "slotId",
              "programEventId",
              "label"
          ],
          "properties": {
              "expectedVersion": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              },
              "slotId": {
                  "type": "string",
                  "format": "uuid"
              },
              "programEventId": {
                  "type": "string",
                  "format": "uuid"
              },
              "label": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 200
              }
          }
      },
      "OrderBriefField": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "key",
              "label",
              "type",
              "group"
          ],
          "properties": {
              "key": {
                  "type": "string"
              },
              "label": {
                  "type": "string"
              },
              "type": {
                  "type": "string",
                  "enum": [
                      "string",
                      "string_array",
                      "integer",
                      "boolean",
                      "date"
                  ]
              },
              "group": {
                  "type": "string",
                  "enum": [
                      "core",
                      "optional"
                  ]
              },
              "maxLength": {
                  "type": "integer"
              },
              "maxItems": {
                  "type": "integer"
              },
              "min": {
                  "type": "integer"
              },
              "max": {
                  "type": "integer"
              },
              "options": {
                  "type": "array",
                  "items": {
                      "type": "string"
                  }
              }
          }
      },
      "OrderBriefSubtype": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "id",
              "label",
              "suggestedKinds",
              "fields"
          ],
          "properties": {
              "id": {
                  "type": "string"
              },
              "label": {
                  "type": "string"
              },
              "suggestedKinds": {
                  "type": "array",
                  "items": {
                      "type": "string",
                      "enum": [
                          "timed_service",
                          "supply",
                          "rental",
                          "deliverable",
                          "appointment"
                      ]
                  }
              },
              "fields": {
                  "type": "array",
                  "items": {
                      "$ref": "contract#/definitions/OrderBriefField"
                  }
              }
          }
      },
      "OrderBriefWrite": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "expectedVersion",
              "brief"
          ],
          "properties": {
              "expectedVersion": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              },
              "brief": {
                  "type": [
                      "object",
                      "null"
                  ],
                  "additionalProperties": false,
                  "required": [
                      "values"
                  ],
                  "properties": {
                      "subtypeId": {
                          "type": "string",
                          "maxLength": 100
                      },
                      "values": {
                          "type": "object",
                          "maxProperties": 64,
                          "additionalProperties": true
                      }
                  }
              }
          }
      },
      "OrderCatalog": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "weddingId",
              "primarySlotId",
              "actorRole",
              "timeZone",
              "assignmentTimeZones",
              "eligiblePositions",
              "draftEditable",
              "category",
              "executionKinds"
          ],
          "properties": {
              "dealState": {
                  "type": "string",
                  "enum": [
                      "candidate",
                      "contacted",
                      "negotiating",
                      "booked",
                      "paid_deposit",
                      "done",
                      "cancelled"
                  ],
                  "description": "Текущее состояние финансового заказа; проверяется сервером, отдельно от согласования условий."
              },
              "vendorId": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "uuid"
              },
              "weddingId": {
                  "type": "string",
                  "format": "uuid"
              },
              "primarySlotId": {
                  "type": "string",
                  "format": "uuid"
              },
              "actorRole": {
                  "type": "string",
                  "enum": [
                      "couple",
                      "vendor"
                  ]
              },
              "draftEditable": {
                  "type": "boolean",
                  "description": "Отменённый финансовый корень сохраняет историю, но его черновик больше не исполняется"
              },
              "timeZone": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "Реальный часовой пояс свадьбы; отсутствие не заменяется поясом зрителя"
              },
              "assignmentTimeZones": {
                  "type": "array",
                  "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                          "assignmentId",
                          "programEventId",
                          "timeZone"
                      ],
                      "properties": {
                          "assignmentId": {
                              "type": "string",
                              "format": "uuid"
                          },
                          "programEventId": {
                              "type": "string",
                              "format": "uuid"
                          },
                          "timeZone": {
                              "type": [
                                  "string",
                                  "null"
                              ]
                          }
                      }
                  }
              },
              "eligiblePositions": {
                  "type": "array",
                  "description": "Только паре — реальные подходящие позиции; это возможность назначения черновика, а не подтверждение брони",
                  "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                          "slotId",
                          "programEventId",
                          "isPrimary",
                          "label"
                      ],
                      "properties": {
                          "slotId": {
                              "type": "string",
                              "format": "uuid"
                          },
                          "programEventId": {
                              "type": [
                                  "string",
                                  "null"
                              ],
                              "format": "uuid"
                          },
                          "isPrimary": {
                              "type": "boolean"
                          },
                          "label": {
                              "type": "string"
                          }
                      }
                  }
              },
              "category": {
                  "$ref": "contract#/definitions/OrderCategoryBrief"
              },
              "executionKinds": {
                  "type": "array",
                  "items": {
                      "type": "string",
                      "enum": [
                          "timed_service",
                          "supply",
                          "rental",
                          "deliverable",
                          "appointment"
                      ]
                  }
              }
          }
      },
      "OrderCategoryBrief": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "categoryId",
              "label",
              "suggestedKinds",
              "fields",
              "autoAssign"
          ],
          "properties": {
              "categoryId": {
                  "type": "string"
              },
              "label": {
                  "type": "string"
              },
              "suggestedKinds": {
                  "type": "array",
                  "items": {
                      "type": "string",
                      "enum": [
                          "timed_service",
                          "supply",
                          "rental",
                          "deliverable",
                          "appointment"
                      ]
                  }
              },
              "fields": {
                  "type": "array",
                  "items": {
                      "$ref": "contract#/definitions/OrderBriefField"
                  }
              },
              "subtypes": {
                  "type": "array",
                  "items": {
                      "$ref": "contract#/definitions/OrderBriefSubtype"
                  }
              },
              "autoAssign": {
                  "type": "boolean",
                  "enum": [
                      false
                  ]
              }
          }
      },
      "OrderExternalContact": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "name",
              "phone"
          ],
          "properties": {
              "name": {
                  "type": "string",
                  "minLength": 2,
                  "maxLength": 120
              },
              "phone": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 32
              }
          }
      },
      "OrderExternalContactWrite": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "expectedVersion",
              "name",
              "phone"
          ],
          "properties": {
              "expectedVersion": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              },
              "name": {
                  "type": "string",
                  "minLength": 2,
                  "maxLength": 120
              },
              "phone": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 32
              }
          }
      },
      "OrderPartCancel": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "expectedVersion",
              "expectedPartVersion"
          ],
          "properties": {
              "expectedVersion": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              },
              "expectedPartVersion": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              }
          }
      },
      "OrderPartCreate": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "expectedVersion",
              "kind",
              "title",
              "details"
          ],
          "properties": {
              "expectedVersion": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              },
              "kind": {
                  "type": "string",
                  "enum": [
                      "timed_service",
                      "supply",
                      "rental",
                      "deliverable",
                      "appointment"
                  ]
              },
              "assignmentId": {
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
              "details": {
                  "type": "object",
                  "maxProperties": 64,
                  "additionalProperties": true
              }
          }
      },
      "OrderPartPatch": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "expectedVersion",
              "expectedPartVersion"
          ],
          "properties": {
              "expectedVersion": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              },
              "expectedPartVersion": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              },
              "title": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 200
              },
              "details": {
                  "type": "object",
                  "maxProperties": 64,
                  "additionalProperties": true
              }
          },
          "minProperties": 3
      },
      "OrderResourceCommitmentView": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "revision",
              "state",
              "termsId",
              "planRevisionId",
              "reservation"
          ],
          "properties": {
              "revision": {
                  "type": "string",
                  "pattern": "^(0|[1-9][0-9]{0,18})$"
              },
              "state": {
                  "type": "string",
                  "enum": [
                      "not_reserved",
                      "reserved",
                      "released"
                  ]
              },
              "termsId": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "uuid"
              },
              "planRevisionId": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "uuid"
              },
              "reservation": {
                  "type": "string",
                  "enum": [
                      "not_reserved",
                      "reserved",
                      "released"
                  ]
              }
          }
      },
      "OrderResourceCommitmentWrite": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "expectedOrderVersion",
              "expectedCommitmentRevision",
              "termsId",
              "expectedTermsVersion",
              "termsDigest",
              "planRevisionId",
              "expectedPolicyRevision"
          ],
          "properties": {
              "expectedOrderVersion": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              },
              "expectedCommitmentRevision": {
                  "type": "string",
                  "pattern": "^(0|[1-9][0-9]{0,18})$"
              },
              "termsId": {
                  "type": "string",
                  "format": "uuid"
              },
              "expectedTermsVersion": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              },
              "termsDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
              },
              "planRevisionId": {
                  "type": "string",
                  "format": "uuid"
              },
              "expectedPolicyRevision": {
                  "type": "string",
                  "pattern": "^(0|[1-9][0-9]{0,18})$"
              }
          }
      },
      "OrderResourcePlanLineInput": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "partId",
              "resourceId",
              "capacityWindowId",
              "quantity",
              "startsAt",
              "endsAt",
              "timeZone",
              "setupMinutes",
              "teardownMinutes",
              "travelBeforeMinutes",
              "travelAfterMinutes"
          ],
          "properties": {
              "partId": {
                  "type": "string",
                  "format": "uuid"
              },
              "resourceId": {
                  "type": "string",
                  "format": "uuid"
              },
              "capacityWindowId": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "uuid"
              },
              "quantity": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2147483647
              },
              "startsAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "endsAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "timeZone": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
              },
              "setupMinutes": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 1440
              },
              "teardownMinutes": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 1440
              },
              "travelBeforeMinutes": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 1440
              },
              "travelAfterMinutes": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 1440
              }
          }
      },
      "OrderResourcePlanView": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "orderVersion",
              "revision",
              "canEdit",
              "reservation",
              "current",
              "editorLines",
              "source",
              "history"
          ],
          "properties": {
              "orderVersion": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              },
              "revision": {
                  "type": "string",
                  "pattern": "^(0|[1-9][0-9]{0,18})$"
              },
              "canEdit": {
                  "type": "boolean"
              },
              "reservation": {
                  "type": "string",
                  "enum": [
                      "not_reserved",
                      "reserved",
                      "released"
                  ]
              },
              "current": {
                  "allOf": [
                      {
                          "$ref": "contract#/definitions/PublicOrderResourcePlan"
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
              "editorLines": {
                  "type": [
                      "array",
                      "null"
                  ],
                  "maxItems": 100,
                  "items": {
                      "$ref": "contract#/definitions/OrderResourcePlanLineInput"
                  }
              },
              "source": {
                  "type": "string",
                  "enum": [
                      "current",
                      "invalid",
                      "unavailable"
                  ]
              },
              "history": {
                  "type": "array",
                  "items": {
                      "$ref": "contract#/definitions/PublicOrderResourcePlan"
                  }
              }
          }
      },
      "OrderResourcePlanWrite": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "expectedVersion",
              "expectedPlanRevision",
              "lines"
          ],
          "properties": {
              "expectedVersion": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              },
              "expectedPlanRevision": {
                  "type": "string",
                  "pattern": "^(0|[1-9][0-9]{0,18})$"
              },
              "lines": {
                  "type": "array",
                  "maxItems": 100,
                  "items": {
                      "$ref": "contract#/definitions/OrderResourcePlanLineInput"
                  }
              }
          }
      },
      "OrderTermsAccept": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "expectedTermsVersion",
              "digest",
              "readToken"
          ],
          "properties": {
              "expectedTermsVersion": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              },
              "digest": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{64}$"
              },
              "readToken": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 8192
              }
          }
      },
      "OrderTermsPublish": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "expectedOrderVersion",
              "expectedTermsRevision"
          ],
          "properties": {
              "expectedOrderVersion": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              },
              "expectedTermsRevision": {
                  "type": "string",
                  "pattern": "^(0|[1-9][0-9]{0,18})$"
              }
          }
      },
      "OrderTermsView": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "revision",
              "proposedTermsId",
              "agreedTermsId",
              "history",
              "selected",
              "readToken",
              "acceptedByCaller"
          ],
          "properties": {
              "revision": {
                  "type": "string",
                  "pattern": "^(0|[1-9][0-9]{0,18})$"
              },
              "proposedTermsId": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "uuid"
              },
              "agreedTermsId": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "uuid"
              },
              "history": {
                  "type": "array",
                  "items": {
                      "$ref": "contract#/definitions/PublishedOrderTerms"
                  }
              },
              "selected": {
                  "type": [
                      "object",
                      "null"
                  ],
                  "additionalProperties": false,
                  "required": [
                      "id",
                      "version",
                      "sourceOrderVersion",
                      "sourceFingerprint",
                      "digest",
                      "snapshot",
                      "publishedBy",
                      "publishedSide",
                      "publishedAt",
                      "freshness",
                      "receipts",
                      "acceptedByCaller"
                  ],
                  "properties": {
                      "id": {
                          "type": "string",
                          "format": "uuid"
                      },
                      "version": {
                          "type": "string",
                          "pattern": "^[1-9][0-9]{0,18}$"
                      },
                      "sourceOrderVersion": {
                          "type": "string",
                          "pattern": "^[1-9][0-9]{0,18}$"
                      },
                      "sourceFingerprint": {
                          "type": "string",
                          "pattern": "^[0-9a-f]{64}$"
                      },
                      "digest": {
                          "type": "string",
                          "pattern": "^[0-9a-f]{64}$"
                      },
                      "snapshot": {
                          "type": "object",
                          "additionalProperties": true
                      },
                      "publishedBy": {
                          "type": [
                              "string",
                              "null"
                          ],
                          "format": "uuid"
                      },
                      "publishedSide": {
                          "type": "string",
                          "enum": [
                              "customer",
                              "performer"
                          ]
                      },
                      "publishedAt": {
                          "type": "string",
                          "format": "date-time"
                      },
                      "freshness": {
                          "type": "string",
                          "enum": [
                              "current",
                              "stale",
                              "unavailable",
                              "invalid"
                          ]
                      },
                      "receipts": {
                          "type": "array",
                          "items": {
                              "type": "object",
                              "additionalProperties": false,
                              "required": [
                                  "id",
                                  "party",
                                  "userId",
                                  "sessionId",
                                  "digest",
                                  "acceptedAt"
                              ],
                              "properties": {
                                  "id": {
                                      "type": "string",
                                      "format": "uuid"
                                  },
                                  "party": {
                                      "type": "string",
                                      "enum": [
                                          "customer",
                                          "performer"
                                      ]
                                  },
                                  "userId": {
                                      "type": [
                                          "string",
                                          "null"
                                      ],
                                      "format": "uuid"
                                  },
                                  "sessionId": {
                                      "type": [
                                          "string",
                                          "null"
                                      ],
                                      "format": "uuid"
                                  },
                                  "digest": {
                                      "type": "string",
                                      "pattern": "^[0-9a-f]{64}$"
                                  },
                                  "acceptedAt": {
                                      "type": "string",
                                      "format": "date-time"
                                  }
                              }
                          }
                      },
                      "acceptedByCaller": {
                          "type": "boolean"
                      }
                  }
              },
              "readToken": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 8192,
                  "description": "Временное доказательство выдачи конкретной редакции данной сессии; не доказательство чтения человеком и не юридическая подпись"
              },
              "acceptedByCaller": {
                  "type": "boolean"
              }
          }
      },
      "PaymentAmendmentActor": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "id",
              "name",
              "kind"
          ],
          "properties": {
              "id": {
                  "type": "string",
                  "format": "uuid"
              },
              "name": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "kind": {
                  "type": "string",
                  "enum": [
                      "self",
                      "partner"
                  ]
              }
          }
      },
      "PaymentCorrection": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "id",
              "dealId",
              "beforeVersion",
              "afterVersion",
              "createdAt",
              "actor",
              "paymentId",
              "before",
              "after",
              "reason"
          ],
          "properties": {
              "id": {
                  "type": "string",
                  "format": "uuid"
              },
              "dealId": {
                  "type": "string",
                  "format": "uuid"
              },
              "beforeVersion": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2147483647
              },
              "afterVersion": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2147483647
              },
              "createdAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "actor": {
                  "anyOf": [
                      {
                          "$ref": "contract#/definitions/PaymentAmendmentActor"
                      },
                      {
                          "type": [
                              "object",
                              "null"
                          ],
                          "enum": [
                              null
                          ]
                      }
                  ]
              },
              "paymentId": {
                  "type": "string",
                  "format": "uuid"
              },
              "before": {
                  "$ref": "contract#/definitions/PaymentCorrectionState"
              },
              "after": {
                  "$ref": "contract#/definitions/PaymentCorrectionState"
              },
              "reason": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 500
              }
          },
          "description": "Реальные before/after одного исправления; версии могут иметь промежутки из-за отдельных операций. История до введения этой функции не восстанавливается. Автор — только self/current couple, иначе null."
      },
      "PaymentCorrectionList": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "items",
              "nextCursor"
          ],
          "properties": {
              "items": {
                  "type": "array",
                  "items": {
                      "$ref": "contract#/definitions/PaymentCorrection"
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
      "PaymentCorrectionResult": {
          "allOf": [
              {
                  "$ref": "contract#/definitions/PaymentRecord"
              },
              {
                  "type": "object",
                  "required": [
                      "amendmentId"
                  ],
                  "properties": {
                      "amendmentId": {
                          "type": [
                              "string",
                              "null"
                          ],
                          "format": "uuid"
                      }
                  }
              }
          ]
      },
      "PaymentCorrectionState": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "amountKnown",
              "amount",
              "paidOn",
              "paymentMethod"
          ],
          "properties": {
              "amountKnown": {
                  "type": "boolean"
              },
              "amount": {
                  "anyOf": [
                      {
                          "$ref": "contract#/definitions/PositivePaymentMoney"
                      },
                      {
                          "type": [
                              "object",
                              "null"
                          ],
                          "enum": [
                              null
                          ]
                      }
                  ]
              },
              "paidOn": {
                  "type": "string",
                  "format": "date",
                  "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
              },
              "paymentMethod": {
                  "$ref": "contract#/definitions/PaymentMethod"
              }
          }
      },
      "PaymentCorrectionWrite": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "version",
              "amountKnown",
              "amount",
              "paidOn",
              "paymentMethod",
              "reason"
          ],
          "properties": {
              "version": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2147483647
              },
              "amountKnown": {
                  "type": "boolean"
              },
              "amount": {
                  "anyOf": [
                      {
                          "$ref": "contract#/definitions/PositivePaymentMoney"
                      },
                      {
                          "type": [
                              "object",
                              "null"
                          ],
                          "enum": [
                              null
                          ]
                      }
                  ]
              },
              "paidOn": {
                  "type": "string",
                  "format": "date",
                  "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
              },
              "paymentMethod": {
                  "$ref": "contract#/definitions/PaymentMethod"
              },
              "reason": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 500
              }
          },
          "description": "Полное намерение исправления ручной recorded deposit/balance без provider_ref. Только RUB payment/deal. amountKnown=false требует amount=null; true — positive Money. Сырые типы не приводятся. reason непустой после trim. ID/статус/вид/приватность/привязка/документы сохраняются."
      },
      "PaymentDeal": {
          "type": "object",
          "required": [
              "id",
              "slotId",
              "name",
              "state",
              "price",
              "recorded",
              "remaining",
              "planned",
              "unallocated",
              "needsReview",
              "active",
              "canPlan",
              "unknownAmountPayments"
          ],
          "properties": {
              "id": {
                  "type": "string",
                  "format": "uuid"
              },
              "slotId": {
                  "type": "string",
                  "format": "uuid"
              },
              "name": {
                  "type": "string"
              },
              "state": {
                  "type": "string",
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
              "price": {
                  "anyOf": [
                      {
                          "$ref": "contract#/definitions/Money"
                      },
                      {
                          "type": "null"
                      }
                  ]
              },
              "recorded": {
                  "$ref": "contract#/definitions/FinancialBalance"
              },
              "remaining": {
                  "anyOf": [
                      {
                          "$ref": "contract#/definitions/Money"
                      },
                      {
                          "type": "null"
                      }
                  ]
              },
              "planned": {
                  "$ref": "contract#/definitions/Money"
              },
              "unallocated": {
                  "$ref": "contract#/definitions/FinancialBalance"
              },
              "needsReview": {
                  "type": "boolean"
              },
              "active": {
                  "type": "boolean"
              },
              "canPlan": {
                  "type": "boolean"
              },
              "unknownAmountPayments": {
                  "type": "integer",
                  "minimum": 0
              }
          }
      },
      "PaymentHistoryExport": {
          "type": "object",
          "required": [
              "filename",
              "csv",
              "records"
          ],
          "properties": {
              "filename": {
                  "type": "string"
              },
              "csv": {
                  "type": "string"
              },
              "records": {
                  "type": "integer",
                  "minimum": 0
              }
          }
      },
      "PaymentInstallment": {
          "type": "object",
          "required": [
              "id",
              "dealId",
              "title",
              "amount",
              "paid",
              "remaining",
              "due",
              "version",
              "status",
              "overdue",
              "cancelReason",
              "cancelledAt",
              "allocated",
              "unknownAmountPayments"
          ],
          "properties": {
              "cancelledAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time"
              },
              "id": {
                  "type": "string",
                  "format": "uuid"
              },
              "dealId": {
                  "type": "string",
                  "format": "uuid"
              },
              "title": {
                  "type": "string"
              },
              "amount": {
                  "$ref": "contract#/definitions/Money"
              },
              "paid": {
                  "$ref": "contract#/definitions/FinancialBalance"
              },
              "allocated": {
                  "allOf": [
                      {
                          "$ref": "contract#/definitions/Money"
                      }
                  ],
                  "description": "Сколько на этап легло неразнесённых известных денег сделки. Только для показа —\nпривязки не меняются.\n"
              },
              "remaining": {
                  "allOf": [
                      {
                          "$ref": "contract#/definitions/Money"
                      }
                  ],
                  "description": "Сколько осталось по этапу с учётом известных оплат; неизвестная сумма его не уменьшает."
              },
              "due": {
                  "type": "string",
                  "format": "date",
                  "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
              },
              "version": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2147483647
              },
              "status": {
                  "$ref": "contract#/definitions/PaymentInstallmentStatus"
              },
              "overdue": {
                  "type": "boolean"
              },
              "cancelReason": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "unknownAmountPayments": {
                  "type": "integer",
                  "minimum": 0,
                  "description": "Факты оплаты этого этапа без сохранённой суммы."
              },
              "amendmentId": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "uuid",
                  "readOnly": true,
                  "description": "Идентификатор исходной попытки PATCH; null при no-op или legacy receipt."
              }
          }
      },
      "PaymentInstallmentCreate": {
          "type": "object",
          "required": [
              "dealId",
              "title",
              "amount",
              "due"
          ],
          "properties": {
              "dealId": {
                  "type": "string",
                  "format": "uuid"
              },
              "title": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 200
              },
              "amount": {
                  "$ref": "contract#/definitions/PositivePaymentMoney"
              },
              "due": {
                  "type": "string",
                  "format": "date",
                  "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
              }
          },
          "additionalProperties": false
      },
      "PaymentInstallmentEdit": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "id",
              "dealId",
              "beforeVersion",
              "afterVersion",
              "createdAt",
              "actor",
              "installmentId",
              "before",
              "after"
          ],
          "properties": {
              "id": {
                  "type": "string",
                  "format": "uuid"
              },
              "dealId": {
                  "type": "string",
                  "format": "uuid"
              },
              "beforeVersion": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2147483647
              },
              "afterVersion": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2147483647
              },
              "createdAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "actor": {
                  "anyOf": [
                      {
                          "$ref": "contract#/definitions/PaymentAmendmentActor"
                      },
                      {
                          "type": [
                              "object",
                              "null"
                          ],
                          "enum": [
                              null
                          ]
                      }
                  ]
              },
              "installmentId": {
                  "type": "string",
                  "format": "uuid"
              },
              "before": {
                  "$ref": "contract#/definitions/PaymentInstallmentState"
              },
              "after": {
                  "$ref": "contract#/definitions/PaymentInstallmentState"
              }
          },
          "description": "Реальная правка title/amount/due либо отдельная отмена этапа. Автоматическая версия от оплаты/привязки/изменения сделки не является правкой этапа."
      },
      "PaymentInstallmentEditList": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "items",
              "nextCursor"
          ],
          "properties": {
              "items": {
                  "type": "array",
                  "items": {
                      "$ref": "contract#/definitions/PaymentInstallmentEdit"
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
      "PaymentInstallmentPatch": {
          "type": "object",
          "required": [
              "version"
          ],
          "properties": {
              "version": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2147483647
              },
              "title": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 200
              },
              "amount": {
                  "$ref": "contract#/definitions/PositivePaymentMoney"
              },
              "due": {
                  "type": "string",
                  "format": "date",
                  "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
              },
              "cancelled": {
                  "type": "boolean",
                  "enum": [
                      true
                  ]
              },
              "reason": {
                  "type": "string",
                  "maxLength": 500
              }
          },
          "additionalProperties": false,
          "description": "Оптимистическая версия обязательна. Отмена допускает только version/cancelled/reason: она не меняет суммы и не создаёт возврат. После снижения цены несогласованный план исправляется явно; старый черновик получает 409.",
          "minProperties": 2
      },
      "PaymentInstallmentPay": {
          "type": "object",
          "required": [
              "version"
          ],
          "properties": {
              "version": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2147483647
              },
              "amount": {
                  "$ref": "contract#/definitions/PositivePaymentMoney"
              },
              "amountKnown": {
                  "type": "boolean",
                  "default": true,
                  "description": "false фиксирует факт расчёта без суммы; amount при этом не передаётся."
              },
              "paymentMethod": {
                  "allOf": [
                      {
                          "$ref": "contract#/definitions/PaymentMethod"
                      }
                  ],
                  "default": "other"
              },
              "visibility": {
                  "allOf": [
                      {
                          "$ref": "contract#/definitions/PaymentVisibility"
                      }
                  ],
                  "default": "private"
              },
              "paidOn": {
                  "type": "string",
                  "format": "date",
                  "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
              }
          },
          "additionalProperties": false,
          "description": "Tili-tili фиксирует оплату вне приложения. Способ не влияет на арифметику.\nПри amountKnown=false числовой долг не уменьшается и итог помечается неполным.\n"
      },
      "PaymentInstallmentState": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "title",
              "amount",
              "due",
              "cancelledAt",
              "cancelReason"
          ],
          "properties": {
              "title": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 200
              },
              "amount": {
                  "$ref": "contract#/definitions/PositivePaymentMoney"
              },
              "due": {
                  "type": "string",
                  "format": "date",
                  "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
              },
              "cancelledAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time"
              },
              "cancelReason": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 500
              }
          }
      },
      "PaymentInstallmentStatus": {
          "type": "string",
          "enum": [
              "pending",
              "partial",
              "paid",
              "covered",
              "cancelled"
          ],
          "description": "paid — привязанные отметки закрыли этап; covered — закрыт неразнесёнными деньгами\nсделки (`allocated`), привязанных может не быть; partial — внесена часть; pending —\nничего; cancelled — этап отменён. Одна схема на этап и на его строку в\n`PaymentSchedule.allInstallments`: копия перечисления уже разошлась однажды (ревью 018, ERR-0314).\n"
      },
      "PaymentMethod": {
          "type": "string",
          "enum": [
              "cash",
              "bank_transfer",
              "card",
              "other"
          ]
      },
      "PaymentPlanLink": {
          "type": "object",
          "required": [
              "version",
              "installmentId"
          ],
          "properties": {
              "version": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2147483647
              },
              "installmentId": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "uuid"
              }
          },
          "additionalProperties": false,
          "description": "Привязывает существующую запись целиком к одному этапу своей сделки или снимает привязку. Не создаёт оплату. Возвраты должны быть распределены так, чтобы нетто этапа не стало отрицательным."
      },
      "PaymentRecord": {
          "type": "object",
          "required": [
              "id",
              "dealId",
              "kind",
              "amount",
              "amountKnown",
              "paymentMethod",
              "visibility",
              "paidOn",
              "status",
              "createdAt",
              "installmentId",
              "version"
          ],
          "properties": {
              "id": {
                  "type": "string",
                  "format": "uuid"
              },
              "dealId": {
                  "type": "string",
                  "format": "uuid"
              },
              "kind": {
                  "type": "string",
                  "enum": [
                      "deposit",
                      "balance",
                      "refund"
                  ]
              },
              "amount": {
                  "allOf": [
                      {
                          "$ref": "contract#/definitions/Money"
                      }
                  ],
                  "description": "null только когда amountKnown=false; неизвестная сумма никогда не кодируется нулём.",
                  "type": [
                      "object",
                      "array",
                      "string",
                      "number",
                      "boolean",
                      "null"
                  ]
              },
              "amountKnown": {
                  "type": "boolean"
              },
              "paymentMethod": {
                  "$ref": "contract#/definitions/PaymentMethod"
              },
              "visibility": {
                  "$ref": "contract#/definitions/PaymentVisibility"
              },
              "paidOn": {
                  "type": "string",
                  "format": "date",
                  "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
              },
              "status": {
                  "type": "string",
                  "enum": [
                      "recorded",
                      "confirmed",
                      "cancelled"
                  ],
                  "description": "Учётный статус отметки. recorded означает записанную оплату; confirmed сам по себе не устанавливает проверку банковской операции провайдером. Загруженный пользователем документ и capability canCorrect не подтверждают такую проверку и не меняют этот статус."
              },
              "createdAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "installmentId": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "uuid"
              },
              "version": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2147483647
              },
              "canCorrect": {
                  "type": "boolean",
                  "readOnly": true,
                  "description": "Capability текущей couple financial projection; отсутствие поля означает запрет UI."
              }
          }
      },
      "PaymentSchedule": {
          "type": "object",
          "required": [
              "range",
              "readOnly",
              "summary",
              "dueInWindow",
              "overdueRemaining",
              "items",
              "deals",
              "payments",
              "allInstallments"
          ],
          "properties": {
              "range": {
                  "type": "object",
                  "required": [
                      "from",
                      "to",
                      "today",
                      "timeZone",
                      "includeOverdue",
                      "includeCancelled"
                  ],
                  "properties": {
                      "from": {
                          "type": "string",
                          "format": "date",
                          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
                      },
                      "to": {
                          "type": "string",
                          "format": "date",
                          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
                      },
                      "today": {
                          "type": "string",
                          "format": "date",
                          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
                      },
                      "timeZone": {
                          "type": "string"
                      },
                      "includeOverdue": {
                          "type": "boolean"
                      },
                      "includeCancelled": {
                          "type": "boolean"
                      }
                  }
              },
              "readOnly": {
                  "type": "boolean"
              },
              "summary": {
                  "$ref": "contract#/definitions/PaymentSummary"
              },
              "dueInWindow": {
                  "allOf": [
                      {
                          "$ref": "contract#/definitions/Money"
                      }
                  ]
              },
              "overdueRemaining": {
                  "allOf": [
                      {
                          "$ref": "contract#/definitions/Money"
                      }
                  ]
              },
              "items": {
                  "type": "array",
                  "items": {
                      "$ref": "contract#/definitions/PaymentInstallment"
                  }
              },
              "deals": {
                  "type": "array",
                  "items": {
                      "$ref": "contract#/definitions/PaymentDeal"
                  }
              },
              "payments": {
                  "type": "array",
                  "items": {
                      "$ref": "contract#/definitions/PaymentRecord"
                  }
              },
              "allInstallments": {
                  "type": "array",
                  "items": {
                      "type": "object",
                      "required": [
                          "id",
                          "dealId",
                          "title",
                          "status",
                          "remaining",
                          "unknownAmountPayments"
                      ],
                      "properties": {
                          "id": {
                              "type": "string",
                              "format": "uuid"
                          },
                          "dealId": {
                              "type": "string",
                              "format": "uuid"
                          },
                          "title": {
                              "type": "string"
                          },
                          "status": {
                              "$ref": "contract#/definitions/PaymentInstallmentStatus"
                          },
                          "remaining": {
                              "$ref": "contract#/definitions/Money"
                          },
                          "unknownAmountPayments": {
                              "type": "integer",
                              "minimum": 0
                          }
                      }
                  }
              }
          }
      },
      "PaymentSummary": {
          "type": "object",
          "required": [
              "committed",
              "recorded",
              "remaining",
              "unallocated",
              "inactiveDealRecorded",
              "unknownPrices",
              "unknownAmountPayments",
              "amountIncomplete"
          ],
          "properties": {
              "committed": {
                  "$ref": "contract#/definitions/FinancialBalance"
              },
              "recorded": {
                  "$ref": "contract#/definitions/FinancialBalance"
              },
              "remaining": {
                  "$ref": "contract#/definitions/FinancialBalance"
              },
              "unallocated": {
                  "$ref": "contract#/definitions/FinancialBalance"
              },
              "inactiveDealRecorded": {
                  "$ref": "contract#/definitions/FinancialBalance"
              },
              "unknownPrices": {
                  "type": "integer",
                  "minimum": 0
              },
              "unknownAmountPayments": {
                  "type": "integer",
                  "minimum": 0
              },
              "amountIncomplete": {
                  "type": "boolean",
                  "description": "true, если есть факты оплаты без сохранённой суммы; recorded — только известная нижняя граница."
              }
          },
          "description": "Только сделки, не ручные статьи. committed — активные обязательства; recorded — сумма\nизвестных отметок минус возвраты; remaining — положительный числовой остаток по каждой\nактивной сделке. Неизвестная сумма не считается нулём и не уменьшает remaining.\n"
      },
      "PaymentVisibility": {
          "type": "string",
          "enum": [
              "private",
              "finance_members",
              "vendor"
          ],
          "description": "private и finance_members не расширяют текущую RBAC-модель: финансовые endpoints свадьбы\nпо-прежнему доступны только роли couple. vendor раскрывает запись только vendor этой сделки.\n"
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
      "PositivePaymentMoney": {
          "type": "object",
          "required": [
              "amount",
              "currency"
          ],
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
          },
          "additionalProperties": false
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
      "PublicOrderResourcePlan": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "planRevisionId",
              "revision",
              "lines"
          ],
          "properties": {
              "planRevisionId": {
                  "type": "string",
                  "format": "uuid"
              },
              "revision": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              },
              "lines": {
                  "type": "array",
                  "maxItems": 100,
                  "items": {
                      "$ref": "contract#/definitions/PublicOrderResourcePlanLine"
                  }
              }
          }
      },
      "PublicOrderResourcePlanLine": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "partId",
              "assignmentId",
              "programEventId",
              "label",
              "kind",
              "quantity",
              "unit",
              "startsAt",
              "endsAt",
              "timeZone",
              "setupMinutes",
              "teardownMinutes",
              "travelBeforeMinutes",
              "travelAfterMinutes",
              "occupiedStartsAt",
              "occupiedEndsAt",
              "window"
          ],
          "properties": {
              "partId": {
                  "type": "string",
                  "format": "uuid"
              },
              "assignmentId": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "uuid"
              },
              "programEventId": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "uuid"
              },
              "label": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 200
              },
              "kind": {
                  "type": "string",
                  "enum": [
                      "person",
                      "equipment",
                      "capacity"
                  ]
              },
              "quantity": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2147483647
              },
              "unit": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 80
              },
              "startsAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "endsAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "timeZone": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
              },
              "setupMinutes": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 1440
              },
              "teardownMinutes": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 1440
              },
              "travelBeforeMinutes": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 1440
              },
              "travelAfterMinutes": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 1440
              },
              "occupiedStartsAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "occupiedEndsAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "window": {
                  "type": [
                      "object",
                      "null"
                  ],
                  "additionalProperties": false,
                  "required": [
                      "startsAt",
                      "endsAt"
                  ],
                  "properties": {
                      "startsAt": {
                          "type": "string",
                          "format": "date-time"
                      },
                      "endsAt": {
                          "type": "string",
                          "format": "date-time"
                      }
                  }
              }
          }
      },
      "PublishedOrderTerms": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "id",
              "version",
              "sourceOrderVersion",
              "sourceFingerprint",
              "digest",
              "snapshot",
              "publishedBy",
              "publishedSide",
              "publishedAt",
              "freshness",
              "receipts",
              "acceptedByCaller"
          ],
          "properties": {
              "id": {
                  "type": "string",
                  "format": "uuid"
              },
              "version": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              },
              "sourceOrderVersion": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              },
              "sourceFingerprint": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{64}$"
              },
              "digest": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{64}$"
              },
              "snapshot": {
                  "type": "object",
                  "additionalProperties": true
              },
              "publishedBy": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "uuid"
              },
              "publishedSide": {
                  "type": "string",
                  "enum": [
                      "customer",
                      "performer"
                  ]
              },
              "publishedAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "freshness": {
                  "type": "string",
                  "enum": [
                      "current",
                      "stale",
                      "unavailable",
                      "invalid"
                  ]
              },
              "receipts": {
                  "type": "array",
                  "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                          "id",
                          "party",
                          "userId",
                          "sessionId",
                          "digest",
                          "acceptedAt"
                      ],
                      "properties": {
                          "id": {
                              "type": "string",
                              "format": "uuid"
                          },
                          "party": {
                              "type": "string",
                              "enum": [
                                  "customer",
                                  "performer"
                              ]
                          },
                          "userId": {
                              "type": [
                                  "string",
                                  "null"
                              ],
                              "format": "uuid"
                          },
                          "sessionId": {
                              "type": [
                                  "string",
                                  "null"
                              ],
                              "format": "uuid"
                          },
                          "digest": {
                              "type": "string",
                              "pattern": "^[0-9a-f]{64}$"
                          },
                          "acceptedAt": {
                              "type": "string",
                              "format": "date-time"
                          }
                      }
                  }
              },
              "acceptedByCaller": {
                  "type": "boolean"
              }
          }
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
      "ResourceCapacityWindow": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "id",
              "startsAt",
              "endsAt",
              "capacity",
              "used",
              "version"
          ],
          "properties": {
              "id": {
                  "type": "string",
                  "format": "uuid"
              },
              "startsAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "endsAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "capacity": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2147483647
              },
              "used": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 2147483647
              },
              "version": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              }
          },
          "description": "Явное конечное окно мощности в объявленных единицах. Окна одного ресурса не пересекаются; used не превышает capacity. Этот API не резервирует мощность."
      },
      "ResourceCapacityWindowCreate": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "startsAt",
              "endsAt",
              "capacity"
          ],
          "properties": {
              "startsAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "endsAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "capacity": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2147483647
              }
          }
      },
      "ResourceCapacityWindowPatch": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "expectedVersion",
              "capacity"
          ],
          "properties": {
              "expectedVersion": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              },
              "capacity": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2147483647
              }
          }
      },
      "ResourceOrderPreparationResult": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "dealId",
              "orderVersion",
              "state",
              "created"
          ],
          "properties": {
              "dealId": {
                  "type": "string",
                  "format": "uuid"
              },
              "orderVersion": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              },
              "state": {
                  "type": "string",
                  "enum": [
                      "candidate",
                      "contacted",
                      "negotiating"
                  ]
              },
              "created": {
                  "type": "boolean"
              }
          }
      },
      "ResourceOrderPreparationWrite": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "vendorId",
              "packageId",
              "expectedSelectedDealId",
              "expectedPolicyRevision"
          ],
          "properties": {
              "vendorId": {
                  "type": "string",
                  "format": "uuid"
              },
              "packageId": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "uuid"
              },
              "expectedSelectedDealId": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "uuid"
              },
              "expectedPolicyRevision": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              }
          }
      },
      "ResourceVersionWrite": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "expectedVersion"
          ],
          "properties": {
              "expectedVersion": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
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
              "availabilityObservation",
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
              "availabilityObservation": {
                  "$ref": "contract#/definitions/AvailabilityObservation"
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
                  "description": "Занятость на дату свадьбы. `null` — дата не выбрана, анкета стёрта или компания использует план ресурсов;\nсвоя бронь этой свадьбы считается `free`.\n"
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
                      "bookingMode": {
                          "type": "string",
                          "enum": [
                              "legacy_day",
                              "resources"
                          ],
                          "description": "Способ бронирования действующей публичной компании; доступность ресурсов не подтверждает."
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
      "TimelineAcknowledgmentStatus": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "kind",
              "id",
              "name",
              "blockCount",
              "status",
              "acknowledgedAt",
              "acknowledgedBy",
              "previousAcknowledgment"
          ],
          "properties": {
              "kind": {
                  "type": "string",
                  "enum": [
                      "registered",
                      "external"
                  ]
              },
              "id": {
                  "type": "string",
                  "format": "uuid",
                  "description": "ID анкеты для registered, ID реальной сделки для external"
              },
              "name": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "blockCount": {
                  "type": "integer",
                  "minimum": 0
              },
              "status": {
                  "type": "string",
                  "enum": [
                      "pending",
                      "acknowledged",
                      "unassigned",
                      "unavailable",
                      "not_supported"
                  ]
              },
              "acknowledgedAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time"
              },
              "acknowledgedBy": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "description": "Текущее имя реального автора для registered; для external всегда null, личность владельца ссылки не проверена"
              },
              "previousAcknowledgment": {
                  "type": [
                      "object",
                      "null"
                  ],
                  "additionalProperties": false,
                  "required": [
                      "sourceVersion",
                      "acknowledgedAt",
                      "acknowledgedBy"
                  ],
                  "properties": {
                      "sourceVersion": {
                          "type": "string"
                      },
                      "acknowledgedAt": {
                          "type": "string",
                          "format": "date-time"
                      },
                      "acknowledgedBy": {
                          "type": [
                              "string",
                              "null"
                          ]
                      }
                  }
              }
          }
      },
      "TimelineAcknowledgments": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "sourceVersion",
              "updatedAt",
              "items"
          ],
          "properties": {
              "sourceVersion": {
                  "type": "string"
              },
              "updatedAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time"
              },
              "items": {
                  "type": "array",
                  "items": {
                      "$ref": "contract#/definitions/TimelineAcknowledgmentStatus"
                  }
              }
          }
      },
      "TimelineEvent": {
          "type": "object",
          "required": [
              "name"
          ],
          "properties": {
              "id": {
                  "type": "string",
                  "format": "uuid",
                  "description": "ID существующего блока; для нового блока поле не передаётся"
              },
              "eventId": {
                  "type": "string",
                  "format": "uuid",
                  "description": "Мероприятие своей свадьбы. Пропущено у существующего блока — связь сохраняется; у нового — основное мероприятие. В гостевой проекции отсутствует. Legacy guest day показывает только разрешённые блоки основной программы до подключения индивидуальных приглашений."
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
              },
              "durationMinutes": {
                  "type": [
                      "number",
                      "null"
                  ],
                  "minimum": 0,
                  "maximum": 10080,
                  "description": "Длительность в минутах; допустима до назначения начала. При начале и длительности сервер вычисляет окончание; противоречащие значения отклоняются. Только в полном тайминге команды."
              },
              "fixed": {
                  "type": "boolean",
                  "description": "Фиксированное начало: нужно startsAt; автоматический сдвиг не двигает блок. Только в полном тайминге команды."
              },
              "travelMinutes": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 10080,
                  "description": "Ручное время переезда, без автоматической оценки маршрута. Только для команды."
              },
              "bufferMinutes": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 10080,
                  "description": "Ручной запас времени. Только для команды."
              },
              "dependsOn": {
                  "type": "array",
                  "maxItems": 60,
                  "items": {
                      "type": "string",
                      "format": "uuid"
                  },
                  "description": "Уникальные ID других блоков сохраняемой программы; чужие, удалённые, собственный ID и циклы запрещены. В гостевой проекции отсутствует."
              },
              "responsible": {
                  "allOf": [
                      {
                          "$ref": "contract#/definitions/TimelineReference"
                      }
                  ],
                  "description": "Один ответственный; null снимает назначение. В гостевой проекции отсутствует.",
                  "type": [
                      "object",
                      "array",
                      "string",
                      "number",
                      "boolean",
                      "null"
                  ]
              },
              "participants": {
                  "type": "array",
                  "maxItems": 200,
                  "items": {
                      "$ref": "contract#/definitions/TimelineReference"
                  },
                  "description": "Уникальные участники. В гостевой проекции отсутствует. Удаление персоны/членства, мягкое удаление аккаунта или отмена сделки снимает назначения и меняет версию."
              }
          }
      },
      "TimelineReference": {
          "type": "object",
          "required": [
              "kind",
              "id"
          ],
          "additionalProperties": false,
          "properties": {
              "kind": {
                  "type": "string",
                  "enum": [
                      "member",
                      "guest",
                      "deal"
                  ]
              },
              "id": {
                  "type": "string",
                  "format": "uuid"
              }
          },
          "description": "Участник своей свадьбы: живой член команды, персона гостей или забронированная сделка (включая своего подрядчика). Только ID и тип, без финансовых данных."
      },
      "TimelineShiftBlockDetails": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "id",
              "name",
              "eventId",
              "eventName",
              "eventDate",
              "timeZone",
              "location",
              "startsAt",
              "endsAt"
          ],
          "properties": {
              "id": {
                  "type": "string",
                  "format": "uuid"
              },
              "name": {
                  "type": "string"
              },
              "eventId": {
                  "type": "string",
                  "format": "uuid"
              },
              "eventName": {
                  "type": "string"
              },
              "eventDate": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date"
              },
              "timeZone": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "location": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "startsAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time"
              },
              "endsAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time",
                  "description": "Известное окончание из записи или точной durationMinutes, тем же расчётом что preview; неизвестное остаётся null"
              }
          }
      },
      "TimelineShiftGuestConsequence": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "guestId",
              "name",
              "eventId",
              "eventName",
              "status",
              "source",
              "version",
              "invitation",
              "assignment"
          ],
          "properties": {
              "guestId": {
                  "type": "string",
                  "format": "uuid"
              },
              "name": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "eventId": {
                  "type": "string",
                  "format": "uuid"
              },
              "eventName": {
                  "type": "string"
              },
              "status": {
                  "type": "string",
                  "enum": [
                      "unknown",
                      "attending",
                      "declined"
                  ]
              },
              "source": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "enum": [
                      "legacy_main_rsvp",
                      "guest_response",
                      "team_observation",
                      "organizer_correction",
                      null
                  ]
              },
              "version": {
                  "type": "string",
                  "pattern": "^[0-9]+$"
              },
              "invitation": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "enum": [
                      "explicit",
                      "main_legacy",
                      null
                  ],
                  "description": "explicit — персональное приглашение; main_legacy — основной список; null — назначения без приглашения."
              },
              "assignment": {
                  "type": "boolean",
                  "description": "Персона назначена участником или ответственным затронутого блока этого мероприятия."
              }
          }
      },
      "TimelineShiftMoment": {
          "type": "object",
          "required": [
              "startsAt",
              "endsAt"
          ],
          "properties": {
              "startsAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "endsAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time"
              }
          }
      },
      "TimelineShiftPreview": {
          "type": "object",
          "required": [
              "scope",
              "minutes",
              "canConfirm",
              "blocks",
              "blockDetails",
              "excluded",
              "conflicts",
              "affectedBlockIds",
              "affectedReferences",
              "referenceDetails",
              "movements",
              "guestsAffected",
              "affectedGuestIds",
              "affectedGuests",
              "guestConsequences",
              "unknownGuestCount",
              "guestConsequencesIncomplete",
              "affectedVendorIds",
              "affectedMemberIds",
              "expiresAt",
              "previewToken",
              "sourceVersion"
          ],
          "properties": {
              "scope": {
                  "type": "object",
                  "required": [
                      "kind",
                      "date",
                      "timeZone"
                  ],
                  "properties": {
                      "kind": {
                          "type": "string",
                          "enum": [
                              "day",
                              "event"
                          ]
                      },
                      "eventId": {
                          "type": "string",
                          "format": "uuid"
                      },
                      "date": {
                          "type": "string",
                          "format": "date"
                      },
                      "timeZone": {
                          "type": "string"
                      }
                  }
              },
              "minutes": {
                  "type": "integer"
              },
              "sourceVersion": {
                  "type": "string"
              },
              "canConfirm": {
                  "type": "boolean"
              },
              "expiresAt": {
                  "type": "string",
                  "format": "date-time"
              },
              "previewToken": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "blocks": {
                  "type": "array",
                  "items": {
                      "type": "object",
                      "required": [
                          "id",
                          "before",
                          "after"
                      ],
                      "properties": {
                          "id": {
                              "type": "string",
                              "format": "uuid"
                          },
                          "before": {
                              "$ref": "contract#/definitions/TimelineShiftMoment"
                          },
                          "after": {
                              "$ref": "contract#/definitions/TimelineShiftMoment"
                          }
                      }
                  }
              },
              "excluded": {
                  "type": "array",
                  "items": {
                      "type": "object",
                      "required": [
                          "id",
                          "reason"
                      ],
                      "properties": {
                          "id": {
                              "type": "string",
                              "format": "uuid"
                          },
                          "reason": {
                              "type": "string",
                              "enum": [
                                  "undated",
                                  "other_day",
                                  "other_event",
                                  "fixed",
                                  "past"
                              ]
                          }
                      }
                  }
              },
              "conflicts": {
                  "type": "array",
                  "items": {
                      "type": "object",
                      "required": [
                          "kind",
                          "blockIds"
                      ],
                      "properties": {
                          "kind": {
                              "type": "string",
                              "enum": [
                                  "shifted_into_past",
                                  "crosses_day",
                                  "unknown_duration",
                                  "invalid_interval",
                                  "missing_dependency",
                                  "unknown_dependency_time",
                                  "dependency_timing",
                                  "unknown_participant_time",
                                  "participant_overlap",
                                  "travel_buffer_overlap"
                              ]
                          },
                          "blockIds": {
                              "type": "array",
                              "items": {
                                  "type": "string",
                                  "format": "uuid"
                              }
                          }
                      }
                  }
              },
              "affectedBlockIds": {
                  "type": "array",
                  "items": {
                      "type": "string",
                      "format": "uuid"
                  }
              },
              "affectedReferences": {
                  "type": "array",
                  "items": {
                      "$ref": "contract#/definitions/TimelineReference"
                  }
              },
              "blockDetails": {
                  "type": "array",
                  "description": "Имена и контекст блоков из того же авторизованного снимка; родительский список клиента не является источником подписанных последствий.",
                  "items": {
                      "$ref": "contract#/definitions/TimelineShiftBlockDetails"
                  }
              },
              "referenceDetails": {
                  "type": "array",
                  "description": "Минимальные имена затронутых назначений, без телефонов, финансов и скрытых vendor user IDs. Неизвестное имя остаётся null.",
                  "items": {
                      "$ref": "contract#/definitions/TimelineShiftReferenceDetails"
                  }
              },
              "affectedGuests": {
                  "type": "array",
                  "description": "Уникальные персоны с attending в затронутых мероприятиях; это последствия, не доставка сообщения.",
                  "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                          "id",
                          "name"
                      ],
                      "properties": {
                          "id": {
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
                  }
              },
              "guestConsequences": {
                  "type": "array",
                  "description": "Персональные последствия по мероприятиям из того же подписанного снимка. Публичный блок дополнительного события включает только реально приглашённых персон; назначение конкретного человека не расширяется до семьи. Отсутствующее участие дополнительного события unknown/null/0; legacy RSVP допустим только для основного. Чтение не создаёт участие и не отправляет сообщения гостям.",
                  "items": {
                      "$ref": "contract#/definitions/TimelineShiftGuestConsequence"
                  }
              },
              "unknownGuestCount": {
                  "type": "integer",
                  "minimum": 0,
                  "description": "Число уникальных персон с неизвестным участием хотя бы в одном затронутом мероприятии."
              },
              "guestConsequencesIncomplete": {
                  "type": "boolean",
                  "description": "Есть неизвестное персональное участие; это не отказ от сдвига и не доказательство доставки."
              },
              "movements": {
                  "type": "array",
                  "items": {
                      "type": "object",
                      "required": [
                          "blockId",
                          "location",
                          "travelMinutes",
                          "bufferMinutes",
                          "beforeArrival",
                          "afterArrival"
                      ],
                      "properties": {
                          "blockId": {
                              "type": "string",
                              "format": "uuid"
                          },
                          "location": {
                              "type": [
                                  "string",
                                  "null"
                              ]
                          },
                          "travelMinutes": {
                              "type": "number"
                          },
                          "bufferMinutes": {
                              "type": "number"
                          },
                          "beforeArrival": {
                              "type": [
                                  "string",
                                  "null"
                              ],
                              "format": "date-time",
                              "description": "Плановое начало блока с ручными travel/buffer до сдвига, не фактическое прибытие рейса"
                          },
                          "afterArrival": {
                              "type": [
                                  "string",
                                  "null"
                              ],
                              "format": "date-time",
                              "description": "Плановое начало блока с ручными travel/buffer после сдвига, не фактическое прибытие рейса"
                          }
                      }
                  }
              },
              "guestsAffected": {
                  "type": "integer"
              },
              "affectedGuestIds": {
                  "type": "array",
                  "items": {
                      "type": "string",
                      "format": "uuid"
                  }
              },
              "affectedVendorIds": {
                  "type": "array",
                  "items": {
                      "type": "string",
                      "format": "uuid"
                  }
              },
              "affectedMemberIds": {
                  "type": "array",
                  "items": {
                      "type": "string",
                      "format": "uuid"
                  }
              }
          }
      },
      "TimelineShiftReceipt": {
          "type": "object",
          "required": [
              "minutes",
              "shiftedBlocks",
              "guestsAffected"
          ],
          "description": "Ответ принятого сдвига. Новые команды сохраняют персональный снимок и неопределённость. Поля последствий optional только для неизменного replay исторических ответов; отсутствие метаданных не означает ноль неизвестных.",
          "properties": {
              "minutes": {
                  "type": "integer"
              },
              "shiftedBlocks": {
                  "type": "integer"
              },
              "guestsAffected": {
                  "type": "integer",
                  "minimum": 0,
                  "description": "Уникальные attending персоны хотя бы одного затронутого мероприятия, без подтверждения доставки."
              },
              "guestConsequences": {
                  "type": "array",
                  "items": {
                      "$ref": "contract#/definitions/TimelineShiftGuestConsequence"
                  }
              },
              "unknownGuestCount": {
                  "type": "integer",
                  "minimum": 0
              },
              "guestConsequencesIncomplete": {
                  "type": "boolean"
              }
          }
      },
      "TimelineShiftReferenceDetails": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "kind",
              "id",
              "name",
              "assignments"
          ],
          "properties": {
              "kind": {
                  "type": "string",
                  "enum": [
                      "member",
                      "guest",
                      "deal"
                  ]
              },
              "id": {
                  "type": "string",
                  "format": "uuid"
              },
              "name": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "assignments": {
                  "type": "array",
                  "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                          "blockId",
                          "role"
                      ],
                      "properties": {
                          "blockId": {
                              "type": "string",
                              "format": "uuid"
                          },
                          "role": {
                              "type": "string",
                              "enum": [
                                  "responsible",
                                  "participant"
                              ]
                          }
                      }
                  }
              }
          }
      },
      "TimelineShiftScope": {
          "oneOf": [
              {
                  "type": "object",
                  "required": [
                      "kind",
                      "date"
                  ],
                  "additionalProperties": false,
                  "properties": {
                      "kind": {
                          "type": "string",
                          "enum": [
                              "day"
                          ]
                      },
                      "date": {
                          "type": "string",
                          "format": "date"
                      }
                  }
              },
              {
                  "type": "object",
                  "required": [
                      "kind",
                      "eventId"
                  ],
                  "additionalProperties": false,
                  "properties": {
                      "kind": {
                          "type": "string",
                          "enum": [
                              "event"
                          ]
                      },
                      "eventId": {
                          "type": "string",
                          "format": "uuid"
                      }
                  }
              }
          ]
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
                  "description": "по умолчанию 22:00–09:00; день свадьбы не отключает тишину",
                  "properties": {
                      "from": {
                          "type": "string"
                      },
                      "to": {
                          "type": "string"
                      }
                  }
              },
              "urgentIncidents": {
                  "type": "boolean",
                  "default": false,
                  "description": "Личное разрешение срочных push о подтверждённой проблеме своего события вне тихих часов; не включает отключённые каналы."
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
              "bookingMode": {
                  "type": "string",
                  "enum": [
                      "legacy_day",
                      "resources"
                  ],
                  "description": "Способ бронирования компании. Доступность конкретных ресурсов и времени этим полем не подтверждается."
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
      "VendorAvailabilityPolicy": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "vendorId",
              "mode",
              "revision",
              "changedBy",
              "changedAt",
              "legacyObligations"
          ],
          "properties": {
              "vendorId": {
                  "type": "string",
                  "format": "uuid"
              },
              "mode": {
                  "type": "string",
                  "enum": [
                      "legacy_day",
                      "resources"
                  ]
              },
              "revision": {
                  "type": "string",
                  "pattern": "^(0|[1-9][0-9]{0,18})$"
              },
              "changedBy": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "uuid"
              },
              "changedAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time"
              },
              "legacyObligations": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                      "unresolved",
                      "manualDays",
                      "dealDays",
                      "unknownDays",
                      "committedDeals",
                      "negotiatingDeals",
                      "reason"
                  ],
                  "properties": {
                      "unresolved": {
                          "type": "boolean"
                      },
                      "manualDays": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 2147483647
                      },
                      "dealDays": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 2147483647
                      },
                      "unknownDays": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 2147483647
                      },
                      "committedDeals": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 2147483647
                      },
                      "negotiatingDeals": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 2147483647
                      },
                      "reason": {
                          "type": [
                              "string",
                              "null"
                          ],
                          "enum": [
                              "unresolved_legacy_obligations",
                              null
                          ]
                      }
                  }
              }
          },
          "description": "Выбранная стратегия новых обязательств. Изменение режима не освобождает старые занятые дни, сделки или деньги. unresolved — диагностика старых обязательств, не запрет любых будущих дат."
      },
      "VendorAvailabilityPolicyWrite": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "mode",
              "expectedRevision"
          ],
          "properties": {
              "mode": {
                  "type": "string",
                  "enum": [
                      "legacy_day",
                      "resources"
                  ]
              },
              "expectedRevision": {
                  "type": "string",
                  "pattern": "^(0|[1-9][0-9]{0,18})$"
              }
          }
      },
      "VendorBookingPolicy": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "mode",
              "revision"
          ],
          "properties": {
              "mode": {
                  "type": "string",
                  "enum": [
                      "legacy_day",
                      "resources"
                  ]
              },
              "revision": {
                  "type": "string",
                  "pattern": "^(0|[1-9][0-9]{0,18})$"
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
      "VendorPaymentRecord": {
          "allOf": [
              {
                  "$ref": "contract#/definitions/PaymentRecord"
              },
              {
                  "type": "object",
                  "required": [
                      "receipts"
                  ],
                  "properties": {
                      "receipts": {
                          "type": "array",
                          "items": {
                              "type": "object",
                              "required": [
                                  "id",
                                  "filename",
                                  "mimeType",
                                  "sizeBytes",
                                  "createdAt"
                              ],
                              "properties": {
                                  "id": {
                                      "type": "string",
                                      "format": "uuid"
                                  },
                                  "filename": {
                                      "type": "string"
                                  },
                                  "mimeType": {
                                      "type": "string"
                                  },
                                  "sizeBytes": {
                                      "type": "integer",
                                      "minimum": 0
                                  },
                                  "createdAt": {
                                      "type": "string",
                                      "format": "date-time"
                                  }
                              }
                          }
                      }
                  }
              }
          ]
      },
      "VendorProgramAck": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "sourceVersion",
              "acknowledgedAt"
          ],
          "properties": {
              "sourceVersion": {
                  "type": "string",
                  "pattern": "^[0-9]+$"
              },
              "acknowledgedAt": {
                  "type": "string",
                  "format": "date-time"
              }
          }
      },
      "VendorProgramBlock": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "id",
              "name",
              "location",
              "startsAt",
              "endsAt",
              "durationMinutes",
              "fixed",
              "travelMinutes",
              "bufferMinutes",
              "outdoor",
              "roles",
              "dependsOn",
              "event"
          ],
          "properties": {
              "id": {
                  "type": "string",
                  "format": "uuid"
              },
              "name": {
                  "type": "string"
              },
              "location": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "startsAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time"
              },
              "endsAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time",
                  "description": "Сохранённое окончание или точная явная длительность; неизвестное null"
              },
              "durationMinutes": {
                  "type": [
                      "number",
                      "null"
                  ]
              },
              "fixed": {
                  "type": "boolean"
              },
              "travelMinutes": {
                  "type": "number",
                  "minimum": 0
              },
              "bufferMinutes": {
                  "type": "number",
                  "minimum": 0
              },
              "outdoor": {
                  "type": "boolean"
              },
              "roles": {
                  "type": "array",
                  "items": {
                      "type": "string",
                      "enum": [
                          "responsible",
                          "participant"
                      ]
                  }
              },
              "dependsOn": {
                  "type": "array",
                  "items": {
                      "type": "string",
                      "format": "uuid"
                  },
                  "description": "Только ID других разрешённых блоков этого снимка"
              },
              "event": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                      "id",
                      "name",
                      "date",
                      "timeZone",
                      "location"
                  ],
                  "properties": {
                      "id": {
                          "type": "string",
                          "format": "uuid"
                      },
                      "name": {
                          "type": "string"
                      },
                      "date": {
                          "type": [
                              "string",
                              "null"
                          ],
                          "format": "date"
                      },
                      "timeZone": {
                          "type": [
                              "string",
                              "null"
                          ]
                      },
                      "location": {
                          "type": [
                              "string",
                              "null"
                          ]
                      }
                  }
              }
          }
      },
      "VendorProgramSnapshot": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "weddingId",
              "wedding",
              "sourceVersion",
              "updatedAt",
              "blocks",
              "acknowledgedAt",
              "requiresAcknowledgment",
              "readToken",
              "expiresAt"
          ],
          "properties": {
              "weddingId": {
                  "type": "string",
                  "format": "uuid"
              },
              "wedding": {
                  "type": "string"
              },
              "sourceVersion": {
                  "type": "string",
                  "pattern": "^[0-9]+$"
              },
              "updatedAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time"
              },
              "blocks": {
                  "type": "array",
                  "items": {
                      "$ref": "contract#/definitions/VendorProgramBlock"
                  }
              },
              "acknowledgedAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time"
              },
              "requiresAcknowledgment": {
                  "type": "boolean"
              },
              "readToken": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "expiresAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time"
              }
          }
      },
      "VendorProgramSummary": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "weddingId",
              "wedding",
              "sourceVersion",
              "updatedAt",
              "blockCount",
              "acknowledgedAt",
              "requiresAcknowledgment"
          ],
          "properties": {
              "weddingId": {
                  "type": "string",
                  "format": "uuid"
              },
              "wedding": {
                  "type": "string"
              },
              "sourceVersion": {
                  "type": "string",
                  "pattern": "^[0-9]+$"
              },
              "updatedAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time"
              },
              "blockCount": {
                  "type": "integer",
                  "minimum": 0
              },
              "acknowledgedAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time"
              },
              "requiresAcknowledgment": {
                  "type": "boolean"
              }
          }
      },
      "VendorResource": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "id",
              "kind",
              "label",
              "version",
              "personUserId",
              "staffMemberId",
              "capacityUnit",
              "retiredAt",
              "source",
              "unavailableReason",
              "windows"
          ],
          "properties": {
              "id": {
                  "type": "string",
                  "format": "uuid"
              },
              "kind": {
                  "type": "string",
                  "enum": [
                      "person",
                      "equipment",
                      "capacity"
                  ]
              },
              "label": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 200
              },
              "version": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              },
              "personUserId": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "uuid"
              },
              "staffMemberId": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "uuid"
              },
              "capacityUnit": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "maxLength": 80
              },
              "retiredAt": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time"
              },
              "source": {
                  "type": "string",
                  "enum": [
                      "current",
                      "unavailable"
                  ]
              },
              "unavailableReason": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "enum": [
                      "retired",
                      "identity_unknown",
                      "person_unavailable",
                      null
                  ]
              },
              "windows": {
                  "type": "array",
                  "items": {
                      "$ref": "contract#/definitions/ResourceCapacityWindow"
                  }
              }
          },
          "description": "Реально заявленный ресурс. current означает действующий источник идентичности, не свободный интервал, бронь или готовность. Внутренний conflict_identity не выдаётся."
      },
      "VendorResourceCreate": {
          "oneOf": [
              {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                      "kind",
                      "label",
                      "personUserId"
                  ],
                  "properties": {
                      "kind": {
                          "type": "string",
                          "enum": [
                              "person"
                          ]
                      },
                      "label": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 200
                      },
                      "personUserId": {
                          "type": "string",
                          "format": "uuid"
                      },
                      "staffMemberId": {
                          "type": "string",
                          "format": "uuid"
                      }
                  }
              },
              {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                      "kind",
                      "label"
                  ],
                  "properties": {
                      "kind": {
                          "type": "string",
                          "enum": [
                              "equipment"
                          ]
                      },
                      "label": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 200
                      }
                  }
              },
              {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                      "kind",
                      "label",
                      "capacityUnit"
                  ],
                  "properties": {
                      "kind": {
                          "type": "string",
                          "enum": [
                              "capacity"
                          ]
                      },
                      "label": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 200
                      },
                      "capacityUnit": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 80
                      }
                  }
              }
          ]
      },
      "VendorResourceOptions": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "vendorId",
              "actorRole",
              "persons"
          ],
          "properties": {
              "vendorId": {
                  "type": "string",
                  "format": "uuid"
              },
              "actorRole": {
                  "type": "string",
                  "enum": [
                      "owner",
                      "resource_manager"
                  ]
              },
              "persons": {
                  "type": "array",
                  "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                          "userId",
                          "name",
                          "staffMemberId"
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
                          },
                          "staffMemberId": {
                              "type": [
                                  "string",
                                  "null"
                              ],
                              "format": "uuid"
                          }
                      }
                  }
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
      "WeddingAttention": {
          "type": "object",
          "required": [
              "version",
              "mode",
              "coordinatorUserId",
              "effectiveMode",
              "coordinatorState",
              "coordinator"
          ],
          "properties": {
              "version": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]*$"
              },
              "mode": {
                  "type": "string",
                  "enum": [
                      "essential",
                      "coordinator",
                      "detailed"
                  ]
              },
              "coordinatorUserId": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "uuid"
              },
              "effectiveMode": {
                  "type": "string",
                  "enum": [
                      "essential",
                      "coordinator",
                      "detailed"
                  ]
              },
              "coordinatorState": {
                  "type": "string",
                  "enum": [
                      "not_selected",
                      "active",
                      "unavailable"
                  ]
              },
              "coordinator": {
                  "type": [
                      "object",
                      "null"
                  ],
                  "required": [
                      "id",
                      "name"
                  ],
                  "properties": {
                      "id": {
                          "type": "string",
                          "format": "uuid"
                      },
                      "name": {
                          "type": "string"
                      }
                  }
              }
          }
      },
      "WeddingEvent": {
          "type": "object",
          "required": [
              "id",
              "name",
              "kind",
              "date",
              "timeZone",
              "location",
              "isMain",
              "rsvpDeadline"
          ],
          "properties": {
              "id": {
                  "type": "string",
                  "format": "uuid"
              },
              "name": {
                  "type": "string"
              },
              "kind": {
                  "$ref": "contract#/definitions/WeddingEventKind"
              },
              "date": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date"
              },
              "timeZone": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "location": {
                  "type": [
                      "string",
                      "null"
                  ]
              },
              "isMain": {
                  "type": "boolean"
              },
              "rsvpDeadline": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date",
                  "description": "Срок ответа на мероприятие включительно, в его часовом поясе (T012).\nБывает только у дополнительных мероприятий (`is_main=false`); `null` —\nсрок не задан. Не обязательное поле: ответы, выданные до T012, его не\nнесут.\n"
              }
          }
      },
      "WeddingEventKind": {
          "type": "string",
          "enum": [
              "registration",
              "nikah",
              "ceremony",
              "banquet",
              "second_day",
              "other"
          ]
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
      "WeddingOrder": {
          "type": "object",
          "additionalProperties": false,
          "required": [
              "dealId",
              "version",
              "schemaVersion",
              "source",
              "brief",
              "assignments",
              "parts"
          ],
          "properties": {
              "externalContact": {
                  "allOf": [
                      {
                          "$ref": "contract#/definitions/OrderExternalContact"
                      }
                  ],
                  "readOnly": true,
                  "description": "Только для внешней сделки; данные пары, не принятие условий исполнителем"
              },
              "dealId": {
                  "type": "string",
                  "format": "uuid"
              },
              "version": {
                  "type": "string",
                  "pattern": "^[1-9][0-9]{0,18}$"
              },
              "schemaVersion": {
                  "type": "integer",
                  "enum": [
                      1
                  ]
              },
              "source": {
                  "type": "string",
                  "enum": [
                      "legacy",
                      "structured"
                  ]
              },
              "brief": {
                  "type": [
                      "object",
                      "null"
                  ],
                  "additionalProperties": false,
                  "required": [
                      "categoryId",
                      "values"
                  ],
                  "properties": {
                      "categoryId": {
                          "type": "string"
                      },
                      "subtypeId": {
                          "type": "string"
                      },
                      "values": {
                          "type": "object",
                          "additionalProperties": true
                      }
                  }
              },
              "assignments": {
                  "type": "array",
                  "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                          "id",
                          "slotId",
                          "programEventId",
                          "version",
                          "source",
                          "label",
                          "cancelledAt"
                      ],
                      "properties": {
                          "id": {
                              "type": "string",
                              "format": "uuid"
                          },
                          "slotId": {
                              "type": "string",
                              "format": "uuid"
                          },
                          "programEventId": {
                              "type": "string",
                              "format": "uuid"
                          },
                          "version": {
                              "type": "string",
                              "pattern": "^[1-9][0-9]{0,18}$"
                          },
                          "source": {
                              "type": "string",
                              "enum": [
                                  "legacy",
                                  "structured"
                              ]
                          },
                          "label": {
                              "type": "string"
                          },
                          "cancelledAt": {
                              "type": [
                                  "string",
                                  "null"
                              ],
                              "format": "date-time"
                          }
                      }
                  }
              },
              "parts": {
                  "type": "array",
                  "items": {
                      "oneOf": [
                          {
                              "type": "object",
                              "additionalProperties": false,
                              "required": [
                                  "id",
                                  "kind",
                                  "version",
                                  "assignmentId",
                                  "source",
                                  "title",
                                  "details",
                                  "cancelledAt"
                              ],
                              "properties": {
                                  "id": {
                                      "type": "string",
                                      "format": "uuid"
                                  },
                                  "kind": {
                                      "type": "string",
                                      "enum": [
                                          "timed_service"
                                      ]
                                  },
                                  "version": {
                                      "type": "string",
                                      "pattern": "^[1-9][0-9]{0,18}$"
                                  },
                                  "assignmentId": {
                                      "type": [
                                          "string",
                                          "null"
                                      ],
                                      "format": "uuid"
                                  },
                                  "source": {
                                      "type": "string",
                                      "enum": [
                                          "legacy",
                                          "structured"
                                      ]
                                  },
                                  "title": {
                                      "type": "string"
                                  },
                                  "details": {
                                      "type": "object",
                                      "additionalProperties": false,
                                      "required": [
                                          "startsAt",
                                          "endsAt",
                                          "location",
                                          "setupMinutes",
                                          "teardownMinutes",
                                          "travelMinutes"
                                      ],
                                      "properties": {
                                          "startsAt": {
                                              "type": [
                                                  "string",
                                                  "null"
                                              ],
                                              "format": "date-time"
                                          },
                                          "endsAt": {
                                              "type": [
                                                  "string",
                                                  "null"
                                              ],
                                              "format": "date-time"
                                          },
                                          "location": {
                                              "type": [
                                                  "string",
                                                  "null"
                                              ],
                                              "maxLength": 2000
                                          },
                                          "setupMinutes": {
                                              "type": [
                                                  "integer",
                                                  "null"
                                              ],
                                              "minimum": 0,
                                              "maximum": 10080
                                          },
                                          "teardownMinutes": {
                                              "type": [
                                                  "integer",
                                                  "null"
                                              ],
                                              "minimum": 0,
                                              "maximum": 10080
                                          },
                                          "travelMinutes": {
                                              "type": [
                                                  "integer",
                                                  "null"
                                              ],
                                              "minimum": 0,
                                              "maximum": 10080
                                          }
                                      }
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
                          {
                              "type": "object",
                              "additionalProperties": false,
                              "required": [
                                  "id",
                                  "kind",
                                  "version",
                                  "assignmentId",
                                  "source",
                                  "title",
                                  "details",
                                  "cancelledAt"
                              ],
                              "properties": {
                                  "id": {
                                      "type": "string",
                                      "format": "uuid"
                                  },
                                  "kind": {
                                      "type": "string",
                                      "enum": [
                                          "supply"
                                      ]
                                  },
                                  "version": {
                                      "type": "string",
                                      "pattern": "^[1-9][0-9]{0,18}$"
                                  },
                                  "assignmentId": {
                                      "type": [
                                          "string",
                                          "null"
                                      ],
                                      "format": "uuid"
                                  },
                                  "source": {
                                      "type": "string",
                                      "enum": [
                                          "legacy",
                                          "structured"
                                      ]
                                  },
                                  "title": {
                                      "type": "string"
                                  },
                                  "details": {
                                      "type": "object",
                                      "additionalProperties": false,
                                      "required": [
                                          "quantity",
                                          "unit",
                                          "windowStartsAt",
                                          "windowEndsAt",
                                          "location",
                                          "recipient",
                                          "substitutions"
                                      ],
                                      "properties": {
                                          "quantity": {
                                              "type": [
                                                  "integer",
                                                  "null"
                                              ],
                                              "minimum": 1,
                                              "maximum": 1000000
                                          },
                                          "unit": {
                                              "type": [
                                                  "string",
                                                  "null"
                                              ],
                                              "maxLength": 80
                                          },
                                          "windowStartsAt": {
                                              "type": [
                                                  "string",
                                                  "null"
                                              ],
                                              "format": "date-time"
                                          },
                                          "windowEndsAt": {
                                              "type": [
                                                  "string",
                                                  "null"
                                              ],
                                              "format": "date-time"
                                          },
                                          "location": {
                                              "type": [
                                                  "string",
                                                  "null"
                                              ],
                                              "maxLength": 2000
                                          },
                                          "recipient": {
                                              "type": [
                                                  "string",
                                                  "null"
                                              ],
                                              "maxLength": 2000
                                          },
                                          "substitutions": {
                                              "type": [
                                                  "string",
                                                  "null"
                                              ],
                                              "maxLength": 2000
                                          }
                                      }
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
                          {
                              "type": "object",
                              "additionalProperties": false,
                              "required": [
                                  "id",
                                  "kind",
                                  "version",
                                  "assignmentId",
                                  "source",
                                  "title",
                                  "details",
                                  "cancelledAt"
                              ],
                              "properties": {
                                  "id": {
                                      "type": "string",
                                      "format": "uuid"
                                  },
                                  "kind": {
                                      "type": "string",
                                      "enum": [
                                          "rental"
                                      ]
                                  },
                                  "version": {
                                      "type": "string",
                                      "pattern": "^[1-9][0-9]{0,18}$"
                                  },
                                  "assignmentId": {
                                      "type": [
                                          "string",
                                          "null"
                                      ],
                                      "format": "uuid"
                                  },
                                  "source": {
                                      "type": "string",
                                      "enum": [
                                          "legacy",
                                          "structured"
                                      ]
                                  },
                                  "title": {
                                      "type": "string"
                                  },
                                  "details": {
                                      "type": "object",
                                      "additionalProperties": false,
                                      "required": [
                                          "quantity",
                                          "unit",
                                          "handoverAt",
                                          "returnAt",
                                          "location",
                                          "recipient",
                                          "condition",
                                          "depositTerms"
                                      ],
                                      "properties": {
                                          "quantity": {
                                              "type": [
                                                  "integer",
                                                  "null"
                                              ],
                                              "minimum": 1,
                                              "maximum": 1000000
                                          },
                                          "unit": {
                                              "type": [
                                                  "string",
                                                  "null"
                                              ],
                                              "maxLength": 80
                                          },
                                          "handoverAt": {
                                              "type": [
                                                  "string",
                                                  "null"
                                              ],
                                              "format": "date-time"
                                          },
                                          "returnAt": {
                                              "type": [
                                                  "string",
                                                  "null"
                                              ],
                                              "format": "date-time"
                                          },
                                          "location": {
                                              "type": [
                                                  "string",
                                                  "null"
                                              ],
                                              "maxLength": 2000
                                          },
                                          "recipient": {
                                              "type": [
                                                  "string",
                                                  "null"
                                              ],
                                              "maxLength": 2000
                                          },
                                          "condition": {
                                              "type": [
                                                  "string",
                                                  "null"
                                              ],
                                              "maxLength": 2000
                                          },
                                          "depositTerms": {
                                              "type": [
                                                  "string",
                                                  "null"
                                              ],
                                              "maxLength": 2000
                                          }
                                      }
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
                          {
                              "type": "object",
                              "additionalProperties": false,
                              "required": [
                                  "id",
                                  "kind",
                                  "version",
                                  "assignmentId",
                                  "source",
                                  "title",
                                  "details",
                                  "cancelledAt"
                              ],
                              "properties": {
                                  "id": {
                                      "type": "string",
                                      "format": "uuid"
                                  },
                                  "kind": {
                                      "type": "string",
                                      "enum": [
                                          "deliverable"
                                      ]
                                  },
                                  "version": {
                                      "type": "string",
                                      "pattern": "^[1-9][0-9]{0,18}$"
                                  },
                                  "assignmentId": {
                                      "type": [
                                          "string",
                                          "null"
                                      ],
                                      "format": "uuid"
                                  },
                                  "source": {
                                      "type": "string",
                                      "enum": [
                                          "legacy",
                                          "structured"
                                      ]
                                  },
                                  "title": {
                                      "type": "string"
                                  },
                                  "details": {
                                      "type": "object",
                                      "additionalProperties": false,
                                      "required": [
                                          "items",
                                          "dueAt",
                                          "recipient",
                                          "reviewProcess"
                                      ],
                                      "properties": {
                                          "items": {
                                              "type": [
                                                  "array",
                                                  "null"
                                              ],
                                              "maxItems": 100,
                                              "items": {
                                                  "type": "string",
                                                  "minLength": 1,
                                                  "maxLength": 500
                                              }
                                          },
                                          "dueAt": {
                                              "type": [
                                                  "string",
                                                  "null"
                                              ],
                                              "format": "date-time"
                                          },
                                          "recipient": {
                                              "type": [
                                                  "string",
                                                  "null"
                                              ],
                                              "maxLength": 2000
                                          },
                                          "reviewProcess": {
                                              "type": [
                                                  "string",
                                                  "null"
                                              ],
                                              "maxLength": 2000
                                          }
                                      }
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
                          {
                              "type": "object",
                              "additionalProperties": false,
                              "required": [
                                  "id",
                                  "kind",
                                  "version",
                                  "assignmentId",
                                  "source",
                                  "title",
                                  "details",
                                  "cancelledAt"
                              ],
                              "properties": {
                                  "id": {
                                      "type": "string",
                                      "format": "uuid"
                                  },
                                  "kind": {
                                      "type": "string",
                                      "enum": [
                                          "appointment"
                                      ]
                                  },
                                  "version": {
                                      "type": "string",
                                      "pattern": "^[1-9][0-9]{0,18}$"
                                  },
                                  "assignmentId": {
                                      "type": [
                                          "string",
                                          "null"
                                      ],
                                      "format": "uuid"
                                  },
                                  "source": {
                                      "type": "string",
                                      "enum": [
                                          "legacy",
                                          "structured"
                                      ]
                                  },
                                  "title": {
                                      "type": "string"
                                  },
                                  "details": {
                                      "type": "object",
                                      "additionalProperties": false,
                                      "required": [
                                          "startsAt",
                                          "endsAt",
                                          "location",
                                          "setupMinutes",
                                          "teardownMinutes",
                                          "travelMinutes"
                                      ],
                                      "properties": {
                                          "startsAt": {
                                              "type": [
                                                  "string",
                                                  "null"
                                              ],
                                              "format": "date-time"
                                          },
                                          "endsAt": {
                                              "type": [
                                                  "string",
                                                  "null"
                                              ],
                                              "format": "date-time"
                                          },
                                          "location": {
                                              "type": [
                                                  "string",
                                                  "null"
                                              ],
                                              "maxLength": 2000
                                          },
                                          "setupMinutes": {
                                              "type": [
                                                  "integer",
                                                  "null"
                                              ],
                                              "minimum": 0,
                                              "maximum": 10080
                                          },
                                          "teardownMinutes": {
                                              "type": [
                                                  "integer",
                                                  "null"
                                              ],
                                              "minimum": 0,
                                              "maximum": 10080
                                          },
                                          "travelMinutes": {
                                              "type": [
                                                  "integer",
                                                  "null"
                                              ],
                                              "minimum": 0,
                                              "maximum": 10080
                                          }
                                      }
                                  },
                                  "cancelledAt": {
                                      "type": [
                                          "string",
                                          "null"
                                      ],
                                      "format": "date-time"
                                  }
                              }
                          }
                      ]
                  }
              }
          }
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
  | "AvailabilityObservation"
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
  | "EventInvitationRoster"
  | "EventRsvpCouplePerson"
  | "EventRsvpDeadline"
  | "EventRsvpDecisionResult"
  | "EventRsvpPerson"
  | "EventRsvpRequest"
  | "EventRsvpRoster"
  | "FinancialBalance"
  | "Fund"
  | "Gift"
  | "Guest"
  | "GuestInvitedEvent"
  | "GuestPersonRsvp"
  | "GuestRsvpEvent"
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
  | "OfferComparisonTerms"
  | "OfferComparisonTermsInput"
  | "OfferInput"
  | "OfferPublic"
  | "OfferRequest"
  | "OrderAssignmentCancel"
  | "OrderAssignmentCreate"
  | "OrderBriefField"
  | "OrderBriefSubtype"
  | "OrderBriefWrite"
  | "OrderCatalog"
  | "OrderCategoryBrief"
  | "OrderExternalContact"
  | "OrderExternalContactWrite"
  | "OrderPartCancel"
  | "OrderPartCreate"
  | "OrderPartPatch"
  | "OrderResourceCommitmentView"
  | "OrderResourceCommitmentWrite"
  | "OrderResourcePlanLineInput"
  | "OrderResourcePlanView"
  | "OrderResourcePlanWrite"
  | "OrderTermsAccept"
  | "OrderTermsPublish"
  | "OrderTermsView"
  | "PaymentAmendmentActor"
  | "PaymentCorrection"
  | "PaymentCorrectionList"
  | "PaymentCorrectionResult"
  | "PaymentCorrectionState"
  | "PaymentCorrectionWrite"
  | "PaymentDeal"
  | "PaymentHistoryExport"
  | "PaymentInstallment"
  | "PaymentInstallmentCreate"
  | "PaymentInstallmentEdit"
  | "PaymentInstallmentEditList"
  | "PaymentInstallmentPatch"
  | "PaymentInstallmentPay"
  | "PaymentInstallmentState"
  | "PaymentInstallmentStatus"
  | "PaymentMethod"
  | "PaymentPlanLink"
  | "PaymentRecord"
  | "PaymentSchedule"
  | "PaymentSummary"
  | "PaymentVisibility"
  | "PositiveMoney"
  | "PositivePaymentMoney"
  | "PrebookedCategory"
  | "PublicOrderResourcePlan"
  | "PublicOrderResourcePlanLine"
  | "PublishedOrderTerms"
  | "Readiness"
  | "ResourceCapacityWindow"
  | "ResourceCapacityWindowCreate"
  | "ResourceCapacityWindowPatch"
  | "ResourceOrderPreparationResult"
  | "ResourceOrderPreparationWrite"
  | "ResourceVersionWrite"
  | "Review"
  | "Session"
  | "ShortlistEntry"
  | "Slot"
  | "SupportDeal"
  | "Table"
  | "Task"
  | "TaskCreate"
  | "TaskPatch"
  | "TimelineAcknowledgmentStatus"
  | "TimelineAcknowledgments"
  | "TimelineEvent"
  | "TimelineReference"
  | "TimelineShiftBlockDetails"
  | "TimelineShiftGuestConsequence"
  | "TimelineShiftMoment"
  | "TimelineShiftPreview"
  | "TimelineShiftReceipt"
  | "TimelineShiftReferenceDetails"
  | "TimelineShiftScope"
  | "Tip"
  | "User"
  | "UserProfile"
  | "Vendor"
  | "VendorAvailabilityPolicy"
  | "VendorAvailabilityPolicyWrite"
  | "VendorBookingPolicy"
  | "VendorDecision"
  | "VendorDetail"
  | "VendorPackage"
  | "VendorPackageInput"
  | "VendorPage"
  | "VendorPaymentRecord"
  | "VendorProgramAck"
  | "VendorProgramBlock"
  | "VendorProgramSnapshot"
  | "VendorProgramSummary"
  | "VendorResource"
  | "VendorResourceCreate"
  | "VendorResourceOptions"
  | "VendorUpsert"
  | "VerificationDecision"
  | "VerificationItem"
  | "VerificationPage"
  | "VerificationRequest"
  | "VerificationStatus"
  | "VerificationSubmit"
  | "Wedding"
  | "WeddingAttention"
  | "WeddingEvent"
  | "WeddingEventKind"
  | "WeddingFormat"
  | "WeddingOrder"
  | "WeddingPlanner"
  | "WeddingPublic"
  | "WeddingSupportCard"
