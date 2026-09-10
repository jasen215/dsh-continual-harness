#!/usr/bin/env node
/**
 * Repair session logs written with the retired `harness-state` message source.
 *
 * WHY this is needed: the released Session format migrations (v0 -> v1 -> v2 ->
 * v3) only classify platform source kinds. An artifact holding one message with
 * a plugin-defined source kind is refused as a whole
 * (`cannot safely transform unclassified message source`), so every session
 * logged by a plugin build up to 0.3.0 became unreadable once the harness
 * started writing the current v3 format. Plugin builds from 0.3.1 log the same
 * overview as a platform-classified `plugin` source, so rewriting the retired
 * kind makes the stored artifact readable again without touching a single
 * sequence number, payload, or surface operation.
 *
 * Usage:
 *   node scripts/repair-harness-state-logs.mjs [options]
 *
 * Options:
 *   --root <dir>            Sessions root (default: $DSH_HOME/sessions, else ~/.dsh/sessions).
 *   --apply                 Write the repair. Without it the run only reports (dry run).
 *   --force                 Repair files modified within --min-age-seconds too.
 *   --min-age-seconds <n>   Skip artifacts written in the last n seconds (default 300),
 *                           so a live session log is never rewritten underneath its writer.
 *   --help                  Print this usage.
 *
 * The repair is offline data surgery: stop the harness (or at least do not
 * continue those sessions) before applying it.
 */

import {
  copyFileSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib'

/** Retired plugin-defined message source kind. */
const LEGACY_KIND = 'harness-state'
/** Platform-classified source that replaced it, matching src/projection.ts. */
const REPLACEMENT = Object.freeze({ kind: 'plugin', plugin: 'dsh-continual-harness', form: 'instructions' })
/** Zstandard frame magic number, little endian on disk. */
const ZSTD_MAGIC = 0xfd2fb528
/** Retired plugin-defined session event type, refused by the same migrations. */
const LEGACY_EVENT = 'harness/refinement'
/** Artifact basenames this script owns: the v0 generation, compressed or plain. */
const V0_ARTIFACTS = ['session.jsonl.zstd', 'session.jsonl']

const USAGE = `Usage:
  node scripts/repair-harness-state-logs.mjs [options]

Options:
  --root <dir>            Sessions root (default: $DSH_HOME/sessions, else ~/.dsh/sessions).
  --apply                 Write the repair. Without it the run only reports (dry run).
  --force                 Repair files modified within --min-age-seconds too.
  --min-age-seconds <n>   Skip artifacts written in the last n seconds (default 300),
                          so a live session log is never rewritten underneath its writer.
  --help                  Print this usage.
`

function parseArgs(argv) {
  const options = { apply: false, force: false, minAgeSeconds: 300, root: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') options.apply = true
    else if (arg === '--force') options.force = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--root') { index += 1; options.root = argv[index] }
    else if (arg === '--min-age-seconds') { index += 1; options.minAgeSeconds = Number(argv[index]) }
    else throw new Error(`unknown argument ${arg}`)
  }
  if (options.root === undefined) {
    const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
    options.root = join(home, 'sessions')
  }
  if (!Number.isFinite(options.minAgeSeconds) || options.minAgeSeconds < 0) {
    throw new Error('--min-age-seconds must be a non-negative number')
  }
  return options
}

/** Recursively collect candidate artifacts below one session root. */
function collectArtifacts(dir, depth, found) {
  if (depth > 3) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collectArtifacts(path, depth + 1, found)
    else if (V0_ARTIFACTS.includes(entry.name)) found.push(path)
  }
}

/** Rebuild one parsed JSON value, replacing every legacy source kind it holds. */
function replaceLegacySources(value, counter) {
  if (Array.isArray(value)) return value.map(member => replaceLegacySources(member, counter))
  if (value === null || typeof value !== 'object') return value
  if (value['kind'] === LEGACY_KIND) {
    counter.sources += 1
    return { ...REPLACEMENT }
  }
  const rebuilt = {}
  for (const [key, member] of Object.entries(value)) rebuilt[key] = replaceLegacySources(member, counter)
  return rebuilt
}

/** Rewrite only the rows that carry the retired kind; every other row keeps its exact bytes. */
function repairRows(text) {
  const counter = { sources: 0, rows: 0, events: 0 }
  const rows = text.split('\n')
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (row.length === 0) continue
    if (row.includes(`"${LEGACY_EVENT}"`) && JSON.parse(row)['type'] === LEGACY_EVENT) counter.events += 1
    if (!row.includes(`"${LEGACY_KIND}"`)) continue
    const parsed = JSON.parse(row)
    const rowCounter = { sources: 0 }
    const rebuilt = replaceLegacySources(parsed, rowCounter)
    if (rowCounter.sources === 0) continue
    rows[index] = JSON.stringify(rebuilt)
    counter.sources += rowCounter.sources
    counter.rows += 1
  }
  return { text: rows.join('\n'), counter }
}

function readArtifact(path) {
  const raw = readFileSync(path)
  if (!path.endsWith('.zstd')) return raw.toString('utf8')
  // A session log is a concatenation of one Zstandard frame per append batch,
  // and Node's zstd binding decodes only the first frame of a buffer. Walk the
  // frames exactly as the session persistence reader does, then decode each.
  return scanZstdFrames(raw).map(({ start, end }) => zstdDecompressSync(raw.subarray(start, end))).join('').toString('utf8')
}

/** Locate complete Zstandard frames without decompressing their blocks. */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 5 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    offset += (singleSegment ? 0 : 1) + (dictionaryFlag === 3 ? 4 : dictionaryFlag)
      + (contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag)
    for (;;) {
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const blockType = (blockHeader >>> 1) & 3
      if (blockType === 3) throw new Error(`corrupt Zstandard log: reserved block type at byte ${offset - 3}`)
      offset += blockType === 1 ? 1 : blockHeader >>> 3
      if ((blockHeader & 1) !== 0) break
    }
    if (checksum) offset += 4
    if (offset > buffer.length) throw new Error(`corrupt Zstandard log: truncated frame at byte ${start}`)
    frames.push({ start, end: offset })
  }
  return frames
}

/**
 * Write one repaired artifact. A compressed log must keep the platform's
 * physical shape — an independently decodable, checksummed first frame holding
 * exactly the header line, then the event frames — because the session
 * persistence reader refuses any other first frame. The produced bytes are
 * decoded back and compared before the atomic rename.
 */
function writeArtifact(path, text) {
  let payload
  if (path.endsWith('.zstd')) {
    const newline = text.indexOf('\n')
    if (newline < 0) throw new Error('repaired log has no complete header line')
    const header = compressFrame(text.slice(0, newline + 1))
    const body = text.slice(newline + 1)
    payload = body.length === 0 ? header : Buffer.concat([header, compressFrame(body)])
    if (scanZstdFrames(payload).map(({ start, end }) => zstdDecompressSync(payload.subarray(start, end))).join('').toString('utf8') !== text) {
      throw new Error('repaired Zstandard frames do not decode back to the repaired log')
    }
  } else {
    payload = Buffer.from(text, 'utf8')
  }
  const temporary = `${path}.repair-tmp`
  writeFileSync(temporary, payload, { mode: 0o600 })
  renameSync(temporary, path)
}

/** Compress one independently decodable, checksummed frame, as the platform does. */
function compressFrame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
}

function repairFile(path, options, report) {
  const ageSeconds = (Date.now() - statSync(path).mtimeMs) / 1000
  if (!options.force && ageSeconds < options.minAgeSeconds) {
    report.skipped.push([path, `modified ${Math.round(ageSeconds)}s ago; use --force to repair`])
    return
  }
  const original = readArtifact(path)
  const { text, counter } = repairRows(original)
  if (counter.events > 0) report.legacyEvents.push([path, counter.events])
  if (counter.sources === 0) return
  report.repaired.push([path, counter.rows, counter.sources])
  if (!options.apply) return
  const backup = `${path}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
  copyFileSync(path, backup)
  try {
    writeArtifact(path, text)
  } catch (error) {
    rmSync(backup, { force: true })
    throw error
  }
  report.backups.push(backup)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(USAGE)
    return
  }
  const artifacts = []
  collectArtifacts(options.root, 0, artifacts)
  const report = { repaired: [], skipped: [], legacyEvents: [], backups: [] }
  let scanned = 0
  for (const path of artifacts.sort()) {
    if (!readFileSync(path).length) continue
    scanned += 1
    repairFile(path, options, report)
  }
  process.stdout.write(`root: ${options.root}\n`)
  process.stdout.write(`scanned v0 artifacts: ${scanned}\n`)
  process.stdout.write(`repairable artifacts: ${report.repaired.length}\n`)
  for (const [path, rows, sources] of report.repaired) {
    process.stdout.write(`  ${path}: ${rows} row(s), ${sources} source(s)\n`)
  }
  if (report.skipped.length > 0) {
    process.stdout.write(`skipped: ${report.skipped.length}\n`)
    for (const [path, reason] of report.skipped) process.stdout.write(`  ${path}: ${reason}\n`)
  }
  if (report.legacyEvents.length > 0) {
    process.stdout.write(`still unreadable (retired ${LEGACY_EVENT} event, not repaired by this script): ${report.legacyEvents.length}\n`)
    for (const [path, count] of report.legacyEvents) process.stdout.write(`  ${path}: ${count} event(s)\n`)
  }
  if (options.apply) {
    process.stdout.write(`backups written: ${report.backups.length}\n`)
  } else if (report.repaired.length > 0) {
    process.stdout.write('dry run: pass --apply to write the repair\n')
  }
}

main()
