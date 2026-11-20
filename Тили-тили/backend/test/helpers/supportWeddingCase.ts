import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

export async function openSupportWeddingCase(app: FastifyInstance, ownerToken: string, weddingId?: string) {
  const reply = await app.inject({ method: 'POST', url: '/support/cases',
    headers: { authorization: 'Bearer ' + ownerToken, 'idempotency-key': randomUUID() },
    payload: { subject: 'Synthetic wedding support', message: 'Synthetic assigned case fixture', ...(weddingId ? { weddingId } : {}) } })
  assert.equal(reply.statusCode, 201, reply.body)
  return reply.json<{ id: string }>().id
}

export function supportWeddingCommand(app: FastifyInstance, caseId: string, staffToken: string, action: 'claim' | 'release' | 'resolve') {
  return app.inject({ method: 'POST', url: `/admin/support/cases/${caseId}`,
    headers: { authorization: 'Bearer ' + staffToken, 'idempotency-key': randomUUID() },
    payload: action === 'resolve' ? { action, message: 'Synthetic resolution' } : { action } })
}

export async function assignSupportWeddingCase(app: FastifyInstance, ownerToken: string, staffToken: string, weddingId?: string) {
  const id = await openSupportWeddingCase(app, ownerToken, weddingId)
  const assigned = await supportWeddingCommand(app, id, staffToken, 'claim')
  assert.equal(assigned.statusCode, 200, assigned.body)
  return id
}
