/** Shared types of the continual harness plugin. @module dsh-continual-harness */

export type EntrySnapshot = HarnessEntry

/** Which store a refinement targets. */
export type HarnessScope = 'local' | 'global'

/** What kind of reusable state an entry holds. */
export type RefinementKind = 'prompt' | 'memory' | 'skill' | 'subagent'

/** Which edit an entry undergoes. */
export type RefinementAction = 'create' | 'update' | 'delete'

/** How far an edit's effects may reach beyond the entry itself. */
export type BlastRadius = 'general' | 'project' | 'session'

/** Governance protection a harness entry carries. */
export type Protection = 'bundled' | 'pinned' | 'user-owned'

/** A versioned harness entry. */
export interface HarnessEntry {
  /** Stable identifier, unique within (scope, kind). */
  id: string
  kind: RefinementKind
  /** Version counter, incremented on every applied edit. */
  version: number
  /** Entry content, kind-dependent. */
  content: string
  /** ISO timestamp of the last applied edit. */
  updatedAt: string
  /** Governance protection; absent entries are unprotected. */
  protection?: Protection
  /** Optional single-line title for listing/ranking. */
  title?: string
  /** Provenance and lifecycle metadata (v2). */
  metadata?: {
    /** Trajectory provenance: source session id. */
    sourceSession?: string
    /** MVP lifecycle state; archived entries are hidden from injection. */
    lifecycleState?: 'active' | 'archived'
    /** User lock; field only, no automatic GC in MVP. */
    pinned?: boolean
    /** Last time this entry entered a model-visible overview. */
    lastInjectedAt?: string
  }
}

/** Reusable prompt notes; `base_system_prompt` is immutable and never stored here. */
export interface PromptEntry extends HarnessEntry {
  kind: 'prompt'
}

/** Durable facts, decisions, failures, preferences, outcomes. */
export interface MemoryEntry extends HarnessEntry {
  kind: 'memory'
}

/**
 * A reusable dsh skill. The entry is the versioned source of truth in
 * `harness_state.json`; on every applied edit the effective merged entry is
 * also materialized as a `SKILL.md` bundle under the configured skills
 * directory, where dsh's filesystem skill provider discovers it live.
 */
export interface SkillEntry extends HarnessEntry {
  kind: 'skill'
  /** One-line summary rendered into the SKILL.md frontmatter. */
  description?: string
  /** Legacy execution-contract fields from the pre-file era; kept for state compatibility. */
  reference?: string
  arguments?: string
}

/** A reusable delegation spec. */
export interface SubagentEntry extends HarnessEntry {
  kind: 'subagent'
}

/** One planned edit inside a refinement proposal. */
export interface RefinementEdit {
  action: RefinementAction
  kind: RefinementKind
  id: string
  content?: string
  /** One-line summary; used by `skill` edits as the SKILL.md description. */
  description?: string
  /** Why this edit is made; required for `update`/`delete`, stamped by rollback. */
  reason?: string
  /** How far this edit's effects may reach; defaults to `general` on apply. */
  blastRadius?: BlastRadius
  /** Legacy fields, tolerated for state compatibility. */
  reference?: string
  arguments?: string
  /** Internal lifecycle edit fields; not required in model JSON. */
  archive?: boolean
  pin?: boolean
  title?: string
  metadata?: HarnessEntry['metadata']
  /** Governance protection restored by rollback; not required in model JSON. */
  protection?: Protection
  rollbackDegraded?: boolean
}

/** The model-produced refinement plan. */
export interface RefinementProposal {
  /** Planner-assigned unique id. */
  id: string
  /** One-line summary of the change. */
  summary: string
  edits: RefinementEdit[]
}

/** A single applied edit with its before/after snapshot. */
export interface AppliedRefinementEdit {
  action: RefinementAction
  kind: RefinementKind
  id: string
  /** Content snapshot before the edit; absent for `create`. */
  before?: string
  /** Content snapshot after the edit; absent for `delete`. */
  after?: string
  /** Why this edit was made; `rollback:<id>` for generated rollbacks. */
  reason?: string
  /** How far this edit's effects reach; always present, defaults to `general`. */
  blastRadius: BlastRadius
  /** Set when validation or the baseline conflict check rejected the edit. */
  error?: string
  beforeEntry?: HarnessEntry
  afterEntry?: HarnessEntry
  rollbackDegraded?: boolean
  applied: boolean
}

/** The durable record of one applied refinement. */
export interface RefinementResult {
  id: string
  summary: string
  /** Present when the refinement is itself a rollback of another result. */
  rollbackOf?: string
  appliedEdits: AppliedRefinementEdit[]
  /** ISO timestamp of the commit. */
  committedAt: string
  /** Store the refinement was applied to. */
  scope: HarnessScope
}

/** The full on-disk harness state. */
export interface HarnessState {
  schemaVersion: number
  entries: Record<RefinementKind, Record<string, HarnessEntry>>
  refinements: RefinementResult[]
}

/** Options for planning a refinement. */
export interface RefineOptions {
  stateOverview: string
  historyText: string
  trajectoryText: string
  scopeInstruction: string
  instructions?: string
}

/** Why an automatic refinement pass was triggered. */
export type AutoRefineReason = 'turn-interval' | 'compact' | 'manual'

/** Context handed to the auto-refine review gate. */
export interface AutoRefineReviewContext {
  stateOverview: string
  historyText: string
  trajectoryText: string
  reason: AutoRefineReason
}

/** The review gate verdict. */
export interface AutoRefineReview {
  /** Whether a refinement is warranted. */
  approved: boolean
  /** One-line justification; shown to the model when rejected. */
  rationale: string
}

/** Planner input for an auto-triggered refinement. */
export interface RefinementPlanInput {
  stateOverview: string
  historyText: string
  trajectoryText: string
  scopeInstruction: string
  instructions?: string
}
