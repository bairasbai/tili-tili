import type { FastifyInstance } from 'fastify'
import type { PlanBScenario } from '../../src/planb/scenarios.js'

export async function planBPreviewToken(app: FastifyInstance, weddingId: string, headers: { authorization: string }, scenario: PlanBScenario = 'rain') {
  const preview = await app.inject({ method: 'POST', url: `/weddings/${weddingId}/planb/preview`, headers, payload: { scenario } })
  if (preview.statusCode !== 200) throw new Error(`Plan B preview returned ${preview.statusCode}: ${preview.body}`)
  return preview.json<{ previewToken: string }>().previewToken
}
