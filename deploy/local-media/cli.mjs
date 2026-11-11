import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { json, requireLocal, reportFailure } from './common.mjs'
import { parseArguments } from './arguments.mjs'
import { assertContainers, assertVolume, assertNetwork, assertPublishedPorts } from './ownership.mjs'
import { provisionAndPublishS3 } from './s3-startup.mjs'

const directory = fileURLToPath(new URL('.', import.meta.url))
let parsed
try { parsed = parseArguments(process.argv.slice(2)) } catch (error) { reportFailure(error); process.exit(1) }
const { action, project, context, webPort, s3Port } = parsed
const images = json(new URL('images.json', import.meta.url))
const env = { ...process.env, COMPOSE_PROJECT_NAME: project, LOCAL_WEB_PORT: String(webPort), LOCAL_S3_PORT: String(s3Port),
  LOCAL_S3_STAGE: 'private', LOCAL_MC_IMAGE: images.minioClient,
  LOCAL_NODE_IMAGE: images.node, LOCAL_NGINX_IMAGE: images.nginx, LOCAL_POSTGRES_IMAGE: images.postgres,
  LOCAL_REDIS_IMAGE: images.redis, LOCAL_S3_IMAGE: images.s3, LOCAL_CLAM_IMAGE: images.clam }
for (const key of ['COMPOSE_FILE', 'COMPOSE_PROFILES', 'COMPOSE_ENV_FILES']) delete env[key]
const composeArgs = ['compose', '--env-file', directory + 'empty.env', '-p', project, '-f', fileURLToPath(new URL('../docker-compose.local.yml', import.meta.url))]
async function docker(argv, capture = false, allowFailure = false, childEnv = env) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['--context', context, ...argv], { cwd: directory, env: childEnv, shell: false,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'] })
    let out = '', err = '', size = 0
    if (capture) for (const [stream, field] of [[child.stdout, 'out'], [child.stderr, 'err']]) stream.on('data', value => {
      size += value.length
      if (size > 8 * 1024 * 1024) { child.kill(); return }
      if (field === 'out') out += value; else err += value
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0 || allowFailure) resolve({ code, out, err })
      else { if (capture && err) console.error(err.trim()); reject(new Error('LOCAL_DOCKER_COMMAND_FAILED')) }
    })
  })
}
const compose = (argv, stage = 'private') => docker([...composeArgs, ...argv], false, false, { ...env, LOCAL_S3_STAGE: stage })
async function containers() {
  const ids = (await docker(['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project], true)).out.trim().split(/\s+/).filter(Boolean)
  if (!ids.length) return []
  const template = '{"id":{{json .Id}},"name":{{json .Name}},"state":{{json .State}},"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}},"networkMode":{{json .HostConfig.NetworkMode}},"portBindings":{{json .HostConfig.PortBindings}}}'
  return (await docker(['inspect', '--format', template, ...ids], true)).out.trim().split('\n').map(line => JSON.parse(line))
}
async function validateOwnership() {
  const items = await containers()
  assertContainers(items, project)
  const names = (await docker(['volume', 'ls', '--format', '{{.Name}}'], true)).out.trim().split('\n').filter(name => name.startsWith(project + '_'))
  for (const name of names) {
    const value = JSON.parse((await docker(['volume', 'inspect', name, '--format', '{"driver":{{json .Driver}},"labels":{{json .Labels}},"options":{{json .Options}}}'], true)).out)
    assertVolume(name, value, project)
  }
  const networkNames = (await docker(['network', 'ls', '--format', '{{.Name}}'], true)).out.trim().split('\n').filter(name => name.startsWith(project + '_'))
  for (const name of networkNames) {
    const value = JSON.parse((await docker(['network', 'inspect', name, '--format', '{"name":{{json .Name}},"driver":{{json .Driver}},"scope":{{json .Scope}},"labels":{{json .Labels}},"options":{{json .Options}},"containers":{{json .Containers}}}'], true)).out)
    assertNetwork(value, project, items)
  }
  return items
}
let lock
async function main() {
  requireLocal(['start', 'restart', 'stop', 'status', 'logs'].includes(action), 'LOCAL_ACTION_INVALID')
  const endpoint = (await docker(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}'], true)).out.trim()
  requireLocal(endpoint === 'npipe:////./pipe/dockerDesktopLinuxEngine'
    || (endpoint.startsWith('unix:///') && !endpoint.includes('?') && !endpoint.includes('#')), 'LOCAL_REMOTE_DOCKER_FORBIDDEN')
  const architecture = (await docker(['info', '--format', '{{.OSType}}/{{.Architecture}}'], true)).out.trim()
  requireLocal(['linux/x86_64', 'linux/amd64'].includes(architecture), 'LOCAL_DOCKER_PLATFORM_UNSUPPORTED')
  if (action === 'status') {
    const items = await validateOwnership()
    console.log(JSON.stringify(items.map(item => ({ service: item.labels['com.docker.compose.service'], status: item.state.Status,
      health: item.state.Health?.Status ?? null })), null, 2)); return
  }
  if (action === 'logs') { await validateOwnership(); await compose(['logs', '--tail', '50', 'api']); return }
  if ((await docker(['image', 'inspect', images.node, '--format', '{{.Id}}'], true, true)).code !== 0) await docker(['pull', images.node])
  const operation = randomUUID(), lockName = project + '-operation-lock'
  const created = await docker(['create', '--name', lockName, '--network', 'none', '--label', 'io.tili.local-media=1',
    '--label', 'io.tili.project=' + project, '--label', 'io.tili.operation=' + operation, '--label', 'io.tili.host-pid=' + process.pid,
    images.node, 'node', '-e', 'process.exit(0)'], true, true)
  requireLocal(created.code === 0, 'LOCAL_OPERATION_LOCKED')
  lock = { id: created.out.trim(), operation }
  let completed = false
  try {
    const items = await validateOwnership()
    completed = true // No service has changed during preflight.
    if (action !== 'stop') assertPublishedPorts(items, webPort, s3Port)
    const services = ['web', 'api', 'db', 'redis', 's3', 'clam']
    const ready = services.every(service => items.some(item => item.labels['com.docker.compose.service'] === service
      && item.state.Status === 'running' && (!item.state.Health || item.state.Health.Status === 'healthy')))
    if (action === 'start' && items.length) {
      const currentApi = items.find(item => item.labels['com.docker.compose.service'] === 'api')
      requireLocal(ready && currentApi?.labels['io.tili.local-s3-policy'] === '1', 'LOCAL_PARTIAL_STACK_USE_RESTART')
      console.log('Локальное приложение уже работает: http://127.0.0.1:' + webPort)
      return
    }
    // Removing the entire old graph retires every old API/S3 process and child.
    // Keep all named volumes. A successful down is not a credential reset.
    completed = false
    await compose(['down', '--remove-orphans', '--timeout', '30'])
    requireLocal((await containers()).length === 0, 'LOCAL_OLD_CONTAINERS_ALIVE')
    if (action === 'stop') { completed = true; console.log('Локальный состав остановлен, данные сохранены.'); return }
    await compose(['--profile', 'tools', 'build', 'api', 'web', 's3', 'provision'])
    await compose(['run', '--rm', '--no-deps', 'init'])
    await compose(['up', '-d', '--wait', '--wait-timeout', '900', 'web', 'db', 'redis', 's3', 'clam'])
    await compose(['run', '--rm', '--no-deps', 'migrate'])
    await provisionAndPublishS3(compose, async () => (await containers()).some(item => item.labels['com.docker.compose.service'] === 's3'))
    await compose(['run', '--rm', '--no-deps', 'setup'], 'public')
    await compose(['up', '-d', '--wait', '--wait-timeout', '120', 'api'], 'public')
    completed = true
    console.log('LOCAL_MEDIA_READY http://127.0.0.1:' + webPort)
  } finally {
    if (lock && completed) {
      const labels = JSON.parse((await docker(['inspect', '--format', '{{json .Config.Labels}}', lock.id], true)).out)
      requireLocal(labels['io.tili.operation'] === lock.operation && labels['io.tili.project'] === project, 'LOCAL_LOCK_OWNERSHIP_CHANGED')
      await docker(['rm', lock.id], true); lock = null
    }
    else if (lock) console.error('LOCAL_OPERATION_INCOMPLETE_LOCK_RETAINED', lockName)
  }
}
main().catch(reportFailure)
