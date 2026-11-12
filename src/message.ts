import { encodeHeader, envelopeAddress, forbidMultiLineHeaders, sanitizeAddress } from './address'
import type { BaseEmailBackend } from './backends/base'
import { getConnection } from './connection'
import { type EmailContent, encodeHeaderValue, guessMimeType, MIMEPart, mimeParam, toBytes } from './mime'
import { DEFAULT_FROM_EMAIL, mailSetting } from './settings'

/** MIME type used for attachments whose type cannot be guessed (Django's `DEFAULT_ATTACHMENT_MIME_TYPE`). */
export const DEFAULT_ATTACHMENT_MIME_TYPE = 'application/octet-stream'

/** A file attached to a message (Django's `EmailAttachment`). */
export interface EmailAttachment {
  filename: string | null
  content: string | Uint8Array
  mimetype: string
}

/** An alternative representation of the body (Django's `EmailAlternative`), e.g. HTML. */
export interface EmailAlternative {
  content: string
  mimetype: string
}

/** An attachment as accepted by the constructor: an `EmailAttachment` or `[filename, content, mimetype?]`. */
export type AttachmentInput =
  | EmailAttachment
  | { filename?: string | null; content: EmailContent; mimetype?: string | null }
  | [filename: string | null, content: EmailContent, mimetype?: string | null]

export interface EmailMessageOptions {
  subject?: string
  body?: string
  /** Sender; defaults to `DEFAULT_FROM_EMAIL`. */
  fromEmail?: string | null
  to?: string[]
  cc?: string[]
  bcc?: string[]
  replyTo?: string[]
  /** Extra headers (`{ 'Message-ID': '...', 'X-Tag': 'x' }`); `From`, `To`, `Cc` and `Reply-To` override the fields. */
  headers?: Record<string, string>
  attachments?: AttachmentInput[]
  /** Backend used by `send()` (default: `getConnection()` at send time). */
  connection?: BaseEmailBackend | null
}

export interface EmailMultiAlternativesOptions extends EmailMessageOptions {
  alternatives?: Array<EmailAlternative | [content: string, mimetype: string]>
}

function addressList(name: string, value: string[] | undefined): string[] {
  if (value === undefined || value === null) return []
  if (typeof value === 'string' || !Array.isArray(value)) {
    throw new TypeError(`"${name}" argument must be a list or tuple`)
  }
  return [...value]
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** RFC 5322 date in UTC (`Wed, 12 Nov 2026 10:00:00 +0000`). */
export function formatDate(date = new Date()): string {
  return (
    `${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  )
}

/** A unique Message-ID (Python's `make_msgid`): `<1731400000000.4f2a...@example.com>`. */
export function makeMsgid(domain = 'localhost'): string {
  const rnd = new Uint8Array(8)
  crypto.getRandomValues(rnd)
  return `<${Date.now()}.${Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('')}@${domain}>`
}

function normalizeAttachment(input: AttachmentInput): EmailAttachment {
  const [filename, content, mimetype] = Array.isArray(input)
    ? input
    : [input.filename ?? null, input.content, input.mimetype ?? null]
  let type = mimetype || guessMimeType(filename) || DEFAULT_ATTACHMENT_MIME_TYPE
  let value: string | Uint8Array = typeof content === 'string' ? content : toBytes(content)
  // Like Django: text attachments given as bytes are decoded; undecodable ones become application/octet-stream.
  if (type.split('/')[0] === 'text' && typeof value !== 'string') {
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(value)
    } catch {
      type = DEFAULT_ATTACHMENT_MIME_TYPE
    }
  }
  return { filename, content: value, mimetype: type }
}

/**
 * An email message (Django's `django.core.mail.EmailMessage`).
 *
 * ```ts
 * const email = new EmailMessage('Hello', 'Body goes here', {
 *   fromEmail: 'from@example.com', to: ['to1@example.com'], bcc: ['bcc@example.com'],
 *   replyTo: ['another@example.com'], headers: { 'Message-ID': 'foo' },
 * })
 * await email.send()
 * ```
 */
export class EmailMessage {
  /** Body subtype: `'plain'` (default) or `'html'`. */
  contentSubtype = 'plain'
  /** Subtype of the outer container when there are attachments. */
  mixedSubtype = 'mixed'

  subject: string
  body: string
  fromEmail: string
  to: string[]
  cc: string[]
  bcc: string[]
  replyTo: string[]
  /** Extra headers (Django's `extra_headers`). */
  extraHeaders: Record<string, string>
  attachments: EmailAttachment[]
  connection: BaseEmailBackend | null

  constructor(options?: EmailMessageOptions)
  constructor(subject?: string, body?: string, options?: Omit<EmailMessageOptions, 'subject' | 'body'>)
  constructor(
    subjectOrOptions?: string | EmailMessageOptions,
    body?: string,
    options: Omit<EmailMessageOptions, 'subject' | 'body'> = {},
  ) {
    const opts: EmailMessageOptions =
      typeof subjectOrOptions === 'object' && subjectOrOptions !== null
        ? subjectOrOptions
        : { ...options, subject: subjectOrOptions, body }
    this.subject = opts.subject ?? ''
    this.body = opts.body ?? ''
    this.fromEmail = opts.fromEmail || mailSetting('DEFAULT_FROM_EMAIL', DEFAULT_FROM_EMAIL)
    this.to = addressList('to', opts.to)
    this.cc = addressList('cc', opts.cc)
    this.bcc = addressList('bcc', opts.bcc)
    this.replyTo = addressList('reply_to', opts.replyTo)
    this.extraHeaders = { ...(opts.headers ?? {}) }
    this.attachments = (opts.attachments ?? []).map(normalizeAttachment)
    this.connection = opts.connection ?? null
  }

  /** The connection used by `send()`; opened lazily and kept on the message. */
  getConnection(failSilently = false): BaseEmailBackend {
    if (!this.connection) this.connection = getConnection(undefined, { failSilently })
    return this.connection
  }

  /** Every recipient: `to`, `cc` and `bcc` (empty entries dropped). */
  recipients(): string[] {
    return [...this.to, ...this.cc, ...this.bcc].filter(Boolean)
  }

  /** Extra header value by case-insensitive name. */
  protected extraHeader(name: string): string | undefined {
    const lower = name.toLowerCase()
    for (const [k, v] of Object.entries(this.extraHeaders)) if (k.toLowerCase() === lower) return v
    return undefined
  }

  /** The text body part (before alternatives / attachments are added). */
  protected createBodyPart(): MIMEPart {
    return MIMEPart.text(this.body, this.contentSubtype)
  }

  /** Wrap the body in `multipart/mixed` with the attachments, if any. */
  protected createAttachments(body: MIMEPart): MIMEPart {
    if (!this.attachments.length) return body
    const parts: MIMEPart[] = []
    if (this.body || body.isMultipart()) parts.push(body)
    for (const attachment of this.attachments) parts.push(this.createAttachment(attachment))
    return MIMEPart.multipart(this.mixedSubtype, parts)
  }

  protected createAttachment({ filename, content, mimetype }: EmailAttachment): MIMEPart {
    const [main, sub] = mimetype.split('/')
    const part =
      main === 'text' && typeof content === 'string'
        ? MIMEPart.text(content, sub)
        : MIMEPart.binary(content, mimetype)
    if (filename !== null && filename !== undefined) {
      forbidMultiLineHeaders('filename', filename)
      part.set('Content-Disposition', `attachment; ${mimeParam('filename', filename)}`)
    }
    return part
  }

  /** Build the MIME structure (`createBodyPart` → alternatives → attachments). */
  protected createMessage(): MIMEPart {
    return this.createAttachments(this.createBodyPart())
  }

  /**
   * The MIME message (Django's `message()`), validated against header injection: raises `BadHeaderError` when
   * the subject, an address or an extra header contains a newline.
   */
  message(): MIMEPart {
    forbidMultiLineHeaders('Subject', this.subject)
    const msg = this.createMessage()
    msg.insertAfter('Content-Type', 'MIME-Version', '1.0')
    msg.set('Subject', encodeHeaderValue(this.subject))
    msg.set('From', encodeHeader('From', this.extraHeader('From') ?? this.fromEmail))
    this.setListHeader(msg, 'To', this.to)
    this.setListHeader(msg, 'Cc', this.cc)
    this.setListHeader(msg, 'Reply-To', this.replyTo)
    if (this.extraHeader('Date') === undefined) msg.set('Date', formatDate())
    if (this.extraHeader('Message-ID') === undefined) {
      const envelope = envelopeAddress(this.fromEmail)
      const at = envelope.lastIndexOf('@')
      msg.set('Message-ID', makeMsgid(at >= 0 ? envelope.slice(at + 1) : 'localhost'))
    }
    const handled = new Set(['from', 'to', 'cc', 'reply-to'])
    for (const [name, value] of Object.entries(this.extraHeaders)) {
      if (handled.has(name.toLowerCase())) continue
      msg.set(name, encodeHeader(name, value))
    }
    return msg
  }

  private setListHeader(msg: MIMEPart, name: string, values: string[]): void {
    const override = this.extraHeader(name)
    if (override !== undefined) msg.set(name, encodeHeader(name, override))
    else if (values.length) msg.set(name, values.map(sanitizeAddress).join(', '))
  }

  /** Send the message. Returns 1 when sent, 0 when there are no recipients (or it failed silently). */
  async send(failSilently = false): Promise<number> {
    if (!this.recipients().length) return 0
    return this.getConnection(failSilently).sendMessages([this])
  }

  /**
   * Attach a file: `attach(filename, content, mimetype?)` or `attach({ filename, content, mimetype })`. The MIME
   * type is guessed from the file name when omitted.
   */
  attach(attachment: AttachmentInput): this
  attach(filename: string | null, content: EmailContent, mimetype?: string | null): this
  attach(
    filenameOrAttachment: string | null | AttachmentInput,
    content?: EmailContent,
    mimetype?: string | null,
  ): this {
    if (content !== undefined) {
      this.attachments.push(normalizeAttachment([filenameOrAttachment as string | null, content, mimetype]))
    } else if (filenameOrAttachment && typeof filenameOrAttachment === 'object') {
      this.attachments.push(normalizeAttachment(filenameOrAttachment))
    } else {
      throw new TypeError('content must be provided.')
    }
    return this
  }

  /** The message as RFC 5322 text (CRLF line endings). */
  toString(): string {
    return this.message().asString()
  }
}

/**
 * A message with alternative representations of the body (Django's `EmailMultiAlternatives`).
 *
 * ```ts
 * const msg = new EmailMultiAlternatives('Hi', 'Plain text', { to: ['a@example.com'] })
 * msg.attachAlternative('<p>HTML</p>', 'text/html')
 * await msg.send()
 * ```
 */
export class EmailMultiAlternatives extends EmailMessage {
  /** Subtype of the container that holds the body and its alternatives. */
  alternativeSubtype = 'alternative'
  alternatives: EmailAlternative[]

  constructor(options?: EmailMultiAlternativesOptions)
  constructor(
    subject?: string,
    body?: string,
    options?: Omit<EmailMultiAlternativesOptions, 'subject' | 'body'>,
  )
  constructor(
    subjectOrOptions?: string | EmailMultiAlternativesOptions,
    body?: string,
    options: Omit<EmailMultiAlternativesOptions, 'subject' | 'body'> = {},
  ) {
    const opts: EmailMultiAlternativesOptions =
      typeof subjectOrOptions === 'object' && subjectOrOptions !== null
        ? subjectOrOptions
        : { ...options, subject: subjectOrOptions, body }
    super(opts)
    this.alternatives = (opts.alternatives ?? []).map((a) =>
      Array.isArray(a) ? { content: a[0], mimetype: a[1] } : { ...a },
    )
  }

  /** Add an alternative representation, e.g. `attachAlternative(html, 'text/html')`. */
  attachAlternative(content: string, mimetype: string): this {
    if (content === undefined || content === null || !mimetype) {
      throw new TypeError('Both content and mimetype must be provided.')
    }
    this.alternatives.push({ content, mimetype })
    return this
  }

  /**
   * True when `text` is in the body and in every `text/*` alternative (Django's `body_contains()`). Useful in
   * tests to check the plain and HTML versions at once.
   */
  bodyContains(text: string): boolean {
    if (!this.body.includes(text)) return false
    return this.alternatives.every((a) => !a.mimetype.startsWith('text/') || a.content.includes(text))
  }

  protected override createMessage(): MIMEPart {
    return this.createAttachments(this.createAlternatives(this.createBodyPart()))
  }

  protected createAlternatives(body: MIMEPart): MIMEPart {
    if (!this.alternatives.length) return body
    const parts: MIMEPart[] = []
    if (this.body) parts.push(body)
    for (const { content, mimetype } of this.alternatives) {
      const [main, sub] = mimetype.split('/')
      parts.push(main === 'text' ? MIMEPart.text(content, sub) : MIMEPart.binary(content, mimetype))
    }
    return MIMEPart.multipart(this.alternativeSubtype, parts)
  }
}
