/**
 * Shared async safety helpers: phase timeout racing with caller aborts.
 * Extracted from src/evaluate.ts so src/complete.ts can share the mechanism
 * without a cyclic import (evaluate.ts already imports complete.ts).
 * @module dsh-continual-harness
 */

/** Marker error for a phase that exceeded its timeout budget. */
export class PhaseTimeoutError extends Error {
  override name = 'PhaseTimeoutError'
}

/** Marker error for a phase cancelled by the caller's abort signal. */
export class PhaseAbortError extends Error {
  override name = 'PhaseAbortError'
}

/**
 * Relay a caller's abort into an internal per-call controller, so cancelling
 * the caller cancels the underlying work. Returns a cleanup fn that removes
 * the forward listener — call it when the guarded work settles; the caller's
 * signal usually outlives the call and would otherwise accumulate listeners.
 */
export function bridgeAbortSignal(from: AbortSignal, controller: AbortController): () => void {
  const forward = (): void => controller.abort()
  if (from.aborted) forward()
  else from.addEventListener('abort', forward, { once: true })
  return () => from.removeEventListener('abort', forward)
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
    const onAbort = (): void => settle(() => reject(new PhaseAbortError()))
    const fireTimeout = (): void => {
      onTimeout?.()
      settle(() => reject(new PhaseTimeoutError()))
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
      value => settle(() => resolve(value)),
      error => settle(() => reject(error)),
    )
  })
}
