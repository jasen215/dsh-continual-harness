import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseFrontmatterName,
  reconcileSkillFiles,
  defaultSkillFsOps,
  referencedFilePaths,
  type SkillFsOps,
  renderSkillMarkdown,
  validateBundleFiles,
  validateSkillBundle,
} from '../src/skills.ts'
import type { HarnessEntry } from '../src/types.ts'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-skills-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function skillEntry(id: string, content: string, description?: string): HarnessEntry {
  return {
    id,
    kind: 'skill',
    version: 1,
    content,
    ...(description === undefined ? {} : { description }),
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('renderSkillMarkdown', () => {
  it('renders the dsh SKILL.md bundle: name + description frontmatter and verbatim body', () => {
    const markdown = renderSkillMarkdown(skillEntry('repro', '## Steps\n1. Run `pnpm test`\n2. Read the failure', 'Reproduce a bug fast'))
    expect(markdown).toContain('---\nname: repro\ndescription: "Reproduce a bug fast"\nmetadata:')
    expect(markdown).toContain('## Steps\n1. Run `pnpm test`\n2. Read the failure')
  })

  it('stamps the provenance metadata block (author + esp source)', () => {
    const markdown = renderSkillMarkdown(skillEntry('repro', 'body', 'summary'))
    expect(markdown).toContain('metadata:\n  author: dsh-continual-harness\n  source: esp')
  })

  it('falls back to the first line of the body when description is missing', () => {
    const markdown = renderSkillMarkdown(skillEntry('repro', 'Reproduce a bug fast\n\nLonger body.'))
    expect(markdown).toContain('description: "Reproduce a bug fast"')
  })

  it('flattens multi-line descriptions and caps their length', () => {
    const markdown = renderSkillMarkdown(skillEntry('repro', 'body', 'line one\nline two'))
    expect(markdown).toContain('description: "line one line two"')
    const long = renderSkillMarkdown(skillEntry('repro', 'body', 'x'.repeat(300)))
    expect(long).toContain(`description: "${'x'.repeat(200)}…"`)
  })

  it('escapes colons, hashes, and quotes as a double-quoted YAML scalar', () => {
    const markdown = renderSkillMarkdown(skillEntry('repro', 'body', 'Note: always repro — #1 priority "now"'))
    expect(markdown).toContain('description: "Note: always repro — #1 priority \\"now\\""')
    // a leading special character must not change the scalar's type
    const leading = renderSkillMarkdown(skillEntry('repro', 'body', '{not a map}'))
    expect(leading).toContain('description: "{not a map}"')
  })
})

describe('reconcileSkillFiles', () => {
  it('writes a SKILL.md bundle for each touched id with an effective entry', () => {
    const dir = tempDir()
    const result = reconcileSkillFiles(dir, { repro: skillEntry('repro', 'body', 'summary') }, ['repro'])
    expect(result.written).toEqual([join(dir, 'repro', 'SKILL.md')])
    expect(result.status).toBe('completed')
    expect(readFileSync(join(dir, 'repro', 'SKILL.md'), 'utf8')).toContain('name: repro')
  })

  it('removes a harness-owned bundle directory for a touched id with no effective entry', () => {
    const dir = tempDir()
    reconcileSkillFiles(dir, { repro: skillEntry('repro', 'body') }, ['repro'])
    expect(existsSync(join(dir, 'repro', 'SKILL.md'))).toBe(true)
    const removed = reconcileSkillFiles(dir, {}, ['repro'])
    expect(removed.status).toBe('completed')
    expect(existsSync(join(dir, 'repro'))).toBe(false)
  })

  it('never writes or removes ids outside touchedIds, and skips non-kebab ids', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'mine'), { recursive: true })
    writeFileSync(join(dir, 'mine', 'SKILL.md'), '---\nname: mine\n---\nuser skill')
    const result = reconcileSkillFiles(dir, {
      mine: skillEntry('mine', 'user'),
      'Not Kebab': skillEntry('Not Kebab', 'bad'),
    }, ['Not Kebab'])
    expect(result.written).toEqual([])
    expect(readFileSync(join(dir, 'mine', 'SKILL.md'), 'utf8')).toBe('---\nname: mine\n---\nuser skill')
  })

  it('skips rewriting when the file already matches', () => {
    const dir = tempDir()
    reconcileSkillFiles(dir, { repro: skillEntry('repro', 'body') }, ['repro'])
    const file = join(dir, 'repro', 'SKILL.md')
    const mtime = readFileSync(file, 'utf8')
    const again = reconcileSkillFiles(dir, { repro: skillEntry('repro', 'body') }, ['repro'])
    expect(again.written).toEqual([])
    expect(again.unchanged).toEqual([file])
    expect(readFileSync(file, 'utf8')).toBe(mtime)
  })
})

describe('reconcileSkillFiles (bundle files, ownership, stale, faults)', () => {
  const entry = (id: string, files?: Record<string, string>, content = '## Steps\n1. run `scripts/x.py`') =>
    ({
      ...skillEntry(id, content, 'Use whenever x'),
      ...(files === undefined ? {} : { files }),
    }) as ReturnType<typeof skillEntry> & { files?: Record<string, string> }

  it('materializes SKILL.md plus every files entry under the right subdirectories', () => {
    const dir = tempDir()
    const result = reconcileSkillFiles(dir, {
      oq: entry('oq', { 'scripts/oq_quantize.py': 'print(1)', 'references/template.md': '# t' }),
    }, ['oq'])
    expect(result.status).toBe('completed')
    expect(result.written).toEqual([
      join(dir, 'oq', 'SKILL.md'),
      join(dir, 'oq', 'scripts', 'oq_quantize.py'),
      join(dir, 'oq', 'references', 'template.md'),
    ])
    expect(readFileSync(join(dir, 'oq', 'scripts', 'oq_quantize.py'), 'utf8')).toBe('print(1)')
  })

  it('replaces changed files, keeps unchanged ones, and deletes stale files from owned bundles', () => {
    const dir = tempDir()
    reconcileSkillFiles(dir, { oq: entry('oq', { 'scripts/oq_quantize.py': 'v1' }) }, ['oq'])
    writeFileSync(join(dir, 'oq', 'extra.md'), 'user file')
    const result = reconcileSkillFiles(dir, { oq: entry('oq', { 'scripts/oq_quantize.py': 'v2' }) }, ['oq'])
    expect(readFileSync(join(dir, 'oq', 'scripts', 'oq_quantize.py'), 'utf8')).toBe('v2')
    expect(result.written).toEqual([join(dir, 'oq', 'scripts', 'oq_quantize.py')])
    expect(result.removed).toEqual([join(dir, 'oq', 'extra.md')])
    expect(existsSync(join(dir, 'oq', 'extra.md'))).toBe(false)
  })

  it('removes empty parent directories after deleting stale files, never the bundle root', () => {
    const dir = tempDir()
    reconcileSkillFiles(dir, { oq: entry('oq') }, ['oq'])
    mkdirSync(join(dir, 'oq', 'deep', 'nest'), { recursive: true })
    writeFileSync(join(dir, 'oq', 'deep', 'nest', 'stale.txt'), 'x')

    const result = reconcileSkillFiles(dir, { oq: entry('oq') }, ['oq'])

    expect(result.removed).toEqual([join(dir, 'oq', 'deep', 'nest', 'stale.txt')])
    expect(existsSync(join(dir, 'oq', 'deep'))).toBe(false)
    expect(existsSync(join(dir, 'oq', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(dir, 'oq'))).toBe(true)
  })

  it('keeps the file and reports remove-failed when deletion fails, continuing other files', () => {
    const dir = tempDir()
    reconcileSkillFiles(dir, { oq: entry('oq', { 'scripts/a.py': 'a' }) }, ['oq'])
    writeFileSync(join(dir, 'oq', 'extra1.md'), 'x')
    writeFileSync(join(dir, 'oq', 'extra2.md'), 'y')
    const failing: SkillFsOps = {
      ...defaultSkillFsOps,
      rmSync(path) {
        if (path.endsWith('extra1.md')) throw new Error('permission denied')
        defaultSkillFsOps.rmSync(path)
      },
    }
    const result = reconcileSkillFiles(dir, { oq: entry('oq', { 'scripts/a.py': 'a' }) }, ['oq'], failing)
    expect(existsSync(join(dir, 'oq', 'extra1.md'))).toBe(true)
    expect(existsSync(join(dir, 'oq', 'extra2.md'))).toBe(false)
    expect(result.removed).toEqual([join(dir, 'oq', 'extra2.md')])
    expect(result.errors.some(error => error.code === 'remove-failed' && error.retryable === true)).toBe(true)
  })

  it('skips a bundle whose existing SKILL.md lacks harness provenance', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'mine'), { recursive: true })
    writeFileSync(join(dir, 'mine', 'SKILL.md'), '---\nname: mine\n---\nuser skill')
    const result = reconcileSkillFiles(dir, { mine: entry('mine', { 'scripts/x.py': 'x' }) }, ['mine'])
    expect(result.written).toEqual([])
    expect(result.skipped).toEqual([join(dir, 'mine')])
    expect(result.errors.some(error => error.code === 'not-harness-owned')).toBe(true)
    expect(result.status).toBe('partial')
    expect(readFileSync(join(dir, 'mine', 'SKILL.md'), 'utf8')).toBe('---\nname: mine\n---\nuser skill')
  })

  it('skips an existing directory without SKILL.md instead of adopting it', () => {
    const dir = tempDir()
    const bundle = join(dir, 'mine')
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(bundle, 'user.txt'), 'user file')
    const result = reconcileSkillFiles(dir, {
      mine: entry('mine', { 'scripts/x.py': 'x' }),
    }, ['mine'])
    expect(result.skipped).toEqual([bundle])
    expect(result.errors.some(error => error.code === 'not-harness-owned' && error.retryable === false)).toBe(true)
    expect(result.status).toBe('partial')
    expect(readFileSync(join(bundle, 'user.txt'), 'utf8')).toBe('user file')
    expect(existsSync(join(bundle, 'scripts'))).toBe(false)
  })

  it('skips an existing empty directory instead of adopting it', () => {
    const dir = tempDir()
    const bundle = join(dir, 'empty')
    mkdirSync(bundle, { recursive: true })
    const result = reconcileSkillFiles(dir, {
      empty: entry('empty', { 'scripts/x.py': 'x' }),
    }, ['empty'])
    expect(result.skipped).toEqual([bundle])
    expect(result.errors.some(error => error.code === 'not-harness-owned')).toBe(true)
    expect(result.status).toBe('partial')
    expect(existsSync(join(bundle, 'SKILL.md'))).toBe(false)
    expect(existsSync(join(bundle, 'scripts'))).toBe(false)
  })

  it('does not delete a non-harness-owned bundle on delete/archive', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'mine'), { recursive: true })
    writeFileSync(join(dir, 'mine', 'SKILL.md'), '---\nname: mine\n---\nuser skill')
    const result = reconcileSkillFiles(dir, {}, ['mine'])
    expect(result.skipped).toEqual([join(dir, 'mine')])
    expect(existsSync(join(dir, 'mine', 'SKILL.md'))).toBe(true)
  })

  it('collects write faults and reports partial/failed status (injected fs fault)', () => {
    const dir = tempDir()
    const base = defaultSkillFsOps
    const failing: SkillFsOps = {
      ...base,
      writeFileSync(path, data, encoding) {
        if (path.includes('oq_quantize.py')) throw new Error('disk full')
        base.writeFileSync(path, data, encoding)
      },
    }
    const result = reconcileSkillFiles(dir, {
      oq: entry('oq', { 'scripts/oq_quantize.py': 'x', 'references/t.md': '# t' }),
    }, ['oq'], failing)
    expect(result.status).toBe('partial')
    expect(result.written.some(path => path.endsWith('SKILL.md'))).toBe(true)
    expect(result.errors.some(error => error.code === 'write-failed' && error.retryable === true)).toBe(true)
    expect(existsSync(join(dir, 'oq', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(dir, 'oq', 'scripts', 'oq_quantize.py'))).toBe(false)

    const allFail: SkillFsOps = { ...base, writeFileSync: () => { throw new Error('read-only') } }
    const failedDir = tempDir()
    const failed = reconcileSkillFiles(failedDir, { oq: entry('oq', { 'scripts/x.py': 'x' }) }, ['oq'], allFail)
    expect(failed.status).toBe('failed')
  })

  it('counts unchanged files as successful when another touched file fails', () => {
    const dir = tempDir()
    const initial = { oq: entry('oq', { 'scripts/stable.py': 'v1', 'scripts/fault.py': 'v1' }) }
    reconcileSkillFiles(dir, initial, ['oq'])
    const failing: SkillFsOps = {
      ...defaultSkillFsOps,
      writeFileSync(path, data, encoding) {
        if (path.endsWith('fault.py.tmp')) throw new Error('disk full')
        defaultSkillFsOps.writeFileSync(path, data, encoding)
      },
    }
    const result = reconcileSkillFiles(dir, {
      oq: entry('oq', { 'scripts/stable.py': 'v1', 'scripts/fault.py': 'v2' }),
    }, ['oq'], failing)
    expect(result.status).toBe('partial')
    expect(result.unchanged).toContain(join(dir, 'oq', 'scripts', 'stable.py'))
    expect(result.errors.some(error => error.code === 'write-failed')).toBe(true)
  })

  it('counts a successful removal as success when another operation fails (partial)', () => {
    const dir = tempDir()
    reconcileSkillFiles(dir, { gone: entry('gone', { 'scripts/x.py': 'x' }) }, ['gone'])
    const failing: SkillFsOps = {
      ...defaultSkillFsOps,
      writeFileSync(path, data, encoding) {
        if (path.includes('fail')) throw new Error('disk full')
        defaultSkillFsOps.writeFileSync(path, data, encoding)
      },
    }
    const result = reconcileSkillFiles(dir, {
      fail: entry('fail', { 'scripts/x.py': 'x' }),
    }, ['gone', 'fail'], failing)
    expect(existsSync(join(dir, 'gone'))).toBe(false)
    expect(result.status).toBe('partial')
    expect(result.errors.some(error => error.code === 'write-failed')).toBe(true)
  })

  it('skips a delete whose bundle path is a regular file', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'odd'), 'not a directory')
    const result = reconcileSkillFiles(dir, {}, ['odd'])
    expect(result.skipped).toEqual([join(dir, 'odd')])
    expect(result.errors.some(error => error.code === 'not-a-directory' && error.retryable === true)).toBe(true)
    expect(result.status).toBe('partial')
    expect(readFileSync(join(dir, 'odd'), 'utf8')).toBe('not a directory')
  })

  it('removes a temporary file when an atomic rename fails', () => {
    const dir = tempDir()
    const failing: SkillFsOps = {
      ...defaultSkillFsOps,
      renameSync: () => { throw new Error('rename failed') },
    }
    const result = reconcileSkillFiles(dir, { oq: entry('oq', { 'scripts/fault.py': 'x' }) }, ['oq'], failing)
    const file = join(dir, 'oq', 'scripts', 'fault.py')
    expect(result.errors.some(error => error.code === 'write-failed')).toBe(true)
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it('skips a regular-file bundle path and continues processing other touched ids', () => {
    const dir = tempDir()
    const bundle = join(dir, 'bad')
    writeFileSync(bundle, 'not a directory')
    const result = reconcileSkillFiles(dir, {
      bad: entry('bad'),
      good: entry('good'),
    }, ['bad', 'good'])
    expect(result.status).toBe('partial')
    expect(result.skipped).toContain(bundle)
    expect(result.errors.some(error => error.path === bundle && error.code === 'not-a-directory' && error.retryable === true)).toBe(true)
    expect(result.written).toContain(join(dir, 'good', 'SKILL.md'))
  })

  it('skips symlink files and symlink dirs during discovery (lstat, no follow)', () => {
    const dir = tempDir()
    reconcileSkillFiles(dir, { oq: entry('oq', { 'scripts/x.py': 'x' }) }, ['oq'])
    // target outside the bundle; a symlink inside the bundle points at it
    writeFileSync(join(dir, 'outside.txt'), 'outside')
    symlinkSync(join(dir, 'outside.txt'), join(dir, 'oq', 'link.txt'))
    mkdirSync(join(dir, 'extdir'), { recursive: true })
    writeFileSync(join(dir, 'extdir', 'nested.txt'), 'nested')
    symlinkSync(join(dir, 'extdir'), join(dir, 'oq', 'linkdir'))

    const result = reconcileSkillFiles(dir, { oq: entry('oq', { 'scripts/x.py': 'x' }) }, ['oq'])

    // symlinks are not removed and their targets are untouched
    expect(result.removed).toEqual([])
    expect(readFileSync(join(dir, 'outside.txt'), 'utf8')).toBe('outside')
    expect(readFileSync(join(dir, 'extdir', 'nested.txt'), 'utf8')).toBe('nested')
    expect(result.errors.some(error => error.code === 'symlink-skipped' && error.retryable === false)).toBe(true)
  })

  it('never traverses or deletes outside the bundle root via hostile directory entries', () => {
    const dir = tempDir()
    reconcileSkillFiles(dir, { oq: entry('oq') }, ['oq'])
    writeFileSync(join(dir, 'outside.txt'), 'precious')
    const hostile: SkillFsOps = {
      ...defaultSkillFsOps,
      readdirSync(path) {
        const names = defaultSkillFsOps.readdirSync(path)
        return path.endsWith('oq') ? [...names, '..'] : names
      },
    }
    const result = reconcileSkillFiles(dir, { oq: entry('oq') }, ['oq'], hostile)
    expect(existsSync(join(dir, 'outside.txt'))).toBe(true)
    expect(existsSync(join(dir, 'oq', 'SKILL.md'))).toBe(true)
    expect(result.removed).toEqual([])
  })

  it('is idempotent across repeated reconciles after stale files are removed', () => {
    const dir = tempDir()
    reconcileSkillFiles(dir, { oq: entry('oq', { 'scripts/x.py': 'x' }) }, ['oq'])
    writeFileSync(join(dir, 'oq', 'extra.md'), 'x')
    const first = reconcileSkillFiles(dir, { oq: entry('oq', { 'scripts/x.py': 'x' }) }, ['oq'])
    expect(first.removed).toEqual([join(dir, 'oq', 'extra.md')])
    const second = reconcileSkillFiles(dir, { oq: entry('oq', { 'scripts/x.py': 'x' }) }, ['oq'])
    expect(second.removed).toEqual([])
    expect(second.status).toBe('completed')
  })

  it('reports partial (not failed) when stale deletions succeeded but writes failed', () => {
    const dir = tempDir()
    reconcileSkillFiles(dir, { oq: entry('oq', { 'scripts/a.py': 'v1' }, 'body v1') }, ['oq'])
    writeFileSync(join(dir, 'oq', 'extra.md'), 'x')
    const failing: SkillFsOps = {
      ...defaultSkillFsOps,
      writeFileSync(path, data, encoding) {
        if (path.endsWith('.tmp')) throw new Error('disk full')
        defaultSkillFsOps.writeFileSync(path, data, encoding)
      },
    }
    const result = reconcileSkillFiles(dir, {
      oq: entry('oq', { 'scripts/a.py': 'v2' }, 'body v2'),
    }, ['oq'], failing)
    expect(result.removed).toEqual([join(dir, 'oq', 'extra.md')])
    expect(result.status).toBe('partial')
  })

  it('refuses to write hostile files-map keys outside the bundle', () => {
    const dir = tempDir()
    const hostile = entry('hostile-skill', {
      '../evil.txt': 'nope',
      'a/../../b.txt': 'nope',
      'other/x.txt': 'nope',
    })
    const result = reconcileSkillFiles(dir, { 'hostile-skill': hostile }, ['hostile-skill'])
    expect(existsSync(join(dir, 'evil.txt'))).toBe(false)
    expect(existsSync(join(dir, 'b.txt'))).toBe(false)
    expect(existsSync(join(dir, 'hostile-skill', 'other'))).toBe(false)
    expect(result.errors.filter((error) => error.code === 'unsafe-path')).toHaveLength(3)
    expect(result.written.some((path) => path.endsWith('SKILL.md'))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('parseFrontmatterName / path helpers', () => {
  it('extracts the name field from a rendered bundle', () => {
    expect(parseFrontmatterName(renderSkillMarkdown(skillEntry('repro', 'body', 'summary')))).toBe('repro')
  })

  it('returns undefined for text without a parseable frontmatter', () => {
    expect(parseFrontmatterName('no frontmatter here')).toBeUndefined()
    expect(parseFrontmatterName('---\nunterminated')).toBeUndefined()
  })

  it('collects referenced scripts/references paths', () => {
    const content = [
      '## Files',
      '- wrapper: `scripts/oq_quantize.py`',
      '- card: `references/model_card_template.md`',
      '```scripts/oq_quantize.py',
      'print("hi")',
      '```',
      '```references/model_card_template.md',
      '# {{model_name}}',
      '```',
    ].join('\n')
    expect(referencedFilePaths(content)).toEqual(['scripts/oq_quantize.py', 'references/model_card_template.md'])
  })
})

describe('validateSkillBundle (L2 structural quality)', () => {
  it('passes a clean skill: short id, trigger description, declared files, short body', () => {
    const content = ['# repro', '## Files', '```scripts/repro.py', 'print("hi")', '```'].join('\n')
    const entry = skillEntry('repro', content, 'Use whenever a bug reproduces; run the repro script and read the failure')
    ;(entry as { files?: Record<string, string> }).files = { 'scripts/repro.py': 'print("hi")' }
    expect(validateSkillBundle(entry)).toEqual([])
  })

  it('flags long and wordy ids', () => {
    const base = skillEntry('omlx-oq-quantization-workflow', 'body', 'Use whenever quantizing')
    const issues = validateSkillBundle(base)
    expect(issues.map(issue => issue.code)).toContain('id-too-wordy')
    const long = skillEntry('x'.repeat(31), 'body', 'Use whenever quantizing')
    expect(validateSkillBundle(long).map(issue => issue.code)).toContain('id-too-long')
  })

  it('flags a missing description as an error', () => {
    const issues = validateSkillBundle(skillEntry('repro', 'body'))
    expect(issues.some(issue => issue.code === 'description-missing' && issue.severity === 'error')).toBe(true)
  })

  it('warns when the description lacks trigger phrasing', () => {
    const issues = validateSkillBundle(skillEntry('repro', 'body', 'A skill about reproduction'))
    expect(issues.some(issue => issue.code === 'description-no-trigger' && issue.severity === 'warning')).toBe(true)
  })

  it('warns when a referenced file is missing from the files map', () => {
    const content = ['## Files', '- wrapper: `scripts/oq_quantize.py`', '- card: `references/model_card_template.md`'].join('\n')
    const issues = validateSkillBundle(skillEntry('repro', content, 'Use whenever quantizing'))
    expect(issues.some(issue => issue.code === 'file-not-declared' && issue.message.includes('scripts/oq_quantize.py'))).toBe(true)
    expect(issues.some(issue => issue.code === 'file-not-declared' && issue.message.includes('references/model_card_template.md'))).toBe(true)
  })

  it('passes the file check when every referenced path is declared in files', () => {
    const content = ['## Files', '- wrapper: `scripts/oq_quantize.py`'].join('\n')
    const entry = skillEntry('repro', content, 'Use whenever quantizing')
    ;(entry as { files?: Record<string, string> }).files = { 'scripts/oq_quantize.py': 'print(1)' }
    expect(validateSkillBundle(entry).some(issue => issue.code === 'file-not-declared')).toBe(false)
  })

  it('warns when the body exceeds the soft line cap', () => {
    const longBody = Array.from({ length: 501 }, (_, i) => `line ${i}`).join('\n')
    const issues = validateSkillBundle(skillEntry('repro', longBody, 'Use whenever repro'))
    expect(issues.some(issue => issue.code === 'body-too-long' && issue.severity === 'warning')).toBe(true)
  })
})

describe('validateBundleFiles (L1 bundle limits)', () => {
  it('accepts a valid scripts/references map', () => {
    expect(validateBundleFiles({
      'scripts/oq_quantize.py': 'print(1)',
      'references/template.md': '# x',
    })).toBeUndefined()
  })

  it('rejects traversal, absolute, dot, empty-segment, and ./ keys', () => {
    expect(validateBundleFiles({ '../evil': 'x' })).toContain('invalid path segment')
    expect(validateBundleFiles({ '/abs': 'x' })).toContain('relative')
    expect(validateBundleFiles({ 'scripts/./x': 'x' })).toContain('invalid path segment')
    expect(validateBundleFiles({ 'scripts//x': 'x' })).toContain('invalid path segment')
    expect(validateBundleFiles({ './scripts/x': 'x' })).toContain('./')
  })

  it('rejects keys outside scripts/ and references/, and SKILL.md', () => {
    expect(validateBundleFiles({ 'lib/x': 'x' })).toContain('scripts/ or references/')
    expect(validateBundleFiles({ 'SKILL.md': 'x' })).toContain('generated from content')
  })

  it('rejects backslashes, URL encoding, and empty keys', () => {
    expect(validateBundleFiles({ 'scripts\\x': 'x' })).toContain('forward slashes')
    expect(validateBundleFiles({ 'scripts/%2e%2e/x': 'x' })).toContain('URL-encoded')
    expect(validateBundleFiles({ '': 'x' })).toContain('must not be empty')
  })

  it('rejects over-limit file counts and byte sizes measured in UTF-8', () => {
    const many: Record<string, string> = {}
    for (let i = 0; i < 21; i += 1) many[`scripts/f${i}.py`] = 'x'
    expect(validateBundleFiles(many)).toContain('maxSkillFiles')
    expect(validateBundleFiles({ 'scripts/big.py': 'x'.repeat(256 * 1024 + 1) })).toContain('maxSkillFileBytes')
    // 5 files × ~261 KiB each (87_000 × 3-byte chars) stays under the per-file
    // cap (262144) but totals ~1.24 MiB — only the bundle cap trips
    const multi: Record<string, string> = {}
    for (let i = 0; i < 5; i += 1) multi[`scripts/f${i}.py`] = '中'.repeat(87_000)
    expect(validateBundleFiles(multi)).toContain('maxSkillBundleBytes')
  })
})

import { isHarnessOwnedBundle } from '../src/skills.ts'

describe('isHarnessOwnedBundle (hard-coded provenance)', () => {
  it('recognizes a bundle rendered by this harness', () => {
    expect(isHarnessOwnedBundle(renderSkillMarkdown(skillEntry('repro', 'body', 'summary')))).toBe(true)
  })

  it('returns false when author or source is missing', () => {
    expect(isHarnessOwnedBundle('---\nname: repro\n---\nbody')).toBe(false)
  })

  it('returns false when author or source differs', () => {
    expect(isHarnessOwnedBundle('---\nname: repro\nmetadata:\n  author: someone-else\n  source: esp\n---\nbody')).toBe(false)
    expect(isHarnessOwnedBundle('---\nname: repro\nmetadata:\n  author: dsh-continual-harness\n  source: other\n---\nbody')).toBe(false)
  })

  it('returns false for unparseable frontmatter', () => {
    expect(isHarnessOwnedBundle('no frontmatter')).toBe(false)
    expect(isHarnessOwnedBundle('---\nunterminated')).toBe(false)
  })
})
