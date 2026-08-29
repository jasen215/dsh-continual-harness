import { describe, expect, it } from 'vitest'
import { basename, dirname, join } from 'node:path'
import { uniqueTmpPath } from '../src/fs-safe.ts'

describe('uniqueTmpPath', () => {
  it('returns a same-directory, dot-prefixed, pid-stamped unique sibling', () => {
    const file = join('/data', 'harness', 'harness_state.json')
    const a = uniqueTmpPath(file)
    const b = uniqueTmpPath(file)
    expect(dirname(a)).toBe(dirname(file))
    expect(basename(a)).toMatch(/^\.harness_state\.json\.\d+\.[a-z0-9]+\.tmp$/)
    expect(a).not.toBe(b)
  })
})
