import { describe, expect, it } from 'vitest'
import {
  AUTO_REFINE_REVIEW_SYSTEM_PROMPT,
  REFINEMENT_SYSTEM_PROMPT,
  TRUNCATED_JSON_ERROR,
  autoRefineInstructions,
  parseAutoRefineReview,
  parseProposal,
  planRefinement,
  reviewAutoRefine,
  scopeInstruction,
} from '../src/planner.ts'

describe('proposal parsing', () => {
  it('parses a proposal from a code-fenced reply', () => {
    const proposal = parseProposal('Here you go:\n```json\n{"id":"refine_1","summary":"s","edits":[{"action":"create","kind":"memory","id":"a","content":"c"}]}\n```')
    expect(proposal.id).toBe('refine_1')
    expect(proposal.edits[0]?.id).toBe('a')
  })

  it('throws a truncated-reply error when no JSON object completes', () => {
    expect(() => parseProposal('{"id":"refine_1","summary":"s","edits":[{"action":"create"')).toThrow(TRUNCATED_JSON_ERROR)
    expect(() => parseProposal('no json here')).toThrow(TRUNCATED_JSON_ERROR)
  })

  it('rejects malformed proposals', () => {
    expect(() => parseProposal('{"id":1,"edits":[]}')).toThrow('malformed refinement proposal')
  })
})

describe('review parsing', () => {
  it('parses an approved review', () => {
    expect(parseAutoRefineReview('{"approved":true,"rationale":"clear pattern"}'))
      .toEqual({ approved: true, rationale: 'clear pattern' })
  })
})

describe('planRefinement and reviewAutoRefine', () => {
  it('plans through the injected seam with the full context', async () => {
    let seen = ''
    const complete = async (system: string, user: string) => {
      expect(system).toContain('continual harness refiner')
      expect(user).toContain('Store scope')
      expect(user).toContain('Current trajectory excerpt')
      seen = user
      return '{"id":"refine_2","summary":"s","edits":[]}'
    }
    const proposal = await planRefinement({
      stateOverview: 'overview',
      historyText: 'history',
      trajectoryText: 'trajectory',
      scopeInstruction: scopeInstruction(false),
    }, complete)
    expect(proposal.id).toBe('refine_2')
    expect(seen).toContain('Target store: local')
  })

  it('reviews through the seam and forwards the reason', async () => {
    const complete = async (system: string, user: string) => {
      expect(system).toContain('gatekeeper')
      expect(user).toContain('reason: turn-interval')
      return '{"approved":false,"rationale":"nothing new"}'
    }
    const review = await reviewAutoRefine({
      stateOverview: 'o',
      historyText: 'h',
      trajectoryText: 't',
      reason: 'turn-interval',
    }, complete)
    expect(review.approved).toBe(false)
    expect(autoRefineInstructions('turn-interval', review)).toContain('nothing new')
  })
})

describe('scope instruction', () => {
  it('describes local and global targets distinctly', () => {
    expect(scopeInstruction(false)).toContain('local')
    expect(scopeInstruction(true)).toContain('global')
    expect(scopeInstruction(false)).not.toEqual(scopeInstruction(true))
  })
})

describe('system prompts', () => {
  it('keeps the base system prompt immutable in planning guidance', () => {
    expect(REFINEMENT_SYSTEM_PROMPT).toContain('base system prompt is immutable')
    expect(AUTO_REFINE_REVIEW_SYSTEM_PROMPT).toContain('gatekeeper')
  })
})
