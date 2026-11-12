import { GhuriError } from '@ghuri/core'

/**
 * A header value (subject, address or extra header) contains a newline, which would let a caller inject headers
 * (Django's `BadHeaderError`).
 */
export class BadHeaderError extends GhuriError {}

export interface EmailSendErrorOptions {
  cause?: unknown
  /** HTTP status (API backends) or SMTP reply code. */
  status?: number
  /** Provider error code (`E_SENDER_NOT_VERIFIED`, Resend's `validation_error`, ...). */
  code?: string
  /** Parsed provider response, when there was one. */
  response?: unknown
}

/** A backend failed to deliver a message (raised unless the connection was opened with `failSilently`). */
export class EmailSendError extends GhuriError {
  readonly status?: number
  readonly code?: string
  readonly response?: unknown

  constructor(message: string, options: EmailSendErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.status = options.status
    this.code = options.code
    this.response = options.response
  }
}
