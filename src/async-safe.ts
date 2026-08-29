/**
 * Shared async safety helpers: phase timeout racing with caller aborts.
 * Extracted from src/evaluate.ts so src/complete.ts can share the mechanism
 * without a cyclic import (evaluate.ts already imports complete.ts).
 * @module dsh-continual-harness
 */

/** Marker error for a phase that exceeded its timeout budget. */
export class EvaluationTimeoutError extends Error {
  override name = 'EvaluationTimeoutError'
}

/** Marker error for a phase cancelled by the caller's abort signal. */
export class EvaluationAbortError extends Error {
  override name = 'EvaluationAbortError'
}

/** Race a promise against a per-phase timeout and the caller's abort signal.
 * When the timeout wins, `onTimeout` (if given) fires first so the caller can
 * cancel the underlying work before the rejection is observed. */
export function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => settle(() => reject(new EvaluationAbortError()))
    const fireTimeout = (): void => {
      onTimeout?.()
      settle(() => reject(new EvaluationTimeoutError()))
    }
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const settle = (fail: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      fail()
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort()
        // The race settled immediately without waiting on `promise`; mark its
        // own rejection handled so it cannot surface as an unhandled rejection.
        promise.catch(() => {})
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    timer = setTimeout(fireTimeout, timeoutMs)
    promise.then(
      value => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      },
      error => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      },
    )
  })
}
