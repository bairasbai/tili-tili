/* СГЕНЕРИРОВАНО. Не править руками — правится контракт, потом `pnpm run gen:schemas`.
 * Схем: 39. */

export const CONTRACT_SCHEMA_ID = "contract"

/** Единый документ схем; подключается через app.addSchema.
  * Ключ `definitions`, а не `components.schemas`: AJV в strict-режиме
  * отвергает неизвестное ключевое слово, а `definitions` он знает. */
export const CONTRACT_SCHEMAS = {
  $id: "contract",
  definitions: {
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
                  "description": "инкрементируется атомарно, переполнение запрещено"
              }
          }
      },
      "Category": {
          "type": "object",
          "description": "Справочник категорий подрядчиков. Список фиксированный — 35 записей, сид-данные лежат в миграции seed_categories и совпадают с CATEGORIES во фронте (Тили-тили/app/src/lib/data.ts). Enum здесь не ставится намеренно: добавление категории не должно требовать выката новой версии контракта. Изменять список может только админ через POST /admin/categories.\n",
          "properties": {
              "id": {
                  "type": "string"
              },
              "title": {
                  "type": "string"
              },
              "icon": {
                  "type": "string"
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
                      "tilly"
                  ]
              },
              "openFrom": {
                  "type": [
                      "string",
                      "null"
                  ],
                  "format": "date-time",
                  "description": "Только у kind=day: 09:00 НАКАНУНЕ свадьбы по Wedding.tz. Чат\nсуществует с момента создания свадьбы и до этого срока виден,\nно закрыт (423) — иначе в списке чатов до дня X была бы пустота\nвместо строки «откроется 13 июня». Дату перенесли — срок едет\nвместе с ней.\n"
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
              "price": {
                  "$ref": "contract#/definitions/Money"
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
              "plusOne": {
                  "type": "boolean"
              },
              "group": {
                  "type": [
                      "string",
                      "null"
                  ]
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
                  "type": "string",
                  "format": "date"
              },
              "city": {
                  "type": "string"
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
          "properties": {
              "question": {
                  "type": "string"
              },
              "sent": {
                  "type": "boolean"
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
                  "description": "null — сообщение от самого приложения: ответ Тиль или системная запись."
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
                  ]
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
      "Review": {
          "type": "object",
          "properties": {
              "id": {
                  "type": "string"
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
      "Slot": {
          "type": "object",
          "description": "Место в команде свадьбы. Слот либо пуст, либо несёт сделку — собственного\nстатуса у него нет. tileState — производная подпись для мозаики команды,\nтолько для чтения: клиент не должен вычислять её сам, чтобы экраны не\nразошлись между собой.\n",
          "properties": {
              "id": {
                  "type": "string"
              },
              "categoryId": {
                  "type": "string"
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
                  "type": "string"
              },
              "done": {
                  "type": "boolean"
              },
              "custom": {
                  "type": "boolean"
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
              "outdoor": {
                  "type": "boolean",
                  "description": "блок под открытым небом — к нему привязывается план Б"
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
                  "type": "string"
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
                  ]
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
                          "items": {
                              "type": "object",
                              "properties": {
                                  "id": {
                                      "type": "string"
                                  },
                                  "name": {
                                      "type": "string"
                                  },
                                  "price": {
                                      "$ref": "contract#/definitions/Money"
                                  },
                                  "includes": {
                                      "type": "array",
                                      "items": {
                                          "type": "string"
                                      }
                                  }
                              }
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
                  "$ref": "contract#/definitions/CityRef"
              },
              "about": {
                  "type": "string"
              },
              "priceFrom": {
                  "$ref": "contract#/definitions/Money"
              },
              "packages": {
                  "type": "array",
                  "items": {
                      "type": "object",
                      "properties": {
                          "name": {
                              "type": "string"
                          },
                          "price": {
                              "$ref": "contract#/definitions/Money"
                          },
                          "includes": {
                              "type": "array",
                              "items": {
                                  "type": "string"
                              }
                          }
                      }
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
              "members": {
                  "type": "array",
                  "items": {
                      "$ref": "contract#/definitions/Member"
                  }
              }
          }
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
  | "AlbumPhoto"
  | "AuthTokens"
  | "Budget"
  | "BudgetItem"
  | "BusRoute"
  | "Category"
  | "Chat"
  | "City"
  | "CityRef"
  | "Complaint"
  | "Deal"
  | "DealState"
  | "Document"
  | "Error"
  | "Fund"
  | "Gift"
  | "Guest"
  | "HotelBlock"
  | "InviteLink"
  | "Lead"
  | "Member"
  | "MenuPoll"
  | "Message"
  | "Money"
  | "Notification"
  | "Review"
  | "Session"
  | "Slot"
  | "Table"
  | "Task"
  | "TimelineEvent"
  | "User"
  | "UserProfile"
  | "Vendor"
  | "VendorDetail"
  | "VendorPage"
  | "VendorUpsert"
  | "Wedding"
  | "WeddingPublic"
