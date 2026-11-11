import { requireLocal } from './common.mjs'

export const volumeRoles = ['credentials', 'api_credentials', 'pg_credentials', 's3_credentials', 'pg', 'objects', 'redis', 'clamdb']
const mounts = {
  web: {},
  api: { '/run/tili-local': ['api_credentials', false] },
  db: { '/var/lib/postgresql/data': ['pg', true], '/run/tili-pg-auth': ['pg_credentials', false], '/docker-entrypoint-initdb.d': ['pg_credentials', false] },
  redis: { '/data': ['redis', true] },
  s3: { '/data': ['objects', true], '/run/s3-auth': ['s3_credentials', false] },
  clam: { '/var/lib/clamav': ['clamdb', true] },
  init: { '/run/tili-local': ['credentials', true], '/local-api-auth': ['api_credentials', true], '/local-pg-auth': ['pg_credentials', true],
    '/local-s3-auth': ['s3_credentials', true], '/local-pg': ['pg', true], '/local-objects': ['objects', true] },
  migrate: { '/run/tili-local': ['api_credentials', false] },
  provision: { '/run/tili-local': ['credentials', false], '/local-s3-auth': ['s3_credentials', true], '/local-objects': ['objects', false] },
  setup: { '/run/tili-local': ['credentials', true], '/local-api-auth': ['api_credentials', true], '/local-pg-auth': ['pg_credentials', false],
    '/local-s3-auth': ['s3_credentials', false], '/local-pg': ['pg', false], '/local-objects': ['objects', false] },
}
const labelsMatch = (labels, project) => labels?.['io.tili.local-media'] === '1' && labels['io.tili.project'] === project
export function assertContainers(items, project) {
  const web = items.filter(item => item.labels?.['com.docker.compose.service'] === 'web')
  requireLocal(web.length <= 1, 'LOCAL_DUPLICATE_ANCHOR')
  for (const item of items) {
    const role = item.labels?.['com.docker.compose.service'], expected = mounts[role]
    requireLocal(labelsMatch(item.labels, project) && item.labels['com.docker.compose.project'] === project && expected, 'LOCAL_FOREIGN_CONTAINER')
    requireLocal(item.mounts.length === Object.keys(expected).length, 'LOCAL_UNEXPECTED_MOUNT')
    for (const mount of item.mounts) {
      const spec = expected[mount.Destination]
      requireLocal(spec && mount.Type === 'volume' && mount.Name === project + '_' + spec[0] && mount.RW === spec[1], 'LOCAL_FOREIGN_MOUNT')
    }
    requireLocal(role === 'web' ? item.networkMode === project + '_default'
      : role === 'init' ? item.networkMode === 'none'
        : web.length === 1 && item.networkMode === 'container:' + web[0].id, 'LOCAL_FOREIGN_NAMESPACE')
  }
}
export function assertVolume(name, value, project) {
  requireLocal(volumeRoles.some(role => name === project + '_' + role) && value.driver === 'local'
    && labelsMatch(value.labels, project) && value.labels['com.docker.compose.project'] === project
    && (!value.options || Object.keys(value.options).length === 0), 'LOCAL_FOREIGN_VOLUME')
}
export function assertNetwork(value, project, items) {
  const defaults = { 'com.docker.network.enable_ipv4': 'true', 'com.docker.network.enable_ipv6': 'false' }
  requireLocal(value.name === project + '_default' && value.driver === 'bridge' && value.scope === 'local'
    && labelsMatch(value.labels, project) && value.labels['com.docker.compose.project'] === project
    && Object.entries(value.options ?? {}).every(([key, option]) => defaults[key] === option), 'LOCAL_FOREIGN_NETWORK')
  const webIds = new Set(items.filter(item => item.labels['com.docker.compose.service'] === 'web').map(item => item.id))
  requireLocal(Object.keys(value.containers ?? {}).every(id => webIds.has(id)), 'LOCAL_FOREIGN_NETWORK_CONSUMER')
}

export function assertPublishedPorts(items, webPort, s3Port) {
  const web = items.find(item => item.labels['com.docker.compose.service'] === 'web')
  if (!web) return
  const bindings = web.portBindings
  const matches = (port, published) => Array.isArray(bindings?.[`${port}/tcp`]) && bindings[`${port}/tcp`].length === 1
    && bindings[`${port}/tcp`][0].HostIp === '127.0.0.1' && bindings[`${port}/tcp`][0].HostPort === String(published)
  requireLocal(Object.keys(bindings ?? {}).length === 2 && matches(80, webPort) && matches(s3Port, s3Port), 'LOCAL_PUBLISHED_PORT_MISMATCH')
}
