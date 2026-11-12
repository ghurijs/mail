import type { EmailMessage } from '../message'
import { BaseEmailBackend, type EmailBackendConfig } from './base'

const OUTBOX_KEY = Symbol.for('ghuri.mail.outbox')
const g = globalThis as Record<symbol, unknown>

/** The process-wide outbox the locmem backend appends to (Django's `mail.outbox`). Always the same array. */
export function getOutbox(): EmailMessage[] {
  let outbox = g[OUTBOX_KEY] as EmailMessage[] | undefined
  if (!outbox) {
    outbox = []
    g[OUTBOX_KEY] = outbox
  }
  return outbox
}

/** Keeps messages in memory (`outbox` from `@ghuri/mail/testing`) instead of sending them. */
export class LocmemBackend extends BaseEmailBackend {
  async sendMessages(messages: EmailMessage[]): Promise<number> {
    return this.sendEach(
      messages,
      async (message) => {
        message.message() // validate headers like a real send would
        getOutbox().push(message)
      },
      { skipEmpty: false },
    )
  }
}

/** `EMAIL_BACKEND: locmemBackend()` stores messages in the test outbox. */
export function locmemBackend(): EmailBackendConfig {
  return { backend: 'locmem', create: (_env, connection) => new LocmemBackend(connection) }
}
