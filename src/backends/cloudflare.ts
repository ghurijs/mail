import { ImproperlyConfigured } from '@ghuri/core'
import type { ParsedAddress } from '../address'
import { EmailSendError } from '../errors'
import type { EmailMessage } from '../message'
import { BaseEmailBackend, type ConnectionOptions, type EmailBackendConfig } from './base'
import { apiPayload } from './payload'

/** `{ name, email }` or a bare address (Cloudflare's `EmailAddress`). */
export type CloudflareAddress = string | { name: string; email: string }

/** The structured message `SendEmail.send()` takes (Cloudflare's `EmailMessageBuilder`). */
export interface CloudflareEmailBuilder {
  from: CloudflareAddress
  to?: CloudflareAddress[]
  cc?: CloudflareAddress[]
  bcc?: CloudflareAddress[]
  replyTo?: CloudflareAddress
  subject: string
  text?: string
  html?: string
  headers?: Record<string, string>
  attachments?: Array<{
    disposition: 'attachment'
    filename: string
    type: string
    content: ArrayBuffer | ArrayBufferView | string
  }>
}

/** The `send_email` binding (Cloudflare's `SendEmail`). */
export interface SendEmailBinding {
  send(message: CloudflareEmailBuilder): Promise<{ messageId: string }>
}

export interface CloudflareEmailBackendOptions {
  /** Name of the `send_email` binding in `env` (default `'EMAIL'`), or the binding itself. */
  binding?: string | SendEmailBinding
}

const address = ({ name, email }: ParsedAddress): CloudflareAddress => (name ? { name, email } : email)

/**
 * Sends with Cloudflare Email Service through a Workers `send_email` binding (`env.EMAIL.send({...})`).
 * The sender's domain must be onboarded to Email Sending.
 */
export class CloudflareEmailBackend extends BaseEmailBackend {
  readonly binding: SendEmailBinding

  constructor(binding: SendEmailBinding, options: ConnectionOptions = {}) {
    super(options)
    this.binding = binding
  }

  /** The `EmailMessageBuilder` passed to `binding.send()` for `message`. */
  builder(message: EmailMessage): CloudflareEmailBuilder {
    const p = apiPayload(message, 'Cloudflare email')
    if (p.replyTo.length > 1) {
      throw new EmailSendError('Cloudflare Email Service accepts a single Reply-To address.')
    }
    const out: CloudflareEmailBuilder = { from: address(p.from), subject: p.subject }
    if (p.to.length) out.to = p.to.map(address)
    if (p.cc.length) out.cc = p.cc.map(address)
    if (p.bcc.length) out.bcc = p.bcc.map(address)
    if (p.replyTo.length) out.replyTo = address(p.replyTo[0])
    if (p.text !== undefined) out.text = p.text
    if (p.html !== undefined) out.html = p.html
    if (Object.keys(p.headers).length) out.headers = p.headers
    if (p.attachments.length) {
      // Binary content: a string would be read as base64 by the binding.
      out.attachments = p.attachments.map((a) => ({
        disposition: 'attachment',
        filename: a.filename,
        type: a.mimetype,
        content: a.content,
      }))
    }
    return out
  }

  async sendMessages(messages: EmailMessage[]): Promise<number> {
    return this.sendEach(messages, async (message) => {
      const builder = this.builder(message)
      try {
        await this.binding.send(builder)
      } catch (err) {
        const e = err as { message?: string; code?: unknown }
        throw new EmailSendError(`Cloudflare email send failed: ${e?.message ?? err}`, {
          code: typeof e?.code === 'string' ? e.code : undefined,
          cause: err,
        })
      }
    })
  }
}

/**
 * `EMAIL_BACKEND: cloudflareEmailBackend({ binding: 'EMAIL' })` sends with Cloudflare Email Service. Add the
 * binding to `wrangler.jsonc`: `"send_email": [{ "name": "EMAIL" }]`. The binding is resolved from the current
 * request's `env` when a connection is opened.
 */
export function cloudflareEmailBackend(options: CloudflareEmailBackendOptions = {}): EmailBackendConfig {
  const binding = options.binding ?? 'EMAIL'
  return {
    backend: 'cloudflare-email',
    create(env, connection) {
      const resolved = (typeof binding === 'string' ? env[binding] : binding) as SendEmailBinding | undefined
      if (!resolved || typeof resolved.send !== 'function') {
        throw new ImproperlyConfigured(
          `Send email binding '${String(binding)}' was not found in env. Add "send_email": [{ "name": "${String(binding)}" }] ` +
            'to wrangler.jsonc.',
        )
      }
      return new CloudflareEmailBackend(resolved, connection)
    },
  }
}
