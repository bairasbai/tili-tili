import { test } from 'node:test'
import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { parseArguments } from '../arguments.mjs'
import { assertContainers, assertNetwork, assertPublishedPorts, assertVolume } from '../ownership.mjs'
import { assertNonRootS3Signer, assertS3PhaseReady, readS3Credentials, s3ProcessEnvironment } from '../s3-credentials.mjs'
import { applicationAccessKey, assertLaunchTicket, parseS3Users, portfolioPolicy, portfolioPolicyName, provisionS3User, s3Listener } from '../s3-policy.mjs'
import { provisionAndPublishS3 } from '../s3-startup.mjs'

const syntheticS3Files = {
  'root-user': `TL${'A'.repeat(18)}\n`,
  'root-password': `${'a'.repeat(64)}\n`,
  '.tili-local-instance': '00000000-0000-4000-8000-000000000001\n',
}

test('missing, empty, whitespace or malformed MinIO credentials stop before process startup', () => {
  for (const [name, value] of [['root-user', undefined], ['root-password', ''], ['root-password', ' \n'],
    ['root-user', 'invalid'], ['.tili-local-instance', '00000000----------------------------']]) {
    const read = path => {
      const key = basename(path)
      if (key !== name) return syntheticS3Files[key]
      if (value === undefined) throw new Error('simulated read failure')
      return value
    }
    assert.throws(() => readS3Credentials('/synthetic', read), { message: 'LOCAL_S3_CREDENTIAL_FILES_INVALID' })
  }
})

test('MinIO starts with one validated snapshot and receives no alternate credential source', () => {
  const reads = []
  const credentials = readS3Credentials('/synthetic', path => {
    const name = basename(path)
    reads.push(name)
    return syntheticS3Files[name]
  })
  const env = s3ProcessEnvironment(credentials, '43010')
  assert.deepEqual(reads, ['root-user', 'root-password', '.tili-local-instance'])
  assert.equal(env.MINIO_ROOT_USER, credentials.accessKeyId)
  assert.equal(env.MINIO_ROOT_PASSWORD, credentials.secretAccessKey)
  assert.equal(env.MINIO_API_CORS_ALLOW_ORIGIN, 'http://127.0.0.1:43010')
  assert.equal(env.MINIO_BROWSER, 'off')
  assert(!Object.keys(env).some(key => key.endsWith('_FILE')))
  assert.throws(() => s3ProcessEnvironment(credentials, 'https://invalid.example'), /LOCAL_PORT_INVALID/)
})

test('local media setup refuses missing credentials or a signing identity that shares a root credential', () => {
  const root = readS3Credentials('/synthetic', path => syntheticS3Files[basename(path)])
  const app = { MEDIA_S3_ACCESS_KEY: 'synthetic-app-user', MEDIA_S3_SECRET_KEY: 'synthetic-app-password' }
  assert.throws(() => assertNonRootS3Signer(root, {}), /LOCAL_S3_SIGNER_MISSING/)
  assert.throws(() => assertNonRootS3Signer(root, { ...app, MEDIA_S3_ACCESS_KEY: root.accessKeyId }), /LOCAL_S3_ROOT_SIGNER_FORBIDDEN/)
  assert.throws(() => assertNonRootS3Signer(root, { ...app, MEDIA_S3_SECRET_KEY: root.secretAccessKey }), /LOCAL_S3_ROOT_SIGNER_FORBIDDEN/)
  assert.doesNotThrow(() => assertNonRootS3Signer(root, app))
})

test('the API rejects both incomplete setup and an old ready phase without a separate S3 signer', () => {
  assert.throws(() => assertS3PhaseReady({ stage: 'pending', s3Signer: 'non-root' }), /LOCAL_STARTUP_FENCE_PENDING/)
  assert.throws(() => assertS3PhaseReady({ stage: 'ready' }), /LOCAL_S3_SIGNER_NOT_VERIFIED/)
  assert.doesNotThrow(() => assertS3PhaseReady({ stage: 'ready', s3Signer: 'non-root' }))
})

test('the application policy grants only the operations and paths used for portfolio photos', () => {
  assert.deepEqual(portfolioPolicy().Statement, [
    { Effect: 'Allow', Action: ['s3:GetBucketLocation'], Resource: ['arn:aws:s3:::tili-local-media'] },
    { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      Resource: ['arn:aws:s3:::tili-local-media/quarantine/*', 'arn:aws:s3:::tili-local-media/clean/*'] },
  ])
})

test('the internal MinIO listener never uses the published port and publication requires a current ticket', () => {
  const credentials = readS3Credentials('/synthetic', path => syntheticS3Files[basename(path)])
  const env = { LOCAL_S3_STAGE: 'private', LOCAL_S3_PORT: '39001' }
  assert.deepEqual(s3Listener(env), { host: '127.0.0.1', port: 39002 })
  assert.deepEqual(s3Listener({ ...env, LOCAL_S3_STAGE: 'public' }), { host: '0.0.0.0', port: 39001 })
  assert.throws(() => s3Listener({ LOCAL_S3_PORT: '39001' }), /LOCAL_S3_STAGE_INVALID/)
  assert.throws(() => parseArguments(['start', '--s3-port', '3001']), /LOCAL_PORT_COLLISION/)
  const generation = '00000000-0000-4000-8000-000000000002'
  const phase = { generation, instance: credentials.instance }
  const ticket = { format: 1, ...phase, rootAccessKeyId: credentials.accessKeyId, stage: 'private' }
  assert.throws(() => assertLaunchTicket(ticket, credentials, 'public', phase), /LOCAL_S3_LAUNCH_TICKET_INVALID/)
  assert.throws(() => assertLaunchTicket({ ...ticket, stage: 'public' }, credentials, 'public', phase), /LOCAL_S3_LAUNCH_TICKET_INVALID/)
  const published = { ...ticket, stage: 'public', appAccessKeyId: applicationAccessKey(phase.instance) }
  assert.throws(() => assertLaunchTicket({ ...published, rootAccessKeyId: 'old' }, credentials, 'public', phase), /LOCAL_S3_LAUNCH_TICKET_INVALID/)
  assert.throws(() => assertLaunchTicket(published, credentials, 'public', { ...phase, generation: 'old' }), /LOCAL_S3_LAUNCH_TICKET_INVALID/)
  assert.doesNotThrow(() => assertLaunchTicket(published, credentials, 'public', phase))
})

test('credential rotation removes only the owned user and requires an exclusive policy after recreation', async () => {
  const accessKey = applicationAccessKey(syntheticS3Files['.tili-local-instance'].trim())
  const user = { status: 'success', accessKey, userStatus: 'enabled', policyName: portfolioPolicyName }
  const foreign = { ...user, accessKey: 'different-user' }
  assert.deepEqual(parseS3Users(`${JSON.stringify(user, null, 2)}\n${JSON.stringify(foreign, null, 2)}\n`), [user, foreign])
  const operations = []
  const mc = async args => {
    operations.push(args.slice(0, 3).join(' '))
    return args[2] === 'list' ? JSON.stringify(user, null, 2) : ''
  }
  await provisionS3User(mc, accessKey, 'synthetic-password', '/tmp/policy.json')
  assert.deepEqual(operations, ['admin user list', 'admin user remove', 'admin policy create', 'admin user add', 'admin policy attach', 'admin user list'])
  const rejected = []
  await assert.rejects(provisionS3User(async args => { rejected.push(args[2]); return JSON.stringify(foreign) }, accessKey, '', ''), /LOCAL_S3_FOREIGN_IDENTITY/)
  assert.deepEqual(rejected, ['list'])
  await assert.rejects(provisionS3User(async args => args[2] === 'list'
    ? JSON.stringify({ ...user, memberOf: [{ name: 'unrelated-group' }] }) : '', accessKey, '', ''), /LOCAL_S3_POLICY_NOT_EXCLUSIVE/)
})

test('a failed provision or a surviving private container prevents publication', async () => {
  for (const failure of ['provision', 'survivor', null]) {
    const steps = []
    const publish = provisionAndPublishS3(async (args, stage) => {
      steps.push(`${args[0]}:${stage}`)
      if (failure === 'provision') throw new Error('provision failed')
    }, async () => failure === 'survivor')
    if (failure) {
      await assert.rejects(publish, failure === 'provision' ? /provision failed/ : /LOCAL_PRIVATE_S3_NOT_REMOVED/)
      assert(!steps.includes('up:public'))
    } else {
      await publish
      assert.deepEqual(steps, ['run:private', 'stop:private', 'rm:private', 'up:public'])
    }
  }
})

const project = 'tili-local-media-qual-test'
const labels = { 'io.tili.local-media': '1', 'io.tili.project': project, 'com.docker.compose.project': project }
const web = () => ({ id: 'web-id', labels: { ...labels, 'com.docker.compose.service': 'web' }, mounts: [], networkMode: project + '_default' })
const s3 = () => ({ id: 's3-id', labels: { ...labels, 'com.docker.compose.service': 's3' }, networkMode: 'container:web-id', mounts: [
  { Type: 'volume', Name: project + '_objects', Destination: '/data', RW: true },
  { Type: 'volume', Name: project + '_s3_credentials', Destination: '/run/s3-auth', RW: false },
] })
const volume = () => ({ driver: 'local', labels: { ...labels }, options: null })
const network = () => ({ name: project + '_default', driver: 'bridge', scope: 'local', labels: { ...labels }, options: {}, containers: { 'web-id': {} } })

test('an existing stack refuses a changed port or wildcard binding before restart', () => {
  const portBindings = { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '43010' }], '43011/tcp': [{ HostIp: '127.0.0.1', HostPort: '43011' }] }
  const existing = [{ ...web(), portBindings }]
  assert.doesNotThrow(() => assertPublishedPorts(existing, 43010, 43011))
  assert.throws(() => assertPublishedPorts(existing, 43910, 43011), /LOCAL_PUBLISHED_PORT_MISMATCH/)
  portBindings['43011/tcp'][0].HostIp = '0.0.0.0'
  assert.throws(() => assertPublishedPorts(existing, 43010, 43011), /LOCAL_PUBLISHED_PORT_MISMATCH/)
})

test('no arguments select read-only status; explicit local namespace remains exact', () => {
  assert.deepEqual(parseArguments([], 'linux'), { action: 'status', project: 'tili-local-media', context: 'default', webPort: 43010, s3Port: 43011 })
  assert.equal(parseArguments(['restart', '--project', project], 'win32').project, project)
})
for (const option of ['--project', '--context', '--web-port', '--s3-port']) {
  test(`${option} without a value cannot fall back to a persistent default target`, () => {
    assert.throws(() => parseArguments(['restart', option]), /LOCAL_OPTION_VALUE_REQUIRED/)
  })
  test(`${option} followed by another option is still a missing value`, () => {
    assert.throws(() => parseArguments(['restart', option, '--unknown']), /LOCAL_OPTION_VALUE_REQUIRED/)
  })
}
test('duplicate target, unknown option, foreign project and colliding ports are refused', () => {
  assert.throws(() => parseArguments(['restart', '--project', project, '--project', 'tili-local-media']), /LOCAL_ARGUMENTS_INVALID/)
  assert.throws(() => parseArguments(['restart', '--unknown', 'x']), /LOCAL_ARGUMENTS_INVALID/)
  assert.throws(() => parseArguments(['restart', '--project', 'production']), /LOCAL_PROJECT_INVALID/)
  assert.throws(() => parseArguments(['start', '--web-port', '43011']), /LOCAL_ARGUMENTS_INVALID/)
})
test('positive physical graph is accepted without exposing other services secrets', () => {
  assert.doesNotThrow(() => assertContainers([web(), s3()], project))
  assert.doesNotThrow(() => assertVolume(project + '_s3_credentials', volume(), project))
  assert.doesNotThrow(() => assertNetwork(network(), project, [web(), s3()]))
  const actual = network(); actual.options = { 'com.docker.network.enable_ipv4': 'true', 'com.docker.network.enable_ipv6': 'false' }
  assert.doesNotThrow(() => assertNetwork(actual, project, [web(), s3()]))
})
test('S3 cannot mount the master credential volume even under correct container labels', () => {
  const item = s3(); item.mounts[1].Name = project + '_credentials'
  assert.throws(() => assertContainers([web(), item], project), /LOCAL_FOREIGN_MOUNT/)
})
test('bind mounts, extra anonymous volumes and writable auth views are refused', () => {
  const bind = s3(); bind.mounts[0].Type = 'bind'
  assert.throws(() => assertContainers([web(), bind], project), /LOCAL_FOREIGN_MOUNT/)
  const extra = s3(); extra.mounts.push({ Type: 'volume', Name: 'anonymous', Destination: '/unexpected', RW: true })
  assert.throws(() => assertContainers([web(), extra], project), /LOCAL_UNEXPECTED_MOUNT/)
  const writable = s3(); writable.mounts[1].RW = true
  assert.throws(() => assertContainers([web(), writable], project), /LOCAL_FOREIGN_MOUNT/)
})
test('a sidecar cannot join a foreign or host namespace', () => {
  for (const mode of ['host', 'container:foreign-web', project + '_default']) {
    const item = s3(); item.networkMode = mode
    assert.throws(() => assertContainers([web(), item], project), /LOCAL_FOREIGN_NAMESPACE/)
  }
})
test('volume name/labels and local driver options must all identify owned storage', () => {
  assert.throws(() => assertVolume('foreign_credentials', volume(), project), /LOCAL_FOREIGN_VOLUME/)
  const foreign = volume(); foreign.labels['io.tili.project'] = 'foreign'
  assert.throws(() => assertVolume(project + '_pg', foreign, project), /LOCAL_FOREIGN_VOLUME/)
  const host = volume(); host.options = { type: 'none', o: 'bind', device: '/host-data' }
  assert.throws(() => assertVolume(project + '_pg', host, project), /LOCAL_FOREIGN_VOLUME/)
})
test('network cannot have foreign endpoints, driver configuration or ownership', () => {
  const foreign = network(); foreign.containers['unrelated-service'] = {}
  assert.throws(() => assertNetwork(foreign, project, [web()]), /LOCAL_FOREIGN_NETWORK_CONSUMER/)
  const options = network(); options.options = { parent: 'foreign-interface' }
  assert.throws(() => assertNetwork(options, project, [web()]), /LOCAL_FOREIGN_NETWORK/)
  const altered = network(); altered.options = { 'com.docker.network.enable_ipv6': 'true' }
  assert.throws(() => assertNetwork(altered, project, [web()]), /LOCAL_FOREIGN_NETWORK/)
  const wrong = network(); wrong.labels['io.tili.project'] = 'foreign'
  assert.throws(() => assertNetwork(wrong, project, [web()]), /LOCAL_FOREIGN_NETWORK/)
})
