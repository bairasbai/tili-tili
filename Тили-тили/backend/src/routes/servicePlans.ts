import type { FastifyInstance } from 'fastify'

export async function servicePlanRoutes(app: FastifyInstance): Promise<void> {
  app.get('/users/me/service-plans', { preHandler: app.requireConsent }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store')
    return { plans: app.appConfig.servicePlans }
  })
}
