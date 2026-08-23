import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  embeddedFilePaths,
  parseFrontmatterName,
  reconcileSkillFiles,
  referencedFilePaths,
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
    const written = reconcileSkillFiles(dir, { repro: skillEntry('repro', 'body', 'summary') }, ['repro'])
    expect(written).toEqual([join(dir, 'repro', 'SKILL.md')])
    expect(readFileSync(join(dir, 'repro', 'SKILL.md'), 'utf8')).toContain('name: repro')
    expect(readFileSync(join(dir, 'repro', 'SKILL.md'), 'utf8')).toContain('summary')
  })

  it('removes the bundle directory for a touched id with no effective entry', () => {
    const dir = tempDir()
    reconcileSkillFiles(dir, { repro: skillEntry('repro', 'body') }, ['repro'])
    expect(existsSync(join(dir, 'repro', 'SKILL.md'))).toBe(true)
    reconcileSkillFiles(dir, {}, ['repro'])
    expect(existsSync(join(dir, 'repro'))).toBe(false)
  })

  it('never writes or removes ids outside touchedIds, and skips non-kebab ids', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'mine'), { recursive: true })
    writeFileSync(join(dir, 'mine', 'SKILL.md'), 'user skill')
    const written = reconcileSkillFiles(dir, {
      mine: skillEntry('mine', 'user'),
      'Not Kebab': skillEntry('Not Kebab', 'bad'),
    }, ['Not Kebab'])
    expect(written).toEqual([])
    expect(readFileSync(join(dir, 'mine', 'SKILL.md'), 'utf8')).toBe('user skill')
  })

  it('skips rewriting when the file already matches', () => {
    const dir = tempDir()
    reconcileSkillFiles(dir, { repro: skillEntry('repro', 'body') }, ['repro'])
    const file = join(dir, 'repro', 'SKILL.md')
    const mtime = readFileSync(file, 'utf8')
    reconcileSkillFiles(dir, { repro: skillEntry('repro', 'body') }, ['repro'])
    expect(readFileSync(file, 'utf8')).toBe(mtime)
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

  it('collects referenced and embedded scripts/references paths separately', () => {
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
    expect(embeddedFilePaths(content)).toEqual(new Set(['scripts/oq_quantize.py', 'references/model_card_template.md']))
  })
})

describe('validateSkillBundle (L2 structural quality)', () => {
  it('passes a clean skill: short id, trigger description, embedded files, short body', () => {
    const content = [
      '# repro',
      '## Files',
      '```scripts/repro.py',
      'print("hi")',
      '```',
    ].join('\n')
    const issues = validateSkillBundle(skillEntry('repro', content, 'Use whenever a bug reproduces; run the repro script and read the failure'))
    expect(issues).toEqual([])
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

  it('warns when a referenced file has no embedded fenced block', () => {
    const content = ['## Files', '- wrapper: `scripts/oq_quantize.py`', '- card: `references/model_card_template.md`', '```scripts/oq_quantize.py', 'print("hi")', '```'].join('\n')
    const issues = validateSkillBundle(skillEntry('repro', content, 'Use whenever quantizing'))
    expect(issues.some(issue => issue.code === 'file-not-embedded' && issue.message.includes('references/model_card_template.md'))).toBe(true)
    expect(issues.some(issue => issue.code === 'file-not-embedded' && issue.message.includes('scripts/oq_quantize.py'))).toBe(false)
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
