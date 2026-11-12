import { ImproperlyConfigured } from '@ghuri/core'
import { formatAddress } from '../address'
import { EmailSendError } from '../errors'
import type { EmailMessage } from '../message'
import { base64Encode } from '../mime'
import { emailTimeout } from '../settings'
import { BaseEmailBackend, type ConnectionOptions, type EmailBackendConfig } from './base'
import { apiPayload } from './payload'

export interface ResendBackendOptions {
  /** Resend API key (`re_...`). Read it from `env` in your settings: `resendBackend({ apiKey: env.RESEND_API_KEY })`. */
  apiKey?: string
  /** API base URL (default `https://api.resend.com`). */
  baseUrl?: string
  /** Seconds before a request is aborted (default `EMAIL_TIMEOUT`, else no timeout). */
  timeout?: number | null
  /** `fetch` implementation (default the global `fetch`). */
  fetch?: typeof fetch
}

/** Sends through the Resend HTTP API (`POST /emails`, one request per message). */
export class ResendBackend extends BaseEmailBackend {
  readonly apiKey: string
  readonly baseUrl: string
  readonly timeout: number | null
  private readonly fetchImpl: typeof fetch

  constructor(options: ConnectionOptions & ResendBackendOptions = {}) {
    super(options)
    if (!options.apiKey) {
      throw new ImproperlyConfigured(
        'resendBackend() needs an apiKey, e.g. EMAIL_BACKEND: resendBackend({ apiKey: env.RESEND_API_KEY }).',
      )
    }
    this.apiKey = options.apiKey
    this.baseUrl = (options.baseUrl ?? 'https://api.resend.com').replace(/\/+$/, '')
    this.timeout = options.timeout === undefined ? emailTimeout() : options.timeout
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
  }

  /** The JSON body Resend's `POST /emails` takes for `message`. */
  payload(message: EmailMessage): Record<string, unknown> {
    const p = apiPayload(message, 'Resend')
    const body: Record<string, unknown> = {
      from: formatAddress(p.from),
      to: p.to.map(formatAddress),
      subject: p.subject,
    }
    if (p.cc.length) body.cc = p.cc.map(formatAddress)
    if (p.bcc.length) body.bcc = p.bcc.map(formatAddress)
    if (p.replyTo.length) body.reply_to = p.replyTo.map(formatAddress)
    if (p.html !== undefined) body.html = p.html
    if (p.text !== undefined) body.text = p.text
    if (Object.keys(p.headers).length) body.headers = p.headers
    if (p.attachments.length) {
      body.attachments = p.attachments.map((a) => ({
        filename: a.filename,
        content: base64Encode(a.content),
        content_type: a.mimetype,
      }))
    }
    return body
  }

  async sendMessages(messages: EmailMessage[]): Promise<number> {
    return this.sendEach(messages, async (message) => {
      const body = JSON.stringify(this.payload(message))
      let response: Response
      try {
        response = await this.fetchImpl(`${this.baseUrl}/emails`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body,
          signal: this.timeout === null ? undefined : AbortSignal.timeout(this.timeout * 1000),
        })
      } catch (err) {
        throw new EmailSendError(`Resend request failed: ${(err as Error)?.message ?? err}`, { cause: err })
      }
      if (!response.ok) {
        let data: any
        try {
          data = await response.json()
        } catch {
          data = undefined
        }
        const detail = data?.message ?? response.statusText
        throw new EmailSendError(`Resend API error ${response.status}: ${detail}`, {
          status: response.status,
          code: typeof data?.name === 'string' ? data.name : undefined,
          response: data,
        })
      }
    })
  }
}

/**
 * `EMAIL_BACKEND: resendBackend({ apiKey: env.RESEND_API_KEY })` sends through Resend's HTTP API with `fetch`
 * (Workers and Node). `getConnection(resendBackend(...), { apiKey })` can override the key per connection.
 */
export function resendBackend(options: ResendBackendOptions = {}): EmailBackendConfig {
  return {
    backend: 'resend',
    create: (_env, connection) => new ResendBackend({ ...options, ...connection }),
  }
}
