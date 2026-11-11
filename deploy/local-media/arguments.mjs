import { port, projectName, requireLocal } from './common.mjs'

export function parseArguments(input, platform = process.platform) {
  const args = [...input], action = args.shift() ?? 'status'
  requireLocal(['start', 'restart', 'stop', 'status', 'logs'].includes(action), 'LOCAL_ACTION_INVALID')
  const option = name => {
    const n = args.indexOf(name)
    if (n < 0) return undefined
    const value = args[n + 1]
    requireLocal(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), 'LOCAL_OPTION_VALUE_REQUIRED')
    args.splice(n, 2); return value
  }
  const project = projectName(option('--project') ?? 'tili-local-media')
  const context = option('--context') ?? (platform === 'win32' ? 'desktop-linux' : 'default')
  requireLocal(/^[a-zA-Z0-9_.-]{1,100}$/.test(context), 'LOCAL_CONTEXT_INVALID')
  const webPort = port(option('--web-port') ?? '43010'), s3Port = port(option('--s3-port') ?? '43011')
  requireLocal(args.length === 0 && webPort !== s3Port, 'LOCAL_ARGUMENTS_INVALID')
  requireLocal(![3001, 3310, 15432, 56379].includes(s3Port), 'LOCAL_PORT_COLLISION')
  return { action, project, context, webPort, s3Port }
}
