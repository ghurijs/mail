import type { Env } from '@ghuri/core'
import type { EmailMessage } from '../message'

/** Options passed to a backend when a connection is opened (`getConnection(backend, options)`). */
export interface ConnectionOptions {
  /** Swallow delivery errors; failed messages are not counted (default false). */
  failSilently?: boolean
  /** Backend-specific overrides (`username`, `password`, `apiKey`, `timeout`, ...). */
  [key: string]: unknown
}

/**
 * Entry of the `EMAIL_BACKEND` setting: same `{ backend, create(env) }` shape as cache / storage / database
 * configs. `create()` runs once per connection (`getConnection()`), with the current request's `env`.
 */
export interface EmailBackendConfig {
  backend: string
  create(env: Env, options: ConnectionOptions): BaseEmailBackend
}

/**
 * Base class for email backends (Django's `BaseEmailBackend`). Subclasses implement `sendMessages()`; network
 * backends may also implement `open()` / `close()` to reuse one connection for several messages.
 *
 * ```ts
 * const conn = getConnection()
 * await conn.open()
 * await conn.sendMessages([m1, m2])
 * await conn.close()
 * ```
 */
export abstract class BaseEmailBackend {
  failSilently: boolean

  constructor(options: ConnectionOptions = {}) {
    this.failSilently = !!options.failSilently
  }

  /** Open a long-lived connection. Returns true when a new connection was opened. */
  async open(): Promise<boolean> {
    return false
  }

  /** Close the connection opened by `open()`. */
  async close(): Promise<void> {}

  /** Send messages; returns how many were sent. */
  abstract sendMessages(messages: EmailMessage[]): Promise<number>

  /**
   * Send each message with `send`, counting successes. Errors are raised unless `failSilently`. With
   * `skipEmpty`, messages without recipients are skipped (not counted), like Django's SMTP backend.
   */
  protected async sendEach(
    messages: EmailMessage[],
    send: (message: EmailMessage) => Promise<void>,
    { skipEmpty = true }: { skipEmpty?: boolean } = {},
  ): Promise<number> {
    let sent = 0
    for (const message of messages) {
      if (skipEmpty && !message.recipients().length) continue
      try {
        await send(message)
        sent++
      } catch (err) {
        if (!this.failSilently) throw err
      }
    }
    return sent
  }
}

export function isBackendConfig(v: unknown): v is EmailBackendConfig {
  return !!v && typeof v === 'object' && typeof (v as EmailBackendConfig).create === 'function'
}
