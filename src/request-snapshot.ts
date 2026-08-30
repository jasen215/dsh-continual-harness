/**
 * Host-loop request snapshot registry: observes the `llm/stream` waterfall
 * and keeps the latest agent-loop request per session so Route A can reuse
 * the exact system/tools/messages the host already sent (spec §2.2).
 * @module dsh-continual-harness
 */
import type { Context } from '@deepseek-ai/cordis'
import { isAgentLoopRequest, type GenerateOptions, type Message, type StreamChunk, type ToolSchema } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Read-only view of the latest agent-loop request for one session. */
export interface HostRequestSnapshot {
  provider: string
  model: string
  system?: string
  tools?: readonly ToolSchema[]
  messages: readonly Message[]
  sessionId: SessionId
}

/** Per-session lookup of the last captured host-loop request. */
export interface HostRequestRegistry {
  latestFor(sessionId: SessionId): HostRequestSnapshot | undefined
}

/**
 * Install the `llm/stream` waterfall listener. Only requests carrying the
 * process-local agent-loop marker are captured; one-shot/planner calls (no
 * marker) are ignored so a planner call can never shadow the host prefix.
 * The listener returns `next()` unchanged — it only observes.
 */
export function installHostRequestSnapshot(ctx: Context): HostRequestRegistry {
  const latest = new Map<string, HostRequestSnapshot>()
  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    if (isAgentLoopRequest(options) && options.sessionId !== undefined) {
      latest.set(String(options.sessionId), {
        provider: options.provider,
        model: options.model,
        ...(options.system === undefined ? {} : { system: options.system }),
        ...(options.tools === undefined ? {} : { tools: options.tools }),
        messages: options.messages,
        sessionId: options.sessionId,
      })
    }
    return next()
  })
  return {
    latestFor(sessionId: SessionId): HostRequestSnapshot | undefined {
      return latest.get(String(sessionId))
    },
  }
}
