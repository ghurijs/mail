// Minimal MIME (RFC 2045/2046/2047/2231) writer used by `EmailMessage.message()`. Workers-safe: no Buffer, no Node
// modules. Everything is emitted as 7-bit (quoted-printable / base64 / encoded words), so no 8BITMIME is needed.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const CRLF = '\r\n'

export function utf8(text: string): Uint8Array {
  return encoder.encode(text)
}

export function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) return false
  return true
}

/** Any content accepted for attachments. */
export type EmailContent = string | Uint8Array | ArrayBuffer | ArrayBufferView

export function toBytes(content: EmailContent): Uint8Array {
  if (typeof content === 'string') return utf8(content)
  if (content instanceof Uint8Array) return content
  if (content instanceof ArrayBuffer) return new Uint8Array(content)
  return new Uint8Array(content.buffer, content.byteOffset, content.byteLength)
}

export function base64Encode(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(out)
}

export function base64Decode(text: string): Uint8Array {
  const bin = atob(text.replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Base64 wrapped at 76 characters (RFC 2045). */
export function base64Body(bytes: Uint8Array): string {
  const b64 = base64Encode(bytes)
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76))
  return lines.join(CRLF)
}

/** Normalize `\n` / `\r` line endings to CRLF. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n|\r|\n/g, CRLF)
}

const hex = (b: number) => `=${b.toString(16).toUpperCase().padStart(2, '0')}`

/** Quoted-printable (RFC 2045 §6.7) of UTF-8 text; lines end with CRLF, soft breaks keep lines ≤ 76. */
export function quotedPrintable(text: string): string {
  return normalizeNewlines(text)
    .split(CRLF)
    .map((line) => {
      const bytes = utf8(line)
      const tokens: string[] = []
      bytes.forEach((b, i) => {
        const last = i === bytes.length - 1
        if ((b === 0x20 || b === 0x09) && last) tokens.push(hex(b))
        else if ((b >= 33 && b <= 126 && b !== 61) || b === 0x20 || b === 0x09)
          tokens.push(String.fromCharCode(b))
        else tokens.push(hex(b))
      })
      const out: string[] = []
      let current = ''
      for (const token of tokens) {
        if (current.length + token.length > 75) {
          out.push(`${current}=`)
          current = ''
        }
        current += token
      }
      out.push(current)
      return out.join(CRLF)
    })
    .join(CRLF)
}

export function quotedPrintableDecode(text: string): Uint8Array {
  const joined = text.replace(/=\r?\n/g, '')
  const bytes: number[] = []
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i]
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(joined.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      bytes.push(...utf8(ch))
    }
  }
  return new Uint8Array(bytes)
}

/** RFC 2047 encoded words (`=?utf-8?b?...?=`), each ≤ 75 characters, never splitting a character. */
export function encodeWords(text: string): string[] {
  const words: string[] = []
  let chunk: number[] = []
  for (const ch of text) {
    const bytes = utf8(ch)
    if (chunk.length + bytes.length > 45) {
      words.push(`=?utf-8?b?${base64Encode(new Uint8Array(chunk))}?=`)
      chunk = []
    }
    chunk.push(...bytes)
  }
  if (chunk.length || !words.length) words.push(`=?utf-8?b?${base64Encode(new Uint8Array(chunk))}?=`)
  return words
}

/** A header value safe for the wire: ASCII stays as is, anything else becomes folded encoded words. */
export function encodeHeaderValue(value: string): string {
  return isAscii(value) ? value : encodeWords(value).join(`${CRLF} `)
}

/** A `name="value"` MIME parameter, RFC 2231-encoded when the value is not ASCII. */
export function mimeParam(name: string, value: string): string {
  if (isAscii(value)) return `${name}="${value.replace(/[\\"]/g, '\\$&')}"`
  const encoded = Array.from(utf8(value), (b) =>
    /[A-Za-z0-9!#$&+\-.^_`|~]/.test(String.fromCharCode(b))
      ? String.fromCharCode(b)
      : `%${b.toString(16).toUpperCase().padStart(2, '0')}`,
  ).join('')
  return `${name}*=utf-8''${encoded}`
}

const MIME_TYPES: Record<string, string> = {
  txt: 'text/plain',
  text: 'text/plain',
  csv: 'text/csv',
  htm: 'text/html',
  html: 'text/html',
  css: 'text/css',
  ics: 'text/calendar',
  md: 'text/markdown',
  xml: 'text/xml',
  js: 'text/javascript',
  json: 'application/json',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  eml: 'message/rfc822',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/vnd.microsoft.icon',
  avif: 'image/avif',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
}

/** Guess a MIME type from a file name (Python's `mimetypes.guess_type`, for common types). */
export function guessMimeType(filename: string | null | undefined): string | undefined {
  const ext = filename?.split('.').pop()?.toLowerCase()
  return ext && filename?.includes('.') ? MIME_TYPES[ext] : undefined
}

let boundaryCounter = 0

function makeBoundary(): string {
  const rnd = new Uint8Array(12)
  crypto.getRandomValues(rnd)
  boundaryCounter = (boundaryCounter + 1) % 1_000_000
  return `===============${Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('')}${boundaryCounter}==`
}

/**
 * One MIME entity: headers plus either an encoded body (`string`) or child parts (multipart). Returned by
 * `EmailMessage.message()`; `asString()` / `asBytes()` give the RFC 5322 source with CRLF line endings.
 */
export class MIMEPart {
  readonly headers: Array<[string, string]> = []
  payload: string | MIMEPart[]
  readonly boundary?: string

  constructor(contentType: string, payload: string | MIMEPart[] = '') {
    this.payload = payload
    if (Array.isArray(payload)) {
      this.boundary = makeBoundary()
      this.headers.push(['Content-Type', `${contentType}; boundary="${this.boundary}"`])
    } else {
      this.headers.push(['Content-Type', contentType])
    }
  }

  /** Multipart container (`multipart/alternative`, `multipart/mixed`, ...). */
  static multipart(subtype: string, parts: MIMEPart[]): MIMEPart {
    return new MIMEPart(`multipart/${subtype}`, parts)
  }

  /** A UTF-8 text part, 7bit when it is short-lined ASCII, quoted-printable otherwise. */
  static text(text: string, subtype = 'plain'): MIMEPart {
    const normalized = normalizeNewlines(text)
    const sevenBit = isAscii(normalized) && normalized.split(CRLF).every((l) => l.length <= 998)
    const part = new MIMEPart(
      `text/${subtype}; charset="utf-8"`,
      sevenBit ? normalized : quotedPrintable(text),
    )
    part.headers.push(['Content-Transfer-Encoding', sevenBit ? '7bit' : 'quoted-printable'])
    return part
  }

  /** A base64-encoded part. */
  static binary(content: EmailContent, mimetype: string): MIMEPart {
    const part = new MIMEPart(mimetype, base64Body(toBytes(content)))
    part.headers.push(['Content-Transfer-Encoding', 'base64'])
    return part
  }

  isMultipart(): boolean {
    return Array.isArray(this.payload)
  }

  /** First value of header `name` (case-insensitive), as written on the wire. */
  get(name: string): string | undefined {
    const lower = name.toLowerCase()
    return this.headers.find(([n]) => n.toLowerCase() === lower)?.[1]
  }

  /** Every value of header `name`. */
  getAll(name: string): string[] {
    const lower = name.toLowerCase()
    return this.headers.filter(([n]) => n.toLowerCase() === lower).map(([, v]) => v)
  }

  set(name: string, value: string): this {
    const lower = name.toLowerCase()
    const i = this.headers.findIndex(([n]) => n.toLowerCase() === lower)
    if (i >= 0) this.headers[i] = [name, value]
    else this.headers.push([name, value])
    return this
  }

  /** Insert a header after another one (keeps Django's header order). */
  insertAfter(after: string, name: string, value: string): this {
    const i = this.headers.findIndex(([n]) => n.toLowerCase() === after.toLowerCase())
    this.headers.splice(i + 1, 0, [name, value])
    return this
  }

  /** `text/plain` from `Content-Type: text/plain; charset="utf-8"`. */
  getContentType(): string {
    return (this.get('Content-Type') ?? 'text/plain').split(';')[0].trim().toLowerCase()
  }

  /** Child parts (multipart) or `[]`. */
  getParts(): MIMEPart[] {
    return Array.isArray(this.payload) ? this.payload : []
  }

  /** Every descendant part, depth first. */
  walk(): MIMEPart[] {
    return Array.isArray(this.payload) ? this.payload.flatMap((p) => [p, ...p.walk()]) : []
  }

  /** The decoded body: a string for `text/*`, bytes otherwise (`undefined` for multipart). */
  getContent(): string | Uint8Array | undefined {
    if (Array.isArray(this.payload)) return undefined
    const cte = (this.get('Content-Transfer-Encoding') ?? '7bit').toLowerCase()
    const bytes =
      cte === 'base64'
        ? base64Decode(this.payload)
        : cte === 'quoted-printable'
          ? quotedPrintableDecode(this.payload)
          : utf8(this.payload)
    return this.getContentType().startsWith('text/') ? decoder.decode(bytes) : bytes
  }

  asString(): string {
    const head = this.headers.map(([n, v]) => `${n}: ${v}`).join(CRLF)
    if (!Array.isArray(this.payload)) return `${head}${CRLF}${CRLF}${this.payload}`
    const b = this.boundary
    const parts = this.payload.map((p) => `--${b}${CRLF}${p.asString()}${CRLF}`).join('')
    return `${head}${CRLF}${CRLF}${parts}--${b}--${CRLF}`
  }

  asBytes(): Uint8Array {
    return utf8(this.asString())
  }

  toString(): string {
    return this.asString()
  }
}
