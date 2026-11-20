import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { components } from '../contract/api.generated.js'
import { CONTRACT_OPERATIONS } from '../contract/paths.generated.js'
import { AppError } from '../errors.js'
import type { Queryable } from '../plugins/db.js'
import { servicePlanAccess } from './orders.js'

type ServicePlanCode = components['schemas']['ServicePlanCode']

const weddingPlanOperations = new Set(CONTRACT_OPERATIONS
  .filter(operation => operation.servicePlanAccess === 'wedding')
  .map(operation => operation.method + ' ' + operation.url))

export function requiresWeddingPlan(method: string, registeredPath: string): boolean {
  return weddingPlanOperations.has(method + ' ' + registeredPath)
}

const planMessage: Record<ServicePlanCode, string> = {
  wedding: 'Для этого действия нужен тариф на свадьбу. Один из партнёров может оплатить его в настройках.',
  vendor_month: 'Для этого действия нужен действующий тариф подрядчика. Оплата и продление доступны в настройках.',
}

export async function assertServicePlanAccess(db: Queryable, code: ServicePlanCode, targetId: string): Promise<void> {
  if (!await servicePlanAccess(db, { code, targetId })) {
    throw new AppError(403, 'service_plan_required', planMessage[code])
  }
}

export function weddingPlanAccessHook(app: FastifyInstance) {
  return async (request: FastifyRequest): Promise<void> => {
    const member = request.member
    if (!member || !requiresWeddingPlan(request.method, request.routeOptions.url ?? '')) return
    await assertServicePlanAccess(app.db!, 'wedding', member.weddingId)
  }
}
