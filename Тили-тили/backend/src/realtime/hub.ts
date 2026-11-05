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

/** Access belongs to this socket's token, including its own session. */
export interface DeliveryAccess {
  token: string
  withAccess(token: string, write: () => void): Promise<void>
  denied(error: unknown): void
}

interface Subscription {
  userId: string | null
  access?: DeliveryAccess
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
  /** Кто вызвал событие: «печатает» своему же соединению не доставляется. */
  actorId: string
  payload?: unknown
}

export class RealtimeHub {
  /**
   * Комната — соединения чата и то, чей пользователь за каждым из них.
   *
   * Пользователь нужен ради «печатает»: событие о наборе уходит через
   * Redis всем процессам и приходит обратно в свой, и без имени владельца
   * соединения хаб доставлял его и автору — под своим полем ввода человек
   * видел «собеседник печатает» каждый раз, когда печатал сам (D4-08).
   * Сообщения автору доставляются: у него может быть открыта вторая вкладка.
   */
  private readonly rooms = new Map<string, Map<Socket, Subscription>>()
  private readonly deliveries = new Map<string, Promise<void>>()
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
        // Redis callbacks cannot return an awaited promise to the emitter.
        void this.enqueue(JSON.parse(raw) as ChatEvent).catch(() => undefined)
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

  /** `userId` — чьё это соединение; без него автор «печатает» неотличим от собеседника. */
  join(chatId: string, socket: Socket, userId: string | null = null, access?: DeliveryAccess): void {
    const room = this.rooms.get(chatId) ?? new Map<Socket, Subscription>()
    // A new identity even when the same socket leaves and rejoins this room.
    room.set(socket, { userId, ...(access ? { access } : {}) })
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
    await this.enqueue(event)
  }

  private enqueue(event: ChatEvent): Promise<void> {
    // Snapshot recipients on arrival: later joins must not receive queued history.
    const recipients = [...(this.rooms.get(event.chatId)?.entries() ?? [])]
    if (recipients.length === 0) return Promise.resolve()
    const previous = this.deliveries.get(event.chatId) ?? Promise.resolve()
    const pending = previous.catch(() => undefined).then(() => this.deliver(event, recipients))
    this.deliveries.set(event.chatId, pending)
    const clear = () => {
      if (this.deliveries.get(event.chatId) === pending) this.deliveries.delete(event.chatId)
    }
    void pending.then(clear, clear)
    return pending
  }

  private async deliver(event: ChatEvent, recipients: [Socket, Subscription][]): Promise<void> {
    const data = JSON.stringify({ type: event.type, chatId: event.chatId, actorId: event.actorId, ...(event.payload ?? {}) })
    await Promise.all(recipients.map(async ([socket, subscription]) => {
      const current = () => this.rooms.get(event.chatId)?.get(socket) === subscription
      if (!current()) return
      let active = true, written = false
      const write = () => {
        // The guard may invoke this only once, synchronously within its pins.
        // A retained callback cannot write after completion or a rejoin.
        if (!active || written) return
        written = true
        if (!current()) return
        if (event.type === 'typing' && subscription.userId !== null && subscription.userId === event.actorId) return
        try { socket.send(data) } catch { if (current()) this.leave(event.chatId, socket) }
      }
      try {
        if (subscription.access) await subscription.access.withAccess(subscription.access.token, write)
        else write()
      } catch (error) {
        // A stale rejection must not close a replacement subscription.
        if (!current()) return
        this.leave(event.chatId, socket)
        try { subscription.access?.denied(error) } catch { /* Socket already closed. */ }
        return
      } finally {
        active = false
      }
    }))
  }
}
