// tests/session-state.spec.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import { HARNESS_STATE_FORM, HARNESS_STATE_KIND } from '../src/domain.ts'
import { harnessStateSeqToReplace, hasSessionCacheEvidence, registerSessionProjectionObserver } from '../src/session-state.ts'
import { HarnessStore } from '../src/store.ts'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup(rawId: string): { ctx: Context; store: HarnessStore; session: Session } {
  const ctx = new Context()
  const home = mkdtempSync(join(tmpdir(), 'harness-state-'))
  tempDirs.push(home)
  const store = new HarnessStore(ctx, { harnessRoot: home, skillsDir: join(home, 'skills') })
  return { ctx, store, session: Session.create(SessionId(rawId)) }
}

/** A committed overview block, the shape the projection injects. */
function block(): UserMessage {
  return createUserMessage({
    source: { kind: HARNESS_STATE_KIND, form: HARNESS_STATE_FORM },
    content: [{ type: 'text', text: '<harness_state/>' }],
  })
}

/** A store-attached session publishes `session/event` from the append itself. */
function commit(ctx: Context, session: Session, message: UserMessage): SessionEvent {
  const event = session.append('user/message', message, { surfaceOp: 'append' })
  ctx.emit('session/event', session, event)
  return event
}

function assistantCommit(ctx: Context, session: Session, cacheReadTokens: number): SessionEvent {
  const event = session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({ source: { provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'ok' }] }),
    usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens },
  } as never, { surfaceOp: 'append' })
  ctx.emit('session/event', session, event)
  return event as SessionEvent
}

describe('harnessStateSeqToReplace', () => {
  it('locates the block a session already carries without any tracking', () => {
    // A resumed session, or one written before this bookkeeping existed: no
    // observer ever saw the block, so the surface itself has to say where it is
    // — otherwise an update injects a second block instead of shadowing the
    // first, and the transcript accumulates stale snapshots.
    const { store, session } = setup('resumed')
    const event = session.append('user/message', block(), { surfaceOp: 'append' })

    expect(harnessStateSeqToReplace(session, store)).toBe(event.seq)
  })

  it('keeps the newest tracked sequence as blocks commit', () => {
    const { ctx, store, session } = setup('committed')
    registerSessionProjectionObserver(ctx, store)
    expect(harnessStateSeqToReplace(session, store)).toBeUndefined()

    commit(ctx, session, block())
    const second = commit(ctx, session, block())

    expect(harnessStateSeqToReplace(session, store)).toBe(second.seq)
  })

  it('never names a block that left the visible surface', () => {
    // A replacement copy shadows the block it replaced, so the stale sequence
    // must not be handed back as a replacement target.
    const { store, session } = setup('shadowed')
    const shadowed = session.append('user/message', block(), { surfaceOp: 'append' })
    expect(harnessStateSeqToReplace(session, store)).toBe(shadowed.seq)

    const plain = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'after' }] })
    session.append('user/message', plain, {
      surfaceOp: { op: 'replace', startSeq: shadowed.seq, endSeq: shadowed.seq },
      sourceEventSeqs: [shadowed.seq],
    })

    expect(harnessStateSeqToReplace(session, store)).toBeUndefined()
  })

  it('relies on the tracked sequence when a message did not derive', () => {
    // An empty-content assistant message derives to no message, so the surface
    // and the derived history stop being index-aligned. Tracking itself is what
    // covers that session; the untracked lookup must not guess a wrong node.
    const { ctx, store, session } = setup('unaligned')
    registerSessionProjectionObserver(ctx, store)
    const tracked = commit(ctx, session, block())
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ source: { provider: 'p', model: 'm' }, content: [] }),
    } as never, { surfaceOp: 'append' })

    expect(harnessStateSeqToReplace(session, store)).toBe(tracked.seq)

    // Without tracking, an unusable pairing yields no target rather than a
    // wrong one.
    const untracked = setup('unaligned-untracked')
    const alone = untracked.session.append('user/message', block(), { surfaceOp: 'append' })
    untracked.session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ source: { provider: 'p', model: 'm' }, content: [] }),
    } as never, { surfaceOp: 'append' })
    expect(harnessStateSeqToReplace(untracked.session, untracked.store)).toBeUndefined()
    expect(alone.seq).toBeDefined()
  })
})

describe('hasSessionCacheEvidence', () => {
  it('observes cache-read evidence as it commits and ignores zeroed accounting', () => {
    const { ctx, store, session } = setup('observed-cache')
    registerSessionProjectionObserver(ctx, store)
    expect(hasSessionCacheEvidence(session, store)).toBe(false)

    assistantCommit(ctx, session, 0)
    expect(hasSessionCacheEvidence(session, store)).toBe(false)

    assistantCommit(ctx, session, 12)
    expect(hasSessionCacheEvidence(session, store)).toBe(true)
  })

  it('does not carry evidence across a plugin restart', () => {
    // The accepted cost of tracking this in memory only: after a restart the
    // first refinement of a resumed session takes Route B until a cache-read
    // message lands. It is a planning-efficiency fallback, never a wrong answer.
    const { ctx, store, session } = setup('restarted-cache')
    registerSessionProjectionObserver(ctx, store)
    assistantCommit(ctx, session, 60)
    expect(hasSessionCacheEvidence(session, store)).toBe(true)

    const restarted = new HarnessStore(ctx, { harnessRoot: mkdtempSync(join(tmpdir(), 'harness-state-')), skillsDir: '/nonexistent' })
    expect(hasSessionCacheEvidence(session, restarted)).toBe(false)
  })
})
