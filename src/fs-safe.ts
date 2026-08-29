/**
 * Shared filesystem safety helpers for the plugin's atomic state writes.
 * @module dsh-continual-harness
 */

import { basename, dirname, join } from 'node:path'

/**
 * A unique sibling temp path for `file`: same directory (so the later rename
 * stays atomic on one filesystem), dot-prefixed basename, pid + random
 * segment. Concurrency never collides on a fixed `.tmp` name, and a crashed
 * write leaves a recognizable orphan instead of a fixed-name file another
 * writer could publish half-written (spec FS-1).
 */
export function uniqueTmpPath(file: string): string {
  return join(dirname(file), `.${basename(file)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`)
}
