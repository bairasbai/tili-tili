import { spawn } from 'node:child_process'
import { apiState, reportFailure, requireLocal } from './common.mjs'
try {
  const { phase, api } = apiState()
  requireLocal(phase.stage === 'pending', 'LOCAL_MIGRATION_PHASE_INVALID')
  const child = spawn(process.execPath, ['/app/node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up', '-m', '/app/migrations'],
    { cwd: '/app', env: { ...process.env, DATABASE_URL: api.env.DATABASE_URL }, stdio: 'inherit' })
  child.on('error', () => { console.error('LOCAL_MIGRATION_START_FAILED'); process.exitCode = 1 })
  child.on('exit', code => { process.exitCode = code ?? 1 })
} catch (error) { reportFailure(error) }
