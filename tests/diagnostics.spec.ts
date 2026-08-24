import { describe, expect, it, vi } from 'vitest'
import { createDiagnosticRunner, structuralProvider } from '../src/diagnostics.ts'
import type {
  DiagnosticRequest,
  MaterializationResult,
  SkillBundleIssue,
  SkillEntry,
} from '../src/types.ts'

function skillEntry(id: string, content = 'body', description?: string): SkillEntry {
  return {
    id,
    kind: 'skill',
    version: 1,
    content,
    ...(description === undefined ? {} : { description }),
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function emptyMaterialization(): MaterializationResult {
  return { status: 'completed', written: [], unchanged: [], skipped: [], staleCandidates: [], errors: [] }
}

function request(overrides: Partial<DiagnosticRequest> = {}): DiagnosticRequest {
  return {
    refinementId: 'r',
    touchedSkillIds: ['one'],
    entries: { one: skillEntry('one') },
    materialization: emptyMaterialization(),
    enableSecurity: true,
    ...overrides,
  }
}

describe('createDiagnosticRunner', () => {
  it('diagnoses only touched skills and embeds materialization', async () => {
    const structural = vi.fn(async (req: DiagnosticRequest) => req.touchedSkillIds.map(skillId => ({ skillId, code: 'ok', message: 'valid' })))
    const report = await createDiagnosticRunner({ structural: { name: 'structural', run: structural }, enableSecurity: false }).run({
      refinementId: 'r',
      touchedSkillIds: ['one'],
      entries: { one: skillEntry('one'), untouched: skillEntry('untouched') },
      materialization: emptyMaterialization(),
      enableSecurity: false,
    })
    expect(structural).toHaveBeenCalledWith(expect.objectContaining({ touchedSkillIds: ['one'] }))
    expect(report).toMatchObject({ status: 'completed', materialization: emptyMaterialization(), security: [], errors: [] })
  })

  it('keeps one provider result when the other provider fails', async () => {
    const report = await createDiagnosticRunner({
      structural: { name: 'structural', run: async () => [{ skillId: 's', code: 'bad', message: 'bad' }] },
      security: { name: 'security', run: async () => { throw new Error('scanner failed') } },
      enableSecurity: true,
    }).run(request())
    expect(report.status).toBe('partial')
    expect(report.structural).toHaveLength(1)
    expect(report.errors).toEqual([{ provider: 'security', code: 'provider-failed', message: 'scanner failed' }])
  })

  it('returns disabled rather than empty-success when no provider is enabled', async () => {
    await expect(createDiagnosticRunner({ enableSecurity: false }).run(request())).resolves.toMatchObject({ status: 'disabled', errors: [] })
  })

  it('runs only structural when security is disabled', async () => {
    const structural = vi.fn(async () => [])
    const security = vi.fn(async () => [])
    const report = await createDiagnosticRunner({
      structural: { name: 'structural', run: structural },
      security: { name: 'security', run: security },
      enableSecurity: false,
    }).run(request())
    expect(report.status).toBe('completed')
    expect(structural).toHaveBeenCalledTimes(1)
    expect(security).not.toHaveBeenCalled()
  })

  it('marks the report partial when the signal is aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const report = await createDiagnosticRunner({
      structural: { name: 'structural', run: async () => [{ skillId: 's', code: 'c', message: 'm' }] },
      enableSecurity: false,
    }).run({ ...request(), signal: controller.signal })
    expect(report.status).toBe('partial')
    expect(report.structural).toHaveLength(1)
    expect(report.errors).toEqual([])
  })

  it('completes with empty findings when no skill is touched and never scans', async () => {
    const structural = vi.fn(async (req: DiagnosticRequest) => req.touchedSkillIds.map(id => ({ skillId: id, code: 'ok', message: 'valid' })))
    const report = await createDiagnosticRunner({ structural: { name: 'structural', run: structural }, enableSecurity: false })
      .run(request({ touchedSkillIds: [], entries: { untouched: skillEntry('untouched') } }))
    expect(report.status).toBe('completed')
    expect(report.structural).toEqual([])
    expect(structural).toHaveBeenCalledWith(expect.objectContaining({ touchedSkillIds: [] }))
  })

  it('carries a failed materialization through unchanged without failing the report', async () => {
    const failed: MaterializationResult = {
      ...emptyMaterialization(),
      status: 'failed',
      errors: [{ code: 'write-failed', retryable: true, message: 'boom' }],
    }
    const report = await createDiagnosticRunner({
      structural: { name: 'structural', run: async () => [] },
      enableSecurity: false,
    }).run(request({ materialization: failed }))
    expect(report.status).toBe('completed')
    expect(report.materialization).toBe(failed)
  })

  it('records a tagged budget error with its own code', async () => {
    const budgetError = Object.assign(new Error('provider exceeded input budget'), { code: 'budget-exceeded' })
    const report = await createDiagnosticRunner({
      structural: { name: 'structural', run: async () => [{ skillId: 's', code: 'ok', message: 'ok' }] },
      security: { name: 'security', run: async () => { throw budgetError } },
      enableSecurity: true,
    }).run(request())
    expect(report.status).toBe('partial')
    expect(report.structural).toHaveLength(1)
    expect(report.errors).toEqual([{ provider: 'security', code: 'budget-exceeded', message: 'provider exceeded input budget' }])
  })
})

describe('structuralProvider', () => {
  it('reports issues only for touched skills using the existing bundle validation helpers', async () => {
    const report = await createDiagnosticRunner({ structural: structuralProvider, enableSecurity: false }).run({
      refinementId: 'r',
      touchedSkillIds: ['valid', 'missing', 'bad-files', 'bad-content'],
      entries: {
        valid: skillEntry('valid', 'Body text', 'Use whenever doing x'),
        'bad-files': { ...skillEntry('bad-files'), files: { '../evil': 'x' } },
        'bad-content': skillEntry('bad-content', 'body without description'),
        untouched: { ...skillEntry('untouched'), files: { '../evil': 'x' } },
      },
      enableSecurity: false,
    })
    const codes = report.structural.map(issue => issue.code)
    expect(codes).toContain('entry-missing')
    expect(codes).toContain('invalid-bundle-files')
    expect(codes).toContain('description-missing')
    expect(codes).not.toContain('id-too-long')
    expect(report.structural.some(issue => issue.skillId === 'untouched')).toBe(false)
  })

  it('returns no issues for a valid touched skill', async () => {
    const issues = await structuralProvider.run(request({
      touchedSkillIds: ['valid'],
      entries: { valid: skillEntry('valid', 'Body text', 'Use whenever doing x') },
    }))
    expect(issues).toEqual([])
  })

  it('never writes files or re-reads store state (pure provider)', async () => {
    const entries: Record<string, SkillEntry> = { one: skillEntry('one') }
    const before = JSON.stringify(entries)
    await structuralProvider.run(request())
    expect(JSON.stringify(entries)).toBe(before)
    expect(entries.one?.content).toBe('body')
  })
})

describe('structuralProvider issue shape', () => {
  it('maps L2 findings to report issues with skillId', async () => {
    const issues: SkillBundleIssue[] = await structuralProvider.run(request({
      touchedSkillIds: ['no-desc'],
      entries: { 'no-desc': skillEntry('no-desc', 'plain body') },
    }))
    expect(issues[0]).toMatchObject({ skillId: 'no-desc', code: 'description-missing', message: expect.any(String) })
  })
})
