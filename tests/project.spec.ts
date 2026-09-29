import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { projectTagFor, workspacePathFor } from '../src/project.ts'

const created: string[] = []

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-project-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('project tagging', () => {
  it('names the repository root, so a session started in a subdirectory still tags its repo', () => {
    const root = sandbox()
    mkdirSync(join(root, 'dsh-continual-harness', '.git'), { recursive: true })
    const deep = join(root, 'dsh-continual-harness', 'src', 'render')
    mkdirSync(deep, { recursive: true })
    expect(projectTagFor(deep)).toBe('dsh-continual-harness')
  })

  it('treats a .git file (worktree/submodule) as a repository root too', () => {
    const root = sandbox()
    mkdirSync(join(root, 'linked-worktree'), { recursive: true })
    writeFileSync(join(root, 'linked-worktree', '.git'), 'gitdir: /elsewhere/.git/worktrees/linked\n')
    expect(projectTagFor(join(root, 'linked-worktree'))).toBe('linked-worktree')
  })

  it('falls back to the directory name outside any repository', () => {
    const root = sandbox()
    const loose = join(root, 'loose-notes')
    mkdirSync(loose, { recursive: true })
    expect(projectTagFor(loose)).toBe('loose-notes')
  })

  it('has no tag without a usable cwd, so callers stamp nothing rather than a wrong project', () => {
    expect(projectTagFor(undefined)).toBeUndefined()
    expect(projectTagFor('')).toBeUndefined()
    expect(projectTagFor('/')).toBeUndefined()
  })

  it('prefers the Workspace DSH accounts the session to, even when a repo sits deeper', () => {
    const root = sandbox()
    // The user registered `monorepo` as their project; the session sits in a
    // nested repository. The user's own unit wins over the walk-up's guess.
    const workspacePath = join(root, 'monorepo')
    const nestedRepo = join(workspacePath, 'packages', 'app')
    mkdirSync(join(nestedRepo, '.git'), { recursive: true })
    expect(projectTagFor(nestedRepo)).toBe('app')
    expect(projectTagFor(nestedRepo, workspacePath)).toBe('monorepo')
  })

  it('finds the workspace by session, not by position', () => {
    const other = { path: '/somewhere/other-repo', sessionIds: ['s-other'] }
    const registry = { list: () => [other, { path: '/somewhere/mine', sessionIds: ['s-1', 's-2'] }] }
    expect(workspacePathFor(registry, 's-2')).toBe('/somewhere/mine')
    expect(workspacePathFor(registry, 's-unknown')).toBeUndefined()
  })
})
