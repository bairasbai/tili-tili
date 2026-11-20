import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/sh.exe' : 'sh'
const shellPath = (path: string) => process.platform === 'win32'
  ? path.replace(/\\/g, '/').replace(/^([a-z]):/i, (_, drive: string) => '/' + drive.toLowerCase())
  : path
const finalName = 'tili-20261113T040000Z.dump'
const oldName = 'tili-20260101T040000Z.dump'

function withBackup(run: (folder: string, backup: (mode?: string) => ReturnType<typeof spawnSync<string>>) => void) {
  const folder = mkdtempSync(join(tmpdir(), 'wp16-atomic-backup-'))
  try {
    const fake = (name: string, body: string) =>
      writeFileSync(join(folder, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 })
    fake('date', 'echo 20261113T040000Z')
    fake('pg_dump', [
      'for arg do case "$arg" in --file=*) file="${arg#--file=}" ;; esac; done',
      'if [ "$BACKUP_TEST_MODE" = interrupted ]; then printf partial > "$file"; exit 4; fi',
      'if [ "$BACKUP_TEST_MODE" = truncated ]; then printf toc-only > "$file"; exit 0; fi',
      'printf archive > "$file"',
    ].join('\n'))
    fake('pg_restore', [
      'if [ "$BACKUP_TEST_MODE" = observe ] && [ -e "$BACKUP_DIR/' + finalName + '" ]; then exit 7; fi',
      '[ "$BACKUP_TEST_MODE" != rejected ] || exit 6',
      'if [ "$1" = --list ]; then [ -s "$2" ]; exit; fi',
      '[ "$1" = --exit-on-error ] && [ "$2" = --file=- ] || exit 5',
      '[ "$(cat "$3")" = archive ] || exit 8',
    ].join('\n'))
    writeFileSync(join(folder, oldName), 'old')
    utimesSync(join(folder, oldName), new Date(0), new Date(0))
    run(folder, (mode = '') => spawnSync(shell, ['-c',
      'PATH="$BACKUP_TEST_STUBS:$PATH"; export PATH; exec sh scripts/backup.sh'], {
      env: { ...process.env, BACKUP_TEST_STUBS: shellPath(folder), BACKUP_DIR: shellPath(folder), BACKUP_TEST_MODE: mode,
        KEEP_DAYS: '30', DATABASE_URL: 'postgres://test@127.0.0.1:1/backup_test' },
      encoding: 'utf8',
    }))
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

describe('WP16 backup publication', () => {
  it.each([['interrupted', 4], ['rejected', 6], ['truncated', 8]])('keeps the last backup when the new dump is %s', (mode, status) => {
    withBackup((folder, backup) => {
      expect(backup(mode).status).toBe(status)
      expect(existsSync(join(folder, finalName))).toBe(false)
      expect(readFileSync(join(folder, oldName), 'utf8')).toBe('old')
      expect(readdirSync(folder).filter(name => name.startsWith('.tili-'))).toEqual([])
    })
  })

  it('does not replace an existing backup with the same timestamp', () => {
    withBackup((folder, backup) => {
      writeFileSync(join(folder, finalName), 'known good')
      expect(backup().status).not.toBe(0)
      expect(readFileSync(join(folder, finalName), 'utf8')).toBe('known good')
      expect(readFileSync(join(folder, oldName), 'utf8')).toBe('old')
      expect(readdirSync(folder).filter(name => name.startsWith('.tili-'))).toEqual([])
    })
  })

  it('publishes after validation and then rotates old backups', () => {
    withBackup((folder, backup) => {
      const result = backup('observe')
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(folder, finalName), 'utf8')).toBe('archive')
      expect(result.stdout).toContain('копия готова')
      expect(existsSync(join(folder, oldName))).toBe(false)
      expect(readdirSync(folder).filter(name => name.startsWith('.tili-'))).toEqual([])
    })
  })
})
