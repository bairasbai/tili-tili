import { ApiError, newIdempotencyKey, type ProgramEventPrecondition } from './api/client'

/** Private immutable command identity; local scope never grants server rights. */
export type LegacyCommandAttempt<T extends object> = Readonly<{
  scope: string
  key: string
  body: Readonly<T>
  origin: object
  programEventContext?: Readonly<ProgramEventPrecondition>
}>

export function legacyCommandAttempt<T extends object>(scope: string, body: T,
  programEventContext: ProgramEventPrecondition | undefined, origin: object): LegacyCommandAttempt<T> {
  return Object.freeze({ scope, origin, key: newIdempotencyKey(), body: Object.freeze(body),
    programEventContext: programEventContext ? Object.freeze({ ...programEventContext }) : undefined })
}

/** A missing response or an in-progress command cannot authorize a new key. */
export function uncertainLegacyCommand(error: unknown): boolean {
  return !(error instanceof ApiError) || error.kind !== 'http' || error.status >= 500 || error.code === 'idempotency_in_progress'
}
