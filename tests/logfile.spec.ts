import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { attachFileLog, PLUGIN_LOG_FILE_NAME } from '../src/logfile.ts'

const tempDirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-logfile-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Parse every JSON line of a log file. */
function readRecords(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('plugin-owned file log', () => {
  let ctx: Context

  beforeEach(() => {
    ctx = new Context()
  })

  it('writes one JSON line per harness info message', () => {
    const home = tempHome()
    const file = join(home, PLUGIN_LOG_FILE_NAME)
    attachFileLog(ctx, { file, maxBytes: 0 })

    ctx.logger('harness').info('hello %s', 'world')

    const records = readRecords(file)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      level: 'info',
      name: 'harness',
      message: 'hello %s',
      args: ['world'],
    })
    expect(typeof records[0]?.ts).toBe('string')
    expect(records[0]?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('drops messages from loggers other than the harness names', () => {
    const home = tempHome()
    const file = join(home, PLUGIN_LOG_FILE_NAME)
    attachFileLog(ctx, { file, maxBytes: 0 })

    ctx.logger('other').warn('x')

    ctx.logger('harness').info('kept')

    const records = readRecords(file)
    expect(records).toHaveLength(1)
    expect(records[0]?.message).toBe('kept')
  })

  it('captures all severities without any facade-level manipulation', () => {
    const home = tempHome()
    const file = join(home, PLUGIN_LOG_FILE_NAME)
    attachFileLog(ctx, { file, maxBytes: 0 })

    ctx.logger('harness').error('err')
    ctx.logger('harness').warn('warn-msg')
    ctx.logger('harness').info('info-msg')
    ctx.logger('harness').debug('debug-msg')

    const records = readRecords(file)
    expect(records.map(record => record.level).sort()).toEqual(['debug', 'error', 'info', 'warn'])
    expect(records.map(record => record.message).sort()).toEqual(['debug-msg', 'err', 'info-msg', 'warn-msg'])
  })

  it('also captures the plugin logger name', () => {
    const home = tempHome()
    const file = join(home, PLUGIN_LOG_FILE_NAME)
    attachFileLog(ctx, { file, maxBytes: 0 })

    ctx.logger('continual-harness').warn('plugin-level warn')

    const records = readRecords(file)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ name: 'continual-harness', message: 'plugin-level warn' })
  })

  it('renders Error args as name/message/stack', () => {
    const home = tempHome()
    const file = join(home, PLUGIN_LOG_FILE_NAME)
    attachFileLog(ctx, { file, maxBytes: 0 })

    ctx.logger('harness').warn('boom', new Error('bang'))

    const records = readRecords(file)
    expect(records).toHaveLength(1)
    expect(records[0]?.message).toBe('boom')
    const args = records[0]?.args as unknown[]
    expect(args).toHaveLength(1)
    expect(args[0]).toMatchObject({ name: 'Error', message: 'bang' })
    expect(typeof (args[0] as { stack?: unknown }).stack).toBe('string')
  })

  it('rotates to <file>.1 once the size cap is exceeded', () => {
    const home = tempHome()
    const file = join(home, PLUGIN_LOG_FILE_NAME)
    // Each line is well over 50 bytes, so every write after the first
    // exceeds the cap and rotates deterministically.
    attachFileLog(ctx, { file, maxBytes: 50 })

    for (let i = 1; i <= 5; i++) ctx.logger('harness').info(`line-${i}`)

    expect(existsSync(`${file}.1`)).toBe(true)
    const rotated = readFileSync(`${file}.1`, 'utf8')
    const current = readFileSync(file, 'utf8')
    // The archive holds the previous generation's line; the live file keeps
    // only the newest line.
    expect(rotated).toContain('line-4')
    expect(rotated).not.toContain('line-5')
    expect(current).toContain('line-5')
    expect(current).not.toContain('line-1')
  })

  it('swallows write failures instead of throwing', () => {
    const home = tempHome()
    // The path is occupied by a directory, so appendFileSync throws EISDIR.
    const blocked = join(home, 'blocked')
    mkdirSync(blocked)
    attachFileLog(ctx, { file: blocked, maxBytes: 0 })

    expect(() => {
      ctx.logger('harness').info('cannot write')
    }).not.toThrow()
  })

  it('creates fresh files with mode 0o600', () => {
    const home = tempHome()
    const file = join(home, PLUGIN_LOG_FILE_NAME)
    attachFileLog(ctx, { file, maxBytes: 0 })

    ctx.logger('harness').info('mode check')

    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})
