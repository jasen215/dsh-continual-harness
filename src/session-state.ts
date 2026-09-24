/**
 * Per-session projection facts: what this plugin cannot re-derive from the
 * session's derived history, tracked in memory for the plugin's lifetime.
 *
 * - `cacheEvidence` records that a model call reported cache-read tokens, which
 *   only the `assistant/message` event carries: `AssistantMessage` has no
 *   `usage` field, so no derived-history read can answer it. It is observed as
 *   events commit and deliberately not persisted: after a plugin restart the
 *   first refinement of a resumed session uses the layered summary (Route B)
 *   until a cache-read message lands. That is the documented, correctness-neutral
 *   cost of keeping this plugin free of log scans and extra files.
 * - `harnessStateSeq` is the sequence of the block this plugin wrote, the fast
 *   path for shadowing it in place. When it is unknown — a block written before
 *   this process started, an upgraded plugin, a fresh store — the block is
 *   located from current surface state instead (see {@link harnessStateSeqToReplace}).
 *
 * dsh 0.1.7 prohibits new synchronous history reads
 * (`snapshotEvents`/`eventAt`/`ownEvents`); nothing here reads the log.
 * @module dsh-continual-harness
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { isCacheEvidenceEvent } from './cache-detect.ts'
import { isHarnessStateSource } from './domain.ts'
import type { HarnessStore } from './store.ts'

/** Facts tracked per session; each field is latest-wins or monotonic. */
export interface SessionProjectionState {
  /** Sequence of this plugin's harness-state block, latest observed. */
  harnessStateSeq?: number
  /** Set once a recorded model call reported cache-read tokens. */
  cacheEvidence?: true
}

/**
 * Register the incremental observer. Every committed event flows through one
 * listener that writes only on change, so the steady-state cost is a comparison
 * per event.
 */
export function registerSessionProjectionObserver(ctx: Context, store: HarnessStore): void {
  ctx.on('session/event', (session, event) => {
    const patch: SessionProjectionState = {}
    // Every update lands a fresh copy of this plugin's block, so the newest
    // observed sequence is the one a later update must shadow.
    if (event.type === 'user/message' && event.data.source !== undefined && isHarnessStateSource(event.data.source)) {
      patch.harnessStateSeq = event.seq
    }
    if (isCacheEvidenceEvent(event)) patch.cacheEvidence = true
    if (patch.harnessStateSeq === undefined && patch.cacheEvidence === undefined) return
    store.recordSessionProjection(session, patch)
  })
}

/** True when a recorded model call in this session reported cache-read tokens. */
export function hasSessionCacheEvidence(session: Session, store: HarnessStore): boolean {
  return store.sessionProjection(session).cacheEvidence === true
}

/**
 * The sequence an update must shadow, or undefined when the session holds no
 * visible harness-state block.
 *
 * Fast path: the sequence tracked as the block committed.
 *
 * Fallback: locate it from current surface state. The node list and the derived
 * history describe the same surface in the same order, so the two arrays are
 * index-aligned exactly when they have equal length — they differ only if a
 * surface event derived to no message, and only an empty-content
 * system/developer/assistant message does that. Equal length therefore proves
 * that index `i` of one array is the same event as index `i` of the other,
 * which covers a block written before this process started without a log scan.
 */
export function harnessStateSeqToReplace(session: Session, store: HarnessStore): SessionSeq | undefined {
  const tracked = visibleHarnessStateSeq(session, store.sessionProjection(session))
  if (tracked !== undefined) return tracked
  return locatedHarnessStateSeq(session)
}

/** The tracked sequence while the block is still model-visible, else undefined. */
function visibleHarnessStateSeq(session: Session, state: SessionProjectionState): SessionSeq | undefined {
  const seq = state.harnessStateSeq
  if (seq === undefined) return undefined
  const tracked = seq as SessionSeq
  return session.surface.nodes.includes(tracked) ? tracked : undefined
}

/**
 * Locate the block from current surface state, newest first. A surface whose
 * derived history dropped a message is not guessed at: an unusable pairing
 * yields no target, which costs at most one stale block until compaction.
 */
function locatedHarnessStateSeq(session: Session): SessionSeq | undefined {
  const nodes = session.surface.nodes
  const messages = session.deriveMessages()
  if (nodes.length !== messages.length) return undefined
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || !isHarnessStateSource(message.source)) continue
    return nodes[index]
  }
  return undefined
}
