/**
 * JSON-lines logger on stdout. URLs inside messages and context values are reduced to their host,
 * because RPC URLs embed provider API keys.
 */

export type LogLevel = 'info' | 'warn' | 'error'
export type LogContext = Readonly<Record<string, unknown>>
export type LogFn = (msg: string, ctx?: LogContext) => void

export interface Logger {
  readonly info: LogFn
  readonly warn: LogFn
  readonly error: LogFn
}

/** Matches scheme://... up to the next whitespace or quote. */
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi
/** Deeper values are replaced so a cyclic or huge context can never crash the logger. */
const MAX_CONTEXT_DEPTH = 6
const REDACTED_URL = '[redacted-url]'

function urlHost(raw: string): string {
  try {
    const url = new URL(raw)
    return url.host === '' ? url.protocol : url.host
  } catch {
    return REDACTED_URL
  }
}

/** Replaces every URL in `text` with its host. */
export function redactUrls(text: string): string {
  return text.replace(URL_PATTERN, (match) => urlHost(match))
}

/** A loggable description of a thrown value: its message only, never a stack. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactUrls(value)
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Error) return redactUrls(value.message)
  if (depth >= MAX_CONTEXT_DEPTH) return '[truncated]'
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1))
  if (isPlainObject(value)) return redactRecord(value, depth + 1)
  return value
}

function redactRecord(record: Readonly<Record<string, unknown>>, depth: number): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, redactValue(value, depth)]))
}

function formatLine(level: LogLevel, msg: string, ctx: LogContext | undefined): string {
  const base = { ts: new Date().toISOString(), level, msg: redactUrls(msg) }
  try {
    const fields = ctx === undefined ? {} : redactRecord(ctx, 0)
    // base is spread last again so ctx can never overwrite ts, level or msg (keys keep their first position).
    return JSON.stringify({ ...base, ...fields, ...base })
  } catch {
    return JSON.stringify({ ...base, logError: 'unserializable context' })
  }
}

function write(level: LogLevel, msg: string, ctx?: LogContext): void {
  process.stdout.write(`${formatLine(level, msg, ctx)}\n`)
}

export const log: Logger = Object.freeze({
  info: (msg: string, ctx?: LogContext) => write('info', msg, ctx),
  warn: (msg: string, ctx?: LogContext) => write('warn', msg, ctx),
  error: (msg: string, ctx?: LogContext) => write('error', msg, ctx),
})
