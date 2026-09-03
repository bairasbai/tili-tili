import type { Redis } from 'ioredis'
import { withRedisTimeout } from '../plugins/redis.js'

/**
 * Кто сейчас смотрит в какой чат.
 *
 * Соединения живут в памяти процесса, а процессов за балансировщиком бывает
 * несколько. Поэтому событие сначала уходит в Redis, и уже оттуда его
 * получают ВСЕ процессы, включая свой. Без этого сообщение доходило бы
 * только тем, кто случайно попал на тот же сервер, — и выглядело бы как
 * «иногда не приходит», что хуже, чем «не приходит никогда».
 */
export interface Socket {
  send(data: string): void
}

declare module 'fastify' {
  interface FastifyInstance {
    realtime: RealtimeHub
  }
}

const CHANNEL = 'tili:chat'

export interface ChatEvent {
  chatId: string
  type: 'message' | 'typing'
  /** Кто вызвал событие: своему же соединению его слать незачем. */
  actorId: string
  payload?: unknown
}

export class RealtimeHub {
  private readonly rooms = new Map<string, Set<Socket>>()
  private publisher: Redis | null = null
  private subscriber: Redis | null = null

  /**
   * Подключает мост между процессами. Без Redis работает один процесс.
   *
   * Подписка не ждётся: с мёртвым Redis `subscribe` висит до первого
   * соединения, а вызывается она при сборке приложения — то есть сервер
   * не поднимется вовсе. Вместо ожидания подписываемся на каждое
   * подключение: `ready` приходит и при первом соединении, и после
   * каждого обрыва, а подписка обрыва не переживает.
   */
  bridge(publisher: Redis, subscriber: Redis): void {
    this.publisher = publisher
    this.subscriber = subscriber
    subscriber.on('message', (channel, raw) => {
      if (channel !== CHANNEL) return
      try {
        this.deliver(JSON.parse(raw) as ChatEvent)
      } catch {
        // Чужое сообщение в канале — не повод падать.
      }
    })
    const resubscribe = () => {
      subscriber.subscribe(CHANNEL).catch(() => undefined)
    }
    subscriber.on('ready', resubscribe)
    if (subscriber.status === 'ready') resubscribe()
  }

  join(chatId: string, socket: Socket): void {
    const room = this.rooms.get(chatId) ?? new Set<Socket>()
    room.add(socket)
    this.rooms.set(chatId, room)
  }

  leave(chatId: string, socket: Socket): void {
    const room = this.rooms.get(chatId)
    if (!room) return
    room.delete(socket)
    if (room.size === 0) this.rooms.delete(chatId)
  }

  /** Сколько соединений слушает чат в ЭТОМ процессе (для тестов и метрик). */
  size(chatId: string): number {
    return this.rooms.get(chatId)?.size ?? 0
  }

  async publish(event: ChatEvent): Promise<void> {
    if (this.publisher) {
      try {
        await withRedisTimeout(this.publisher.publish(CHANNEL, JSON.stringify(event)))
        return
      } catch {
        /* Redis недоступен — доставляем своим соединениям напрямую.
         *
         * Сообщение уже в базе: потерять его нельзя, а вот живой канал
         * между процессами переживёт. Тот, кто сидит на другом сервере,
         * увидит реплику при следующем открытии чата — это хуже, чем
         * сразу, и несравнимо лучше, чем отказ на отправку. */
      }
    }
    // Один процесс — доставляем напрямую, иначе событие потерялось бы.
    this.deliver(event)
  }

  private deliver(event: ChatEvent): void {
    const room = this.rooms.get(event.chatId)
    if (!room) return
    const data = JSON.stringify({ type: event.type, chatId: event.chatId, actorId: event.actorId, ...(event.payload ?? {}) })
    for (const socket of room) {
      try {
        socket.send(data)
      } catch {
        // Оборвавшееся соединение уберёт обработчик close.
      }
    }
  }
}
