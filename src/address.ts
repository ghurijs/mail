import { BadHeaderError } from './errors'
import { encodeHeaderValue, encodeWords, isAscii } from './mime'

/** Raise `BadHeaderError` when a header value contains a newline (Django's `forbid_multi_line_headers`). */
export function forbidMultiLineHeaders(name: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new BadHeaderError(
      `Header values can't contain newlines (got ${JSON.stringify(value)} for header ${JSON.stringify(name)})`,
    )
  }
}

/** Raise `BadHeaderError` for header names that are not printable ASCII without a colon. */
export function checkHeaderName(name: string): void {
  if (!/^[!-9;-~]+$/.test(name)) throw new BadHeaderError(`Invalid header name ${JSON.stringify(name)}`)
}

export interface ParsedAddress {
  /** Display name (`''` when none). */
  name: string
  /** The addr-spec (`user@example.com`). */
  email: string
}

/** Split `'Jane <jane@example.com>'` into display name and address. Raises `BadHeaderError` on newlines. */
export function parseAddress(address: string): ParsedAddress {
  forbidMultiLineHeaders('address', address)
  const trimmed = address.trim()
  const m = /^(.*?)\s*<([^<>]*)>$/s.exec(trimmed)
  let name = ''
  let email = trimmed
  if (m) {
    name = m[1].trim()
    email = m[2].trim()
    if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
      name = name.slice(1, -1).replace(/\\(.)/g, '$1')
    }
  }
  if (!email || /\s/.test(email) || email.includes(',')) {
    throw new BadHeaderError(`Invalid address ${JSON.stringify(address)}`)
  }
  return { name, email }
}

/**
 * Split a header value holding several addresses (`'a@x.com, "Doe, Jane" <j@x.com>'`) on commas outside quotes
 * and angle brackets.
 */
export function splitAddresses(value: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  let angle = false
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '\\' && quoted) {
      current += ch + (value[++i] ?? '')
      continue
    }
    if (ch === '"') quoted = !quoted
    else if (ch === '<' && !quoted) angle = true
    else if (ch === '>' && !quoted) angle = false
    if (ch === ',' && !quoted && !angle) {
      if (current.trim()) out.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) out.push(current.trim())
  return out
}

function idnaDomain(domain: string): string {
  if (isAscii(domain)) return domain
  try {
    return new URL(`http://${domain}`).hostname
  } catch (err) {
    throw new BadHeaderError(`Invalid domain ${JSON.stringify(domain)}`, { cause: err })
  }
}

/** The address with its domain converted to IDNA (punycode); used for the SMTP envelope. */
export function envelopeAddress(address: string): string {
  const { email } = parseAddress(address)
  const at = email.lastIndexOf('@')
  return at < 0 ? email : `${email.slice(0, at)}@${idnaDomain(email.slice(at + 1))}`
}

function quoteName(name: string): string {
  return /[()<>[\]:;@\\,."]/.test(name) ? `"${name.replace(/[\\"]/g, '\\$&')}"` : name
}

/** `'Name <email>'` (name quoted when needed) or just the email, for APIs that take display strings. */
export function formatAddress({ name, email }: ParsedAddress): string {
  return name ? `${quoteName(name)} <${email}>` : email
}

/**
 * An address ready for a MIME header (Django's `sanitize_address`): non-ASCII display names become encoded words
 * and international domains are converted to punycode.
 */
export function sanitizeAddress(address: string): string {
  const { name } = parseAddress(address)
  const email = envelopeAddress(address)
  if (!name) return email
  const displayName = isAscii(name) ? quoteName(name) : encodeWords(name).join(' ')
  return `${displayName} <${email}>`
}

/** Header names whose values are address lists. */
export const ADDRESS_HEADERS = new Set([
  'from',
  'sender',
  'reply-to',
  'to',
  'cc',
  'bcc',
  'resent-from',
  'resent-sender',
  'resent-to',
  'resent-cc',
  'resent-bcc',
])

/** Validate and encode one header for the wire. */
export function encodeHeader(name: string, value: string): string {
  checkHeaderName(name)
  forbidMultiLineHeaders(name, value)
  if (ADDRESS_HEADERS.has(name.toLowerCase())) return splitAddresses(value).map(sanitizeAddress).join(', ')
  return encodeHeaderValue(value)
}
