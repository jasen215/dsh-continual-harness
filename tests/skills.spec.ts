import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderSkillMarkdown, reconcileSkillFiles } from '../src/skills.ts'
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
