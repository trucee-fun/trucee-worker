/**
 * JSON-lines logger on stdout. URLs inside messages and context values are reduced to their host,
 * because RPC URLs embed provider API keys. Only plain data is serialised structurally: class instances
 * (Keypair, Connection, URL, Buffer, ...) become a `[ClassName]` placeholder so their internals never leak,
 * and every registered secret is scrubbed from the final line.
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
const REDACTED_SECRET = '[redacted]'
/** Shorter values are ignored: scrubbing a string like "/" would mangle every line. */
const MIN_SECRET_LENGTH = 8

/** Longest first, so a full secret is replaced before any registered fragment of it. */
let secrets: readonly string[] = []

/**
 * Registers a value that must never appear in a log line (e.g. the RPC URL or its path/query).
 * Values shorter than 8 characters are ignored.
 */
export function registerSecret(value: string): void {
  if (value.length < MIN_SECRET_LENGTH) return
  // The scrub runs on the serialised line, so also match the JSON-escaped form.
  const forms = [value, JSON.stringify(value).slice(1, -1)].filter((form) => !secrets.includes(form))
  secrets = [...secrets, ...new Set(forms)].sort((a, b) => b.length - a.length)
}

function scrubSecrets(line: string): string {
  return secrets.reduce((text, secret) => text.split(secret).join(REDACTED_SECRET), line)
}

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

/** PublicKey and anything else exposing a base58 form (checked by shape, so any @solana/web3.js copy matches). */
function hasToBase58(value: object): value is { toBase58(): string } {
  return typeof (value as { toBase58?: unknown }).toBase58 === 'function'
}

function placeholder(value: object): string {
  const name: unknown = (value as { constructor?: { name?: unknown } }).constructor?.name
  return `[${typeof name === 'string' && name !== '' ? name : 'Object'}]`
}

function redactObject(value: object, depth: number): unknown {
  if (value instanceof Error) return redactUrls(value.message)
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '[Invalid Date]' : value.toISOString()
  if (hasToBase58(value)) return value.toBase58()
  if (depth >= MAX_CONTEXT_DEPTH) return '[truncated]'
  if (Array.isArray(value)) return value.map((item: unknown) => redactValue(item, depth + 1))
  if (isPlainObject(value)) return redactRecord(value, depth + 1)
  // Keypair, Connection, URL, Buffer, Uint8Array, Map, ...: never dump internals.
  return placeholder(value)
}

function redactValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactUrls(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function') return '[Function]'
  if (typeof value === 'symbol') return '[Symbol]'
  return redactObject(value, depth)
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
  process.stdout.write(`${scrubSecrets(formatLine(level, msg, ctx))}\n`)
}

export const log: Logger = Object.freeze({
  info: (msg: string, ctx?: LogContext) => write('info', msg, ctx),
  warn: (msg: string, ctx?: LogContext) => write('warn', msg, ctx),
  error: (msg: string, ctx?: LogContext) => write('error', msg, ctx),
})
