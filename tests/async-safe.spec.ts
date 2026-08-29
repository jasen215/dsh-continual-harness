import { expect, describe, it } from 'vitest'
import { EvaluationAbortError, EvaluationTimeoutError, raceWithTimeout } from '../src/async-safe.ts'

/** Record unhandled rejections for the duration of one assertion block. */
async function withoutUnhandledRejections(run: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    await run()
    await new Promise(resolve => setTimeout(resolve, 20))
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  return unhandled
}

describe('raceWithTimeout', () => {
  it('rejects with an abort when the signal is already aborted and keeps the loser handled', async () => {
    const loser = Promise.reject(new Error('loser after early return'))
    const unhandled = await withoutUnhandledRejections(async () => {
      const controller = new AbortController()
      controller.abort()
      await expect(raceWithTimeout(loser, 1000, controller.signal)).rejects.toBeInstanceOf(EvaluationAbortError)
    })
    expect(unhandled).toEqual([])
  })

  it('keeps the loser handled when the caller aborts after entry and the promise rejects later', async () => {
    let rejectLoser: ((error: Error) => void) | undefined
    const loser = new Promise<string>((_resolve, reject) => { rejectLoser = reject })
    const unhandled = await withoutUnhandledRejections(async () => {
      const controller = new AbortController()
      const raced = raceWithTimeout(loser, 1000, controller.signal)
      controller.abort()
      await expect(raced).rejects.toBeInstanceOf(EvaluationAbortError)
      rejectLoser?.(new Error('loser after settle'))
    })
    expect(unhandled).toEqual([])
  })

  it('rejects with a timeout and fires onTimeout so the caller can cancel the work', async () => {
    let cancelled = false
    const pending = new Promise<string>(() => {})
    await expect(raceWithTimeout(pending, 5, undefined, () => { cancelled = true }))
      .rejects.toBeInstanceOf(EvaluationTimeoutError)
    expect(cancelled).toBe(true)
  })
})
