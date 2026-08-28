import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  createRefineCommandAdapter,
  parseRefineCommand,
  registerRefineCommand,
  reportRefineOutcome,
} from '../src/command.ts'
import type { CommandDefinition, CommandsCapability } from '../src/command.ts'
import type { RefineCoordinator, RefineExecutionResult } from '../src/coordinator.ts'
import { PLUGIN_NAME } from '../src/domain.ts'

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
  it('acknowledges immediately with status started without awaiting the execution', async () => {
    let resolveExecute!: (result: RefineExecutionResult) => void
    const execute = vi.fn(() => new Promise<RefineExecutionResult>(resolve => { resolveExecute = resolve }))
    const report = vi.fn()
    const handler = createRefineCommandAdapter({ execute }, { defaultGlobal: false, report })
    const result = await handler({ rawInput: '/refine --local focus', agent: agent() })
    // The handler settled while the coordinator has not even started yet: the
    // draft can clear as soon as the host RPC round-trip finishes.
    expect(result.kind).toBe('success')
    expect(result.text).toContain('stage: ack-done')
    expect(result.text).toContain('status: started')
    expect(result.text).toContain('scope: local')
    expect(execute).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    resolveExecute(committedWithRejected())
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1))
  })

  it('reports the settled execution and requested scope through the outcome reporter', async () => {
    const report = vi.fn()
    const handler = createRefineCommandAdapter(fakeCoordinator(committedWithRejected()), { defaultGlobal: false, report })
    const a = agent()
    const result = await handler({ rawInput: '/refine --local focus', agent: a })
    expect(result.kind).toBe('success')
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1))
    const [invocation, execution, scope] = report.mock.calls[0]
    expect(invocation.agent).toBe(a)
    expect(scope).toBe('local')
    expect(execution.commitStatus).toBe('committed-with-rejected-edits')
    expect(execution.appliedCount).toBe(2)
  })

  it('skips a second submit while one execution is still in flight', async () => {
    let resolveExecute!: (result: RefineExecutionResult) => void
    const execute = vi.fn(() => new Promise<RefineExecutionResult>(resolve => { resolveExecute = resolve }))
    const report = vi.fn()
    const handler = createRefineCommandAdapter({ execute }, { defaultGlobal: false, report })
    const a = agent()
    const first = await handler({ rawInput: '/refine --local focus', agent: a })
    expect(first.text).toContain('status: started')
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    const second = await handler({ rawInput: '/refine --local focus', agent: a })
    expect(second.text).toContain('stage: ack-done')
    expect(second.text).toContain('status: already-running')
    expect(execute).toHaveBeenCalledTimes(1)
    resolveExecute(notCommitted())
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1))
    // Once the first execution settled, the session accepts new submits again.
    const third = await handler({ rawInput: '/refine --local focus', agent: a })
    expect(third.text).toContain('status: started')
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2))
    resolveExecute(notCommitted())
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2))
  })

  it('builds a plan request with source command and strips the invocation signal', async () => {
    const execute = vi.fn(async () => notCommitted())
    const report = vi.fn()
    const handler = createRefineCommandAdapter({ execute }, { defaultGlobal: false, report })
    const signal = new AbortController().signal
    await handler({ rawInput: '/refine --local focus errors', agent: agent(), signal })
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1))
    const request = execute.mock.calls[0][0]
    expect(request).toMatchObject({
      mode: 'plan', source: 'command', scope: 'local', instructions: 'focus errors', agent: expect.any(Object),
    })
    // The signal belongs to the UI request and may abort once the handler
    // settles; the detached execution must not inherit it.
    expect(request).not.toHaveProperty('signal')
  })

  it('builds a rollback request with source command', async () => {
    const execute = vi.fn(async () => notCommitted())
    const report = vi.fn()
    const handler = createRefineCommandAdapter({ execute }, { defaultGlobal: true, report })
    await handler({ rawInput: '/refine rollback r-9 --local', agent: agent() })
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1))
    const request = execute.mock.calls[0][0]
    expect(request).toMatchObject({ mode: 'rollback', source: 'command', scope: 'local', rollbackId: 'r-9', agent: expect.any(Object) })
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

  it('normalizes a thrown background execution into a reported error result', async () => {
    const execute = vi.fn(async () => { throw new Error('boom') })
    const report = vi.fn()
    const handler = createRefineCommandAdapter({ execute }, { defaultGlobal: true, report })
    const result = await handler({ rawInput: '/refine', agent: agent() })
    expect(result.kind).toBe('success')
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1))
    const execution = report.mock.calls[0][1] as RefineExecutionResult
    expect(execution.commitStatus).toBe('not-committed')
    expect(execution.error).toMatchObject({ code: 'unexpected-error', message: 'boom' })
  })

  it('default reporter fires when no reporter option is given', async () => {
    const a = agent()
    const appendSpy = vi.spyOn(a.session, 'append')
    const handler = createRefineCommandAdapter(fakeCoordinator(committedWithRejected()), { defaultGlobal: false })
    await handler({ rawInput: '/refine --local focus', agent: a, commandId: 'cmd-1' })
    await vi.waitFor(() => expect(appendSpy).toHaveBeenCalled())
    const [type, data] = appendSpy.mock.calls[0]
    expect(type).toBe('command/done')
    expect(data.commandId).toBe('cmd-1')
    expect(data.kind).toBe('success')
  })

  it('default reporter updates the original command card with the rendered outcome', async () => {
    const a = agent()
    const appendSpy = vi.spyOn(a.session, 'append')
    const handler = createRefineCommandAdapter(fakeCoordinator(committedWithRejected()), { defaultGlobal: false, report: reportRefineOutcome })
    await handler({ rawInput: '/refine --local focus', agent: a, commandId: 'cmd-1' })
    await vi.waitFor(() => expect(appendSpy).toHaveBeenCalled())
    const [type, data] = appendSpy.mock.calls[0]
    expect(type).toBe('command/done')
    expect(data.commandId).toBe('cmd-1')
    expect(data.kind).toBe('success')
    const text = data.text as string
    expect(text).toContain('stage: refine-done')
    expect(text).toContain('status: committed')
    expect(text).toContain('refinement: r-cmd')
    expect(text).toContain('summary: saved two lessons; one update rejected')
  })

  it('default reporter renders a plain not-committed outcome', async () => {
    const a = agent()
    const appendSpy = vi.spyOn(a.session, 'append')
    const handler = createRefineCommandAdapter(fakeCoordinator(notCommitted()), { defaultGlobal: true, report: reportRefineOutcome })
    await handler({ rawInput: '/refine', agent: a, commandId: 'cmd-1' })
    await vi.waitFor(() => expect(appendSpy).toHaveBeenCalled())
    const [, data] = appendSpy.mock.calls[0]
    const text = data.text as string
    expect(text).toContain('status: not-committed')
    expect(text).toContain('refinement: none')
  })

  it('default reporter renders the requested scope for a failed global run', async () => {
    const a = agent()
    const appendSpy = vi.spyOn(a.session, 'append')
    const handler = createRefineCommandAdapter(fakeCoordinator({
      ...notCommitted(),
      failedAt: 'validation',
      error: { code: 'rollback-target-not-found', message: 'no refinement found with id missing' },
    }), { defaultGlobal: true, report: reportRefineOutcome })
    const result = await handler({ rawInput: '/refine rollback missing --global', agent: a, commandId: 'cmd-1' })
    expect(result.text).toContain('scope: global')
    await vi.waitFor(() => expect(appendSpy).toHaveBeenCalled())
    const [, data] = appendSpy.mock.calls[0]
    // No refinement exists on the failure result; the requested scope must
    // still render truthfully instead of falling back to a guessed local.
    expect(data.text).toContain('scope: global')
    expect(data.text).toContain('error: rollback-target-not-found no refinement found with id missing')
  })

  it('default reporter renders a completed diagnostics line', async () => {
    const a = agent()
    const appendSpy = vi.spyOn(a.session, 'append')
    const handler = createRefineCommandAdapter(fakeCoordinator({
      ...committedWithRejected(),
      diagnostics: {
        status: 'partial',
        structural: [],
        security: [],
        errors: [{ provider: 'security', code: 'provider-failed', message: 'scanner failed' }],
      },
    }), { defaultGlobal: false, report: reportRefineOutcome })
    await handler({ rawInput: '/refine --local focus', agent: a, commandId: 'cmd-1' })
    await vi.waitFor(() => expect(appendSpy).toHaveBeenCalled())
    const [, data] = appendSpy.mock.calls[0]
    expect(data.text).toContain('diagnostics: partial')
    expect(data.text).toContain('diagnostics-error: security provider-failed scanner failed')
  })

  it('default reporter falls back to a plugin-source user message without a commandId', async () => {
    const a = agent()
    const appendSpy = vi.spyOn(a.session, 'append')
    const handler = createRefineCommandAdapter(fakeCoordinator(committedWithRejected()), { defaultGlobal: false, report: reportRefineOutcome })
    await handler({ rawInput: '/refine --local focus', agent: a })
    await vi.waitFor(() => expect(appendSpy).toHaveBeenCalled())
    const [type, message] = appendSpy.mock.calls[0]
    expect(type).toBe('user/message')
    expect(message.source).toMatchObject({ kind: 'plugin', plugin: PLUGIN_NAME })
    expect(message.content[0].text).toContain('status: committed')
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

  it('passes the outcome reporter through to the registered handler', async () => {
    const report = vi.fn()
    const register = vi.fn(() => ({ dispose: () => {} }))
    const commands: CommandsCapability = { register }
    const coordinator = fakeCoordinator(committedWithRejected())
    registerRefineCommand(commands, coordinator, { defaultGlobal: false, report })
    const definition = register.mock.calls[0][0] as CommandDefinition
    const result = await definition.handler({ rawInput: '/refine --local focus', agent: agent() })
    expect(result).toMatchObject({ kind: 'success', text: expect.stringContaining('status: started') })
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1))
  })
})
