/**
 * Shared `Agent` test double for the driver-owned inbox.
 *
 * dsh 0.1.5 turned `Inbox` from a constructible class into a pure interface:
 * the concrete implementation (`ReactLoopInbox`) moved into the agent-loop
 * package and is built by the driver, so `new Inbox(session, callbacks)` no
 * longer exists. Specs that only need an `Agent`-shaped value supply this
 * in-memory implementation instead of reaching into the loop's internals.
 * @module dsh-continual-harness
 */

import type { Inbox } from '@deepseek-ai/dsh-agent'
import type { InboxTarget } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** One in-memory {@link Inbox} implementing the full interface, since a stub
 *  that silently answered `false`/`[]` would hide a caller that started using
 *  the mutate-by-id operations. */
export function stubInbox(): Inbox {
  const pending: Record<InboxTarget, UserMessage[]> = { 'next-turn': [], 'next-step': [] }
  const lists = (): UserMessage[][] => [pending['next-turn'], pending['next-step']]
  return {
    get nextTurn(): readonly UserMessage[] { return pending['next-turn'] },
    get nextStep(): readonly UserMessage[] { return pending['next-step'] },
    clear(): void {
      pending['next-step'] = []
      pending['next-turn'] = []
    },
    append(target: InboxTarget, message: UserMessage): void {
      pending[target].push(message)
    },
    prepend(target: InboxTarget, message: UserMessage): void {
      pending[target].unshift(message)
    },
    replace(messageId, newMessage): boolean {
      for (const list of lists()) {
        const index = list.findIndex(message => message.id === messageId)
        if (index !== -1) {
          list[index] = newMessage
          return true
        }
      }
      return false
    },
    remove(messageId): boolean {
      for (const list of lists()) {
        const index = list.findIndex(message => message.id === messageId)
        if (index !== -1) {
          list.splice(index, 1)
          return true
        }
      }
      return false
    },
    splice(target, start, deleteCount, inserted): UserMessage[] {
      return pending[target].splice(start, deleteCount, ...inserted)
    },
  }
}
