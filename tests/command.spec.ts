import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  createRefineCommandAdapter,
  parseRefineCommand,
  registerRefineCommand,
} from '../src/command.ts'
import type { CommandsCapability } from '../src/command.ts'
import type { RefineCoordinator, RefineExecutionResult } from '../src/coordinator.ts'

function agent(id = 'command-agent'): Agent {
  const session = Session.create(SessionId(id))
  return {
    id: session.id,
    options: { provider: 'test-provider', model: 'test-model' },
    session,
    inbox: undefined as never,
    get status() { return 'running' as const },
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
}

function committedWithRejected(): RefineExecutionResult {
  return {
    commitStatus: 'committed-with-rejected-edits',
    approval: 'approved',
    appliedCount: 2,
    rejectedCount: 1,
    refinement: {
      id: 'r-cmd',
      summary: 'saved two lessons; one update rejected',
      appliedEdits: [
        { action: 'create', kind: 'memory', id: 'ok1', applied: true, blastRadius: 'general' },
        { action: 'create', kind: 'memory', id: 'ok2', applied: true, blastRadius: 'general' },
        { action: 'update', kind: 'memory', id: 'bad', applied: false, blastRadius: 'general', error: 'entry not found' },
      ],
      committedAt: new Date().toISOString(),
      scope: 'local',
    },
  }
}

function notCommitted(): RefineExecutionResult {
  return { commitStatus: 'not-committed', approval: 'not-required', appliedCount: 0, rejectedCount: 0 }
}

function fakeCoordinator(result: RefineExecutionResult): RefineCoordinator {
  return { execute: vi.fn(async () => result) }
}

describe('parseRefineCommand', () => {
  it.each([
    ['/refine', { mode: 'plan', scope: 'global', instructions: undefined }],
    ['/refine --global focus errors', { mode: 'plan', scope: 'global', instructions: 'focus errors' }],
    ['/refine --local focus errors', { mode: 'plan', scope: 'local', instructions: 'focus errors' }],
    ['refine --local focus errors', { mode: 'plan', scope: 'local', instructions: 'focus errors' }],
  ])('parses %s', (raw, expected) => expect(parseRefineCommand(raw, true)).toEqual(expected))

  it('parses a bare remainder as a plan with the default scope', () => {
    expect(parseRefineCommand('focus errors', false)).toEqual({ mode: 'plan', scope: 'local', instructions: 'focus errors' })
    expect(parseRefineCommand('', true)).toEqual({ mode: 'plan', scope: 'global', instructions: undefined })
  })

  it('parses rollback with the scope flag in either position', () => {
    expect(parseRefineCommand('/refine rollback r-1 --local', true)).toEqual({ mode: 'rollback', scope: 'local', rollbackId: 'r-1' })
    expect(parseRefineCommand('/refine rollback --global r-2', true)).toEqual({ mode: 'rollback', scope: 'global', rollbackId: 'r-2' })
  })

  it.each([
    '/refine --global --local focus',
    '/refine rollback id',
    '/refine rollback --local',
    '/refine rollback id --local focus',
    '/refine --unknown x',
    '/refine rollback --local id --global',
    '/refine rollback id --unknown',
  ])('rejects invalid syntax: %s', raw => expect(parseRefineCommand(raw, true)).toMatchObject({ error: expect.any(String) }))
})

describe('createRefineCommandAdapter', () => {
  it('maps domain three-state status into command text two-state status', async () => {
    const handler = createRefineCommandAdapter(fakeCoordinator(committedWithRejected()), { defaultGlobal: false })
    const result = await handler({ rawInput: '/refine --local focus', agent: agent() })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('status: committed')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('scope: local')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('applied: 2')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('rejected: 1')
  })

  it('keeps the refinement id and summary for a committed result', async () => {
    const handler = createRefineCommandAdapter(fakeCoordinator(committedWithRejected()), { defaultGlobal: false })
    const result = await handler({ rawInput: '/refine --local focus', agent: agent() })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('refinement: r-cmd')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('summary: saved two lessons; one update rejected')
  })

  it('maps only not-committed to status not-committed with refinement none', async () => {
    const coordinator = fakeCoordinator(notCommitted())
    const handler = createRefineCommandAdapter(coordinator, { defaultGlobal: true })
    const result = await handler({ rawInput: '/refine', agent: agent() })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('status: not-committed')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('refinement: none')
  })

  it('appends a completed diagnostics line when the coordinator result has a report', async () => {
    const handler = createRefineCommandAdapter(fakeCoordinator({
      ...committedWithRejected(),
      diagnostics: { status: 'completed', structural: [], security: [], errors: [] },
    }), { defaultGlobal: false })
    const result = await handler({ rawInput: '/refine --local focus', agent: agent() })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('diagnostics: completed')
  })

  it('appends a disabled diagnostics line when no provider is enabled', async () => {
    const handler = createRefineCommandAdapter(fakeCoordinator({
      ...committedWithRejected(),
      diagnostics: { status: 'disabled', structural: [], security: [], errors: [] },
    }), { defaultGlobal: false })
    const result = await handler({ rawInput: '/refine --local focus', agent: agent() })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('diagnostics: disabled')
  })

  it('renders one diagnostics error line per provider error', async () => {
    const handler = createRefineCommandAdapter(fakeCoordinator({
      ...committedWithRejected(),
      diagnostics: {
        status: 'partial',
        structural: [],
        security: [],
        errors: [{ provider: 'security', code: 'provider-failed', message: 'scanner failed' }],
      },
    }), { defaultGlobal: false })
    const result = await handler({ rawInput: '/refine --local focus', agent: agent() })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('diagnostics: partial')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('diagnostics-error: security provider-failed scanner failed')
  })

  it('omits the diagnostics line when the coordinator result has no report', async () => {
    const handler = createRefineCommandAdapter(fakeCoordinator(committedWithRejected()), { defaultGlobal: false })
    const result = await handler({ rawInput: '/refine --local focus', agent: agent() })
    expect(result.kind).toBe('success')
    expect(result.text).not.toContain('diagnostics:')
  })

  it('renders a stable error line from the domain result', async () => {
    const coordinator = fakeCoordinator({
      ...notCommitted(),
      failedAt: 'validation',
      error: { code: 'rollback-target-not-found', message: 'no refinement found with id missing' },
    })
    const handler = createRefineCommandAdapter(coordinator, { defaultGlobal: true })
    const result = await handler({ rawInput: '/refine rollback missing --local', agent: agent() })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('error: rollback-target-not-found no refinement found with id missing')
  })

  it('builds a plan request with source command and passes the signal', async () => {
    const execute = vi.fn(async () => notCommitted())
    const handler = createRefineCommandAdapter({ execute }, { defaultGlobal: false })
    const signal = new AbortController().signal
    await handler({ rawInput: '/refine --local focus errors', agent: agent(), signal })
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'plan', source: 'command', scope: 'local', instructions: 'focus errors', agent: expect.any(Object), signal,
    }))
  })

  it('builds a rollback request with source command', async () => {
    const execute = vi.fn(async () => notCommitted())
    const handler = createRefineCommandAdapter({ execute }, { defaultGlobal: true })
    await handler({ rawInput: '/refine rollback r-9 --local', agent: agent() })
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'rollback', source: 'command', scope: 'local', rollbackId: 'r-9', agent: expect.any(Object),
    }))
  })

  it('returns a usage error without calling the coordinator when the agent is missing', async () => {
    const execute = vi.fn()
    const handler = createRefineCommandAdapter({ execute }, { defaultGlobal: true })
    const result = await handler({ rawInput: '/refine --global focus' })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('error:')
    expect(execute).not.toHaveBeenCalled()
  })

  it('returns a usage error without calling the coordinator on a parse failure', async () => {
    const execute = vi.fn()
    const handler = createRefineCommandAdapter({ execute }, { defaultGlobal: true })
    const result = await handler({ rawInput: '/refine --global --local focus', agent: agent() })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('error:')
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('registerRefineCommand', () => {
  it('registers the refine command and disposes through the capability handle', () => {
    const dispose = vi.fn()
    const register = vi.fn(() => ({ dispose }))
    const commands: CommandsCapability = { register }
    const coordinator = fakeCoordinator(notCommitted())
    const registration = registerRefineCommand(commands, coordinator, { defaultGlobal: false })
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ name: 'refine', handler: expect.any(Function) }))
    registration.dispose()
    expect(dispose).toHaveBeenCalled()
  })
})
