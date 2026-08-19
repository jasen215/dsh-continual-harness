/**
 * Plugin-owned file log — mirrors the harness logger facades (`harness`,
 * `continual-harness`) into a JSONL file under the harness home, with a
 * simple size-based rotation to `<file>.1`.
 *
 * The exporter never throws: a log failure must never break the agent loop.
 * @module dsh-continual-harness
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context, Exporter, Message } from '@deepseek-ai/cordis'

/** File name of the plugin-owned log inside the harness home. */
export const PLUGIN_LOG_FILE_NAME = 'continual-harness.log'

/**
 * Logger names captured by the file log. Anything else (host-wide noise
 * from other subsystems) is dropped.
 */
const PLUGIN_LOG_NAMES = new Set(['harness', 'continual-harness'])

/** Options controlling where and how the file log is written. */
export interface FileLogOptions {
  /** Absolute path of the log file. */
  file: string
  /** Rotation cap in bytes; 0 disables rotation. */
  maxBytes: number
}

/**
 * Register a logger exporter that appends harness records to `options.file`.
 * @param ctx - Cordis context whose logger service receives the exporter.
 * @param options - destination and rotation cap.
 */
export function attachFileLog(ctx: Context, options: FileLogOptions): void {
  ctx.logger.exporter({
    // Raise the exporter's per-name threshold to DEBUG (3) so every severity
    // (error/info/warn/debug) of this plugin's loggers reaches `export()`.
    // Cordis drops messages with `targetLevel < level` before exporters see
    // them, so without this the host's default INFO threshold would silently
    // discard warn/debug. `LoggerLevel.DEBUG` is a type-only const enum (no
    // runtime export), hence the numeric 3.
    levels: { default: 3 },
    export(message) {
      try {
        if (!PLUGIN_LOG_NAMES.has(message.name)) return
        appendRecord(options, message)
      } catch {
        /* 日志失败永不打断 agent 循环 */
      }
    },
  } satisfies Exporter)
}

function appendRecord(options: FileLogOptions, message: Message): void {
  mkdirSync(dirname(options.file), { recursive: true })
  const record = {
    ts: new Date(message.ts).toISOString(),
    level: message.type,
    name: message.name,
    message: String(message.args[0] ?? ''),
    args: message.args.slice(1).map(renderArg),
  }
  const line = `${JSON.stringify(record)}\n`
  if (options.maxBytes > 0 && existsSync(options.file)
      && statSync(options.file).size + Buffer.byteLength(line) > options.maxBytes) {
    try { renameSync(options.file, `${options.file}.1`) } catch { /* 轮转失败保留原文件 */ }
  }
  appendFileSync(options.file, line, { mode: 0o600 })
}

function renderArg(value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value
}
