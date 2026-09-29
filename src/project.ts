/**
 * Project tagging: the repository a refinement was applied in.
 *
 * The tag is derived from the session's creation cwd rather than asked of the
 * model — a project name is a *fact*, determined by where the session ran, so
 * deriving it cannot drift and needs no judgement (the model's 0-of-73 fill
 * rate for the comparable `title` field is corroborating evidence, not the
 * argument). Derivation is also why this module is separate: it is the only
 * part of ranking that touches the filesystem, so it stays unit-testable alone.
 *
 * DSH already knows a better answer than any walk-up can produce: Workspaces are
 * the user's own project units, and the registry associates a session with one
 * by canonical cwd. So the workspace's directory wins when it is known, and the
 * repository walk-up below is the fallback for providerless or unregistered
 * sessions.
 * @module dsh-continual-harness
 */

import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * The part of `ctx.workspaceRegistry` this plugin consumes. Structural on
 * purpose: the harness does not depend on `@deepseek-ai/dsh-workspace`, and a
 * deployment without Workspaces must simply fall through to the cwd walk.
 */
export interface WorkspaceRegistryLike {
  list(): ReadonlyArray<{ readonly path: string; readonly sessionIds: readonly unknown[] }>
}

/** Canonical directory of the Workspace accounting `sessionId`, if any. */
export function workspacePathFor(registry: WorkspaceRegistryLike, sessionId: string): string | undefined {
  return registry.list().find(workspace => workspace.sessionIds.includes(sessionId))?.path
}

/**
 * Tag for the project work is happening in: the accounting Workspace's directory
 * name when DSH has one, else the basename of the nearest ancestor holding a
 * `.git` entry — so a session started in `repo/src` still tags `repo`. Falls
 * back to the cwd basename outside a repository, and to undefined when there is
 * no usable name at all.
 *
 * The Workspace's path is used rather than its title: titles are user-facing and
 * mutable (`setTitle`), and a renamed project would orphan every entry tagged
 * with the old name, which ranks it below a project-agnostic one.
 */
export function projectTagFor(cwd: string | undefined, workspacePath?: string): string | undefined {
  if (workspacePath !== undefined) return directoryName(workspacePath)
  if (cwd === undefined || cwd === '') return undefined
  let current = cwd
  for (;;) {
    if (existsSync(join(current, '.git'))) return directoryName(current)
    const parent = dirname(current)
    if (parent === current) return directoryName(cwd)
    current = parent
  }
}

/** Final path segment, or undefined when a path has no name of its own. */
export function directoryName(path: string): string | undefined {
  const name = basename(path)
  return name === '' || name === '/' ? undefined : name
}
