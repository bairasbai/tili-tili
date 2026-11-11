import { apiState, reportFailure } from './common.mjs'
import { assertS3PhaseReady } from './s3-credentials.mjs'

try {
  const { phase, api } = apiState()
  assertS3PhaseReady(phase)
  Object.assign(process.env, api.env)
  await import('/app/dist/index.js')
} catch (error) { reportFailure(error) }
