import { describe, expect, it } from 'vitest'
import {
  AUTO_REFINE_REVIEW_SYSTEM_PROMPT,
  REFINEMENT_SYSTEM_PROMPT,
  TRUNCATED_JSON_ERROR,
  PlannerReplyError,
  MAX_REPLY_DETAIL_CHARS,
  autoRefineInstructions,
  escapeRawControlChars,
  isTruncatedReply,
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

describe('reply repair', () => {
  it('parses a reply whose content carries raw newlines and tabs', () => {
    // The literal control characters in this reply make it invalid JSON until
    // the repair escapes them — the 2026-10-13 failure mode.
    const reply = '{"id":"refine_1","summary":"s","edits":[{"action":"create","kind":"memory","id":"a","content":"# Title\nbody\tcell"}]}'
    const proposal = parseProposal(reply)
    expect(proposal.edits[0]?.content).toBe('# Title\nbody\tcell')
  })

  it('repairs a raw-newline review rationale too', () => {
    const review = parseAutoRefineReview('{"approved":true,"rationale":"line one\nline two"}')
    expect(review.rationale).toBe('line one\nline two')
  })

  it('escapes control characters inside strings but never between tokens', () => {
    const text = '{"a":"x\ny"}\n{"b":"z"}'
    expect(escapeRawControlChars(text)).toBe('{"a":"x\\ny"}\n{"b":"z"}')
  })

  it('leaves already-escaped sequences and escapes\' payloads untouched', () => {
    const text = '{"a":"x\\ny","b":"quote: \\""}'
    expect(escapeRawControlChars(text)).toBe(text)
  })

  it('says nothing to repair for a document without raw control characters', () => {
    const text = '{"id":"refine_1","summary":"s","edits":[]}'
    expect(escapeRawControlChars(text)).toBe(text)
  })
})

describe('reply failure types', () => {
  /** Run a parser and return what it threw, so the typed failure can be asserted. */
  function thrownBy(parse: () => unknown): unknown {
    try {
      parse()
    } catch (error) {
      return error
    }
    return undefined
  }

  it('types an unparseable reply and carries the rejected reply verbatim', () => {
    const reply = '{"id":"refine_1","summary":"s "oops"","edits":[]}'
    const thrown = thrownBy(() => parseProposal(reply))
    expect(thrown).toBeInstanceOf(PlannerReplyError)
    const failure = thrown as PlannerReplyError
    expect(failure.failure).toBe('invalid-json')
    expect(failure.reply).toBe(reply)
    // The message must name the failure and show the reply, so the tool output
    // stays diagnosable without reading the log.
    expect(failure.message).toContain('reply is not valid JSON')
    expect(failure.message).toContain(`reply ${reply.length} chars`)
    expect(failure.message).toContain('head: {"id":"refine_1"')
  })

  it('types a reply with no complete JSON object as truncated-json', () => {
    const thrown = thrownBy(() => parseProposal('{"id":"refine_1","summary":"s"'))
    expect((thrown as PlannerReplyError).failure).toBe('truncated-json')
    expect((thrown as Error).message).toContain(TRUNCATED_JSON_ERROR)
  })

  it('types a right-shaped-but-wrong-fields reply as malformed-shape', () => {
    const thrown = thrownBy(() => parseProposal('{"id":1,"edits":[]}'))
    expect((thrown as PlannerReplyError).failure).toBe('malformed-shape')
    expect((thrown as Error).message).toContain('malformed refinement proposal')
  })

  it('keeps the legacy message check for seams that raise worded errors', () => {
    expect(isTruncatedReply(TRUNCATED_JSON_ERROR)).toBe(true)
    expect(isTruncatedReply('malformed refinement proposal | reply 20 chars')).toBe(true)
    expect(isTruncatedReply('Unexpected end of JSON input')).toBe(true)
    expect(isTruncatedReply('harness refinement planning failed: model request failed')).toBe(false)
  })

  it('bounds the reply diagnostic so a runaway reply cannot inflate the tool output', () => {
    const reply = `{"id":"refine_1","summary":"s","edits":[{"content":"${'x'.repeat(4_000)}`
    const failure = thrownBy(() => parseProposal(reply)) as PlannerReplyError
    // The error keeps the whole reply for the log; only the message is capped.
    expect(failure.reply).toBe(reply)
    expect(failure.message.length).toBeLessThanOrEqual(MAX_REPLY_DETAIL_CHARS)
    expect(failure.message).toContain('head: ')
    expect(failure.message).toContain('tail: ')
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

describe('planner edit contract (task 3)', () => {
  it('documents reason as required for update/delete and optional for create', () => {
    expect(REFINEMENT_SYSTEM_PROMPT).toMatch(/update.*delete.*must.*reason|must.*reason.*update|update\/delete/i)
    expect(REFINEMENT_SYSTEM_PROMPT).toMatch(/create.*(may|can) omit|omit.*create/i)
  })

  it('documents the blastRadius field with general|project|session values', () => {
    expect(REFINEMENT_SYSTEM_PROMPT).toContain('blastRadius')
    expect(REFINEMENT_SYSTEM_PROMPT).toMatch(/general\|project\|session/)
  })

  it('instructs the 4-level update preference with umbrella entries', () => {
    expect(REFINEMENT_SYSTEM_PROMPT).toContain('umbrella')
    expect(REFINEMENT_SYSTEM_PROMPT).toMatch(/4|four|levels|preference/i)
  })

  it('carries the Do NOT capture list for non-durable lessons', () => {
    expect(REFINEMENT_SYSTEM_PROMPT).toContain('Do NOT capture')
    expect(REFINEMENT_SYSTEM_PROMPT).toMatch(/environment-dependent|missing binaries|negative assertions|broken/i)
  })

  it('shows reason and blastRadius in the JSON contract example', () => {
    expect(REFINEMENT_SYSTEM_PROMPT).toContain('"reason":"..."')
    expect(REFINEMENT_SYSTEM_PROMPT).toContain('"blastRadius":"general"')
  })

  it('keeps the review gate warning that negative assertions are not durable lessons', () => {
    expect(AUTO_REFINE_REVIEW_SYSTEM_PROMPT).toMatch(/Do NOT capture|not durable/i)
    expect(AUTO_REFINE_REVIEW_SYSTEM_PROMPT).toMatch(/negative assertions|environment-dependent/i)
  })
})

describe('scope instruction (task 3)', () => {
  it('restricts global writes to stable cross-session lessons and requires reason', () => {
    const globalInstruction = scopeInstruction(true)
    expect(globalInstruction).toMatch(/stable cross-session lessons|stable.*lessons/i)
    expect(globalInstruction).toMatch(/update.*delete.*reason|must.*reason/i)
  })
})

describe('proposal parsing (task 3)', () => {
  it('still parses legacy-shaped JSON without reason or blastRadius', () => {
    const proposal = parseProposal(
      '{"id":"refine_1","summary":"s","edits":[{"action":"update","kind":"memory","id":"a","content":"c"}]}',
    )
    expect(proposal.edits[0]).toMatchObject({ action: 'update', kind: 'memory', id: 'a', content: 'c' })
    expect(proposal.edits[0]).not.toHaveProperty('reason')
    expect(proposal.edits[0]).not.toHaveProperty('blastRadius')
  })
})

describe('REFINEMENT_SYSTEM_PROMPT skill files contract', () => {
  it('documents the structured files map and its text-only contract', () => {
    expect(REFINEMENT_SYSTEM_PROMPT).toContain('"files" map')
    expect(REFINEMENT_SYSTEM_PROMPT).toContain('scripts/ or references/')
    expect(REFINEMENT_SYSTEM_PROMPT).toContain('text-only')
    expect(REFINEMENT_SYSTEM_PROMPT).toContain('forward slashes')
    expect(REFINEMENT_SYSTEM_PROMPT).toContain('generated from content')
    expect(REFINEMENT_SYSTEM_PROMPT).toContain('UTF-8 bytes')
  })

  it('states the routing boundary: no full skill-authoring loop', () => {
    expect(REFINEMENT_SYSTEM_PROMPT).toMatch(/never.*skill-authoring|skill-authoring.*loop/i)
  })
})
