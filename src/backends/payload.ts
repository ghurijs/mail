// Turns an EmailMessage into the structured fields HTTP / binding APIs take (Resend, Cloudflare Email Service).

import {
  checkHeaderName,
  forbidMultiLineHeaders,
  type ParsedAddress,
  parseAddress,
  splitAddresses,
} from '../address'
import { EmailSendError } from '../errors'
import type { EmailMessage, EmailMultiAlternatives } from '../message'
import { toBytes } from '../mime'

export interface ApiAttachment {
  filename: string
  content: Uint8Array
  mimetype: string
}

export interface ApiPayload {
  from: ParsedAddress
  to: ParsedAddress[]
  cc: ParsedAddress[]
  bcc: ParsedAddress[]
  replyTo: ParsedAddress[]
  subject: string
  text?: string
  html?: string
  /** Extra headers, minus the ones that have API fields (From, To, Cc, Bcc, Reply-To, Subject). */
  headers: Record<string, string>
  attachments: ApiAttachment[]
}

const API_FIELD_HEADERS = new Set(['from', 'to', 'cc', 'bcc', 'reply-to', 'subject'])

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v
  return undefined
}

/**
 * Structured fields for an API backend. Validates headers like `message()` (raises `BadHeaderError`). An extra
 * `From` / `Reply-To` header overrides the field; `To` / `Cc` headers are ignored, since the API delivers to the
 * recipient lists. Bodies: the body is `text` (or `html` when `contentSubtype` is `'html'`); `text/html` and
 * `text/plain` alternatives fill the other one. Other alternative types raise `EmailSendError`.
 */
export function apiPayload(message: EmailMessage, backend: string): ApiPayload {
  message.message() // header-injection checks
  const extra = message.extraHeaders
  const from = parseAddress(headerValue(extra, 'from') ?? message.fromEmail)
  const replyToHeader = headerValue(extra, 'reply-to')
  const replyTo = (replyToHeader !== undefined ? splitAddresses(replyToHeader) : message.replyTo).map(
    parseAddress,
  )

  let text: string | undefined
  let html: string | undefined
  if (message.body) {
    if (message.contentSubtype === 'html') html = message.body
    else text = message.body
  }
  for (const alt of (message as EmailMultiAlternatives).alternatives ?? []) {
    const type = alt.mimetype.split(';')[0].trim().toLowerCase()
    if (type === 'text/html' && html === undefined) html = alt.content
    else if (type === 'text/plain' && text === undefined) text = alt.content
    else throw new EmailSendError(`The ${backend} backend cannot send a '${alt.mimetype}' alternative.`)
  }

  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(extra)) {
    checkHeaderName(name)
    forbidMultiLineHeaders(name, value)
    if (!API_FIELD_HEADERS.has(name.toLowerCase())) headers[name] = value
  }

  return {
    from,
    to: message.to.filter(Boolean).map(parseAddress),
    cc: message.cc.filter(Boolean).map(parseAddress),
    bcc: message.bcc.filter(Boolean).map(parseAddress),
    replyTo,
    subject: message.subject,
    text,
    html,
    headers,
    attachments: message.attachments.map((a) => ({
      filename: a.filename ?? 'attachment',
      content: toBytes(a.content),
      mimetype: a.mimetype,
    })),
  }
}
