import type { EmailMessage } from '../message'
import { BaseEmailBackend, type EmailBackendConfig } from './base'

/** Does nothing and reports every message as sent (Django's dummy backend). */
export class DummyBackend extends BaseEmailBackend {
  async sendMessages(messages: EmailMessage[]): Promise<number> {
    return messages.length
  }
}

/** `EMAIL_BACKEND: dummyBackend()` discards every message. */
export function dummyBackend(): EmailBackendConfig {
  return { backend: 'dummy', create: (_env, connection) => new DummyBackend(connection) }
}
