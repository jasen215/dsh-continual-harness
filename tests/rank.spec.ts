import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { buildQueryFromSession, buildStableAnchor, DEFAULT_INDEX_LINES, formatHarnessStateForPromptStructured, queryTerms, STABLE_ANCHOR_NOTE } from '../src/render.ts'
import { freshState } from '../src/refine.ts'

function userText(session: Session, text: string) {
  session.append('user/message', createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }), { surfaceOp: 'append' })
}

describe('query construction', () => {
  it('takes the most recent direct-user message, ignoring harness-state sources', () => {
    const session = Session.create(SessionId('s1'))
    userText(session, 'first question')
    session.append('user/message', createUserMessage({ source: { kind: 'plugin', plugin: 'dsh-continual-harness', form: 'instructions' }, content: [{ type: 'text', text: '<system-reminder>…' }] }), { surfaceOp: 'append' })
    userText(session, 'how do I pin versions?')
    expect(buildQueryFromSession(session)).toBe('how do I pin versions?')
  })
  it('drops empty, pure-punctuation, and ACK-phrase messages and falls back to recency', () => {
    const session = Session.create(SessionId('s2'))
    userText(session, '好的'); userText(session, '   '); userText(session, '!!!')
    expect(buildQueryFromSession(session)).toBe('')
  })
  it('keeps messages with task content even when they contain ACK words', () => {
    const session = Session.create(SessionId('s3')); userText(session, '好的，请继续修复这个 bug')
    expect(buildQueryFromSession(session)).toBe('好的，请继续修复这个 bug')
  })
  it('truncates to MAX_QUERY_CHARS', () => {
    const session = Session.create(SessionId('s4')); userText(session, 'x'.repeat(500))
    expect(buildQueryFromSession(session)?.length).toBe(400)
  })
})

describe('stable anchor', () => {
  function sessionWithCwd(rawId: string, cwd: string) {
    const id = SessionId(rawId)
    return Session.create(id, undefined, {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
      isSeeded: false,
      cwd,
    })
  }

  it('keeps the session opening request, not the latest question', () => {
    const session = sessionWithCwd('a1', '/repo/my/dsh-continual-harness')
    userText(session, 'fix the ranked injection')
    userText(session, '继续')
    userText(session, 'now something else entirely')
    const anchor = buildStableAnchor(session)
    expect(anchor).toContain('fix the ranked injection')
    expect(anchor).not.toContain('now something else entirely')
    expect(anchor).toContain('dsh-continual-harness')
  })

  it('returns the project cwd alone when no message qualifies', () => {
    const session = sessionWithCwd('a2', '/repo/my/dsh-continual-harness')
    userText(session, '好的')
    expect(buildStableAnchor(session)).toBe('/repo/my/dsh-continual-harness')
  })

  it('is empty without a cwd and without a qualifying message', () => {
    const session = Session.create(SessionId('a3'))
    userText(session, '!!!')
    expect(buildStableAnchor(session)).toBe('')
  })

  it('renders a byte-identical overview for the same state however the session advances', () => {
    const state = freshState()
    state.entries.memory.alpha = { id: 'alpha', kind: 'memory', version: 1, content: 'ranking notes', updatedAt: '2026-01-01T00:00:00.000Z' }
    const first = sessionWithCwd('a4', '/repo/my/dsh-continual-harness')
    userText(first, 'fix the ranked injection')
    const before = formatHarnessStateForPromptStructured(state, buildStableAnchor(first), {
      sessionId: 'a4', isLocal: () => false, indexLines: DEFAULT_INDEX_LINES, anchorNote: STABLE_ANCHOR_NOTE,
    }).overview
    userText(first, 'a totally unrelated follow-up about docker')
    const after = formatHarnessStateForPromptStructured(state, buildStableAnchor(first), {
      sessionId: 'a4', isLocal: () => false, indexLines: DEFAULT_INDEX_LINES, anchorNote: STABLE_ANCHOR_NOTE,
    }).overview
    expect(after).toBe(before)
  })

  it('index mode trades entry content for capped id lines', () => {
    const state = freshState()
    for (let index = 0; index < 20; index += 1) {
      const id = `entry-${String(index).padStart(2, '0')}`
      state.entries.memory[id] = { id, kind: 'memory', version: index + 1, content: 'SECRETBODY ranking notes', updatedAt: '2026-01-01T00:00:00.000Z' }
    }
    const rendered = formatHarnessStateForPromptStructured(state, 'ranking notes', {
      sessionId: 'x', isLocal: () => false, indexLines: DEFAULT_INDEX_LINES, anchorNote: STABLE_ANCHOR_NOTE,
    })
    expect(rendered.overview).toContain('## memory (20)')
    expect(rendered.overview).toContain('## index (20 entries, top 15)')
    expect(rendered.overview).toContain('- memory/entry-00 v1')
    expect(rendered.overview).toContain('- … 5 more')
    expect(rendered.overview).not.toContain('SECRETBODY')
    expect(rendered.injectedKeys).toHaveLength(15)
    // The full-content path still carries bodies; the mode is opt-in.
    const full = formatHarnessStateForPromptStructured(state, 'ranking notes', { sessionId: 'x', isLocal: () => false })
    expect(full.overview).toContain('SECRETBODY')
  })

  it('orders the index by project ownership, then relevance', () => {
    const state = freshState()
    // Same recency for all three: only ownership and match score may decide.
    state.entries.memory.foreign = { id: 'foreign', kind: 'memory', version: 1, content: 'ranking notes', projects: ['other-repo'], updatedAt: '2026-01-01T00:00:00.000Z' }
    state.entries.memory.agnostic = { id: 'agnostic', kind: 'memory', version: 1, content: 'ranking notes', updatedAt: '2026-01-01T00:00:00.000Z' }
    state.entries.memory.mine = { id: 'mine', kind: 'memory', version: 1, content: 'unrelated body', projects: ['dsh-continual-harness'], updatedAt: '2026-01-01T00:00:00.000Z' }
    const rendered = formatHarnessStateForPromptStructured(state, 'ranking notes', {
      sessionId: 'x', isLocal: () => false, indexLines: DEFAULT_INDEX_LINES, project: 'dsh-continual-harness',
    })
    const order = rendered.injectedKeys.map(key => key.split(':').at(-1))
    // `mine` matches no term yet leads: ownership is information the text lacks.
    // `foreign` matched a term and still trails: another project's entry must not
    // be able to displace this project's context on relevance alone.
    expect(order).toEqual(['mine', 'agnostic', 'foreign'])
  })

  it('ranks a foreign-tagged entry below an untagged one but never drops it', () => {
    const state = freshState()
    state.entries.memory.foreign = { id: 'foreign', kind: 'memory', version: 1, content: 'deeply relevant ranking notes', projects: ['other-repo'], updatedAt: '2026-01-01T00:00:00.000Z' }
    state.entries.memory.agnostic = { id: 'agnostic', kind: 'memory', version: 1, content: 'filler', updatedAt: '2026-01-01T00:00:00.000Z' }
    const rendered = formatHarnessStateForPromptStructured(state, 'ranking notes', {
      sessionId: 'x', isLocal: () => false, indexLines: DEFAULT_INDEX_LINES, project: 'dsh-continual-harness',
    })
    // A rank, not a filter: a mis-tagged or cross-project entry stays reachable.
    expect(rendered.injectedKeys.map(key => key.split(':').at(-1))).toEqual(['agnostic', 'foreign'])
  })

  it('says so when the anchor matched nothing, instead of presenting recency as a ranking', () => {
    const state = freshState()
    state.entries.memory.alpha = { id: 'alpha', kind: 'memory', version: 1, content: 'ranking notes', updatedAt: '2026-01-01T00:00:00.000Z' }
    const ranked = formatHarnessStateForPromptStructured(state, 'ranking notes', { sessionId: 'x', isLocal: () => false, indexLines: DEFAULT_INDEX_LINES })
    expect(ranked.overview).not.toContain('anchor matched no entry')
    const unranked = formatHarnessStateForPromptStructured(state, 'zzz nothing here', { sessionId: 'x', isLocal: () => false, indexLines: DEFAULT_INDEX_LINES })
    expect(unranked.overview).toContain('anchor matched no entry')
  })
})

describe('ranked injection', () => {
  function withEntries(overrides: Array<[string, Partial<import('../src/types.ts').HarnessEntry>]>) {
    const state = freshState()
    for (const [id, patch] of overrides) state.entries.memory[id] = { id, kind: 'memory', version: 1, content: 'default', updatedAt: '2026-01-01T00:00:00.000Z', ...patch }
    return state
  }
  /** Neutral filler that keeps a corpus large enough for its terms to stay discriminative. */
  function pad(state: ReturnType<typeof freshState>, count: number) {
    for (let index = 0; index < count; index += 1) {
      const id = `pad-${index}`
      state.entries.memory[id] = { id, kind: 'memory', version: 1, content: 'filler entry', updatedAt: '2025-12-01T00:00:00.000Z' }
    }
    return state
  }
  it('ranks title hits over content hits, then updatedAt desc, then id asc', () => {
    // Why: recency must not be what puts the title hit first — c is the newer one,
    // so the title weight has to do the work. The corpus is padded because a term
    // shared with a large share of it carries no discriminative power.
    const state = pad(withEntries([['b', { title: 'pin versions', updatedAt: '2026-01-02T00:00:00.000Z' }], ['c', { content: 'pin versions please', updatedAt: '2026-01-03T00:00:00.000Z' }], ['a', { content: 'unrelated', updatedAt: '2026-01-01T00:00:00.000Z' }]]), 17)
    expect(formatHarnessStateForPromptStructured(state, 'pin versions', { sessionId: 's1', maxPerKind: 3, isLocal: () => true }).injectedKeys).toEqual(['local:s1:memory:b', 'local:s1:memory:c', 'local:s1:memory:a'])
  })
  it('emits global keys for entries not shadowed by the local store', () => {
    const state = withEntries([['shared', { content: 'cross-session', updatedAt: '2026-01-02T00:00:00.000Z' }]])
    expect(formatHarnessStateForPromptStructured(state, 'cross', { sessionId: 's1', maxPerKind: 6, isLocal: () => false }).injectedKeys).toEqual(['global:memory:shared'])
  })
  it('excludes archived and shadowed (local:-prefixed) entries from injection', () => {
    const state = pad(withEntries([['keep', { content: 'relevant keep', updatedAt: '2026-01-04T00:00:00.000Z' }], ['gone', { metadata: { lifecycleState: 'archived' }, updatedAt: '2026-01-05T00:00:00.000Z' }]]), 17)
    state.entries.memory['local:shadowed-global'] = { id: 'shadowed-global', kind: 'memory', version: 1, content: 'global dup', updatedAt: '2026-01-06T00:00:00.000Z' }
    expect(formatHarnessStateForPromptStructured(state, 'relevant', { sessionId: 's1', maxPerKind: 1, isLocal: () => true }).injectedKeys).toEqual(['local:s1:memory:keep'])
  })
  it('caps per kind and falls back to pure recency on empty query', () => {
    const state = withEntries([['a', { updatedAt: '2026-01-01T00:00:00.000Z' }], ['b', { updatedAt: '2026-01-02T00:00:00.000Z' }], ['c', { updatedAt: '2026-01-03T00:00:00.000Z' }], ['d', { updatedAt: '2026-01-04T00:00:00.000Z' }]])
    expect(formatHarnessStateForPromptStructured(state, '', { sessionId: 's1', maxPerKind: 3, isLocal: () => true }).injectedKeys).toEqual(['local:s1:memory:d', 'local:s1:memory:c', 'local:s1:memory:b'])
  })
  it('overview contains exactly the injected entries', () => {
    const state = withEntries([['a', { content: 'pin versions', updatedAt: '2026-01-01T00:00:00.000Z' }], ['b', { content: 'other', updatedAt: '2026-01-02T00:00:00.000Z' }]])
    const result = formatHarnessStateForPromptStructured(state, 'pin', { sessionId: 's1', maxPerKind: 1, isLocal: () => true })
    expect(result.overview).toContain('- a v1: pin versions'); expect(result.overview).not.toContain('- b v1: other'); expect(result.injectedKeys).toEqual(['local:s1:memory:a'])
  })
  it('recalls a Chinese entry from a sentence query that never contains it verbatim', () => {
    // Why: the query is a whole user message, so whole-query containment scored
    // zero hits and the oldest-but-relevant entry became unreachable behind the
    // per-kind cap — injection silently degenerated to recency.
    const state = withEntries([
      ['zh-retrieval', { content: '端侧语义检索用在注入召回里，注意长句查询的命中问题。', updatedAt: '2026-01-01T00:00:00.000Z' }],
      ...['n1', 'n2', 'n3', 'n4', 'n5', 'n6'].map((id, index) => [id, { content: `unrelated note ${id}`, updatedAt: `2026-01-0${index + 2}T00:00:00.000Z` }] as [string, { content: string; updatedAt: string }]),
    ])
    const { injectedKeys } = formatHarnessStateForPromptStructured(state, '这篇微信文章讲的端侧向量检索对本项目的注入召回有用吗', { sessionId: 's1', maxPerKind: 6, isLocal: () => true })
    expect(injectedKeys[0]).toBe('local:s1:memory:zh-retrieval')
  })
  it('ranks by how many query terms match, not by recency', () => {
    // Why: recency as the primary signal buries older experience that the current
    // task actually shares several terms with.
    const state = withEntries([
      ['older-strong', { content: '排序打分的权重需要修复', updatedAt: '2026-01-01T00:00:00.000Z' }],
      ['newer-weak', { content: '排序说明', updatedAt: '2026-01-09T00:00:00.000Z' }],
    ])
    const { injectedKeys } = formatHarnessStateForPromptStructured(state, '修复排序打分', { sessionId: 's1', maxPerKind: 6, isLocal: () => true })
    expect(injectedKeys).toEqual(['local:s1:memory:older-strong', 'local:s1:memory:newer-weak'])
  })
  it('recalls an English entry from a full-sentence query', () => {
    const state = withEntries([
      ['pinning', { title: 'pin versions', updatedAt: '2026-01-01T00:00:00.000Z' }],
      ['newer-noise', { content: 'unrelated release note', updatedAt: '2026-01-09T00:00:00.000Z' }],
    ])
    const { injectedKeys } = formatHarnessStateForPromptStructured(state, 'How do I pin versions in this project?', { sessionId: 's1', maxPerKind: 6, isLocal: () => true })
    expect(injectedKeys[0]).toBe('local:s1:memory:pinning')
  })
  it('drops corpus-generic terms so generic phrasing cannot promote unrelated entries', () => {
    // Why: a real question in Chinese ("how should this X question be handled?")
    // shares its generic words for "this", "question" and "handle" with unrelated
    // entries. Counting those matches put the newest noise in front of the single
    // entry the query actually named.
    const noise = ['n1', 'n2', 'n3', 'n4', 'n5'].map((id, index) => [id, { content: '这是问题，需要处理', updatedAt: `2026-02-0${index + 1}T00:00:00.000Z` }] as [string, { content: string; updatedAt: string }])
    const state = pad(withEntries([['zzzanchor', { content: 'zzzanchor procedure', updatedAt: '2026-01-01T00:00:00.000Z' }], ...noise]), 14)
    const { injectedKeys } = formatHarnessStateForPromptStructured(state, '关于 zzzanchor这个问题该怎么处理？', { sessionId: 's1', maxPerKind: 6, isLocal: () => true })
    expect(injectedKeys[0]).toBe('local:s1:memory:zzzanchor')
  })
  it('never drops a term that is unique in the corpus', () => {
    // Why: the share-based guard must not degenerate on a small corpus — a term
    // exactly one entry has is discriminative by definition.
    const state = withEntries([
      ['only-one', { content: 'zzzunique marker', updatedAt: '2026-01-01T00:00:00.000Z' }],
      ['other', { content: 'filler entry', updatedAt: '2026-01-09T00:00:00.000Z' }],
    ])
    const { injectedKeys } = formatHarnessStateForPromptStructured(state, 'zzzunique', { sessionId: 's1', maxPerKind: 1, isLocal: () => true })
    expect(injectedKeys).toEqual(['local:s1:memory:only-one'])
  })
  it('ranks a rarer matched term above a more common one', () => {
    // Why: two entries that match one term each are not equally relevant — the one
    // whose term is more distinctive wins even when it is the older entry.
    const state = pad(withEntries([
      ['rare-term', { content: 'zzzrare marker', updatedAt: '2026-01-01T00:00:00.000Z' }],
      ['common-term', { content: 'midterm marker', updatedAt: '2026-01-09T00:00:00.000Z' }],
      ['shares-midterm', { content: 'midterm appears here too', updatedAt: '2025-12-20T00:00:00.000Z' }],
    ]), 17)
    const { injectedKeys } = formatHarnessStateForPromptStructured(state, 'zzzrare midterm', { sessionId: 's1', maxPerKind: 2, isLocal: () => true })
    expect(injectedKeys).toEqual(['local:s1:memory:rare-term', 'local:s1:memory:common-term'])
  })
  it('keeps corpus-wide terms when the query has no rarer term to fall back on', () => {
    // Why: a query that is only a hub word ("hermes") carries no distinctive
    // evidence. Dropping it would score every entry 0, silently degrading the
    // ranking to recency — the newest unrelated entry wins instead of the three
    // entries the query actually names.
    const state = pad(withEntries([
      ['hermes-target', { content: 'hermes adapter notes', updatedAt: '2026-02-01T00:00:00.000Z' }],
      ['hermes-other-1', { content: 'hermes gateway notes', updatedAt: '2026-01-01T00:00:00.000Z' }],
      ['hermes-other-2', { content: 'hermes launchd notes', updatedAt: '2026-01-15T00:00:00.000Z' }],
      ['unrelated-newest', { content: 'unrelated recent note', updatedAt: '2026-03-01T00:00:00.000Z' }],
    ]), 16)
    const { injectedKeys } = formatHarnessStateForPromptStructured(state, 'hermes', { sessionId: 's1', maxPerKind: 1, isLocal: () => true })
    expect(injectedKeys).toEqual(['local:s1:memory:hermes-target'])
  })
})

describe('query terms', () => {
  it('drops single latin characters and shingles CJK runs into bigrams', () => {
    expect(queryTerms('fix a bug')).toEqual(['fix', 'bug'])
    expect(queryTerms('检索排序')).toEqual(['检索', '索排', '排序'])
    expect(queryTerms('好')).toEqual(['好'])
    expect(queryTerms('!!!')).toEqual([])
  })
  it('keeps a latin term from swallowing the CJK characters glued to it', () => {
    // Why: Chinese messages routinely glue a latin term to Chinese with no space.
    // Han characters are \p{L}, so a naive latin run would swallow them and
    // shingle the mixed run into junk terms that then match unrelated English
    // content.
    expect(queryTerms('Hermes配置怎么写')).toEqual(['hermes', '配置', '置怎', '怎么', '么写'])
  })
})

describe('formatHarnessStateForPromptStructured files key list', () => {
  it('renders files keys without their contents', () => {
    const state = freshState()
    state.entries.skill['oq-gen'] = {
      id: 'oq-gen', kind: 'skill', version: 1,
      content: '## Steps', description: 'quantize',
      files: { 'scripts/oq_quantize.py': 'print(1)', 'references/t.md': '# t' },
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const { overview } = formatHarnessStateForPromptStructured(state, '', {
      sessionId: 's1', maxPerKind: 6, isLocal: () => false,
    })
    expect(overview).toContain('files: scripts/oq_quantize.py, references/t.md')
    expect(overview).not.toContain('print(1)')
  })
})
